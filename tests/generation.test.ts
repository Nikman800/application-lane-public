import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  profileSchema,
  narrativeSchema,
  type Field,
  type GenerationRequest,
} from "../src/shared/model";
import {
  GenerationQueue,
  greetingCompany,
  provider,
  unsupportedClaims,
} from "../src/server/generation";
import { configSchema, Store } from "../src/server/store";
import { extractResume } from "../src/server/documents";

const profile = profileSchema.parse({
  firstName: "Alex",
  lastName: "Fixture",
  email: "test@example.test",
  confirmed: true,
  revision: 1,
  facts: [
    {
      id: "original-a",
      text: "Built TypeScript interfaces and automated tests.",
    },
    { id: "original-b", text: "Improved application response times by 30%." },
    { id: "original-c", text: "Organized weekly team meetings." },
  ],
});
const field = (overrides: Partial<Field> = {}): Field => ({
  id: "0|experience",
  label: "Describe your experience",
  kind: "textarea",
  required: false,
  value: "",
  options: [],
  revision: 1,
  protected: false,
  ...overrides,
});
const request = (fields: Field[] = []): GenerationRequest => ({
  applicationId: randomUUID(),
  operation: 1,
  profileRevision: 1,
  title: "TypeScript Engineer",
  description: "Build TypeScript interfaces and automated tests.",
  url: "https://example.test/job",
  fields,
});
const signal = () => new AbortController().signal;
async function transport(
  t: TestContext,
  respond: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(respond);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return configSchema.parse({
    postingLookup: false,
    token: "synthetic-token-".repeat(4),
    model: "fixture",
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
  });
}
const reply = (
  res: ServerResponse,
  content: unknown,
  finish_reason = "stop",
) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        { finish_reason, message: { content: JSON.stringify(content) } },
      ],
    }),
  );
};
const compact = { resume: ["f2", "f1"], coverLetter: ["f1"], answers: [] };
const quiet = { diagnostic: () => {} };

test("missing resume factId recovers exact confirmed text and drops invented claims", async (t) => {
  const config = await transport(t, (_, res) =>
    reply(res, {
      resume: [
        { factId: "original-b", text: "Invented replacement claim" },
        { text: profile.facts[0].text },
        { text: "I invented a billion dollars." },
        { factId: "unknown", text: "Unverified experience" },
      ],
      coverLetter: [],
      answers: [],
    }),
  );
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.deepEqual(
    result.resume.map((f) => f.factId),
    ["original-b", "original-a"],
  );
  assert.deepEqual(
    result.resume.map((f) => f.text),
    [profile.facts[1].text, profile.facts[0].text],
  );
  assert.ok(result.coverLetter.length > 2);
  assert.match(result.warnings!.join(" "), /repaired/);
  assert.doesNotMatch(JSON.stringify(result), /invented|Unverified/i);
  narrativeSchema.parse(result);
});

test("empty coverLetter uses selected resume evidence without discarding valid AI ordering", async (t) => {
  const config = await transport(t, (_, res) =>
    reply(res, { ...compact, coverLetter: [] }),
  );
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.equal(result.resume[0].factId, "original-b");
  assert.deepEqual(
    result.coverLetter.flatMap((p) => p.factIds),
    ["original-b", "original-a"],
  );
  assert.match(result.warnings!.join(" "), /repaired/);
});

test("compact prompt sends short IDs and only unanswered nonsensitive narrative questions", async (t) => {
  let body: any;
  const config = await transport(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
    reply(res, { ...compact, answers: [{ fieldId: "q1", factIds: ["f1"] }] });
  });
  const fields = [
    field(),
    field({ id: "filled", value: "private existing text" }),
    field({ id: "locked", protected: true }),
    field({ id: "sensitive", label: "Describe your visa sponsorship needs" }),
    field({ id: "password", kind: "password" }),
    field({ id: "select", options: ["Yes", "No"] }),
  ];
  const result = await provider(config, quiet)(
    request(fields),
    profile,
    signal(),
  );
  const input = JSON.parse(body.messages[1].content);
  assert.deepEqual(input.fields, [
    { id: "q1", label: "Describe your experience" },
  ]);
  // Answers are asked for before the letter's plan: a plan that runs away
  // to the token cap must not take the answers with it.
  const shape = body.messages[0].content;
  assert.ok(shape.indexOf('"answers"') < shape.indexOf('"letterPlan"'));
  assert.equal(input.facts[0].id, "f1");
  assert.equal(body.max_tokens, 4000);
  assert.doesNotMatch(
    JSON.stringify(body),
    /private existing text|original-a|0\|experience/,
  );
  assert.deepEqual(result.answers, [
    {
      fieldId: "0|experience",
      factIds: ["original-a"],
      value: profile.facts[0].text,
    },
  ]);
  assert.equal(result.warnings, undefined);
});

for (const [name, content, finish] of [
  [
    "unknown facts",
    { resume: ["not-a-fact"], coverLetter: ["unknown"] },
    "stop",
  ],
  ["null JSON", null, "stop"],
  ["wrong field types", { resume: { factId: "f1" }, coverLetter: 4 }, "stop"],
] as const) {
  test(`${name} produces an explicitly labeled local draft with no narrative answers`, async (t) => {
    const config = await transport(t, (_, res) => reply(res, content, finish));
    const result = await provider(config, quiet)(
      request([field()]),
      profile,
      signal(),
    );
    assert.match(result.warnings!.join(" "), /Local fallback draft/);
    assert.equal(result.resume[0].factId, "original-a");
    assert.deepEqual(result.answers, []);
    for (const f of result.resume)
      assert.ok(
        profile.facts.some((p) => p.id === f.factId && p.text === f.text),
      );
    narrativeSchema.parse(result);
  });
}

