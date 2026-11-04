import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { extractResume } from "../src/server/documents";
import { dateRange, detailBullets, resumeDocx, resumePdf } from "../src/server/resume-layout";
import { resumeNarrative, resumeProfile } from "./support/resume-fixture";

const flat = (text: string) => text.replace(/\s+/gu, " ");
const pageCount = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();

test("resume dates read month and year, with Present for a current role", () => {
  assert.equal(dateRange("2022-03", ""), "Mar 2022 – Present");
  assert.equal(dateRange("2019-06-01", "2022-02-28"), "Jun 2019 – Feb 2022");
  assert.equal(dateRange("2015", "2019"), "2015 – 2019");
  assert.equal(dateRange("", ""), "");
  assert.deepEqual(detailBullets("- One\n• Two\n\n  * Three\nFour"), ["One", "Two", "Three", "Four"]);
});

test("the built-in resume PDF has the header, sections, bullets and dates on one page", async () => {
  const bytes = await resumePdf(resumeProfile(), resumeNarrative());
  assert.equal(await pageCount(bytes), 1);
  const text = flat(await extractResume(Buffer.from(bytes), "pdf"));
  for (const expected of [
    "Alex Rivera",
    "alex.rivera@example.com",
    "Phoenix, AZ",
    "linkedin.com/in/alex-rivera",
    "github.com/alexrivera",
    "HIGHLIGHTS",
    "EXPERIENCE",
    "EDUCATION",
    "SKILLS",
    "LANGUAGES",
    "Improved application response times by 30%",
    "Cut median API response times by 30%",
    "Senior Software Engineer",
    "Northwind Health",
    "Mar 2022 – Present",
    "Jun 2019 – Feb 2022",
    "B.S., Computer Science",
    "PostgreSQL",
    "Spanish: Professional",
  ])
    assert.ok(text.includes(expected), `${expected} in: ${text}`);
  assert.doesNotMatch(text, /Selected experience for/);
});

test("a resume too long for one page runs onto a second without losing anything", async () => {
  const profile = resumeProfile();
  profile.work = Array.from({ length: 9 }, (_, i) => ({
    ...profile.work[i % 2],
    organization: `Employer ${i + 1}`,
    details: Array.from({ length: 5 }, (_, j) => `- Delivered outcome ${i + 1}.${j + 1} for a cross-functional team of engineers and designers`).join("\n"),
  }));
  const bytes = await resumePdf(profile, resumeNarrative());
  assert.equal(await pageCount(bytes), 2);
  const text = flat(await extractResume(Buffer.from(bytes), "pdf"));
  for (let i = 1; i <= 9; i++) {
    assert.ok(text.includes(`Employer ${i}`), `Employer ${i}`);
    for (let j = 1; j <= 5; j++) assert.ok(text.includes(`Delivered outcome ${i}.${j} for`), `outcome ${i}.${j}`);
  }
  assert.ok(text.includes("Spanish: Professional"));
});

test("a slightly long resume is tightened to fit one page", async () => {
  const profile = resumeProfile();
  profile.work = [...profile.work, ...profile.work, { ...profile.work[0], organization: "Fabrikam" }];
  const bytes = await resumePdf(profile, resumeNarrative([...resumeNarrative().resume.map((f) => f.text), "Shipped an accessible form library adopted by six product teams."]));
  assert.equal(await pageCount(bytes), 1);
  assert.ok(flat(await extractResume(Buffer.from(bytes), "pdf")).includes("Fabrikam"));
});

test("the page size is the caller's", async () => {
  const bytes = await resumePdf(resumeProfile(), resumeNarrative(), { pageSize: [595.28, 841.89] });
  const [page] = (await PDFDocument.load(bytes)).getPages();
  assert.deepEqual(page.getSize(), { width: 595.28, height: 841.89 });
});

test("the built-in resume DOCX carries the same content", async () => {
  const buffer = await resumeDocx(resumeProfile(), resumeNarrative());
  const text = flat(await extractResume(buffer, "docx"));
  for (const expected of [
    "Alex Rivera",
    "alex.rivera@example.com",
    "HIGHLIGHTS",
    "EXPERIENCE",
    "EDUCATION",
    "SKILLS",
    "Raised test coverage from 45% to ≥80%",
    "Migrated a legacy jQuery front end to React",
    "Senior Software Engineer",
    "Mar 2022 – Present",
    "B.S., Computer Science",
    "Michigan State University",
  ])
    assert.ok(text.includes(expected), `${expected} in: ${text}`);
});
