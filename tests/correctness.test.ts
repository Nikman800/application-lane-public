// Answers that hold for any applicant, not only a U.S. new graduate: the
// worst outcome is a false statement on an application, so what cannot be
// told is left for the applicant.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { globalConfigSchema } from "../src/engine/config/schema";
import { matchOption } from "../src/engine/values";
import { normalize } from "../src/shared/model";
import { pickOption } from "../src/shared/answers";
import geographyData from "../src/engine/config/globals.json" with { type: "json" };

const globals = globalConfigSchema.parse(JSON.parse(await readFile("src/engine/config/globals.json", "utf8")));

test("text is compared in any script, with accents folded, and nothing never matches nothing", () => {
  assert.equal(normalize("José Álvarez-Núñez"), "jose alvarez nunez");
  assert.equal(normalize("北京大学"), "北京大学");
  assert.equal(normalize("Université de Montréal"), "universite de montreal");
  assert.equal(normalize("ＡＢＣ ﬁle"), "abc file");
  assert.equal(normalize("— / —"), "");
  // Punctuation mangled by a page without a charset is still punctuation.
  assert.equal(normalize("I choose not to selfâ€\u0090identify."), "i choose not to self identify");
  assert.equal(normalize("Iâ€™m"), "i m");
  // A school written without its accents is still the same school.
  assert.deepEqual(matchOption(["Jose University"], [{ label: "José University", value: "1" }], globals), { label: "José University", value: "1" });
  // Two schools in another script are told apart, not both read as "".
  const schools = [{ label: "清华大学", value: "q" }, { label: "北京大学", value: "b" }];
  assert.deepEqual(matchOption(["北京大学"], schools, globals), { label: "北京大学", value: "b" });
  assert.equal(matchOption(["—"], [{ label: "–", value: "x" }], globals), undefined);
  // Oracle's degree pills name a level with examples after it.
  const pills = ["Graduate Master's Degrees (e.g., Master of Arts, Master of Business Administration)", "Undergraduate Bachelor's Degrees (e.g., Bachelor of Science)", "Other"].map((label, at) => ({ label, value: String(at) }));
  assert.equal(matchOption(["Master of Science", "Master's", "MS"], pills, globals)?.value, "0");
  assert.equal(matchOption(["Bachelor of Science", "Bachelor's"], pills, globals)?.value, "1");
  assert.equal(matchOption(["Doctor of Philosophy"], pills, globals), undefined);
  assert.equal(pickOption({ value: "北京大学" }, ["清华大学", "北京大学"], (option) => option), "北京大学");
  assert.equal(pickOption({ value: "—" }, ["–"], (option) => option), undefined);
});

import { once } from "node:events";
import { mkdir, mkdtemp, readdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileSchema, type Field, type Profile } from "../src/shared/model";
import { proposals } from "../src/shared/matching";
import { canonicalValues } from "../src/engine/values";
import { authorizationAnswer, usPerson } from "../src/shared/authorization";
import { locationCountry, type Geography } from "../src/shared/geography";
import { formatSalary, parseSalary } from "../src/shared/salary";
import { hintedFormat, localDate, paperSize, letterDateText, writtenDate } from "../src/shared/dates";
import { splitPhone } from "../src/shared/phone";
import { internshipSeason, profileTargets, searchJobs, searchSettingsSchema, stageDefaults } from "../src/server/job-search";
import { createApp } from "../src/server/app";
import { configSchema } from "../src/server/store";

const base = {
  firstName: "Sam",
  lastName: "Applicant",
  email: "sam@example.test",
  confirmed: true,
  facts: [],
};
const person = (fields: Record<string, unknown>) => profileSchema.parse({ ...base, ...fields });
const field = (label: string, overrides: Partial<Field> = {}): Field => ({
  id: "q",
  label,
  kind: "radio",
  required: true,
  value: "",
  options: ["Yes", "No"],
  revision: 1,
  protected: false,
  ...overrides,
});
const answer = (label: string, who: Profile, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], who)[0]?.value;
const applying = (who: Profile, country?: string, company?: string): Profile => ({ ...who, applyingTo: { country, company } });

