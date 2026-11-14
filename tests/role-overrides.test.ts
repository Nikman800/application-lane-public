import { test } from "node:test";
import assert from "node:assert/strict";
import { forRole, overrideFor, profileSchema } from "../src/shared/model";
import { proposals } from "../src/shared/matching";

// Different values for some kinds of job: an applicant who stays
// enrolled a term longer for internships gives those a later graduation date
// ("If you are a current university student, please provide your anticipated
// graduation date?" was given the full-time date on an internship).
const applicant = profileSchema.parse({
  confirmed: true, firstName: "Alex", lastName: "Rivera", email: "alex@example.test", facts: [],
  education: [
    { organization: "Michigan State University", title: "Master of Science", startDate: "2025-08", endDate: "2099-05-10", location: "", details: "" },
    { organization: "Penn State", title: "Bachelor of Science", startDate: "2020-09", endDate: "2024-06-15", location: "", details: "" },
  ],
  roleOverrides: [{ name: "Internships & co-ops", titleWords: ["intern", "internship", "co-op"], education: [{ index: 0, endDate: "2099-12-13" }] }],
});

test("a job's title selects its type's values, by whole words", () => {
  assert.equal(overrideFor(applicant.roleOverrides, "Software Engineer Intern - Summer 2027")?.name, "Internships & co-ops");
  assert.equal(overrideFor(applicant.roleOverrides, "Co-op, Data Science")?.name, "Internships & co-ops");
  // A plural title is the same kind of job.
  assert.equal(overrideFor(applicant.roleOverrides, "Software Engineering Internships – Summer 2027")?.name, "Internships & co-ops");
  assert.equal(overrideFor(applicant.roleOverrides, "International Sales Engineer"), undefined);
  assert.equal(overrideFor(applicant.roleOverrides, "Software Engineer, New Grad"), undefined);
});

test("an internship's graduation questions take its type's end date, other jobs the profile's", () => {
  const question = { id: "x", label: "If you are a current university student, please provide your anticipated graduation date?", kind: "datepicker", required: false, value: "", options: [], revision: 1, protected: false };
  const intern = forRole(applicant, "Data Science Intern");
  assert.equal(intern.education[0].endDate, "2099-12-13");
  assert.equal(intern.education[1].endDate, "2024-06-15");
  assert.equal(proposals([question], intern)[0]?.value, "2099-12-13");
  const fullTime = forRole(applicant, "Data Scientist I");
  assert.equal(fullTime.education[0].endDate, "2099-05-10");
  assert.equal(proposals([question], fullTime)[0]?.value, "2099-05-10");
});
