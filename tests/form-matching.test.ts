import { test } from "node:test";
import assert from "node:assert/strict";
import {
  profileSchema,
  type Field,
  type Application,
} from "../src/shared/model";
import { canonicalAnswer, pickOption as pickListOption } from "../src/shared/answers";
import { deterministicAnswer, nameVariants, postingGuess, proposals } from "../src/shared/matching";
import { configPassTimeout, transitionTiming } from "../src/shared/timing";
import { degreeAliases } from "../src/shared/education";

test("authorization never invents documentary proof or temporary immigration status", () => {
  const p = us(profile, "Yes", "No");
  for (const label of ["Can you provide proof that you are authorized to work in the United States?", "Do you have temporary work authorization?"]) {
    for (const options of [[], ["Yes", "No"]])
      assert.deepEqual(proposals([field(label, { kind: "combobox", options })], p), [], label);
  }
  const label = "Can you provide proof that you are authorized to work in the United States?";
  assert.equal(proposals([field(label, { kind: "combobox", options: ["Yes", "No"] })], {
    ...p, answers: [{ question: label, answer: "No" }],
  })[0]?.value, "No");
});

test("confirmed school-name prompts and direct postal requests never answer unrelated school facts", () => {
  for (const label of ["College/University", "College or University", "Current University", "Please select your current or most recent university.", "Which university will you graduate from?", "Please include the university you are currently enrolled in.", "Which institution do you currently attend/have most recently attended?", "Which institution do you currently or most recently attend?", "Which university are you currently attending? Select Other if not listed", "Please re-confirm the university you currently attend", "What college/university are currently enrolled?", "Which college or university do you currently attend?", "What is the name of your University?", "Which University do/did you attend?", "What University do you currently attend?", "What college/university did you attend?"])
    assert.equal(proposals([field(label)], profile)[0]?.value, "Test University", label);
  for (const label of ["University GPA", "College enrollment status", "University email", "Which university did your parent attend?", "Which university will you graduate from and when?"])
    assert.equal(deterministicAnswer(field(label), profile), undefined, label);
  assert.deepEqual(proposals([field("Current University")], { ...profile, education: [] }), []);
  assert.deepEqual(proposals([field("Please select your current or most recent university.", { kind: "combobox", options: ["Other", "A Different University"] })], profile), []);
  for (const label of ["Please enter the ZIP code of your primary residence in the United States.", "Please provide your Post Code/ ZIP code."])
    assert.equal(deterministicAnswer(field(label), profile), "85001");
  assert.equal(deterministicAnswer(field("Please provide your full permanent address (city, state and ZIP)"), profile), undefined);
  assert.equal(deterministicAnswer(field("How did you hear about Zipline?"), profile), undefined);
});

test("state picker abbreviations require the corresponding confirmed country and state", () => {
  const picker = field("State", { kind: "combobox", options: ["AK", "AZ"] });
  assert.equal(proposals([picker], profile)[0]?.value, "AZ");
  assert.deepEqual(proposals([picker], { ...profile, country: "Unknown" }), []);
  assert.deepEqual(proposals([field("State", { kind: "combobox", options: ["AK"] })], profile), []);
});

test("a location-address helper uses confirmed location facts, while commute ability stays unknown", () => {
  assert.equal(proposals([field("Address (city, region, country)")], profile)[0]?.value, "Phoenix, Arizona, United States");
  assert.equal(proposals([field("Address")], profile)[0]?.value, "100 Test Way");
  assert.deepEqual(proposals([field("Address (city, region, country)")], { ...profile, city: "" }), []);
  const onsite = { ...profile, answers: [{ question: "Are you willing to work onsite?", answer: "Yes" }] };
  assert.deepEqual(proposals([field("Are you able to commute to our Boulder office five days a week?", { kind: "radio", options: ["YES", "NO"] })], onsite), []);
});

test("education aliases preserve degree level and specialization", () => {
  const options = ["Bachelor's", "Bachelor of Arts", "Master's"];
  const science = profileSchema.parse({ ...profile, education: [{ ...profile.education[0], title: "Bachelor of Science" }] });
  assert.equal(proposals([field("Degree", { kind: "select", options })], science)[0]?.value, "Bachelor's");
  assert.deepEqual(proposals([field("Degree", { kind: "select", options: ["Bachelor of Arts", "Master's"] })], science), []);
  assert.equal(degreeAliases("BS").includes("Bachelor of Science"), true);
  assert.equal(degreeAliases("Unknown certificate").length, 0);
  // A plural level ("Masters of Science") is the same degree: Cisco's
  // Workday lists "Master of Science", and both Degree boxes stayed empty
  // (2026-10-17).
  assert.equal(degreeAliases("Masters of Science")[0], "Master of Science");
  assert.equal(degreeAliases("Bachelors of Science")[0], "Bachelor of Science");
  assert.equal(degreeAliases("Bachelors of Arts")[0], "Bachelor of Arts");
  // Still never another specialization.
  assert.equal(degreeAliases("Masters of Science").includes("Master of Arts"), false);
  assert.equal(deterministicAnswer(field("School"), science), science.education[0].organization);
  assert.equal(deterministicAnswer(field("Current location"), science), science.city);
  assert.equal(deterministicAnswer(field("Where are you currently located?"), science), science.city);
  // Reports, 2026-10-13 (Ashby): "(City, State)" got the country as well, and
  // "Preferred Last Name" was left empty.
  assert.equal(proposals([field("Where are you currently located? (City, State)")], science)[0]?.value, [science.city, science.state].filter(Boolean).join(", "));
  assert.equal(proposals([field("Where are you currently located? (City, State, Country)")], science)[0]?.value, [science.city, science.state, science.country].filter(Boolean).join(", "));
  assert.equal(proposals([field("Preferred Last Name")], science)[0]?.value, science.lastName);
  // A report, 2026-10-14 (Pinterest, Greenhouse): "…to work in the country in
  // which you are applying" names no country; the list was left empty.
  const sponsored = proposals([field("Will you now or in the future require employer sponsorship or other employer assistance to obtain, extend, or maintain authorization to work in the country in which you are applying for a position ?", { kind: "combobox" })], us(science, "", "No"))[0];
  assert.equal(sponsored?.value, "No");
  assert.equal(proposals([field("Will you require sponsorship to work in which country?", { kind: "combobox" })], us(science, "", "No"))[0], undefined);
  // Citi's Workday, 2026-10-28: "the country or jurisdiction where the
  // position to which you are applying is located" names none either.
  const citi = us(science, "Yes", "No");
  assert.equal(proposals([field("Will you, now or in the future, require sponsorship for employment in the country or jurisdiction where the position to which you are applying is located?", { kind: "combobox" })], citi)[0]?.value, "No");
  assert.equal(proposals([field("Are you legally authorized to work in the country or jurisdiction where the position to which you are applying is located?", { kind: "combobox" })], citi)[0]?.value, "Yes");
  // NVIDIA's Workday asks the job's country, then "that country" (report
  // 8ca807c1, 2026-11-04), its options unread until the list opens.
  assert.equal(proposals([field("Will you require employer support to obtain or maintain authorization to work in that country? e.g. (work permit)", { kind: "combobox" })], citi)[0]?.value, "No");
  // Axiom Space's Workday lists "Authorized" and "Not Authorized" (report 0197354d).
  assert.equal(proposals([field("Are you legally authorized to work in the United States?", { kind: "combobox", options: ["Authorized", "Not Authorized"] })], citi)[0]?.value, "Authorized");
  // Microsoft's careers site words it "country/region" (report ae0e9ee8).
  assert.equal(proposals([field("Are you legally authorized to work in the country/region you are applying for?", { kind: "combobox" })], citi)[0]?.value, "Yes");
  // Being authorized does not say the applicant can produce the documents.
  assert.equal(proposals([field("Can you, within the time period prescribed by law, submit verification of both your identity and authorization to work in the country or jurisdiction where the position to which you are applying is located? (Proof will be required)", { kind: "combobox" })], citi)[0], undefined);
  // Epic Games' form, 2026-10-14: "the location associated with this job
  // posting" names no place, and "legal authorization to work" is asked.
  const epic = us(science, "Yes", "No");
  assert.equal(proposals([field("Do you now, or will you in the future, require sponsorship for employment authorization in order to legally work in the location associated with this job posting?", { kind: "combobox" })], epic)[0]?.value, "No");
  assert.equal(proposals([field("Do you have legal authorization to work in the geographic region specified for the internship?", { kind: "combobox" })], epic)[0]?.value, "Yes");
  assert.equal(proposals([field("Are you willing to work in the location of this role?", { kind: "combobox" })], epic)[0], undefined);
  // A report, 2026-10-13 (Greenhouse): the race list loads its options only
  // when opened, and was left empty.
  const race = proposals([field("Please identify your race", { kind: "combobox", required: false })], { ...science, ethnicity: "South Asian" })[0]!;
  assert.equal(pickListOption(race, ["American Indian or Alaskan Native", "Asian", "Black or African American", "White"], (option) => option), "Asian");
  assert.equal(pickListOption(race, ["Asian", "South Asian", "White"], (option) => option), "South Asian");
  assert.equal(proposals([field("Please identify your race", { kind: "combobox", required: false })], { ...science, ethnicity: "" })[0], undefined);
  // A report, 2026-10-13 (Greenhouse): a question about one project, with its
  // description and challenges, was answered with the GitHub profile.
  const linked = { ...science, github: "github.com/example" };
  assert.equal(proposals([field("Can you provide a link to a recent project you’ve worked on? Please include a brief description of the project, any challenges you faced, and the link to it.", { kind: "textarea" })], linked)[0]?.value, undefined);
  assert.equal(proposals([field("Please share a link to your projects or GitHub")], linked)[0]?.value, "https://github.com/example");
  // A report, 2026-10-13 (Greenhouse): the phone country list says "United
  // States +1"; the profile says "United States of America".
  const american = { ...science, country: "United States of America" };
  const phoneCountry = proposals([field("Country", { kind: "select", options: ["Canada +1", "United States +1", "United Kingdom +44"] })], american)[0]!;
  assert.equal(pickListOption(phoneCountry, ["Canada +1", "United States +1", "United Kingdom +44"], (option) => option), "United States +1");
  // Amazon asks it as a question (report f686f6a0, 2026-10-25).
  const located = proposals([field("What country/region are you currently located?", { kind: "select", options: ["Canada", "United States"] })], american)[0]!;
  assert.equal(pickListOption(located, ["Canada", "United States"], (option) => option), "United States");
  assert.equal(deterministicAnswer(field("Desired location"), science), undefined);
  assert.equal(deterministicAnswer(field("Date"), science), undefined);
  assert.equal(deterministicAnswer(field("Do you agree to relocate?"), science), undefined);
});

const profile = profileSchema.parse({
  firstName: "Alex",
  lastName: "Fixture",
  email: "alex@example.test",
  confirmed: true,
  address: "100 Test Way",
  city: "Phoenix",
  state: "Arizona",
  postalCode: "85001",
  country: "United States",
  facts: [],
  education: [
    {
      organization: "Test University",
      title: "Bachelor's Degree",
      fieldOfStudy: "Computer Science",
      startDate: "2024-08",
      endDate: "2028-05",
    },
  ],
});
const field = (label: string, overrides: Partial<Field> = {}): Field => ({
  id: "fixture",
  label,
  kind: "text",
  required: true,
  value: "",
  options: [],
  revision: 1,
  protected: false,
  ...overrides,
});

// PageUp (report 98d686e3) labels its address fields "Postcode/ZIP:" and
// "State / District:"; neither was answered from the profile.
test("a postcode and a state asked for under their regional names are answered from the profile", () => {
  for (const label of ["Postcode/ZIP:", "Postcode", "Post code", "ZIP / Postal code"])
    assert.equal(deterministicAnswer(field(label), profile), profile.postalCode, label);
  for (const label of ["State / District:", "State / Province / Region", "State/Territory"])
    assert.equal(deterministicAnswer(field(label), profile), profile.state, label);
  assert.equal(deterministicAnswer(field("Postcode of your school"), profile), undefined);
});

// PageUp (report 645e8cca) pre-fills "Home address line two" from the
// account's older address; the profile's address has no second line.
test("a second address line the site kept from another address is emptied, or replaced with the profile's", () => {
  const stale = (label: string, overrides: Partial<Field> = {}) =>
    field(label, { required: false, value: "Oldtown ZZ", siteValue: true, ...overrides });
  for (const label of ["Home address line two", "Address Line 2", "Street address 2", "Address 2:"]) {
    const [proposal] = proposals([stale(label)], profile);
    assert.equal(proposal?.value, "", label);
    assert.equal(proposal?.expectedValue, "Oldtown ZZ", label);
  }
  const suite = profileSchema.parse({ ...profile, addressLine2: "Suite 4" });
  assert.equal(proposals([stale("Home address line two")], suite)[0]?.value, "Suite 4");
  assert.equal(proposals([field("Address line 2")], suite)[0]?.value, "Suite 4");
  // Nothing to empty, the applicant's own entry, or no address to go by.
  assert.deepEqual(proposals([field("Address line 2")], profile), []);
  assert.deepEqual(proposals([stale("Address line 2", { siteValue: false })], profile), []);
  assert.deepEqual(
    proposals([stale("Address line 2")], profileSchema.parse({ ...profile, address: "" })),
    [],
  );
  // Other pre-filled fields the profile cannot answer are left as they are.
  assert.deepEqual(proposals([stale("Middle name")], profile), []);
});

// AMD's iCIMS (report d9900f7d, 2026-11-07): the site's parser put
// "Hyderabad" under a job the profile says was remote.
test("a place the site parsed for a remote job is emptied", () => {
  const remote = profileSchema.parse({
    ...profile,
    work: [
      { organization: "Example Labs", title: "Engineer", location: "Lansing, MI", startDate: "2024-01", endDate: "", details: "" },
      { organization: "Solo Studio", title: "Founder", location: "Remote", startDate: "2025-03", endDate: "", details: "" },
    ],
  });
  const parsed = (label: string, index: number, overrides: Partial<Field> = {}) =>
    field(label, { required: false, value: "Hyderabad", siteValue: true, section: "Professional Experience", index, ...overrides });
  for (const label of ["City", "Address", "Postal Code", "State"])
    assert.equal(proposals([parsed(label, 1)], remote)[0]?.value, "", label);
  // A job with a place keeps its own; the applicant's own entry and a
  // school's place are left alone.
  assert.equal(proposals([parsed("City", 0)], remote)[0]?.value, "Lansing");
  assert.deepEqual(proposals([parsed("City", 1, { siteValue: false })], remote), []);
  assert.deepEqual(proposals([parsed("City", 1, { section: "Education" })], remote), []);
});

// SuccessFactors (Westinghouse, report 63ee7aa5) pre-fills "Home/Area Code"
// and "Home Phone #" from the account's older number; neither was replaced
// with the profile's.
test("a home phone and area code the site kept from an older number are replaced with the profile's", () => {
  const phoned = profileSchema.parse({ ...profile, phone: "+1 (555) 201-0199" });
  const stale = (label: string, value: string) => field(label, { value, siteValue: true });
  assert.equal(proposals([stale("* Home/Area Code", "999")], phoned)[0]?.value, "555");
  assert.equal(proposals([stale("* Home Phone #", "9990000000")], phoned)[0]?.value, phoned.phone);
  for (const label of ["Area Code", "Home Phone Number", "Cell Phone #", "Mobile Phone"])
    assert.ok(deterministicAnswer(field(label), phoned), label);
  // The same number is left as it is; an area code only comes from a North
  // American number.
  assert.deepEqual(proposals([stale("Home/Area Code", "555")], phoned), []);
  assert.equal(deterministicAnswer(field("Area Code"), profileSchema.parse({ ...profile, phone: "+44 20 7946 0000" })), undefined);
  assert.equal(deterministicAnswer(field("Area Code"), profile), undefined);
});

