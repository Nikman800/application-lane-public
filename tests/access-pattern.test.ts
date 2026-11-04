import assert from "node:assert/strict";
import { test } from "node:test";
import { accessPattern } from "../src/shared/matching";

test("site access is asked for once per site, not once per host of it", () => {
  // One Indeed application: the posting, the apply steps, a tracking frame.
  for (const host of ["www.indeed.com", "smartapply.indeed.com", "sgtm.indeed.com", "indeed.com"])
    assert.equal(accessPattern(`https://${host}`), "https://*.indeed.com/*");
  assert.equal(accessPattern("https://job-boards.eu.greenhouse.io"), "https://*.greenhouse.io/*");
  assert.equal(accessPattern("https://careers.example.co.uk"), "https://*.example.co.uk/*");
  assert.equal(accessPattern("https://example.co.uk"), "https://*.example.co.uk/*");
  // Never a whole registry, a shared host, or an address without a site.
  assert.equal(accessPattern("https://co.uk"), "https://co.uk/*");
  assert.equal(accessPattern("https://someone.github.io"), "https://someone.github.io/*");
  assert.equal(accessPattern("http://127.0.0.1:4318"), "http://127.0.0.1:4318/*");
  assert.equal(accessPattern("http://localhost"), "http://localhost/*");
  assert.equal(accessPattern("https://jobs.example.com:8443"), "https://jobs.example.com:8443/*");
});
