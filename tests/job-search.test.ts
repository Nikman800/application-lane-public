import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileSchema } from "../src/shared/model";
import { boardFor, isTracked, knownOpenings, openingKey, profileTargets, searchJobs, searchSettingsSchema } from "../src/server/job-search";
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

// Finding jobs: the applicant's roles and places, or the ones
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
  assert.deepEqual(boardFor("https://jobs.ashbyhq.com/acme"), { ats: "ashby", slug: "acme" });
  assert.deepEqual(boardFor("ashby:acme"), { ats: "ashby", slug: "acme" });
  assert.equal(boardFor("https://example.com/careers"), undefined);
});

// One Workday requisition queued twice from two of its addresses: another career site of the tenant, "/apply", a posting suffix.
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

// An application's address follows the tab through the apply flow (a
// success page, Workday's "userHome", SmartRecruiters' one-click form), and
// the day's submitted openings were not marked tracked.
test("a listing is tracked by its application's job id or its company and title, wherever the application ended", () => {
  const known = [
    { url: "https://careers-acme.icims.com/jobs/93894/platform-engineer/job?mode=submit_apply", company: "acme", title: "Platform Engineer" },
    { url: "https://apply.example.test/careers/apply/success?pid=1970393557049981", company: "example", title: "Careers at Example" },
    { url: "https://beta.wd1.myworkdayjobs.com/en-US/External/userHome", company: "betacorp", title: "Compiler Software Engineering Intern - Summer 2027" },
    { url: "https://jobs.smartrecruiters.com/oneclick-ui/company/Gamma3/publication/a65e1dba", company: "Gamma3", title: "Software Engineer Intern (First Play) - Summer 2027 (Mountain View, CA)" },
    { url: "https://apply.workable.com/delta/j/DE75CD20B8/apply/?success=", company: "Delta", title: "Business Data Analyst" },
  ];
  const listing = (company: string, title: string, url: string, locations: string[] = []) => ({ company, title, url, locations });
  assert.equal(isTracked(listing("Acme", "Platform Engineer", "https://careers.acme.test/jobs/93894?icims=1"), known), true);
  assert.equal(isTracked(listing("Example", "Research Intern", "https://apply.example.test/careers/job/1970393557049981"), known), true);
  assert.equal(isTracked(listing("Beta Corp", "Compiler Software Engineer Intern", "https://beta.wd1.myworkdayjobs.com/External/job/US-WA/Compiler-Software-Engineer-Intern_R1"), known), true);
  assert.equal(isTracked(listing("Gamma", "Software Engineer Intern - First Play", "https://jobs.smartrecruiters.com/Gamma3/744000158394370", ["Mountain View, CA"]), known), true);
  assert.equal(isTracked(listing("Delta", "Business Data Analyst", "https://apply.workable.com/delta/j/DE75CD20B8/apply"), known), true);
  // Another opening of one title on the same site, by its own id: not this one.
  assert.equal(isTracked(listing("Delta", "Business Data Analyst", "https://apply.workable.com/delta/j/516C3CF516/apply"), known), false);
  // Another company with the same title, or another title at the company.
  assert.equal(isTracked(listing("Epsilon", "Platform Engineer", "https://jobs.epsilon.test/1"), known), false);
  assert.equal(isTracked(listing("Acme", "Data Engineer", "https://careers.acme.test/jobs/1"), known), false);
});

// Openings applied to were offered again by a later search: an
// application saved under its site's name ("sec" for one employer's Workday, an
// Ashby board's UUID), its requisition after an underscore, and a title
// carrying its requisition number.
test("a listing is tracked by its job's id whatever the company was saved as", () => {
  const known = [
    { url: "https://zeta.wd3.myworkdayjobs.com/en-US/Zeta_Careers/job/Plano-TX/Data-Analyst-Intern_R121996/apply/applyManually", company: "zeta-careers", title: "Data Analyst Intern" },
    { url: "https://jobs.ashbyhq.com/eta/955d48ad-9380-4621-91f4-51f3f093ac10/application?embed=true", company: "F7d8749a 72d6 407c Bf98 292ea630c73a", title: "Engineer I, Software" },
    { url: "https://career5.successfactors.example/portalcareer?_s.crb=x", company: "theta", title: "Data Analyst Intern (73956)" },
  ];
  const listing = (company: string, title: string, url: string) => ({ company, title, url, locations: [] });
  assert.equal(isTracked(listing("Zeta", "ePro Data Analyst Intern", "https://zeta.wd3.myworkdayjobs.com/Zeta_Careers/job/Plano-TX/Data-Analyst-Intern_R121996"), known), true);
  assert.equal(isTracked(listing("Eta", "Software Engineer 1 New Grad", "https://jobs.ashbyhq.com/f7d8749a-72d6-407c-bf98-292ea630c73a/955d48ad-9380-4621-91f4-51f3f093ac10"), known), true);
  assert.equal(isTracked(listing("Theta", "Data Analyst Intern", "https://jobs.theta.example/job/Data-Analyst-Intern/1455610233/"), known), true);
  // An application whose tab ended on its confirmation page is still known
  // by the listing it began at.
  const sent = knownOpenings([{ url: "https://iota.example/confirmation?LeverAppId=2358ba43", sourceUrl: "https://jobs.lever.co/iota/85c6aec7-8da2-445d-9c4d-812365dbce97/apply", company: "Iota", title: "Data Science Intern [Summer 2027]" }]);
  assert.equal(isTracked(listing("Iota", "Data Scientist Intern", "https://jobs.lever.co/iota/85c6aec7-8da2-445d-9c4d-812365dbce97/apply"), sent), true);
  // Another requisition on the same site, and another job on the same Ashby
  // board (the board's UUID is not the job's), are not these.
  assert.equal(isTracked(listing("Zeta", "AI Data Analyst Intern", "https://zeta.wd3.myworkdayjobs.com/Zeta_Careers/job/Plano-TX/AI-Data-Analyst-Intern_R121971-1"), known), false);
  assert.equal(isTracked(listing("Eta", "Hardware Engineer", "https://jobs.ashbyhq.com/f7d8749a-72d6-407c-bf98-292ea630c73a/11111111-2222-4333-8444-555555555555"), known), false);
});
