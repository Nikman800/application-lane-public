import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findDefects, type Evidence } from "../scripts/repair-evidence";
import {
  NO_PROGRESS_LIMIT,
  OWNER_LAPSE_MS,
  SETTLE_MS,
  claim,
  defectId,
  fromFixingFlag,
  lapse,
  mayRetry,
  openRepair,
  outcome,
  published,
  recordAttempt,
  release,
  section,
  verifyLive,
  type Defect,
  type Found,
} from "../src/shared/repairs";
import { readRepairs } from "../src/server/app";

const APP = "f00dcafe-0000-4000-8000-000000000001";
const defect = (kind: Defect["kind"], field: string, detail = "x"): Defect => ({ id: defectId(kind, field, detail), kind, field, detail, status: "open" });
const found = (...defects: Defect[]): Found => ({ defects, userActions: [] });
const city = defect("lost-value", "City");
const degree = defect("widget", "Degree");

// What a fill's capture or a report shows, read the way the repair records
// need it: a blank required field alone is no defect; the fill
// saying it had the answer and failed makes it one; what only the applicant
// can do is listed for them.
test("a capture's defects are what the software can fix, apart from what the applicant must do", () => {
  const evidence: Evidence = {
    id: "capture-1",
    tab: { ats: "Workday" },
    application: {
      missing: [
        "Degree: not filled (the list did not open).",
        'Left "Signature" for you: type your full name to sign.',
        "Required: Middle name (left alone: your edit lock holds it)",
        "Please complete the CAPTCHA before continuing.",
      ],
      attempts: [{ status: "needs-review", note: "Review the items below.", completedAt: 1 }],
    },
    frames: [{ observation: { fields: [
      { label: "Degree", kind: "select", required: true, value: "", options: ["Bachelor's", "Master's"] },
      { label: "Phone extension", kind: "text", required: true, value: "" },
      { label: "Postal code", kind: "text", required: true, value: "ABCDE", invalid: true },
      { label: "City", kind: "text", required: true, value: "", fillWarning: "The site cleared the value after it was filled." },
    ] } }],
  };
  const result = findDefects(evidence);
  const byField = Object.fromEntries(result.defects.map((item) => [item.field, item.kind]));
  assert.equal(byField.Degree, "widget");
  assert.equal(byField["Postal code"], "rejected");
  assert.equal(byField.City, "lost-value");
  // Empty and required, with nothing saying an answer existed: not a defect.
  assert.equal(byField["Phone extension"], undefined);
  assert.ok(result.userActions.some((action) => /Signature/.test(action)));
  assert.ok(result.userActions.some((action) => /Middle name.*Unlock empty fields/.test(action)));
  assert.ok(result.userActions.some((action) => /CAPTCHA/.test(action)));
  assert.ok(!result.defects.some((item) => /Signature|Middle name|CAPTCHA/i.test(`${item.field} ${item.detail}`)));
});

test("a repair is needed, owned, and released only when every targeted defect is gone on a settled page", () => {
  let repair = openRepair(undefined, { applicationId: APP, evidence: { kind: "report", id: "r1" }, ...found(city, degree) }, 1000);
  assert.equal(section(repair), "needs fixing");
  repair = claim(repair, "fixer", 2000, "port the address fix");
  assert.equal(section(repair), "being fixed");
  // Too soon after the fill: the site's late changes could still undo it.
  const early = verifyLive(repair, { capture: "c0", settledMs: SETTLE_MS - 1, found: found(), codeChanged: true }, 3000);
  assert.equal(early.ok, false);
  assert.match((early as { why: string }).why, /settled/);
  // One of two fixed: progress, not a verified repair.
  const half = verifyLive(repair, { capture: "c1", build: "abc", settledMs: SETTLE_MS, found: found(degree), codeChanged: true }, 4000);
  assert.equal(half.ok, false);
  assert.equal(section(half.repair), "being fixed");
  assert.equal(outcome(half.repair), "partial");
  assert.deepEqual(half.repair.attempts.at(-1)!.resolved, [city.id]);
  // Both gone, but a new problem appeared: still not released.
  const newly = defect("rejected", "Email");
  const worse = verifyLive(half.repair, { capture: "c2", settledMs: SETTLE_MS, found: found(newly), codeChanged: true }, 5000);
  assert.equal(worse.ok, false);
  assert.match((worse as { why: string }).why, /1 newly found/);
  // Everything gone: released, verified live, its regression pending.
  const done = verifyLive(worse.repair, { capture: "c3", build: "abd", settledMs: SETTLE_MS + 5000, found: found(), codeChanged: true }, 6000);
  assert.equal(done.ok, true);
  assert.equal(section(done.repair), undefined);
  assert.equal(done.repair.verification?.capture, "c3");
  assert.equal(done.repair.regression, "pending");
  assert.equal(outcome(done.repair), "fixed");
  assert.equal(published(done.repair, "1234567", 7000).regression, "published");
  // Seen again later: back in the queue.
  const again = openRepair(done.repair, { applicationId: APP, evidence: { kind: "capture", id: "c4" }, ...found(city) }, 8000);
  assert.equal(section(again), "needs fixing");
  assert.equal(again.verification, undefined);
});

