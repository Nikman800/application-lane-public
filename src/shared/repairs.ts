// What the fixer is repairing, application by application.
//
// An application needs fixing when a report or a settled capture shows a
// defect the software can fix: an answer it has left empty, a wrong or
// rejected value, a value that disappeared after it was written, a widget,
// upload or fill that failed, an unexplained stall. A required field that is
// merely empty is not one by itself: the profile may have no answer for it.
// What only the applicant can do (an answer the profile lacks, consent, a
// CAPTCHA, a sign-in, their own edit) is listed for them instead, and never
// refilled as a defect.
//
// The record says which defects it targets and their evidence, who owns the
// repair, each refill tried (on which build, with what result), and the
// capture that showed it working live. Verified live is evidence on the
// record, not a place in the list: once every targeted defect is gone on a
// settled page with nothing new wrong, the application goes back to the
// applicant, and the regression test and its publication are tracked here
// apart from it.

import { z } from "zod";

export const defectKinds = ["empty-answerable", "wrong-value", "rejected", "lost-value", "widget", "upload", "fill-failed", "stall", "other"] as const;
export type DefectKind = (typeof defectKinds)[number];

const defectSchema = z.object({
  id: z.string().max(200),
  kind: z.enum(defectKinds),
  field: z.string().max(300).optional(),
  detail: z.string().max(600),
  status: z.enum(["open", "resolved"]),
  // Described in words (the applicant's report, the fixer's reading of the
  // page) rather than found by the checks: a capture that does not mention it
  // proves nothing, so it is resolved only when the fixer confirms it there.
  manual: z.boolean().optional(),
  // Where it was seen, and the capture that showed it gone.
  seenIn: z.string().max(100).optional(),
  resolvedIn: z.string().max(100).optional(),
});
export type Defect = z.infer<typeof defectSchema>;

const attemptSchema = z.object({
  at: z.number(),
  // Why another refill was worth trying: a repair shipped, the profile
  // changed, or the page did.
  reason: z.enum(["repair", "profile", "page"]),
  build: z.string().max(100).optional(),
  capture: z.string().max(100).optional(),
  resolved: z.array(z.string().max(200)).max(100),
  remaining: z.array(z.string().max(200)).max(100),
  added: z.array(z.string().max(200)).max(100),
  progress: z.boolean(),
});
export type Attempt = z.infer<typeof attemptSchema>;

