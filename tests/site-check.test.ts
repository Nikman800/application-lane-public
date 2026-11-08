import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSite, checkSites, siteOfAddress, type SiteCheck } from "../src/server/site-check";

test("an opening's site is known from its address, its host, or the ATS its address names", () => {
  assert.equal(siteOfAddress("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Remote/Engineer_JR1")?.ats, "Workday");
  assert.equal(siteOfAddress("https://job-boards.greenhouse.io/acme/jobs/123")?.ats, "Greenhouse");
  assert.equal(siteOfAddress("https://jobs.lever.co/acme/123")?.ats, "Lever");
  // A careers page that embeds Greenhouse names its job ID (Rubrik's).
  assert.deepEqual(siteOfAddress("https://www.example.com/company/careers/departments/job.8267709?gh_jid=8267709"), { ats: "Greenhouse", by: "parameter" });
  // Paccar's names its ATS outright.
  assert.equal(siteOfAddress("https://jobs.example.com/job/Intern/1451916833/?ats=successfactors")?.ats, "SuccessFactors");
  // A careers page of its own, with nothing to go on.
  assert.equal(siteOfAddress("https://careers.example.com/jobs/93894"), undefined);
});

test("a careers page is read for the ATS its links lead to", async () => {
  const pages: Record<string, { status: number; body: string; url?: string }> = {
    "https://careers.example.com/jobs/93894": { status: 200, body: '<a href="https://careers-acme.icims.com/jobs/93894/login">Apply</a>' },
    "https://careers.example.net/job/1": { status: 200, body: "<p>Apply on our own site.</p>" },
    "https://careers.example.org/job/2": { status: 200, body: "", url: "https://acme.wd1.myworkdayjobs.com/en-US/External/job/Intern_R1" },
  };
  const fetcher = (async (input: string | URL) => {
    const page = pages[String(input)];
    const response = new Response(page?.body ?? "", { status: page?.status ?? 404 });
    if (page?.url) Object.defineProperty(response, "url", { value: page.url });
    return response;
  }) as typeof fetch;
  assert.deepEqual(await checkSite("https://careers.example.com/jobs/93894", fetcher), { ats: "iCIMS", via: "https://careers-acme.icims.com/jobs/93894/login", by: "page" });
  assert.deepEqual(await checkSite("https://careers.example.net/job/1", fetcher), { by: "none" });
  assert.equal((await checkSite("https://careers.example.org/job/2", fetcher)).ats, "Workday");
  // Checked once each.
  let requests = 0;
  const counted = (async (input: string | URL) => (requests++, fetcher(input))) as typeof fetch;
  const cache = new Map<string, SiteCheck>();
  await checkSites(["https://careers.example.net/job/1", "https://careers.example.net/job/1", "https://jobs.lever.co/acme/1"], cache, counted);
  await checkSites(["https://careers.example.net/job/1"], cache, counted);
  assert.equal(requests, 1);
  assert.equal(cache.get("https://jobs.lever.co/acme/1")?.ats, "Lever");
});
