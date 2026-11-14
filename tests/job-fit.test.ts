import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileSchema, type GenerationRequest, type GenerationJob } from "../src/shared/model";
import { assessJobFit, fitEvidence, normalizeFit, unknownFit, type FitAssessor } from "../src/server/job-fit";
import { GenerationQueue } from "../src/server/generation";
import { configSchema, Store } from "../src/server/store";

const profile = profileSchema.parse({
  confirmed: true, revision: 1, firstName: "Alex", lastName: "Rivera", email: "private@example.test",
  facts: [{ id: "project", text: "Built accessible TypeScript interfaces and automated tests." }],
  education: [{ organization: "Example University", title: "B.S. Computer Science", startDate: "2020-08", endDate: "2024-05" }],
  sponsorship: "Yes", gender: "Private demographic answer",
});
const description = `Requirements: Build accessible TypeScript interfaces. Write automated tests. Enrollment through December 2027 required. Experience with Rust preferred. We are looking for an engineer who can work with our product team to develop reliable web applications, review code and improve performance for customers. We offer benefits and an inclusive workplace.`;
const request = (overrides: Partial<GenerationRequest> = {}): GenerationRequest => ({
  applicationId: randomUUID(), operation: 1, profileRevision: 1, title: "Frontend Engineer",
  url: "https://example.test/jobs/1", description, fields: [], ...overrides,
});
const entries = fitEvidence(profile);
const matched = {
  requirement: "Build accessible TypeScript interfaces", importance: "required", status: "matched",
  evidence: [{ id: "e1", quote: "Built accessible TypeScript interfaces" }],
};
const tests = {
  requirement: "Write automated tests", importance: "required", status: "matched",
  evidence: [{ id: "e1", quote: "automated tests" }],
};
const gap = { requirement: "Experience with Rust preferred", importance: "preferred", status: "gap", evidence: [] };
const fit = (requirements: unknown[]) => normalizeFit({ requirements }, request(), profile, entries);

test("job fit maps supporting evidence, preferred gaps and required gaps into a verdict", () => {
  const good = fit([matched, tests, gap]);
  assert.equal(good.verdict, "good");
  assert.deepEqual(good.requirements[0].evidence, ["Built accessible TypeScript interfaces"]);
  assert.equal(good.requirements[2].status, "gap");
  assert.equal(fit([matched, { ...tests, status: "gap", evidence: [] }]).verdict, "partial");
  const poor = fit([{ ...matched, status: "gap", evidence: [] }]);
  assert.equal(poor.verdict, "poor");
  assert.match(poor.summary, /no supporting evidence/);
});

test("only explicit required eligibility conflicts are failures; unknown facts and preferences stay separate", () => {
  const enrollment = {
    requirement: "Enrollment through December 2027 required", importance: "required", status: "unmet",
    evidence: [{ id: "e2", quote: "B.S. Computer Science at Example University, 2020-08 to 2024-05" }],
  };
  assert.equal(fit([matched, enrollment]).verdict, "poor");
  assert.match(fit([matched, enrollment]).summary, /conflicts/);
  const unknown = fit([{ ...enrollment, evidence: [] }]);
  assert.equal(unknown.verdict, "unknown");
  assert.equal(unknown.requirements[0].status, "uncertain");
  const preferred = fit([matched, { ...gap, status: "unmet", evidence: matched.evidence }]);
  assert.equal(preferred.verdict, "good");
  assert.equal(preferred.requirements[1].status, "gap");
});

test("invented evidence, foreign IDs and invented requirements cannot yield a good-fit verdict", () => {
  for (const evidence of [
    [{ id: "e1", quote: "Ten years of professional TypeScript experience" }],
    [{ id: "foreign", quote: "Built accessible TypeScript interfaces" }],
  ]) {
    const result = fit([{ ...matched, evidence }]);
    assert.equal(result.verdict, "unknown");
    assert.equal(result.requirements[0].status, "uncertain");
    assert.deepEqual(result.requirements[0].evidence, []);
  }
  const invented = fit([matched, { ...tests, requirement: "Security clearance required" }]);
  assert.equal(invented.verdict, "unknown");
  // Said as what happened: the posting was read.
  assert.match(invented.summary, /posting was read, but the fit check quoted a requirement that is not in it/);
  assert.equal(normalizeFit({ requirements: [] }, request(), profile, entries).verdict, "unknown");
});

