import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app";
import { configSchema } from "../src/server/store";
import { profileSchema } from "../src/shared/model";

async function installation(tailorDir?: string) {
  const directory = await mkdtemp(join(tmpdir(), "lane-bundle-"));
  const config = configSchema.parse({
    postingLookup: false,
    token: "test-token-".repeat(7),
    model: "test",
    apiKey: "secret-api-key",
    endpoint: "http://127.0.0.1:9999/v1",
    ...(tailorDir ? { tailorDir } : {}),
  });
  const { server, store } = await createApp(config, directory);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(`${url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { directory, config, store, call, close: () => new Promise<void>((done) => server.close(() => done())) };
}

test("a profile exported from one installation arrives whole in another, with its tailoring files and no secrets", async () => {
  // The source keeps its tailoring files in a job-applier checkout's layout.
  const checkout = await mkdtemp(join(tmpdir(), "lane-bundle-checkout-"));
  await mkdir(join(checkout, "resumes", "resume-creator"), { recursive: true });
  await writeFile(join(checkout, "resumes", "resume-creator", "Alex_Fixture_Resume.tex"), "\\documentclass{article}");
  await writeFile(join(checkout, "resumes", "resume-creator", "Alex_Fixture_Resume.pdf"), "build product");
  await writeFile(join(checkout, "resumes", "profile.md"), "## Experience\n- Built things.\n");
  await writeFile(join(checkout, "resumes", "preferences.md"), "## Logistics (confirmed)\n- **Home base:** Tucson, AZ.\n");
  await writeFile(join(checkout, "resumes", "cover-letter-example.md"), "Dear Team, a letter I like.");
  await mkdir(join(checkout, ".claude", "skills", "job-apply", "references"), { recursive: true });
  await writeFile(join(checkout, ".claude", "skills", "job-apply", "references", "anti-fabrication.md"), "Never invent employers.");
  const source = await installation(checkout);
  const target = await installation();
  try {
    source.store.data.profile = profileSchema.parse({
      firstName: "Alex",
      lastName: "Fixture",
      email: "alex@example.test",
      confirmed: true,
      revision: 7,
      facts: [{ id: "fact-1", text: "Built a Redis cache." }],
      answers: [{ question: "Why us?", answer: "The mission." }],
      legal: { criminal: "No convictions and no pending charges" },
    });
    const exported = await (await source.call("/v1/profile/bundle")).json();
    assert.equal(exported.format, "application-lane-profile");
    assert.deepEqual(
      exported.tailoring.map((file: { path: string }) => file.path).sort(),
      ["cover-letter-example.md", "preferences.md", "profile.md", "references/anti-fabrication.md", "resumes/Alex_Fixture_Resume.tex"],
    );
    // Nothing that belongs to the machine is in the file.
    assert.doesNotMatch(JSON.stringify(exported), /secret-api-key|test-token-/);

    const sent = await target.call("/v1/profile/bundle", "PUT", { ...exported, settings: { modelFill: "review" } });
    assert.equal(sent.status, 200);
    const imported = await sent.json();
    assert.equal(imported.tailoring.length, 5);
    assert.deepEqual(imported.settings, { modelFill: "review" });
    // The profile is the exported one, as this installation's next revision.
    const profile = target.store.data.profile;
    assert.equal(profile.firstName, "Alex");
    assert.equal(profile.legal.criminal, "No convictions and no pending charges");
    assert.equal(profile.answers[0].answer, "The mission.");
    assert.equal(profile.confirmed, true);
    assert.equal(profile.revision, 1);
    // The files are in the lane's own layout, and used from now on.
    const folder = join(target.directory, "tailoring");
    assert.deepEqual(await readdir(join(folder, "resumes")), ["Alex_Fixture_Resume.tex"]);
    assert.match(await readFile(join(folder, "preferences.md"), "utf8"), /Tucson/);
    assert.equal(target.config.tailorDir, folder);
    assert.equal("tailorDir" in JSON.parse(await readFile(join(target.directory, "config.json"), "utf8")), false);
    const conflicts = await (await target.call("/v1/profile/conflicts")).json();
    assert.ok(Array.isArray(conflicts));
  } finally {
    await source.close();
    await target.close();
  }
});

test("an import writes nowhere but the tailoring folder, and refuses a file that is not an export", async () => {
  const target = await installation();
  try {
    const profile = profileSchema.parse({ firstName: "Alex", lastName: "Fixture", email: "", confirmed: false, facts: [] });
    const bundle = (tailoring: { path: string; text: string }[]) => ({
      format: "application-lane-profile", version: 1, exportedAt: new Date().toISOString(), profile, tailoring,
    });
    for (const path of ["../config.json", "resumes/../../state.json", "/etc/passwd", "resumes/run.sh", "config.json", "references/../../x.md"]) {
      const refused = await target.call("/v1/profile/bundle", "PUT", bundle([{ path, text: "x" }]));
      assert.equal(refused.status, 400, path);
    }
    assert.equal(existsSync(join(target.directory, "tailoring")), false);
    assert.equal(target.store.data.profile.firstName, "");
    assert.equal((await target.call("/v1/profile/bundle", "PUT", { ...bundle([]), format: "something-else" })).status, 400);
    assert.equal((await target.call("/v1/profile/bundle", "PUT", { firstName: "Alex" })).status, 400);
    // A profile with no tailoring files is a complete import of its own.
    assert.equal((await target.call("/v1/profile/bundle", "PUT", bundle([]))).status, 200);
    assert.equal(target.store.data.profile.firstName, "Alex");
    assert.equal(target.config.tailorDir, undefined);
  } finally {
    await target.close();
  }
});
