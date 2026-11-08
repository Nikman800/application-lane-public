import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { globalConfigSchema } from "../src/engine/config/schema";
import {
  canonicalValues,
  matchOption,
  selectorValues,
} from "../src/engine/values";
import { profileSchema } from "../src/shared/model";
import { canonicalAnswer } from "../src/shared/answers";

const globals = globalConfigSchema.parse(
  JSON.parse(await readFile("src/engine/config/globals.json", "utf8")),
);
const profile = profileSchema.parse({
  confirmed: true,
  firstName: "Alex",
  lastName: "Rivera",
  email: "alex@example.test",
  phone: "+1 (602) 555-0100",
  phoneDeviceType: "Mobile",
  city: "Phoenix",
  state: "Arizona",
  county: "Maricopa",
  country: "United States",
  address: "100 Test Way",
  addressLine2: "Suite 200",
  postalCode: "85001",
  linkedin: "https://linkedin.com/in/alex",
  referralSource: ["LinkedIn", "Online job board"],
  disabilityStatus: "No",
  veteranStatus: "Not a protected veteran",
  gender: "Decline to self-identify",
  ethnicity: "Decline to self-identify",
  hispanic: "No",
  workAuthorization: "Yes",
  sponsorship: "No",
  age18OrOlder: "Yes",
  willingToRelocate: "Yes",
  priorEmployment: "None",
  acknowledgeTerms: true,
  skills: ["TypeScript", "Python"],
  facts: [],
  education: [
    {
      organization: "State University",
      title: "Bachelor of Science",
      fieldOfStudy: "Computer Science",
      startDate: "2020-08",
      endDate: "2024-05",
    },
  ],
  answers: [{ question: "Work auth", answer: "Yes" }],
});

test("a rule's degree wordings are used only for a compatible degree", () => {
  const values = selectorValues("degree", { path: ".", values: {
    "Bachelor of Science": ["BS - Bachelor of Science"],
    "Bachelor of Arts": ["BA - Bachelor of Arts"],
    "Bachelor's degree": ["Bachelor's (4 year)"],
    "Master of Science": ["MS - Master of Science"],
  } }, profile, globals, { collection: "education", index: 0 });
  assert.ok(values.includes("BS - Bachelor of Science"));
  assert.ok(values.includes("Bachelor's (4 year)"));
  assert.equal(values.includes("BA - Bachelor of Arts"), false);
  assert.equal(values.includes("MS - Master of Science"), false);
});

test("maps canonical config keys to confirmed profile values", () => {
  assert.deepEqual(canonicalValues("first_name_2", profile), ["Alex"]);
  // The national number's digits; its country code is a key of its own.
  assert.deepEqual(canonicalValues("phone_stripped", profile), ["6025550100"]);
  assert.deepEqual(canonicalValues("phone", profile), ["(602) 555-0100"]);
  assert.deepEqual(canonicalValues("phone_country_code", profile), ["+1"]);
  assert.deepEqual(canonicalValues("phone_country", profile), ["United States"]);
  assert.deepEqual(canonicalValues("city_state_full", profile), [
    "Phoenix, Arizona",
  ]);
  assert.deepEqual(canonicalValues("work_auth", profile), ["Yes"]);
  assert.equal(canonicalValues("phone_type", profile)[0], "Mobile");
  assert.deepEqual(canonicalValues("county", profile), ["Maricopa"]);
  assert.deepEqual(canonicalValues("address_2", profile), ["Suite 200"]);
  assert.deepEqual(canonicalValues("source", profile), [
    "LinkedIn",
    "Online job board",
  ]);
  assert.deepEqual(canonicalValues("disability", profile), ["No"]);
  // Answer-bank text is normalized to a fixed choice.
  assert.deepEqual(canonicalValues("veteran_status", profile), ["No"]);
  assert.deepEqual(canonicalValues("veteran", profile), ["No"]);
  assert.deepEqual(canonicalValues("acknowledge_terms", profile), ["Yes"]);
  assert.deepEqual(
    canonicalValues("acknowledge_terms", {
      ...profile,
      acknowledgeTerms: false,
    }),
    [],
  );
  assert.deepEqual(canonicalValues("skill", profile), ["TypeScript", "Python"]);
  assert.deepEqual(canonicalValues("over18", profile), ["Yes"]);
  assert.deepEqual(canonicalValues("relocation", profile), ["Yes"]);
  // "None" (never worked for a company applied to) is the new toggle, and
  // the answer is No when no job in the history is with the employer.
  assert.deepEqual(canonicalValues("prior_employment", profile), ["No"]);
  const today = new Date();
  assert.deepEqual(canonicalValues("current_date_YYYY", profile), [
    String(today.getFullYear()),
  ]);
  assert.deepEqual(
    canonicalValues("major", profile, { collection: "education", index: 0 }),
    ["Computer Science"],
  );
  assert.deepEqual(canonicalValues("gender", profile), ["Decline"]);
  const saved = {
    ...profile,
    answers: [
      {
        question: "Are you legally authorized to work in the United States?",
        answer: "Yes",
      },
      {
        question: "Will you now or in the future require sponsorship?",
        answer: "No",
      },
      { question: "How did you hear about us?", answer: "Online job board" },
    ],
  };
  assert.deepEqual(canonicalValues("work_auth", saved), ["Yes"]);
  assert.deepEqual(canonicalValues("sponsorship", saved), ["No"]);
  assert.deepEqual(canonicalValues("source", saved), ["Online job board"]);
});