test("fit evidence includes saved experience, education and skill context while excluding contact and demographics", () => {
  const evidence = fitEvidence(profile, {
    profile: "## Projects\n### Backend\n- Built a Python service.",
    preferences: "## Logistics\n- **Relocation:** Yes", guidance: "", warnings: [],
  });
  const text = evidence.map((entry) => entry.text).join("\n");
  assert.match(text, /TypeScript/);
  assert.match(text, /B\.S\. Computer Science/);
  assert.match(text, /Python service/);
  assert.match(text, /United States: status not said; needs sponsorship: yes/);
  assert.doesNotMatch(text, /private@example|Private demographic/);
});

test("fit assessment uses the configured provider and application graduation date, and short postings need more information", async (t) => {
  let input: any;
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    input = JSON.parse(body.messages[1].content);
    assert.match(body.messages[0].content, /UNTRUSTED DATA/);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ requirements: [matched, tests, gap] }) } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = configSchema.parse({
    token: "test-token-".repeat(4), model: "fixture", postingLookup: false,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
  });
  const assess = assessJobFit(config);
  const short = await assess(request({ description: "TypeScript engineer" }), profile, new AbortController().signal);
  assert.equal(short.verdict, "unknown");
  assert.equal(short.needsPosting, true);
  assert.equal(calls, 0);
  const result = await assess(request(), profile, new AbortController().signal, { graduation: "2027-12" });
  assert.equal(result.verdict, "good");
  assert.equal(input.graduationForThisApplication, "2027-12");
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(input), /private@example|Private demographic/);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const unavailable = await assess(request(), profile, new AbortController().signal);
  assert.equal(unavailable.verdict, "unknown");
  assert.match(unavailable.summary, /AI service/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(assess(request(), profile, controller.signal));
});

async function finished(store: Store, job: GenerationJob) {
  for (let i = 0; i < 200 && ["queued", "running"].includes(job.status); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(job.status, "complete", job.error);
  // execute's final store save follows the status update.
  await store.save();
  return job;
}

test("queued fit checks create no documents; normal preparation reuses the fit and reassesses changed postings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lane-fit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  await store.init();
  store.data.profile = structuredClone(profile);
  let drafted = 0;
  let assessed = 0;
  const assess: FitAssessor = async (req, p) => {
    assessed++;
    return normalizeFit({ requirements: [matched, tests, gap] }, req, p, fitEvidence(p));
  };
  const queue = new GenerationQueue(store, configSchema.parse({ token: "test-token-".repeat(4), postingLookup: false }),
    async () => { drafted++; return { resume: [{ factId: "project", text: profile.facts[0].text }], coverLetter: [], answers: [] }; },
    undefined, undefined, undefined, undefined, undefined, assess,
  );
  const req = request({ postingText: description });
  const checked = await finished(store, await queue.enqueue({ ...req, purpose: "fit" }));
  assert.equal(checked.fit?.verdict, "good");
  assert.deepEqual(checked.artifacts, []);
  assert.equal(checked.narrative, undefined);
  assert.equal(drafted, 0);
  assert.deepEqual(await readdir(join(directory, "artifacts")), []);
  const generated = await finished(store, await queue.enqueue(req));
  assert.notEqual(generated.id, checked.id);
  assert.equal(generated.fit?.verdict, "good");
  assert.ok(generated.artifacts.length);
  assert.equal(assessed, 1);
  assert.equal(drafted, 1);
  await finished(store, await queue.enqueue({ ...req, operation: 2 }));
  assert.equal(assessed, 1);
  assert.equal(drafted, 1);
  await finished(store, await queue.enqueue({ ...req, operation: 3, postingText: description + " Additional qualifications required." }));
  assert.equal(assessed, 2);
  assert.equal(drafted, 2);
  const reopened = new Store(directory);
  await reopened.init();
  assert.equal(reopened.data.jobs.find((job) => job.id === checked.id)?.fit?.verdict, "good");
});

test("failed fit assessment does not fail document preparation or masquerade as a match", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lane-fit-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  await store.init();
  store.data.profile = structuredClone(profile);
  const queue = new GenerationQueue(store, configSchema.parse({ token: "test-token-".repeat(4), postingLookup: false }),
    async () => ({ resume: [{ factId: "project", text: profile.facts[0].text }], coverLetter: [], answers: [] }),
    undefined, undefined, undefined, undefined, undefined, async () => { throw new Error("Unavailable"); },
  );
  const job = await finished(store, await queue.enqueue(request({ postingText: description })));
  assert.equal(job.fit?.verdict, "unknown");
  assert.ok(job.artifacts.length);
  assert.equal(unknownFit(profile, "missing").profileRevision, profile.revision);
});
