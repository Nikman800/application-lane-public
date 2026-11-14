import { test } from "node:test";
import assert from "node:assert/strict";
import { REPORT_OPEN_MS, reportOpen } from "../src/shared/reload-gate";

// A reload closed the report the applicant was writing, several times.
test("a report is open while the panel's beat is recent, and not after it stops", () => {
  const now = 1_000_000;
  assert.equal(reportOpen(undefined, now), false);
  assert.equal(reportOpen(0, now), false);
  assert.equal(reportOpen(now - 4_000, now), true);
  assert.equal(reportOpen(now - REPORT_OPEN_MS + 1, now), true);
  // The dialog closed or the panel went away: its beats stopped.
  assert.equal(reportOpen(now - REPORT_OPEN_MS - 1, now), false);
});