// PageUp (report b040f06f) pre-fills "Education status:" with "Completed"
// from the resume; a degree still under way was never corrected.
test("an education status is answered from the degree's end date, and a wrong pre-filled one is replaced", () => {
  const status = (overrides: Partial<Field> = {}) =>
    field("Education status:", {
      kind: "combobox",
      section: "Highest level of education",
      ...overrides,
    });
  const [ongoing] = proposals([status({ value: "Completed", siteValue: true })], profile);
  assert.equal(ongoing?.value, "In progress");
  assert.equal(ongoing?.expectedValue, "Completed");
  const options = ["Select", "All But Dissertation", "Completed", "In progress", "Incomplete"];
  assert.equal(proposals([status({ kind: "select", options })], profile)[0]?.value, "In progress");
  const finished = profileSchema.parse({
    ...profile,
    education: [{ ...profile.education[0], endDate: "2020-05" }],
  });
  assert.equal(proposals([status()], finished)[0]?.value, "Completed");
  // Already right, no end date to go by, or a status outside education.
  assert.deepEqual(proposals([status({ value: "Completed", siteValue: true })], finished), []);
  const undated = profileSchema.parse({
    ...profile,
    education: [{ ...profile.education[0], endDate: "" }],
  });
  assert.deepEqual(proposals([status({ value: "Completed", siteValue: true })], undated), []);
  assert.deepEqual(proposals([status({ section: "Work experience" })], profile), []);
});

test("contact aliases fill exact confirmed values, default the preferred name, and do not invent a current company", () => {
  assert.equal(
    deterministicAnswer(field("email", { kind: "textarea" }), profile),
    profile.email,
  );
  assert.equal(
    deterministicAnswer(field("Home address", { kind: "textarea" }), profile),
    "100 Test Way\nPhoenix, Arizona, 85001\nUnited States",
  );
  assert.equal(
    deterministicAnswer(field("Preferred First Name"), profile),
    profile.firstName,
  );
  assert.equal(
    deterministicAnswer(field("Current company"), profile),
    undefined,
  );
  const completed = {
    ...profile,
    preferredName: "Al",
    github: "https://github.com/fixture",
    currentCompany: "Current Co",
    website: "https://example.test",
  };
  assert.equal(
    deterministicAnswer(field("Preferred First Name"), completed),
    "Al",
  );
  assert.equal(
    deterministicAnswer(field("* First & Last Name"), profile),
    `${profile.firstName} ${profile.lastName}`,
  );
  // Oracle's "Preferred Full Name": the preferred first name, then the last.
  assert.equal(
    deterministicAnswer(field("Preferred Full Name"), profile),
    `${profile.firstName} ${profile.lastName}`,
  );
  assert.equal(
    deterministicAnswer(field("Preferred Full Name"), completed),
    `Al ${profile.lastName}`,
  );
  assert.equal(
    deterministicAnswer(field("GitHub URL"), completed),
    completed.github,
  );
  assert.equal(
    deterministicAnswer(field("Other website"), completed),
    completed.website,
  );
  assert.equal(
    deterministicAnswer(field("Current company"), completed),
    completed.currentCompany,
  );
});

test("education dates split into exact month/year options and never invent missing days", () => {
  const inEducation = (label: string, overrides: Partial<Field> = {}) =>
    field(label, { section: "Education", index: 0, ...overrides });
  assert.equal(
    deterministicAnswer(inEducation("School Dropdown"), profile),
    "Test University",
  );
  assert.equal(
    deterministicAnswer(inEducation("Major"), profile),
    "Computer Science",
  );
  assert.equal(
    deterministicAnswer(inEducation("Start Date Year"), profile),
    "2024",
  );
  assert.equal(
    deterministicAnswer(
      inEducation("End date month", { kind: "combobox" }),
      profile,
    ),
    "May",
  );
  assert.equal(
    proposals(
      [
        inEducation("Start Date Month", {
          kind: "select",
          options: ["Jan", "Aug", "Dec"],
        }),
      ],
      profile,
    )[0].value,
    "Aug",
  );
  assert.equal(
    deterministicAnswer(inEducation("Start Date Day"), profile),
    undefined,
  );
  assert.equal(
    deterministicAnswer(inEducation("Start date", { kind: "date" }), profile),
    undefined,
  );
  // With a full date, day lists and date inputs use the real day.
  const dated = {
    ...profile,
    education: [{ ...profile.education[0], startDate: "2024-08-05" }],
  };
  assert.equal(
    deterministicAnswer(
      inEducation("Start Date Day", {
        kind: "select",
        options: Array.from({ length: 31 }, (_, i) => String(i + 1)),
      }),
      dated,
    ),
    "5",
  );
  assert.equal(
    deterministicAnswer(inEducation("Start date", { kind: "date" }), dated),
    "2024-08-05",
  );
  // Answered from the end date: still ahead means not yet graduated.
  assert.equal(
    deterministicAnswer(inEducation("Did You Graduate?"), profile),
    "No",
  );
  assert.equal(
    deterministicAnswer(inEducation("Did You Graduate?"), {
      ...profile,
      education: [{ ...profile.education[0], endDate: "2020-05" }],
    }),
    "Yes",
  );
  assert.equal(
    deterministicAnswer(inEducation("Start Date Year", { index: 2 }), profile),
    undefined,
  );
});

test("consent, initials, and signatures stay manual even when an exact answer was saved", () => {
  for (const question of [
    "PLEASE INITIAL EACH PARAGRAPH BEFORE SIGNING",
    "I understand this agreement",
    "I authorize you to contact my prior employers",
    "I hereby certify this information is correct",
  ]) {
    assert.equal(
      deterministicAnswer(field(question), {
        ...profile,
        answers: [{ question, answer: "Yes" }],
      }),
      undefined,
    );
  }
  const question = "Are you legally authorized to work in the United States?";
  assert.equal(
    deterministicAnswer(field(question), {
      ...profile,
      answers: [{ question, answer: "Yes" }],
    }),
    "Yes",
  );
});

test("active duration excludes paused and queued time, including overnight waits", () => {
  const app = { status: "queued" } as Application;
  transitionTiming(app, "inspecting", 1000);
  transitionTiming(app, "preparing", 1200);
  transitionTiming(app, "paused", 1500);
  transitionTiming(app, "queued", 50_000_000);
  transitionTiming(app, "filling", 50_100_000);
  transitionTiming(app, "ready", 50_100_400);
  assert.equal(app.preparationMs, 900);
  assert.equal(app.activeSince, undefined);
});

test("GPA, internships, pronouns and orientation match each portal's wording", () => {
  const answering = profileSchema.parse({
    ...profile,
    gpa: "3.62",
    internshipCount: "0",
    pronouns: "He/Him",
    sexualOrientation: "Straight",
  });
  const pick = (label: string, options: string[], who = answering) =>
    proposals([field(label, { kind: "select", options })], who)[0]?.value;
  // The Klaviyo (Greenhouse) option lists.
  const gpaOptions = ["Below 2", "2 - 2.24", "3.5 - 3.74", "3.75 - 4", "4+"];
  assert.equal(pick("What is your GPA?", gpaOptions), "3.5 - 3.74");
  assert.equal(
    pick("What is your GPA?", gpaOptions, withGPA(answering, "4.0")),
    "3.75 - 4",
  );
  assert.equal(
    pick("What is your GPA?", gpaOptions, withGPA(answering, "1.9")),
    "Below 2",
  );
  const internships = ["None", "1", "2", "3", "3+"];
  const label =
    "How many prior internship(s) and/or co-op(s) have you completed in software engineering?";
  assert.equal(pick(label, internships), "None");
  assert.equal(pick(label, internships, { ...answering, internshipCount: "3" }), "3");
  assert.equal(pick(label, internships, { ...answering, internshipCount: "5" }), "3+");
  assert.equal(
    pick("Pronoun", ["He/Him/His", "She/Her/Hers", "He/They", "Other"]),
    "He/Him/His",
  );
  assert.equal(
    pick("Sexual Orientation", ["Straight", "Gay", "Bi-Sexual", "I don't wish to answer"]),
    "Straight",
  );
  assert.equal(
    pick(
      "Sexual Orientation",
      ["Heterosexual", "Bi-Sexual", "I don't wish to answer"],
      { ...answering, sexualOrientation: "Decline" },
    ),
    "I don't wish to answer",
  );
  assert.equal(
    pick(
      "Sexual Orientation",
      ["Heterosexual", "Bi-Sexual"],
      { ...answering, sexualOrientation: "bi" },
    ),
    "Bi-Sexual",
  );
  // A range list is a four-point one: a GPA on another scale is left.
  assert.equal(pick("What is your GPA?", gpaOptions, withGPA(answering, "8.7", "10")), undefined);
  // Free-text questions get the number itself; blanks are left for the user.
  assert.equal(proposals([field("GPA")], answering)[0]?.value, "3.62");
  assert.equal(proposals([field("GPA (out of 10)")], answering)[0]?.value, undefined);
  assert.equal(proposals([field("CGPA out of 10")], withGPA(answering, "8.7", "10"))[0]?.value, "8.7");
  assert.equal(proposals([field("Pronouns")], profile).length, 0);
  // The dropdown hint travels with the proposal when options load later.
  assert.deepEqual(
    proposals([field("What is your GPA?", { kind: "combobox" })], answering)[0],
    {
      fieldId: "fixture",
      value: "3.62",
      numeric: 3.62,
      expectedValue: "",
      revision: 1,
      source: "confirmed-profile",
    },
  );
});

test("profile rejects internship values that cannot be matched, and keeps each school's GPA as written", () => {
  assert.equal(profileSchema.safeParse({ ...profile, internshipCount: "two" }).success, false);
  // A grade on any scale is the applicant's to write ("8.7", "85", "1.3").
  for (const gpa of ["3.62", "8.7", "85", "1.3"])
    assert.equal(profileSchema.safeParse(withGPA(profile, gpa, "other")).success, true, gpa);
  // An older profile's one GPA moves to its latest school, on a four-point
  // scale when it fits one.
  const moved = profileSchema.parse({ ...profile, gpa: "3.6" });
  assert.equal(moved.education[0].gpa, "3.6");
  assert.equal(moved.education[0].gpaScale, "4");
  assert.equal("gpa" in moved, false);
});

// The single U.S. answers an older profile held, as today's entries.
const us = (who: typeof profile, workAuthorization: string, sponsorship = "") =>
  profileSchema.parse({ ...who, workAuthorization, sponsorship, citizenships: [] });
const withGPA = (who: typeof profile, gpa: string, gpaScale: "4" | "5" | "10" | "100" | "other" = "4") =>
  ({ ...who, education: who.education.map((row, index) => (index === 0 ? { ...row, gpa, gpaScale } : row)) });

test("long school and program names reach a picker's short canonical names", () => {
  assert.deepEqual(
    nameVariants(
      "M.S. Data Science, Statistics & Engineering (Applied Systems)",
    ).slice(-3),
    ["Data Science", "Statistics", "Engineering"],
  );
  assert.ok(
    nameVariants("Pennsylvania State University, University Park").includes(
      "Pennsylvania State University",
    ),
  );
  assert.deepEqual(nameVariants("Computer Science"), []);
  const educated = profileSchema.parse({
    ...profile,
    education: [
      {
        organization: "Pennsylvania State University, University Park",
        title: "Bachelors of Science",
        fieldOfStudy: "M.S. Data Science, Statistics & Engineering (Applied Systems)",
        startDate: "2020-09",
        endDate: "2027-05",
      },
    ],
  });
  const pick = (label: string, options: string[]) =>
    proposals(
      [field(label, { kind: "select", options, section: "Education", index: 0 })],
      educated,
    )[0]?.value;
  // Punctuation differs from the picker's wording; the name is the same.
  assert.equal(
    pick("School", ["Pennsylvania State University - University Park", "Pennsylvania State University - Penn State Harrisburg"]),
    "Pennsylvania State University - University Park",
  );
  assert.equal(pick("Discipline", ["Computer Science", "Data Science"]), "Data Science");
  assert.equal(
    proposals(
      [field("What is your anticipated graduation month/year?", { kind: "select", options: ["December 2026", "May 2027", "Other"] })],
      educated,
    )[0]?.value,
    "May 2027",
  );
  assert.equal(
    proposals([field("Expected graduation year")], educated)[0]?.value,
    "2027",
  );
  // An ongoing program without an end date is left to the applicant.
  assert.equal(
    proposals([field("What is your anticipated graduation month/year?", { kind: "combobox" })], profileSchema.parse({ ...educated, education: [{ ...educated.education[0], endDate: "" }] })).length,
    0,
  );
});

test("project-link questions get the profile's GitHub or website as a full URL", () => {
  const linked = profileSchema.parse({
    ...profile,
    github: "github.com/alex-rivera",
    website: "alexrivera.dev",
    linkedin: "linkedin.com/in/alex-rivera",
  });
  const answer = (label: string) => proposals([field(label, { required: false })], linked)[0]?.value;
  assert.equal(
    answer("We encourage you to share a link that showcases something you've built and shipped yourself."),
    "https://github.com/alex-rivera",
  );
  assert.equal(answer("Portfolio URL"), "https://alexrivera.dev");
  assert.equal(answer("LinkedIn Profile"), "https://linkedin.com/in/alex-rivera");
  // Already-complete links are kept as saved.
  assert.equal(
    proposals([field("GitHub")], { ...linked, github: "https://github.com/x" })[0]?.value,
    "https://github.com/x",
  );
  // No link in the profile: the question is left to the applicant.
  assert.equal(
    proposals([field("Share a link to a project you built")], { ...linked, github: "", website: "" }).length,
    0,
  );
});

test("parser-filled education rows follow profile order; entries of the applicant's own pair by school", () => {
  const educated = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-05" },
      { organization: "Test Polytechnic", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06" },
    ],
  });
  const row = (index: number, label: string, value = "", siteValue = false) =>
    field(label, { id: `${index}-${label}`, section: "Education", index, value, siteValue, required: true });
  // As a resume parser left them: row 0 holds the second school's major,
  // row 1 holds the first school's name.
  const fields = [
    row(0, "School"),
    row(0, "Major", "Computer Science", true),
    row(0, "Start date year"),
    row(1, "School", "Michigan state university", true),
    row(1, "Major"),
    row(1, "Start date year", "1999", true),
  ];
  const plan = (list: typeof fields) =>
    Object.fromEntries(
      proposals(list, educated).map((proposal) => [proposal.fieldId, proposal.value]),
    );
  // The parser's guesses decide nothing: rows follow the profile's order,
  // and wrong guesses are replaced.
  assert.deepEqual(plan(fields), {
    "0-School": "Michigan State University",
    "0-Major": "Data Science",
    "0-Start date year": "2025",
    "1-School": "Test Polytechnic",
    "1-Major": "Computer Science",
    "1-Start date year": "2020",
  });
  // A school the applicant entered themselves does pair its row.
  const entered = fields.map((field) =>
    field.id === "1-School" ? { ...field, siteValue: false } : field,
  );
  // (Row 0's parsed major is already right for that school, so it stays.)
  assert.deepEqual(plan(entered), {
    "0-School": "Test Polytechnic",
    "0-Start date year": "2020",
    "1-Major": "Data Science",
    "1-Start date year": "2025",
  });
  // Without the site flag, an existing value is never replaced.
  assert.equal(
    proposals([row(1, "Start date year", "1999")], educated).length,
    0,
  );
});