for (const phase of ["headers", "body"] as const) {
  test(`provider ${phase} timeout releases the lane into a local draft within its total budget`, async (t) => {
    const config = await transport(t, (_, res) => {
      if (phase === "body") {
        res.writeHead(200);
        res.write('{"choices":[');
      }
    });
    const logs: unknown[] = [];
    const started = Date.now();
    const result = await provider(config, {
      timeoutMs: 150,
      diagnostic: (e) => logs.push(e),
    })(request(), profile, signal());
    assert.ok(Date.now() - started < 2000);
    assert.match(
      result.warnings!.join(" "),
      /time budget.*Local fallback draft/,
    );
    assert.match(JSON.stringify(logs), /"reason":"timeout"/);
    assert.doesNotMatch(
      JSON.stringify(logs),
      /synthetic-token|original-a|TypeScript|example.test/,
    );
  });
}

test("cancellation during provider response or retry backoff never produces a fallback", async (t) => {
  for (const retry of [false, true]) {
    let began!: () => void;
    const started = new Promise<void>((r) => {
      began = r;
    });
    const config = await transport(t, (_, res) => {
      if (retry) {
        res.writeHead(429, { "Retry-After": "1" });
        res.end("{}");
      }
      began();
    });
    const controller = new AbortController();
    const task = provider(config, { ...quiet, timeoutMs: 1000 })(
      request(),
      profile,
      controller.signal,
    );
    await started;
    if (retry) await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    await assert.rejects(task, { name: "AbortError" });
  }
});

test("one total timeout also bounds retry backoff", async (t) => {
  let calls = 0;
  const config = await transport(t, (_, res) => {
    calls++;
    res.writeHead(503, { "Retry-After": "5" });
    res.end("{}");
  });
  const started = Date.now();
  const result = await provider(config, { ...quiet, timeoutMs: 1000 })(
    request(),
    profile,
    signal(),
  );
  assert.ok(Date.now() - started < 3000);
  assert.equal(calls, 1);
  assert.match(result.warnings!.join(" "), /time budget/);
});

test("oversized and malformed upstream bodies never leak raw provider content", async (t) => {
  let oversized = true;
  const diagnostics: unknown[] = [];
  const config = await transport(t, (_, res) => {
    res.writeHead(200);
    res.end(
      oversized
        ? "private-provider-body".repeat(10000)
        : "private malformed provider JSON",
    );
  });
  for (const mode of [true, false]) {
    oversized = mode;
    const result = await provider(config, {
      diagnostic: (e) => diagnostics.push(e),
    })(request(), profile, signal());
    assert.match(result.warnings!.join(" "), /Local fallback draft/);
    assert.doesNotMatch(
      JSON.stringify({ result, diagnostics }),
      /private-provider-body|private malformed/,
    );
  }
});

test("short reference aliases do not collide with existing profile or field IDs", async (t) => {
  const collisionProfile = {
    ...profile,
    facts: profile.facts.map((f, i) => ({ ...f, id: ["f1", "_f1", "f3"][i] })),
  };
  const config = await transport(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(
      JSON.parse(Buffer.concat(chunks).toString()).messages[1].content,
    );
    reply(res, {
      resume: [input.facts[1].id, input.facts[0].id],
      coverLetter: [input.facts[2].id],
      answers: [{ fieldId: input.fields[0].id, factIds: [input.facts[1].id] }],
    });
  });
  const result = await provider(config, quiet)(
    request([field({ id: "q1" }), field({ id: "_q1", protected: true })]),
    collisionProfile,
    signal(),
  );
  assert.deepEqual(
    result.resume.map((f) => f.factId),
    ["_f1", "f1"],
  );
  assert.deepEqual(
    result.coverLetter.flatMap((p) => p.factIds),
    ["f3"],
  );
  assert.equal(result.answers[0].fieldId, "q1");
  assert.equal(result.answers[0].value, profile.facts[1].text);
  assert.equal(result.warnings, undefined);
});

test("long confirmed facts cannot exceed the narrative answer contract", async (t) => {
  const longProfile = {
    ...profile,
    facts: profile.facts.map((f) => ({ ...f, text: f.text.padEnd(3000, "x") })),
  };
  const config = await transport(t, (_, res) =>
    reply(res, {
      ...compact,
      answers: [{ fieldId: "q1", factIds: ["f1", "f2", "f3"] }],
    }),
  );
  const result = await provider(config, quiet)(
    request([field()]),
    longProfile,
    signal(),
  );
  narrativeSchema.parse(result);
  assert.equal(result.answers[0].value, longProfile.facts[0].text);
});

test("authentication errors stay actionable and a long retry-after falls back without immediate retries", async (t) => {
  let status = 401;
  let calls = 0;
  const config = await transport(t, (_, res) => {
    calls++;
    res.writeHead(status, { "Retry-After": "90" });
    res.end('{"error":"private upstream details"}');
  });
  await assert.rejects(
    provider(config, quiet)(request(), profile, signal()),
    /HTTP 401/,
  );
  status = 429;
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.equal(calls, 2);
  assert.match(result.warnings!.join(" "), /Local fallback draft/);
  assert.doesNotMatch(JSON.stringify(result), /private upstream details/);
});

