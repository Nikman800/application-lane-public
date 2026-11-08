import { test } from "node:test";
import assert from "node:assert/strict";
import { structuredFallbackField } from "../src/shared/questions";
import type { Field } from "../src/shared/model";

const field = (label: string, overrides: Partial<Field> = {}): Field => ({
  id: "x",
  label,
  kind: "text",
  required: false,
  value: "",
  options: [],
  revision: 1,
  protected: false,
  ...overrides,
});

// SuccessFactors (WEC Energy Group, report 7810d2d5, 2026-10-15): told only
// "End Date" under "Previous employment", the model gave a job still held
// another job's end date. A row's dates are the profile's alone.
test("a job's or school's dates are never left to the model", () => {
  assert.equal(structuredFallbackField(field("End Date", { section: "Previous employment", index: 1 })), false);
  assert.equal(structuredFallbackField(field("From Date", { section: "Formal education" })), false);
  assert.equal(structuredFallbackField(field("Start month", { section: "Work Experience 2" })), false);
  // Elsewhere, and other fields in a row, are still the model's to suggest.
  assert.equal(structuredFallbackField(field("Reason For Leaving", { section: "Previous employment" })), true);
  assert.equal(structuredFallbackField(field("Registration Source", { section: "Profile information" })), true);
  // (And "Degree Conferred" is a date the model can only guess at.)
  assert.equal(structuredFallbackField(field("Degree Conferred", { section: "Education" })), false);
  // A box that adds one skill per search gets none typed as a list (Jabil, 2026-10-16).
  assert.equal(structuredFallbackField(field("Type to Add Skills", { section: "Skills" })), false);
});

// Workday (Cisco, report e63ffa89, 2026-10-17): the profile gave one school's
// GPA and left another's out on purpose; the model put the first school's GPA
// on the second. A grade is the profile's, school by school.
test("a school's GPA is never left to the model", () => {
  assert.equal(structuredFallbackField(field("Overall Result (GPA)", { section: "Education", index: 1 })), false);
  assert.equal(structuredFallbackField(field("Cumulative Grade Point Average", { section: "Education" })), false);
  assert.equal(structuredFallbackField(field("Field of Study", { section: "Education", index: 1 })), true);
});

// Leidos's Workday (report bb699b7d, 2026-11-08): each question's section is
// the question itself, and a long question naming "employment" and "Year"
// was kept from the fallback as a job's date.
test("a long question whose own text is its section is not taken for an entry's date", () => {
  const asked = "2. Section 847 of the National Defense Authorization Act for Fiscal Year 2008 requires certain current and former DoD officials or employees to seek a written ethics opinion regarding post-employment restrictions. Do you now, or did you at any time in the past 24 months, serve as an official or employee of the DoD?";
  assert.equal(structuredFallbackField(field(asked, { section: asked, kind: "combobox" }), true), true);
  // An entry's own date is still kept out.
  assert.equal(structuredFallbackField(field("End Date", { section: "Previous employment", index: 1 })), false);
});
