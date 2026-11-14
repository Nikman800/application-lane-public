import assert from "node:assert/strict";
import { test } from "node:test";
import { askedCountry } from "../src/shared/authorization";

// one employer's SmartRecruiters question: "the U.S.
// and Puerto Rico" is one authorization, not two countries.
test("a United States territory named beside the United States asks about the United States", () => {
  assert.equal(askedCountry("Are you legally authorized to work in the U.S. and Puerto Rico?"), "US");
  assert.equal(askedCountry("Are you legally authorized to work in the United States?"), "US");
  // Two countries still name no single one.
  assert.equal(askedCountry("Are you legally authorized to work in the United States and Canada?"), undefined);
});