test("recovered queue jobs render real documents; cancelled and superseded jobs cannot authorize artifacts", async (t) => {
  const config = await transport(t, (_, res) =>
    reply(res, { ...compact, coverLetter: [] }),
  );
  const directory = await mkdtemp(join(tmpdir(), "lane-generation-recovery-"));
  const store = new Store(directory);
  await store.init();
  store.data.profile = structuredClone(profile);
  const queue = new GenerationQueue(store, config, provider(config, quiet));
  // A form that takes a cover letter, so the recovered letter is rendered.
  const job = await queue.enqueue(
    request([{ id: "cover", label: "Cover Letter", kind: "file", required: false, value: "", options: [], revision: 1, protected: false, documentKind: "cover" }]),
  );
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!check()) {
      assert.ok(Date.now() < deadline, "job must settle");
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  await waitFor(() => !["queued", "running"].includes(job.status));
  assert.equal(job.status, "complete", job.error);
  assert.match(job.narrative!.warnings!.join(" "), /repaired/);
  assert.equal(job.artifacts.length, 4);
  for (const artifact of job.artifacts) {
    const bytes = await readFile(
      join(directory, "artifacts", `${artifact.id}.${artifact.format}`),
    );
    assert.match(await extractResume(bytes, artifact.format), /Alex Fixture/);
  }
  const slowConfig = await transport(t, () => {});
  const slow = new GenerationQueue(
    store,
    slowConfig,
    provider(slowConfig, { ...quiet, timeoutMs: 150 }),
  );
  const cancelled = await slow.enqueue(request());
  await slow.cancel(cancelled.id);
  const superseded = await slow.enqueue(request());
  store.data.profile.revision++;
  await waitFor(() => !["queued", "running"].includes(superseded.status));
  await slow.cancelAll();
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.artifacts, []);
  assert.equal(superseded.status, "failed");
  assert.deepEqual(superseded.artifacts, []);
  assert.equal(superseded.narrative, undefined);
});

test("a written cover letter is kept, under our own greeting", async (t) => {
  const config = await transport(t, (_, res) =>
    reply(res, {
      resume: ["f2", "f1"],
      coverLetter: [
        {
          text: "I improved application response times by 30% on a TypeScript codebase.",
          factIds: ["f2", "f1"],
        },
        {
          text: "I also built TypeScript interfaces and automated tests.",
          factIds: ["f1"],
        },
      ],
      answers: [],
    }),
  );
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.equal(result.warnings, undefined);
  assert.match(result.coverLetter[0].text, /^Dear Hiring Team,$/);
  assert.match(
    result.coverLetter[1].text,
    /improved application response times/,
  );
  assert.match(result.coverLetter[2].text, /automated tests/);
  // Greeting plus the two written paragraphs. A letter that writes its own
  // ending does not also get the assembled one; the document adds the sign-off.
  assert.equal(result.coverLetter.length, 3);
  assert.ok(!result.coverLetter.some((p) => /I would welcome/.test(p.text)));
  assert.deepEqual(result.coverLetter[1].factIds, ["original-b", "original-a"]);
});

test("a cover letter claim outside the confirmed facts is named for the applicant", async (t) => {
  const config = await transport(t, (_, res) =>
    reply(res, {
      resume: ["f1"],
      coverLetter: [
        {
          text: "At Initech I led a team of 40 engineers and cut latency by 85%.",
          factIds: ["f1"],
        },
      ],
      answers: [],
    }),
  );
  const result = await provider(config, quiet)(request(), profile, signal());
  const warning = result.warnings!.join(" ");
  assert.match(warning, /Initech/);
  assert.match(warning, /85%|40/);
  // The draft is still delivered; the applicant decides what to do with it.
  assert.match(result.coverLetter[1].text, /At Initech/);
});

test("an unranked selection is ranked locally instead of trusting its order", async (t) => {
  const many = profileSchema.parse({
    ...profile,
    facts: Array.from({ length: 30 }, (_, i) => ({
      id: `fact-${i}`,
      // Only the last fact mentions the job's words, so ranking must find it.
      text:
        i === 29
          ? "Built TypeScript interfaces and automated tests for a large app."
          : `Unrelated activity number ${i}.`,
    })),
  });
  const config = await transport(t, (_, res) =>
    reply(res, {
      resume: Array.from({ length: 30 }, (_, i) => `f${i + 1}`),
      coverLetter: [],
      answers: [],
    }),
  );
  const result = await provider(config, quiet)(request(), many, signal());
  assert.equal(result.resume[0].factId, "fact-29");
  assert.deepEqual(result.coverLetter[1].factIds, ["fact-29"]);
  assert.match(result.warnings!.join(" "), /unranked/i);
});

// The configured endpoint sometimes runs to the token cap mid-object.
const rawReply = (res: ServerResponse, content: string) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ finish_reason: "length", message: { content } }],
    }),
  );
};

test("a response cut at the token cap keeps the ranking and the paragraphs that finished", async (t) => {
  const config = await transport(t, (_, res) =>
    rawReply(
      res,
      '{"resume":["f2","f1"],"coverLetter":[{"text":"I improved application response times by 30%.","factIds":["f2"]},{"text":"I built TypeScript interf',
    ),
  );
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.deepEqual(
    result.resume.map((r) => r.factId),
    ["original-b", "original-a"],
  );
  assert.match(result.coverLetter[1].text, /improved application response/);
  // Greeting, the one paragraph that finished, closing: the half-written
  // paragraph is gone. ("TypeScript interfaces" is also a confirmed fact, so
  // the letter is checked rather than the whole narrative.)
  assert.equal(result.coverLetter.length, 2);
  assert.ok(
    !result.coverLetter.some((p) =>
      p.text.includes("I built TypeScript interf"),
    ),
  );
});

test("a response cut before anything finished still falls back to a local draft", async (t) => {
  const config = await transport(t, (_, res) => rawReply(res, '{"resume":["f'));
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.match(result.warnings!.join(" "), /Local fallback draft/);
});