test("work authorization and sponsorship choices come from the profile, in either wording", () => {
  const applicant = profileSchema.parse({ ...profile, workAuthorization: "Yes", sponsorship: "No" });
  const yesNo = ["Yes", "No"];
  const pick = (label: string, options = yesNo, kind = "radio", who = applicant) =>
    proposals([field(label, { kind, options })], who)[0]?.value;
  // Lever custom-question wording from the eval corpus.
  assert.equal(pick("Are you authorized to work in the United States?"), "Yes");
  assert.equal(pick("Are you lawfully authorized to work in the United States?"), "Yes");
  assert.equal(pick("Do you require sponsorship now or in the future to work at Neighbor?"), "No");
  assert.equal(pick("Will you require sponsorship for employment now or in the future?", yesNo, "select"), "No");
  assert.equal(pick("Will you now or in the future require sponsorship for work authorization?"), "No");
  assert.equal(pick("Do you currently require immigration sponsorship for work authorization? "), "No");
  // Asking for authorization is asking for sponsorship.
  assert.equal(pick("Do you require work authorization to work in the U.S.?"), "No");
  // "Without sponsorship" asks the opposite question.
  assert.equal(pick("Are you legally able to work in the US without sponsorship?"), "Yes");
  assert.equal(pick("Are you legally able to work in the US without sponsorship?", yesNo, "radio", us(applicant, "Yes", "Yes")), "No");
  // A citizenship answer in the profile still reads as authorized.
  assert.equal(pick("Are you authorized to work in the United States?", yesNo, "radio", us(applicant, "U.S. citizen", "No")), "Yes");
  // Left to the applicant: another country, two questions in one, free text,
  // an empty profile field, and options that aren't a yes/no.
  assert.equal(pick("Are you legally entitled to work in Canada?"), undefined);
  assert.equal(pick("Are you legally authorized to work in Canada (e.g., citizen or permanent resident)?"), undefined);
  assert.equal(pick("Are you authorized to work in the US, and will you require sponsorship?"), undefined);
  assert.equal(pick("If you require sponsorship, please explain", [], "textarea"), undefined);
  assert.equal(pick("Are you authorized to work in the United States?", yesNo, "radio", us(applicant, "", "No")), undefined);
  assert.equal(pick("Are you authorized to work in the United States?", ["US Citizen", "Green Card", "H-1B"]), undefined);
});

test("unloaded remote screening menus receive confirmed binary answers without guessing status or jurisdiction", () => {
  const applicant = profileSchema.parse({ ...profile, workAuthorization: "Yes", sponsorship: "No" });
  const ask = (label: string, who = applicant, kind = "combobox") => proposals([field(label, { kind })], who)[0]?.value;
  assert.equal(ask("Will you require sponsorship for employment visa status in the United States?"), "No");
  assert.equal(ask("Are you authorized to work in the United States?"), "Yes");
  assert.equal(ask("Are you able to work in the US without sponsorship?"), "Yes");
  assert.equal(ask("Are you authorized to work in Canada?"), undefined);
  assert.equal(ask("Are you authorized to work in the country where this role is based?"), undefined);
  assert.equal(ask("Do you have temporary work authorization in the United States?"), undefined);
  assert.equal(ask("Can you provide proof that you are authorized to work in the United States?"), undefined);
  assert.equal(ask("Are you authorized to work in the US, and will you require sponsorship?"), undefined);
  assert.equal(ask("If you require sponsorship, please explain", applicant, "textarea"), undefined);
  assert.equal(ask("Are you authorized to work in the United States?", us(applicant, "", "No")), undefined);
});

test("demographic choices come from the profile, matched to each portal's option wording", () => {
  const applicant = profileSchema.parse({
    ...profile,
    gender: "Female",
    hispanic: "No",
    ethnicity: "White",
    veteranStatus: "I am not a protected veteran",
    disabilityStatus: "No",
  });
  const pick = (label: string, options: string[], who = applicant) =>
    proposals([field(label, { kind: "radio", options })], who)[0]?.value;
  // Ashby's EEO options, as captured.
  const race = [
    "Hispanic or Latino",
    "White (Not Hispanic or Latino)",
    "Black or African American (Not Hispanic or Latino)",
    "Asian (Not Hispanic or Latino)",
    "Two or More Races (Not Hispanic or Latino)",
    "Decline to self-identify",
  ];
  assert.equal(pick("Gender", ["Male", "Female", "Decline to self-identify"]), "Female");
  assert.equal(pick("Race", race), "White (Not Hispanic or Latino)");
  assert.equal(pick("Are you Hispanic/Latino?", ["Yes", "No", "Decline to self-identify"]), "No");
  const veteran = [
    "I identify as one or more of the classifications of protected veteran listed above",
    "I am not a protected veteran",
    "I decline to self-identify for protected veteran status",
  ];
  assert.equal(pick("Veteran Status", veteran), "I am not a protected veteran");
  assert.equal(pick("Veteran Status", veteran, { ...applicant, veteranStatus: "Yes" }), veteran[0]);
  // PageUp's VEVRAA question (issue report 2026-10-03) says only "veterans",
  // and its decline is spelled with a Unicode hyphen.
  const vevraa =
    "If you believe you belong to any of the categories of protected veterans listed above, please indicate by checking the appropriate box below. As a Government contractor subject to VEVRAA, we request this information.";
  const vevraaOptions = [veteran[0] + ".", veteran[1] + ".", "I choose not to self‐identify."];
  for (const [veteranStatus, index] of [["Yes", 0], ["No", 1], ["Decline", 2]] as const)
    assert.equal(pick(vevraa, vevraaOptions, { ...applicant, veteranStatus }), vevraaOptions[index], veteranStatus);
  // The OFCCP disability form; its decline option must not read as "No".
  const disability = [
    "Yes, I have a disability (or previously had a disability)",
    "No, I do not have a disability and have not had one in the past",
    "I do not want to answer",
  ];
  assert.equal(pick("Disability Status", disability), disability[1]);
  assert.equal(pick("Disability Status", disability, { ...applicant, disabilityStatus: "Decline" }), "I do not want to answer");
  // PageUp's copy of the form (issue report 2026-10-03) asks only "Please
  // check one of the boxes below:"; its options say what is being asked.
  const boxes = "Please check one of the boxes below:";
  const pageUp = [disability[0], "No, I don't have a disability", "I don't wish to answer"];
  for (const [disabilityStatus, index] of [["Yes", 0], ["No", 1], ["Decline", 2]] as const)
    assert.equal(pick(boxes, pageUp, { ...applicant, disabilityStatus }), pageUp[index], disabilityStatus);
  // One option mentioning a disability does not make the question about it.
  assert.equal(pick(boxes, ["I have a disability", "I am a veteran", "None of these"]), undefined);
  // Declines find each portal's own decline wording.
  const decliner =profileSchema.parse({ ...applicant, gender: "I do not wish to answer", ethnicity: "Decline" });
  assert.equal(pick("Gender", ["Male", "Female", "Decline to self-identify"], decliner), "Decline to self-identify");
  assert.equal(pick("Race", race, decliner), "Decline to self-identify");
  // A "decline" that also states a group is not a decline (UK-style lists).
  const ukEthnicity = [
    "White",
    "Mixed or multiple ethnic groups",
    "Other ethnic group (Arab; Any other ethnic group; Prefer not to say)",
  ];
  assert.equal(pick("Ethnicity", ukEthnicity, decliner), undefined);
  assert.equal(pick("Ethnicity", ["Asian", "Other ethnic group (Prefer not to say or self-describe)"], decliner), undefined);
  // A decline that only repeats the question's words still counts.
  assert.equal(pick("Veteran Status", veteran, { ...applicant, veteranStatus: "Decline" }), veteran[2]);
  // Groups listed with their definitions (PageUp, issue report 2026-10-03):
  // a definition names other groups' places, and is not what the option says.
  const defined = [
    "Hispanic or Latino A person of Cuban, Mexican, Puerto Rican, South or Central American, or other Spanish culture or origin, regardless of race.",
    "White (Not Hispanic or Latino) A person having origins in any of the original peoples of Europe, the Middle East, or North Africa.",
    "American Indian or Alaska Native (Not Hispanic or Latino) A person having origins in any of the original peoples of North and South America (including Central America), and who maintains tribal affiliation or community attachment.",
    "Black or African American (Not Hispanic or Latino) A person having origins in any of the black racial groups of Africa.",
    "Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino) A person having origins in any of the peoples of Hawaii, Guam, Samoa, or other Pacific Islands.",
    "Asian (Not Hispanic or Latino) A person having origins in any of the original peoples of the Far East, Southeast Asia, or the Indian Subcontinent, including, for example, Cambodia, China, India, Japan, Korea, Malaysia, Pakistan, the Philippine Islands, Thailand, and Vietnam.",
    "Two or More Races (Not Hispanic or Latino) All persons who identify with more than one of the above races, excluding those who identify themselves as Hispanic or Latino.",
    "Not Disclosed",
  ];
  const question = "Race/Ethnicity Category* Please select the option that describes the race/ethnicity category with which you primarily identify.";
  for (const [ethnicity, index] of [
    ["Hispanic/Latinx", 0],
    ["White", 1],
    ["Native American", 2],
    ["African American", 3],
    ["Pacific Islander", 4],
    ["East Asian", 5],
    ["South Asian", 5],
    ["Southeast Asian", 5],
    ["Two or More", 6],
    ["Decline", 7],
  ] as const)
    assert.equal(pick(question, defined, profileSchema.parse({ ...applicant, ethnicity })), defined[index], ethnicity);
  // A plain "Asian" answers for any Asian group, unless the list names them.
  assert.equal(pick("Race", ["South Asian", "East Asian", "Asian"], profileSchema.parse({ ...applicant, ethnicity: "South Asian" })), "South Asian");
  assert.equal(pick("Race", ["East Asian", "White"], profileSchema.parse({ ...applicant, ethnicity: "South Asian" })), undefined);
  // No guessing: an answer the options don't state, or no answer at all.
  assert.equal(pick("Race", ["Asian", "Black", "Other"]), undefined);
  assert.equal(pick("Gender", ["Male", "Female"], profileSchema.parse({ ...applicant, gender: "" })), undefined);
});

// Bank of America / TalNet, report 6527a0ce: a previous degree must not be
// denied when both current and previous education are in the profile.
test("previous university education is confirmed by multiple education entries", () => {
  const question = field("Do you have any previous university education?", {
    kind: "select", options: ["Yes", "No"], value: "no", siteValue: true,
  });
  const graduate = profileSchema.parse({ ...profile, education: [
    { organization: "Example Graduate University", title: "Master of Science", startDate: "2025-08", endDate: "2099-05" },
    { organization: "Example Undergraduate College", title: "Bachelor of Science", startDate: "2020-09", endDate: "2024-06" },
  ] });
  assert.equal(proposals([question], graduate)[0]?.value, "Yes");
  assert.equal(deterministicAnswer({ ...question, section: "Current University Education" }, graduate), "Yes");
  // A single saved row does not establish that there was no earlier study.
  assert.equal(deterministicAnswer(question, profile), undefined);
  assert.deepEqual(proposals([{ ...question, protected: true }], graduate), []);
  assert.deepEqual(proposals([{ ...question, siteValue: false }], graduate), []);
  assert.equal(deterministicAnswer(question, profileSchema.parse({ ...graduate,
    answers: [{ question: question.label, answer: "No" }],
  })), "No");
});

// Greenhouse (Anduril, task e90ed1a9, 2026-10-17): the export-control
// question lists the kinds of U.S. person instead of Yes and No. The
// applicant's citizenship is in the profile's export-control statement, not
// in a saved answer, and the question was left empty.
test("a citizen's export-control statement picks the citizen from a list of U.S. person statuses", () => {
  const statuses = [
    "A United States citizen or national",
    "A person lawfully admitted for permanent residence of the United States (i.e., “Green Card” holder)",
    "A person admitted as a refugee to the United States under 8 U.S.C. 1157",
    "A person admitted as an asylee to the United States under 8 U.S.C. 1158",
    "None of the above",
  ];
  const label = "EXPORT CONTROLS - This position requires access to information and technology that is subject to U.S. export controls. Your responses to the questions below will be used solely to determine your eligibility under U.S. law to receive information and materials subject to U.S. export controls.";
  const legal = (exportControl: string) => profileSchema.parse({ ...profile, answers: [], legal: { ...profile.legal, exportControl } });
  const pick = (who: ReturnType<typeof legal>, options = statuses) => {
    const answer = proposals([field(label, { kind: "select", options })], who)[0];
    return answer && pickListOption(answer, options, (option) => option);
  };
  assert.equal(pick(legal("U.S. citizen (a U.S. person under ITAR and EAR)")), "A United States citizen or national");
  // A U.S. person who is not a citizen could be any of the others.
  assert.equal(pick(legal("U.S. person (permanent resident)")), undefined);
  assert.equal(pick(legal("Not a U.S. person")), undefined);
  assert.equal(pick(legal("")), undefined);
  // A Yes/No version takes Yes from the statement.
  assert.equal(pick(legal("U.S. person (permanent resident)"), ["Yes", "No"]), "Yes");
  // NGC's words a citizen "A citizen of the U.S." (report b80c92a2).
  assert.equal(pick(legal("U.S. citizen (a U.S. person under ITAR and EAR)"), ["A citizen of the U.S.", "A lawful permanent resident of the U.S.", "None of the above"]), "A citizen of the U.S.");
  // Citizenship of an embargoed country is another question, the applicant's
  // to answer (Micron, report 224a1d60): it got "Yes".
  const embargo = "All Micron sites must observe U.S. export control rules that control information that may be provided to persons from Cuba, Iran, North Korea, and Syria. Are you a citizen of, or do you hold dual citizenship with any of these countries?";
  assert.deepEqual(proposals([field(embargo, { kind: "combobox", options: [] })], legal("U.S. citizen (a U.S. person under ITAR and EAR)")), []);
});

// Amazon.jobs (report 5ab89018, 2026-10-25) opens several export-control
// questions with the same notice. The applicant's full legal name, the
// denied-persons question (its "Arms Export Control Act" list) and the dual
// citizenship box were each answered Yes as if they asked about U.S. person
// status.
test("an export-control notice before another question does not make it the U.S. person question", () => {
  const notice = "Amazon collects this information solely for the purpose of complying with United States export control laws and regulations.";
  const citizen = profileSchema.parse({
    ...profile,
    answers: [{ question: "Are you a U.S. person under export control regulations?", answer: "Yes" }],
    legal: { ...profile.legal, exportControl: "U.S. citizen (a U.S. person under ITAR and EAR)" },
  });
  const answer = (label: string, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], citizen)[0]?.value;
  assert.notEqual(answer(`${notice} What is your full legal name:`), "Yes");
  assert.notEqual(answer(`${notice} If you have dual citizenship, please identify the last country in which you obtained citizenship, or type, I do not have dual citizenship.`), "Yes");
  assert.notEqual(
    answer(
      `${notice} Are you currently, or have you ever been at any time, any of the following: (1) a person designated on the Denied Persons List, which is enforced by the Department of Commerce’s Bureau of Industry and Security, (2) a person designated on the Arms Export Control Act Debarred List, which is enforced by the Department of State’s Directorate of Defense Trade Controls, or (3) debarred or prohibited from contracting with or engaging in any dealing with the U.S. government or any other governmental entity?`,
      { kind: "select", options: ["Yes", "No"] },
    ),
    "Yes",
  );
  // The status question itself, and a notice that is the whole label, still are.
  assert.equal(answer(`${notice} Are you a U.S. person under export control regulations?`, { kind: "select", options: ["Yes", "No"] }), "Yes");
  assert.equal(answer(notice, { kind: "select", options: ["Yes", "No"] }), "Yes");
});

