import { test } from "node:test";
import assert from "node:assert/strict";
import { namesNoDuration } from "../src/server/generation";

// SuccessFactors: "How many years of experience
// do you have in a directly related technical field…" was answered with the
// nearest other experience alone, the "0 years" sentence taken out by the
// check. An answer to a how-many-years question names a duration or is left.
test("a how-many-years question is answered only by a duration", () => {
  const question = "How many years of experience do you have in a directly related technical field: such as gas distribution operations?";
  assert.equal(namesNoDuration(question, "My nearest experience is satellite image processing and 2D-to-3D reconstruction."), true);
  for (const answer of ["2 years.", "I have 0 years of directly related experience.", "Less than a year.", "None.", "I have no direct experience in that field.", "Three years, at a utility."])
    assert.equal(namesNoDuration(question, answer), false, answer);
  // an employer asks for the count without "how many".
  for (const asked of ["Please input the total years of experience you have that are relevant for this role.", "Number of years of professional experience", "Years of relevant experience you have?"]) {
    assert.equal(namesNoDuration(asked, "Plus project and coursework experience"), true, asked);
    assert.equal(namesNoDuration(asked, "Under 2 years: Pixelforge since March 2025 and a 3-month internship."), false, asked);
  }
  // Any other question is not held to a count.
  assert.equal(namesNoDuration("Describe your experience with gas distribution.", "My nearest experience is satellite imaging."), false);
});
