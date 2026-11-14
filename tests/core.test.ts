import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  profileSchema,
  type Field,
  type GenerationRequest,
  type Narrative,
} from "../src/shared/model";
import {
  canonicalURL,
  deterministicAnswer,
  proposals,
} from "../src/shared/matching";
import {
  groundNarrative,
  GenerationQueue,
  provider,
} from "../src/server/generation";
import { configSchema, Store } from "../src/server/store";
import { createApp } from "../src/server/app";
import { extractResume } from "../src/server/documents";

export const profile = profileSchema.parse({
  firstName: "Alex",
  lastName: "Rivera",
  email: "alex@example.test",
  confirmed: true,
  revision: 1,
  city: "Phoenix",
  facts: [
    {
      id: "fact-1",
      text: "Built accessible web applications using TypeScript.",
    },
    { id: "fact-2", text: "Improved application response times by 30%." },
  ],
});
const field = (overrides: Partial<Field> = {}): Field => ({
  id: "email",
  label: "Email",
  kind: "email",
  required: true,
  value: "",
  options: [],
  revision: 1,
  protected: false,
  ...overrides,
});
const request = (
  overrides: Partial<GenerationRequest> = {},
): GenerationRequest => ({
  applicationId: randomUUID(),
  operation: 1,
  profileRevision: 1,
  url: "https://example.test/job/1",
  title: "Frontend Engineer",
  description: "Build accessible applications.",
  // A form that takes a cover letter gets one (wantsLetter).
  fields: [field(), field({ id: "cover", label: "Cover Letter", kind: "file", required: false, documentKind: "cover" })],
  ...overrides,
});
const candidate: Narrative = {
  resume: [
    { factId: "fact-2", text: "Invented a billion dollars." },
    { factId: "fact-1", text: "Invented skill." },
  ],
  coverLetter: [
    {
      text: "I built accessible web applications using TypeScript.",
      factIds: ["fact-1"],
    },
  ],
  answers: [],
};
const config = () =>
  configSchema.parse({
    postingLookup: false,
    token: "test-token-".repeat(7),
    model: "test",
    endpoint: "http://127.0.0.1:9999/v1",
  });
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for behavior.");
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("fills confirmed fields, preserves populated/cleared fields, and only exact options", () => {
  assert.equal(deterministicAnswer(field(), profile), profile.email);
  assert.equal(
    proposals(
      [field({ protected: true }), field({ value: "human@example.test" })],
      profile,
    ).length,
    0,
  );
  assert.equal(
    proposals(
      [field({ label: "Country", kind: "select", options: ["France"] })],
      { ...profile, country: "United States" },
    ).length,
    0,
  );
  assert.equal(
    deterministicAnswer(
      field({ label: "Are you authorized to work here?" }),
      profile,
    ),
    undefined,
  );
  assert.equal(
    deterministicAnswer(field({ label: "Are you authorized to work here?" }), {
      ...profile,
      answers: [
        { question: "Are you authorized to work here?", answer: "Yes" },
      ],
    }),
    "Yes",
  );
});
test("does not conflate similarly named fields in employment and contact sections", () => {
  const p = {
    ...profile,
    work: [
      {
        organization: "Example Ltd",
        title: "Engineer",
        startDate: "2023-01",
        endDate: "",
        details: "",
        location: "Remote",
      },
    ],
  };
  assert.equal(
    deterministicAnswer(
      field({ label: "Company", section: "Work experience", index: 0 }),
      p,
    ),
    "Example Ltd",
  );
  assert.equal(
    deterministicAnswer(
      field({ label: "Company", section: "Work experience", index: 1 }),
      p,
    ),
    undefined,
  );
});
test("canonicalizes tracking but preserves application identity and route hashes", () => {
  assert.equal(
    canonicalURL("https://jobs.test/app?job=4&utm_source=a#form"),
    "https://jobs.test/app?job=4#form",
  );
  assert.throws(() => canonicalURL("javascript:alert(1)"));
  assert.throws(() => canonicalURL("https://name:pass@jobs.test/"));
});
test("model cannot manufacture claims, select unknown facts, or answer sensitive questions", () => {
  const req = request({
    fields: [
      field({ id: "s", label: "Visa sponsorship", kind: "text" }),
      field({ id: "n", label: "Describe your experience", kind: "textarea" }),
      field({ id: "p", label: "Describe a project you are proud of", kind: "textarea" }),
    ],
  });
  const grounded = groundNarrative(
    {
      ...candidate,
      answers: [
        { fieldId: "s", value: "No", factIds: ["fact-1"] },
        { fieldId: "n", value: "I was the CEO", factIds: ["fact-2"] },
        { fieldId: "p", value: "", factIds: ["fact-2"] },
      ],
    },
    profile,
    req,
  );
  assert.equal(grounded.resume[0].text, profile.facts[1].text);
  // The written answer with an invented claim is not delivered; a warning
  // names the claim for the applicant. The sensitive question gets nothing,
  // and an answer given as facts only is those facts.
  assert.ok(!JSON.stringify(grounded.answers).includes("CEO"));
  assert.ok(!JSON.stringify(grounded).includes("billion"));
  assert.match(grounded.warnings!.join(" "), /Left "Describe your experience" for you: .*CEO/);
  assert.deepEqual(
    grounded.answers.map((a) => [a.fieldId, a.value]),
    [["p", profile.facts[1].text]],
  );
  assert.throws(() =>
    groundNarrative(
      { ...candidate, resume: [{ factId: "fake", text: "fake" }] },
      profile,
      req,
    ),
  );
  // A written letter is delivered as written, but a claim the confirmed facts
  // do not contain is named so the applicant sees it before submitting.
  const invented = groundNarrative(
    {
      ...candidate,
      coverLetter: [
        {
          text: "I was your CTO at Initech and cut costs by 85%.",
          factIds: ["fact-1"],
        },
      ],
    },
    profile,
    req,
  );
  assert.match(invented.coverLetter[1].text, /I was your CTO/);
  const warning = invented.warnings!.join(" ");
  assert.match(warning, /CTO/);
  assert.match(warning, /Initech/);
  assert.match(warning, /85%/);
});
test("generation runs concurrently, idempotently, produces readable PDF/DOCX, and cancels late results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lane-core-"));
  const store = new Store(directory);
  await store.init();
  store.data.profile = profile;
  let current = 0,
    maximum = 0;
  const queue = new GenerationQueue(store, config(), async (req, p) => {
    current++;
    maximum = Math.max(maximum, current);
    await new Promise((r) => setTimeout(r, 100));
    // Held until a second job is running beside it, for up to two seconds.
    // On a loaded Windows disk, saving the next job took longer than the
    // 100 ms above, and the two never overlapped though nothing stopped them.
    for (let waited = 0; maximum < 2 && waited < 2000; waited += 20) await new Promise((r) => setTimeout(r, 20));
    current--;
    return groundNarrative(candidate, p, req);
  });
  const firstReq = request();
  const first = await queue.enqueue(firstReq);
  assert.equal((await queue.enqueue(firstReq)).id, first.id);
  const second = await queue.enqueue(request());
  const third = await queue.enqueue(request());
  await queue.cancel(third.id);
  await waitFor(
    () => first.status === "complete" && second.status === "complete",
  );
  assert.equal(maximum, 2);
  assert.equal(third.status, "cancelled");
  assert.equal(first.artifacts.length, 4);
  for (const artifact of first.artifacts) {
    const bytes = await readFile(
      join(directory, "artifacts", `${artifact.id}.${artifact.format}`),
    );
    assert.ok(bytes.length > 1000);
    const text = await extractResume(bytes, artifact.format);
    assert.match(text, /Alex Rivera/);
    assert.match(text, /TypeScript|response times/);
    assert.equal(artifact.applicationId, firstReq.applicationId);
  }
  const late = await queue.enqueue(request());
  await queue.cancel(late.id);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(late.status, "cancelled");
  assert.equal(late.artifacts.length, 0);
});
test("restart never resumes an interrupted backend generation silently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lane-restart-"));
  const store = new Store(directory);
  await store.init();
  store.data.jobs.push({
    id: randomUUID(),
    applicationId: randomUUID(),
    operation: 1,
    profileRevision: 0,
    status: "running",
    artifacts: [],
    createdAt: Date.now(),
  });
  await store.save();
  const restarted = new Store(directory);
  await restarted.init();
  assert.equal(restarted.data.jobs[0].status, "failed");
  assert.match(restarted.data.jobs[0].error!, /restarted/);
});
test("HTTP API rejects page origins, wrong tokens, cross-extension pairing, malformed bodies and stale profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lane-api-"));
  const cfg = config();
  const { server, store } = await createApp(cfg, directory);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    "Content-Type": "application/json",
  };
  try {
    assert.equal((await fetch(`${url}/v1/profile`)).status, 401);
    assert.equal(
      (
        await fetch(`${url}/v1/profile`, {
          headers: { ...headers, Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${url}/v1/pair`, {
          method: "POST",
          headers: {
            ...headers,
            Origin: `chrome-extension://${"a".repeat(32)}`,
          },
          body: JSON.stringify({ extensionId: "a".repeat(32) }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${url}/v1/profile`, {
          headers: {
            ...headers,
            Origin: `chrome-extension://${"b".repeat(32)}`,
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(`${url}/v1/jobs`, { method: "POST", headers, body: "{}" }))
        .status,
      400,
    );
    const saved = await fetch(`${url}/v1/profile`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...profile, revision: 0 }),
    });
    assert.equal(saved.status, 200);
    assert.equal(
      (
        await fetch(`${url}/v1/profile`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ ...profile, revision: 0 }),
        })
      ).status,
      400,
    );
    assert.equal(store.data.profile.revision, 1);
    assert.equal(
      (await fetch(`${url}/v1/artifacts/${randomUUID()}`, { headers })).status,
      404,
    );
    assert.equal(
      (await fetch(`${url}/v1/data`, { method: "DELETE", headers })).status,
      200,
    );
    assert.equal(store.data.profile.confirmed, false);
    assert.ok((await readdir(directory)).includes("config.json"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("issue reports persist locally, export intact, delete individually, and clear with local data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lane-issues-"));
  const cfg = config();
  const { server } = await createApp(cfg, directory);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    "Content-Type": "application/json",
  };
  const id = randomUUID();
  const report = {
    id,
    createdAt: Date.now(),
    category: "wrong-value",
    note: "The city field was incorrect.",
    tab: {
      tabId: 4,
      url: "https://jobs.example.test/application",
      title: "Application",
    },
    extension: { version: "0.1.0", contentVersion: "test" },
    frames: [{ url: "https://jobs.example.test/application", html: "<input data-lane-value=\"Phoenix\">" }],
  };
  const recording = { id: randomUUID(), createdAt: Date.now(), durationMs: 1,
    tab: { url: report.tab.url, title: report.tab.title }, pages: [report.tab.url], eventCount: 0, events: [] };
  const har = { log: { version: "1.2", entries: [{ request: { url: report.tab.url } }] } };
  try {
    assert.equal(
      (
        await fetch(`${url}/v1/issues`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...report, recordingId: recording.id,
            network: { entries: 1, fromLoad: false }, har, recording }),
        })
      ).status,
      201,
    );
    const listed = await (await fetch(`${url}/v1/issues`, { headers })).json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].frames, undefined);
    const exported = await (
      await fetch(`${url}/v1/issues/${id}`, { headers })
    ).json();
    assert.equal(exported.frames[0].html, report.frames[0].html);
    // A published report must already have its replay and recording on disk.
    assert.deepEqual(JSON.parse(await readFile(join(directory, "issues", `${id}.har.json`), "utf8")), har);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "recordings", `${recording.id}.json`), "utf8")), recording);
    assert.equal(exported.har, undefined);
    // Screenshots pasted into a report are files beside it, named in it,
    // and go when it goes.
    const pictured = randomUUID();
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const withImages = await fetch(`${url}/v1/issues`, { method: "POST", headers,
      body: JSON.stringify({ ...report, id: pictured, images: [{ mime: "image/png", data: png.toString("base64") }, { mime: "image/jpeg", data: "/9j/4AAQ" }] }) });
    assert.equal(withImages.status, 201);
    const picturedReport = await (await fetch(`${url}/v1/issues/${pictured}`, { headers })).json();
    assert.deepEqual(picturedReport.images, [`${pictured}.image-1.png`, `${pictured}.image-2.jpg`]);
    assert.deepEqual(await readFile(join(directory, "issues", `${pictured}.image-1.png`)), png);
    // Not an image type, or not base64: refused.
    for (const images of [[{ mime: "text/html", data: "PGI+" }], [{ mime: "image/png", data: "<script>" }]])
      assert.notEqual((await fetch(`${url}/v1/issues`, { method: "POST", headers, body: JSON.stringify({ ...report, id: randomUUID(), images }) })).status, 201);
    assert.equal((await fetch(`${url}/v1/issues/${pictured}`, { method: "DELETE", headers })).status, 200);
    await assert.rejects(readFile(join(directory, "issues", `${pictured}.image-1.png`)));
    const blockedId = randomUUID();
    await mkdir(join(directory, "issues", `${blockedId}.har.json`));
    const rejected = await fetch(`${url}/v1/issues`, { method: "POST", headers,
      body: JSON.stringify({ ...report, id: blockedId, har, network: { entries: 1, fromLoad: false } }) });
    assert.notEqual(rejected.status, 201);
    assert.equal((await fetch(`${url}/v1/issues/${blockedId}`, { headers })).status, 404);
    assert.equal(
      (
        await fetch(`${url}/v1/issues/${id}`, {
          method: "DELETE",
          headers,
        })
      ).status,
      200,
    );
    assert.equal(
      (await fetch(`${url}/v1/issues/${id}`, { headers })).status,
      404,
    );
    await fetch(`${url}/v1/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...report, id: randomUUID() }),
    });
    await fetch(`${url}/v1/data`, { method: "DELETE", headers });
    assert.deepEqual(
      await (await fetch(`${url}/v1/issues`, { headers })).json(),
      [],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("OpenAI-compatible transport uses compact JSON contracts, retries throttling, and recovers malformed output", async () => {
  let calls = 0;
  let mode = "valid";
  let payload: any;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    payload = JSON.parse(Buffer.concat(chunks).toString());
    calls++;
    if (calls === 1) {
      res.writeHead(429, { "Retry-After": "1" });
      res.end("{}");
      return;
    }
    if (mode === "unauthorized") {
      res.writeHead(401);
      res.end('{"private":"not surfaced"}');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                mode === "invalid" ? "not JSON" : JSON.stringify(candidate),
            },
          },
        ],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const generate = provider({
      ...config(),
      endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    });
    const output = await generate(
      request(),
      profile,
      new AbortController().signal,
    );
    assert.equal(calls, 2);
    assert.equal(payload.model, "test");
    assert.equal(payload.response_format.type, "json_object");
    assert.match(payload.messages[0].content, /UNTRUSTED DATA/);
    assert.deepEqual(JSON.parse(payload.messages[1].content).fields, []);
    assert.equal(payload.max_tokens, 4000);
    assert.equal(output.resume[0].text, profile.facts[1].text);
    mode = "invalid";
    const fallback = await generate(
      request(),
      profile,
      new AbortController().signal,
    );
    assert.match(fallback.warnings!.join(" "), /Local fallback draft/);
    assert.deepEqual(fallback.answers, []);
    mode = "unauthorized";
    await assert.rejects(
      generate(request(), profile, new AbortController().signal),
      /HTTP 401/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a stored profile that fails validation does not stop the backend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lane-legacy-"));
  // A legacy row without endDate, plus a confirmed flag that must not survive.
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({
      profile: {
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
        confirmed: true,
        facts: [],
        work: [{ organization: "Acme", title: "Intern", startDate: "2024-01" }],
      },
      jobs: [],
    }),
  );
  const store = new Store(directory);
  await store.init();
  assert.equal(store.data.profile.firstName, "Alex");
  assert.equal(store.data.profile.email, "alex@example.test");
  assert.equal(store.data.profile.confirmed, false, "must be reconfirmed");
  assert.deepEqual(store.data.profile.work, []);
  // Profiles saved before references existed keep working.
  assert.deepEqual(store.data.profile.references, []);
});

test("professional references round-trip and drop only the invalid entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lane-references-"));
  const store = new Store(directory);
  await store.init();
  const references = [
    {
      name: "Jordan Chen",
      relationship: "Director of Engineering, Example Labs",
      phone: "4805550111",
      email: "jordan@example.test",
    },
    // A reference with no phone on file is still worth keeping.
    { name: "Priya Raman", relationship: "Mentor", phone: "", email: "" },
  ];
  store.data.profile = profileSchema.parse({ ...profile, references });
  await store.save();
  const reopened = new Store(directory);
  await reopened.init();
  assert.deepEqual(reopened.data.profile.references, references);
  assert.throws(() =>
    profileSchema.parse({
      ...profile,
      references: [{ name: "Jordan Chen", email: "not-an-address" }],
    }),
  );
});

test("a preferred first name falls back to the first name", () => {
  assert.equal(
    deterministicAnswer(field({ label: "Preferred First Name" }), profile),
    profile.firstName,
  );
  assert.equal(
    deterministicAnswer(field({ label: "Preferred Name" }), {
      ...profile,
      preferredName: "Lex",
    }),
    "Lex",
  );
});

test("degree candidates spell the degree out before abbreviations", async () => {
  const { selectorValues } = await import("../src/engine/values");
  const values = selectorValues(
    "degree",
    {
      path: ".",
      values: { "2": ["MS", "MA", "MFA", "Master's degree", "Masters", "Master's"], "17": ["Master of Science", "M.S.", "MS"] },
    } as never,
    { ...profile, education: [{ organization: "MSU", title: "Master of Science", fieldOfStudy: "", startDate: "", endDate: "", location: "", details: "" }] },
    { fieldNameAliases: {}, countries: {}, regionsByCountry: {} } as never,
    { collection: "education", index: 0 },
  );
  const firstAbbreviation = values.findIndex((value) => !/[a-z]{3}/.test(value));
  assert.ok(firstAbbreviation > 0, JSON.stringify(values));
  assert.ok(values.slice(firstAbbreviation).every((value) => !/[a-z]{3}/.test(value)), JSON.stringify(values));
  assert.ok(values.includes("MS"));
});

test("a legal-name question asked as a sentence gets the applicant's full name, a signature does not", () => {
  const name = `${profile.firstName} ${profile.lastName}`;
  for (const label of ["Please state your full legal name:", "Full legal name", "Enter your legal name", "Your full name"])
    assert.equal(deterministicAnswer(field({ label, kind: "text" }), profile), name, label);
  // Typing a name to sign stays the applicant's own act.
  assert.equal(deterministicAnswer(field({ label: "Type your full legal name as your signature", kind: "text" }), profile), undefined);
  assert.equal(deterministicAnswer(field({ label: "Name of your current manager", kind: "text" }), profile), undefined);
});