test("a saved answer covers the same standing question in other words, and no other", () => {
  const saved = profileSchema.parse({
    ...profile,
    willingToRelocate: "Yes",
    work: [{ organization: "Example Labs", title: "Intern", startDate: "2024-06", endDate: "2024-08", details: "", location: "" }],
    priorEmployment: "No",
    answers: [
      { question: "What are your salary expectations?", answer: "$100,000/year" },
      { question: "Do you hold an active security clearance?", answer: "No" },
      { question: "Are you a U.S. citizen?", answer: "Yes" },
      { question: "When can you start?", answer: "Immediately" },
      { question: "Are you willing to work onsite?", answer: "Yes" },
    ],
  });
  const value = (label: string, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], saved)[0]?.value;
  // Other wordings of what was saved.
  assert.equal(value("Would you be open to relocation for this role?", { kind: "select", options: ["Yes", "No"] }), "Yes");
  assert.equal(value("Are you open to relocating?", { kind: "select", options: ["Yes, I am willing to relocate", "No, I am not"] }), "Yes, I am willing to relocate");
  assert.equal(value("Desired salary", { kind: "number" }), "100000");
  assert.equal(value("What is your expected compensation?"), "$100,000/year");
  assert.equal(value("Active Security Clearance(s)", { kind: "select", options: ["Secret", "Top Secret", "None"] }), "None");
  assert.equal(value("Citizenship Status", { kind: "select", options: ["U.S. Citizen", "Permanent Resident", "Other"] }), "U.S. Citizen");
  assert.equal(value("This position is subject to export control laws. Are you a U.S. person?", { kind: "select", options: ["Yes", "No"] }), undefined);
  assert.equal(value("This role requires being in the office 5 days a week. Are you able to meet this requirement?", { kind: "select", options: ["Yes", "No"] }), "Yes");
  // Notion (2026-10-30): working from one of its offices on set days.
  assert.equal(value("We work from our offices on Mondays, Tuesdays, and Thursdays (Anchor Days). If you need an accommodation, we’ll partner with you and explore reasonable options consistent with applicable law. Are you able to commit to working from one of our offices on Anchor Days each week?", { kind: "radio", options: ["Yes", "No"] }), "Yes");
  assert.equal(value("What is your earliest start date?"), "Immediately");
  assert.equal(value("Have you previously worked at Acme?", { kind: "select", options: ["Yes", "No"] }), "No");
  // A box that takes only a date gets today's for "Immediately" (a report,
  // 2026-10-13: Ashby's date picker dropped the word, and the applicant
  // entered the day themselves), in the box's own format.
  const today = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  assert.equal(value("Earliest start date", { kind: "date" }), `${today.getFullYear()}-${two(today.getMonth() + 1)}-${two(today.getDate())}`);
  assert.equal(value("When can you start a new role?", { kind: "datepicker" }), `${two(today.getMonth() + 1)}/${two(today.getDate())}/${today.getFullYear()}`);
  assert.equal(
    proposals([field("When can you start a new role?", { kind: "datepicker" })], { ...saved, answers: [{ question: "When can you start?", answer: "Two weeks after an offer" }] })[0]?.value,
    undefined,
  );
  // A question naming one of the applicant's own employers is answered
  // from their work history: they did work there.
  assert.equal(value("Have you previously worked at Example Labs?", { kind: "select", options: ["Yes", "No"] }), "Yes");
  // Not the same question: another country, an answer the list does not
  // offer, or no topic at all.
  assert.equal(value("Are you willing to relocate to Canada?", { kind: "select", options: ["Yes", "No"] }), undefined);
  assert.equal(value("Desired salary", { kind: "select", options: ["Under $50,000", "$50,000 - $75,000"] }), undefined);
  assert.equal(value("Do you have a family member employed here?", { kind: "select", options: ["Yes", "No"] }), undefined);
  // An hourly rate is not the saved yearly figure, and a long preamble that
  // merely mentions a topic does not make the question about it.
  assert.equal(value("What are your hourly pay requirements", { kind: "number" }), undefined);
  assert.equal(value("Interns attend an on-site summit in Arlington and are able to join weekly sessions online. Which cohort are you applying to?", { kind: "select", options: ["Yes", "No"] }), undefined);
  assert.equal(value("This is an in-person role at our Lehi HQ. Are you able and willing to commute and/or relocate to Utah?", { kind: "select", options: ["Yes", "No"] }), "Yes");
  // "Either of these" is answered by a citizen, and weekday hours by
  // full-time availability.
  const more = profileSchema.parse({ ...saved, answers: [...saved.answers, { question: "Are you available to work full-time?", answer: "Yes" }] });
  const also = (label: string, who = more) => proposals([field(label, { kind: "radio", options: ["Yes", "No"] })], who)[0]?.value;
  assert.equal(also("Due to the regulatory environment of our industry, this role requires US Citizenship or Permanent Residence. Do you meet either of these criteria?"), "Yes");
  assert.equal(also("Summer internships are full-time. Are you available Monday–Friday, 8:00 AM–4:30 PM during the internship period?"), "Yes");
  const notCitizen = profileSchema.parse({ ...saved, answers: [{ question: "Are you a U.S. citizen?", answer: "No" }] });
  assert.equal(also("This role requires US Citizenship or Permanent Residence. Do you meet either of these criteria?", notCitizen), undefined);
  // Without a saved answer nothing is assumed.
  assert.equal(proposals([field("Desired salary", { kind: "number" })], profile).length, 0);
});

test("acknowledgement boxes are ticked only with the profile's permission, and never a signature or an opt-in", () => {
  const allowed = profileSchema.parse({ ...profile, acknowledgeTerms: true });
  const ticked = (label: string, who = allowed) => proposals([field(label, { kind: "checkbox" })], who)[0]?.value;
  assert.equal(ticked("I agree to the Privacy Policy"), "Yes");
  assert.equal(ticked("I certify that the information above is true and complete"), "Yes");
  assert.equal(ticked("I acknowledge that I have read the applicant privacy notice"), "Yes");
  assert.equal(ticked("By checking this box I consent to the processing of my data"), "Yes");
  // Not without permission.
  assert.equal(ticked("I agree to the Privacy Policy", profile), undefined);
  // Never these, permission or not.
  assert.equal(ticked("Signature: I agree and sign electronically"), undefined);
  assert.equal(ticked("I do not agree"), undefined);
  assert.equal(ticked("I agree to receive SMS text messages about my application"), undefined);
  assert.equal(ticked("I consent to join the talent community for future opportunities"), undefined);
  assert.equal(ticked("Immuta has my consent to contact me about future job opportunities."), undefined);
  // And only boxes: a consent question with options is the applicant's.
  assert.equal(proposals([field("Do you consent to a background check?", { kind: "select", options: ["Yes", "No"] })], allowed).length, 0);
});

test("a screening question is read from what it asks, not from the instructions after it", () => {
  const applicant = profileSchema.parse({ ...profile, workAuthorization: "Yes", sponsorship: "No" });
  const label =
    'Do you now or will you in the future require sponsorship for employment visa status? Please select "Yes" if you will require the Company to commence ("sponsor") an immigration case in order to be authorized to work, or to continue to be authorized to work, in the United States.';
  assert.equal(proposals([field(label, { kind: "radio", options: ["Yes", "No"] })], applicant)[0]?.value, "No");
  // Two questions in one are still left to the applicant.
  assert.equal(proposals([field("Are you authorized to work in the U.S., and will you require sponsorship?", { kind: "radio", options: ["Yes", "No"] })], applicant).length, 0);
});

test("a school asked as a question picks the listed school, never Other", () => {
  const label = 'Which university are you currently attending or did you last attend? Please select "Other (School Not Listed)" if your school is not listed.';
  const pick = (options: string[]) => proposals([field(label, { kind: "select", options })], profile)[0]?.value;
  assert.equal(pick(["Aalborg University", "Test University", "Other (School Not Listed)"]), "Test University");
  assert.equal(pick(["Aalborg University", "Other (School Not Listed)"]), undefined);
  assert.equal(proposals([field("Which high school did you attend?", { kind: "select", options: ["Test University"] })], profile).length, 0);
});

test("a work-history row's address and reason for leaving come from that row only", () => {
  const worked = profileSchema.parse({
    ...profile,
    work: [{ organization: "Example Labs", title: "Intern", startDate: "2024-06", endDate: "2024-08", location: "Tucson, AZ", details: "", address: "1 Lab Way", postalCode: "48910", reasonForLeaving: "Internship ended" }],
  });
  const inWork = (label: string, who = worked) => deterministicAnswer(field(label, { section: "Work Experience 1", index: 0 }), who);
  assert.equal(inWork("Address Line 1"), "1 Lab Way");
  assert.equal(inWork("City"), "Tucson");
  assert.equal(inWork("State"), "AZ");
  assert.equal(inWork("Zip Code"), "48910");
  assert.equal(inWork("Reason for Leaving"), "Internship ended");
  // A row without them is not given the applicant's home address.
  const bare = profileSchema.parse({ ...profile, work: [{ organization: "Example Labs", title: "Intern", startDate: "2024-06", endDate: "2024-08", location: "", details: "" }] });
  for (const label of ["Address Line 1", "City", "State", "Zip Code", "Country", "Reason for Leaving"]) assert.equal(inWork(label, bare), undefined, label);
});

test("a school list by campus picks the campus in the profile's city, and a long list is matched on the page", () => {
  const student = profileSchema.parse({ ...profile, education: [{ ...profile.education[0], organization: "University of Michigan", location: "Dearborn, MI" }] });
  const label = "Which university are you currently attending or did you last attend?";
  const campuses = ["Michigan State University", "University of Michigan - Ann Arbor", "University of Michigan - Dearborn", "University of Michigan - Flint"];
  assert.equal(proposals([field(label, { kind: "select", options: campuses })], student)[0]?.value, "University of Michigan - Dearborn");
  // No campus in the profile's city: none is guessed.
  const elsewhere = profileSchema.parse({ ...student, education: [{ ...student.education[0], location: "Detroit, MI" }] });
  assert.equal(proposals([field(label, { kind: "select", options: campuses })], elsewhere).length, 0);
  // Only the first 300 of 3,302 options were sent: the answer and its
  // alternatives go to the page, which holds the rest.
  const cut = proposals([field(label, { kind: "select", options: ["Aalborg University", "Aalto University"], optionCount: 3302 })], student)[0];
  assert.equal(cut?.value, "University of Michigan");
  assert.ok(cut?.choices?.includes("University of Michigan Dearborn"));
});

test("a school list names the profile's school by its official or common name, \"The\" or Main Campus, but never a sibling", () => {
  const label = "School";
  const list = [
    "Central Michigan University", "Georgia Institute of Technology-Main Campus", "Michigan State University", "Michigan State University College of Law",
    "Michigan Technological University", "The Ohio State University", "Ohio University", "Pennsylvania State University-Main Campus",
    "Pennsylvania State University-Penn State Harrisburg", "University of California-Berkeley", "University of California-Davis", "University of Michigan",
    "University of Virginia", "Virginia Polytechnic Institute and State University", "Virginia State University", "Virginia Tech Carilion School of Medicine",
  ];
  const pick = (organization: string, options = list) =>
    proposals([field(label, { kind: "select", options, section: "Education", index: 0 })], profileSchema.parse({ ...profile, education: [{ ...profile.education[0], organization, location: "" }] }))[0]?.value;
  assert.equal(pick("Virginia Tech"), "Virginia Polytechnic Institute and State University");
  assert.equal(pick("Virginia Polytechnic Institute and State University", list.map((option) => option.replace(/^Virginia Polytechnic.*/, "Virginia Tech"))), "Virginia Tech");
  assert.equal(pick("Ohio State University"), "The Ohio State University");
  assert.equal(pick("The Pennsylvania State University"), "Pennsylvania State University-Main Campus");
  assert.equal(pick("Georgia Tech"), "Georgia Institute of Technology-Main Campus");
  assert.equal(pick("UC Berkeley"), "University of California-Berkeley");
  assert.equal(pick("Michigan State University"), "Michigan State University");
  // Its siblings are not it: the medical school, another Virginia school,
  // the law college, or an initialism several schools share.
  const without = list.filter((option) => !/^(Virginia Polytechnic|Michigan State University$)/.test(option));
  assert.equal(pick("Virginia Tech", without), undefined);
  assert.equal(pick("Michigan State University", without), undefined);
  assert.equal(pick("MSU", [...list, "Mississippi State University"]), undefined);
});

test("a plain Location text box gets the applicant's city and state, but not inside a job row", () => {
  assert.equal(proposals([field("Location")], profile)[0]?.value, "Phoenix, Arizona");
  assert.equal(proposals([field("Location", { section: "Work Experience 1", index: 0 })], profile).length, 0);
  const picker = proposals([field("Location", { kind: "combobox" })], profile)[0];
  assert.equal(picker?.value, "Phoenix");
  assert.ok(picker?.choices?.includes("Phoenix, Arizona, United States"));
  assert.equal(proposals([field("Location", { kind: "combobox", section: "Work Experience 1", index: 0 })], profile).length, 0);
  assert.equal(proposals([field("Desired location")], profile).length, 0);
});

test("an abbreviation inside a question does not cut it, and Yes or No reach a sentence-worded option", async () => {
  const { pickOption } = await import("../src/shared/answers");
  const applicant = profileSchema.parse({ ...profile, workAuthorization: "Yes", sponsorship: "No" });
  const ask = (label: string) => proposals([field(label, { kind: "radio", options: ["Yes", "No"] })], applicant)[0]?.value;
  assert.equal(ask("Will you now, or in the future, require sponsorship for employment visa status (e.g. H-1B visa status)?"), "No");
  assert.equal(ask("Will you now, or in the future, require sponsorship (i.e. H-1B visa, etc.) to legally work in the US?"), "No");
  const pick = (value: string, options: string[]) => pickOption({ value }, options, (o) => o);
  assert.equal(pick("Yes", ["Yes, I am authorized to work in the United States", "No, I am not"]), "Yes, I am authorized to work in the United States");
  assert.equal(pick("No", ["Yes", "No - I do not require sponsorship"]), "No - I do not require sponsorship");
  // Two "Yes…" options are two answers: neither is chosen.
  assert.throws(() => pick("Yes", ["Yes, as a citizen", "Yes, on a visa", "No"]));
  assert.equal(pick("Yes", ["Yesterday", "Never"]), undefined);
  // A report, 2026-10-13 (Greenhouse): one school listed twice, with a hyphen
  // and with a long dash. That is one answer; the same text twice is not.
  const school = "Pennsylvania State University - University Park";
  const dashed = "Pennsylvania State University — University Park";
  assert.equal(pick(school, [dashed, school, "Michigan State University"]), school);
  assert.equal(pick("Pennsylvania State University University Park", [dashed, school]), dashed);
  assert.throws(() => pick(school, [school, school]));
});


test("confirmed authorization answers an explicit OR with proof without claiming proof", () => {
  const label = "Are you lawfully authorized to work in the US or can you provide proof of employment eligibility upon hire?";
  for (const options of [[], ["Yes", "No"]]) {
    const question = field(label, { kind: "combobox", options });
    assert.equal(proposals([question], us(profile, "Yes"))[0]?.value, "Yes");
    assert.deepEqual(proposals([question], us(profile, "No")), []);
    assert.deepEqual(proposals([question], us(profile, "")), []);
  }
  assert.deepEqual(proposals([field("Can you provide proof that you are authorized to work in the United States?", { kind: "combobox", options: ["Yes", "No"] })], us(profile, "Yes")), []);
});


test("relocation assistance in a permanent-address request does not infer an address", () => {
  const label = "Please provide your permanent address (city, state, zip code). We use this information to determine eligibility for relocation assistance for the internship. A permanent address is your long-term, stable address.";
  const p = { ...profile, willingToRelocate: "Yes", answers: [{ question: "Are you willing to relocate?", answer: "Yes" }] };
  assert.deepEqual(proposals([field(label)], p), []);
  assert.equal(proposals([field(label)], { ...p, answers: [{ question: label, answer: "100 Confirmed Permanent Ave, Phoenix, AZ 85001" }] })[0]?.value, "100 Confirmed Permanent Ave, Phoenix, AZ 85001");
  assert.equal(proposals([field("Are you willing to relocate?")], p)[0]?.value, "Yes");
});


test("CPT and OPT status stays manual while the exact no-sponsorship sentence expresses the confirmed answer", () => {
  const p = { ...us(profile, "Yes", "No"), answers: [] };
  const status = "Does your work authorization now, or will it in the future, involve CPT (Curricular Practical Training) or OPT (Optional Practical Training)?";
  for (const kind of ["select", "combobox", "radio", "text"] as const)
    assert.deepEqual(proposals([field(status, { kind, options: kind === "text" ? [] : ["Yes", "No"] })], p), []);
  assert.equal(proposals([field(status, { kind: "select", options: ["Yes", "No"] })], { ...p, answers: [{ question: status, answer: "No" }] })[0]?.value, "No");
  const label = "Do you now or will you ever require sponsorship for a work visa?";
  const exact = "I do not and will not require sponsorship at any point in the future in order to work in the US";
  const options = ["I require sponsorship to work in the US at this time", exact, "I am in the process of obtaining permanent work authorization but the process is not complete", "I do not require sponsorship right now, but will at some point in the future"];
  assert.equal(proposals([field(label, { kind: "select", options })], p)[0]?.value, exact);
  assert.deepEqual(proposals([field(label, { kind: "select", options: options.filter(x => x !== exact) })], p), []);
  assert.deepEqual(proposals([field(label, { kind: "select", options })], us(p, "Yes", "")), []);
});