test("Paylocity graduation month/year uses the selected education row", () => {
  // Paylocity: the second school's date must not come
  // from the current program or leave MM/YYYY to a prose-date fallback.
  const schools = profileSchema.parse({ ...profile, education: [
    { organization: "Example University", title: "Master of Science", startDate: "2025-08", endDate: "2099-12" },
    { organization: "Sample College", title: "Bachelor of Science", startDate: "2020-09", endDate: "2024-06" },
  ] });
  assert.deepEqual(canonicalValues("grad_date_slashes_MMYYYY", schools, { collection: "education", index: 0 }), ["12/2099"]);
  assert.deepEqual(canonicalValues("grad_date_slashes_MMYYYY", schools, { collection: "education", index: 1 }), ["06/2024"]);
});

test("applies selector value maps and global country aliases", () => {
  assert.ok(
    selectorValues(
      "country",
      { path: ".//select", values: "countryCodes" },
      profile,
      globals,
    ).includes("US"),
  );
  assert.deepEqual(
    selectorValues(
      "work_auth",
      { path: ".//input", values: { Yes: ["Y", "true"] } },
      profile,
      globals,
    ).slice(0, 2),
    ["Y", "true"],
  );
  assert.ok(
    selectorValues("location", { path: ".//input" }, profile, globals).includes(
      "Phoenix, AZ, United States",
    ),
  );
  // A location search lists a place under the country's short name (Ashby:
  // "Phoenix, Arizona, United States") where the profile has the long one.
  // With no candidate equal to the option, nothing was picked.
  const longName = profileSchema.parse({ ...profile, country: "United States of America" });
  assert.ok(selectorValues("location", { path: ".//input" }, longName, globals).includes("Phoenix, Arizona, United States"));
  // Only the country at the end is renamed, never a city or state that happens to match.
  assert.ok(!selectorValues("location", { path: ".//input" }, longName, globals).some((value) => /^United States,|, Arizona, US$/.test(value) && !/Phoenix/.test(value)));
  assert.ok(
    selectorValues(
      "state",
      { path: ".//button", values: "regionNames" },
      profile,
      globals,
    ).includes("AZ"),
  );
});

test("matches options in ordered stages without choosing duplicates", () => {
  assert.deepEqual(
    matchOption(
      ["United States"],
      [
        { label: "Canada", value: "CA" },
        { label: "USA", value: "US" },
      ],
      globals,
    ),
    { label: "USA", value: "US" },
  );
  assert.equal(
    matchOption(
      ["Phoenix"],
      [
        { label: "Phoenix", value: "one" },
        { label: "Phoenix", value: "two" },
      ],
      globals,
    ),
    undefined,
  );
});

