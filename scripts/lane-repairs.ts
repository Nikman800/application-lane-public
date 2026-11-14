// The fixer's repair records from the command line (src/shared/repairs.ts
// says what they hold and why):
//
//   lane repair <app> [--report <id>] [--capture <id>] [--defect "<what>"]…
//                         what a report or capture shows: its defects open a
//                         repair (needs fixing); what only the applicant can
//                         do is listed for them, never as a defect
//   lane fixing <app> [next action]
//                         the fixer owns it now (being fixed); again to say
//                         it is still at work. Alone: every open repair
//   lane retry <app> --reason repair|profile|page
//                         refill it, only with a reason to expect progress,
//                         on the newest build, on a page the extension reaches
//   lane check <app> [--confirm <n>]…
//                         a capture of the page once settled: resolved,
//                         still open and newly found defects. Every one gone
//                         releases it (verified live); --confirm marks a
//                         defect described in words as seen fixed there
//   lane fixed <app>      the same check; it never releases an open defect
//   lane release <app> "<why>"
//                         back to the applicant with defects still open
//                         (theirs to do, or blocked), saying why
//   lane repairs [--json] every record not yet published
//   lane published <commit>
//                         the batch is pushed: its repairs' regressions are
//                         published, and .local/fixer/<report>.json written

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findDefects, type Evidence } from "./repair-evidence";
import {
  SETTLE_MS,
  claim,
  defectId,
  heartbeat,
  mayRetry,
  openRepair,
  outcome,
  published,
  release,
  section,
  verifyLive,
  type Attempt,
  type Defect,
  type Repair,
} from "../src/shared/repairs";
import { newerBuild, type BuildStamp } from "../src/shared/build";
import type { QueueSnapshot, QueueSummaryItem } from "../src/shared/model";

export type RepairContext = {
  words: string[];
  json: boolean;
  dataDirectory: string;
  api: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  snapshot: () => Promise<QueueSnapshot>;
  find: (queue: QueueSnapshot, wanted: string) => QueueSummaryItem;
  send: (action: string, applicationId?: string) => Promise<{ ok: boolean; detail?: string; error?: string }>;
  name: (app: QueueSummaryItem) => string;
  short: (app: QueueSummaryItem) => string;
  distBuild: () => Promise<BuildStamp | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  print?: (line: string) => void;
};

type About = {
  build?: BuildStamp;
  contentVersion: string;
  tab: { open: boolean; url?: string; loading?: boolean; discarded?: boolean };
  page?: { contentVersion?: string };
  status: string;
  busy: boolean;
};

const flagValues = (words: string[], flag: string) => words.flatMap((word, index) => (words[index - 1] === flag ? [word] : []));
const positional = (words: string[]) => words.filter((word, index) => !word.startsWith("--") && !words[index - 1]?.startsWith("--"));
const describe = (defect: Defect) => `${defect.field ? `${defect.field}: ` : ""}${defect.detail}`;