test("work authorization is answered only for a country the applicant has an entry for", () => {
  const canadian = person({ country: "Canada", workAuthorization: [{ country: "CA", status: "citizen", needsSponsorship: false }], citizenships: ["CA"] });
  // Asked about the United States: not known, so left for them.
  assert.equal(answer("Are you legally authorized to work in the United States?", canadian), undefined);
  assert.equal(answer("Will you require sponsorship to work in the U.S.?", canadian), undefined);
  assert.equal(answer("Are you authorized to work in Canada?", canadian), "Yes");
  // A U.S. entry saying they are not authorized there answers No.
  const knowsUS = person({ ...canadian, workAuthorization: [...canadian.workAuthorization, { country: "US", status: "none", needsSponsorship: true }] });
  assert.equal(answer("Are you legally authorized to work in the United States?", knowsUS), "No");
  assert.equal(answer("Will you now or in the future require sponsorship to work in the United States?", knowsUS), "Yes");
  // A generic question with two entries and no job country: unknown.
  assert.equal(answer("Are you legally authorized to work?", knowsUS), undefined);
  // The job's country picks the entry.
  assert.equal(answer("Are you legally authorized to work?", applying(knowsUS, "CA")), "Yes");
  assert.equal(answer("Are you legally authorized to work in the country where this job is located?", applying(knowsUS, "US")), "No");
});

test("a U.S. applicant applying to a U.K. job gets no Yes", () => {
  const american = person({ country: "United States", workAuthorization: [{ country: "US", status: "citizen" }], citizenships: ["US"] });
  const uk = applying(american, "GB");
  assert.equal(answer("Are you legally authorized to work?", uk), undefined);
  assert.equal(answer("Do you have the right to work in the UK?", uk), undefined);
  assert.equal(answer("Will you require visa sponsorship?", uk), undefined);
  assert.equal(answer("Are you a citizen of the United Kingdom?", uk), "No");
  // Asked about the U.S. by name, it is still answered.
  assert.equal(answer("Are you authorized to work in the United States?", uk), "Yes");
  // With one entry and no job country, a question naming no place is.
  assert.equal(answer("Are you legally authorized to work?", american), "Yes");
  assert.equal(answer("Will you require visa sponsorship?", american), "No");
  // The config engine's keys read the same way.
  assert.deepEqual(canonicalValues("work_auth", uk), []);
  assert.deepEqual(canonicalValues("work_auth", applying(american, "US")), ["Yes"]);
  // A question about the EU or "any country" names no country it could be.
  assert.equal(answer("Are you authorized to work in the European Union?", american), undefined);
  assert.equal(authorizationAnswer(american, "Are you authorized to work in any other country?", "workAuthorization"), undefined);
});

test("older single answers become one U.S. entry when the profile is a U.S. one", () => {
  const old = person({ country: "United States", workAuthorization: "Yes", sponsorship: "No" });
  assert.deepEqual(old.workAuthorization, [{ country: "US", status: "authorized", needsSponsorship: false }]);
  assert.equal("sponsorship" in old, false);
  const blank = person({ country: "", workAuthorization: "No", sponsorship: "Yes" });
  assert.deepEqual(blank.workAuthorization, [{ country: "US", status: "none", needsSponsorship: true }]);
  // A profile in another country: a plain Yes said nothing about which.
  assert.deepEqual(person({ country: "India", workAuthorization: "Yes", sponsorship: "No" }).workAuthorization, []);
  // A citizen's statement names the country whatever the profile says.
  const citizen = person({ country: "", workAuthorization: "US Citizen" });
  assert.deepEqual(citizen.workAuthorization, [{ country: "US", status: "citizen" }]);
  assert.deepEqual(citizen.citizenships, ["US"]);
  // A plain Yes does not say on what basis: no immigration status is chosen.
  assert.equal(answer("Are you currently authorized to work for any employer in the United States?", old, {
    options: ["Yes - I have US work authorization as a Citizen or US Permanent Resident / Green Card Holder", "Yes - I have US work authorization via a non-immigrant visa (e.g. F-1, H-1B, L-1, TN)", "No"],
  }), undefined);
  // A citizen's entry does.
  assert.equal(answer("Are you currently authorized to work for any employer in the United States?", citizen, {
    options: ["Yes - I have US work authorization as a Citizen or US Permanent Resident / Green Card Holder", "Yes - I have US work authorization via a non-immigrant visa (e.g. F-1, H-1B, L-1, TN)", "No"],
  }), "Yes - I have US work authorization as a Citizen or US Permanent Resident / Green Card Holder");
});