test("an explicitly saved now-or-future No distinguishes the two No sponsorship sentences", () => {
  const label = "Do you now or in the future require sponsorship for employment visa status to work in the United States?";
  const complete = "No, I do not require sponsorship now or in the future";
  const partial = "No, I do not require sponsorship now, but may require it in the future";
  const options = [complete, partial, "Yes, I currently hold a visa status that would require a transfer to a new employer", "Yes, I would require new sponsorship"];
  const p = { ...us(profile, "", "No"), answers: [{ question: "Will you now or in the future require sponsorship?", answer: "No" }] };
  const pick = (choices = options, applicant = p) => proposals([field(label, { kind: "radio", options: choices })], applicant);
  assert.equal(pick()[0]?.value, complete);
  assert.deepEqual(pick(options, { ...p, answers: [] }), []);
  assert.deepEqual(pick([complete, options[2]], { ...p, answers: [] }), []);
  assert.deepEqual(pick(options, { ...p, answers: [...p.answers, { question: p.answers[0].question, answer: "Yes" }] }), []);
  assert.deepEqual(pick(options, { ...p, answers: [...p.answers, { question: label, answer: "Yes" }] }), []);
  assert.deepEqual(pick(options, { ...p, answers: [...p.answers, { question: p.answers[0].question, answer: "" }] }), []);
  assert.equal(pick(options, { ...p, answers: [...p.answers, ...p.answers] })[0]?.value, complete);
  assert.deepEqual(proposals([field(label, { kind: "radio", options: ["Yes", "No"] })], {
    ...p, answers: [{ question: label, answer: "No" }, { question: label, answer: "Yes" }],
  }), []);
  assert.deepEqual(pick(options, us(p, "", "")), []);
  assert.deepEqual(pick([partial, options[2], options[3]]), []);
  const exactBinary = { ...p, answers: [{ question: label, answer: "No" }] };
  assert.equal(pick(options, exactBinary)[0]?.value, complete);
  assert.deepEqual(pick([partial, options[2]], exactBinary), []);
  assert.deepEqual(pick(options, { ...exactBinary, answers: [...exactBinary.answers, { question: label, answer: "Yes" }] }), []);
  const requiresSponsorship = { ...us(p, "", "Yes"), answers: [{ question: label, answer: "Yes" }] };
  assert.deepEqual(pick([complete, options[2]], requiresSponsorship), []);
  assert.deepEqual(pick([complete, options[3]], requiresSponsorship), []);
  assert.equal(pick([complete, "Yes"], requiresSponsorship)[0]?.value, "Yes");
  assert.equal(pick(options, { ...p, answers: [{ question: label, answer: options[2] }] })[0]?.value, options[2]);
  assert.deepEqual(pick([complete, complete, partial]), []);
  const foreignLabel = label.replace("United States", "Canada");
  const foreignField = field(foreignLabel, { kind: "radio", options: [partial, options[2]] });
  assert.deepEqual(proposals([foreignField], p), []);
  assert.deepEqual(proposals([foreignField], { ...p, answers: [{ question: foreignLabel, answer: "No" }] }), []);
  assert.deepEqual(proposals([field(label.replace("United States", "Canada"), { kind: "radio", options })], p), []);
});

test("confirmed citizenship and authorization select only the exact citizen-or-resident statement", () => {
  const label = "Are you currently authorized to work for any employer in the United States?";
  const citizen = "Yes - I have US work authorization as a Citizen or US Permanent Resident / Green Card Holder";
  const visa = "Yes - I have US work authorization via a non-immigrant visa (e.g. F-1, H-1B, L-1, TN)";
  const options = [citizen, visa, "No - I am not currently authorized to work in the US"];
  const p = { ...us(profile, "Yes"), answers: [{ question: "Are you a U.S. citizen?", answer: "Yes" }] };
  const pick = (applicant = p, choices = options) => proposals([field(label, { kind: "radio", options: choices })], applicant);
  assert.equal(pick()[0]?.value, citizen);
  assert.deepEqual(pick({ ...p, answers: [] }), []);
  assert.deepEqual(pick({ ...p, answers: [...p.answers, { question: p.answers[0].question, answer: "No" }] }), []);
  assert.deepEqual(pick({ ...p, answers: [...p.answers, { question: p.answers[0].question, answer: "" }] }), []);
  assert.equal(pick({ ...p, answers: [...p.answers, ...p.answers] })[0]?.value, citizen);
  assert.deepEqual(pick({ ...p, answers: [{ question: "Are you a U.S. citizen?", answer: "No" }] }), []);
  assert.deepEqual(pick(us(p, "")), []);
  assert.deepEqual(pick(p, [citizen, citizen, visa]), []);
  const exactBinary = { ...p, answers: [...p.answers, { question: label, answer: "Yes" }] };
  assert.equal(pick(exactBinary)[0]?.value, citizen);
  assert.deepEqual(pick(exactBinary, [visa, options[2]]), []);
  assert.deepEqual(pick({ ...exactBinary, answers: [{ question: label, answer: "Yes" }] }), []);
  assert.deepEqual(pick({ ...exactBinary, answers: [...exactBinary.answers, { question: label, answer: "No" }] }), []);
  assert.deepEqual(pick(us(exactBinary, "No")), []);
  assert.equal(pick({ ...p, answers: [{ question: label, answer: citizen }] })[0]?.value, citizen);
  assert.deepEqual(pick(p, [visa, options[2]]), []);
  const foreignLabel = label.replace("United States", "Canada");
  assert.deepEqual(proposals([field(foreignLabel, { kind: "radio", options: [visa, options[2]] })], {
    ...p, answers: [{ question: foreignLabel, answer: "Yes" }],
  }), []);
  assert.deepEqual(proposals([field(label.replace("United States", "Canada"), { kind: "radio", options })], p), []);
});


test("late dropdown options cannot add visa or future facts to a bare saved binary answer", async () => {
  const { pickOption, qualifiedBinarySentences } = await import("../src/shared/answers");
  for (const sentence of Object.values(qualifiedBinarySentences).flat()) {
    const binary = sentence.startsWith("Yes") ? "Yes" : "No";
    assert.equal(pickOption({ value: binary }, [sentence], option => option), undefined, sentence);
    assert.equal(pickOption({ value: sentence }, [sentence], option => option), sentence);
    assert.equal(pickOption({ value: binary, choices: [sentence] }, [sentence], option => option), sentence);
  }
  assert.equal(pickOption({ value: "Yes" }, ["Yes, I am authorized to work in the United States"], option => option), "Yes, I am authorized to work in the United States");
  assert.equal(pickOption({ value: "No" }, ["No, I do not require sponsorship"], option => option), "No, I do not require sponsorship");
});

// Reports on two Ashby forms, 2026-10-13.
test("one box of a checkbox question is ticked only when it is the profile's answer to that question", () => {
  const applicant = profileSchema.parse({
    ...profile,
    sexualOrientation: "Straight",
    education: [
      { organization: "State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08-21", endDate: "2099-05-10" },
      { organization: "Virginia Tech", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15" },
    ],
  });
  const boxes = (question: string | undefined, labels: string[]) =>
    proposals(labels.map((label, index) => field(label, { id: `box-${index}`, kind: "checkbox", options: ["Yes", "No"], question })), applicant).map((proposal) => proposal.fieldId);
  // "Degree Type" beside the school being attended is the degree in
  // progress there: the bachelor's the applicant also holds was ticked too.
  assert.deepEqual(boxes("Degree Type", ["Undergraduate/Bachelors", "Master's", "PhD", "MBA"]), ["box-1"]);
  // The orientation the profile holds, in the form's wording, and nothing else.
  assert.deepEqual(boxes("What is your sexual orientation? Please select all that apply.", ["Bisexual", "Lesbian", "Gay", "Queer", "Heterosexual / straight", "Other", "I prefer not to answer"]), ["box-4"]);
  // Without their question the same boxes say nothing, and a question that
  // is not one of these is left alone.
  assert.deepEqual(boxes(undefined, ["Undergraduate/Bachelors", "Master's", "Heterosexual / straight"]), []);
  assert.deepEqual(boxes("Which of the following communities do you belong to?", ["Parent", "Neurodiverse", "None of the above"]), []);
});

test("a graduation date box gets the whole date, and a season its term", () => {
  const applicant = profileSchema.parse({ ...profile, education: [{ organization: "State University", title: "Masters of Science", startDate: "2025-08-21", endDate: "2099-05-10" }] });
  const pick = (label: string, overrides: Partial<Field> = {}, who = applicant) => proposals([field(label, overrides)], who)[0]?.value;
  // Typed "May 2099", a date picker made it the 1st.
  assert.equal(pick("Graduation Date"), "05/10/2099");
  assert.equal(pick("Graduation Date", { kind: "date" }), "2099-05-10");
  // A profile date without a day, and a question for the month or year, are as before.
  assert.equal(pick("Graduation Date", {}, profile), "May 2028");
  assert.equal(pick("Expected graduation month"), "May 2099");
  assert.equal(pick("Graduation year"), "2099");
  const seasons = { kind: "radio", options: ["Winter 2099", "Spring 2099", "Fall 2099"] };
  assert.equal(pick("What is your ancitipated graduation season?", seasons), "Spring 2099");
  assert.equal(pick("Anticipated graduation term", seasons), "Spring 2099");
  // December is the Fall term and winter by the calendar: only a list with one of them is answered.
  const december = profileSchema.parse({ ...profile, education: [{ organization: "State University", title: "Masters of Science", startDate: "2025-08-21", endDate: "2099-12-13" }] });
  assert.equal(pick("Anticipated graduation season", seasons, december), undefined);
  assert.equal(pick("Anticipated graduation season", { kind: "radio", options: ["Spring 2099", "Fall 2099"] }, december), "Fall 2099");
  // A season with no year the list offers is left alone.
  assert.equal(pick("Anticipated graduation season", { kind: "radio", options: ["Spring 2098", "Fall 2098"] }), undefined);
  // A list of spans takes the one holding the month (American Express's
  // Oracle form, 2026-10-25), and a list read only when opened can match it.
  const quarters = { kind: "select", options: ["January - March 2099", "April - June 2099", "July - September 2099", "October - December 2099", "January - March 2100"] };
  assert.equal(pick("What is your expected graduation date:", quarters, december), "October - December 2099");
  assert.equal(pick("What is your expected graduation date:", quarters), "April - June 2099");
  assert.equal(pick("What is your expected graduation date:", { kind: "select", options: ["January - March 2099", "April - June 2099"] }, december), undefined);
  const opened = proposals([field("What is your expected graduation date:", { kind: "combobox" })], december)[0]!;
  assert.equal(pickListOption(opened, quarters.options, (option) => option), "October - December 2099");
  // Amazon's names the format, and its question is asked another way.
  assert.equal(pick("In what month and year did you (or do you expect to) graduate from your highest degree? Date: Year-Month-Day", { kind: "datepicker" }, december), "2099-12-13");
});

test("name pronunciation, transgender and age come from the profile, and stay empty without it", () => {
  const born = new Date();
  born.setFullYear(born.getFullYear() - 27);
  born.setDate(born.getDate() - 1);
  const applicant = profileSchema.parse({ ...profile, namePronunciation: "AL-ex", transgender: "No", dateOfBirth: born.toISOString().slice(0, 10) });
  const pick = (label: string, overrides: Partial<Field> = {}, who = applicant) => proposals([field(label, overrides)], who)[0]?.value;
  assert.equal(pick("Name pronounciation"), "AL-ex");
  assert.equal(pick("Phonetic spelling of your name"), "AL-ex");
  assert.equal(pick("What pronouns do you use?"), undefined);
  assert.equal(pick("Do you identify as transgender?", { kind: "radio", options: ["Yes", "No", "I prefer not to answer"] }), "No");
  const ranges = { kind: "radio", options: ["Under 30", "30-39", "40-49", "50-59", "60 or older", "I prefer not to answer"] };
  assert.equal(pick("What is your current age?", ranges), "Under 30");
  assert.equal(pick("Age"), "27");
  const older = new Date();
  older.setFullYear(older.getFullYear() - 61);
  assert.equal(pick("What is your current age?", ranges, profileSchema.parse({ ...profile, dateOfBirth: older.toISOString().slice(0, 10) })), "60 or older");
  // "Are you 18 or older?" is another question, and none of these is guessed.
  assert.equal(pick("Are you at least 18 years of age?", { kind: "radio", options: ["Yes", "No"] }), undefined);
  for (const [label, overrides] of [["Name pronounciation", {}], ["Do you identify as transgender?", { kind: "radio", options: ["Yes", "No"] }], ["What is your current age?", ranges]] as [string, Partial<Field>][])
    assert.equal(pick(label, overrides, profile), undefined, label);
});

// JazzHR (Axtria, report 0c460367, 2026-10-14) asks for the school, major
// and degree of one level of study, and for the highest degree's date.
test("a question naming a level of study is answered from the education row at that level", () => {
  const applicant = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08-21", endDate: "2099-05-10" },
      { organization: "Virginia Polytechnic Institute and State University", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15" },
    ],
  });
  const schools = ["-- No answer --", "Virginia Polytechnic Institute and State University", "Michigan State University", "Other (US Based Schools)"];
  const ask = (label: string, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], applicant)[0];
  assert.equal(ask("Highest Degree Earned/Pursuing", { kind: "select", options: ["-- No answer --", "Bachelor", "Master", "PhD"] })?.value, "Master");
  assert.ok(ask("Highest Degree Earned/Pursuing")?.choices?.includes("Master"));
  // A degree still in progress is not one earned.
  assert.equal(ask("Highest degree earned")?.value, "Bachelors of Science");
  assert.equal(ask("Completion date of your highest degree (mm/yyyy)")?.value, "05/2099");
  assert.equal(ask("Name of the School: Undergraduate Degree", { kind: "select", options: schools })?.value, "Virginia Polytechnic Institute and State University");
  assert.equal(ask("Name of the School: Graduate/MBA/PhD Degree", { kind: "select", options: schools })?.value, "Michigan State University");
  assert.equal(ask("Field of Study / Major: Undergraduate Degree")?.value, "Computer Science");
  assert.equal(ask("Field of Study: Graduate/MBA/PhD Degree")?.value, "Data Science");
  // Two graduate programs: which one a graduate question means is unknown.
  const twice = profileSchema.parse({
    ...applicant,
    education: [...applicant.education, { organization: "Harbor Business School", title: "MBA", startDate: "2018-08", endDate: "2020-05" }],
  });
  assert.equal(proposals([field("Name of the School: Graduate/MBA/PhD Degree")], twice).length, 0);
});

// JazzHR (Axtria, report 0c460367, 2026-10-14) draws a yes/no question as
// one checkbox per answer, the question carried by each box.
test("Yes and No drawn as boxes of a sponsorship question tick the profile's answer", () => {
  const applicant = profileSchema.parse({ ...profile, workAuthorization: "Yes", sponsorship: "No" });
  const question =
    "Will you in the future (beyond the expiration of your current visa status, such as F-1 student status with OPT eligibility), require sponsorship for employment visa status (such as H-1B, TN, O1 visa statuses, etc.) to work legally for our Company in the United States?";
  const boxes = ["Yes", "No", "Other (please explain below)"].map((label, index) =>
    field(label, { id: `box${index}`, kind: "checkbox", options: ["Yes", "No"], required: false, question }),
  );
  const ticked = (applicantProfile: typeof applicant) =>
    Object.fromEntries(proposals(boxes, applicantProfile).map((proposal) => [proposal.fieldId, proposal.value]));
  assert.deepEqual(ticked(applicant), { box1: "Yes" });
  assert.deepEqual(ticked(profileSchema.parse(us(applicant, "Yes", "Yes"))), { box0: "Yes" });
  // Another country's sponsorship is not the profile's to answer.
  const abroad = boxes.map((box) => ({ ...box, question: "Will you require sponsorship to work in Canada?" }));
  assert.equal(proposals(abroad, applicant).length, 0);
});

