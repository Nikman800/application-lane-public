import { test } from "node:test";
import assert from "node:assert/strict";
import { badgeInfo } from "../src/extension/badge-info";

// The badge on an application's page: how the step's fill is
// going, without the side panel open.
test("the page badge says whether the step is filling, done, or needs the applicant", () => {
  const app = (overrides: Partial<Parameters<typeof badgeInfo>[0]> = {}) => ({
    status: "ready" as const, workflowStage: "applying" as const, attempts: [], missing: [], note: "", ...overrides,
  });
  const attempt = (filled: number) => ({ id: "a", tabId: 1, startedAt: 1, status: "needs-review" as const, filled, note: "" });
  assert.deepEqual(badgeInfo(app(), "Alt+Shift+F"), { tone: "idle", title: "Ready to fill", detail: "Alt+Shift+F fills this step" });
  assert.equal(badgeInfo(app({ status: "filling", attempts: [attempt(4)] }), "Alt+Shift+F").title, "Filling…");
  // Documents are made on the first step; later steps only ready answers.
  assert.equal(badgeInfo(app({ status: "preparing" }), "").title, "Preparing documents…");
  assert.equal(badgeInfo(app({ status: "preparing", documentJobId: "job" }), "").title, "Getting this step's answers ready…");
  assert.equal(badgeInfo(app({ status: "filling", attempts: [attempt(4)] }), "").detail, "4 fields so far");
  assert.deepEqual(badgeInfo(app({ status: "awaiting-user", attempts: [attempt(12)], missing: ["Required: Country", "Required: Division", "Optional unanswered: Suffix"] }), ""),
    { tone: "attention", title: "12 filled · 2 need you", detail: "" });
  assert.equal(badgeInfo(app({ status: "awaiting-user", attempts: [attempt(12)], missing: ["Required: Country"] }), "").title, "12 filled · 1 needs you");
  assert.deepEqual(badgeInfo(app({ status: "ready", attempts: [attempt(9)] }), "Alt+Shift+F"), { tone: "done", title: "9 filled", detail: "Alt+Shift+F fills this step" });
  assert.equal(badgeInfo(app({ workflowStage: "submitted", attempts: [attempt(9)] }), "").tone, "submitted");
  assert.equal(badgeInfo(app({ status: "failed", note: "The page closed." }), "").detail, "The page closed.");
});

// The side panel said "Still filling" while the model suggested values, and the
// badge said "63 filled · 2 need you" (Wise).
test("the badge says still filling while the model suggests values for the rest", () => {
  const app = { status: "awaiting-user" as const, workflowStage: "applying" as const, attempts: [{ id: "a", tabId: 1, startedAt: 1, status: "needs-review" as const, filled: 63, note: "" }], missing: ["Required: Country", "Required: Division"], note: "", documentJobId: undefined };
  assert.equal(badgeInfo(app, "").title, "63 filled · 2 need you");
  assert.deepEqual(badgeInfo({ ...app, assisting: true }, "").tone, "working");
  assert.equal(badgeInfo({ ...app, assisting: true }, "").title, "Still filling…");
  // A paused or failed application is not still filling.
  assert.equal(badgeInfo({ ...app, assisting: true, status: "paused" as const }, "").tone, "paused");
});