test("option matching never infers names from contained words", () => {
  assert.equal(
    matchOption(["No"], [{ label: "Not authorized", value: "x" }], globals),
    undefined,
  );
  assert.equal(
    matchOption(["US"], [{ label: "Australia", value: "AU" }], globals),
    undefined,
  );
  assert.deepEqual(
    matchOption(
      ["Science"],
      [{ label: "Bachelor of Science", value: "BS" }],
      globals,
    ),
    undefined,
  );
  assert.deepEqual(matchOption(["No"], [{ label: "No, I do not require sponsorship", value: "n" }], globals), { label: "No, I do not require sponsorship", value: "n" });
  assert.equal(matchOption(["Yes"], [{ label: "Yes, citizen", value: "a" }, { label: "Yes, visa", value: "b" }], globals), undefined);
  assert.equal(matchOption(["No"], [{ label: "Norway", value: "NO" }], globals), undefined);
});

test("candidate order resolves options that map to several candidates", () => {
  // "Arizona" and "AZ" are both candidates for a state field; a select that
  // offers both must take the preferred candidate instead of giving up.
  const options = [
    { label: "Arizona", value: "Arizona" },
    { label: "AZ", value: "AZ" },
  ];
  assert.deepEqual(matchOption(["Arizona", "AZ"], options, globals), options[0]);
  assert.deepEqual(matchOption(["AZ", "Arizona"], options, globals), options[1]);
  // Genuine ambiguity for one candidate is still refused.
  assert.equal(
    matchOption(
      ["Yes"],
      [
        { label: "Yes", value: "1" },
        { label: "Yes", value: "2" },
      ],
      globals,
    ),
    undefined,
  );
  assert.deepEqual(
    canonicalValues("address_line_2", { ...profile, addressLine2: "Apt 4" }),
    ["Apt 4"],
  );
});

test("answer-bank choices reach each site's own option wording", async () => {
  // Common EEO wordings reach a list's options with no wordings of the rule's own.
  const selector = (_key: string) => ({ path: "." });
  const pick = (key: string, answers: Partial<typeof profile>, labels: string[]) =>
    matchOption(
      selectorValues(key, selector(key), { ...profile, answers: [], ...answers }, globals),
      labels.map((label) => ({ label, value: label })),
      globals,
    )?.label;
  const veteran = [
    "I am not a protected veteran",
    "I identify as one or more of the classifications of protected veteran",
    "I do not wish to self-identify",
  ];
  assert.equal(pick("veteran", { veteranStatus: "No" }, veteran), veteran[0]);
  assert.equal(pick("veteran", { veteranStatus: "Not a veteran" }, veteran), veteran[0]);
  assert.equal(pick("veteran", { veteranStatus: "Yes" }, veteran), veteran[1]);
  assert.equal(pick("veteran", { veteranStatus: "Prefer not to say" }, veteran), veteran[2]);
  // one employer's Workday lists no "protected" wording: "I am not a
  // veteran" is picked for someone whose saved answers say they never
  // served, and never for someone who did serve.
  const plain = ["I AM A VETERAN", "I AM NOT A VETERAN", "I DO NOT WISH TO SELF-IDENTIFY"];
  const served = (answer: string) => ({ veteranStatus: "No", answers: [{ question: "Military status", answer }] });
  assert.equal(pick("veteran", served("No"), plain), plain[1]);
  assert.notEqual(pick("veteran", served("Yes"), plain), plain[1]);
  assert.notEqual(pick("veteran", { veteranStatus: "No" }, plain), plain[1]);
  const gender = ["Male", "Female", "I do not wish to self-identify"];
  assert.equal(pick("gender", { gender: "Man" }, gender), "Male");
  assert.equal(pick("gender", { gender: "Decline" }, gender), gender[2]);
  const disability = [
    "Yes, I have a disability (or previously had a disability)",
    "No, I do not have a disability and have not had one in the past",
    "I do not want to answer",
  ];
  assert.equal(pick("disability", { disabilityStatus: "No" }, disability), disability[1]);
  assert.equal(pick("disability", { disabilityStatus: "Decline" }, disability), disability[2]);
  // "No" must not expand to a country code (NO = Norway).
  assert.ok(
    !selectorValues("hispanic", selector("hispanic"), { ...profile, answers: [], hispanic: "No" }, globals).includes("Norway"),
  );
});

