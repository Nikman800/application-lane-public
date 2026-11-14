import { test } from "node:test";
import assert from "node:assert/strict";
import { applicationWarning, sameJob } from "../src/shared/duplicates";
import { badgeInfo } from "../src/extension/badge-info";

const app = (id: string, url: string, overrides: Record<string, unknown> = {}) => ({
  id, url, title: "Software Engineer", status: "awaiting-user" as const, workflowStage: "applying" as const, tabId: undefined as number | undefined, ...overrides,
});

// Two copies of one application worked at once clash, and one already
// submitted must not be sent again.
test("the page warns when the fixer has the application, or another copy of the job is submitted or open", () => {
  const here = app("a", "https://boards.example.test/acme/jobs/123456/apply", { tabId: 1 });
  // The fixer's records.
  assert.equal(applicationWarning(here, [here], "being-fixed")?.kind, "being-fixed");
  assert.equal(applicationWarning(here, [here], "needs-fixing")?.kind, "being-fixed");
  assert.equal(applicationWarning(here, [here], "released"), undefined);
  // Another record of the same job, submitted.
  const submitted = app("b", "https://boards.example.test/acme/jobs/123456/apply?utm_source=x", { workflowStage: "submitted" as const });
  assert.equal(applicationWarning(here, [here, submitted])?.kind, "copy-submitted");
  // Another copy open in a tab.
  const open = app("c", "https://boards.example.test/acme/jobs/123456/apply", { tabId: 9 });
  assert.equal(applicationWarning(here, [here, open])?.kind, "copy-open");
  // A copy with no tab, a cancelled or abandoned one, or another job: no warning.
  assert.equal(applicationWarning(here, [here, app("d", here.url)]), undefined);
  assert.equal(applicationWarning(here, [here, app("e", here.url, { status: "cancelled" as const, tabId: 3 })]), undefined);
  assert.equal(applicationWarning(here, [here, app("f", here.url, { workflowStage: "abandoned" as const, tabId: 3 })]), undefined);
  assert.equal(applicationWarning(here, [here, app("g", "https://boards.example.test/acme/jobs/999999/apply", { tabId: 4 })]), undefined);
  // A submitted application says so itself; it is not warned of its twin.
  assert.equal(applicationWarning({ ...here, workflowStage: "submitted" as const }, [here, submitted]), undefined);
});

test("one Workday requisition is one job across its addresses, and a site's front page is no job", () => {
  const a = { url: "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Austin-TX/Engineer_R-1001/apply", sourceUrl: undefined, postingUrl: undefined };
  const b = { url: "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Austin-TX/Engineer_R-1001", sourceUrl: undefined, postingUrl: undefined };
  const c = { url: "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Austin-TX/Engineer_R-2002", sourceUrl: undefined, postingUrl: undefined };
  assert.equal(sameJob(a, b), true);
  assert.equal(sameJob(a, c), false);
  const front = { url: "https://boards.example.test/", sourceUrl: undefined, postingUrl: undefined };
  assert.equal(sameJob(front, { ...front }), false);
});

test("the badge shows the warning over the fill's own state", () => {
  const state = { status: "filling" as const, workflowStage: "applying" as const, attempts: [], missing: [], note: "", documentJobId: undefined };
  assert.deepEqual(badgeInfo(state, "", { kind: "being-fixed", title: "Being fixed", detail: "Leave it alone." }), { tone: "warn", title: "Being fixed", detail: "Leave it alone." });
  assert.equal(badgeInfo(state, "").tone, "working");
  assert.equal(badgeInfo({ ...state, workflowStage: "submitted" as const }, "").title, "Submitted");
});
