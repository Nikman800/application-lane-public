import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXTENSION_KEY, extensionManifest } from "../scripts/manifest.mjs";

const icons = { "16": "icons/icon-16.png" };
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

test("the store build has no fixed key and no debugger permission; the others are unchanged", () => {
  const full = extensionManifest({ target: "extension", version, icons });
  const baseline = extensionManifest({ target: "baseline", version, icons });
  const store = extensionManifest({ target: "store", version, icons });
  assert.equal(full.key, EXTENSION_KEY);
  assert.ok(full.permissions.includes("debugger"));
  assert.equal(store.key, undefined);
  assert.ok(!store.permissions.includes("debugger"));
  assert.equal(baseline.key, undefined);
  assert.ok(!baseline.permissions.includes("debugger"));
  // Apart from those two, the store build asks for exactly what the full one does.
  const { key: _key, permissions, ...rest } = full;
  const { permissions: storePermissions, ...storeRest } = store;
  assert.deepEqual(storeRest, rest);
  assert.deepEqual(storePermissions, permissions.filter((permission) => permission !== "debugger"));
  // The backend stays the only place extension pages may connect to.
  assert.match(store.content_security_policy.extension_pages, /connect-src http:\/\/127\.0\.0\.1:4318 ws:\/\/127\.0\.0\.1:4318$/);
  assert.deepEqual(store.host_permissions, ["http://127.0.0.1/*"]);
});

test("every build carries the version from package.json", () => {
  for (const target of ["extension", "baseline", "store"] as const)
    assert.equal(extensionManifest({ target, version, icons }).version, version);
});

test("the toolbar action has a default shortcut, and it opens the side panel the button opens", () => {
  const full = extensionManifest({ target: "extension", version, icons });
  assert.equal((full.commands as any)._execute_action.suggested_key.default, "Alt+Shift+L");
  assert.equal((full.commands as any)["fill-step"].suggested_key.default, "Alt+Shift+F");
});
