import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app";
import { configSchema } from "../src/server/store";

// The history of applications that went in (SubmissionRecord): kept apart
// from the list being worked on, so removing or archiving one leaves it.
test("the submissions history keeps each application once, with the date it first went in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lane-submissions-"));
  const cfg = configSchema.parse({ postingLookup: false, token: "test-token-".repeat(7), model: "test", endpoint: "http://127.0.0.1:9999/v1" });
  const { server } = await createApp(cfg, directory);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" };
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(`${url}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }).then((response) => response.json());
  const record = (id: string, submittedAt: number, confirmedBySite = false) => ({
    applicationId: id, company: "Acme", title: "Engineer", url: "https://jobs.example/acme", submittedAt, confirmedBySite,
  });
  const a = "00000000-0000-4000-8000-00000000000a";
  const b = "00000000-0000-4000-8000-00000000000b";
  try {
    assert.deepEqual(await call("/v1/submissions"), []);
    await call("/v1/submissions", "POST", { entries: [record(a, 2000), record(b, 1000, true)] });
    // A backfill sends them again later: the first date and a site's
    // confirmation stand.
    await call("/v1/submissions", "POST", { entries: [record(a, 5000, true), record(b, 9000, false)] });
    assert.deepEqual(
      (await call("/v1/submissions")).map((r: { applicationId: string; submittedAt: number; confirmedBySite: boolean }) => [r.applicationId, r.submittedAt, r.confirmedBySite]),
      [[a, 2000, true], [b, 1000, true]],
    );
    // Moved back out of Submitted: it leaves the history.
    await call(`/v1/submissions/${a}`, "DELETE");
    assert.deepEqual((await call("/v1/submissions")).map((r: { applicationId: string }) => r.applicationId), [b]);
    // Deleting all data deletes the history too.
    await call("/v1/data", "DELETE");
    assert.deepEqual(await call("/v1/submissions"), []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
