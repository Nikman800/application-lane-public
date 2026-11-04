import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { configSchema } from "../src/server/store";
import { createApp } from "../src/server/app";

const run = promisify(execFile);

// The command line queues links and reads the queue the extension mirrors
// (2026-10-30): many links at once, how the applications stand, and which
// fills failed, also as JSON for anyone monitoring a shared setup.
test("the command line queues links and reports the queue and its failed fills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lane-cli-"));
  const cfg = configSchema.parse({ token: "cli-fixture-token-".repeat(3), model: "fixture", endpoint: "http://127.0.0.1:9/v1", postingLookup: false });
  await writeFile(join(directory, "config.json"), JSON.stringify(cfg));
  const { server } = await createApp(cfg, directory);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" };
  const lane = (...args: string[]) =>
    run(process.execPath, ["--import", "tsx", "scripts/lane.ts", ...args], { env: { ...process.env, LANE_DATA_DIR: directory, LANE_URL: url } })
      .then(({ stdout }) => stdout, (error) => ({ failed: true, stdout: error.stdout, stderr: error.stderr }));
  try {
    // Before the extension has sent anything, status says so.
    const early = await lane("status");
    assert.match(typeof early === "string" ? early : early.stderr, /has not sent its queue yet/);
    // Links from arguments and from a file, each queued once.
    const list = join(directory, "jobs.txt");
    await writeFile(list, "https://jobs.example.test/one\n\nnot a link\nhttps://jobs.example.test/two\n");
    assert.match(String(await lane("add", list, "https://jobs.example.test/one", "https://jobs.example.test/three")), /Queued 3 links \(3 waiting\)/);
    assert.deepEqual(
      (await (await fetch(`${url}/v1/inbox`, { headers })).json()).map((item: { url: string }) => item.url),
      ["https://jobs.example.test/one", "https://jobs.example.test/two", "https://jobs.example.test/three"],
    );
    // The extension takes what it tracked off the list.
    await fetch(`${url}/v1/inbox`, { method: "DELETE", headers, body: JSON.stringify({ urls: ["https://jobs.example.test/one"] }) });
    const summary = (id: string, status: string, extra: object = {}) => ({
      id, url: `https://jobs.example.test/${id}`, company: "Acme", title: `Engineer ${id}`, status, stage: "applying",
      note: "Your attention is needed.", needs: [], updatedAt: Date.now(), reports: 0, ...extra,
    });
    assert.equal((await fetch(`${url}/v1/queue`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        at: Date.now(),
        applications: [
          summary("a", "awaiting-user", { needs: ["Status", "Type of Company"], optional: ["Pronouns"] }),
          summary("b", "failed", { note: "The page reloaded during a write.", reports: 1 }),
          summary("c", "awaiting-user", { lastFill: { status: "error", note: "Fill stopped: the site did not answer.", filled: 3 } }),
          summary("d", "awaiting-user", { stage: "submitted" }),
          // AI still filling what the rules left: busy, not waiting on you.
          summary("e", "awaiting-user", { assisting: true }),
        ],
      }),
    })).status, 200);
    const status = String(await lane("status"));
    assert.match(status, /5 applications/);
    assert.match(status, /in progress\s+1/);
    assert.match(status, /needs you\s+1/);
    assert.match(status, /failed\s+2/);
    assert.match(status, /submitted\s+1/);
    assert.match(status, /queued links\s+2 not tracked yet/);
    assert.match(status, /Required \(2\):\n      • Status\n      • Type of Company\n    Optional \(1\):\n      • Pronouns/);
    const failures = String(await lane("failures"));
    assert.match(failures, /Engineer b[\s\S]*page reloaded during a write[\s\S]*1 issue report filed/);
    assert.match(failures, /Engineer c[\s\S]*the site did not answer/);
    assert.doesNotMatch(failures, /Engineer a/);
    const asJson = JSON.parse(String(await lane("failures", "--json")));
    assert.deepEqual(asJson.map((app: { id: string }) => app.id).sort(), ["b", "c"]);
    // Without the token nothing is read or queued.
    assert.equal((await fetch(`${url}/v1/inbox`)).status, 401);
  } finally {
    server.close();
  }
});

