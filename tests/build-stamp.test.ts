import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app";
import { configSchema } from "../src/server/store";
import { newerBuild } from "../src/shared/build";

// A forgotten reload of the extension was taken for a fix that did not work
// (2026-10-14): the panel says when dist/ holds a newer build than it runs.
test("a build more than a minute newer than the loaded one is waiting", () => {
  const loaded = { builtAt: 1_000_000, commit: "aaa1111" };
  assert.equal(newerBuild(loaded, { builtAt: 1_030_000, commit: "aaa1111" }), undefined);
  assert.deepEqual(newerBuild(loaded, { builtAt: 1_200_000, commit: "bbb2222" }), { builtAt: 1_200_000, commit: "bbb2222" });
  assert.equal(newerBuild(undefined, { builtAt: 1_200_000, commit: "bbb2222" }), undefined);
});

test("the backend says which build is in dist/", async () => {
  // The stamp the last npm run build wrote, or none before any build (the
  // fixer runs the unit tests on a checkout it has not built yet).
  const stamp = await readFile(join("dist", "extension", "build.json"), "utf8").then((text) => JSON.parse(text), () => undefined);
  if (stamp) assert.ok(stamp.builtAt > 0 && typeof stamp.commit === "string");
  const directory = await mkdtemp(join(tmpdir(), "lane-build-"));
  const cfg = configSchema.parse({ postingLookup: false, token: "test-token-".repeat(7), model: "test", endpoint: "http://127.0.0.1:9999/v1" });
  const { server } = await createApp(cfg, directory);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const status = await (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/status`, { headers: { Authorization: `Bearer ${cfg.token}` } })).json();
    assert.deepEqual(status.extensionBuild, stamp);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