export function repairCommands(ctx: RepairContext) {
  const print = ctx.print || ((line: string) => console.log(line));
  const now = ctx.now || Date.now;
  const sleep = ctx.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const all = () => ctx.api<Record<string, Repair>>("/v1/repairs");
  const save = (repair: Repair) => ctx.api<Repair>(`/v1/repairs/${encodeURIComponent(repair.applicationId)}`, "PUT", repair);
  const target = async () => {
    const [wanted] = positional(ctx.words);
    if (!wanted) throw new Error("Name the application: its short id, or part of its company or title.");
    return ctx.find(await ctx.snapshot(), wanted);
  };
  const about = async (app: QueueSummaryItem): Promise<About> => {
    const reply = await ctx.send("about", app.id);
    if (!reply.ok) throw new Error(reply.error || "The extension did not answer.");
    return JSON.parse(reply.detail || "{}") as About;
  };
  const readEvidence = async (kind: "issues" | "captures", id: string): Promise<Evidence> => {
    const file = join(ctx.dataDirectory, kind, `${id}.json`);
    if (!existsSync(file)) throw new Error(`No ${kind === "issues" ? "report" : "capture"} ${id} in ${join(ctx.dataDirectory, kind)}.`);
    return JSON.parse(await readFile(file, "utf8")) as Evidence;
  };
  const list = (repair: Repair) => {
    repair.defects.forEach((defect, index) =>
      print(`  ${String(index + 1).padStart(2)}. ${defect.status === "open" ? "open    " : "resolved"} ${defect.kind.padEnd(16)} ${describe(defect).slice(0, 140)}${defect.manual && defect.status === "open" ? "  (confirm with --confirm)" : ""}`),
    );
    for (const action of repair.userActions) print(`   - for the applicant: ${action}`);
    if (repair.blocker) print(`   blocked: ${repair.blocker}`);
  };
  const pick = (repair: Repair, wanted: string[]) =>
    wanted.map((value) => {
      const byNumber = /^\d+$/.test(value) ? repair.defects[Number(value) - 1] : undefined;
      const defect = byNumber || repair.defects.find((other) => other.id === value);
      if (!defect) throw new Error(`No defect ${value} on this repair (lane repairs lists them).`);
      return defect.id;
    });

  // lane repair <app> --report <id> | --capture <id> | --defect "…"
  async function open() {
    const app = await target();
    const repairs = await all();
    const reports = flagValues(ctx.words, "--report");
    const captures = flagValues(ctx.words, "--capture");
    const described = flagValues(ctx.words, "--defect");
    if (!reports.length && !captures.length && !described.length) throw new Error("Give what shows the problem: --report <id>, --capture <id>, or --defect \"<what is wrong>\".");
    let repair = repairs[app.id];
    const sources = [...reports.map((id) => ["issues", id] as const), ...captures.map((id) => ["captures", id] as const)];
    for (const [kind, id] of sources) {
      const evidence = await readEvidence(kind, id);
      if (evidence.applicationId && evidence.applicationId !== app.id) throw new Error(`${id} is from another application.`);
      repair = openRepair(repair, { applicationId: app.id, step: evidence.tab?.url, evidence: { kind: kind === "issues" ? "report" : "capture", id }, ...findDefects(evidence) }, now());
    }
    if (described.length) {
      const defects: Defect[] = described.map((text) => ({ id: defectId("other", undefined, text), kind: "other", detail: text.slice(0, 600), status: "open", manual: true }));
      repair = openRepair(repair, { applicationId: app.id, defects, userActions: [] }, now());
    }
    if (!repair!.defects.length) {
      print(`${ctx.name(app)}: nothing the software can fix.`);
      for (const action of repair!.userActions) print(`  - for the applicant: ${action}`);
      return;
    }
    await save(repair!);
    print(`${ctx.name(app)}: ${section(repair) || "released"}.`);
    list(repair!);
  }

  // lane fixing <app> [next action]: the fixer owns it.
  async function own() {
    if (!positional(ctx.words).length) return show(false);
    const app = await target();
    const repairs = await all();
    const owner = flagValues(ctx.words, "--owner")[0] || "fixer";
    const next = positional(ctx.words).slice(1).join(" ");
    let repair = repairs[app.id];
    if (!repair?.defects.some((defect) => defect.status === "open")) {
      // Marked the moment a report arrives, before it is read: what the
      // applicant said is the defect until the report is classified.
      if (!next) throw new Error("Nothing open on it. Say what is wrong (lane fixing <app> \"<what>\"), or open it from the report: lane repair <app> --report <id>.");
      repair = openRepair(repair, { applicationId: app.id, defects: [{ id: defectId("other", undefined, next), kind: "other", detail: next, status: "open", manual: true }], userActions: [] }, now());
    }
    repair = repair.owner?.name === owner && repair.state === "being-fixed" ? heartbeat(repair, now(), next || undefined) : claim(repair, owner, now(), next || undefined);
    await save(repair);
    print(`${ctx.name(app)}: being fixed by ${owner}${repair.nextAction ? `; next: ${repair.nextAction}` : ""}.`);
  }

  // lane retry <app> --reason repair|profile|page
  async function retry() {
    const app = await target();
    const repair = (await all())[app.id];
    if (!repair) throw new Error(`${ctx.name(app)} has no repair. Open one from what shows the problem: lane repair <app> --report <id>.`);
    const reason = flagValues(ctx.words, "--reason")[0] as Attempt["reason"] | undefined;
    if (reason && !["repair", "profile", "page"].includes(reason)) throw new Error("--reason is repair, profile or page.");
    const allowed = mayRetry(repair, reason);
    if (!allowed.ok) throw new Error(`Not refilled. ${allowed.why}`);
    const state = await about(app);
    const newest = await ctx.distBuild();
    if (newerBuild(state.build, newest)) throw new Error(`The extension runs an older build (${state.build?.commit}) than dist/extension (${newest!.commit}): lane reload, then lane refresh ${ctx.short(app)}.`);
    if (!state.tab.open) throw new Error("Its tab is closed: lane switch opens it again (a sign-in may be needed first).");
    if (state.tab.loading || state.tab.discarded) throw new Error("Its page is still loading or was put to sleep by Chrome: switch to it, then try again.");
    if (!state.page) throw new Error("The extension cannot reach its page (signed out, another site, or no access). The applicant may need to sign in again.");
    if (state.page.contentVersion !== state.contentVersion) throw new Error(`Its page runs another build: lane refresh ${ctx.short(app)} first.`);
    if (state.busy) throw new Error("It is being filled now. Try again when it finishes.");
    const reply = await ctx.send("fill", app.id);
    if (!reply.ok) throw new Error(reply.error || "The fill did not start.");
    await save({ ...heartbeat(repair, now()), refill: { at: now(), reason: reason!, build: state.build?.commit } });
    print(`${ctx.name(app)}: refilling on build ${state.build?.commit || "unknown"} (${reason}). Then: lane check ${ctx.short(app)}.`);
  }

  // lane check <app> [--confirm <n>]…: the settled page against the record.
  async function check() {
    const app = await target();
    const repair = (await all())[app.id];
    if (!repair) throw new Error(`${ctx.name(app)} has no repair to check.`);
    const confirmed = pick(repair, flagValues(ctx.words, "--confirm"));
    // The fill finished, and the site had time for its own late changes.
    let state = await about(app);
    for (let waited = 0; state.busy && waited < 10 * 60_000; waited += 5000) {
      await sleep(5000);
      state = await about(app);
    }
    if (state.busy) throw new Error("It is still being filled after ten minutes.");
    let capture: Evidence & { createdAt: number } = await takeCapture(app);
    let settled = settledFor(capture);
    if (settled < SETTLE_MS) {
      print(`Waiting ${Math.ceil((SETTLE_MS - settled) / 1000)} s for the page to settle…`);
      await sleep(SETTLE_MS - settled);
      capture = await takeCapture(app);
      settled = settledFor(capture);
    }
    const found = findDefects(capture);
    const result = verifyLive(repair, { capture: capture.id, build: state.build?.commit, settledMs: settled, found, codeChanged: (repair.refill?.reason || "repair") === "repair", confirmed }, now());
    await save(result.repair);
    if (result.ok) print(`${ctx.name(app)}: verified live in capture ${capture.id}; every targeted defect is gone and nothing new is wrong. Released to the applicant${result.repair.regression === "pending" ? "; its regression test is pending publication" : ""}.`);
    else print(`${ctx.name(app)}: not verified. ${result.why}`);
    list(result.repair);
    if (!result.ok) process.exitCode = 1;
  }
  async function takeCapture(app: QueueSummaryItem) {
    const reply = await ctx.send("capture", app.id);
    if (!reply.ok || !reply.detail) throw new Error(reply.error || "No capture was taken.");
    const file = join(ctx.dataDirectory, "captures", `${reply.detail}.json`);
    for (let tries = 0; !existsSync(file) && tries < 20; tries++) await sleep(500);
    return JSON.parse(await readFile(file, "utf8")) as Evidence & { createdAt: number };
  }
  const settledFor = (capture: Evidence & { createdAt: number }) => {
    const finished = capture.application?.attempts?.at(-1)?.completedAt;
    return finished ? capture.createdAt - finished : SETTLE_MS;
  };

  // lane release <app> "<why>"
  async function giveBack() {
    const app = await target();
    const repair = (await all())[app.id];
    if (!repair) throw new Error(`${ctx.name(app)} has no repair.`);
    const why = positional(ctx.words).slice(1).join(" ");
    if (!why) throw new Error("Say why it goes back with defects open (what the applicant has to do, or what blocks the repair).");
    await save(release(repair, now(), why));
    print(`${ctx.name(app)}: back with the applicant; ${repair.defects.filter((defect) => defect.status === "open").length} defect(s) stay open on the record.`);
  }

  async function show(everything: boolean) {
    const repairs = Object.values(await all()).filter((repair) => everything || repair.state !== "released" || repair.regression === "pending");
    if (ctx.json) return print(JSON.stringify(repairs, null, 2));
    if (!repairs.length) return print("No repairs open or awaiting publication.");
    const queue = await ctx.snapshot().catch(() => undefined);
    const label = (id: string) => {
      const app = queue?.applications.find((candidate) => candidate.id === id);
      return app ? `[${ctx.short(app)}] ${ctx.name(app)}` : `[${id.slice(0, 6)}]`;
    };
    for (const repair of repairs.sort((a, b) => b.updatedAt - a.updatedAt)) {
      const where = section(repair) || "released";
      print(`${label(repair.applicationId)}  ${where}, ${outcome(repair)}${repair.owner ? `, ${repair.owner.name}` : ""}${repair.regression !== "none" ? `, regression ${repair.regression}` : ""}`);
      if (repair.nextAction) print(`   next: ${repair.nextAction}`);
      if (repair.note) print(`   ${repair.note}`);
      list(repair);
    }
  }

  // lane published <commit>: the batch is on main.
  async function publish() {
    const [commit] = positional(ctx.words);
    if (!commit) throw new Error("Give the commit that was pushed.");
    const repairs = await all();
    let count = 0;
    for (const repair of Object.values(repairs)) {
      if (repair.regression !== "pending" && repair.regression !== "passed") continue;
      const done = published(repair, commit, now());
      await save(done);
      count++;
      for (const evidence of done.evidence.filter((item) => item.kind === "report")) await writeRecord(evidence.id, done, commit);
    }
    print(`${count} repair${count === 1 ? "" : "s"} marked published in ${commit}.`);
  }
  // .local/fixer/<report>.json, its status taken from the record: "fixed"
  // only when it was seen working live with nothing open.
  async function writeRecord(reportId: string, repair: Repair, commit: string) {
    const dir = join(ctx.dataDirectory, "fixer");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${reportId}.json`);
    const previous = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as { summary?: string; startedAt?: number };
    const open = repair.defects.filter((defect) => defect.status === "open");
    const status = outcome(repair);
    const summary = `${status === "fixed" ? "Confirmed live" : status === "needs-live-check" ? "Not yet confirmed live" : status === "partial" ? "Partly confirmed live" : "Not confirmed live"}: ${repair.defects.filter((defect) => defect.status === "resolved").map(describe).join("; ") || "nothing resolved yet"}.`;
    await writeFile(file, JSON.stringify({ status, summary: previous.summary && status === "fixed" ? previous.summary : summary, problems: open.map(describe), commit, startedAt: previous.startedAt || repair.createdAt, finishedAt: now() }, null, 2));
  }

  return { open, own, retry, check, fixed: check, release: giveBack, list: () => show(ctx.words.includes("--all")), publish };
}
