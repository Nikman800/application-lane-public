import { test } from "node:test";
import assert from "node:assert/strict";
import { ageAnswer, ageInYears, profileFactAnswer } from "../src/shared/profile-facts";
import { profileSchema, type Field } from "../src/shared/model";
import { proposals } from "../src/shared/matching";
import { applicationQuestion, structuredFallbackField } from "../src/shared/questions";
import { fieldFallbackSources, writeFieldFallback } from "../src/server/field-fallback";
import { configSchema } from "../src/server/store";
import { writeAnswers } from "../src/server/answers";

const field = (label: string, overrides: Partial<Field> = {}): Field => ({
  id: label, label, kind: "radio", required: true, value: "", options: ["Yes", "No"], revision: 1, protected: false, ...overrides,
});
const profile = profileSchema.parse({
  firstName: "Alex", lastName: "Fixture", email: "alex@example.test", facts: [], confirmed: true, dateOfBirth: "2000-11-12", country: "United States",
  skills: ["TypeScript", "Python"],
  education: [
    { organization: "Test Graduate School", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2020-01", endDate: "2099-05", current: true },
    { organization: "Test College", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2010-01", endDate: "2014-05", current: false },
  ],
});
const now = new Date(2026, 10, 12, 12);
const value = (label: string, given = profile, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], given)[0]?.value;

test("age calculation validates calendar dates and changes on the local birthday", () => {
  assert.equal(ageInYears("2008-11-12", new Date(2026, 10, 11, 23, 59)), 17);
  assert.equal(ageInYears("2008-11-12", now), 18);
  assert.equal(ageInYears("2004-02-29", new Date(2026, 1, 28)), 21);
  assert.equal(ageInYears("2004-02-29", new Date(2026, 2, 1)), 22);
  for (const date of ["", "2001-02-29", "2000-13-01", "2000-04-31", "2027-01-01", "11/12/2000"])
    assert.equal(ageInYears(date, now), undefined, date);
});

test("captured age threshold wordings fill from birth date without another saved answer", () => {
  for (const label of ["Are you 18 or older?", "Are you age 18 or over?", "At the time of application, are you 18+ years of age?", "At the time of applying, are you 18 years of age or older?", "Are you 18 years of age or older today?", "Are you at least 18 years old?", "Are you eighteen years of age or older?", "Are you over the age of 18?", "Are you 21 years old or older?"])
    assert.equal(value(label), "Yes", label);
  const younger = { ...profile, dateOfBirth: `${new Date().getFullYear() - 16}-01-01` };
  assert.equal(value("Are you 18 or older?", younger), "No");
  assert.equal(value("Are you under 18?", younger), "Yes");
  assert.equal(value("Are you 18 or older?", profile, { kind: "combobox", options: [] }), "Yes");
  assert.equal(value("Are you 18 or older?", profile, { options: ["Yes, I am 18 or older", "No, I am under 18"] }), "Yes, I am 18 or older");
});

test("age comparisons distinguish strict, inclusive and inverse boundaries", () => {
  const birthday = { ...profile, dateOfBirth: "2008-11-12" };
  for (const [label, expected] of [["Are you 18 or older?", "Yes"], ["Are you over 18?", "No"], ["Are you under 18?", "No"], ["Are you 18 or younger?", "Yes"], ["Are you at least 21?", "No"]])
    assert.equal(ageAnswer(field(label), birthday, now)?.value, expected, label);
});

test("missing or contradictory birthdays never invent age answers", () => {
  assert.equal(value("Are you 18 or older?", { ...profile, dateOfBirth: "" }), undefined);
  assert.equal(value("Are you 18 or older?", { ...profile, dateOfBirth: "2001-02-29" }), undefined);
  assert.equal(value("Are you 18 or older?", { ...profile, age18OrOlder: "No" }), undefined);
  const saved = { ...profile, dateOfBirth: "", age18OrOlder: "Yes" };
  assert.equal(value("Are you 18 or older?", saved), "Yes");
  assert.equal(value("Are you under 18?", saved), "No");
  assert.equal(value("Are you over 18?", saved), undefined);
  assert.equal(value("Are you at least 21?", saved), undefined);
});

test("age words do not answer combined eligibility, future dates, experience or attestations", () => {
  for (const label of ["Are you 18 or older and willing to work nights?", "Are you 18 or older? Can you work nights?", "Will you be 18 by the start of the internship?", "Do you have 18 years of experience?", "I certify that I am at least 18 years old", "Please confirm that you meet the minimum age requirement for employment in your state."])
    assert.equal(value(label), undefined, label);
  assert.equal(value("Are you 18 or older?", { ...profile, answers: [{ question: "Are you 18 or older?", answer: "No" }] }), "No");
  assert.equal(value("Are you 18 or older?", profile, { protected: true }), undefined);
  assert.equal(value("Are you 18 or older?", profile, { value: "No" }), undefined);
});

test("numeric age and birth date use a validated birthday that stays out of AI sources", () => {
  assert.equal(profileFactAnswer(field("How old are you?", { kind: "number", options: [] }), profile, now)?.value, "26");
  assert.equal(profileFactAnswer(field("Date of birth", { kind: "date", options: [] }), profile, now)?.value, "2000-11-12");
  assert.equal(profileFactAnswer(field("Date of birth (DD/MM/YYYY)", { kind: "text", options: [] }), profile, now)?.value, "12/11/2000");
  assert.equal(profileFactAnswer(field("Age", { options: [] }), { ...profile, dateOfBirth: "2000-02-31" }, now), undefined);
  assert.ok(fieldFallbackSources(profile).every(source => !/2000-11-12|date of birth/i.test(source.text)));
});

test("current and completed degree questions select different education facts", () => {
  const options = ["Associate degree", "Bachelor’s degree", "Master’s degree", "PhD or other doctoral degree", "Other"];
  for (const label of ["What degree are you currently pursuing?", "What degree are you currently enrolled in?", "What degree are you currently working toward?", "What is your Current Degree Program?", "Degree In Progress"])
    assert.equal(value(label, profile, { options }), "Master’s degree", label);
  assert.equal(value("What is the highest level of education you have completed?", profile, { options }), "Bachelor’s degree");
  assert.equal(value("Highest Degree Achieved", profile, { options }), "Bachelor’s degree");
  assert.equal(value("What is your highest level of education (completed or in-progress)", profile, { options }), "Master’s degree");
  assert.equal(value("What degree are you currently pursuing?You must be currently pursuing a degree to be eligible for an internship.", profile, { options }), "Master’s degree");
  const question = "Please indicate your degree of study";
  assert.equal(value(`${question}: Masters/phD`, profile, { kind: "checkbox", question }), "Yes");
  assert.equal(value(`${question}: Bachelors`, profile, { kind: "checkbox", question }), undefined); // An unchecked box already says No.
});

test("enrollment predicates check the named program and exclude future study", () => {
  assert.equal(value("Are you currently pursuing a Masters Degree?"), "Yes");
  assert.equal(value("5. Are you currently working towards a Bachelors or Master’s Degree?"), "Yes");
  assert.equal(value("Are you currently pursuing a Doctorate Degree?"), "No");
  const future = { ...profile, education: [{ ...profile.education[0], startDate: "2098-01" }] };
  assert.equal(value("What degree are you currently pursuing?", future, { options: [] }), undefined);
  assert.equal(value("Are you currently pursuing a Masters Degree?", { ...profile, education: [] }), undefined);
});

test("education status, major and institution fields use the appropriate row", () => {
  assert.equal(value("What is/was your major or field of study?", profile, { kind: "text", options: [] }), "Data Science");
  assert.equal(value("Current school or university:", profile, { kind: "text", options: [] }), "Test Graduate School");
  assert.equal(value("Level (High School,College, University, Other)", profile, { section: "Education", index: 1, options: ["High School", "College", "University", "Other"] }), "College");
  assert.equal(value("Education Level", profile, { section: "Education", index: 1, options: [] }), "Bachelor of Science");
  assert.equal(value("Please choose the appropriate Degree Status", profile, { section: "Education", index: 1, options: ["Completed", "In Progress"] }), "Completed");
  assert.equal(value("Please choose the appropriate Degree Status", profile, { section: "Education", index: 0, options: ["Completed", "In Progress"] }), "In Progress");
});

test("diploma checks require completed study and preserve exact saved answers", () => {
  for (const label of ["* Do you have a High school diploma or GED? Yes No", "Do you have a minimum of High School Diploma or GED?", "Have you obtained a High School Diploma, Secondary School Certificate, or equivalent (GED, etc.)?", "Do you have a Bachelor's Degree?"])
    assert.equal(value(label), "Yes", label);
  const ongoing = { ...profile, education: [profile.education[0]] };
  assert.equal(value("Do you have a high school diploma or GED?", ongoing), undefined);
  assert.equal(value("Do you have a Bachelor's Degree in Computer Science and a security clearance?"), undefined);
  const label = "Do you have a high school diploma or GED?";
  assert.equal(value(label, { ...profile, answers: [{ question: label, answer: "No" }] }), "No");
});

test("simple contact and skills fields use saved values without choosing preferences", () => {
  for (const label of ["Preferred Name (Optional)", "Preferred Name (if applicable)", "Preferred Name | What would you like us to call you?"])
    assert.equal(value(label, profile, { kind: "text", options: [] }), "Alex", label);
  assert.equal(value("Skills", profile, { kind: "text", options: [] }), "TypeScript, Python");
  assert.equal(value("What is your preferred coding language?", profile, { options: ["Python", "TypeScript"] }), undefined);
  assert.equal(value("Address Line 2(optional)", { ...profile, addressLine2: "Unit 2" }, { kind: "text", options: [], required: false }), "Unit 2");
  assert.equal(value("Address Line 2(optional)", profile, { kind: "text", options: [], required: false }), undefined);
});

test("explicit programming skills answer simple any-language checks, never stronger claims", () => {
  assert.equal(value("Do you have experience with at least one general-purpose programming language such as Java, Python, C++, C#, Go, Rust, or TypeScript?"), "Yes");
  assert.equal(value("Do you have experience with at least one programming language, such as JavaScript, TypeScript, Python, or Java?"), "Yes");
  for (const label of ["Do you have experience with at least one programming language such as C++, C#?", "Do you have professional experience with at least one programming language such as Python?", "Do you have experience with at least one programming language such as Python and database administration?", "Do you have 5 years of experience with Python?"])
    assert.equal(value(label), undefined, label);
  const cpp = { ...profile, skills: ["C++"] };
  assert.equal(value("Do you have experience with at least one programming language such as C#?", cpp), undefined);
  assert.equal(value("Do you have experience with at least one programming language such as C++?", cpp), "Yes");
  assert.equal(value("How many years of work experience do you have?", { ...profile, yearsExperience: 0 }, { kind: "select", options: ["None", "1 - 2", "3+"] }), "None");
  assert.equal(value("How many years of software development experience do you have?", { ...profile, yearsExperience: 4 }), undefined);
});

test("calculated questions and absent optional contact fields never call AI", async () => {
  const fields = [field("Are you 18 or older?"), field("What degree are you currently pursuing?", { kind: "text", options: [] }), field("Date of birth", { kind: "text", options: [] }), ...["Address Line 2", "Phone Extension", "Alternate Phone Number", "Suffix"].map(label => field(label, { kind: "text", options: [], required: false }))];
  for (const f of fields) {
    assert.equal(applicationQuestion(f), false, f.label);
    assert.equal(structuredFallbackField(f, true), false, f.label);
  }
  // An unreachable endpoint fails the test if any model call is attempted.
  const result = await writeFieldFallback(configSchema.parse({ endpoint: "http://127.0.0.1:1/v1", token: "test-token-".repeat(4) }), {
    applicationId: "00000000-0000-4000-8000-000000000001", operation: 1, profileRevision: 1, title: "Engineer", description: "", url: "https://example.test/job", fields,
  }, profile, new AbortController().signal);
  assert.deepEqual(result, { drafts: [], warnings: [] });
});

test("AI endpoints exclude ordinary profile answers even when an older client requests them", async () => {
  const config = configSchema.parse({ endpoint: "http://127.0.0.1:1/v1", token: "test-token-".repeat(4) });
  const who = { ...profile, phoneDeviceType: "Mobile", answers: [{ question: "When can you start?", answer: "Immediately" }] };
  const request = { applicationId: "00000000-0000-4000-8000-000000000001", operation: 1, profileRevision: 1, title: "Engineer", description: "", url: "https://example.test/job", fields: [field("Phone Device Type", { kind: "combobox", options: ["Mobile", "Home"] })] };
  assert.deepEqual(await writeFieldFallback(config, request, who, new AbortController().signal), { drafts: [], warnings: [] });
  const written = await writeAnswers(config, { ...request, fields: [field("When can you start?", { kind: "textarea", options: [] })] }, who, { profile: "", preferences: "", guidance: "", warnings: [] }, new AbortController().signal);
  assert.deepEqual(written.answers, []);
});