test("citizenship answers mean authorized and no sponsorship needed", () => {
  assert.equal(canonicalAnswer("workAuthorization", "US Citizen"), "Yes");
  assert.equal(canonicalAnswer("workAuthorization", "Permanent Resident"), "Yes");
  assert.equal(canonicalAnswer("sponsorship", "US Citizen"), "No");
  assert.equal(canonicalAnswer("veteranStatus", "I am not a veteran"), "No");
  assert.equal(canonicalAnswer("disabilityStatus", "I am not disabled"), "No");
});

test("degree titles reach each portal's degree wording", async () => {
  const site = JSON.parse(
    await readFile("src/engine/config/sites/workday.json", "utf8"),
  );
  const education = site.inputSelectors.find(([k]: [string]) => k === "education")[1][0];
  const degree = education.inputSelectors.find(([k]: [string]) => k === "degree")[1][0];
  assert.ok(degree.path, "Workday's education rows carry a degree rule");
  const pick = (title: string, options: string[]) =>
    matchOption(
      selectorValues(
        "degree",
        degree,
        { ...profile, education: [{ ...profile.education[0], title }] },
        globals,
        { collection: "education", index: 0 },
      ),
      options.map((label) => ({ label, value: label })),
      globals,
    )?.label;
  const workday = ["B.S. - Bachelor of Science", "M.S. - Masters of Science", "Ph.D."];
  assert.equal(pick("Master of Science", workday), "M.S. - Masters of Science");
  assert.equal(pick("Bachelor of Science", workday), "B.S. - Bachelor of Science");
  assert.equal(pick("Doctor of Philosophy", workday), "Ph.D.");
  assert.equal(matchOption(["Master of Science", "MS"], [{ label: "B.S. - Master of Science", value: "wrong" }], globals), undefined);
});

test("web addresses are written in the form portals accept, and GPA comes from the row", () => {
  const withLinks = {
    ...profile,
    linkedin: "linkedin.com/in/alex-rivera",
    github: "github.com/alex",
    website: "alex.example.com/",
  };
  assert.deepEqual(canonicalValues("linkedin", withLinks), [
    "https://www.linkedin.com/in/alex-rivera",
  ]);
  assert.deepEqual(canonicalValues("github", withLinks), ["https://github.com/alex"]);
  assert.deepEqual(canonicalValues("website", withLinks), ["https://alex.example.com"]);
  const withGpa = {
    ...profile,
    education: [{ ...profile.education[0], details: "GPA 3.84, Dean's List" }],
  };
  assert.deepEqual(
    canonicalValues("gpa", withGpa, { collection: "education", index: 0 }),
    ["3.84"],
  );
});

test("source, referral and pay questions take only the applicant's own answers", () => {
  const heard = { ...profile, referralSource: ["Campus career fair"] };
  const fixed = (key: string, value: string | string[], who = heard) =>
    selectorValues(key, { path: ".//input", value }, who, globals);
  assert.deepEqual(fixed("source", ["Other", "External"]), ["Campus career fair"]);
  assert.deepEqual(fixed("source_description", "Job board"), ["Campus career fair"]);
  // Without one there is nothing to say, and nobody referred the applicant.
  assert.deepEqual(fixed("source_description", "Job board", { ...profile, referralSource: [] }), []);
  assert.deepEqual(fixed("referred_by", "Someone"), []);
  assert.deepEqual(fixed("source", ["Other", "Website"], { ...profile, referralSource: [] }), []);
  const saved = { ...heard, answers: [{ question: "How did you hear about us?", answer: "Online job board" }] };
  assert.deepEqual(fixed("source", ["LinkedIn", "Other"], saved), ["Online job board"]);
  assert.deepEqual(fixed("salary", "100000"), []);
});