// The live line (2026-10-30): the command line's fill and switch reach the
// extension at once and its answer comes back. Only the paired extension and
// the command line, with the token, may join.
test("fill and switch go to the extension over the live line, and come back with its answer", async () => {
  const { default: WebSocket } = await import("ws");
  const directory = await mkdtemp(join(tmpdir(), "lane-live-"));
  const cfg = configSchema.parse({ token: "live-fixture-token-".repeat(3), model: "fixture", endpoint: "http://127.0.0.1:9/v1", postingLookup: false, extensionId: "a".repeat(32) });
  await writeFile(join(directory, "config.json"), JSON.stringify(cfg));
  const { server } = await createApp(cfg, directory);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const join_ = (origin?: string, token = cfg.token) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/live`, origin ? { origin } : {});
    const messages: any[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data))));
    const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
    const opened = new Promise<void>((resolve, reject) => {
      socket.on("open", () => (socket.send(JSON.stringify({ type: "auth", token })), resolve()));
      socket.on("error", reject);
    });
    return { socket, messages, closed, opened };
  };
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(check());
  };
  try {
    // A web page cannot join, nor anyone without the token.
    await assert.rejects(join_("https://evil.test").opened);
    const stranger = join_(undefined, "wrong-token");
    await stranger.opened;
    assert.equal(await stranger.closed, 4003);
    // The extension joins and answers what it is sent.
    const extension = join_(`chrome-extension://${"a".repeat(32)}`);
    await extension.opened;
    extension.socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type === "command")
        extension.socket.send(JSON.stringify({ type: "result", id: message.id, ok: true, detail: `did ${message.action} for ${message.applicationId}` }));
    });
    extension.socket.send(JSON.stringify({ type: "queue", snapshot: { at: Date.now(), applications: [] } }));
    // The command line finds the application by part of its name.
    await fetch(`${url}/v1/queue`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ at: Date.now(), applications: [{ id: "f00dcafe-0000-4000-8000-000000000000", url: "https://jobs.example.test/notion", company: "Notion", title: "Software Engineer", status: "awaiting-user", stage: "applying", note: "Tracked.", needs: [], updatedAt: Date.now(), reports: 0 }] }),
    });
    const lane = (...args: string[]) =>
      run(process.execPath, ["--import", "tsx", "scripts/lane.ts", ...args], { env: { ...process.env, LANE_DATA_DIR: directory, LANE_URL: url } })
        .then(({ stdout }) => stdout, (error) => `${error.stdout}${error.stderr}`);
    assert.match(await lane("fill", "notion"), /Notion — Software Engineer: did fill for f00dcafe-0000-4000-8000-000000000000/);
    assert.match(await lane("switch", "f00dca"), /did switch for f00dcafe/);
    // Abandoned from the command line as the panel's Abandon (2026-11-02).
    assert.match(await lane("abandon", "notion"), /Notion — Software Engineer: did abandon for f00dcafe/);
    assert.match(await lane("fill", "nobody"), /No application matches "nobody"/);
    // A command line watching hears the extension's queue.
    const watcher = join_();
    await watcher.opened;
    extension.socket.send(JSON.stringify({ type: "queue", snapshot: { at: 1, applications: [] } }));
    await until(() => watcher.messages.some((message) => message.type === "queue" && message.snapshot.at === 1));
    // A link queued while the extension listens is picked up at once, not
    // at its next minute's check (the applicant, 2026-10-31).
    const queued = await (await fetch(`${url}/v1/inbox`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ urls: ["https://jobs.example.test/queued-now"] }),
    })).json();
    assert.equal(queued.now, true);
    await until(() => extension.messages.some((message) => message.type === "command" && message.action === "pick-up"));
    // With the extension gone, a command says so at once.
    extension.socket.close();
    await extension.closed;
    assert.match(await lane("fill", "notion"), /extension is not connected/);
    watcher.socket.close();
  } finally {
    server.close();
  }
});

