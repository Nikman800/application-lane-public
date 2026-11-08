import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, fillHistory, greenhouseFields, greenhouseJob, readGreenhouse, siteGaps } from "../src/server/form-preview";
import { profileSchema } from "../src/shared/model";

const profile = profileSchema.parse({
  firstName: "Alex",
  lastName: "Rivera",
  email: "alex@example.test",
  phone: "6025550101",
  country: "United States",
  city: "Phoenix",
  confirmed: true,
  revision: 1,
  facts: [{ id: "fact-1", text: "Built accessible web applications with TypeScript." }],
});

test("past fills say what a site and a company left to the applicant", () => {
  const history = fillHistory([
    { url: "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/A_1", company: "Acme", needs: ["Veteran Status", "How did you hear about us?"], lastFill: {} },
    { url: "https://beta.wd5.myworkdayjobs.com/en-US/Jobs/job/B_2", company: "Beta Corp", needs: ["Veteran Status"], lastFill: {} },
    { url: "https://gamma.wd1.myworkdayjobs.com/en-US/Jobs/job/C_3", company: "Gamma", needs: [], lastFill: {} },
    // Never filled: says nothing.
    { url: "https://delta.wd1.myworkdayjobs.com/en-US/Jobs/job/D_4", company: "Delta", needs: ["Anything"] },
  ]);
  const workday = history.forListing({ url: "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/E_5", company: "Acme, Inc." });
  assert.deepEqual(workday?.site, { name: "Workday", applications: 3, leftSome: 2, common: [{ label: "Veteran Status", count: 2 }] });
  assert.deepEqual(workday?.company, { applications: 1, left: ["Veteran Status", "How did you hear about us?"] });
  assert.equal(history.forListing({ url: "https://jobs.lever.co/zeta/1", company: "Zeta" }), undefined);
});

test("a site rule's known gaps are named for its openings", () => {
  assert.equal(siteGaps("https://apply.careers.microsoft.com/careers/job/1", undefined).length, 1);
  assert.equal(siteGaps("https://jobs.smartrecruiters.com/Acme/1", "SmartRecruiters").length, 1);
  assert.deepEqual(siteGaps("https://jobs.lever.co/acme/1", "Lever"), []);
});

test("a Greenhouse opening's published form is answered offline", async () => {
  assert.deepEqual(greenhouseJob("https://job-boards.greenhouse.io/acme/jobs/4749545005"), { board: "acme", id: "4749545005" });
  assert.deepEqual(greenhouseJob("https://boards.greenhouse.io/embed/job_app?for=acme&token=123"), { board: "acme", id: "123" });
  assert.equal(greenhouseJob("https://jobs.lever.co/acme/1"), undefined);
  const job = {
    questions: [
      { label: "First Name", required: true, fields: [{ type: "input_text" }] },
      { label: "Email", required: true, fields: [{ type: "input_text" }] },
      { label: "Resume/CV", required: true, fields: [{ type: "input_file" }, { type: "textarea" }] },
      { label: "Why do you want to work at Acme?", required: true, fields: [{ type: "textarea" }] },
      { label: "What is your favorite color?", required: true, fields: [{ type: "multi_value_single_select", values: [{ label: "Red" }, { label: "Blue" }] }] },
      { label: "Anything else?", required: false, fields: [{ type: "input_text" }] },
    ],
    location_questions: [
      { label: "Location (City)", required: false, fields: [{ type: "input_text" }] },
      { label: "Longitude", required: false, fields: [{ type: "input_hidden" }] },
    ],
    compliance: [{ questions: [{ label: "VeteranStatus", required: false, fields: [{ type: "multi_value_single_select", values: [{ label: "I am not a protected veteran" }] }] }] }],
  };
  const fields = greenhouseFields(job);
  assert.deepEqual(fields.map((field) => [field.label, field.kind]), [
    ["First Name", "text"], ["Email", "text"], ["Resume/CV", "file"], ["Why do you want to work at Acme?", "textarea"],
    ["What is your favorite color?", "select"], ["Anything else?", "text"], ["Location (City)", "text"], ["Veteran Status", "select"],
  ]);
  const summary = classify(fields, profile, "Acme");
  assert.equal(summary.total, 8);
  assert.equal(summary.ai, 1);
  assert.deepEqual(summary.you, ["What is your favorite color?"]);
  assert.ok(summary.profile >= 3);
  // Read from the board's API; one it cannot read is none.
  const requested: string[] = [];
  const fetcher = (async (input: string | URL) => {
    requested.push(String(input));
    return new Response(JSON.stringify(job), { status: 200 });
  }) as typeof fetch;
  assert.equal((await readGreenhouse("https://job-boards.greenhouse.io/acme/jobs/42", fetcher))?.length, 8);
  assert.deepEqual(requested, ["https://boards-api.greenhouse.io/v1/boards/acme/jobs/42?questions=true"]);
  assert.equal(await readGreenhouse("https://job-boards.greenhouse.io/acme/jobs/43", (async () => new Response("", { status: 404 })) as typeof fetch), undefined);
});
