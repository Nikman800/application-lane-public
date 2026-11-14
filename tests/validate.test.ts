import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countOutcomes,
  exactTitles,
  mayTakeLock,
  nodeTestCounts,
  playwrightOutcomes,
  runVerdict,
  stepVerdict,
  unmatchedTitles,
  type StepResult,
} from "../scripts/validate-core";

const step = (over: Partial<StepResult>): StepResult => ({ name: "browser tests", kind: "browser", command: [], exitCode: 0, timedOut: false, ms: 1, log: "", ...over });

// The pipelines this replaced ended in "| tail; echo SUITE-DONE" and exited
// 0 whatever the tests did.
test("a run passes only when every step ran, exited 0 and counted tests", () => {
  assert.equal(runVerdict([step({ counts: { passed: 3, failed: 0, flaky: 0, skipped: 0, total: 3 } })], 1).verdict, "passed");
  // Failures, whatever the exit status says.
  assert.equal(runVerdict([step({ counts: { passed: 2, failed: 1, flaky: 0, skipped: 0, total: 3 } })], 1).verdict, "failed");
  // A name that matched nothing is no pass.
  const none = runVerdict([step({ exitCode: 1, counts: { passed: 0, failed: 0, flaky: 0, skipped: 0, total: 0 }, unmatched: ["a test that was renamed"] })], 1);
  assert.equal(none.verdict, "failed");
  assert.match(none.why.join(" "), /renamed/);
  assert.equal(stepVerdict(step({ counts: { passed: 0, failed: 0, flaky: 0, skipped: 0, total: 0 } })).verdict, "failed");
  // Timed out, stopped, or no counts at all: incomplete.
  assert.equal(stepVerdict(step({ timedOut: true, exitCode: null })).verdict, "incomplete");
  assert.equal(stepVerdict(step({ exitCode: null })).verdict, "incomplete");
  assert.equal(stepVerdict(step({ kind: "unit" })).verdict, "incomplete");
  // A step that never ran leaves the run incomplete.
  assert.equal(runVerdict([step({ kind: "typecheck" })], 3).verdict, "incomplete");
  // A failed build fails the run, though later steps never ran.
  assert.equal(runVerdict([step({ kind: "build", exitCode: 1 })], 1).verdict, "failed");
});

test("a failure that passes alone is reported as a retry, and one that fails again fails the run", () => {
  const counts = { passed: 9, failed: 1, flaky: 0, skipped: 0, total: 10 };
  assert.equal(stepVerdict(step({ exitCode: 1, counts, retried: { titles: ["x"], passed: ["x"], failed: [], ms: 5 } })).verdict, "passed-after-retry");
  assert.equal(stepVerdict(step({ exitCode: 1, counts, retried: { titles: ["x"], passed: [], failed: ["x"], ms: 5 } })).verdict, "failed");
});

test("a replay that found or reproduced no form is not a pass", () => {
  assert.equal(stepVerdict(step({ kind: "replay", replays: { chosen: 0, reproduced: 0 } })).verdict, "failed");
  assert.equal(stepVerdict(step({ kind: "replay", replays: { chosen: 3, reproduced: 0 } })).verdict, "failed");
  assert.equal(stepVerdict(step({ kind: "replay", replays: { chosen: 3, reproduced: 2 } })).verdict, "passed");
});

test("Playwright's report and node --test's summary are counted", () => {
  const report = { suites: [{ title: "extension.spec.ts", specs: [
    { title: "a", tests: [{ status: "expected", results: [{ status: "passed" }] }] },
    { title: "b", tests: [{ status: "unexpected", results: [{ status: "failed" }] }] },
  ], suites: [{ specs: [{ title: "c", tests: [{ status: "flaky", results: [] }, { status: "skipped", results: [] }] }] }] }] };
  const outcomes = playwrightOutcomes(report);
  assert.deepEqual(countOutcomes(outcomes), { passed: 1, failed: 1, flaky: 1, skipped: 1, total: 4 });
  assert.deepEqual(unmatchedTitles(["a", "missing"], outcomes), ["missing"]);
  assert.deepEqual(nodeTestCounts("# tests 5\n# suites 0\n# pass 4\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n"), { passed: 4, failed: 1, flaky: 0, skipped: 0, total: 5 });
  assert.equal(nodeTestCounts("Error: Cannot find module"), undefined);
});

test("exact titles match those tests only, special characters and all", () => {
  const grep = new RegExp(exactTitles(["Paylocity's address (front tab)", "a+b"]));
  assert.ok(grep.test("extension.spec.ts Paylocity's address (front tab)"));
  assert.ok(grep.test("a+b"));
  assert.ok(!grep.test("extension.spec.ts Paylocity's address (front tab) again"));
  assert.ok(!grep.test("aab"));
  assert.ok(!grep.test("extension.spec.ts not Paylocity's address (front tabs)"));
});

test("a short check waiting goes before a full suite at the lock", () => {
  const full = { pid: 1, kind: "full" as const, since: 1 };
  const short = { pid: 2, kind: "short" as const, since: 2 };
  assert.equal(mayTakeLock(full, [full, short]), false);
  assert.equal(mayTakeLock(full, [full]), true);
  assert.equal(mayTakeLock(short, [full, short]), true);
});
