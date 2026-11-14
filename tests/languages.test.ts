import { test } from "node:test";
import assert from "node:assert/strict";
import { isFluent, levelChoices, parseLanguage } from "../src/shared/languages";

// The applicant asked for languages in the profile (Workday): one line each, with one level for every skill.
test("a language line gives its name and one level", () => {
  assert.deepEqual(parseLanguage("English: Native"), { language: "English", level: "native" });
  assert.deepEqual(parseLanguage("Hindi - Fluent"), { language: "Hindi", level: "fluent" });
  assert.deepEqual(parseLanguage("Spanish (basic)"), { language: "Spanish", level: "basic" });
  assert.deepEqual(parseLanguage("Haitian-Creole: conversational"), { language: "Haitian-Creole", level: "intermediate" });
  assert.deepEqual(parseLanguage("Marathi"), { language: "Marathi", level: "" });
  assert.equal(isFluent({ language: "English", level: "native" }), true);
  assert.equal(isFluent({ language: "Spanish", level: "basic" }), false);
  assert.equal(levelChoices("native")[0], "Native");
});

test("a languages text box gets each language with how well", async () => {
  const { profileSchema } = await import("../src/shared/model");
  const { proposals } = await import("../src/shared/matching");
  const applicant = profileSchema.parse({ firstName: "A", lastName: "B", email: "a@example.test", confirmed: true, facts: [], languages: ["English: Native", "Hindi: Fluent"] });
  const ask = (label: string) => proposals([{ id: "x", label, kind: "text", required: false, value: "", options: [], revision: 1, protected: false }], applicant)[0]?.value;
  assert.equal(ask("What languages do you speak?"), "English (Native), Hindi (Fluent)");
  assert.equal(ask("Languages"), "English (Native), Hindi (Fluent)");
});

// one employer's Ashby form: "What languages are
// you fluent in?" as radios of languages was left.
test("a list of languages asked as fluency gets the applicant's fluent ones", async () => {
  const { profileSchema } = await import("../src/shared/model");
  const { proposals } = await import("../src/shared/matching");
  const applicant = profileSchema.parse({ firstName: "A", lastName: "B", email: "a@example.test", confirmed: true, facts: [], languages: ["English: Native", "Spanish: Basic"] });
  const options = ["English", "Thai", "Mandarin", "Korean", "German", "Ukranian", "French", "Spanish"];
  const ask = (label: string, kind = "radio", extra: object = {}) =>
    proposals([{ id: "x", label, kind, required: true, value: "", options, revision: 1, protected: false, ...extra }], applicant)[0]?.value;
  assert.equal(ask("What languages are you fluent in?"), "English");
  assert.equal(ask("What languages are you fluent in?", "select"), "English");
  // Asked only what they speak, a basic language counts too.
  const box = (language: string, question: string) => ask(`${question}: ${language}`, "checkbox", { question, options: ["Yes", "No"] });
  assert.equal(box("English", "What languages are you fluent in?"), "Yes");
  assert.equal(box("Spanish", "What languages are you fluent in?"), undefined);
  assert.equal(box("Spanish", "Which languages do you speak?"), "Yes");
  // None of the applicant's languages listed: left.
  assert.equal(proposals([{ id: "x", label: "What languages are you fluent in?", kind: "radio", required: true, value: "", options: ["Thai", "Korean"], revision: 1, protected: false }], applicant)[0]?.value, undefined);
});

