// The one way to run checks on a change, by hand, by the fixer, or by its
// subagents:
//
//   npm run validate -- browser --test "<exact test title>" [--test …]
//                                       the named browser tests, nothing else
//   npm run validate -- unit [--file tests/x.test.ts …]
//                                       unit tests (all, or these files)
//   npm run validate -- site <site> [--capture <id> …]
//                                       the browser tests naming the site and
//                                       an offline re-fill of its saved forms
//                                       (the newest of each page, or these)
//   npm run validate -- full            typecheck, all unit tests, the whole
//                                       browser suite: once per batch
//   npm run validate -- status          what is running, and what waits
//
// Options: --workers N (at most 3), --retries 0|1 (failed browser tests run
// once more alone; default 1 for full, 0 otherwise), --timeout <minutes> for
// each step, --label <text>, --without "<path>" (check the regression fails
// without a change: those files are taken from HEAD in the snapshot).
//
// Every run tests a frozen copy of the tree as it is when the run starts
// (tracked and new files, uncommitted changes included), built into that
// copy's own dist/extension-test: editing, building the applicant's
// extension or starting another run changes nothing under it. The copy is
// named by the git tree it holds, and that name is stamped into its build.
//
// Results: <checkout>/.local/validate/<run>/result.json and a log per step.
// The exit status is 0 only when the run passed (see validate-core.ts); a
// step that matched no test, timed out or was stopped fails the run.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, createWriteStream, renameSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { holder, lockPath, tryLock, unlock } from "../tests/support/suite-lock";
import {
  countOutcomes,
  exactTitles,
  mayTakeLock,
  nodeTestCounts,
  playwrightOutcomes,
  runVerdict,
  seconds,
  timingLine,
  unmatchedTitles,
  type StepKind,
  type StepResult,
  type Timing,
  type Waiter,
} from "./validate-core";

const args = process.argv.slice(2);
const kind = args[0];
const many = (name: string) => args.flatMap((arg, index) => (args[index - 1] === `--${name}` ? [arg] : []));
const option = (name: string) => many(name).at(-1);
const checkout = process.cwd();
const runsDir = join(checkout, ".local", "validate");
const waitersDir = process.env.LANE_VALIDATE_QUEUE || join(process.platform === "win32" ? tmpdir() : "/tmp", "application-lane-validate-waiters");
const treesDir = process.env.LANE_VALIDATE_TREES || join(homedir(), ".cache", "application-lane", "validate");

if (kind === "status") {
  printStatus();
  process.exit(0);
}
if (!["browser", "unit", "site", "full"].includes(kind || "")) {
  console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((line) => line.startsWith("//")).slice(0, 26).map((line) => line.slice(3)).join("\n"));
  process.exit(2);
}

const workers = Math.min(3, Math.max(1, Number(option("workers") || (kind === "full" ? 3 : 2))));
const retries = Math.min(1, Math.max(0, Number(option("retries") ?? (kind === "full" ? 1 : 0))));
const minutes = (fallback: number) => Number(option("timeout") || fallback) * 60_000;
const titles = many("test");
const site = kind === "site" ? args[1] : undefined;
if (kind === "browser" && !titles.length) fail("Name the tests: --test \"<exact title>\" (repeat for more). Broad patterns pick up hundreds of unrelated tests.");
if (kind === "site" && (!site || site.startsWith("--"))) fail("Name the site: npm run validate -- site workday");

