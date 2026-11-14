import { test } from "node:test";
import assert from "node:assert/strict";
import { usableImages } from "../src/shared/issue-images";

// Two reports were downloaded as files and never reached the fixer because a
// pasted screenshot came through with no bytes.
test("an empty or malformed screenshot is left out of a report, and a real one stays", () => {
  const good = { mime: "image/png" as const, data: "iVBORw0KGgo=" };
  assert.deepEqual(usableImages([good]), [good]);
  assert.deepEqual(usableImages([{ mime: "image/png" as const, data: "" }, good]), [good]);
  assert.deepEqual(usableImages([{ mime: "image/png" as const, data: "data:image/png;base64,AAAA" }]), []);
  assert.deepEqual(usableImages([]), []);
});