test("no site rule answers for the applicant with a fixed value", async () => {
  const { readdir } = await import("node:fs/promises");
  // A fixed "value" is an answer nobody gave (a salary, a language, hours):
  // every answer comes from the profile.
  const fixed: string[] = [];
  const walk = (node: unknown, where: string) => {
    if (Array.isArray(node)) node.forEach((child, index) => walk(child, `${where}[${index}]`));
    else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (key === "value") fixed.push(`${where}.value = ${JSON.stringify(child)}`);
        walk(child, `${where}.${key}`);
      }
    }
  };
  const files = (await readdir("src/engine/config/sites")).filter((file) => file.endsWith(".json"));
  assert.ok(files.length > 0);
  for (const file of files) walk(JSON.parse(await readFile(`src/engine/config/sites/${file}`, "utf8")), file);
  assert.deepEqual(fixed, []);
});

test("a work row gives its own address parts and reason for leaving", () => {
  const worked = profileSchema.parse({
    ...profile,
    work: [
      { organization: "Example Labs", title: "Intern", startDate: "2024-06", endDate: "2024-08", location: "Tucson, AZ", details: "", address: "1 Lab Way", county: "Maricopa", postalCode: "48910", reasonForLeaving: "Internship ended" },
      { organization: "Remote Co", title: "Engineer", startDate: "2024-09", endDate: "", location: "Remote", details: "" },
    ],
  });
  const row = (key: string, index: number) => selectorValues(key, { path: ".//input" }, worked, globals, { collection: "experience", index })[0];
  assert.equal(row("address", 0), "1 Lab Way");
  assert.equal(row("city", 0), "Tucson");
  assert.equal(row("state", 0), "AZ");
  assert.equal(row("county", 0), "Maricopa");
  assert.equal(row("postal_code", 0), "48910");
  assert.equal(row("reason_for_leaving", 0), "Internship ended");
  assert.equal(row("location", 0), "Tucson, AZ");
  // Nothing saved: nothing is offered, and never the applicant's home address.
  assert.equal(row("address", 1), undefined);
  assert.equal(row("postal_code", 1), undefined);
  assert.equal(row("reason_for_leaving", 1), undefined);
  assert.equal(row("city", 1), "Remote");
  assert.equal(row("state", 1), undefined);
});

// A report: "How did you find out about this opportunity?" was
// answered with the name of one of the applicant's references.
test("a person saved as a reference is not where the applicant heard of a job", () => {
  const saved = profileSchema.parse({
    ...profile,
    referralSource: ["Jordan Vale", "Company website"],
    references: [{ name: "Jordan Vale", relationship: "Manager", phone: "", email: "jordan@example.test" }],
  });
  assert.deepEqual(canonicalValues("source", saved), ["Company website"]);
  assert.deepEqual(canonicalValues("source", { ...saved, referralSource: ["Jordan Vale"] }), []);
});

test("site rules get the middle name, its initial, and a legal name with it", () => {
  const named = profileSchema.parse({ ...profile, middleName: "Jordan" });
  assert.deepEqual(canonicalValues("middle_name", named), ["Jordan"]);
  assert.deepEqual(canonicalValues("middle_initial", named), ["J"]);
  assert.deepEqual(canonicalValues("legal_name", named), [`${profile.firstName} Jordan ${profile.lastName}`]);
  assert.deepEqual(canonicalValues("full_name", named), [`${profile.firstName} ${profile.lastName}`]);
  assert.deepEqual(canonicalValues("middle_name", profile), []);
});

// one employer's Workday: "M.S. Data Science, Statistics & Engineering
// (Applied Systems)" is in no site's list of fields of study;
// its shorter forms are searched after it.
test("a field of study is also searched without its degree, note and second part", async () => {
  const { fieldOfStudyWordings } = await import("../src/engine/values");
  assert.deepEqual(fieldOfStudyWordings("M.S. Data Science, Statistics & Engineering (Applied Systems)"), [
    "M.S. Data Science, Statistics & Engineering (Applied Systems)",
    "Data Science, Statistics & Engineering",
    "Data Science, Statistics and Engineering",
    "Data Science",
  ]);
  assert.deepEqual(fieldOfStudyWordings("Computer Science"), ["Computer Science"]);
  assert.deepEqual(fieldOfStudyWordings("Bachelor of Science in Electrical Engineering"), ["Bachelor of Science in Electrical Engineering", "Electrical Engineering"]);
});

