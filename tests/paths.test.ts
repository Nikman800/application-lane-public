import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDataDirectory, packageRoot, packageVersion, resolveDataDirectory } from "../src/server/paths";
import { transcriptsFolder } from "../src/server/documents";

test("the data folder is LANE_DATA_DIR, an existing .local installation, or the platform's app-data folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-paths-"));
  const cwd = join(root, "cwd");
  const checkout = join(root, "checkout");
  await mkdir(cwd);
  await mkdir(checkout);
  try {
    const fresh = { cwd, root: checkout, env: {}, platform: "linux" as const, home: "/home/u" };
    assert.equal(resolveDataDirectory(fresh), "/home/u/.local/share/application-lane");
    assert.equal(resolveDataDirectory({ ...fresh, env: { XDG_DATA_HOME: "/xdg" } }), "/xdg/application-lane");
    assert.equal(resolveDataDirectory({ ...fresh, env: { LANE_DATA_DIR: "custom" } }), join(cwd, "custom"));
    // A .local/ without a configuration is not an installation.
    await mkdir(join(checkout, ".local"));
    assert.equal(resolveDataDirectory(fresh), "/home/u/.local/share/application-lane");
    await writeFile(join(checkout, ".local", "config.json"), "{}");
    assert.equal(resolveDataDirectory(fresh), join(checkout, ".local"));
    await mkdir(join(cwd, ".local"));
    await writeFile(join(cwd, ".local", "config.json"), "{}");
    assert.equal(resolveDataDirectory(fresh), join(cwd, ".local"));
    assert.equal(resolveDataDirectory({ ...fresh, env: { LANE_DATA_DIR: "/elsewhere" } }), "/elsewhere");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(appDataDirectory("darwin", {}, "/Users/u"), "/Users/u/Library/Application Support/Application Lane");
  assert.equal(appDataDirectory("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u"), join("C:\\Users\\u\\AppData\\Roaming", "Application Lane"));
});

test("the package root and version come from the module, not the working directory", () => {
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
  assert.ok(packageRoot.endsWith("/"));
});

test("transcripts live in the data folder, except beside an old .local that already has them", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-transcripts-"));
  try {
    assert.equal(transcriptsFolder(undefined, join(root, "data")), join(root, "data", "transcripts"));
    assert.equal(transcriptsFolder(undefined, join(root, ".local")), join(root, ".local", "transcripts"));
    await mkdir(join(root, "transcripts"));
    assert.equal(transcriptsFolder(undefined, join(root, ".local")), join(root, "transcripts"));
    assert.equal(transcriptsFolder("/mine", join(root, ".local")), "/mine");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