test("citizenship and export-control answers follow the applicant's citizenships and entries", () => {
  const indian = person({ country: "India", workAuthorization: [{ country: "US", status: "visa", visaType: "H-1B", needsSponsorship: true }], citizenships: ["IN"] });
  assert.equal(answer("Are you a U.S. citizen?", indian), "No");
  assert.equal(answer("Are you an Indian citizen?", indian), "Yes");
  assert.equal(usPerson(indian), false);
  assert.equal(answer("This position is subject to export control regulations. Are you a U.S. person?", indian), "No");
  const resident = person({ workAuthorization: [{ country: "US", status: "permanent-resident" }], citizenships: ["MX"] });
  assert.equal(usPerson(resident), true);
  assert.equal(answer("Are you a U.S. person under ITAR?", resident), "Yes");
  assert.equal(answer("Are you a U.S. citizen?", resident), "No");
  // Nothing saved: nothing said.
  assert.equal(answer("Are you a U.S. citizen?", person({})), undefined);
  assert.equal(answer("Are you a U.S. person under ITAR?", person({})), undefined);
  // A statement that contradicts the entries leaves it to the applicant.
  const contradicts = person({ citizenships: ["CA"], legal: { exportControl: "U.S. citizen (a U.S. person under ITAR and EAR)" } });
  assert.equal(answer("Are you a U.S. citizen?", contradicts), undefined);
  // A citizen of one country is asked about countries one by one.
  const dual = person({ citizenships: ["FR", "CA"] });
  assert.equal(answer("Country 1 Name", dual, { kind: "text", options: [] }), "France");
  assert.equal(answer("Country 2 Name", dual, { kind: "text", options: [] }), "Canada");
  assert.equal(answer("Country of citizenship", dual, { kind: "text", options: [] }), undefined);
});

test("a job's place names its country, and an unclear place names none", () => {
  const geography = geographyData as unknown as Geography;
  assert.equal(locationCountry(geography, "Toronto, ON, Canada"), "CA");
  assert.equal(locationCountry(geography, "Toronto, ON, CA"), "CA");
  assert.equal(locationCountry(geography, "Austin, TX"), "US");
  assert.equal(locationCountry(geography, "London, UK"), "GB");
  assert.equal(locationCountry(geography, "Remote - US"), "US");
  assert.equal(locationCountry(geography, "Remote"), undefined);
  assert.equal(locationCountry(geography, "New York, NY; London, UK"), undefined);
});

test("pay is read in any form and currency, and never given one the applicant did not", () => {
  assert.deepEqual(parseSalary("55k"), { min: 55000, currency: "", period: "year" });
  assert.deepEqual(parseSalary("€55.000"), { min: 55000, currency: "EUR", period: "year" });
  assert.deepEqual(parseSalary("£40,000-50,000"), { min: 40000, max: 50000, currency: "GBP", period: "year" });
  assert.deepEqual(parseSalary("$35-40/hr"), { min: 35, max: 40, currency: "$", period: "hour" });
  assert.deepEqual(parseSalary("40-50k CAD"), { min: 40000, max: 50000, currency: "CAD", period: "year" });
  assert.equal(parseSalary("negotiable"), undefined);
  assert.equal(formatSalary({ min: 55000, currency: "", period: "year" }), "55,000");
  // An older profile's free-text pay becomes the structured figure.
  assert.deepEqual(person({ salaryYearly: "€55.000", salaryHourly: "" }).salary, { min: 55000, currency: "EUR", period: "year" });
  assert.deepEqual(person({ salaryYearly: "", salaryHourly: "35" }).salary, { min: 35, currency: "", period: "hour" });
  // A site rule's own figure is never the applicant's.
  const paid = person({ salary: { min: 70000, currency: "", period: "year" } });
  assert.deepEqual(canonicalValues("desired_pay", paid), ["70,000"]);
  assert.deepEqual(canonicalValues("salary_amount", paid), ["70000"]);
  assert.deepEqual(canonicalValues("desired_pay", person({})), []);
});

