import assert from "node:assert/strict";
import { test } from "node:test";
import { legalQuestion } from "../src/shared/questions";

test("legal and eligibility questions are told apart from ordinary ones", () => {
  for (const label of [
    "Have you ever been convicted of a felony?",
    "Do you currently hold an active security clearance?",
    "Do you have any relatives currently working at Precisely?",
    "If you answered yes to having a relative/relatives that currently work at Precisely, please provide details",
    "Are you subject to a non-compete agreement?",
    "Have you ever been terminated or asked to resign from a position?",
    "This position is subject to export control regulations (ITAR). Are you a U.S. person?",
    "Are you a current or former government employee?",
    "Do you consent to a background check?",
    "Are you related to anyone who works at Acme?",
    "Are you related to any current employees?",
  ])
    assert.equal(legalQuestion(label), true, label);
  for (const label of [
    "How many years of Python experience do you have?",
    "What is your expected graduation date?",
    "Are you willing to relocate?",
    "How did you hear about us?",
    "Which best describes your hands-on experience building AI-powered applications?",
    "Describe a partner team you worked with.",
    "What discipline are you studying?",
    "Describe a time you terminated a project that was not working.",
    "Do you have experience in a multi-disciplinary team?",
    "LinkedIn Profile",
    // Paylocity (Space Tango, report 44f8f45f, 2026-10-14): "related to this
    // role" is no relative; the question was neither drafted nor explained.
    "How many years of work experience do you have directly related to this role?",
    "Describe work you have done related to distributed systems.",
  ])
    assert.equal(legalQuestion(label), false, label);
});

// L3Harris (report 9a11d03e, 2026-10-15): "Have you worked for a government
// entity…" was left though the applicant saved "Never a government employee
// or public official".
test("a saved never-in-government statement answers a government-employment question", async () => {
  const { profileSchema } = await import("../src/shared/model");
  const { proposals } = await import("../src/shared/matching");
  const ask = (label: string, government = "Never a government employee or public official") =>
    proposals(
      [{ id: "x", label, kind: "combobox", required: true, value: "", options: [], revision: 1, protected: false }],
      profileSchema.parse({ firstName: "A", lastName: "B", email: "a@example.test", confirmed: true, facts: [], legal: { government } }),
    )[0]?.value;
  assert.equal(ask("Have you worked for a government entity currently or in the past?"), "No");
  assert.equal(ask("Have you ever been employed by a government agency?"), "No");
  // Military service, relatives, or a statement that is not a plain never: not this one's to say.
  assert.equal(ask("Are you currently a US government employee or have you been in the past? (This includes military service)"), undefined);
  assert.equal(ask("Do you have relatives who work for a government agency?"), undefined);
  assert.equal(ask("Have you worked for a government entity currently or in the past?", "Worked at a state agency in 2021"), undefined);
});

// L3Harris, report ed248429 (2026-10-15): "Are you eligible to obtain a U.S.
// security clearance?" was left to the site, whose stored "No" stood. A U.S.
// citizen with no convictions, by the saved details, is.
test("a citizen with no convictions is eligible to obtain a security clearance", async () => {
  const { profileSchema } = await import("../src/shared/model");
  const { proposals } = await import("../src/shared/matching");
  const ask = (label: string, workAuthorization = "US Citizen", criminal = "No convictions and no pending charges") =>
    proposals(
      [{ id: "x", label, kind: "radio", required: false, value: "", options: ["Yes", "No"], revision: 1, protected: false }],
      profileSchema.parse({ firstName: "A", lastName: "B", email: "a@example.test", confirmed: true, facts: [], workAuthorization, legal: { criminal } }),
    )[0]?.value;
  const eligible = "Are you eligible to obtain a U.S. security clearance? This is typically based on having U.S. citizenship and successful completion and disposition of an extensive background investigation.";
  assert.equal(ask(eligible), "Yes");
  // Not a citizen, or a conviction on record: not this one's to say.
  assert.equal(ask(eligible, "Green card holder"), undefined);
  assert.equal(ask(eligible, "US Citizen", "One misdemeanor conviction in 2019"), undefined);
  // Holding one is another question.
  assert.equal(ask("Have you ever been granted a security clearance?"), undefined);
  // Nor, by the same details, does anything known stand in the way of one;
  // with a conviction on record that is not this one's to say.
  assert.equal(ask("Are you aware of anything that may prevent you from obtaining a government security clearance?"), "No");
  assert.equal(ask("Are you aware of anything that may prevent you from obtaining a government security clearance?", "US Citizen", "One misdemeanor conviction in 2019"), undefined);
});

// Report 17ac6723 (2026-10-15): preferences.md's "Do you hold an active
// security clearance? No" was taken as the answer to every question naming a
// security clearance, eligibility to obtain one included.
test("a saved answer about holding a clearance does not answer whether one could be obtained", async () => {
  const { profileSchema } = await import("../src/shared/model");
  const { proposals } = await import("../src/shared/matching");
  const applicant = profileSchema.parse({
    firstName: "A", lastName: "B", email: "a@example.test", confirmed: true, facts: [],
    workAuthorization: "US Citizen",
    legal: { criminal: "No convictions and no pending charges" },
    answers: [{ question: "Do you hold an active security clearance?", answer: "No" }],
  });
  const ask = (label: string) =>
    proposals([{ id: "x", label, kind: "radio", required: false, value: "", options: ["Yes", "No"], revision: 1, protected: false }], applicant)[0]?.value;
  assert.equal(ask("Are you eligible to obtain a U.S. security clearance? This is typically based on having U.S. citizenship and successful completion and disposition of an extensive background investigation."), "Yes");
  assert.equal(ask("Do you currently have an active security clearance?"), "No");
  // (What might prevent one is answered from the legal details, not the saved held-clearance answer.)
  assert.equal(ask("Are you aware of anything that may prevent you from obtaining a government security clearance?"), "No");
});
