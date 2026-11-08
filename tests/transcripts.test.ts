import assert from "node:assert/strict";
import { test } from "node:test";
import { askedLevel, degreeLevel, pickTranscript } from "../src/shared/transcripts";
import { profileSchema, type Artifact } from "../src/shared/model";

const profile = profileSchema.parse({
  confirmed: true,
  firstName: "Alex",
  lastName: "Rivera",
  email: "alex@example.test",
  facts: [],
  work: [],
  education: [
    { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05", location: "", details: "", transcript: "MSU.pdf" },
    { organization: "Penn State", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "", details: "", transcript: "PSU.pdf" },
  ],
});
const artifact = (name: string, tags: Partial<Artifact> = {}): Artifact => ({
  id: name, kind: "transcript", format: "pdf", name, mime: "application/pdf", applicationId: "a", operation: 1, ...tags,
});

test("a degree's level is read from its title, and a field's from its question", () => {
  assert.equal(degreeLevel("Bachelor of Science"), "undergraduate");
  assert.equal(degreeLevel("Bachelors of Science"), "undergraduate");
  assert.equal(degreeLevel("Master of Science"), "graduate");
  assert.equal(degreeLevel("Masters of Science"), "graduate");
  assert.equal(degreeLevel("Ph.D. in Physics"), "graduate");
  assert.equal(askedLevel("Please provide a recent transcript of your undergraduate studies."), "undergraduate");
  assert.equal(askedLevel("Please provide a recent transcript of your graduate studies (if applicable)"), "graduate");
  assert.equal(askedLevel("Unofficial Transcript (no SSN)"), undefined);
});

// Databricks' Greenhouse form (2026-11-08): the graduate transcript, the
// only file there was, went into the box asking for the undergraduate one.
test("each degree's field gets that degree's transcript, and a plain one the most recent", () => {
  const tagged = [artifact("MSU.pdf", { education: 0, level: "graduate" }), artifact("PSU.pdf", { education: 1, level: "undergraduate" })];
  assert.equal(pickTranscript("Undergraduate transcript", tagged, profile).artifact?.name, "PSU.pdf");
  assert.equal(pickTranscript("Graduate transcript", tagged, profile).artifact?.name, "MSU.pdf");
  assert.equal(pickTranscript("Transcript", tagged, profile).artifact?.name, "MSU.pdf");
  // Only the master's attached: the undergraduate field is left, not given it.
  assert.deepEqual(pickTranscript("Undergraduate transcript", [tagged[0]], profile), { missing: "undergraduate" });
});

test("with one untagged transcript, a field naming another degree than the latest is left", () => {
  const only = [artifact("Newest.pdf")];
  assert.equal(pickTranscript("Transcript", only, profile).artifact?.name, "Newest.pdf");
  assert.equal(pickTranscript("Graduate transcript", only, profile).artifact?.name, "Newest.pdf");
  assert.deepEqual(pickTranscript("Undergraduate transcript", only, profile), { missing: "undergraduate" });
  assert.deepEqual(pickTranscript("Transcript", [], profile), {});
});