// one employer's Workday form: a language row's
// Comprehension, Overall, Reading, Speaking and Writing were left, and its
// numbered scale runs "1 - Beginner" to "5 - Fluent".
test("a language row's skills take that language's level, in the list's own words", async () => {
  const { profileSchema } = await import("../src/shared/model");
  const { proposals } = await import("../src/shared/matching");
  const applicant = profileSchema.parse({ firstName: "A", lastName: "B", email: "a@example.test", confirmed: true, facts: [], languages: ["English: Native", "Spanish: Basic"] });
  const scale = ["Select One", "1 - Beginner", "2 - Classroom Study", "3 - Intermediate", "4 - Advanced", "5 - Fluent"];
  const ask = (label: string, index: number, kind = "select", options = scale) =>
    proposals([{ id: "x", label, kind, required: false, value: "", options, revision: 1, protected: false, section: "Languages", index }], applicant)[0]?.value;
  assert.equal(ask("Comprehension", 0), "5 - Fluent");
  assert.equal(ask("Writing", 1), "1 - Beginner");
  assert.equal(ask("I am fluent in this language.", 0, "checkbox", ["Yes", "No"]), "Yes");
  // A box already clear says No by itself.
  assert.equal(ask("I am fluent in this language.", 1, "checkbox", ["Yes", "No"]), undefined);
  // one employer's Workday rates each skill Average, Excellent or Not Qualified
  //: every skill was left.
  const rated = ["Select One", "Average", "Excellent", "Not Qualified"];
  for (const skill of ["Listening", "Overall", "Reading", "Speaking", "Writing"])
    assert.equal(ask(skill, 0, "select", rated), "Excellent", skill);
  // A basic speaker is neither; that is the applicant's to choose.
  assert.equal(ask("Reading", 1, "select", rated), undefined);
  assert.ok(levelChoices("native").includes("Excellent"));
  // ICE's iCIMS rates each skill Proficient, Medium or Basic: a native speaker is Proficient.
  for (const skill of ["Reading", "Writing", "Speaking"])
    assert.equal(ask(skill, 0, "select", ["Proficient", "Medium", "Basic"]), "Proficient", skill);
  assert.equal(ask("Reading", 1, "select", ["Proficient", "Medium", "Basic"]), "Basic");
  // Rockwell Automation's Workday scale stops at "4 - Fluent": Reading, Speaking and Writing were left.
  const four = ["1 - Beginner", "2 - Intermediate", "3 - Advanced", "4 - Fluent"];
  for (const skill of ["Reading", "Speaking", "Writing"]) {
    assert.equal(ask(skill, 0, "combobox", four), "4 - Fluent", skill);
    assert.equal(ask(skill, 1, "combobox", four), "1 - Beginner", skill);
  }
});

// one employer's Workday form names a language's
// overall level "All", beside Reading, Speaking and Writing; it was left.
test("a language row's All takes that language's level", async () => {
  const { profileSchema } = await import("../src/shared/model");
  const { proposals } = await import("../src/shared/matching");
  const applicant = profileSchema.parse({ firstName: "A", lastName: "B", email: "a@example.test", confirmed: true, facts: [], languages: ["English: Native"] });
  const field = { id: "x", label: "All", kind: "select", required: true, value: "", options: ["Select One", "Beginner", "Intermediate", "Expert"], revision: 1, protected: false, section: "Languages", index: 0 };
  assert.equal(proposals([field], applicant)[0]?.value, "Expert");
});

// PACCAR's SuccessFactors: a "Language Skills"
// row of Language, Speak, Read and Write, and an education row's "Result",
// were left.
test("a SuccessFactors Language Skills row and an education Result are answered", async () => {
  const { profileSchema } = await import("../src/shared/model");
  const { proposals } = await import("../src/shared/matching");
  const applicant = profileSchema.parse({ firstName: "A", lastName: "B", email: "a@example.test", confirmed: true, facts: [], languages: ["English: Native"],
    education: [
      { organization: "Michigan State University", title: "Master of Science", startDate: "2025-08", endDate: "2099-05", location: "", details: "" },
      { organization: "Penn State", title: "Bachelor of Science", startDate: "2020-09", endDate: "2024-06", location: "", details: "" },
    ] });
  const ask = (label: string, section: string, index = 0) =>
    proposals([{ id: "x", label, kind: "combobox", required: true, value: "", options: [], revision: 1, protected: false, section, index }], applicant)[0];
  assert.equal(ask("Language", "Language Skills")?.value, "English");
  assert.equal(ask("Speak", "Language Skills")?.value, "Native");
  assert.ok(ask("Write", "Language Skills")?.choices?.includes("Fluent"));
  assert.ok(ask("Result", "Formal Education", 0)?.choices?.includes("In Progress"));
  assert.ok(ask("Result", "Formal Education", 1)?.choices?.includes("Graduated"));
});