test("citation markers are stripped and a block of paragraphs is split", async (t) => {
  const config = await transport(t, (_, res) =>
    reply(res, {
      resume: ["f2", "f1"],
      coverLetter: [
        {
          text: "I improved application response times by 30% (f2, f1).\n\nI also built TypeScript interfaces and automated tests [f1].",
          factIds: ["f2", "f1"],
        },
      ],
      answers: [],
    }),
  );
  const result = await provider(config, quiet)(request(), profile, signal());
  const body = result.coverLetter.slice(1).map((p) => p.text);
  assert.deepEqual(body, [
    "I improved application response times by 30%.",
    "I also built TypeScript interfaces and automated tests.",
  ]);
  assert.equal(result.warnings, undefined);
});

test("prose that is only citation machinery is dropped, not patched", async (t) => {
  const config = await transport(t, (_, res) =>
    reply(res, {
      resume: ["f2"],
      coverLetter: [{ text: "See f2 and f1 for details.", factIds: ["f2"] }],
      answers: [],
    }),
  );
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.ok(!JSON.stringify(result).includes("See f2"));
  assert.match(result.warnings!.join(" "), /repaired/);
});

test("written answers are delivered when grounded and left for the applicant when not", async (t) => {
  let sent: any;
  const config = await transport(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    sent = JSON.parse(
      JSON.parse(Buffer.concat(chunks).toString()).messages[1].content,
    );
    reply(res, {
      ...compact,
      answers: [
        // Grounded in the facts and the posting; the citation marker comes out.
        {
          fieldId: "q1",
          text: "I want to build TypeScript interfaces and automated tests here, which is the work I already do (f1). Improving response times by 30% taught me to care about speed.",
          factIds: ["f1", "f2"],
        },
        // Names an employer neither the facts nor the posting contain.
        {
          fieldId: "q2",
          text: "I led the platform team at Initech for five years.",
          factIds: ["f1"],
        },
        // Facts alone never answer an opinion question.
        { fieldId: "q3", factIds: ["f1"] },
        // Facts alone still answer a question about work.
        { fieldId: "q4", factIds: ["f2"] },
      ],
    });
  });
  const fields = [
    field({ id: "why", label: "Why are you interested in this position?" }),
    field({ id: "lead", label: "Tell us about your leadership experience" }),
    field({ id: "excites", label: "What excites you about working here?" }),
    field({
      id: "proud",
      label: "What is an accomplishment you are proud of?",
    }),
    field({ id: "powers", label: "What are your superpowers?" }),
  ];
  const result = await provider(config, quiet)(
    request(fields),
    profile,
    signal(),
  );
  // The widened question list reaches the model, with the new answer shape.
  assert.deepEqual(
    sent.fields.map((f: { label: string }) => f.label),
    fields.map((f) => f.label),
  );
  assert.deepEqual(
    result.answers.map((a) => [a.fieldId, a.value]),
    [
      [
        "why",
        "I want to build TypeScript interfaces and automated tests here, which is the work I already do. Improving response times by 30% taught me to care about speed.",
      ],
      ["proud", profile.facts[1].text],
    ],
  );
  assert.match(
    result.warnings!.join(" "),
    /Left "Tell us about your leadership experience" for you: .*Initech/,
  );
});

test("a sentence's capitalised first word is checked by stem, names are not excused", () => {
  const support = profile.facts.map((f) => f.text);
  assert.deepEqual(
    unsupportedClaims(
      "Improving response times by 30% taught me patience.",
      support,
      profile,
    ),
    [],
  );
  assert.deepEqual(
    unsupportedClaims(
      "Initech hired me to improve response times.",
      support,
      profile,
    ),
    ["Initech"],
  );
  assert.deepEqual(
    unsupportedClaims(
      "Kubernetes clusters improved response times by 30%.",
      support,
      profile,
    ),
    ["Kubernetes"],
  );
});

test("a figure inside a product name does not vouch for an invented figure", () => {
  const support = [
    "Benchmarked models on an NVIDIA A100 across a 12-node deployment.",
  ];
  assert.deepEqual(
    unsupportedClaims(
      "I trained on an A100 across 12 nodes.",
      support,
      profile,
    ),
    [],
  );
  assert.deepEqual(
    unsupportedClaims("I kept sub-100ms response times.", support, profile),
    ["100ms"],
  );
  assert.deepEqual(
    unsupportedClaims("Its A100 runs used 12 nodes.", support, profile),
    [],
  );
});

// Stand-ins for the Claude and Codex CLIs: each records how it was called,
// then answers the way the real one does (or fails like a logged-out one).
async function fakeCli(
  t: TestContext,
  kind: "claude" | "codex",
  answer: unknown,
  fail?: string,
  delayMs = 0,
  failModel?: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "lane-fake-cli-"));
  const log = join(directory, "calls.json");
  // Windows runs no shebang: there the stand-in is a .cmd beside the script,
  // as npm installs the real CLIs.
  const windows = process.platform === "win32";
  const script = join(directory, windows ? `${kind}.cmd` : kind);
  if (windows) await writeFile(script, `@"${process.execPath}" "%~dp0${kind}.js" %*\r\n`);
  await writeFile(
    windows ? join(directory, `${kind}.js`) : script,
    `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (c) => (input += c)).on("end", () => {
  const previous = fs.existsSync(${JSON.stringify(log)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(log)}, "utf8")) : { count: 0, models: [] };
  const model = process.argv[process.argv.indexOf("-m") + 1];
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ count: previous.count + 1, models: [...previous.models, model], args: process.argv.slice(2), cwd: process.cwd(), files: fs.readdirSync(process.cwd()), input, codexHome: process.env.CODEX_HOME }));
  setTimeout(() => {
  ${fail ? `if (${failModel ? `model === ${JSON.stringify(failModel)}` : "true"}) { console.error(${JSON.stringify(fail)}); process.exit(1); }` : ""}
  const answer = ${JSON.stringify(JSON.stringify(answer))};
  if (${JSON.stringify(kind)} === "claude")
    console.log(JSON.stringify({ type: "result", is_error: false, result: answer }));
  else fs.writeFileSync(process.argv[process.argv.indexOf("-o") + 1], "Here is the JSON:\\n" + answer);
  }, ${delayMs});
});
`,
    { mode: 0o755 },
  );
  const variable = kind === "claude" ? "LANE_CLAUDE_BIN" : "LANE_CODEX_BIN";
  process.env[variable] = script;
  t.after(async () => {
    delete process.env[variable];
    await rm(directory, { recursive: true, force: true });
  });
  return async () =>
    JSON.parse(await readFile(log, "utf8")) as {
      count: number;
      models: string[];
      args: string[];
      cwd: string;
      files: string[];
      input: string;
      codexHome?: string;
    };
}
const written = {
  resume: ["f2", "f1"],
  coverLetter: [
    { text: "I improved application response times by 30%.", factIds: ["f2"] },
    {
      text: "I built TypeScript interfaces and automated tests.",
      factIds: ["f1"],
    },
  ],
  answers: [],
};

