import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importTailoring } from "../scripts/tailoring-import";
import { skillContext } from "../src/server/answers";
import { resumeSources, tailoringHome } from "../src/server/job-apply";
import { configSchema } from "../src/server/store";

// A job-applier checkout as that repository lays its files out.
async function checkout() {
  const dir = await mkdtemp(join(tmpdir(), "lane-import-checkout-"));
  const resumes = join(dir, "resumes", "resume-creator");
  await mkdir(resumes, { recursive: true });
  await writeFile(join(resumes, "Alex_Fixture_Resume.tex"), "\\documentclass{article}");
  await writeFile(join(resumes, "Alex_Fixture_Resume.aux"), "build product");
  await writeFile(join(resumes, "Alex_Fixture_Resume.pdf"), "build product");
  await writeFile(join(dir, "resumes", "profile.md"), "## Experience\n- Built things.\n");
  await writeFile(join(dir, "resumes", "preferences.md"), "## Logistics (confirmed)\n- **Home base:** Tucson, AZ.\n");
  const references = join(dir, ".claude", "skills", "job-apply", "references");
  await mkdir(references, { recursive: true });
  await writeFile(join(references, "common-questions.md"), "Why here: tie a posting signal to real work.");
  await writeFile(join(references, "anti-fabrication.md"), "Never invent employers or metrics.");
  return dir;
}

test("a job-applier checkout is still read in its own layout, under either setting name", async () => {
  const dir = await checkout();
  const home = tailoringHome(dir);
  assert.equal(home.sources, join(dir, "resumes", "resume-creator"));
  assert.equal(resumeSources(dir), home.sources);
  const context = await skillContext(dir);
  assert.deepEqual(context.warnings, []);
  assert.match(context.guidance, /Never invent employers/);
  const config = { token: "synthetic-token-".repeat(4) };
  assert.equal(configSchema.parse({ ...config, jobApplierDir: dir }).tailorDir, dir);
  assert.equal(configSchema.parse({ ...config, jobApplierDir: "old", tailorDir: dir }).tailorDir, dir);
  assert.equal("jobApplierDir" in configSchema.parse({ ...config, jobApplierDir: dir }), false);
});

test("importing copies the applicant's files into the data folder and lets go of the checkout", async () => {
  const dir = await checkout();
  const data = await mkdtemp(join(tmpdir(), "lane-import-data-"));
  await writeFile(join(data, "config.json"), JSON.stringify({ token: "t", jobApplierDir: dir, model: "kept" }));
  const done = await importTailoring(dir, data);
  const target = join(data, "tailoring");
  // Sources only: no build products.
  assert.deepEqual(await readdir(join(target, "resumes")), ["Alex_Fixture_Resume.tex"]);
  assert.deepEqual((await readdir(target)).sort(), ["preferences.md", "profile.md", "references", "resumes"]);
  assert.deepEqual((await readdir(join(target, "references"))).sort(), ["anti-fabrication.md", "common-questions.md"]);
  assert.deepEqual(JSON.parse(await readFile(join(data, "config.json"), "utf8")), { token: "t", model: "kept" });
  assert.ok(done.includes("config.json: no longer points at a checkout"));
  // The copy reads like the checkout did, in the lane's own layout.
  assert.equal(resumeSources(target), join(target, "resumes"));
  const context = await skillContext(target);
  assert.deepEqual(context.warnings, []);
  assert.match(context.preferences, /Tucson/);
  // The checkout is untouched.
  assert.equal((await readdir(join(dir, "resumes", "resume-creator"))).length, 3);
});
