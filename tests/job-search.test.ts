import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileSchema } from "../src/shared/model";
import { boardFor, openingKey, profileTargets, searchJobs, searchSettingsSchema } from "../src/server/job-search";
import { sameOpening, workdayOpening } from "../src/shared/matching";

const day = 86_400_000;
const now = Date.UTC(2026, 9, 30);
const profile = profileSchema.parse({
  firstName: "Alex",
  lastName: "Rivera",
  email: "alex@example.test",
  city: "Tucson",
  state: "AZ",
  confirmed: true,
  revision: 1,
  facts: [],
  work: [{ organization: "Example Labs", title: "Software Engineer Intern", startDate: "2024-06", endDate: "2024-09", location: "", details: "" }],
  education: [{ organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-05", location: "", details: "" }],
});

// Listings as SimplifyJobs and the job boards publish them; nothing is
// fetched from the network.
const fetcher = (async (url: string | URL) => {
  const address = String(url);
  const body =
    /New-Grad-Positions/.test(address)
      ? [
          { id: "1", title: "Software Engineer, New Grad", company_name: "Acme", locations: ["Phoenix, AZ"], url: "https://acme.example.test/1", date_posted: (now - 2 * day) / 1000, active: true, is_visible: true, category: "Software" },
          { id: "2", title: "Data Scientist I", company_name: "Beta", locations: ["Remote in USA"], url: "https://beta.example.test/2", date_posted: (now - 5 * day) / 1000, active: true, is_visible: true },
          { id: "3", title: "Mechanical Engineer", company_name: "Gamma", locations: ["Tucson, AZ"], url: "https://gamma.example.test/3", date_posted: (now - 1 * day) / 1000, active: true, is_visible: true },
          { id: "4", title: "Software Engineer", company_name: "Delta", locations: ["Seattle, WA"], url: "https://delta.example.test/4", date_posted: (now - 3 * day) / 1000, active: true, is_visible: true },
          { id: "5", title: "Software Engineer", company_name: "Old", locations: ["Phoenix, AZ"], url: "https://old.example.test/5", date_posted: (now - 90 * day) / 1000, active: true, is_visible: true },
          { id: "6", title: "Software Engineer", company_name: "Closed", locations: ["Phoenix, AZ"], url: "https://closed.example.test/6", date_posted: (now - 1 * day) / 1000, active: false, is_visible: true },
        ]
      : /boards-api\.greenhouse\.io\/v1\/boards\/acme\/jobs/.test(address)
        ? { jobs: [{ id: 9, title: "Machine Learning Engineer", location: { name: "Arizona" }, absolute_url: "https://boards.greenhouse.io/acme/jobs/9", first_published: new Date(now - day).toISOString() }] }
        : undefined;
  return body ? new Response(JSON.stringify(body)) : new Response("missing", { status: 404 });
}) as typeof fetch;

// Finding jobs (2026-10-30): the applicant's roles and places, or the ones
// their profile suggests, over SimplifyJobs and companies' own job boards.
test("a job search finds the roles and places asked for, newest and closest first", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "lane-search-"));
  const settings = searchSettingsSchema.parse({
    roles: ["software engineer"],
    locations: ["Arizona"],
    fromProfile: false,
    companies: ["https://boards.greenhouse.io/acme", "jobs.lever.co/missing", "example.com/careers"],
  });
  const result = await searchJobs(settings, profile, { cacheDir, fetcher, now, known: new Set(["https://acme.example.test/1"]) });
  // Phoenix, AZ is Arizona; Seattle is not; one 90 days old and one closed
  // are left out; a data scientist is not a software engineer.
  assert.deepEqual(result.listings.map((listing) => listing.company), ["Acme"]);
  assert.equal(result.listings[0].tracked, true);
  assert.deepEqual(result.listings[0].matched, ["software engineer", "Arizona"]);
  // Each source says what it gave, or why it gave nothing.
  assert.deepEqual(result.sources.map((source) => [source.id, source.count, Boolean(source.error)]), [
    ["simplify-new-grad", 5, false],
    ["greenhouse:acme", 1, false],
    ["lever:missing", 0, true],
    ["example.com/careers", 0, true],
  ]);
  // Remote openings count wherever they are; the board's ML role is found
  // when asked for.
  const wider = await searchJobs({ ...settings, roles: ["data scientist", "machine learning"] }, profile, { cacheDir, fetcher, now });
  assert.deepEqual(wider.listings.map((listing) => listing.company).sort(), ["Beta", "acme"]);
});

test("a search from the profile looks for its roles, where the applicant lives unless they relocate anywhere", async () => {
  assert.deepEqual(profileTargets(profile), {
    roles: ["software engineer", "data scientist", "data engineer", "machine learning", "data analyst"],
    locations: ["AZ", "Tucson"],
  });
  assert.deepEqual(profileTargets(profile, "- **Relocation:** Yes, open to relocating anywhere.").locations, []);
  const cacheDir = await mkdtemp(join(tmpdir(), "lane-search-"));
  const result = await searchJobs(searchSettingsSchema.parse({ fromProfile: true, companies: [] }), profile, { cacheDir, fetcher, now });
  assert.deepEqual(result.listings.map((listing) => listing.company), ["Acme", "Beta"]);
  assert.deepEqual(result.roles.slice(0, 2), ["software engineer", "data scientist"]);
});

test("a company's job board is named by its address or as ats:slug", () => {
  assert.deepEqual(boardFor("https://job-boards.greenhouse.io/acme"), { ats: "greenhouse", slug: "acme" });
  assert.deepEqual(boardFor("jobs.lever.co/acme/123"), { ats: "lever", slug: "acme" });
  assert.deepEqual(boardFor("https://jobs.ashbyhq.com/notion"), { ats: "ashby", slug: "notion" });
  assert.deepEqual(boardFor("ashby:notion"), { ats: "ashby", slug: "notion" });
  assert.equal(boardFor("https://example.com/careers"), undefined);
});

// One Workday requisition queued twice from two of its addresses (KLA,
// 2026-11-03): another career site of the tenant, "/apply", a posting suffix.
test("addresses of one Workday requisition are one opening, and other requisitions are not", () => {
  const search = "https://acme.wd1.myworkdayjobs.com/search/job/Springfield-IL/Software-Engineer-Intern_2642721-1";
  const apply = "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Springfield%2C-IL/Software-Engineer-Intern_2642721/apply?ssoProvider=google";
  const manual = "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Springfield%2C-IL/Software-Engineer-Intern_2642721/apply/applyManually";
  assert.equal(workdayOpening(search), "acme.wd1.myworkdayjobs.com#2642721");
  assert.ok(sameOpening(search, apply));
  assert.ok(sameOpening(apply, manual));
  assert.equal(openingKey(search), openingKey(apply));
  assert.equal(workdayOpening("https://acme.wd5.myworkdayjobs.com/en-US/Ext/job/Chicago/Associate_JR-012345-2"), "acme.wd5.myworkdayjobs.com#jr-012345");
  // A neighbouring requisition, the same number at another tenant, and other sites.
  assert.ok(!sameOpening(search, "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Springfield%2C-IL/System-Software-Engineer_2642720/apply"));
  assert.ok(!sameOpening(search, "https://other.wd1.myworkdayjobs.com/search/job/Springfield-IL/Software-Engineer-Intern_2642721-1"));
  assert.equal(workdayOpening("https://boards.greenhouse.io/acme/jobs/2642721"), undefined);
  assert.ok(sameOpening("https://boards.greenhouse.io/acme/jobs/1?utm_source=x", "https://boards.greenhouse.io/acme/jobs/1"));
});
