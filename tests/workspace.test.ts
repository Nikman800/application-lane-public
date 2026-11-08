import assert from "node:assert/strict";
import test from "node:test";
import type { QueueState } from "../src/shared/model";
import { companyFor, migrateLocks, migrateQueue, redactURL, secretName } from "../src/extension/workspace";

test("legacy queues migrate into the manual tracker without losing the active tab", () => {
  const legacy = {
    applications: [
      {
        id: "application-1",
        tabId: 42,
        url: "https://jobs.example.test/application/1",
        title: "Frontend Engineer",
        status: "queued",
        operation: 3,
        updatedAt: 100,
      },
      {
        id: "application-2",
        url: "https://acme.example.test/jobs/2",
        title: "Designer",
        status: "cancelled",
        operation: 1,
        updatedAt: 200,
      },
    ],
    settings: { concurrency: 4, generationConcurrency: 2 },
  } as unknown as QueueState;

  const migrated = migrateQueue(legacy, 500, () => "tab-relation-1");

  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(
    {
      sourceUrl: migrated.applications[0].sourceUrl,
      company: migrated.applications[0].company,
      workflowStage: migrated.applications[0].workflowStage,
      stageUpdatedAt: migrated.applications[0].stageUpdatedAt,
      explicitFill: migrated.applications[0].explicitFill,
      attempts: migrated.applications[0].attempts,
      issueCount: migrated.applications[0].issueCount,
    },
    {
      sourceUrl: "https://jobs.example.test/application/1",
      company: "example",
      workflowStage: "applying",
      stageUpdatedAt: 100,
      explicitFill: false,
      attempts: [],
      issueCount: 0,
    },
  );
  assert.deepEqual(migrated.applications[0].tabs[0], {
    id: "tab-relation-1",
    tabId: 42,
    url: "https://jobs.example.test/application/1",
    title: "Frontend Engineer",
    role: "posting",
    fieldCount: 0,
    state: "no-form",
    lastSeenAt: 500,
  });
  assert.equal(migrated.applications[1].workflowStage, "abandoned");
  assert.equal(migrated.applications[1].tabs.length, 0);
});

test("report URLs keep their path but drop token-like query values", () => {
  const url = redactURL(
    "https://acme.example/apply/42?token=abc123&step=2&session_id=s1#access_token=x",
  );
  assert.ok(!url.includes("abc123"));
  assert.ok(!url.includes("s1"));
  assert.ok(!url.includes("access_token=x"));
  assert.ok(url.includes("/apply/42"));
  assert.ok(url.includes("step=2"));
  assert.equal(redactURL("not a url"), "not a url");
  assert.ok(!redactURL("https://a.example/x?csrf=7052CF&page=2").includes("7052CF"));
});

test("secret control names cover common CSRF and session fields", () => {
  for (const name of [
    "authenticity_token",
    "__RequestVerificationToken",
    "csrf-token",
    "user_otp",
    "password",
  ])
    assert.ok(secretName.test(name), name);
  for (const name of ["Are you authorized to work?", "Optional", "First name"])
    assert.ok(!secretName.test(name), name);
});

test("company names come from the job board path or title, not the board host", () => {
  assert.equal(
    companyFor(
      "https://job-boards.greenhouse.io/klaviyocampus/jobs/7989364003",
      "Job Application for Software Engineer Intern (Summer 2027) at Klaviyo Campus",
    ),
    "Klaviyo Campus",
  );
  assert.equal(companyFor("https://jobs.lever.co/acme-labs/123"), "Acme Labs");
  // Greenhouse's embedded form names its board in "for".
  assert.equal(companyFor("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123"), "Acme");
  assert.equal(companyFor("https://acme.wd5.myworkdayjobs.com/x"), "acme");
  assert.equal(
    companyFor("https://example.com/job", "Work at Home Specialist"),
    "example",
  );
  assert.equal(companyFor("https://careers.acme.com/jobs/1"), "acme");
});

test("locks saved by older builds are dropped once; current ones are kept", () => {
  const old = { "app-1": [":0:pronoun", "phone:0:phone"] };
  assert.deepEqual(migrateLocks(old, undefined), { locks: {}, migrated: true });
  assert.deepEqual(migrateLocks(old, 1), { locks: {}, migrated: true });
  assert.deepEqual(migrateLocks(old, 2), { locks: old, migrated: false });
  assert.deepEqual(migrateLocks(undefined, 2), { locks: {}, migrated: false });
});