test("dates follow the field's own format, else the applicant's, else are left", () => {
  assert.equal(hintedFormat("DD/MM/YYYY"), "DD/MM/YYYY");
  assert.equal(hintedFormat("jj.mm.aaaa"), "DD.MM.YYYY");
  assert.equal(hintedFormat("Date: Year-Month-Day"), "YYYY-MM-DD");
  const british = person({ country: "United Kingdom" });
  const american = person({ country: "United States" });
  const nowhere = person({ country: "" });
  const text = (label: string, format?: string) => ({ kind: "text", label, ...(format ? { format } : {}) });
  assert.equal(writtenDate("2027-05-10", text("Graduation date"), british), "10/05/2027");
  assert.equal(writtenDate("2027-05-10", text("Graduation date"), american), "05/10/2027");
  assert.equal(writtenDate("2027-05-10", text("Graduation date", "YYYY-MM-DD"), american), "2027-05-10");
  assert.equal(writtenDate("2027-05-10", text("Graduation date (DD/MM/YYYY)"), american), "10/05/2027");
  assert.equal(writtenDate("2027-05-10", text("Graduation date"), nowhere), undefined);
  assert.equal(writtenDate("2027-05-10", { kind: "date", label: "Graduation" }, nowhere), "2027-05-10");
  assert.equal(writtenDate("2027-05-10", text("Graduation date"), person({ country: "", locale: { dateFormat: "YYYY-MM-DD" } })), "2027-05-10");
  // Today is the applicant's own day, not UTC's.
  const evening = new Date(2026, 10, 3, 23, 30);
  assert.equal(localDate(evening), "2026-11-03");
  // Letters: A4 and a day-first date outside the U.S. and Canada.
  assert.equal(paperSize(british), "a4");
  assert.equal(paperSize(person({ country: "Canada" })), "letter");
  assert.equal(paperSize(american), "letter");
  assert.equal(letterDateText(british, evening), "3 November 2026");
  assert.equal(letterDateText(american, evening), "November 3, 2026");
});

test("an empty end date is not 'still studying', and the highest degree is by level", () => {
  const thisYear = new Date().getFullYear();
  const rows = [
    { organization: "Old College", title: "Associate of Arts", startDate: "2001-09", endDate: "", location: "", details: "" },
    { organization: "Grad School", title: "Master of Science", startDate: `${thisYear - 1}-09`, endDate: "", location: "", details: "" },
    { organization: "State University", title: "Bachelor of Science", startDate: "2015-09", endDate: "2019-05", location: "", details: "" },
  ];
  const migrated = person({ education: rows });
  // The most recent school, begun within six years, is taken as current;
  // the old one is unknown.
  assert.equal(migrated.education[1].current, true);
  assert.equal(migrated.education[0].current, undefined);
  assert.deepEqual(canonicalValues("currently_studying", migrated, { collection: "education", index: 0 }), []);
  assert.deepEqual(canonicalValues("currently_studying", migrated, { collection: "education", index: 1 }), ["Yes"]);
  assert.deepEqual(canonicalValues("graduated_flag", migrated, { collection: "education", index: 2 }), ["Yes"]);
  assert.equal(answer("Did you graduate?", migrated, { kind: "text", options: [], section: "Education", index: 0 }), undefined);
  // The highest degree is the master's, whatever order the rows are in.
  assert.deepEqual(canonicalValues("highestDegree", migrated), ["Master of Science"]);
  // A migrated profile is not migrated again: an entry the applicant marks
  // as finished stays finished.
  const edited = person({ ...migrated, education: migrated.education.map((row, index) => (index === 1 ? { ...row, current: false } : row)) });
  assert.equal(edited.education[1].current, false);
});

