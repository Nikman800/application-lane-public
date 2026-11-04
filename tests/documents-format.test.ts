import assert from "node:assert/strict";
import { test } from "node:test";
import { pdfPrintableText } from "../src/server/documents";

test("PDF text removes invisible bidi controls but preserves visible Unicode", () => {
  assert.equal(
    pdfPrintableText("\u202AJordan\u202C — Zoë São\u2066\u2069\uFEFF"),
    "Jordan — Zoë São",
  );
});