// one employer's Workday lists none of those: the closest standard
// fields come next, computing first, as the applicant asked.
test("a field of study missing from a list has close standard fields to fall back on", async () => {
  const { relatedFieldsOfStudy } = await import("../src/engine/values");
  const data = relatedFieldsOfStudy("M.S. Data Science, Statistics & Engineering (Applied Systems)");
  // Its own wordings are not repeated; computing comes before statistics.
  assert.ok(!data.includes("Data Science"));
  assert.ok(data.indexOf("Computer and Information Science") < data.indexOf("Statistics"));
  assert.deepEqual(relatedFieldsOfStudy("Computer Science").slice(0, 2), ["Computer and Information Science", "Computer Science and Engineering"]);
  // A field with no close standard family has none: it stays the applicant's.
  assert.deepEqual(relatedFieldsOfStudy("Art History"), []);
});

test("every site's graduated question is answered Yes or No from the row's end date", async () => {
  const { readdir } = await import("node:fs/promises");
  // one employer's Avature asks "Did you graduate?" for each school; its rule (and
  // iCIMS') answered with the graduation year, which no Yes/No list holds
  //. A degree ending ahead is not yet earned.
  const schooled = profileSchema.parse({
    ...profile,
    education: [
      { ...profile.education[0], endDate: "2099-05" },
      { ...profile.education[0], organization: "Second College", endDate: "2019-05" },
    ],
  });
  let checked = 0;
  const walk = (node: unknown, key: string, file: string) => {
    if (Array.isArray(node)) {
      const pair = node.length === 2 && typeof node[0] === "string" && Array.isArray(node[1]);
      for (const child of node) walk(child, pair ? (node[0] as string) : key, file);
    } else if (node && typeof node === "object") {
      const selector = node as Record<string, unknown>;
      // Checkboxes and fixed values say Yes their own way.
      const listed = !("value" in selector) && !("values" in selector) && !["click", "selectCheckboxOrRadio"].includes(String(selector.method));
      if (key === "graduated" && "path" in selector && listed) {
        checked++;
        const answer = (index: number) =>
          selectorValues(key, selector as never, schooled, globals, { collection: "education", index })[0];
        assert.equal(answer(0), "No", `${file}: ${JSON.stringify(selector.valueKey)}`);
        assert.equal(answer(1), "Yes", `${file}: ${JSON.stringify(selector.valueKey)}`);
      }
      for (const child of Object.values(selector)) walk(child, key, file);
    }
  };
  for (const file of await readdir("src/engine/config/sites"))
    walk(JSON.parse(await readFile(`src/engine/config/sites/${file}`, "utf8")).inputSelectors, "", file);
  assert.ok(checked >= 1, `only ${checked} graduated rules were found`);
});

test("a row's dates are written with dashes for month and date inputs", () => {
  // Avature's job rows (and nine other sites' rules) name these keys; they
  // had no value, so one employer's start and end months were left to a guess.
  const worked = { ...profile, work: [{ organization: "Sample AI", title: "Intern", location: "", details: "", startDate: "2023-07-03", endDate: "2023-09" }] };
  const at = (key: string) => canonicalValues(key, worked, { collection: "experience", index: 0 });
  assert.deepEqual(at("start_date_dashes_YYYYMM"), ["2023-07"]);
  assert.deepEqual(at("start_date_dashes_YYYYMMDD"), ["2023-07-03"]);
  assert.deepEqual(at("end_date_dashes_YYYYMM"), ["2023-09"]);
  assert.deepEqual(at("end_date_dashes_YYYYMMDD"), ["2023-09-01"]);
  // A current job has no end to write.
  assert.deepEqual(canonicalValues("end_date_dashes_YYYYMM", { ...worked, work: [{ ...worked.work[0], endDate: "" }] }, { collection: "experience", index: 0 }), []);
});