export const repairSchema = z.object({
  applicationId: z.string().min(1).max(100),
  // The step of the application (its page) the defects are on.
  step: z.string().max(500).optional(),
  state: z.enum(["needs-fixing", "being-fixed", "released"]),
  defects: z.array(defectSchema).max(100),
  evidence: z.array(z.object({ kind: z.enum(["report", "capture"]), id: z.string().max(100), at: z.number() })).max(100),
  // What the applicant has to do; not defects, and not refilled for.
  userActions: z.array(z.string().max(400)).max(50),
  owner: z.object({ name: z.string().max(100), since: z.number(), heartbeatAt: z.number() }).optional(),
  nextAction: z.string().max(400).optional(),
  attempts: z.array(attemptSchema).max(50),
  // A refill started (lane retry) whose outcome no capture has shown yet.
  refill: z.object({ at: z.number(), reason: z.enum(["repair", "profile", "page"]), build: z.string().max(100).optional() }).optional(),
  // A refill that made no progress after this many tries stops here.
  blocker: z.string().max(400).optional(),
  verification: z.object({ capture: z.string().max(100), build: z.string().max(100).optional(), at: z.number(), settledMs: z.number() }).optional(),
  // The regression test for the code repair, and the commit that published it.
  regression: z.enum(["none", "pending", "passed", "published"]),
  commit: z.string().max(80).optional(),
  note: z.string().max(500).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Repair = z.infer<typeof repairSchema>;
export const repairsSchema = z.record(z.string(), repairSchema);

// Long enough for a hard repair's time box and a live check; an owner who
// has not touched the record since has stopped working on it.
export const OWNER_LAPSE_MS = 45 * 60_000;
// Refills in a row that changed nothing before the repair is called blocked.
export const NO_PROGRESS_LIMIT = 3;
// A capture taken this soon after a fill can still miss the site's own late
// changes (a résumé parser's rewrite came 38 s after the address was typed); verification needs a page this long settled.
export const SETTLE_MS = 15_000;

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const defectId = (kind: DefectKind, field: string | undefined, detail: string) => `${kind}:${norm(field || detail).slice(0, 120)}`;

export type Found = { defects: Defect[]; userActions: string[] };

// Opens a repair, or adds what a new report or capture found to one in
// progress. A released application with a new defect needs fixing again.
export function openRepair(existing: Repair | undefined, found: Found & { applicationId: string; step?: string; evidence?: { kind: "report" | "capture"; id: string } }, now: number): Repair {
  const base: Repair = existing ?? {
    applicationId: found.applicationId,
    state: "needs-fixing",
    defects: [],
    evidence: [],
    userActions: [],
    attempts: [],
    regression: "none",
    createdAt: now,
    updatedAt: now,
  };
  const defects = [...base.defects];
  let added = 0;
  for (const defect of found.defects) {
    const same = defects.findIndex((other) => other.id === defect.id);
    if (same < 0) {
      defects.push({ ...defect, status: "open" });
      added++;
    } else if (defects[same].status === "resolved") {
      // Seen again after it was fixed: open again.
      defects[same] = { ...defects[same], status: "open", resolvedIn: undefined, seenIn: defect.seenIn };
      added++;
    }
  }
  const open = defects.some((defect) => defect.status === "open");
  return {
    ...base,
    step: found.step ?? base.step,
    defects,
    evidence: found.evidence ? [...base.evidence, { ...found.evidence, at: now }].slice(-100) : base.evidence,
    userActions: [...new Set([...base.userActions, ...found.userActions])].slice(0, 50),
    state: base.state === "being-fixed" ? "being-fixed" : open && (base.state !== "released" || added) ? "needs-fixing" : base.state,
    blocker: added ? undefined : base.blocker,
    verification: added ? undefined : base.verification,
    updatedAt: now,
  };
}

// The fixer's old flag (fixing.json: a time and a note) as a record: the
// note is the one thing known to be wrong, and it stays open until a check
// shows otherwise.
export function fromFixingFlag(applicationId: string, flag: { since: number; note: string }, now: number): Repair {
  const detail = flag.note.trim() || "Flagged as being fixed before repair records; what is wrong was not recorded.";
  return {
    applicationId,
    state: "being-fixed",
    defects: [{ id: defectId("other", undefined, detail), kind: "other", detail: detail.slice(0, 600), status: "open", manual: true }],
    evidence: [],
    userActions: [],
    owner: { name: "fixer", since: flag.since, heartbeatAt: flag.since },
    attempts: [],
    regression: "none",
    note: "Carried over from the old being-fixed flag.",
    createdAt: flag.since,
    updatedAt: now,
  };
}

export function claim(repair: Repair, owner: string, now: number, nextAction?: string): Repair {
  if (!repair.defects.some((defect) => defect.status === "open")) throw new Error("Nothing to fix: no open defect on this application.");
  return { ...repair, state: "being-fixed", owner: { name: owner, since: repair.owner?.name === owner ? repair.owner.since : now, heartbeatAt: now }, nextAction: nextAction ?? repair.nextAction, updatedAt: now };
}
export function heartbeat(repair: Repair, now: number, nextAction?: string): Repair {
  return repair.owner ? { ...repair, owner: { ...repair.owner, heartbeatAt: now }, nextAction: nextAction ?? repair.nextAction, updatedAt: now } : repair;
}

// An owner gone quiet gives the repair back to the queue. Its defects stay
// open: nobody showed them fixed.
export function lapse(repair: Repair, now: number, limitMs = OWNER_LAPSE_MS): Repair {
  if (repair.state !== "being-fixed" || !repair.owner || now - repair.owner.heartbeatAt < limitMs) return repair;
  return { ...repair, state: "needs-fixing", owner: undefined, note: `${repair.owner.name} stopped working on it ${new Date(repair.owner.heartbeatAt).toISOString()}; its defects are still open.`, updatedAt: now };
}

// Whether another refill is worth trying: only for a reason to expect
// progress, and not after refills in a row that changed nothing.
export function mayRetry(repair: Repair, reason: Attempt["reason"] | undefined): { ok: boolean; why?: string } {
  if (!reason) return { ok: false, why: "Say why a refill should go differently now: a repair shipped, the profile changed, or the page did." };
  if (repair.blocker) return { ok: false, why: `Blocked: ${repair.blocker}` };
  if (!repair.defects.some((defect) => defect.status === "open")) return { ok: false, why: "No open defect to refill for." };
  const recent = repair.attempts.slice(-NO_PROGRESS_LIMIT);
  if (recent.length === NO_PROGRESS_LIMIT && recent.every((attempt) => !attempt.progress))
    return { ok: false, why: `${NO_PROGRESS_LIMIT} refills in a row changed nothing.` };
  return { ok: true };
}

// A refill's outcome: what the capture after it still shows. A targeted
// defect it no longer shows is resolved; one it shows that the record did
// not have is added and opened.
export function recordAttempt(repair: Repair, outcome: { reason: Attempt["reason"]; build?: string; capture?: string; found: Found; confirmed?: string[] }, now: number): Repair {
  const ids = new Set(outcome.found.defects.map((defect) => defect.id));
  const confirmed = new Set(outcome.confirmed || []);
  const resolved: string[] = [];
  const defects = repair.defects.map((defect) => {
    if (defect.status === "open" && !ids.has(defect.id) && (!defect.manual || confirmed.has(defect.id))) {
      resolved.push(defect.id);
      return { ...defect, status: "resolved" as const, resolvedIn: outcome.capture };
    }
    return defect;
  });
  const added = outcome.found.defects.filter((defect) => !repair.defects.some((other) => other.id === defect.id));
  const all = [...defects, ...added.map((defect) => ({ ...defect, status: "open" as const }))];
  const attempt: Attempt = {
    at: now,
    reason: outcome.reason,
    build: outcome.build,
    capture: outcome.capture,
    resolved,
    remaining: all.filter((defect) => defect.status === "open").map((defect) => defect.id),
    added: added.map((defect) => defect.id),
    progress: resolved.length > 0,
  };
  const attempts = [...repair.attempts, attempt].slice(-50);
  const recent = attempts.slice(-NO_PROGRESS_LIMIT);
  const stuck = recent.length === NO_PROGRESS_LIMIT && recent.every((entry) => !entry.progress) && attempt.remaining.length > 0;
  return {
    ...repair,
    defects: all,
    attempts,
    refill: undefined,
    userActions: [...new Set([...repair.userActions, ...outcome.found.userActions])].slice(0, 50),
    blocker: stuck ? `${NO_PROGRESS_LIMIT} refills changed nothing; still open: ${attempt.remaining.slice(0, 4).join(", ")}` : repair.blocker,
    updatedAt: now,
  };
}

// Verified live: on a settled page every targeted defect is gone and nothing
// new is wrong. Then the application goes back to the applicant; one
// defect fixed of several is progress, not a verified repair.
export function verifyLive(
  repair: Repair,
  check: { capture: string; build?: string; settledMs: number; found: Found; codeChanged: boolean; confirmed?: string[] },
  now: number,
): { ok: true; repair: Repair } | { ok: false; repair: Repair; why: string } {
  if (check.settledMs < SETTLE_MS)
    return { ok: false, repair, why: `The page had settled ${Math.round(check.settledMs / 1000)} s; take the capture at least ${SETTLE_MS / 1000} s after the fill.` };
  const after = recordAttempt(repair, { reason: repair.refill?.reason || "repair", build: check.build, capture: check.capture, found: check.found, confirmed: check.confirmed }, now);
  const open = after.defects.filter((defect) => defect.status === "open");
  if (open.length) {
    const added = after.attempts.at(-1)!.added;
    return {
      ok: false,
      repair: { ...after, state: repair.state === "released" ? "needs-fixing" : repair.state },
      why: `${open.length} still open${added.length ? ` (${added.length} newly found)` : ""}: ${open.slice(0, 4).map((defect) => defect.field || defect.detail).join("; ")}`,
    };
  }
  return {
    ok: true,
    repair: {
      ...after,
      state: "released",
      owner: undefined,
      nextAction: undefined,
      blocker: undefined,
      verification: { capture: check.capture, build: check.build, at: now, settledMs: check.settledMs },
      regression: check.codeChanged ? (repair.regression === "published" ? "published" : "pending") : repair.regression,
    },
  };
}

// Back to the applicant with what only they can do, every defect resolved
// or not: when the rest is theirs (an answer the profile lacks), or a
// blocked repair the fixer cannot take further now. Open defects stay open.
export function release(repair: Repair, now: number, why: string): Repair {
  return { ...repair, state: "released", owner: undefined, note: why.slice(0, 500), updatedAt: now };
}

export function published(repair: Repair, commit: string, now: number): Repair {
  return { ...repair, regression: "published", commit, updatedAt: now };
}

// Where the list shows the application: in one of the fixer's two
// sections, or (released, or no record) wherever its own state puts it.
export function section(repair: Repair | undefined): "needs fixing" | "being fixed" | undefined {
  if (!repair) return;
  if (repair.state === "being-fixed") return "being fixed";
  if (repair.state === "needs-fixing" && repair.defects.some((defect) => defect.status === "open")) return "needs fixing";
  return;
}

// What a fixer record (.local/fixer/<report>.json) may call the outcome:
// "fixed" only when the repair was seen working live with nothing open.
export function outcome(repair: Repair): "fixed" | "partial" | "needs-live-check" | "blocked" | "open" {
  const open = repair.defects.filter((defect) => defect.status === "open").length;
  if (repair.verification && !open) return "fixed";
  if (repair.blocker) return "blocked";
  if (open && open < repair.defects.length) return "partial";
  if (repair.regression !== "none" && !repair.verification) return "needs-live-check";
  return "open";
}