// Finding jobs from the command line (2026-10-30): a search with the saved
// settings or these, numbered openings, and queueing them by number. The
// listings are served from the backend's cache, so nothing is fetched.
test("the command line searches for openings and queues them by number", async () => {
  const { mkdir } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "lane-search-cli-"));
  const cfg = configSchema.parse({ token: "search-fixture-token-".repeat(3), model: "fixture", endpoint: "http://127.0.0.1:9/v1", postingLookup: false });
  await writeFile(join(directory, "config.json"), JSON.stringify(cfg));
  await mkdir(join(directory, "search", "cache"), { recursive: true });
  const posted = Date.now() / 1000 - 86_400;
  await writeFile(join(directory, "search", "cache", "simplify-new-grad.json"), JSON.stringify([
    { id: "1", title: "Software Engineer, New Grad", company_name: "Acme", locations: ["Phoenix, AZ"], url: "https://acme.example.test/1", date_posted: posted, active: true, is_visible: true },
    { id: "2", title: "Senior Software Engineer", company_name: "Beta", locations: ["Phoenix, AZ"], url: "https://beta.example.test/2", date_posted: posted, active: true, is_visible: true },
    { id: "3", title: "Software Engineer", company_name: "Gamma", locations: ["London, UK"], url: "https://gamma.example.test/3", date_posted: posted, active: true, is_visible: true },
  ]));
  const { server } = await createApp(cfg, directory);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const lane = (...args: string[]) =>
    run(process.execPath, ["--import", "tsx", "scripts/lane.ts", ...args], { env: { ...process.env, LANE_DATA_DIR: directory, LANE_URL: url } })
      .then(({ stdout }) => stdout, (error) => `${error.stdout}${error.stderr}`);
  try {
    const found = await lane("search", "--role", "software engineer", "--country", "United States", "--no-profile", "--save");
    assert.match(found, /Looked for software engineer \(United States\)/);
    assert.match(found, /  1\. Acme — Software Engineer, New Grad · Phoenix, AZ/);
    // Senior and abroad are left out.
    assert.doesNotMatch(found, /Beta|Gamma/);
    // Saved, as the dashboard shows them.
    const saved = await (await fetch(`${url}/v1/search/settings`, { headers: { Authorization: `Bearer ${cfg.token}` } })).json();
    assert.deepEqual(saved.settings.roles, ["software engineer"]);
    assert.equal(saved.settings.fromProfile, false);
    assert.match(await lane("search", "add", "1"), /Queued 1 opening/);
    assert.deepEqual(
      (await (await fetch(`${url}/v1/inbox`, { headers: { Authorization: `Bearer ${cfg.token}` } })).json()).map((item: { url: string }) => item.url),
      ["https://acme.example.test/1"],
    );
    assert.match(await lane("search", "add", "9"), /Give the numbers of openings to queue, 1 to 1/);
    // Tracked after the search ran, at its address with a query: the saved
    // search marks it when read (2026-11-02: one from three days before
    // marked none).
    const auth = { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" };
    const read = async () => (await (await fetch(`${url}/v1/search`, { headers: auth })).json()).listings.map((listing: { tracked?: boolean }) => Boolean(listing.tracked));
    assert.deepEqual(await read(), [false]);
    await fetch(`${url}/v1/queue`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ at: Date.now(), applications: [{ id: "f00dcafe-0000-4000-8000-000000000001", url: "https://ACME.example.test/1/?gh_src=board", company: "Acme", title: "Software Engineer, New Grad", status: "awaiting-user", stage: "applying", note: "Tracked.", needs: [], updatedAt: Date.now(), reports: 0 }] }),
    });
    assert.deepEqual(await read(), [true]);
  } finally {
    server.close();
  }
});

test("the full-screen view's tabs and key hints fit a narrow pane, the selected tab always shown", async () => {
  const { tabStrip, styled } = await import("../scripts/lane-view");
  const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
  const labels = ["needs you", "in progress", "failed", "ready to review", "submitted", "all", "find jobs"].map((name, i) => ` ${name} (${i * 7}) `);
  // Wide enough: every tab, nothing marked as cut.
  assert.equal(plain(tabStrip(labels, 0, 200)), labels.join(" "));
  // A half-width pane (the screenshot of 2026-11-02 had 80 columns): no
  // line wraps, and the first tab is there when it is selected.
  for (const selected of [0, 3, 6]) {
    const strip = plain(tabStrip(labels, selected, 60));
    assert.ok(strip.length <= 60, strip);
    assert.ok(strip.includes(labels[selected].trim()), strip);
  }
  assert.match(plain(tabStrip(labels, 0, 60)), /^ needs you \(0\) .* ›$/);
  assert.match(plain(tabStrip(labels, 6, 60)), /^‹ .* find jobs \(42\) $/);
  assert.ok(plain(tabStrip(labels, 3, 8)).length <= 8);
  assert.equal(plain(styled("←/→ tabs · ↑/↓ select · f fill this step", 20, "\x1b[2m")).length, 20);
  // An opening already tracked says so first, where a cut line keeps it.
  const { openingLine } = await import("../scripts/lane-view");
  const line = openingLine({ company: "GM financial", title: "Data Engineer Intern", locations: ["Arlington, TX"], postedAt: 1, tracked: true }, () => "4 days ago");
  assert.equal(line.slice(0, 30), "✓ tracked · GM financial — Dat");
  assert.equal(openingLine({ company: "Axon", title: "Software Engineer Intern", locations: ["Seattle, WA"] }, () => ""), "Axon — Software Engineer Intern · Seattle, WA");
});