test("claude-cli drafts through a locked-down claude -p, never the endpoint", async (t) => {
  let requests = 0;
  const endpoint = await transport(t, (_, res) => {
    requests++;
    reply(res, compact);
  });
  const calls = await fakeCli(t, "claude", written);
  const config = { ...endpoint, provider: "claude-cli" as const };
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.equal(requests, 0);
  assert.equal(result.warnings, undefined);
  assert.equal(
    result.coverLetter[1].text,
    "I improved application response times by 30%.",
  );
  const call = await calls();
  const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
  assert.equal(flag("--model"), "sonnet");
  assert.equal(flag("--tools"), "");
  assert.equal(flag("--setting-sources"), "project");
  assert.match(flag("--system-prompt"), /^Rank confirmed applicant facts/);
  assert.ok(call.args.includes("--no-session-persistence"));
  // The posting is data on stdin, run from an empty scratch directory.
  assert.match(call.input, /"title":"TypeScript Engineer"/);
  assert.deepEqual(call.files, []);
  assert.notEqual(call.cwd, process.cwd());
});

test("codex-cli drafts through codex exec with the CLI's own model and the chosen effort", async (t) => {
  const endpoint = await transport(t, () =>
    assert.fail("endpoint must not be called"),
  );
  const calls = await fakeCli(t, "codex", written);
  const config = {
    ...endpoint,
    provider: "codex-cli" as const,
    cliEffort: "medium" as const,
  };
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.equal(result.warnings, undefined);
  assert.equal(result.coverLetter.length, 3);
  const call = await calls();
  assert.deepEqual(call.args.slice(0, 5), [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
  ]);
  // No model chosen: Codex's own configured model, so no -m.
  assert.ok(!call.args.includes("-m"));
  assert.ok(call.args.includes("model_reasoning_effort=medium"));
  assert.ok(call.args.includes("--ignore-user-config"));
  assert.ok(call.args.includes("--ignore-rules"));
  assert.ok(call.args.includes("features.shell_tool=false"));
  // The standard tier: the fast one cost more of the weekly limit for every
  // draft and check.
  assert.ok(!call.args.some((arg) => /service_tier/.test(arg)));
  assert.match(
    call.input,
    /^Rank confirmed applicant facts[\s\S]*\n\nINPUT:\n\{"facts"/,
  );
});

for (const failure of ["Model codex-primary-model is not available for this account", "You've hit your usage limit"]) {
  test(`the drafting policy tries the second Codex model before Claude when the first fails: ${failure}`, async (t) => {
    const endpoint = await transport(t, () => assert.fail("the endpoint must not be called"));
    const codex = await fakeCli(t, "codex", written, failure, 0, "codex-primary-model");
    const home = join(tmpdir(), `codex-primary-${randomUUID()}`);
    const config = configSchema.parse({
      ...endpoint,
      draftProviders: [
        { id: "codex-primary", name: "Codex primary", provider: "codex-cli", model: "codex-primary-model", home },
        { id: "codex-second", name: "Codex second", provider: "codex-cli", model: "codex-second-model", home },
        { id: "claude", provider: "claude-cli", model: "sonnet", command: "/nonexistent/claude" },
        { id: "local-endpoint", provider: "http", model: "gemma4-31b-it" },
      ],
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await provider(config, quiet)(request(), profile, signal());
      assert.deepEqual(result.draftedWith, { provider: "codex-cli", model: "codex-second-model", name: "Codex second" });
      assert.equal(result.warnings?.length, 1);
      assert.match(result.warnings![0], /Codex primary could not draft this .* so Codex second was used instead/);
      assert.equal((await codex()).codexHome, home);
    }
    assert.deepEqual((await codex()).models, failure.includes("usage limit")
      ? ["codex-primary-model", "codex-second-model", "codex-second-model"]
      : ["codex-primary-model", "codex-second-model", "codex-primary-model", "codex-second-model"]);
  });
}

test("an ordered policy falls through account-specific Codex to the endpoint and names the provider", async (t) => {
  let sentModel = "";
  const endpoint = await transport(t, (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      sentModel = JSON.parse(body).model;
      reply(res, written);
    });
  });
  const codex = await fakeCli(t, "codex", written);
  const home = join(tmpdir(), "codex-primary-fixture");
  const config = configSchema.parse({
    ...endpoint,
    draftProviders: [
      { id: "codex-other", name: "Codex other login", provider: "codex-cli", model: "other-model", command: "/nonexistent/codex" },
      { id: "codex-primary", name: "Codex primary", provider: "codex-cli", model: "codex-primary-model", effort: "medium", home },
      { id: "local-endpoint", name: "Local endpoint", provider: "http", model: "gemma4-31b-it" },
    ],
  });
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.equal(sentModel, "", "the successful second provider stops the chain");
  assert.deepEqual(result.draftedWith, { provider: "codex-cli", model: "codex-primary-model", name: "Codex primary" });
  assert.match(result.warnings!.join(" "), /Codex other login could not draft this .* so Codex primary was used instead/);
  const call = await codex();
  assert.equal(call.codexHome, home);
  assert.equal(call.args[call.args.indexOf("-m") + 1], "codex-primary-model");
});

