import { test } from "node:test";
import assert from "node:assert/strict";
import { profileSchema } from "../src/shared/model";
import {
  conflictWarning,
  graduationFor,
  graduationRule,
  internshipRole,
  markdownEntries,
  profileConflicts,
  withGraduation,
} from "../src/server/profile-sync";

// preferences.md and profile.md as the job-applier checkout writes them.
const preferences = `## Education timeline (confirmed)
- **Graduation:** December 13, 2027 (end of Fall 2027, he stays enrolled through the Fall
  term).
## Logistics (confirmed)
- **Work authorization:** U.S. citizen. No visa sponsorship needed, now or ever.
- **Requires visa sponsorship (now or in future)?** No.
- **Relocation:** Yes, open to relocating anywhere.
- **Veteran / military status:** No (not a veteran, reservist, or military spouse).
- **Home base:** Tucson, AZ.`;
const masterProfile = "## Education\n- **Michigan State University** — M.S., expected December 13, 2027. GPA 3.84.";

const profile = (overrides: object = {}) =>
  profileSchema.parse({
    firstName: "Alex",
    lastName: "Fixture",
    email: "t@example.test",
    confirmed: true,
    facts: [],
    city: "Tucson",
    state: "Arizona",
    gpa: "3.84",
    workAuthorization: "Yes",
    sponsorship: "No",
    willingToRelocate: "Yes",
    veteranStatus: "I am not a protected veteran",
    education: [
      { organization: "Penn State", title: "B.S.", startDate: "2020-09", endDate: "2024-06" },
      { organization: "Michigan State University", title: "M.S.", startDate: "2025-08", endDate: "2027-12" },
    ],
    ...overrides,
  });

test("markdown entries read bold labels, question labels and wrapped lines", () => {
  const entries = markdownEntries(preferences);
  assert.equal(entries.get("requires visa sponsorship (now or in future)"), "No.");
  assert.match(entries.get("graduation")!, /December 13, 2027 .*term\)\.$/);
});

test("matching answers written differently are not disagreements", () => {
  // "U.S. citizen" reads as authorized, "No (not a veteran…)" as No.
  assert.deepEqual(profileConflicts(profile(), { preferences, profile: masterProfile }), []);
  // An answer missing on one side is not a contradiction either.
  assert.deepEqual(profileConflicts(profile({ sponsorship: "", gpa: "" }), { preferences, profile: masterProfile }), []);
});

test("each real disagreement is named with both values and the file", () => {
  const conflicts = profileConflicts(
    profile({
      sponsorship: "Yes",
      willingToRelocate: "No",
      city: "Seattle",
      gpa: "3.6",
      education: [{ organization: "Michigan State University", title: "M.S.", startDate: "2025-08", endDate: "2027-05" }],
    }),
    { preferences, profile: masterProfile },
  );
  assert.deepEqual(
    conflicts.map((c) => [c.field, c.extension, c.file]),
    [
      ["Visa sponsorship", "Yes", "preferences.md"],
      ["Relocation", "No", "preferences.md"],
      ["Home city", "Seattle, Arizona", "preferences.md"],
      ["Graduation", "2027-05", "preferences.md"],
      ["GPA", "3.6", "profile.md"],
    ],
  );
  assert.match(conflictWarning(conflicts)[0], /disagree.*Visa sponsorship \(extension: Yes; preferences.md: No\.\)/);
  assert.deepEqual(conflictWarning([]), []);
});

test("graduation by role: internships and full-time roles state their own date", async () => {
  const rule = graduationRule(
    "## Education timeline\n- **Graduation by role:** internships and co-ops: December 13, 2027. Full-time and new-grad roles: May 10, 2027.",
  );
  assert.deepEqual(rule, { internship: "2027-12", fullTime: "2027-05" });
  assert.equal(internshipRole("Software Engineer Intern (Summer 2027)"), true);
  assert.equal(internshipRole("Co-op, Data Engineering"), true);
  assert.equal(internshipRole("Internal Tools Engineer"), false);
  // Banks name internships after the season (Bank of America, 2026-10-04).
  assert.equal(graduationFor(rule, "Global Technology Summer Analyst 2027 - Software Engineer and Mainframe Analyst"), "2027-12");
  assert.equal(internshipRole("Investment Banking Summer Associate"), true);
  assert.equal(internshipRole("Analyst, Summer Reading Program Technology"), false);
  assert.equal(graduationFor(rule, "Software Engineer, New Grad"), "2027-05");
  // Only the degree still in progress moves; a same-month date keeps its day.
  const base = profile({ education: [
    { organization: "Penn State", title: "B.S.", startDate: "2020-09", endDate: "2024-06-15" },
    { organization: "MSU", title: "M.S.", startDate: "2025-08", endDate: "2027-05-10" },
  ] });
  assert.deepEqual(withGraduation(base, "2027-12").education.map((r) => r.endDate), ["2024-06-15", "2027-12"]);
  assert.equal(withGraduation(base, "2027-05"), base);
  // A rule with the day moves the date to that day.
  assert.deepEqual(graduationRule(
    "## Education timeline\n- **Graduation by role:** internships and co-ops: December 13, 2027. Full-time and new-grad roles: May 10, 2027.", true,
  ), { internship: "2027-12-13", fullTime: "2027-05-10" });
  assert.deepEqual(withGraduation(base, "2027-12-13").education.map((r) => r.endDate), ["2024-06-15", "2027-12-13"]);
  assert.equal(withGraduation(base, "2027-05-10"), base);
  // Either of the rule's dates agrees with the extension profile.
  const both = "- **Graduation:** December 13, 2027.\n- **Graduation by role:** internships: December 13, 2027. Full-time: May 10, 2027.";
  assert.deepEqual(profileConflicts(base, { preferences: both, profile: masterProfile }), []);
  assert.equal(profileConflicts(base, { preferences: "- **Graduation:** December 13, 2027.", profile: masterProfile })[0].field, "Graduation");
});

test("plain preference entries become standing answers, and hedged ones do not", async () => {
  const { preferenceAnswers } = await import("../src/server/profile-sync");
  const { questionTopic } = await import("../src/shared/standing");
  const text = [
    "- **Work authorization:** U.S. citizen. No sponsorship needed.",
    "- **Relocation:** Yes, open to relocating anywhere.",
    "- **Remote vs. onsite preference:** Prefers onsite, fine with hybrid.",
    "- **Salary expectation:** $90,000/year target (full-time). Internships: accept the posted rate.",
    "- **Earliest start date / availability:** Immediately.",
    "- **Security clearance:** None.",
    "- **Willing to do a take-home / coding assessment:** Yes (default).",
  ].join("\n");
  const byTopic = (title: string) => Object.fromEntries(preferenceAnswers(text, title).map((a) => [questionTopic(a.question), a.answer]));
  assert.deepEqual(byTopic("Software Engineer"), { relocate: "Yes", citizen: "Yes", usPerson: "Yes", onsite: "Yes", salary: "$90,000", start: "Immediately", clearance: "No", assessment: "Yes" });
  // An internship takes the posted rate: no figure is offered.
  assert.equal(byTopic("Software Engineering Intern").salary, undefined);
  // Hedged or absent entries say nothing.
  const hedged = "- **Relocation:** Depends on the city.\n- **Remote vs. onsite preference:** Remote only.\n- **Security clearance:** Held Secret until 2022.";
  assert.deepEqual(preferenceAnswers(hedged, "Engineer"), []);
});
