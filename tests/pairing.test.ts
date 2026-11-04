import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createApp } from "../src/server/app";
import { configSchema } from "../src/server/store";
import { Pairing, PAIRING_LOCKOUT_MS, PAIRING_WINDOW_MS, type PairingAnnouncement } from "../src/server/pairing";

const EXTENSION = "a".repeat(32);
const OTHER = "b".repeat(32);

async function backend(extra: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "lane-pairing-"));
  const config = configSchema.parse({ postingLookup: false, token: "pair-token-".repeat(7), ...extra });
  const shown: PairingAnnouncement[] = [];
  const app = await createApp(config, directory, undefined, { announcePairing: (a) => shown.push(a) });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const port = (app.server.address() as any).port;
  const call = async (path: string, init: { method?: string; origin?: string; body?: unknown; token?: string; host?: string } = {}) => {
    // node:http, so the Host and Origin headers are exactly what is given.
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method: init.method || "GET",
          headers: {
            Host: init.host || `127.0.0.1:${port}`,
            "Content-Type": "application/json",
            ...(init.origin ? { Origin: init.origin } : {}),
            ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
        },
      );
      req.on("error", reject);
      req.end(init.body === undefined ? undefined : JSON.stringify(init.body));
    });
  };
  const pair = (code: string, extensionId = EXTENSION, origin = `chrome-extension://${extensionId}`) =>
    call("/v1/pair/request", { method: "POST", origin, body: { extensionId, code } });
  const close = async () => {
    await new Promise<void>((done) => app.server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  };
  return { ...app, config, directory, shown, call, pair, close };
}

test("an unpaired backend hands its token to the extension that types the code shown in the terminal", async () => {
  const lane = await backend();
  try {
    assert.equal((await lane.call("/v1/hello", { method: "POST", origin: `chrome-extension://${EXTENSION}` })).body.pairing, "closed");
    const { code } = lane.pairing.open("unpaired");
    assert.match(code, /^\d{6}$/);
    assert.equal(lane.shown.length, 1);
    const hello = await lane.call("/v1/hello", { method: "POST", origin: `chrome-extension://${EXTENSION}` });
    assert.equal(hello.status, 200);
    assert.deepEqual({ app: hello.body.app, paired: hello.body.paired, pairing: hello.body.pairing }, { app: "application-lane", paired: false, pairing: "open" });
    // The code may be typed with a space, as the terminal shows it.
    const paired = await lane.pair(`${code.slice(0, 3)} ${code.slice(3)}`);
    assert.equal(paired.status, 200);
    assert.equal(paired.body.token, lane.config.token);
    assert.equal(lane.config.extensionId, EXTENSION);
    assert.equal(JSON.parse(await readFile(join(lane.directory, "config.json"), "utf8")).extensionId, EXTENSION);
    // The token now works, and the code is spent.
    assert.equal((await lane.call("/v1/status", { origin: `chrome-extension://${EXTENSION}`, token: paired.body.token })).status, 200);
    assert.equal((await lane.pair(code)).status, 409);
  } finally {
    await lane.close();
  }
});

test("pairing is refused to pages, the command line, other hosts and a mismatched extension", async () => {
  const lane = await backend();
  try {
    const { code } = lane.pairing.open("unpaired");
    assert.equal((await lane.pair(code, EXTENSION, "https://evil.example")).status, 403);
    assert.equal((await lane.call("/v1/pair/request", { method: "POST", body: { extensionId: EXTENSION, code } })).status, 403);
    assert.equal((await lane.call("/v1/hello", { method: "POST" })).status, 403);
    assert.equal((await lane.pair(code, EXTENSION, `chrome-extension://${OTHER}`)).status, 403);
    assert.equal(
      (await lane.call("/v1/pair/request", { method: "POST", origin: `chrome-extension://${EXTENSION}`, host: "localhost:4318", body: { extensionId: EXTENSION, code } })).status,
      403,
    );
    // None of these used up an attempt or paired anything.
    assert.equal(lane.config.extensionId, undefined);
    assert.equal((await lane.pair(code)).status, 200);
  } finally {
    await lane.close();
  }
});

test("a paired backend refuses another extension until a new code is asked for, then lets it take over", async () => {
  const lane = await backend({ extensionId: EXTENSION });
  try {
    const refused = await lane.pair("123456", OTHER);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /already paired.*--pair/);
    assert.equal((await lane.call("/v1/hello", { method: "POST", origin: `chrome-extension://${OTHER}` })).body.pairing, "closed");
    // Only the command line, holding the token, can open pairing again.
    assert.equal((await lane.call("/v1/pair/open", { method: "POST" })).status, 401);
    assert.equal((await lane.call("/v1/pair/open", { method: "POST", token: lane.config.token, origin: `chrome-extension://${EXTENSION}` })).status, 403);
    const opened = await lane.call("/v1/pair/open", { method: "POST", token: lane.config.token });
    assert.equal(opened.status, 200);
    assert.equal(lane.shown.at(-1)!.code, opened.body.code);
    assert.ok(opened.body.expiresAt > Date.now());
    assert.equal((await lane.pair(opened.body.code, OTHER)).status, 200);
    assert.equal(lane.config.extensionId, OTHER);
    // The old extension's origin is no longer accepted.
    assert.equal((await lane.call("/v1/status", { origin: `chrome-extension://${EXTENSION}`, token: lane.config.token })).status, 403);
  } finally {
    await lane.close();
  }
});

test("wrong codes are limited: the code is retired, a new one shown, and pairing locked for a minute", async () => {
  const lane = await backend();
  try {
    const { code } = lane.pairing.open("unpaired");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 1; attempt < 5; attempt++) assert.equal((await lane.pair(wrong)).status, 403, `attempt ${attempt}`);
    assert.equal((await lane.pair(wrong)).status, 429);
    assert.equal(lane.shown.length, 2);
    assert.equal(lane.shown[1].reason, "rotated");
    // Even the right code, old or new, waits out the lockout.
    assert.equal((await lane.pair(lane.shown[1].code)).status, 429);
    assert.equal((await lane.call("/v1/hello", { method: "POST", origin: `chrome-extension://${EXTENSION}` })).body.pairing, "locked");
    assert.equal(lane.config.extensionId, undefined);
  } finally {
    await lane.close();
  }
});

test("a requested code expires after the pairing window; an unpaired one does not", () => {
  let now = 1_000_000;
  const shown: PairingAnnouncement[] = [];
  const pairing = new Pairing((a) => shown.push(a), () => now);
  const unpaired = pairing.open("unpaired");
  now += PAIRING_WINDOW_MS * 3;
  assert.equal(pairing.state, "open");
  assert.deepEqual(pairing.attempt(unpaired.code, false), { ok: true });
  const requested = pairing.open("requested");
  now += PAIRING_WINDOW_MS + 1;
  assert.equal(pairing.state, "closed");
  assert.equal(pairing.attempt(requested.code, true).ok, false);
  // After a lockout the rotated code works.
  const again = pairing.open("requested");
  for (let i = 0; i < 5; i++) pairing.attempt(again.code === "999999" ? "000000" : "999999", true);
  assert.equal(pairing.state, "locked");
  now += PAIRING_LOCKOUT_MS + 1;
  assert.deepEqual(pairing.attempt(shown.at(-1)!.code, true), { ok: true });
});
