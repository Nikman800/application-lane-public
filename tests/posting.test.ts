import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPosting, fetchPostingPage, htmlText, postingEndpoint, postingFromPage, publicPostingURL } from "../src/server/posting";

const long = "Build backend services in Python and Go for the payments platform. ".repeat(3);

test("each ATS application URL leads to its public posting endpoint", () => {
  const api = (url: string) => postingEndpoint(url)?.api;
  assert.equal(
    api("https://job-boards.greenhouse.io/klaviyocampus/jobs/7989364003?gh_src=x"),
    "https://boards-api.greenhouse.io/v1/boards/klaviyocampus/jobs/7989364003",
  );
  assert.equal(
    api("https://boards.greenhouse.io/embed/job_app?for=acme&token=123"),
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs/123",
  );
  // An EU board's embedded form, as on one employer's careers page.
  assert.equal(
    api("https://job-boards.eu.greenhouse.io/embed/job_app?for=acme&validityToken=x&token=4830113101"),
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs/4830113101",
  );
  assert.equal(
    api("https://jobs.lever.co/acronaviation/34cf5ad0-840a-4c1b-8231-02a433d0479e/apply?lever-source=LinkedIn"),
    "https://api.lever.co/v0/postings/acronaviation/34cf5ad0-840a-4c1b-8231-02a433d0479e",
  );
  assert.equal(
    api("https://jobs.eu.lever.co/acme/34cf5ad0-840a-4c1b-8231-02a433d0479e"),
    "https://api.eu.lever.co/v0/postings/acme/34cf5ad0-840a-4c1b-8231-02a433d0479e",
  );
  assert.equal(
    api("https://jobs.ashbyhq.com/acme/0c1d5f3e-6c39-4a0e-9d4b-7d5b0f3c2a11/application"),
    "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true",
  );
  assert.equal(
    api("https://intel.wd1.myworkdayjobs.com/en-US/External/job/US-Oregon-Hillsboro/Software-Engineering---Intern--Bachelor-s_JR0286834/apply/autofillWithResume?source=x"),
    "https://intel.wd1.myworkdayjobs.com/wday/cxs/intel/External/job/US-Oregon-Hillsboro/Software-Engineering---Intern--Bachelor-s_JR0286834",
  );
  // A location holding a slash is refused by the API (400) as an encoded
  // slash; the job's slug alone finds the posting.
  assert.equal(
    api("https://acme.wd5.myworkdayjobs.com/en-US/Acme_Careers/job/Springfield%2FShelbyville%2C-FL/Software-Developer_J1234567/apply/applyManually?utm_source=x"),
    "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Acme_Careers/job/Software-Developer_J1234567",
  );
  assert.equal(
    api("https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26011784/apply/section/2"),
    "https://egug.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%2226011784%22,siteNumber=CX_1",
  );
  // Nothing else is fetched: other sites, account pages, plain http.
  assert.equal(api("https://example.com/jobs/1"), undefined);
  assert.equal(api("https://intel.wd1.myworkdayjobs.com/en-US/External/userHome"), undefined);
  assert.equal(api("http://jobs.lever.co/acme/34cf5ad0-840a-4c1b-8231-02a433d0479e"), undefined);
  assert.equal(api("https://jobs.lever.co/acme/not-a-posting"), undefined);
});

test("posting HTML reads as text, Greenhouse's escaped HTML included", () => {
  assert.equal(
    htmlText("&lt;p&gt;Build &amp;amp; ship&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;li&gt;SQL&lt;/li&gt;&lt;/ul&gt;"),
    "Build & ship\n• Go\n• SQL",
  );
  assert.equal(htmlText("<h2>Role</h2><p>Own&nbsp;the&nbsp;API.</p><script>x()</script>"), "Role\nOwn the API.");
});