test("'worked here before' comes from the work history, and No only with the applicant's say-so", () => {
  const work = [{ organization: "Contoso Electric Company LLC", title: "Intern", startDate: "2023-06", endDate: "2023-08", location: "", details: "" }];
  const who = person({ work });
  const question = "Have you previously been employed by this company?";
  assert.equal(answer(question, applying(who, undefined, "Contoso")), "Yes");
  assert.equal(answer(question, applying(who, undefined, "Acme Corp")), undefined);
  const never = person({ work, neverWorkedForApplyingCompanies: true });
  assert.equal(answer(question, applying(never, undefined, "Acme Corp")), "No");
  // A name that only shares a word is not confidently the same employer.
  assert.equal(answer(question, applying(never, undefined, "Contoso Air Brake")), undefined);
  // Worked there, but before the time asked about.
  assert.equal(answer("Have you worked for Contoso in the past 12 months?", never), "No");
  // one employer's contractor wording: the employer is the one the
  // services were provided to.
  const services = "Have you ever provided services to Acme or any of its subsidiaries/affiliates as a contingent worker or contractor on behalf of a staffing company or other service provider?";
  assert.equal(answer(services, applying(never, undefined, "acme-careers")), "No");
  assert.equal(answer(services.replace("Acme", "Contoso Electric"), applying(never, undefined, "contoso-careers")), "Yes");
  // An older profile's global "No" becomes the toggle.
  assert.equal(person({ priorEmployment: "No" }).neverWorkedForApplyingCompanies, true);
  assert.equal(person({ priorEmployment: "Yes" }).neverWorkedForApplyingCompanies, undefined);
});

test("the phone's country code is its own field, and national-number fields get none", () => {
  assert.deepEqual(splitPhone("+44 20 7946 0958"), { code: "+44", national: "20 7946 0958" });
  assert.deepEqual(splitPhone("+447700900123"), { code: "+44", national: "7700900123" });
  assert.deepEqual(splitPhone("+1 (602) 555-0100"), { code: "+1", national: "(602) 555-0100" });
  assert.deepEqual(splitPhone("602-555-0100"), { national: "602-555-0100" });
  const londoner = person({ country: "United Kingdom", phone: "+44 20 7946 0958" });
  assert.equal(londoner.phoneCountryCode, "+44");
  assert.equal(londoner.phone, "20 7946 0958");
  assert.deepEqual(canonicalValues("phone_stripped", londoner), ["2079460958"]);
  assert.equal(answer("Phone number", londoner, { kind: "text", options: [] }), "20 7946 0958");
  assert.equal(answer("Country code", londoner, { kind: "text", options: [] }), "+44");
  assert.equal(answer("Phone country code", londoner, { kind: "select", options: ["United States (+1)", "United Kingdom (+44)"] }), "United Kingdom (+44)");
  // A list of countries takes the code's country, else the residence.
  const abroad = person({ country: "Germany", phone: "+1 415 555 0100" });
  assert.deepEqual(canonicalValues("phone_country", abroad), ["United States"]);
  assert.deepEqual(canonicalValues("phone_country", person({ country: "Germany", phone: "030 1234567" })), ["Germany"]);
  // An area code is a North American number's only.
  assert.equal(answer("Area code", londoner, { kind: "text", options: [] }), undefined);
});

test("another country's diversity questions are left alone", () => {
  const who = person({ country: "United Kingdom", ethnicity: "South Asian", disabilityStatus: "No", gender: "Male", veteranStatus: "No" });
  assert.equal(answer("What is your ethnic group?", who, { kind: "select", options: ["White - British", "Asian or Asian British - Indian", "Prefer not to say"] }), undefined);
  assert.equal(answer("Do you consider yourself to have a disability under the Equality Act 2010?", who, { options: ["Yes", "No", "Prefer not to say"] }), undefined);
  assert.equal(answer("Do you identify as a member of a visible minority in Canada?", who), undefined);
  assert.equal(answer("Caste", who, { kind: "select", options: ["General", "OBC", "SC", "ST"] }), undefined);
  // The U.S. questions are still answered.
  assert.equal(answer("Disability status", who, { kind: "select", options: ["Yes, I have a disability", "No, I do not have a disability"] }), "No, I do not have a disability");
});