test("an ordered policy sends the selected HTTP model rather than the legacy model", async (t) => {
  let sentModel = "";
  const endpoint = await transport(t, (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      sentModel = JSON.parse(body).model;
      reply(res, written);
    });
  });
  const config = configSchema.parse({
    ...endpoint,
    model: "legacy-model",
    draftProviders: [{ id: "local-endpoint", name: "Local endpoint", provider: "http", model: "gemma4-31b-it" }],
  });
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.equal(sentModel, "gemma4-31b-it");
  assert.deepEqual(result.draftedWith, { provider: "http", model: "gemma4-31b-it", name: "Local endpoint" });
});

test("a failed CLI falls back to the endpoint when Codex fallback is disabled", async (t) => {
  let requests = 0;
  const endpoint = await transport(t, (_, res) => {
    requests++;
    reply(res, written);
  });
  await fakeCli(t, "claude", written, "Not logged in · Please run /login");
  const config = { ...endpoint, provider: "claude-cli" as const, codexFallback: false };
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.equal(requests, 1);
  assert.equal(
    result.coverLetter[1].text,
    "I improved application response times by 30%.",
  );
  assert.deepEqual(result.warnings, [
    'Claude could not draft this (not logged in or authentication expired ("Not logged in · Please run /login")), so fixture was used instead.',
  ]);
});

test("a failed CLI with no endpoint model leaves a local draft that says why", async (t) => {
  const endpoint = await transport(t, () =>
    assert.fail("no model, no request"),
  );
  process.env.LANE_CODEX_BIN = "/nonexistent/codex";
  t.after(() => {
    delete process.env.LANE_CODEX_BIN;
  });
  const config = { ...endpoint, model: "", provider: "codex-cli" as const };
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.match(
    result.warnings![0],
    /^Codex could not draft this \(codex is not installed or not on PATH\)/,
  );
  assert.match(result.warnings!.join(" "), /Local fallback draft/);
});

test("Claude's JSON usage-limit error falls back to Codex before the endpoint", async (t) => {
  let requests = 0;
  const endpoint = await transport(t, (_, res) => { requests++; reply(res, written); });
  await fakeCli(t, "claude", written, JSON.stringify({ is_error: true, result: "You've hit your weekly usage limit", session_id: "private-session", usage: {} }));
  const calls = await fakeCli(t, "codex", written);
  const result = await provider({ ...endpoint, provider: "claude-cli", codexFallback: true, codexFallbackModel: "codex-fixture" }, quiet)(request(), profile, signal());
  assert.equal(requests, 0);
  assert.deepEqual(result.warnings, ["Claude could not draft this (usage limit reached), so Codex was used instead."]);
  const call = await calls();
  assert.equal(call.args[call.args.indexOf("-m") + 1], "codex-fixture");
  assert.doesNotMatch(result.warnings!.join(" "), /private-session|usage.*\{/);
});

test("a Codex draft stopped at its time limit says it ran out of time", async (t) => {
  // one employer's fill: Codex was stopped at its limit while the
  // machine was busy, and the notice read "codex exited with an error" with
  // only Codex's opening lines in it.
  const endpoint = await transport(t, () => assert.fail("the endpoint must not be called"));
  await fakeCli(t, "codex", written, undefined, 5000);
  await fakeCli(t, "claude", written);
  const config = configSchema.parse({
    ...endpoint,
    draftProviders: [
      { id: "codex", provider: "codex-cli", model: "codex-primary-model", timeoutMs: 1000 },
      { id: "claude", provider: "claude-cli", model: "sonnet" },
    ],
  });
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.deepEqual(result.warnings, ["Codex could not draft this (it took longer than 1s), so Claude was used instead."]);
});

test("Claude and Codex failures reach the endpoint with one readable notice", async (t) => {
  let requests = 0;
  const endpoint = await transport(t, (_, res) => { requests++; reply(res, written); });
  await fakeCli(t, "claude", written, "You've hit your limit");
  await fakeCli(t, "codex", written, "Not logged in");
  const result = await provider({ ...endpoint, provider: "claude-cli", codexFallback: true }, quiet)(request(), profile, signal());
  assert.equal(requests, 1);
  assert.deepEqual(result.warnings, ["Claude could not draft this (usage limit reached); Codex could not draft this (not logged in or authentication expired (\"Not logged in\")), so fixture was used instead."]);
});

test("usage-limited Claude is skipped for subsequent requests while Codex keeps drafting", async (t) => {
  const endpoint = await transport(t, () => assert.fail("endpoint must not be called"));
  const claude = await fakeCli(t, "claude", written, "You've hit your weekly usage limit");
  const codex = await fakeCli(t, "codex", written);
  const config = { ...endpoint, provider: "claude-cli" as const, codexFallback: true };
  await provider(config, quiet)(request(), profile, signal());
  await provider(config, quiet)(request(), profile, signal());
  assert.equal((await claude()).count, 1);
  assert.equal((await codex()).count, 2);
});

// a hosted endpoint: "fetch failed" on two fills in three, the
// connection dropped before any answer, and fine a second later.
test("a connection dropped before any answer is tried once more", async (t) => {
  let requests = 0;
  const endpoint = await transport(t, (req, res) => {
    requests++;
    if (requests === 1) return req.socket.destroy();
    reply(res, written);
  });
  const config = configSchema.parse({ ...endpoint, draftProviders: [{ id: "endpoint", provider: "http", model: "fixture" }] });
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.equal(requests, 2);
  assert.ok(result.coverLetter.length);
});

test("Codex at its workspace's spend cap is skipped for subsequent requests", async (t) => {
  let requests = 0;
  const endpoint = await transport(t, (_, res) => { requests++; reply(res, written); });
  const codex = await fakeCli(t, "codex", written, "ERROR: You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.");
  const config = configSchema.parse({ ...endpoint, draftProviders: [{ id: "codex", provider: "codex-cli", model: "codex-primary-model" }, { id: "endpoint", provider: "http", model: "fixture" }] });
  const first = await provider(config, quiet)(request(), profile, signal());
  await provider(config, quiet)(request(), profile, signal());
  assert.equal((await codex()).count, 1);
  assert.equal(requests, 2);
  assert.match(first.warnings!.join(" "), /Codex could not draft this \(usage limit reached\)/);
});

test("cancellation while Claude is drafting never calls Codex or the endpoint", async (t) => {
  const endpoint = await transport(t, () => assert.fail("endpoint must not be called"));
  const claude = await fakeCli(t, "claude", written, undefined, 10000);
  const codex = await fakeCli(t, "codex", written);
  const controller = new AbortController();
  const drafted = provider({ ...endpoint, provider: "claude-cli", codexFallback: true }, quiet)(request(), profile, controller.signal);
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await claude(); started = true; break; } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.ok(started);
  controller.abort();
  await assert.rejects(drafted, { name: "AbortError" });
  await assert.rejects(codex(), { code: "ENOENT" });
});

