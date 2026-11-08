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