// The command line's colours (2026-11-02): the extension's themes at the
// depth the terminal has, and none when asked or piped. What it says stays
// the same at every depth.
test("the command line picks a colour depth and paints the same text at each", async () => {
  const { colorDepth, createPalette, sgr, tabStrip, terminalTheme, visible } = await import("../scripts/lane-view");
  const { themes } = await import("../src/shared/theme");
  assert.equal(colorDepth({ COLORTERM: "truecolor" }, true), "truecolor");
  assert.equal(colorDepth({ COLORTERM: "24bit", TERM: "xterm" }, true), "truecolor");
  assert.equal(colorDepth({ TERM: "xterm-256color" }, true), "256");
  assert.equal(colorDepth({ TERM: "xterm" }, true), "16");
  assert.equal(colorDepth({ TERM: "dumb" }, true), "none");
  // Piped or tested: plain, unless forced.
  assert.equal(colorDepth({ COLORTERM: "truecolor" }, false), "none");
  assert.equal(colorDepth({ FORCE_COLOR: "1" }, false), "16");
  assert.equal(colorDepth({ FORCE_COLOR: "2" }, false), "256");
  assert.equal(colorDepth({ FORCE_COLOR: "3" }, false), "truecolor");
  assert.equal(colorDepth({ FORCE_COLOR: "0", COLORTERM: "truecolor" }, true), "none");
  // NO_COLOR wins over everything.
  assert.equal(colorDepth({ NO_COLOR: "1", FORCE_COLOR: "3", COLORTERM: "truecolor" }, true), "none");

  assert.equal(sgr("#2f7bff", "truecolor"), "\x1b[38;2;47;123;255m");
  assert.equal(sgr("#2f7bff", "truecolor", "bg"), "\x1b[48;2;47;123;255m");
  assert.match(sgr("#2f7bff", "256"), /^\x1b\[38;5;(\d+)m$/);
  assert.equal(sgr("#ff2e4d", "256"), "\x1b[38;5;197m");
  assert.equal(sgr("#ff2e4d", "16"), "\x1b[91m");
  assert.equal(sgr("#000000", "16", "bg"), "\x1b[40m");
  assert.equal(sgr("#ff2e4d", "none"), "");

  const plain = createPalette(themes.velocity, "none");
  assert.equal(plain.gradient("Application Lane"), "Application Lane");
  assert.equal(plain.chevrons(2), "›››");
  assert.equal(plain.meter(2, 3), "▰▰▱");
  assert.equal(plain.group("failed")("failed"), "failed");
  for (const depth of ["16", "256", "truecolor"] as const) {
    const colors = createPalette(themes.velocity, depth);
    assert.notEqual(colors.gradient("Application Lane"), "Application Lane");
    assert.equal(visible(colors.gradient("Application Lane")), "Application Lane");
    assert.equal(visible(colors.chevrons(4)), "›››");
    assert.equal(visible(colors.meter(5, 3)), "▰▰▰");
    assert.equal(visible(colors.chip(themes.velocity.accent, " all (4) ")), " all (4) ");
    // The tabs say the same, painted or not, and still fit.
    const labels = [" needs you (0) ", " in progress (2) ", " failed (1) ", " find jobs (42) "];
    const painted = tabStrip(labels, 1, 40, { selected: (label) => colors.chip("#2f7bff", label), other: (label, index) => colors.group(["needs you", "in progress", "failed", "find jobs"][index])(label) });
    assert.equal(visible(painted), visible(tabStrip(labels, 1, 40)));
    assert.ok(visible(painted).length <= 40);
  }
  // Velocity's chevrons are its blue and red.
  const chevrons = createPalette(themes.velocity, "truecolor").chevrons(0);
  assert.ok(chevrons.includes("38;2;47;123;255") && chevrons.includes("38;2;255;46;77"));

  assert.equal(terminalTheme(["ui", "--theme", "velocity"], {}), "velocity");
  assert.equal(terminalTheme(["ui"], { LANE_THEME: "Ember" }), "ember");
  assert.equal(terminalTheme(["ui"], { LANE_THEME: "system" }), "midnight");
  assert.equal(terminalTheme(["ui", "--theme", "neon"], {}), "midnight");
});

test("the full-screen view's live line opens again after the backend drops it", async () => {
  // 2026-11-02: the backend restarted, and the view kept showing the queue of
  // that moment, its applications filling unseen.
  const { liveLine } = await import("../scripts/lane-live");
  const { WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  server.on("connection", (socket) => socket.send(JSON.stringify({ type: "queue", snapshot: { at: Date.now(), applications: [] } })));
  const heard: number[] = [];
  const events: string[] = [];
  const line = await liveLine(`ws://127.0.0.1:${port}`, async () => "token", `http://127.0.0.1:${port}`, (queue) => heard.push(queue.at), {
    onDown: () => events.push("down"),
    onUp: () => events.push("up"),
  }, 50);
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(check());
  };
  try {
    await until(() => heard.length === 1);
    // The backend drops every line, as a restart does.
    for (const client of server.clients) client.terminate();
    await until(() => events.join() === "down,up");
    await until(() => heard.length === 2);
  } finally {
    line.close();
    server.close();
  }
});