test("a search starts from the applicant's career stage and any country", async () => {
  assert.equal(internshipSeason(Date.UTC(2026, 10, 3)), 2027);
  assert.equal(internshipSeason(Date.UTC(2027, 2, 1)), 2027);
  assert.deepEqual(stageDefaults({ careerStage: "student" }).sources, { newGrad: true, internships: true, boards: true });
  assert.deepEqual(stageDefaults({ careerStage: "experienced" }), { sources: { newGrad: false, internships: false, boards: true }, skipSenior: false });
  // Roles from any field's titles, without their level.
  const nurse = person({ work: [{ organization: "City Hospital", title: "Senior Registered Nurse", startDate: "2018-01", endDate: "", location: "", details: "" }, { organization: "Self", title: "Founder", startDate: "2015-01", endDate: "2016-01", location: "", details: "" }] });
  assert.deepEqual(profileTargets(nurse).roles, ["registered nurse"]);
  // Places in another country; a remote opening with no country is not
  // counted as in one.
  const fetcher = (async (url: string | URL) => {
    if (/Summer2027/.test(String(url))) return new Response("missing", { status: 404 });
    if (/Summer2026/.test(String(url)))
      return new Response(JSON.stringify([
        { id: "a", title: "Nurse Intern", company_name: "Clinic", locations: ["Toronto, ON"], url: "https://a.example.test", active: true },
        { id: "b", title: "Nurse Intern", company_name: "Remote Co", locations: ["Remote"], url: "https://b.example.test", active: true },
        { id: "c", title: "Nurse Intern", company_name: "Elsewhere", locations: ["Austin, TX"], url: "https://c.example.test", active: true },
      ]));
    return new Response("[]");
  }) as typeof fetch;
  const cacheDir = await mkdtemp(join(tmpdir(), "lane-search-"));
  const settings = searchSettingsSchema.parse({ roles: ["nurse"], locations: ["Ontario"], country: "Canada", fromProfile: false, sources: { newGrad: false, internships: true, boards: false } });
  const result = await searchJobs(settings, nurse, { cacheDir, fetcher, now: Date.UTC(2026, 10, 3) });
  assert.deepEqual(result.listings.map((listing) => listing.company), ["Clinic"]);
  assert.equal(result.sources[0].error, undefined);
});

test("deleting local data removes reports, captures, searches, the fixer's results and uploaded transcripts, and keeps config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lane-delete-"));
  const transcripts = await mkdtemp(join(tmpdir(), "lane-transcripts-"));
  const documents = await mkdtemp(join(tmpdir(), "lane-documents-"));
  const cfg = configSchema.parse({ postingLookup: false, token: "test-token-".repeat(7), model: "test", endpoint: "http://127.0.0.1:9999/v1", transcriptsDir: transcripts, documentsDir: documents });
  const { server } = await createApp(cfg, directory);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" };
  const id = "00000000-0000-4000-8000-00000000000c";
  try {
    for (const folder of ["issues", "captures", "recordings", "search", "fixer", "fixer/tasks"]) await mkdir(join(directory, folder), { recursive: true });
    await writeFile(join(directory, "issues", `${id}.har.json`), "{}");
    await writeFile(join(directory, "captures", `${id}.json`), "{}");
    await writeFile(join(directory, "captures", `${id}.har.json`), "{}");
    await writeFile(join(directory, "recordings", `${id}.json`), "{}");
    await writeFile(join(directory, "queue.json"), "{}");
    await writeFile(join(directory, "inbox.json"), "[]");
    await writeFile(join(directory, "search", "latest.json"), "{}");
    await writeFile(join(directory, "fixer", `${id}.json`), "{}");
    await writeFile(join(directory, "fixer", "settings.json"), "{}");
    await writeFile(join(directory, "fixer", "tasks", `${id}.json`), "{}");
    await writeFile(join(transcripts, "mine.pdf"), "%PDF-1.4 kept");
    const upload = await fetch(`${url}/v1/transcript`, { method: "PUT", headers, body: JSON.stringify({ name: "uploaded.pdf", data: Buffer.from("%PDF-1.4 x").toString("base64") }) });
    assert.equal(upload.status, 200);
    assert.equal((await fetch(`${url}/v1/data`, { method: "DELETE", headers })).status, 200);
    const left = async (folder: string) => readdir(folder).catch(() => [] as string[]);
    assert.deepEqual(await left(join(directory, "issues")), []);
    assert.deepEqual(await left(join(directory, "captures")), []);
    assert.deepEqual(await left(join(directory, "recordings")), []);
    assert.deepEqual(await left(join(directory, "search")), []);
    assert.deepEqual((await left(join(directory, "fixer"))).sort(), ["settings.json"]);
    assert.equal((await left(directory)).includes("queue.json"), false);
    assert.equal((await left(directory)).includes("inbox.json"), false);
    // Only the transcript uploaded through the app; the applicant's own stays.
    assert.deepEqual(await left(transcripts), ["mine.pdf"]);
    // Config and pairing stay.
    assert.ok(await stat(join(directory, "config.json")).catch(() => true));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
