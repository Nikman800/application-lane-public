// The validation runner's decisions, apart from its processes so they can be
// tested (tests/validate.test.ts): what a Playwright or node --test run
// counted, whether a run passed, which test titles matched nothing, and
// which waiting run takes the machine's browser-suite lock next.
//
// A run passes only when every step ran, exited 0 and counted at least one
// test (or replayed at least one form); a step that matched nothing, timed
// out, or was cut short is a failure, never a quiet success. The pipelines
// this replaces ended in `| tail` and `echo SUITE-DONE`, whose exit status
// was 0 whatever the tests did.

export type StepKind = "build" | "unit" | "browser" | "replay" | "typecheck";
export type Counts = { passed: number; failed: number; flaky: number; skipped: number; total: number };
export type StepResult = {
  name: string;
  kind: StepKind;
  command: string[];
  exitCode: number | null;
  // Killed for running past its time limit.
  timedOut: boolean;
  ms: number;
  log: string;
  counts?: Counts;
  // Requested test titles that matched no test.
  unmatched?: string[];
  // Tests that failed, then passed when run again alone.
  retried?: { titles: string[]; passed: string[]; failed: string[]; ms: number };
  // Forms replayed offline: how many, and how many came back close enough
  // to the real page to re-fill.
  replays?: { chosen: number; reproduced: number };
  note?: string;
};
export type Verdict = "passed" | "passed-after-retry" | "failed" | "incomplete";

// What a step's result means for the run.
export function stepVerdict(step: StepResult): { verdict: Verdict; why?: string } {
  if (step.timedOut) return { verdict: "incomplete", why: `${step.name} ran past its time limit` };
  if (step.exitCode === null) return { verdict: "incomplete", why: `${step.name} was cut short` };
  if (step.unmatched?.length) return { verdict: "failed", why: `no test is named ${step.unmatched.map((title) => `"${title}"`).join(", ")}` };
  if (step.kind === "replay") {
    if (!step.replays?.chosen) return { verdict: "failed", why: `${step.name} found no saved form to replay` };
    if (!step.replays.reproduced) return { verdict: "failed", why: `${step.name}: none of ${step.replays.chosen} saved forms could be replayed offline` };
    return step.exitCode === 0 ? { verdict: "passed" } : { verdict: "failed", why: `${step.name} exited ${step.exitCode}` };
  }
  if ((step.kind === "unit" || step.kind === "browser") && step.counts) {
    if (step.counts.total === 0 || step.counts.passed + step.counts.flaky + step.counts.failed === 0) return { verdict: "failed", why: `${step.name} ran no tests` };
    if (step.retried) {
      if (step.retried.failed.length) return { verdict: "failed", why: `${step.retried.failed.length} failed again alone: ${step.retried.failed.slice(0, 3).join("; ")}` };
      if (step.counts.failed === step.retried.titles.length && step.retried.passed.length === step.retried.titles.length)
        return { verdict: "passed-after-retry", why: `${step.retried.passed.length} passed only when run again alone` };
    }
    if (step.counts.failed) return { verdict: "failed", why: `${step.counts.failed} failed` };
  } else if (step.kind === "unit" || step.kind === "browser") return { verdict: "incomplete", why: `${step.name} reported no counts` };
  if (step.exitCode !== 0 && !step.retried) return { verdict: "failed", why: `${step.name} exited ${step.exitCode}` };
  return { verdict: "passed" };
}

export function runVerdict(steps: StepResult[], expected: number): { verdict: Verdict; why: string[] } {
  const why: string[] = [];
  let verdict: Verdict = "passed";
  const rank: Record<Verdict, number> = { passed: 0, "passed-after-retry": 1, failed: 2, incomplete: 3 };
  for (const step of steps) {
    const result = stepVerdict(step);
    if (result.why) why.push(result.why);
    if (rank[result.verdict] > rank[verdict]) verdict = result.verdict;
  }
  // A step that never ran (an earlier one failed, or the run was stopped)
  // leaves the run incomplete, not passed.
  const ran = steps.filter((step) => step.kind !== "build").length;
  if (ran < expected) {
    why.push(`${expected - ran} of ${expected} steps did not run`);
    if (rank[verdict] < rank.incomplete && verdict !== "failed") verdict = "incomplete";
  }
  return { verdict, why };
}

// Playwright's JSON report: each test's title and its outcome.
type JsonSuite = { title?: string; specs?: { title: string; tests: { status: string; results: { status: string }[] }[] }[]; suites?: JsonSuite[] };
export function playwrightOutcomes(report: { suites?: JsonSuite[]; errors?: unknown[] }): { title: string; status: "passed" | "failed" | "flaky" | "skipped" }[] {
  const out: { title: string; status: "passed" | "failed" | "flaky" | "skipped" }[] = [];
  const walk = (suite: JsonSuite) => {
    for (const spec of suite.specs || [])
      for (const test of spec.tests) {
        const status = test.status === "expected" ? "passed" : test.status === "flaky" ? "flaky" : test.status === "skipped" ? "skipped" : "failed";
        out.push({ title: spec.title, status });
      }
    for (const child of suite.suites || []) walk(child);
  };
  for (const suite of report.suites || []) walk(suite);
  return out;
}
export function countOutcomes(outcomes: { status: string }[]): Counts {
  const counts: Counts = { passed: 0, failed: 0, flaky: 0, skipped: 0, total: outcomes.length };
  for (const outcome of outcomes) counts[outcome.status as keyof Omit<Counts, "total">]++;
  return counts;
}

// node --test's closing summary ("# pass 612", "# fail 0", …).
export function nodeTestCounts(log: string): Counts | undefined {
  const read = (name: string) => {
    const found = [...log.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gm"))].at(-1);
    return found ? Number(found[1]) : undefined;
  };
  const tests = read("tests");
  const pass = read("pass");
  const fail = read("fail");
  if (tests === undefined || pass === undefined || fail === undefined) return;
  return { passed: pass, failed: fail + (read("cancelled") || 0), flaky: 0, skipped: (read("skipped") || 0) + (read("todo") || 0), total: tests };
}
// The tests node --test failed, by name ("not ok 3 - a test's name").
export function nodeTestFailures(log: string): string[] {
  return [...log.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((match) => match[1].trim());
}

// A Playwright --grep matching exactly these titles: a test's title ends the
// line Playwright matches (file and describe titles come before it).
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function exactTitles(titles: string[]): string {
  return `(?:^|\\s)(?:${titles.map(escape).join("|")})$`;
}
export function unmatchedTitles(wanted: string[], ran: { title: string }[]): string[] {
  return wanted.filter((title) => !ran.some((test) => test.title === title));
}

// Whose turn it is at the browser-suite lock. A short check (a few named
// tests, a site's tests) waiting goes before a full suite: a full suite
// that has not started yet waits for every short check that is waiting.
export type Waiter = { pid: number; kind: "short" | "full"; since: number; label?: string };
export function mayTakeLock(self: Waiter, waiting: Waiter[]): boolean {
  if (self.kind === "short") return true;
  return !waiting.some((other) => other.pid !== self.pid && other.kind === "short");
}

// What a run took, by phase, for the record and the summary line.
export type Timing = { lockWaitMs: number; snapshotMs: number; buildMs: number; executionMs: number; retryMs: number; totalMs: number };
export const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
export function timingLine(timing: Timing): string {
  return `lock wait ${seconds(timing.lockWaitMs)}, snapshot ${seconds(timing.snapshotMs)}, build ${seconds(timing.buildMs)}, tests ${seconds(timing.executionMs)}, retries ${seconds(timing.retryMs)}, total ${seconds(timing.totalMs)}`;
}