// Ashby listed "Pennsylvania State University" for the school saved
// as "Pennsylvania State University, University Park", and no
// spelling tried matched it. The name before
// the campus is tried after the full name.
test("a school saved with its campus is also tried by its name alone, after the full name", () => {
  const schooled = profileSchema.parse({
    ...profile,
    education: [{ organization: "Pennsylvania State University, University Park", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15", location: "", details: "" }],
  });
  const values = selectorValues("school", { path: "." }, schooled, globals, { collection: "education", index: 0 });
  assert.equal(values[0], "Pennsylvania State University, University Park");
  assert.ok(values.indexOf("Pennsylvania State University") > 0);
  assert.ok(values.indexOf("Pennsylvania State University") < 4);
});

// Real school lists name a school by its official name, its common one,
// with "The" or "Main Campus", or by campus; the profile holds one of them.
test("a school is also tried by its other whole names, never by a sibling's", () => {
  const school = (organization: string, location = "") =>
    selectorValues("school", { path: "." }, profileSchema.parse({
      ...profile,
      education: [{ organization, title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location, details: "" }],
    }), globals, { collection: "education", index: 0 });
  const options = [
    "Central Michigan University", "Michigan State University - East Lansing", "Michigan State University College of Law",
    "The Ohio State University", "Ohio University", "Pennsylvania State University-Main Campus", "Pennsylvania State University-Penn State Harrisburg",
    "University of Virginia", "Virginia Polytechnic Institute and State University", "Virginia State University", "Virginia Tech Carilion School of Medicine",
  ].map((label) => ({ label, value: label }));
  const pick = (organization: string, location = "") => matchOption(school(organization, location), options, globals)?.label;
  assert.equal(school("Virginia Tech")[0], "Virginia Tech");
  assert.equal(pick("Virginia Tech"), "Virginia Polytechnic Institute and State University");
  assert.equal(pick("Ohio State University"), "The Ohio State University");
  assert.equal(pick("Penn State"), "Pennsylvania State University-Main Campus");
  assert.equal(pick("Michigan State University", "East Lansing, MI"), "Michigan State University - East Lansing");
  // Not its campus, nor a school that only shares its words.
  assert.equal(pick("Michigan State University"), undefined);
  assert.equal(pick("Virginia Commonwealth University"), undefined);
  assert.equal(pick("MSU"), undefined);
});

test("a stripped job description holds no semicolon, which SmartRecruiters refuses", () => {
  // one employer's SmartRecruiters form: "This field cannot contain
  // following characters: ;" under the experience Description.
  const worked = { ...profile, work: [{ organization: "Pixelforge", title: "Founder", location: "", startDate: "2025-03", endDate: "", details: "Built the platform; shipped via CI/CD ; added OAuth." }] };
  assert.deepEqual(canonicalValues("description_stripped", worked, { collection: "experience", index: 0 }), ["Built the platform, shipped via CI/CD, added OAuth."]);
  assert.deepEqual(canonicalValues("description", worked, { collection: "experience", index: 0 }), ["Built the platform; shipped via CI/CD ; added OAuth."]);
});

test("a phone's type is offered in the wordings lists use, personal first", () => {
  // one employer's Workday: "Business Mobile" and
  // "Personal Mobile" listed, and "Mobile" picked neither.
  const values = canonicalValues("phone_type", { ...profile, phoneDeviceType: "Mobile" });
  assert.equal(values[0], "Mobile");
  assert.ok(values.indexOf("Personal Mobile") > 0);
  // one employer's Workday lists only "Home" and "Home Cellular".
  assert.ok(values.includes("Home Cellular"));
  assert.ok(!values.includes("Home"));
  assert.ok(!values.includes("Business Mobile"));
});

// one employer's SuccessFactors Veteran Status:
// "No" took the list's "No Selection" by its first word, and its own
// "Not Protected Veteran (OFCCP)" matched none of the wordings tried.
test("a veteran list's OFCCP wording is matched, and No Selection never is", () => {
  const options = ["No Selection", "Not Protected Veteran (OFCCP)", "Prefer Not To Answer (OFCCP)", "Protected Veteran (OFCCP)"]
    .map((label) => ({ label, value: label }));
  const never = selectorValues("veteran", { path: ["x"] } as never, profileSchema.parse({ ...profile, veteranStatus: "I am not a veteran" }), globals);
  assert.equal(matchOption(never, options, globals)?.label, "Not Protected Veteran (OFCCP)");
  assert.equal(matchOption(["No"], options, globals), undefined);
  assert.equal(matchOption(["No"], [{ label: "No Selection", value: "" }, { label: "No", value: "n" }], globals)?.label, "No");
});