// The applicant asked, 2026-10-14: forms that ask for a full legal name did
// not get the middle name. It is its own profile value now.
test("a legal name includes the middle name, an everyday full name does not", () => {
  const named = profileSchema.parse({ confirmed: true, firstName: "Alex", middleName: "Jordan", lastName: "Rivera", email: "alex@example.test", facts: [], work: [], education: [], skills: [], answers: [] });
  const value = (label: string) => proposals([field(label)], named)[0]?.value;
  assert.equal(value("Full legal name"), "Alex Jordan Rivera");
  assert.equal(value("Legal Name"), "Alex Jordan Rivera");
  assert.equal(value("Please state your full legal name:"), "Alex Jordan Rivera");
  assert.equal(value("Middle name"), "Jordan");
  assert.equal(value("Middle initial"), "J");
  assert.equal(value("Full name"), "Alex Rivera");
  assert.equal(value("First and last name"), "Alex Rivera");
  // Without a middle name saved, the legal name is the first and last name,
  // and a middle-name box is left as it is.
  const plain = { ...named, middleName: undefined };
  assert.equal(proposals([field("Full legal name")], plain)[0]?.value, "Alex Rivera");
  assert.equal(proposals([field("Middle name")], plain)[0], undefined);
});

// JazzHR (Axtria, report 14eb9da9, 2026-10-14): the school lists lacked the
// applicant's schools, and each was followed by a box for the name of one
// chosen as "Other"; the applicant asked for Other and the name.
test("a school list without the school picks its Other, and the box after it gets the name", () => {
  const applicant = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05", location: "East Lansing, MI" },
      { organization: "Virginia Polytechnic Institute and State University", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "Blacksburg, Virginia" },
    ],
  });
  const lists = (others: string[]) => [
    field("Name of the School: Undergraduate Degree", { id: "under", kind: "select", options: ["-- No answer --", "Bucknell University", ...others] }),
    field('If you selected "OTHER" , please enter the full name of the school where you are pursuing your Undergraduate degree', { id: "underName", required: false }),
    field("Field of Study / Major: Undergraduate Degree", { id: "major" }),
    field("Name of the School: Graduate/MBA/PhD Degree", { id: "grad", kind: "select", options: ["-- No answer --", "Bucknell University", ...others], required: false }),
    field('If you selected "OTHER" , please enter the full name of the school where you are pursuing your Graduate/MBA/PhD', { id: "gradName", required: false }),
  ];
  const answers = (fields: Field[], who = applicant) => Object.fromEntries(proposals(fields, who).map((proposal) => [proposal.fieldId, proposal.value]));
  assert.deepEqual(answers(lists(["Other (International Schools)", "Other (US Based Schools)"])), {
    under: "Other (US Based Schools)",
    underName: "Virginia Polytechnic Institute and State University",
    major: "Computer Science",
    grad: "Other (US Based Schools)",
    gradName: "Michigan State University",
  });
  // A listed school is chosen itself, and its box is left.
  const listed = lists(["Virginia Polytechnic Institute and State University", "Other (US Based Schools)"]);
  assert.equal(answers(listed).under, "Virginia Polytechnic Institute and State University");
  assert.equal(answers(listed).underName, undefined);
  // Without a place to tell US from international, neither Other is chosen.
  const placeless = profileSchema.parse({ ...applicant, education: applicant.education.map((row) => ({ ...row, location: "" })) });
  const unknown = answers(lists(["Other (International Schools)", "Other (US Based Schools)"]), placeless);
  assert.equal(unknown.under, undefined);
  assert.equal(unknown.underName, undefined);
  // No box for the name: the list is left, as before.
  assert.equal(answers(lists(["Other (US Based Schools)"]).filter((f) => !/Name$/.test(f.id))).under, undefined);
});

// SuccessFactors (WEC Energy Group, report 624039b6, 2026-10-14) asks about
// sponsorship without the word: "…commence an immigration case in order to
// employ you? (e.g. H-1B…)". Its list loads only when opened.
test("asking an employer to commence an immigration case is a sponsorship question", () => {
  const applicant = profileSchema.parse({ ...profile, workAuthorization: "Yes", sponsorship: "No" });
  const ask = (label: string) => proposals([field(label, { kind: "combobox" })], applicant)[0]?.value;
  assert.equal(ask("Will you now or in the future ask WEC Energy Group or any of our subsidiaries to commence an immigration case in order to employ you? (e.g. H-1B or other immigration cases)"), "No");
  assert.equal(ask("Will you now or in the future ask Acme to file an immigration petition on your behalf?"), "No");
  // Another country's case is not the profile's to answer.
  assert.equal(ask("Will you ask Acme to commence an immigration case to work in Canada?"), undefined);
});

// Ashby (Applied Intuition, 2026-10-28) asks "Do you currently have an
// active immigration case (ex H-1B extension, green card)?" and it was left
// to the applicant. A U.S. citizen has none; anyone else might.
test("a citizen has no active immigration case", () => {
  const ask = (workAuthorization: string, label = "Do you currently have an active immigration case (ex H-1B extension, green card)?") =>
    proposals([field(label, { kind: "radio" })], profileSchema.parse({ ...profile, workAuthorization, sponsorship: "No" }))[0]?.value;
  assert.equal(ask("US Citizen"), "No");
  assert.equal(ask("U.S. citizen", "Do you have a pending immigration petition?"), "No");
  assert.equal(ask("Green Card Holder"), undefined);
  assert.equal(ask("Yes"), undefined);
});

// L3Harris's SuccessFactors form (report 5beb4b34, 2026-10-15) asks these as
// sentences: the highest level completed is the finished degree; the major
// is the program studied now (the model gave the finished degree's); and
// "Date Available" is a date picker that reads as a text box.
test("SuccessFactors' education sentences and its availability date are answered from the profile", () => {
  const applicant = profileSchema.parse({
    ...profile,
    answers: [{ question: "When can you start?", answer: "Immediately" }],
    education: [
      { organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08-21", endDate: "2099-05-10" },
      { organization: "Virginia Polytechnic Institute and State University", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15" },
    ],
  });
  const ask = (label: string, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], applicant)[0]?.value;
  assert.equal(ask("What is the highest level of education you have completed?", { kind: "select", options: ["High School", "Bachelors Degree", "Masters Degree or Higher"] }), "Bachelors Degree");
  assert.equal(ask("What area was your major in?"), "Data Science");
  const today = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  assert.equal(ask("Date Available"), `${two(today.getMonth() + 1)}/${two(today.getDate())}/${today.getFullYear()}`);
});

// Amazon's internship form (report 4d8218b1, 2026-10-25) names its date
// format in the label, and "10/25/2026" was "not in the correct format".
test("a start-date picker whose label names Year-Month-Day gets today's date in that format", () => {
  const applicant = profileSchema.parse({ ...profile, answers: [{ question: "When can you start?", answer: "Immediately" }] });
  const today = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  const value = proposals([
    field("What is your earliest possible start date for this internship term? (required) Date: Year-Month-Day Please enter the date in the format YYYY dash MM dash DD", { kind: "datepicker" }),
  ], applicant)[0]?.value;
  assert.equal(value, `${today.getFullYear()}-${two(today.getMonth() + 1)}-${two(today.getDate())}`);
});

// L3Harris's SuccessFactors profile (2026-10-15): "Degree Conferred" is a
// date, and the model wrote "Bachelors of Science" into it. A finished
// degree gives its end date. One in progress is conferred on its expected
// date but not yet received.
test("a degree-conferred box gets the degree's date, expected for one in progress, and degree-received only a finished one's", () => {
  const applicant = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08-21", endDate: "2099-05-10" },
      { organization: "Virginia Polytechnic Institute and State University", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15" },
    ],
  });
  const ask = (index: number, label = "Degree Conferred") => proposals([field(label, { section: "Education", index })], applicant)[0]?.value;
  assert.equal(ask(1), "06/15/2024");
  assert.equal(ask(0), "05/10/2099");
  assert.equal(ask(1, "Degree Received"), "06/15/2024");
  assert.equal(ask(0, "Degree Received"), undefined);
});

// L3Harris (report 17ac6723, 2026-10-15) asks "What year did you or, if you
// have not graduated, will you receive your degree?" twice: once in a text
// box, which takes the year, and once in a date picker, where "2027" was
// invalid: it takes the whole expected date.
test("a will-you-receive-your-degree question gets the year in a text box and the date in a date picker", () => {
  const applicant = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08-21", endDate: "2099-05-10" },
      { organization: "Virginia Polytechnic Institute and State University", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15" },
    ],
  });
  const ask = (label: string, kind: string) => proposals([field(label, { kind, section: "Job-Specific Information" })], applicant)[0]?.value;
  assert.equal(ask("What year did you or, if you have not graduated, will you receive your degree?", "text"), "2099");
  assert.equal(ask("What year did you or if you have not graduated will you receive your degree?", "datepicker"), "05/10/2099");
});

// L3Harris (2026-10-16) asks "Please indicate your current year of study in
// college." as a list and as a text box. An M.S. begun more than a year ago
// is in its second year: a graduate student, never an undergraduate class.
test("the current year of study is counted from the program under way", () => {
  const started = (monthsAgo: number) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - monthsAgo);
    return date.toISOString().slice(0, 10);
  };
  const applicant = (title: string, startDate: string) =>
    profileSchema.parse({
      ...profile,
      education: [
        { organization: "Michigan State University", title, fieldOfStudy: "Data Science", startDate, endDate: "2099-05-10" },
        { organization: "Virginia Polytechnic Institute and State University", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15" },
      ],
    });
  const ask = (person: ReturnType<typeof applicant>, kind: string) =>
    proposals([field("Please indicate your current year of study in college.", { kind, section: "Job-Specific Information" })], person)[0];
  const master = applicant("Masters of Science", started(14));
  assert.equal(ask(master, "textarea")?.value, "Second year of graduate study");
  assert.equal(ask(master, "combobox")?.value, "Graduate Student");
  assert.ok(!ask(master, "combobox")?.choices?.includes("Sophomore"));
  const bachelor = applicant("Bachelor of Science", started(26));
  assert.equal(ask(bachelor, "combobox")?.value, "Junior");
  assert.equal(ask(bachelor, "text")?.value, "Third year (Junior)");
});

// Jabil's Workday form (2026-10-16): the site's "Masters" from the resume is
// the profile's "Masters of Science" in another wording, and was replaced
// anyway, opening the list again.
test("a value the site filled in one of the answer's wordings is left as it is", () => {
  const applicant = profileSchema.parse({
    ...profile,
    education: [{ organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05" }],
  });
  const degree = (value: string) => proposals([field("Degree", { kind: "combobox", section: "Education", value, siteValue: true })], applicant);
  assert.deepEqual(degree("Masters"), []);
  assert.equal(degree("Bachelors")[0]?.value, "Masters of Science");
});

// Westinghouse's SuccessFactors (report cc40f1fb): "Are you one of the
// following? U.S. Citizen or National, U.S. Lawful Permanent Resident…" and
// then the countries of citizenship, the latest first as "Country 1 Name".
test("a citizen answers which of the following they are, and names the United States first", () => {
  const citizen = profileSchema.parse({ ...profile, workAuthorization: "US Citizen" });
  const question = "Are you one of the following? U.S. Citizen or National U.S. Lawful Permanent Resident. Person granted Refugee status in the United States. Person granted Asylum in the United States.";
  const answered = proposals([
    field(question, { id: "status", kind: "combobox", options: ["No Selection", "No", "Yes"] }),
    field("Country 1 Name", { id: "first", kind: "combobox" }),
    field("Country 2 Name", { id: "second", kind: "combobox", required: false }),
  ], citizen);
  assert.deepEqual(answered.map((proposal) => [proposal.fieldId, proposal.value]), [["status", "Yes"], ["first", "United States"]]);
  // Nothing saved says citizen: nothing is said.
  assert.deepEqual(proposals([field(question, { kind: "combobox", options: ["No", "Yes"] }), field("Country 1 Name", { kind: "combobox" })], profile), []);
});

// Westinghouse's SuccessFactors (report cc40f1fb, 2026-10-27): beside "Country 1
// Name" is a required "Type of Status 1", which was left empty for a citizen.
test("a citizen's first country of citizenship is held as a citizen", () => {
  const citizen = profileSchema.parse({ ...profile, workAuthorization: "US Citizen" });
  const answered = proposals([
    field("Type of Status 1", { id: "first", kind: "combobox" }),
    field("Type of Status 2", { id: "second", kind: "combobox", required: false }),
  ], citizen);
  assert.deepEqual(answered.map((proposal) => [proposal.fieldId, proposal.value]), [["first", "Citizen"]]);
  assert.ok(answered[0].choices?.includes("U.S. Citizen"));
  assert.deepEqual(proposals([field("Type of Status 1", { kind: "combobox" })], profile), []);
});

// Westinghouse's SuccessFactors (report d57dca7e, 2026-10-28): "Have you
// worked for Westinghouse in the past 12 months?" and "Were you referred by
// someone at Westinghouse?" were left empty, both required.
test("working there recently and a referral from someone there are answered from the profile", () => {
  const applicant = profileSchema.parse({
    ...profile,
    priorEmployment: "No",
    work: [{ organization: "Northwind Labs", title: "Intern", startDate: "2025-01", endDate: "", details: "", location: "" }],
    references: [{ name: "Jordan Lee", relationship: "Director of Northwind Labs", phone: "", email: "jordan@example.com" }],
  });
  const answer = (label: string, who = applicant) => proposals([field(label, { kind: "combobox" })], who)[0]?.value;
  assert.equal(answer("Have you worked for Westinghouse in the past 12 months?"), "No");
  assert.equal(answer("Were you referred by someone at Westinghouse?"), "No");
  assert.equal(answer("Were you referred by someone at Westinghouse Electric Company, LLC?"), "No");
  // Someone who vouches for the applicant works there, or the question is
  // about the applicant's own employer, or names no company: left alone.
  assert.equal(answer("Were you referred by someone at Northwind Labs?"), undefined);
  assert.equal(answer("Have you worked for Northwind Labs in the past 12 months?"), undefined);
  assert.equal(answer("Were you referred by someone?"), undefined);
  // A saved answer to the question is used instead.
  const saved = profileSchema.parse({ ...applicant, answers: [{ question: "Were you referred by an employee?", answer: "Yes" }] });
  assert.equal(answer("Were you referred by someone at Westinghouse?", saved), "Yes");
});

// Expand Energy's SuccessFactors (report a248361b, 2026-10-29) asks each
// school's Country, State and City. Penn State's got the applicant's home,
// Arizona, and the school list that follows the State then held no Penn State.
test("a school's or job's City, State and Country are its own, not the applicant's home", () => {
  const applicant = profileSchema.parse({
    ...profile,
    city: "Tucson",
    state: "Arizona",
    country: "United States",
    education: [
      { organization: "Michigan State University", title: "Master of Science", location: "East Lansing, MI", startDate: "2025-08", endDate: "2027-05", details: "" },
      { organization: "Pennsylvania State University, University Park", title: "Bachelors of Science", location: "University Park, Pennsylvania", startDate: "2020-09", endDate: "2024-06", details: "" },
      { organization: "Online Academy", title: "Certificate", location: "", startDate: "2019", endDate: "2019", details: "" },
    ],
  });
  const ask = (label: string, index: number, kind = "combobox") =>
    proposals([field(label, { kind, section: "What is your educational background?", index })], applicant)[0];
  assert.equal(ask("State", 1)?.value, "Pennsylvania");
  assert.ok(ask("State", 1)?.choices?.includes("PA"));
  assert.equal(ask("State", 0)?.value, "Michigan");
  assert.equal(ask("* City", 1, "text")?.value, "University Park");
  assert.equal(ask("Country", 1)?.value, "United States");
  // A school with no place saved is not given the applicant's.
  assert.equal(ask("State", 2), undefined);
  assert.equal(ask("* City", 2, "text"), undefined);
  // Outside a school or job row, the home address still answers.
  assert.equal(proposals([field("State", { kind: "combobox" })], applicant)[0]?.value, "Arizona");
});

// Expand Energy's SuccessFactors (2026-10-29) asks "* City" in a text box;
// "Tucson" there became "Tucson, Arizona".
test("a text box asking only for the city gets only the city", () => {
  const applicant = profileSchema.parse({ ...profile, city: "Tucson", state: "Arizona", country: "United States" });
  assert.equal(proposals([field("* City")], applicant)[0]?.value, "Tucson");
  assert.equal(proposals([field("City")], applicant)[0]?.value, "Tucson");
  // A box asking where the applicant lives still gets the state.
  assert.equal(proposals([field("Where are you currently located? (City, State)")], applicant)[0]?.value, "Tucson, Arizona");
});

// Expand Energy's SuccessFactors (report 4d01710e, 2026-10-29): each school's
// "Education Type" (College, GED, High School, Junior College, Trade School)
// and "What date are you available to start work?" were left empty.
test("a school's education type comes from its degree, and a start date is asked as a date", () => {
  const applicant = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Masters of Science", startDate: "2025-08", endDate: "2027-05", location: "", details: "" },
      { organization: "Mesa Community College", title: "Associate of Arts", startDate: "2018-08", endDate: "2020-05", location: "", details: "" },
    ],
    answers: [{ question: "When can you start?", answer: "Immediately" }],
  });
  const type = (index: number) =>
    proposals([field("Education Type", { kind: "combobox", section: "What is your educational background?", index })], applicant)[0]?.value;
  assert.equal(type(0), "College");
  assert.equal(type(1), "Junior College");
  // Outside a school's row it says nothing.
  assert.equal(proposals([field("Education Type", { kind: "combobox" })], applicant)[0]?.value, undefined);
  const start = proposals([field("What date are you available to start work?", { kind: "datepicker" })], applicant)[0]?.value || "";
  assert.match(start, /^\d{2}\/\d{2}\/\d{4}$/);
  // Without a saved answer the date is not made up.
  assert.equal(proposals([field("What date are you available to start work?", { kind: "datepicker" })], profileSchema.parse({ ...profile, answers: [] }))[0]?.value, undefined);
});

