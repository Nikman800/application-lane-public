import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../src/server/app";
import { configSchema } from "../src/server/store";

test("the dashboard reads and edits drafting providers, the endpoint and folders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lane-settings-"));
  const cfg = configSchema.parse({
    postingLookup: false,
    token: "test-token-".repeat(7),
    model: "test",
    apiKey: "sk-original",
    endpoint: "http://127.0.0.1:9999/v1",
  });
  const { server } = await createApp(cfg, directory);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1/config`;
  const headers = { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" };
  const put = async (body: unknown) => {
    const response = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as any };
  };
  try {
    const initial = (await (await fetch(url, { headers })).json()) as any;
    assert.deepEqual(initial.providers, [{ id: "legacy-http", provider: "http", model: "test" }]);
    assert.equal(initial.hasApiKey, true);
    assert.ok(!JSON.stringify(initial).includes("sk-original"));
    assert.equal(typeof initial.installed["claude-cli"].found, "boolean");
    // No LaTeX folder: the built-in resume layout, with the tools still looked for.
    assert.equal(initial.tailoring.configured, false);
    assert.equal(initial.tailoring.folder, "");
    assert.equal(typeof initial.tailoring.python.found, "boolean");
    assert.equal(typeof initial.tailoring.pdflatex.found, "boolean");

    // A stand-in for the CLI, at a path of its own.
    const windows = process.platform === "win32";
    const claude = join(directory, windows ? "claude.cmd" : "claude");
    await writeFile(claude, windows ? "@echo 9.9.9 (Claude Code)\r\n" : "#!/bin/sh\necho '9.9.9 (Claude Code)'\n");
    await chmod(claude, 0o755);
    await mkdir(join(directory, "transcripts"));
    const saved = await put({
      providers: [
        { id: "claude", provider: "claude-cli", model: "sonnet", command: claude, home: directory },
        { id: "codex", provider: "codex-cli", model: "gpt-5-codex", effort: "low" },
        { id: "http", provider: "http", model: "gemma" },
      ],
      // Who checks, in an order of its own.
      checkProviders: [
        { id: "checker", provider: "codex-cli", model: "codex-checker-model", effort: "low" },
        { id: "http", provider: "http", model: "gemma" },
      ],
      endpoint: "https://models.example.edu/v1",
      model: "gemma",
      verifyModel: " checker-large ",
      apiKey: "sk-new",
      documentsDir: join(directory, "documents"),
      transcriptsDir: join(directory, "transcripts"),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.providers[0].cli, { command: claude, found: true, version: "9.9.9 (Claude Code)" });
    assert.ok(!JSON.stringify(saved.body).includes("sk-new"));
    // The running backend's own configuration changed, and the file with it.
    assert.equal(cfg.draftProviders.length, 3);
    assert.equal(cfg.apiKey, "sk-new");
    const file = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
    assert.equal(file.draftProviders[0].command, claude);
    assert.deepEqual(file.checkProviders.map((step: { model: string }) => step.model), ["codex-checker-model", "gemma"]);
    assert.equal(cfg.checkProviders[0].model, "codex-checker-model");
    assert.deepEqual(saved.body.checkProviders.map((step: { id: string }) => step.id), ["checker", "http"]);
    assert.deepEqual(initial.checkProviders, []);
    assert.equal(file.endpoint, "https://models.example.edu/v1");
    // The model that checks drafts is set here too, not only by hand in the file.
    assert.equal(initial.verifyModel, "");
    assert.equal(saved.body.verifyModel, "checker-large");
    assert.equal(cfg.verifyModel, "checker-large");
    assert.equal(file.verifyModel, "checker-large");
    assert.equal(file.transcriptsDir, join(directory, "transcripts"));
    const status = (await (await fetch(url.replace("config", "status"), { headers })).json()) as any;
    assert.equal(status.configured, true);

    // An empty key keeps the saved one; an empty transcripts folder clears it.
    assert.equal((await put({ apiKey: "", transcriptsDir: "" })).status, 200);
    assert.equal(cfg.apiKey, "sk-new");
    assert.equal(cfg.transcriptsDir, undefined);
    // Left out, it stays; emptied, the endpoint's own model checks again.
    assert.equal(cfg.verifyModel, "checker-large");
    assert.equal((await put({ verifyModel: "" })).body.verifyModel, "");
    assert.equal(cfg.verifyModel, "");

    // The backend runs the program, so only the CLI itself is accepted.
    for (const [step, message] of [
      [{ command: "/bin/sh" }, /must start with "claude"/],
      [{ command: "claude" }, /full path/],
      [{ command: join(directory, "claude-missing") }, /no program at/],
      [{ home: join(directory, "missing") }, /existing folder/],
    ] as const) {
      const refused = await put({ providers: [{ id: "claude", provider: "claude-cli", model: "sonnet", ...step }] });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, message);
    }
    assert.equal((await put({ endpoint: "file:///etc/passwd" })).status, 400);
    assert.equal((await put({ transcriptsDir: join(directory, "missing") })).status, 400);
    assert.equal((await put({ token: "x".repeat(40) })).status, 400);
    assert.equal(
      (await put({ providers: [{ id: "a", provider: "http", model: "m" }, { id: "a", provider: "http", model: "n" }] })).status,
      400,
    );
    assert.equal(cfg.draftProviders.length, 3);
    assert.equal(cfg.endpoint, "https://models.example.edu/v1");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});

// A form asked for "your most recent transcript" and the only way to supply
// one was to find the backend's transcripts folder by hand.
test("a transcript uploaded on the dashboard becomes the one forms are given, and only a real PDF or Word file is kept", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-transcript-"));
  const directory = join(root, "data");
  await mkdir(directory);
  const cfg = configSchema.parse({ postingLookup: false, token: "test-token-".repeat(7), model: "test", endpoint: "http://127.0.0.1:9999/v1" });
  const { server } = await createApp(cfg, directory);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const headers = { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" };
  const upload = async (name: string, bytes: string | Buffer) => {
    const response = await fetch(`${base}/transcript`, { method: "PUT", headers, body: JSON.stringify({ name, data: Buffer.from(bytes).toString("base64") }) });
    return { status: response.status, body: (await response.json()) as any };
  };
  try {
    assert.equal(((await (await fetch(`${base}/config`, { headers })).json()) as any).transcript, null);
    const first = await upload("Spring transcript.pdf", "%PDF-1.7 synthetic transcript");
    assert.equal(first.status, 200);
    assert.equal(first.body.transcript.name, "Spring transcript.pdf");
    // In the data folder, where a fill looks for it.
    assert.equal(await readFile(join(root, "data", "transcripts", "Spring transcript.pdf"), "utf8"), "%PDF-1.7 synthetic transcript");
    // A later upload is the newest, so it is the one used; a Word file is taken too.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await upload("Fall transcript.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("synthetic")]));
    assert.equal(second.body.transcript.name, "Fall transcript.docx");
    assert.equal(((await (await fetch(`${base}/config`, { headers })).json()) as any).transcript.name, "Fall transcript.docx");
    // The name never chooses the folder, and the content has to be what the name says.
    for (const [name, bytes, message] of [
      ["../escaped.pdf", "%PDF-1.7", /plain file name/],
      ["folder\\escaped.pdf", "%PDF-1.7", /plain file name/],
      [".hidden.pdf", "%PDF-1.7", /plain file name/],
      ["transcript.exe", "MZ", /PDF or a Word/],
      ["renamed.pdf", "MZ this is a program", /not a PDF/],
      ["renamed.docx", "%PDF-1.7", /not a Word document/],
    ] as const) {
      const refused = await upload(name, bytes);
      assert.equal(refused.status, 400, name);
      assert.match(refused.body.error, message);
    }
    assert.equal((await upload("big.pdf", Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(8 * 1024 * 1024)]))).status, 400);
    assert.deepEqual((await readdir(join(root, "data", "transcripts"))).sort(), ["Fall transcript.docx", "Spring transcript.pdf"]);
    assert.deepEqual(await readdir(root).then((names) => names.sort()), ["data"]);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