test("a defect described in words is resolved only when the fixer confirms it", () => {
  const words: Defect = { ...defect("other", "", "Languages were left empty"), manual: true };
  const repair = claim(openRepair(undefined, { applicationId: APP, ...found(words) }, 1), "fixer", 2);
  // A capture that does not mention it proves nothing.
  const silent = verifyLive(repair, { capture: "c1", settledMs: SETTLE_MS, found: found(), codeChanged: true }, 3);
  assert.equal(silent.ok, false);
  const confirmed = verifyLive(repair, { capture: "c2", settledMs: SETTLE_MS, found: found(), codeChanged: true, confirmed: [words.id] }, 4);
  assert.equal(confirmed.ok, true);
  // The old being-fixed flag carries over the same way.
  const carried = fromFixingFlag(APP, { since: 10, note: "ICE: address and languages" }, 20);
  assert.equal(section(carried), "being fixed");
  assert.equal(carried.defects[0].manual, true);
});

test("refills need a reason, and stop after refills that change nothing", () => {
  let repair = claim(openRepair(undefined, { applicationId: APP, ...found(city) }, 1), "fixer", 2);
  assert.equal(mayRetry(repair, undefined).ok, false);
  assert.equal(mayRetry(repair, "repair").ok, true);
  for (let n = 0; n < NO_PROGRESS_LIMIT; n++) repair = recordAttempt(repair, { reason: "page", capture: `c${n}`, found: found(city) }, 10 + n);
  assert.match(repair.blocker || "", /changed nothing/);
  assert.equal(mayRetry(repair, "profile").ok, false);
  // Given back with its defect open, saying why: the record keeps it open.
  const back = release(repair, 100, "The site refuses the city list; the applicant picks it.");
  assert.equal(section(back), undefined);
  assert.equal(back.defects[0].status, "open");
  assert.equal(outcome(back), "blocked");
  // A repair with a regression and no live check is not "fixed".
  assert.equal(outcome({ ...repair, blocker: undefined, regression: "pending" }), "needs-live-check");
});

test("an owner gone quiet gives the repair back with its defects open, and the old flags carry over", async () => {
  const repair = claim(openRepair(undefined, { applicationId: APP, ...found(city) }, 1), "subagent-3", 1000);
  assert.equal(lapse(repair, 1000 + OWNER_LAPSE_MS - 1), repair);
  const lapsed = lapse(repair, 1000 + OWNER_LAPSE_MS);
  assert.equal(section(lapsed), "needs fixing");
  assert.equal(lapsed.owner, undefined);
  assert.equal(lapsed.defects[0].status, "open");
  assert.match(lapsed.note || "", /subagent-3 stopped/);

  const directory = await mkdtemp(join(tmpdir(), "lane-repairs-"));
  await writeFile(join(directory, "fixing.json"), JSON.stringify({ [APP]: { since: 5, note: "Acme: education entries" } }));
  const now = 5 + OWNER_LAPSE_MS + 1;
  const repairs = await readRepairs(directory, now);
  assert.equal(existsSync(join(directory, "fixing.json")), false);
  // Carried over, and its owner has been quiet since: back in the queue.
  assert.equal(section(repairs[APP]), "needs fixing");
  assert.match(repairs[APP].defects[0].detail, /education entries/);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "repairs.json"), "utf8"))[APP].state, "needs-fixing");
});

// A file the lane has no document for (a photo) is the applicant's to
// attach; an unattached résumé is the fill's (Bask Health's Workable form).
test("only an unattached document the lane makes is an upload defect", async () => {
  const { findDefects } = await import("../scripts/repair-evidence");
  const found = findDefects({ id: "c1", application: { missing: ["Choose a file manually: Photo Choose file", "Choose a file manually: Resume"] } });
  assert.deepEqual(found.defects.map((defect) => [defect.kind, defect.field]), [["upload", "Resume"]]);
  assert.match(found.userActions.join(" "), /Photo/);
});