// Expand Energy's SuccessFactors (2026-10-30) asked three questions most
// forms ask in some wording, and each was left to the applicant; one saved
// answer now covers every wording.
test("essential job functions, military status and earlier interviews are answered from saved answers", () => {
  const applicant = profileSchema.parse({
    ...profile,
    answers: [
      { question: "Can you perform the essential job functions with or without reasonable accommodation?", answer: "Yes" },
      { question: "Military status", answer: "No" },
      { question: "Have you interviewed with this company before?", answer: "No" },
    ],
  });
  const ask = (label: string, options: string[] = []) =>
    proposals([field(label, { kind: options.length ? "select" : "combobox", options })], applicant)[0];
  assert.equal(ask("Are you able to perform the essential job functions for the position for which you are applying with or without reasonable accommodation?", ["Yes", "No"])?.value, "Yes");
  assert.equal(ask("Military Status", ["No Selection", "Active Guard", "Active Reserve", "No Military", "Not Indicated"])?.value, "No Military");
  assert.ok(ask("Military Status")?.choices?.includes("No Military"));
  assert.equal(ask("Are you serving, or have you ever served in the Armed Forces?", ["Yes", "No"])?.value, "No");
  assert.equal(ask("Have you ever interviewed with Chesapeake Energy, Southwestern Energy, or Expand Energy before?", ["Yes", "No"])?.value, "No");
  // Without saved answers, nothing is assumed.
  assert.equal(proposals([field("Military Status", { kind: "combobox" })], profileSchema.parse({ ...profile, answers: [] }))[0]?.value, undefined);
});

// Notion's Ashby form (2026-10-30): "Please indicate all of the locations
// that you would be interested in relocating to for this position", one box
// per city. Willing to relocate, every one is ticked; otherwise none is.
test("a relocation question listing its locations as boxes is answered from the relocation answer", () => {
  const asked = "Please indicate all of the locations that you would be interested in relocating to for this position.";
  const box = (label: string) => field(label, { kind: "checkbox", question: asked, options: ["Yes", "No"] });
  const willing = profileSchema.parse({ ...profile, answers: [{ question: "Are you willing to relocate?", answer: "Yes" }] });
  assert.deepEqual(proposals([box("New York, NY"), { ...box("San Francisco, CA"), id: "sf" }], willing).map((proposal) => proposal.value), ["Yes", "Yes"]);
  const staying = profileSchema.parse({ ...profile, answers: [{ question: "Are you willing to relocate?", answer: "No" }] });
  assert.deepEqual(proposals([box("New York, NY")], staying), []);
  assert.deepEqual(proposals([box("New York, NY")], profileSchema.parse({ ...profile, answers: [] })), []);
});

// Elucid's JazzHR form (capture c11a168d, 2026-10-30): "What's your
// citizenship / employment eligibility?" lists statuses under each country,
// and "Are you available to work in the Greater Boston area for the duration
// of this internship?" asks the relocation question of one place.
test("a citizen picks their status from a list of eligibilities, and one willing to relocate is available where the job is", () => {
  const citizen = profileSchema.parse({ ...profile, workAuthorization: "US Citizen", answers: [{ question: "Are you willing to relocate?", answer: "Yes" }] });
  const eligibility = field("What's your citizenship / employment eligibility?", {
    id: "citizen",
    kind: "select",
    options: ["I am a U.S. Citizen/Permanent Resident", "Non-citizen allowed to work for any employer", "Non-citizen allowed to work for current employer", "Non-citizen seeking work authorization", "I am a Canadian Citizen/Permanent Resident", "Other"],
  });
  const boston = field("Are you available to work in the Greater Boston area for the duration of this internship?", { id: "boston", kind: "select", options: ["Yes", "No"] });
  assert.deepEqual(proposals([eligibility, boston], citizen).map((proposal) => [proposal.fieldId, proposal.value]), [
    ["citizen", "I am a U.S. Citizen/Permanent Resident"],
    ["boston", "Yes"],
  ]);
  // Nothing saved: nothing is said.
  assert.deepEqual(proposals([eligibility, boston], profile), []);
});

test("a minimum-GPA question is answered by comparing the saved GPA, on the same scale only", () => {
  // Nokia's Oracle form, report 1f68e4f9.
  const yesNo = { kind: "radio" as const, options: ["Yes", "No"] };
  const asked = field("Do you meet the minimum GPA requirement of 3.0?", yesNo);
  assert.equal(proposals([asked], withGPA(profile, "3.84"))[0]?.value, "Yes");
  assert.equal(proposals([asked], withGPA(profile, "2.9"))[0]?.value, "No");
  assert.equal(proposals([field("Is your cumulative GPA 3.5 or higher?", yesNo)], withGPA(profile, "3.84"))[0]?.value, "Yes");
  assert.deepEqual(proposals([asked], profile), []);
  // Another scale is never compared with a four-point minimum: 8.7 of 10,
  // or a German 1.3 where lower is better.
  assert.deepEqual(proposals([asked], withGPA(profile, "8.7", "10")), []);
  assert.deepEqual(proposals([asked], withGPA(profile, "1.3", "other")), []);
  assert.deepEqual(proposals([asked], withGPA(profile, "3.84", "other")), []);
  // A question that states its own scale is compared on it.
  const tenPoint = field("Do you have a CGPA of at least 7.5 out of 10?", yesNo);
  assert.equal(proposals([tenPoint], withGPA(profile, "8.7", "10"))[0]?.value, "Yes");
  assert.deepEqual(proposals([tenPoint], withGPA(profile, "3.84")), []);
  // A Workday list, its options not read until opened (Morningstar, report
  // f502e2b5): still a yes/no, never the GPA itself.
  assert.equal(proposals([field("Do you have a 3.0 gpa or higher?", { kind: "combobox", options: [] })], withGPA(profile, "3.84"))[0]?.value, "Yes");
});

test("a graduation date split in three after its question gets each part", () => {
  // Nokia's Oracle form, report 1f68e4f9: each box got "May 2027" or "2027".
  const dated = { ...profile, education: [{ ...profile.education[0], endDate: "2099-12-13" }] };
  const part = (name: string) => proposals([field(`What is your expected year of graduation? ${name}`, { kind: "combobox" })], dated)[0]?.value;
  assert.equal(part("Month"), "December");
  assert.equal(part("Day"), "13");
  assert.equal(part("Year"), "2099");
  // Workday's parts carry their question with a colon (report c875e6c5).
  const workday = (name: string) => proposals([field(`What is your projected/approximate graduation date?: ${name}`, { kind: "text" })], dated)[0];
  assert.equal(workday("Month")?.value, "December");
  assert.ok(workday("Month")?.choices?.includes("12"));
  assert.equal(workday("Year")?.value, "2099");
  // After a sentence, and the 1st where the question says to use it (NGC,
  // report b80c92a2): the profile holds only May 2027.
  const monthOnly = { ...profile, education: [{ ...profile.education[0], endDate: "2099-05" }] };
  const ngc = (name: string) => proposals([field(`What is your (estimated or actual) graduation date? If you do not know your graduation day, input the first of the month.: ${name}`, { kind: "text" })], monthOnly)[0]?.value;
  assert.equal(ngc("Month"), "May");
  assert.equal(ngc("Day"), "1");
  assert.equal(ngc("Year"), "2099");
});

test("Workday's degree codes and country-suffixed race options are matched", () => {
  // WEX's Workday (report 6a57344f) and RTX's (2026-10-31).
  assert.equal(pickListOption({ value: "Masters of Science", choices: degreeAliases("Masters of Science") },
    ["Master of Arts (M.A)", "Master of Science (M.S)", "Master of Business Administration (MBA)"], (option) => option), "Master of Science (M.S)");
  // HPE's: each degree explained in brackets (report 451b9877).
  assert.equal(pickListOption({ value: "Masters of Science", choices: degreeAliases("Masters of Science") },
    ["Bachelors (±16 years of education)", "Masters (±18 years of education)", "Doctorate (over 19 years of education)"], (option) => option), "Masters (±18 years of education)");
  const race = proposals([field("What is your race / ethnicity?", { kind: "combobox" })], { ...profile, ethnicity: "South Asian" })[0];
  assert.equal(pickListOption(race!, ["Asian (Not Hispanic or Latino) (United States of America)", "White (Not Hispanic or Latino) (United States of America)"], (option) => option),
    "Asian (Not Hispanic or Latino) (United States of America)");
});

test("salary expectations are given for the period asked, in the applicant's currency only", () => {
  // WEX's Workday asked "What is your salary expectation?" (2026-10-31).
  const yearly = { ...profile, salary: { min: 95000, currency: "$", period: "year" as const } };
  const hourly = { ...profile, salary: { min: 35, currency: "", period: "hour" as const } };
  const answer = (label: string, saved: typeof profile, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], saved)[0]?.value;
  assert.equal(answer("What is your salary expectation?", yearly), "$95,000");
  assert.equal(answer("Desired annual salary", yearly), "$95,000");
  // Pay is never converted between periods.
  assert.equal(answer("What is your expected hourly pay rate?", yearly), undefined);
  assert.equal(answer("What is your expected hourly pay rate?", hourly), "35");
  assert.equal(answer("What is your salary expectation?", hourly), "35 per hour");
  // A box that takes only a number gets the figure alone.
  assert.equal(answer("Desired salary (numbers only)", yearly), "95000");
  assert.equal(answer("What is your salary expectation?", yearly, { kind: "number" }), "95000");
  // A range in euros stays in euros; none is added where none was given.
  const euros = { ...profile, salary: { min: 55000, max: 65000, currency: "EUR", period: "year" as const } };
  assert.equal(answer("What is your salary expectation?", euros), "EUR 55,000-65,000");
  assert.equal(answer("What is your salary expectation?", { ...profile, salary: { min: 55000, currency: "", period: "year" as const } }), "55,000");
  assert.deepEqual(proposals([field("Desired salary range", { kind: "select", options: ["$50k-$70k", "$70k-$90k"] })], yearly), []);
});

test("an application page's posting is guessed as the same address without /apply", () => {
  // NeuroHire's Workable page, 2026-10-31.
  assert.equal(postingGuess("https://apply.workable.com/neurohire-dot-a-i/j/DE75CD20B8/apply"), "https://apply.workable.com/neurohire-dot-a-i/j/DE75CD20B8");
  assert.equal(postingGuess("https://jobs.lever.co/tri/f8c9ed26-4574-4ad2-954b-b7f5ec365495/apply?lever-source=x"), "https://jobs.lever.co/tri/f8c9ed26-4574-4ad2-954b-b7f5ec365495");
  assert.equal(postingGuess("https://jobs.ashbyhq.com/acme/1234/application"), "https://jobs.ashbyhq.com/acme/1234");
  // Microsoft's careers site applies at ?pid= and shows the job at /careers/job/<id> (report bce03da9).
  assert.equal(postingGuess("https://apply.careers.microsoft.com/careers/apply?pid=1970393557049981"), "https://apply.careers.microsoft.com/careers/job/1970393557049981");
  assert.equal(postingGuess("https://example.com/careers/engineer"), undefined);
  assert.equal(postingGuess("https://example.com/apply"), undefined);
});

test("a LinkedIn or GitHub link asked as a request with instructions is still the profile's", () => {
  // Micron's Workday (report 88608f31, 2026-11-02).
  const asked = field("Please provide your LinkedIn Profile url. Instruction: Navigate to your LinkedIn Profile page, copy the url and paste here.", { kind: "text" });
  assert.match(proposals([asked], { ...profile, linkedin: "linkedin.com/in/example" })[0]?.value || "", /linkedin\.com\/in\/example$/);
  // A question about LinkedIn that asks for something else is not the link.
  assert.deepEqual(proposals([field("How did you hear about us on LinkedIn?", { kind: "text" })], { ...profile, linkedin: "linkedin.com/in/example" }).map((p) => p.value).filter((v) => /linkedin\.com/.test(v)), []);
});