test("the letter greets the company only by a name the posting writes", () => {
  const greet = (company: string, description: string) =>
    greetingCompany({ company, title: "Engineer", description });
  assert.equal(greet("DoorDash", "At DoorDash, we deliver."), "DoorDash");
  // The tracker's name can be a board slug, a host label, or a placeholder.
  assert.equal(greet("Doordashusa", "At DoorDash, we deliver."), "");
  assert.equal(greet("acme", "Join ACME Corp."), "ACME");
  assert.equal(greet("acme", "The acme of design."), "");
  assert.equal(greet("Application", "Submit your Application."), "");
  // Without a posting, the page around the form names the company.
  assert.equal(
    greetingCompany({ company: "zyx", title: "Software Engineering Intern", description: "", pageText: "Interested in building your career at ZYX?" }),
    "ZYX",
  );
});

test("a letter drafted without a posting still names the company the page names", async (t) => {
  let sent: any;
  const config = await transport(t, (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      sent = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ resume: ["f1"], answers: [], coverLetter: [{ text: "I build TypeScript interfaces.", factIds: ["f1"] }] }) } }] }));
    });
  });
  const draft = { ...request(), description: "", company: "zyx", pageText: "Create a Job Alert. Interested in building your career at ZYX?" };
  const narrative = await provider(config, quiet)(draft, profile, signal());
  const input = JSON.parse(sent.messages[1].content);
  assert.equal(input.job.company, "ZYX");
  assert.match(input.notes.join(" "), /name ZYX with the role in the opening sentence/);
  assert.equal(narrative.coverLetter[0].text, "Dear ZYX Hiring Team,");
});

// No longer skipped where the system has no word list (Windows, a cluster's
// container): there "Second, …" withheld a whole drafted answer.
test("an ordinary English word opening a sentence is not a claim, a name still is", () => {
  const support = profile.facts.map((f) => f.text);
  // Sentence openers from real answers that were wrongly dropped.
  for (const sentence of ["Taking ownership mattered.", "Second, I automated tests.", "Measure before optimizing."])
    assert.deepEqual(unsupportedClaims(sentence, support, profile), [], sentence);
  // Names the list only has capitalised (or not at all) are still claims.
  assert.deepEqual(unsupportedClaims("Google hired me to build interfaces.", support, profile), ["Google"]);
  assert.deepEqual(unsupportedClaims("Globex hired me to build interfaces.", support, profile), ["Globex"]);
  // Only a sentence's first word is excused; mid-sentence capitals are checked.
  assert.deepEqual(unsupportedClaims("I built tests at Second Street Labs.", support, profile), ["Second", "Street", "Labs."]);
});

// A live application: the profile says "reached 76.0%", the draft wrote
// "76%", and the whole answer was left for the applicant.
test("a figure is the same claim with or without its trailing zero", () => {
  const support = ["Cache hits reached 82.0% at a quarter of the memory budget, with R² 0.50."];
  assert.deepEqual(unsupportedClaims("Cache hits reached 82% at a quarter of the budget.", support, profile), []);
  assert.deepEqual(unsupportedClaims("Cache hits reached 82.0% and R² 0.5.", support, profile), []);
  // A different figure is still a claim, and so is a different magnitude.
  assert.deepEqual(unsupportedClaims("Cache hits reached 83%.", support, profile), ["83%."]);
  assert.deepEqual(unsupportedClaims("Cache hits reached 820%.", support, profile), ["820%."]);
});

test("a month written out is the same claim as its abbreviation", () => {
  const support = ["Founded the platform in Mar 2025 and shipped it in September 2025."];
  assert.deepEqual(unsupportedClaims("I founded it in March 2025 and shipped it in Sep 2025.", support, profile), []);
  assert.deepEqual(unsupportedClaims("I founded it in June 2025.", support, profile), ["June"]);
});

