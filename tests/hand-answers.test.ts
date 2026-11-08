import { test } from "node:test";
import assert from "node:assert/strict";
import { keptHandAnswer } from "../src/shared/hand-answers";

const kept = (label: string, value: string, extra: { kind?: string; section?: string } = {}) =>
  keptHandAnswer({ label, value, ...extra });

test("keeps a real question answered with what the applicant saw", () => {
  assert.equal(kept("How did you hear about this internship?", "Company Website"), true);
  assert.equal(kept("Can you provide an official or unofficial educational transcript?", "Yes"), true);
  assert.equal(kept("Which location are you applying for?", "Foster City, CA"), true);
  assert.equal(kept("What did you score on your SAT?", "SAT: 1460"), true);
});

test("drops a list's hidden option value", () => {
  assert.equal(kept("Which location are you applying for?", "65f5e6fd-0ec6-423a-bc28-401ef04b6d76"), false);
  assert.equal(kept("How many months are you available for an internship?", "7_months_or_more"), false);
  assert.equal(kept("Pick one", "a3f9c2e17b4d8e60"), false);
});

test("drops a calendar heading read as a label", () => {
  assert.equal(kept("November 2026", "No"), false);
  assert.equal(kept("2026", "Yes"), false);
  assert.equal(kept("Sept 12 2026", "Yes"), false);
  // A question that only mentions a month is still a question.
  assert.equal(kept("Are you available in November 2026?", "No"), true);
});

test("drops a phone number's country code picker", () => {
  assert.equal(kept("Search by country/region or code", "+1"), false);
  assert.equal(kept("Country code", "United States (+1)"), false);
  assert.equal(kept("Dialing code", "US"), false);
  assert.equal(kept("Country of residence", "United States"), true);
});

test("keeps the earlier exclusions", () => {
  assert.equal(kept("Why this team?", "Because", { kind: "textarea" }), false);
  assert.equal(kept("Company", "Acme", { section: "Work Experience" }), false);
  assert.equal(kept("Email", "a@example.com"), false);
  assert.equal(kept("Unlabelled field", "x"), false);
  assert.equal(kept("Anything", "x".repeat(121)), false);
});
