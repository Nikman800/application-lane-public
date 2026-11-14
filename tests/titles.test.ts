import { test } from "node:test";
import assert from "node:assert/strict";
import { genericTitle, singlePostingUrl } from "../src/shared/titles";

// PACCAR's application was renamed "Your session has expired." and then
// "Candidate Profile" by the pages a sign-in led to, and its documents were
// drafted for a job of that name.
test("a sign-in, profile or home page's heading names no job", () => {
  const url = "https://career5.successfactors.example/portalcareer?company=acme";
  for (const title of ["Candidate Profile", "Your session has expired.", "Your session is about to time out.", "Sign In", "Career Opportunities: Sign In", "Tesla homepageCareersSkip to main content", "", "career5.successfactors.example", "https://career5.successfactors.example/x"])
    assert.equal(genericTitle(title, url), true, title);
  for (const title of ["Data Analyst Intern (73956)", "Software Engineer Intern - Autonomy", "Full-Stack Software Engineering Intern, Summer 2027"])
    assert.equal(genericTitle(title, url), false, title);
});

// Optimum's application was opened from its posting, and the form it led to
// is another site's: the posting was never sent to be read.
test("one job's own page is a posting; a list, a search or a company's openings is not", () => {
  for (const url of [
    "https://www.optimumcareers.com/job/Bethpage-Intern-Operations-Data-Analyst-NY-11714/1449510400/?ats=successfactors",
    "https://careers.example.test/careers/job/12345678",
    "https://boards.example.test/acme/jobs/4d2f1c3e-1111-4222-8333-444455556666",
    "https://jobs.example.test/positions/Software-Engineer-Intern-Summer-Program",
  ])
    assert.equal(singlePostingUrl(url), true, url);
  for (const url of [
    "https://github.com/Example/Summer2027-Internships",
    "https://www.example.test/jobs",
    "https://www.example.test/jobs/search?q=intern",
    "https://www.example.test/careers",
    "https://www.example.test/",
    "not a url",
  ])
    assert.equal(singlePostingUrl(url), false, url);
});