const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-${kind}-${process.pid}`;
const runDir = join(runsDir, runId);
mkdirSync(runDir, { recursive: true });
const timing: Timing = { lockWaitMs: 0, snapshotMs: 0, buildMs: 0, executionMs: 0, retryMs: 0, totalMs: 0 };
const started = Date.now();
const steps: StepResult[] = [];
const children = new Set<number>();
let holdingLock = false;
let phase = "starting";
let tree = "";
let build: { builtAt: number; commit: string } | undefined;
// The steps a complete run has, builds aside (a build is reused when the
// tree was built before): fewer means the run stopped part way.
const expected = kind === "full" ? 3 : kind === "site" ? 1 + (Math.min(5, many("capture").length) || 1) : 1;
// --without: the tree with these files as committed, where the named tests
// have to fail. The run succeeds when they do.
const without = many("without");

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
function record(status = "running", why: string[] = []) {
  const result = { id: runId, kind, label: option("label"), status, why, phase, checkout, tree, snapshot: tree ? join(treesDir, tree.slice(0, 12)) : undefined, build, titles, site, workers, retries, timing: { ...timing, totalMs: Date.now() - started }, startedAt: started, steps };
  writeFileSync(join(runDir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}
const say = (line: string) => console.log(`[validate ${kind}] ${line}`);

// A frozen copy of the tree: git's own name for its content (tracked and new
// files, through a scratch index so the real one is untouched), unpacked
// once per tree and reused by later runs of the same tree.
function snapshot(): string {
  const begun = Date.now();
  const index = join(runDir, "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync("git", ["read-tree", "HEAD"], { env });
  execFileSync("git", ["add", "-A", "--", ".", ":!.claude"], { env, stdio: ["ignore", "ignore", "pipe"] });
  tree = execFileSync("git", ["write-tree"], { env }).toString().trim();
  if (without.length) {
    // The same tree with these files as committed: the regression has to
    // fail here and pass in the tree itself.
    execFileSync("git", ["read-tree", tree], { env });
    for (const path of without) {
      const committed = execFileSync("git", ["ls-tree", "HEAD", "--", path]).toString().trim();
      if (committed) execFileSync("git", ["update-index", "--index-info"], { env, input: `${committed}\n` });
      else execFileSync("git", ["rm", "--cached", "-q", "--", path], { env });
    }
    tree = execFileSync("git", ["write-tree"], { env }).toString().trim();
  }
  rmSync(index, { force: true });
  const dir = join(treesDir, tree.slice(0, 12));
  if (!existsSync(join(dir, ".complete"))) {
    const temporary = `${dir}.${process.pid}`;
    rmSync(temporary, { recursive: true, force: true });
    mkdirSync(temporary, { recursive: true });
    execFileSync("sh", ["-c", `git archive --format=tar ${tree} | tar -x -C "${temporary}"`]);
    symlinkSync(join(checkout, "node_modules"), join(temporary, "node_modules"));
    // A repository of its own holding just this tree: tests and scripts
    // that ask git (the public export's) see the tree as committed.
    const git = (...gitArgs: string[]) => execFileSync("git", gitArgs, { cwd: temporary, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "validate", GIT_AUTHOR_EMAIL: "validate@localhost", GIT_COMMITTER_NAME: "validate", GIT_COMMITTER_EMAIL: "validate@localhost" } });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", `snapshot ${tree}`);
    writeFileSync(join(temporary, ".complete"), tree);
    try {
      renameSync(temporary, dir);
    } catch {
      // Another run unpacked the same tree first.
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  // Trees no run has used for a day go (a full suite takes under an hour).
  const touched = new Date();
  utimesSync(dir, touched, touched);
  for (const name of readdirSync(treesDir)) {
    const other = join(treesDir, name);
    try {
      if (other !== dir && Date.now() - statSync(other).mtimeMs > 24 * 3600_000) rmSync(other, { recursive: true, force: true });
    } catch { /* another run removed it */ }
  }
  timing.snapshotMs = Date.now() - begun;
  say(`testing tree ${tree.slice(0, 12)} (${dir})`);
  return dir;
}

function run(name: string, stepKind: StepKind, command: string[], cwd: string, env: NodeJS.ProcessEnv, limitMs: number): Promise<StepResult> {
  const log = join(runDir, `${name.replace(/[^a-z0-9]+/gi, "-")}.log`);
  const out = createWriteStream(log);
  const begun = Date.now();
  return new Promise((done) => {
    const child = spawn(command[0], command.slice(1), { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid) children.add(child.pid);
    let timedOut = false;
    const kill = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* gone */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 10_000).unref();
    }, limitMs);
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (child.pid) children.delete(child.pid);
      out.end();
      done({ name, kind: stepKind, command, exitCode: signal && code === null ? null : code, timedOut, ms: Date.now() - begun, log });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      out.end(String(error));
      done({ name, kind: stepKind, command, exitCode: 127, timedOut: false, ms: Date.now() - begun, log, note: error.message });
    });
  });
}

// The build of this tree, into the copy's own directory, once per tree.
async function buildIn(dir: string): Promise<boolean> {
  const target = join(dir, "dist", "extension-test", "build.json");
  const stamp = `tree-${tree.slice(0, 12)}`;
  const existing = existsSync(target) ? (JSON.parse(readFileSync(target, "utf8")) as { builtAt: number; commit: string }) : undefined;
  if (existing?.commit === stamp) {
    build = existing;
    say(`reusing the build of this tree (${new Date(existing.builtAt).toISOString()})`);
    return true;
  }
  const begun = Date.now();
  const scratch = `dist/extension-test-${process.pid}`;
  const step = await run("build", "build", [process.execPath, "scripts/build.mjs"], dir, { LANE_EXTENSION_DIR: scratch, LANE_BUILD_COMMIT: stamp }, minutes(5));
  timing.buildMs += Date.now() - begun;
  steps.push(step);
  if (step.exitCode !== 0) return false;
  rmSync(join(dir, "dist", "extension-test"), { recursive: true, force: true });
  renameSync(join(dir, scratch), join(dir, "dist", "extension-test"));
  build = JSON.parse(readFileSync(target, "utf8"));
  return true;
}

// The machine's browser-suite lock (tests/support/suite-lock.ts), shared
// with Playwright runs started any other way. A short check waiting goes
// first: a full suite yields the lock to it before starting.
async function takeLock(self: Waiter) {
  const begun = Date.now();
  mkdirSync(waitersDir, { recursive: true });
  const mine = join(waitersDir, `${process.pid}.json`);
  writeFileSync(mine, JSON.stringify(self));
  let announced = "";
  try {
    for (;;) {
      const waiting = readWaiters();
      if (mayTakeLock(self, waiting) && tryLock()) break;
      const other = holder();
      const ahead = waiting.filter((waiter) => waiter.pid !== self.pid && waiter.kind === "short" && self.kind === "full");
      const line = other
        ? `waiting for the browser-suite lock: held by pid ${other.pid} in ${other.cwd} since ${other.since}`
        : ahead.length ? `waiting: ${ahead.length} short check${ahead.length === 1 ? "" : "s"} go first` : "waiting for the browser-suite lock";
      if (line !== announced) say((announced = line));
      phase = line;
      record();
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  } finally {
    rmSync(mine, { force: true });
  }
  holdingLock = true;
  timing.lockWaitMs += Date.now() - begun;
}
function readWaiters(): Waiter[] {
  if (!existsSync(waitersDir)) return [];
  return readdirSync(waitersDir).flatMap((name) => {
    try {
      const waiter = JSON.parse(readFileSync(join(waitersDir, name), "utf8")) as Waiter;
      process.kill(waiter.pid, 0);
      return [waiter];
    } catch {
      rmSync(join(waitersDir, name), { force: true });
      return [];
    }
  });
}
function releaseLock() {
  if (holdingLock) unlock();
  holdingLock = false;
}

async function browser(dir: string, name: string, grep: { grep?: string; invert?: string }, wanted: string[], shard?: string): Promise<StepResult> {
  const begun = Date.now();
  const report = join(runDir, `${name.replace(/[^a-z0-9]+/gi, "-")}.json`);
  const env = { LANE_EXTENSION_DIR: "dist/extension-test", LANE_BROWSER_LOCK: "off", PLAYWRIGHT_JSON_OUTPUT_NAME: report, FORCE_COLOR: "0" };
  const command = ["npx", "playwright", "test", "--workers", String(workers), "--retries", "0", "--reporter=line,json",
    ...(grep.grep ? ["--grep", grep.grep] : []), ...(grep.invert ? ["--grep-invert", grep.invert] : []), ...(shard ? [`--shard=${shard}`] : [])];
  const step = await run(name, "browser", command, dir, env, minutes(kind === "full" ? 60 : 20));
  timing.executionMs += Date.now() - begun;
  const outcomes = existsSync(report) ? playwrightOutcomes(JSON.parse(readFileSync(report, "utf8"))) : [];
  if (existsSync(report)) step.counts = countOutcomes(outcomes);
  if (wanted.length) step.unmatched = unmatchedTitles(wanted, outcomes);
  const failed = [...new Set(outcomes.filter((outcome) => outcome.status === "failed").map((outcome) => outcome.title))];
  // Failed tests run once more, alone: a test that passes then is reported
  // as passing only on retry, never as a clean pass. At most ten: more
  // failures than that is a broken change, not a slow machine.
  if (retries && failed.length && failed.length <= 10 && !step.timedOut && step.exitCode !== null) {
    const again = Date.now();
    const retryReport = join(runDir, `${name.replace(/[^a-z0-9]+/gi, "-")}-retry.json`);
    const retry = await run(`${name} retry`, "browser", ["npx", "playwright", "test", "--workers", "1", "--retries", "0", "--reporter=line,json", "--grep", exactTitles(failed)], dir, { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: retryReport }, minutes(20));
    const second = existsSync(retryReport) ? playwrightOutcomes(JSON.parse(readFileSync(retryReport, "utf8"))) : [];
    const passed = failed.filter((title) => second.some((outcome) => outcome.title === title) && second.filter((outcome) => outcome.title === title).every((outcome) => outcome.status !== "failed"));
    step.retried = { titles: failed, passed, failed: failed.filter((title) => !passed.includes(title)), ms: Date.now() - again };
    if (retry.timedOut || retry.exitCode === null) step.retried.failed = failed;
    timing.retryMs += Date.now() - again;
  }
  return step;
}

async function replay(dir: string, name: string, only: string, all: boolean): Promise<StepResult> {
  const begun = Date.now();
  const step = await run(name, "replay", [process.execPath, "--import", "tsx", "eval/check.ts", "--replay", "--no-build", ...(all ? ["--all"] : ["--limit", "10"]), "--only", only], dir,
    { LANE_EXTENSION_DIR: "dist/extension-test", LANE_DATA_DIR: process.env.LANE_DATA_DIR || join(checkout, ".local") }, minutes(20));
  timing.executionMs += Date.now() - begun;
  const report = readFileSync(step.log, "utf8").match(/Full report: (.+)\/summary\.md/);
  if (report && existsSync(join(report[1], "results.json"))) {
    const results = JSON.parse(readFileSync(join(report[1], "results.json"), "utf8")) as { forms: unknown[]; replayed: { reproduced: boolean }[] };
    step.replays = { chosen: results.forms.length, reproduced: results.replayed.filter((form) => form.reproduced).length };
  } else step.replays = { chosen: 0, reproduced: 0 };
  return step;
}

function finish(): never {
  releaseLock();
  timing.totalMs = Date.now() - started;
  const { verdict, why } = runVerdict(steps, expected);
  phase = "done";
  // Without the change, the regression has to fail, and to fail as tests
  // (not a build that broke, or a name that matched nothing).
  const tested = steps.filter((step) => step.kind === "unit" || step.kind === "browser");
  const failsWithout = without.length > 0 && tested.length > 0 && tested.every((step) => !step.unmatched?.length && !step.timedOut && step.exitCode !== null) &&
    tested.some((step) => (step.counts?.failed || 0) > 0);
  const result = record(without.length ? (failsWithout ? "fails-without-change" : "does-not-fail-without-change") : verdict, why);
  const counts = steps.filter((step) => step.counts).map((step) => `${step.name}: ${step.counts!.passed} passed, ${step.counts!.failed} failed${step.counts!.flaky ? `, ${step.counts!.flaky} flaky` : ""}${step.counts!.skipped ? `, ${step.counts!.skipped} skipped` : ""}`);
  const replays = steps.filter((step) => step.replays).map((step) => `${step.name}: ${step.replays!.reproduced}/${step.replays!.chosen} forms replayed`);
  console.log(`\n[validate ${kind}] ${without.length ? (failsWithout ? "FAILS WITHOUT THE CHANGE, as a regression should" : "DOES NOT FAIL WITHOUT THE CHANGE: not a regression for it") : verdict.toUpperCase()}  tree ${tree.slice(0, 12)}  build ${build ? `${build.commit} ${new Date(build.builtAt).toISOString()}` : "none"}`);
  for (const line of [...counts, ...replays, ...why]) console.log(`  ${line}`);
  console.log(`  ${timingLine(result.timing)}`);
  console.log(`  ${join(runDir, "result.json")}`);
  writeFileSync(join(runsDir, "latest.json"), JSON.stringify(result, null, 2));
  process.exit(without.length ? (failsWithout ? 0 : 1) : verdict === "passed" || verdict === "passed-after-retry" ? 0 : 1);
}

function stop(signal: NodeJS.Signals) {
  for (const pid of children) try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
  phase = `stopped (${signal})`;
  releaseLock();
  rmSync(join(waitersDir, `${process.pid}.json`), { force: true });
  record("incomplete", [`stopped by ${signal}`]);
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => stop(signal));
// The runner's own failure is a failed run, recorded as one.
process.on("uncaughtException", (error) => {
  for (const pid of children) try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
  releaseLock();
  rmSync(join(waitersDir, `${process.pid}.json`), { force: true });
  phase = "runner error";
  record("incomplete", [`the runner failed: ${error.message.split("\n")[0]}`]);
  console.error(`[validate ${kind}] INCOMPLETE: ${error.message}`);
  process.exit(1);
});

function printStatus() {
  const lock = holder(lockPath());
  console.log(lock ? `Browser-suite lock: held by pid ${lock.pid} in ${lock.cwd} since ${lock.since}` : "Browser-suite lock: free");
  const waiting = readWaiters();
  for (const waiter of waiting) console.log(`  waiting: ${waiter.kind} check, pid ${waiter.pid}${waiter.label ? ` (${waiter.label})` : ""}, since ${new Date(waiter.since).toISOString()}`);
  if (!existsSync(runsDir)) return;
  for (const name of readdirSync(runsDir).filter((entry) => !entry.endsWith(".json")).sort().slice(-8)) {
    const file = join(runsDir, name, "result.json");
    if (!existsSync(file)) continue;
    const result = JSON.parse(readFileSync(file, "utf8"));
    let live = false;
    try { process.kill(Number(name.split("-").at(-1)), 0); live = result.status === "running"; } catch { /* ended */ }
    console.log(`${name}  ${live ? `running: ${result.phase}` : result.status === "running" ? "ended without a result (incomplete)" : result.status}  ${seconds(result.timing.totalMs)}${result.why?.length ? `  ${result.why.slice(0, 2).join("; ")}` : ""}`);
  }
}

// The run.
phase = "snapshot";
record();
const dir = snapshot();
record();
if (kind === "unit" || kind === "full") {
  if (kind === "full") {
    phase = "typecheck";
    record();
    const begun = Date.now();
    steps.push(await run("typecheck", "typecheck", ["npx", "tsc", "--noEmit", "-p", "."], dir, {}, minutes(5)));
    timing.executionMs += Date.now() - begun;
    if (steps.at(-1)!.exitCode !== 0) finish();
  }
  phase = "unit tests";
  record();
  const begun = Date.now();
  const files = many("file");
  const step = await run("unit tests", "unit", [process.execPath, "--import", "tsx", "--test", ...(files.length ? files : readdirSync(join(dir, "tests")).filter((name) => name.endsWith(".test.ts")).sort().map((name) => `tests/${name}`))], dir, {}, minutes(15));
  timing.executionMs += Date.now() - begun;
  step.counts = nodeTestCounts(readFileSync(step.log, "utf8"));
  steps.push(step);
  if (kind === "unit") finish();
}
phase = "build";
record();
if (!(await buildIn(dir))) finish();
await takeLock({ pid: process.pid, kind: kind === "full" ? "full" : "short", since: Date.now(), label: option("label") || titles.join("; ").slice(0, 120) || site });
phase = "browser tests";
record();
if (kind === "browser") steps.push(await browser(dir, "browser tests", { grep: exactTitles(titles) }, titles));
if (kind === "full") {
  // The suite runs in shards, the lock given up between them: one run held
  // it for 27 minutes, and every short check (a subagent's proof, a single
  // test) waited that long behind it. Short checks waiting go
  // first at each hand-over (mayTakeLock).
  const shards = 6;
  const waiter: Waiter = { pid: process.pid, kind: "full", since: Date.now(), label: option("label") || "full suite" };
  for (let index = 1; index <= shards; index++) {
    if (index > 1) {
      releaseLock();
      await takeLock(waiter);
      phase = `browser tests ${index}/${shards}`;
      record();
    }
    steps.push(await browser(dir, `browser suite ${index}/${shards}`, { invert: "throughput benchmark" }, [], `${index}/${shards}`));
  }
}
if (kind === "site") {
  // Test names say which site they come from ("the captured Workday Skills…").
  const anyCase = [...site!].map((char) => (/[a-z]/i.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
  steps.push(await browser(dir, `browser tests naming ${site}`, { grep: anyCase }, []));
  phase = "replays";
  record();
  const captures = many("capture").slice(0, 5);
  if (captures.length) for (const capture of captures) steps.push(await replay(dir, `replay ${capture.slice(0, 8)}`, capture, true));
  else steps.push(await replay(dir, `replay of ${site}'s saved forms`, site!, false));
}
finish();