// JM Family's Workday (report 5494cdaa, 2026-11-04): "interns must be
// actively enrolled in a … degree-seeking program … If you qualify, please
// select yes." was left for an applicant midway through a master's.
test("a current student answers Yes to being enrolled, and nobody else is answered for", () => {
  const now = new Date();
  const ym = (months: number) => {
    const date = new Date(now.getFullYear(), now.getMonth() + months, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  };
  const row = (startDate: string, endDate: string) => ({ organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate, endDate, location: "", details: "" });
  const student = profileSchema.parse({ ...profile, education: [row(ym(-14), ym(8))] });
  const graduate = profileSchema.parse({ ...profile, education: [row(ym(-40), ym(-3))] });
  const justStarted = profileSchema.parse({ ...profile, education: [row(ym(-1), ym(20))] });
  const label = "To qualify for our program, interns must be actively enrolled in a bachelor’s, master’s, or other degree-seeking program at an accredited college or university, with a focus in a relevant field. Students must have completed at least one semester of coursework. Students who will be graduating in Spring 2027 will also be considered.  If you qualify, please select yes.";
  const pick = (who: typeof student, text = label, overrides: Partial<Field> = { kind: "combobox", options: ["Yes", "No"] }) => proposals([field(text, overrides)], who)[0]?.value;
  assert.equal(pick(student), "Yes");
  // A list read only when opened still gets its answer.
  assert.equal(pick(student, label, { kind: "combobox", options: [] }), "Yes");
  assert.equal(pick(student, "Are you currently enrolled in a degree program?"), "Yes");
  assert.equal(pick(graduate), undefined);
  assert.equal(pick(justStarted), undefined);
  // Which school is another question, answered with the school, not Yes.
  assert.equal(pick(student, "Please include the university you are currently enrolled in", { kind: "text" }), "Michigan State University");
});

// Philips' Workday (2026-11-04): a U.S. citizen was asked whether they hold
// temporary authorization (OPT, CPT) and, if on OPT, whether they could
// extend it, and both were left. A citizen holds none and is not on OPT;
// anyone else is left to answer.
test("OPT and CPT questions are answered for a citizen and left for anyone else", () => {
  const ask = (label: string, options: string[], who: Parameters<typeof proposals>[1]) =>
    proposals([field(label, { kind: "combobox", options })], who)[0]?.value;
  const citizen = profileSchema.parse({ ...profile, workAuthorization: [{ country: "US", status: "citizen", needsSponsorship: false }] });
  const student = profileSchema.parse({ ...profile, workAuthorization: [{ country: "US", status: "visa", needsSponsorship: true }] });
  const temporary = "Do you have temporary authorization (e.g., OPT, CPT, or similar temporary work authorization) to currently work in the United States?";
  const extension = "If you are currently in a period of Optional Practical Training (OPT), are you eligible for a 24-month OPT extension based upon a degree from a qualifying United States institution in Science, Technology, Engineering or Mathematics (STEM)?";
  assert.equal(ask(temporary, ["Yes", "No"], citizen), "No");
  assert.equal(ask(extension, ["Yes", "No", "N/A"], citizen), "N/A");
  assert.equal(ask("Are you currently in a period of Optional Practical Training (OPT)?", [], citizen), "No");
  // No "N/A" to say it with: a No would read as ineligible.
  assert.equal(ask(extension, ["Yes", "No"], citizen), undefined);
  assert.equal(ask(temporary, ["Yes", "No"], student), undefined);
  assert.equal(ask(extension, ["Yes", "No", "N/A"], student), undefined);
});

// Philips' Workday (report 2d320e91, 2026-11-04): "I am a veteran but do not
// fall under the protected classifications" was chosen for someone who never
// served, and "I have no military experience" read as a veteran's answer.
test("a veteran list that words service apart is answered by the saved military answer", () => {
  const options = ["I am a Protected Veteran (as defined above)", "I am a veteran but do not fall under the protected classifications listed above", "I have no military experience", "I do not wish to disclose my status"];
  const ask = (military: string | undefined) =>
    proposals([field("Please select your Veteran status.", { kind: "combobox", options })], profileSchema.parse({
      ...profile,
      veteranStatus: "No",
      answers: military ? [{ question: "Military status", answer: military }] : [],
    }))[0]?.value;
  assert.equal(ask("No"), "I have no military experience");
  assert.equal(ask("Yes"), "I am a veteran but do not fall under the protected classifications listed above");
  // Not known whether they served: neither is said for them.
  assert.equal(ask(undefined), undefined);
  assert.equal(canonicalAnswer("veteranStatus", "I have no military experience"), "No");
});

// A SmartRecruiters screening page (2026-11-04): its graduation month list
// holds only months, its past-employment list says No as "Not Applicable",
// and the date box after it asks for the details, not Yes or No.
test("a months-only list takes the month, a list without No takes Not Applicable, and a details box after a past-employer question is left", () => {
  const applicant = profileSchema.parse({ ...profile, neverWorkedForApplyingCompanies: true, applyingTo: { company: "Acme", title: "Engineer Intern" }, education: [{ organization: "Penn State", title: "Masters of Science", startDate: "2025-08-21", endDate: "2099-12-13" }] });
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const answer = (label: string, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], applicant)[0];
  const listed = (label: string, options: string[]) => {
    const proposal = answer(label, { kind: "combobox", options });
    return proposal && pickListOption(proposal, options, (option) => option);
  };
  assert.equal(listed("Please select your Graduation Month", months), "December");
  assert.equal(listed("Do you currently or have you previously worked at Acme in any capacity? (Select all that apply)", ["Not Applicable", "I currently work at Acme", "I previously worked at Acme"]), "Not Applicable");
  assert.equal(answer("If you have previously worked at Acme, please provide your approximate last date of employment.(MM/DD/YYYY)"), undefined);
});

// The same page's degree type list and its "Today's Date" box beside the
// typed name were left unanswered (2026-11-05).
test("a degree type list takes the degree under way, and a Today's Date box today's date", () => {
  const applicant = profileSchema.parse({ ...profile, education: [
    { organization: "Virginia Tech", title: "Bachelor of Science", startDate: "2018-08-20", endDate: "2022-05-10" },
    { organization: "Penn State", title: "Masters of Science", startDate: "2025-08-21", endDate: "2099-12-13" },
  ] });
  const answer = (label: string, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], applicant)[0]?.value;
  assert.equal(answer("Please select your degree type", { kind: "combobox", options: ["BA/BS", "Masters", "PhD", "N/A"] }), "Masters");
  const today = new Date();
  assert.equal(answer("Today's Date"), `${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}/${today.getFullYear()}`);
});

// LinkedIn's Race/Ethnicity (2026-11-05): its label defines each category
// after its name, "Hispanic or Latino" first, and names places ("China,
// India, Japan") the U.S. definitions use. It was read as the Hispanic
// question, then as another country's, and left.
test("a race list whose label carries the U.S. category definitions takes the race", () => {
  const applicant = profileSchema.parse({ ...profile, ethnicity: "South Asian", hispanic: "No" });
  const label = "Race/Ethnicity Race categories are defined as follows: Hispanic or Latino - A person of Cuban, Mexican, Puerto Rican, South or Central American, or other Spanish culture or origin regardless of race White (Not Hispanic or Latino) - A person having origins in any of the original peoples of Europe, the Middle East, or North Africa Asian (Not Hispanic or Latino) - A person having origins in any of the original peoples of the Far East, Southeast Asia, or the Indian Subcontinent, including, for example, Cambodia, China, India, Japan, Korea, Malaysia, Pakistan, the Philippine Islands, Thailand, and Vietnam American Indian or Alaska Native (Not Hispanic or Latino) - A person having origins in any of the original peoples of North and South America Two or More Races (Not Hispanic or Latino) - All persons who identify with more than one of the above five races";
  const options = ["Hispanic or Latino", "American Indian or Alaska Native (Not Hispanic or Latino)", "Asian (Not Hispanic or Latino)", "White (Not Hispanic or Latino)", "Two or More Races (Not Hispanic or Latino)", "I prefer not to specify"];
  assert.equal(proposals([field(label, { kind: "combobox", options })], applicant)[0]?.value, "Asian (Not Hispanic or Latino)");
  // Still the Hispanic question when it is asked first.
  assert.equal(proposals([field("Are you Hispanic or Latino?", { kind: "select", options: ["Yes", "No"] })], applicant)[0]?.value, "No");
});

// A SmartRecruiters pass types and picks each title, company, school and
// place with real keys: at 60 s it was cut off in the second school
// (LinkedIn, 2026-11-05). It gets the time Workday's does.
test("a site rule's pass gets the longer time on sites whose picks are slow", () => {
  assert.equal(configPassTimeout("jobs.smartrecruiters.com"), 150_000);
  assert.equal(configPassTimeout("acme.wd1.myworkdayjobs.com"), 150_000);
  assert.equal(configPassTimeout("jobs.lever.co"), 60_000);
});

// L3Harris (report 726eafd7, 2026-11-07): "Are you related or have close
// personal friendships with any current L3Harris employees…" was left at No
// Selection. As with a referral: none of the applicant's references or jobs
// there, No; one there, theirs to say.
test("a related-to-an-employee question is No unless a reference or a job is at the company", () => {
  const label = "Are you related or have close personal friendships with any current Acme employees with whom you will be directly working with if hired?";
  const options = ["No", "Unknown", "Yes"];
  const ask = (who: typeof profile) => proposals([field(label, { kind: "combobox", options })], who)[0]?.value;
  assert.equal(ask(profileSchema.parse({ ...profile, applyingTo: { company: "Acme", title: "Intern" } })), "No");
  assert.equal(ask(profileSchema.parse({ ...profile, references: [{ name: "Sam Lee", relationship: "Manager at Acme", email: "sam@acme.example" }] })), undefined);
});

// Microsoft (2026-11-07): "Are you currently enrolled in a Doctorate Degree
// program in Computer Science…?" was answered Yes for a master's student.
// A question naming a level asks about that level.
test("an enrollment question naming a degree level is answered for that level", () => {
  const applicant = profileSchema.parse({ ...profile, education: [
    { organization: "Virginia Tech", title: "Bachelor of Science", startDate: "2018-08", endDate: "2022-05" },
    { organization: "Penn State", title: "Master of Science", startDate: "2025-08", endDate: "2099-12" },
  ] });
  const ask = (label: string) => proposals([field(label, { kind: "combobox", options: ["Yes", "No"] })], applicant)[0]?.value;
  assert.equal(ask("Are you currently enrolled in a Doctorate Degree program in Computer Science, Operations Research or a related STEM field?"), "No");
  assert.equal(ask("Are you currently enrolled in a Master's degree program?"), "Yes");
  assert.equal(ask("Are you currently enrolled in a Bachelor's degree program?"), "No");
});

// CharterUP and Rubrik on Greenhouse (2026-11-07): "1–2 years" with its unit
// read as no option for one year; "Yes, I am currently based in Atlanta, GA"
// was taken for an applicant elsewhere who will relocate; "What is your
// Legal Name?" was left.
test("a range with its unit, the relocating Yes, and a legal name asked as a question are answered", () => {
  const applicant = profileSchema.parse({ ...profile, city: "Phoenix", willingToRelocate: "Yes", work: [{ organization: "Acme", title: "Data Analyst", startDate: "2024-06", endDate: "2025-08", details: "" }] });
  const pick = (label: string, options: string[]) => {
    const answer = proposals([field(label, { kind: "combobox", options })], applicant)[0];
    return answer && pickListOption(answer, options, (option) => option);
  };
  assert.equal(pickListOption({ value: "1", numeric: 1 }, ["Less than 1 year", "1–2 years", "3–4 years", "5+ years"], (option) => option), "1–2 years");
  assert.equal(pickListOption({ value: "6", numeric: 6 }, ["Less than 1 year", "1–2 years", "3–4 years", "5+ years"], (option) => option), "5+ years");
  assert.equal(pick("This role is hybrid and requires working from our Atlanta, GA office. Are you currently located in Atlanta or willing to relocate prior to your start date?", ["Yes, I am currently based in Atlanta, GA", "Yes, I am willing to relocate at my own expense", "No, I am not willing to relocate"]), "Yes, I am willing to relocate at my own expense");
  assert.equal(proposals([field("What is your Legal Name?")], applicant)[0]?.value, `${profile.firstName} ${profile.lastName}`);
});

// AMD's iCIMS screening page (report 4933eec7, 2026-11-07): years with one
// skill or kind of work are never more than all the applicant's work, so a
// "less than N years" choice is answered when all of it is under N, and
// nothing else is guessed.
test("a skill's years take a list's 'less than' choice only when all work is under it", () => {
  // Eighteen months of work, up to now.
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - 17);
  const worked = profileSchema.parse({
    ...profile,
    work: [{ organization: "Example Labs", title: "Engineer", location: "Lansing, MI", startDate: start.toISOString().slice(0, 10), endDate: "", details: "" }],
  });
  const hpc = field("How many years of experience do you have designing HPC, AI, or large-scale compute infrastructure?", {
    kind: "select", options: ["Less than 2 years", "2-5 years", "5-8 years", "8-12 years", "12+ years"],
  });
  assert.equal(proposals([hpc], worked)[0]?.value, "Less than 2 years");
  const cpp = field("Please select the # of years of professional work experience with the following: C/C++", {
    kind: "select", options: ["I have less than 1 year with this skill", "1-2 years", "3-5 years", "6-8 years", "more than 8 years"],
  });
  // Over a year of work in all: under one year with C/C++ is not known.
  assert.deepEqual(proposals([cpp], worked), []);
  // Two years exactly is not under two.
  const two = new Date();
  two.setUTCDate(1);
  two.setUTCMonth(two.getUTCMonth() - 23);
  const longer = profileSchema.parse({ ...worked, work: [{ ...worked.work[0], startDate: two.toISOString().slice(0, 10) }] });
  assert.deepEqual(proposals([hpc], longer), []);
  const fresh = profileSchema.parse({
    ...profile,
    work: [{ organization: "Example Labs", title: "Intern", location: "Lansing, MI", startDate: "2023-07-01", endDate: "2023-09-01", details: "" }],
  });
  assert.equal(proposals([cpp], fresh)[0]?.value, "I have less than 1 year with this skill");
});

// Applied Materials (report 297590e2, 2026-11-08): asked where the applicant
// would move from, the relocation question's "Yes" was given.
test("a question asking the city, state and zip one would move from gets the applicant's place", () => {
  // As the applicant's: willing to relocate, which answered it before.
  const placed = profileSchema.parse({ ...profile, city: "Lansing", state: "Michigan", postalCode: "48910", willingToRelocate: "Yes" });
  const asked = field("Relocation assistance may be available for this role. If you would need to relocate, please tell us the city, state, and zip code you’d be moving from", { kind: "textarea" });
  assert.equal(proposals([asked], placed)[0]?.value, "Lansing, Michigan 48910");
});

// Leidos's Workday questions (2026-11-08): the highest degree asked after a
// preamble naming "your most recent graduation date" was given that date,
// and "Expected degree completion date" was left.
test("a highest-degree question after a preamble, and an expected completion date, are answered", () => {
  const studying = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08-19", endDate: "2099-05-10", location: "", details: "" },
      { organization: "Penn State", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15", location: "", details: "" },
    ],
  });
  const highest = field("4. If hired by Leidos, we will verify your most recent graduation date and the highest degree or diploma received. What is the highest level of education you've received?", { kind: "combobox" });
  assert.match(proposals([highest], studying)[0]?.value || "", /^Bachelor/);
  const part = (name: string) => proposals([field(`5a. Expected degree completion date.: ${name}`, { kind: "spinbutton" })], studying)[0]?.value;
  assert.equal(part("Month"), "May");
  assert.equal(part("Day"), "10");
  assert.equal(part("Year"), "2099");
});

// Leidos (report bb699b7d, 2026-11-08): "Did you obtain this degree in the
// last 24 months?" after the highest degree received: that degree's end.
test("a degree obtained within so many months is read from the highest finished degree's end", () => {
  const ago = (months: number) => {
    const at = new Date();
    at.setUTCDate(1);
    at.setUTCMonth(at.getUTCMonth() - months);
    return at.toISOString().slice(0, 10);
  };
  const graduated = (end: string) => profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Master of Science", startDate: "2025-08-19", endDate: "2099-05-10", location: "", details: "" },
      { organization: "Penn State", title: "Bachelor of Science", startDate: "2020-09-13", endDate: end, location: "", details: "" },
    ],
  });
  const asked = field("4a. Did you obtain this degree in the last 24 months?", { kind: "combobox" });
  assert.equal(proposals([asked], graduated(ago(29)))[0]?.value, "No");
  assert.equal(proposals([asked], graduated(ago(10)))[0]?.value, "Yes");
});

// Databricks' Greenhouse form (report b3cb8c2b, 2026-11-08): its sanctions
// list had "Ordinarily a resident of Russia or Belarus and not willing to
// relocate…" ticked as a relocation answer, and its follow-up's "U.S.
// citizen" as citizenship. Read as what they ask, an applicant tied to no
// sanctioned place has "None of the above" and then "Not applicable".
test("a sanctions list and its follow-up are answered as what they ask", () => {
  const american = profileSchema.parse({ ...profile, country: "United States", citizenships: ["US"], willingToRelocate: "Yes" });
  const sanctions = "Please confirm whether any of the below applies to you. Select all that apply. Note: This information will only be used to ensure compliance with U.S. sanctions and export controls.";
  const followUp = "If you selected a response to the prior question other than “none of the above,” please confirm whether any of the following also applies to you. Select all that apply.";
  const box = (question: string, option: string) => field(`${question}: ${option}`, { kind: "checkbox", question, required: false });
  const ticked = (question: string, option: string, who = american) => proposals([box(question, option)], who)[0]?.value;
  // A box ticked before (by an earlier fill or the site) is cleared; an
  // empty one is left empty.
  const clears = (question: string, option: string) =>
    proposals([{ ...box(question, option), value: "Yes", siteValue: true }], american)[0]?.value;
  assert.equal(clears(sanctions, "Ordinarily a resident of Russia or Belarus and not willing to relocate for a Databricks role"), "No");
  assert.equal(ticked(sanctions, "Citizen or permanent resident of Cuba, Iran, North Korea, or Syria"), undefined);
  assert.equal(ticked(sanctions, "None of the above"), "Yes");
  assert.equal(clears(followUp, "U.S. citizen"), "No");
  assert.equal(ticked(followUp, "Not applicable (i.e., I selected “none of the above” for the prior question)"), "Yes");
  // A tie to a sanctioned place, or no citizenship saved: the applicant's.
  const tied = profileSchema.parse({ ...american, citizenships: ["US", "RU"] });
  assert.equal(ticked(sanctions, "None of the above", tied), undefined);
  assert.equal(ticked(sanctions, "None of the above", profileSchema.parse({ ...american, citizenships: [] })), undefined);
});