// A report: "Codex could not draft this (not logged in or
// authentication expired)" while Codex was logged in. Codex repeats its
// prompt, and a posting there said "sign in"; that is no error of Codex's.
test("a CLI failure is read from the CLI's own words, never from the prompt it repeats", async () => {
  const { cliFailure } = await import("../src/server/cli-provider");
  const echoed = [
    "OpenAI Codex v0.160.0",
    "--------",
    "user",
    "Posting: engineers build sign in and authentication services. Profile: …",
    "ERROR: stream disconnected before completion: error sending request",
  ].join("\n");
  const failure = cliFailure("codex", "", echoed);
  assert.equal(failure.category, "unavailable");
  assert.match(failure.message, /^codex exited with an error \("ERROR: stream disconnected before completion/);
  const expired = cliFailure("codex", "", ["user", "Please sign in to apply.", "ERROR: Your access token could not be refreshed; please log in again."].join("\n"));
  assert.equal(expired.category, "authentication");
  assert.match(expired.message, /please log in again/);
});

// The an employer letter: written in one request under a list of
// rules, it read as a list. The first request now plans which facts answer
// the posting; drafts are written from the plan, and the better one goes.
const plan = {
  resume: ["f1", "f2"],
  answers: [],
  letterPlan: {
    intro: "An engineer who builds TypeScript interfaces.",
    points: [{ requirement: "TypeScript interfaces and automated tests", factIds: ["f1"], why: "It is the work the posting describes." }],
    company: "interfaces",
  },
};
const listy = [
  "I am applying for the TypeScript Engineer role. I built TypeScript interfaces and automated tests. I used Kubernetes for it.",
  "I built TypeScript interfaces. I wrote automated tests. I would bring that work to the team.",
  "I see a connection to these interfaces. I will bring it.",
];
const varied = [
  "I am applying for the TypeScript Engineer role. Building TypeScript interfaces is the work I know best, and it is what this role asks for.",
  "The posting asks for interfaces and automated tests together. That pairing is how I built TypeScript interfaces, with automated tests written alongside them so that each change was checked.",
  "Interfaces are where this team's work starts, which is why the role fits. Good interfaces need tests behind them.",
];
const writes = (bodies: any[]) => bodies.filter((body) => /^Write this applicant's cover letter/.test(body.messages[0].content));
const letterServer = async (t: TestContext, letter: (index: number) => unknown) => {
  const bodies: any[] = [];
  const config = await transport(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    const written = writes(bodies).length;
    if (written && writes(bodies).at(-1) === bodies.at(-1)) return reply(res, letter(written - 1));
    reply(res, plan);
  });
  return { config, bodies };
};

test("the letter is planned first, then written from the plan, and the better draft goes out", async (t) => {
  const { config, bodies } = await letterServer(t, (index) => ({
    coverLetter: (index === 0 ? listy : varied).map((text) => ({ text, factIds: ["f1"] })),
  }));
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.equal(writes(bodies).length, 2);
  const input = JSON.parse(writes(bodies)[0].messages[1].content);
  // The writer sees the plan and the facts it cites, and nothing else of the profile.
  assert.deepEqual(input.plan.points[0].factIds, ["f1"]);
  assert.deepEqual(input.facts, [{ id: "f1", text: profile.facts[0].text }]);
  assert.equal(input.example, undefined);
  const letter = result.coverLetter.map((p) => p.text).join("\n");
  assert.match(letter, /^Dear Hiring Team,\n/);
  assert.match(letter, /written alongside them so that each change was checked/);
  assert.doesNotMatch(letter, /Kubernetes/);
  assert.deepEqual(result.coverLetter[1].factIds, ["original-a"]);
  assert.equal(result.warnings, undefined);
});

test("a letter whose drafts all fail is put together from the plan's facts, and says so", async (t) => {
  const { config } = await letterServer(t, () => ({ coverLetter: [] }));
  const result = await provider(config, quiet)(request(), profile, signal());
  assert.deepEqual(result.coverLetter.flatMap((p) => p.factIds), ["original-a"]);
  assert.match(result.warnings!.join(" "), /could not be written \(no paragraphs came back\), so it was put together from your facts/);
  // The resume of the first request stands.
  assert.deepEqual(result.resume.map((f) => f.factId), ["original-a", "original-b"]);
});

test("the letter writer reads the tailoring profile and the applicant's example letter", async (t) => {
  const tailoring = await mkdtemp(join(tmpdir(), "lane-letter-"));
  t.after(() => rm(tailoring, { recursive: true, force: true }));
  await writeFile(join(tailoring, "profile.md"), "# Profile\n\n## Projects\n\nInterface kit: built on Kubernetes so that tests ran per change.\n");
  await writeFile(join(tailoring, "cover-letter-example.md"), "Dear Team, a letter in a voice I like.");
  const { config, bodies } = await letterServer(t, () => ({
    coverLetter: [...varied, "Kubernetes ran those tests per change, so that no interface shipped untested."].map((text) => ({ text, factIds: ["f1"] })),
  }));
  const result = await provider({ ...config, tailorDir: tailoring }, quiet)(request(), profile, signal());
  const input = JSON.parse(writes(bodies)[0].messages[1].content);
  assert.equal(input.example, "Dear Team, a letter in a voice I like.");
  assert.match(input.background, /Interface kit/);
  // What the letter takes from the profile notes is no invention.
  assert.match(result.coverLetter.map((p) => p.text).join(" "), /Kubernetes ran those tests/);
  assert.doesNotMatch((result.warnings || []).join(" "), /mentions/);
});

test("a draft's penalty weighs unsupported claims, then sentences opening with I", async () => {
  const { letterPenalty, iOpened } = await import("../src/server/generation");
  assert.equal(iOpened(listy.join(" ")), 1);
  assert.ok(iOpened(varied.join(" ")) <= 1 / 3);
  assert.ok(letterPenalty(varied, 0) < letterPenalty(listy, 0));
  assert.ok(letterPenalty(listy, 0) < letterPenalty(varied, 1));
});