test("each ATS response becomes the posting's title, company and description", async () => {
  const respond = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
  const lever = await fetchPosting(["https://jobs.lever.co/acme/34cf5ad0-840a-4c1b-8231-02a433d0479e"], {
    fetch: respond({
      text: "Software Engineer Intern",
      categories: { location: "Phoenix, AZ" },
      descriptionPlain: long,
      lists: [{ text: "What you'll do", content: "<li>Ship features</li>" }],
      additionalPlain: "Equal opportunity employer.",
    }),
  });
  assert.equal(lever?.title, "Software Engineer Intern");
  assert.equal(lever?.company, "acme");
  assert.match(lever!.description, /payments platform[\s\S]*What you'll do\n• Ship features[\s\S]*Equal opportunity/);

  const ashbyId = "0c1d5f3e-6c39-4a0e-9d4b-7d5b0f3c2a11";
  const ashby = await fetchPosting([`https://jobs.ashbyhq.com/acme/${ashbyId}`], {
    fetch: respond({ jobs: [{ id: "other", title: "Other" }, { id: ashbyId, title: "Data Engineer", location: "Remote", descriptionPlain: long }] }),
  });
  assert.deepEqual([ashby?.source, ashby?.title, ashby?.location], ["Ashby", "Data Engineer", "Remote"]);

  const workday = await fetchPosting(["https://intel.wd1.myworkdayjobs.com/External/job/US/Intern_JR1"], {
    fetch: respond({
      jobPostingInfo: { title: "Software Intern", location: "Hillsboro", jobDescription: `<p>${long}</p>` },
      hiringOrganization: { name: "100 Intel Corporation" },
    }),
  });
  assert.deepEqual([workday?.title, workday?.company], ["Software Intern", "Intel Corporation"]);

  const oracle = await fetchPosting(["https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26011784"], {
    fetch: respond({
      items: [{ Title: "Campus Intern", PrimaryLocation: "Phoenix", ExternalDescriptionStr: `<p>${long}</p>`, ExternalQualificationsStr: "<ul><li>Python</li></ul>" }],
    }),
  });
  assert.equal(oracle?.title, "Campus Intern");
  assert.match(oracle!.description, /payments platform[\s\S]*• Python/);
});

test("a failed, empty or unrecognised posting falls through to the next URL, then to nothing", async () => {
  const lever = "https://jobs.lever.co/acme/34cf5ad0-840a-4c1b-8231-02a433d0479e";
  const asked: string[] = [];
  const posting = await fetchPosting(
    ["https://example.com/apply", "https://intel.wd1.myworkdayjobs.com/External/job/US/Intern_JR1", lever],
    {
      fetch: async (url: string) => {
        asked.push(url);
        if (url.includes("myworkdayjobs")) return new Response("Not found", { status: 404 });
        return new Response(JSON.stringify({ text: "Engineer", descriptionPlain: long }), { status: 200 });
      },
    },
  );
  assert.equal(posting?.title, "Engineer");
  // The unknown site was never fetched.
  assert.equal(asked.length, 2);
  // A posting too short to tailor from does not count.
  assert.equal(
    await fetchPosting([lever], {
      fetch: async () => new Response(JSON.stringify({ text: "Engineer", descriptionPlain: "Apply now." }), { status: 200 }),
    }),
    undefined,
  );
  assert.equal(
    await fetchPosting([lever], { fetch: async () => { throw new Error("offline"); } }),
    undefined,
  );
});

test("a linked posting page is read from its schema.org JobPosting, else from its text", () => {
  const described = `<p>${long}</p><ul><li>Python</li></ul>`;
  const ld = postingFromPage(
    `<html><head><title>Careers</title><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [{ "@type": "Organization", name: "Acme" }, { "@type": "JobPosting", title: "Data Intern", hiringOrganization: { name: "Acme Corp" }, description: described }],
    })}</script></head><body>Apply now</body></html>`,
  );
  assert.deepEqual([ld?.title, ld?.company], ["Data Intern", "Acme Corp"]);
  assert.match(ld!.description, /payments platform[\s\S]*• Python/);
  // No structured data: the page's own text, without its navigation.
  const text = postingFromPage(`<html><head><title>Data Intern | Acme</title></head><body><nav>Home Jobs About</nav><main><h1>Data Intern</h1><p>${long.repeat(3)}</p></main></body></html>`);
  assert.equal(text?.title, "Data Intern | Acme");
  assert.doesNotMatch(text!.description, /Home Jobs About/);
  // A page its script builds holds no posting to read: the applicant pastes it.
  assert.equal(postingFromPage('<html><body><div id="root"></div><script src="/app.js"></script></body></html>'), undefined);
});

test("only a public https posting page is fetched, redirects included", async () => {
  assert.equal(publicPostingURL("http://careers.example.com/job/1"), undefined);
  for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.2", "172.20.0.1", "[::1]", "printer.local"])
    assert.equal(publicPostingURL(`https://${host}/job`), undefined, host);
  assert.ok(publicPostingURL("https://careers.example.com/job/1"));
  const asked: string[] = [];
  const page = `<html><body><main><p>${long.repeat(3)}</p></main></body></html>`;
  const reached = await fetchPostingPage("https://careers.example.com/job/1", {
    fetch: async (url: string) => {
      asked.push(url);
      return url.endsWith("/job/1")
        ? new Response("", { status: 302, headers: { location: "/job/1/details" } })
        : new Response(page, { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  assert.equal(reached?.source, "Posting page");
  assert.deepEqual(asked, ["https://careers.example.com/job/1", "https://careers.example.com/job/1/details"]);
  // A redirect to a private address is not followed.
  const internal: string[] = [];
  assert.equal(
    await fetchPostingPage("https://careers.example.com/job/2", {
      fetch: async (url: string) => {
        internal.push(url);
        return new Response("", { status: 302, headers: { location: "https://127.0.0.1/admin" } });
      },
    }),
    undefined,
  );
  assert.deepEqual(internal, ["https://careers.example.com/job/2"]);
});

test("a Workable application's posting is read from its API", () => {
  // one employer's.
  const endpoint = postingEndpoint("https://apply.workable.com/acme-dot-a-i/j/DE75CD20B8/apply/");
  assert.equal(endpoint?.api, "https://apply.workable.com/api/v2/accounts/acme-dot-a-i/jobs/DE75CD20B8");
  const posting = endpoint!.read({
    title: "Business Data Analyst",
    location: { city: "", region: null, country: "United States" },
    description: "<p>Transform raw data into <strong>insight</strong>.</p>",
    requirements: "<ul><li>Master's degree in Data Science</li></ul>",
    benefits: "<ul><li>Remote</li></ul>",
  });
  assert.equal(posting?.source, "Workable");
  assert.equal(posting?.title, "Business Data Analyst");
  assert.equal(posting?.location, "United States");
  assert.match(posting!.description, /Transform raw data into insight\./);
  assert.match(posting!.description, /• Master's degree in Data Science/);
  assert.equal(postingEndpoint("https://apply.workable.com/acme-dot-a-i/")?.api, undefined);
});

test("a SmartRecruiters application's posting is read from its API", () => {
  // ACME's one-click apply form: the posting could not be read.
  const endpoint = postingEndpoint("https://jobs.smartrecruiters.com/oneclick-ui/company/ACME/publication/43759487-0f62-484b-bb63-32a137e7ff02?dcr_ci=ACME");
  assert.equal(endpoint?.api, "https://api.smartrecruiters.com/v1/companies/ACME/postings/43759487-0f62-484b-bb63-32a137e7ff02");
  assert.equal(postingEndpoint("https://jobs.smartrecruiters.com/AcmeGroup/744000012345678-data-scientist-intern")?.api, "https://api.smartrecruiters.com/v1/companies/AcmeGroup/postings/744000012345678");
  assert.equal(postingEndpoint("https://jobs.smartrecruiters.com/AcmeGroup")?.api, undefined);
  const posting = endpoint!.read({
    name: "Geographic Information System Software Developer",
    company: { name: "ACME", identifier: "ACME" },
    location: { city: "Livermore", region: "CA", fullLocation: "Livermore, CA, United States" },
    jobAd: { sections: {
      companyDescription: { title: "Company Description", text: "<p>We solve <b>national security</b> problems.</p>" },
      jobDescription: { title: "Job Description", text: "<ul><li>Build GIS software</li></ul>" },
      qualifications: { title: "Qualifications", text: "<p>Python</p>" },
      videos: { title: "Videos To Watch", text: "" },
    } },
  });
  assert.equal(posting?.source, "SmartRecruiters");
  assert.equal(posting?.title, "Geographic Information System Software Developer");
  assert.equal(posting?.company, "ACME");
  assert.equal(posting?.location, "Livermore, CA, United States");
  assert.match(posting!.description, /We solve national security problems\./);
  assert.match(posting!.description, /• Build GIS software/);
  assert.match(posting!.description, /Qualifications\nPython/);
});

test("a posting endpoint that drops its first answer is asked once more", async () => {
  // Workable's, slow past the time limit at times.
  let calls = 0;
  const posting = await fetchPosting(["https://apply.workable.com/waggoner-financial/j/FA0B644142/apply/"], {
    fetch: async () => {
      calls++;
      if (calls === 1) throw new DOMException("The operation timed out.", "TimeoutError");
      return new Response(JSON.stringify({ title: "Software Engineer Internship", description: `<p>${long}</p>` }), { status: 200 });
    },
  });
  assert.equal(calls, 2);
  assert.equal(posting?.title, "Software Engineer Internship");
});
