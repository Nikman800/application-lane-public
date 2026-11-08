import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileSchema, type Field, type GenerationRequest } from "../src/shared/model";
import { leftReasons, pickOption } from "../src/shared/answers";
import {
  applicationQuestion,
  fitLength,
  markdownSections,
  salaryFigure,
  screenAnswer,
  shortLabel,
  skillContext,
  writeAnswers,
} from "../src/server/answers";
import {
  fieldFallbackSources,
  writeFieldFallback,
} from "../src/server/field-fallback";
import { structuredFallbackField } from "../src/shared/questions";
import { GenerationQueue, postingReadable, unsupportedClaims, wantsLetter } from "../src/server/generation";
import { evidenceEntries, heldByOneEntry, supportedBy, talksAboutSources, unclaimed, checkers, verifier, type Draft, type Verdict } from "../src/server/verify";
import { configSchema, Store } from "../src/server/store";

const field = (label: string, overrides: Partial<Field> = {}): Field => ({
  id: label,
  label,
  kind: "textarea",
  required: true,
  value: "",
  options: [],
  revision: 1,
  protected: false,
  ...overrides,
});
const profile = profileSchema.parse({
  firstName: "Alex",
  lastName: "Fixture",
  email: "t@example.test",
  confirmed: true,
  revision: 1,
  facts: [{ id: "a", text: "Built a TypeScript web application used by 2,000 students." }],
});

// The applicant's tailoring folder, with synthetic contents.
async function checkout(options: { references?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "lane-answers-checkout-"));
  await mkdir(join(dir, "resumes"), { recursive: true });
  await writeFile(
    join(dir, "profile.md"),
    `# Master Profile
## Contact
- Phone: 555-0100, home: 1 Private Lane
## Application personal information (explicitly supplied)
- Date of birth: 2000-01-01
## Positioning — two angles
Backend engineer.
## Experience
### Platform Engineer — Initrode · 2024
- Cut API latency 35% with a Redis cache.
## Reusable STAR stories (for behavioral questions)
- Hard problem: the Redis latency work.
## Known gaps (state honestly)
- No Kubernetes in production.
`,
  );
  await writeFile(
    join(dir, "preferences.md"),
    `# Preferences
## Logistics (confirmed)
- **Salary expectation:** $100,000/year target (full-time).
- **Earliest start date:** Immediately.
- **Notice period:** TODO
## Default stances (edit anytime)
- Willing to do a take-home: Yes.
## Personal notes
- Something private.
`,
  );
  if (options.references !== false) {
    const refs = join(dir, "references");
    await mkdir(refs, { recursive: true });
    await writeFile(join(refs, "common-questions.md"), "Why here: tie a posting signal to real work.");
    await writeFile(join(refs, "anti-fabrication.md"), "Never invent employers or metrics.");
  }
  return dir;
}

test("every free-text question is answered, except identity, demographics and consent", () => {
  const answered = (label: string, overrides: Partial<Field> = {}) => applicationQuestion(field(label, overrides));
  // Range, Ashby and Greenhouse wording.
  assert.ok(answered("Why are you interested in this position?"));
  assert.ok(answered("What are your superpowers?", { kind: "text" }));
  assert.ok(answered("What are some of your biggest career lessons learned?"));
  assert.ok(answered("Anything else you would like us to know"));
  assert.ok(answered("Desired Salary (required)", { kind: "text" }));
  assert.ok(answered("When can you start?", { kind: "text" }));
  // Filled exactly by the profile, or never by a model.
  assert.equal(answered("LinkedIn Profile", { kind: "text" }), false);
  assert.equal(answered("What is your LinkedIn URL?", { kind: "text" }), false);
  assert.equal(answered("Legal Full Name", { kind: "text" }), false);
  assert.equal(answered("Please describe your gender identity"), false);
  assert.equal(answered("I certify that the information above is true"), false);
  assert.equal(answered("Have you ever been convicted of a felony?"), false);
  // Choice questions stay with the answer bank; filled or history rows are skipped.
  assert.equal(answered("Why this role?", { options: ["A", "B"] }), false);
  assert.equal(answered("Why this role?", { value: "already written" }), false);
  assert.equal(answered("Description", { section: "Work Experience" }), false);
  // A plain text input that is not a question is not a narrative field.
  assert.equal(answered("Current company", { kind: "text" }), false);
});

test("only the allowed profile and preference sections are read, without TODO lines", async () => {
  const context = await skillContext(await checkout());
  assert.match(context.profile, /Positioning/);
  assert.match(context.profile, /Initrode/);
  assert.match(context.profile, /STAR stories/);
  assert.match(context.profile, /No Kubernetes/);
  assert.doesNotMatch(context.profile, /555-0100|Private Lane|Date of birth/);
  assert.match(context.preferences, /\$100,000/);
  assert.match(context.preferences, /take-home/);
  assert.doesNotMatch(context.preferences, /Notice period|TODO|Something private/);
  assert.match(context.guidance, /Never invent/);
  assert.deepEqual(context.warnings, []);
  // A folder without its own question guides uses the ones shipped with Lane.
  const partial = await skillContext(await checkout({ references: false }));
  assert.deepEqual(partial.warnings, []);
  assert.match(partial.guidance, /Answering common application questions/);
  assert.match(partial.guidance, /Anti-fabrication rules/);
  assert.equal(markdownSections("## Logistics\n- a: TODO\n- b: yes", /^logistics/i), "## Logistics\n- b: yes");
});

test("answers fit a field's limit at a sentence boundary", () => {
  assert.equal(fitLength("One sentence. Two sentences here.", 20), "One sentence.");
  assert.equal(fitLength("Short.", 20), "Short.");
  assert.equal(fitLength("No sentence end fits in this limit", 10), "");
});

async function endpoint(t: TestContext, answers: unknown) {
  let sent: any;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    sent = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ answers }) } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const config = configSchema.parse({ postingLookup: false,
    token: "synthetic-token-".repeat(4),
    model: "fixture",
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
  });
  return { config, sent: () => sent };
}

const request = (fields: Field[]): GenerationRequest => ({
  applicationId: randomUUID(),
  operation: 1,
  profileRevision: 1,
  title: "Backend Engineer",
  description: "Build low-latency APIs at Acme with Redis.",
  url: "https://example.test/job",
  fields,
});

test("the model's answers are grounded, cleaned and fitted before use", async (t) => {
  const { config, sent } = await endpoint(t, [
    { fieldId: "q1", text: "I cut API latency 35% with a Redis cache at Initrode — the kind of low-latency work Acme does (q1)." },
    { fieldId: "q2", text: "My target is $100,000/year for a full-time role." },
    { fieldId: "q3", text: "I led the platform team at Globex for five years." },
    { fieldId: "q4", text: "I built a TypeScript web application used by 2,000 students. That taught me to ship. It also taught me a great deal more than fits." },
  ]);
  const fields = [
    field("Why are you interested in Acme?"),
    field("Desired salary", { kind: "text" }),
    field("Tell us about your leadership experience"),
    field("What are you proud of?", { maxLength: 90 }),
    field("Email", { kind: "email" }),
  ];
  const context = await skillContext(await checkout());
  const result = await writeAnswers(config, request(fields), profile, context, new AbortController().signal);
  // Only the free-text questions were asked, with the limit where one exists.
  const input = JSON.parse(sent().messages[1].content);
  assert.deepEqual(
    input.questions.map((q: { label: string; maxLength?: number }) => [q.label, q.maxLength]),
    [
      ["Why are you interested in Acme?", undefined],
      ["Desired salary", undefined],
      ["Tell us about your leadership experience", undefined],
      ["What are you proud of?", 90],
    ],
  );
  assert.doesNotMatch(sent().messages[1].content, /555-0100|Date of birth/);
  assert.match(sent().messages[0].content, /Never invent employers or metrics/);
  assert.deepEqual(
    result.answers.map((a) => [a.fieldId, a.value]),
    [
      ["Why are you interested in Acme?", "I cut API latency 35% with a Redis cache at Initrode, the kind of low-latency work Acme does."],
      // A one-line salary box takes the figure (salaryFigure).
      ["Desired salary", "100000"],
      ["What are you proud of?", "I built a TypeScript web application used by 2,000 students. That taught me to ship."],
    ],
  );
  assert.match(result.warnings.join(" "), /Left "Tell us about your leadership experience" for you: .*Globex/);
});

test("the queue uses the profile's answers in place of the letter request's, and survives their failure", async () => {
  const run = async (answer: () => Promise<{ answers: any[]; warnings: string[]; withheld: string[]; sources: Record<string, string> }>) => {
    const store = new Store(await mkdtemp(join(tmpdir(), "lane-answers-queue-")));
    await store.init();
    store.data.profile = structuredClone(profile);
    const config = configSchema.parse({ postingLookup: false, token: "synthetic-token-".repeat(4), model: "fixture", endpoint: "http://127.0.0.1:9/v1", tailorDir: "unused" });
    const queue = new GenerationQueue(
      store,
      config,
      async () => ({
        resume: [{ factId: "a", text: profile.facts[0].text }],
        coverLetter: [{ text: "Dear Hiring Team,", factIds: [] }, { text: profile.facts[0].text, factIds: ["a"] }],
        answers: [
          { fieldId: "why", value: "from the letter request", factIds: ["a"] },
          { fieldId: "other", value: "kept", factIds: ["a"] },
        ],
      }),
      async () => {
        throw new Error("no tailoring in this test");
      },
      answer,
    );
    const job = await queue.enqueue(request([field("why"), field("other")]));
    const deadline = Date.now() + 30000;
    while (["queued", "running"].includes(job.status)) {
      assert.ok(Date.now() < deadline);
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(job.status, "complete", job.error);
    return job.narrative!;
  };
  const replaced = await run(async () => ({ answers: [{ fieldId: "why", value: "from the profile", factIds: [] }], warnings: [], withheld: [], sources: {} }));
  assert.deepEqual(
    replaced.answers.map((a) => [a.fieldId, a.value]),
    [["why", "from the profile"], ["other", "kept"]],
  );
  const failed = await run(async () => {
    throw new Error("Claude is not installed or not on PATH.");
  });
  assert.deepEqual(failed.answers.map((a) => a.value), ["from the letter request", "kept"]);
  assert.match(failed.warnings!.join(" "), /could not be written from your tailoring notes.*not on PATH/);
});

test("documents are drafted from the job posting when its ATS publishes it", async () => {
  const run = async (posting: { source: "Lever"; title: string; company?: string; description: string } | undefined) => {
    const store = new Store(await mkdtemp(join(tmpdir(), "lane-posting-queue-")));
    await store.init();
    store.data.profile = structuredClone(profile);
    const config = configSchema.parse({ postingLookup: true, token: "synthetic-token-".repeat(4), model: "fixture", endpoint: "http://127.0.0.1:9/v1", tailorDir: "unused" });
    const seen: { title: string; company?: string; description: string }[] = [];
    const asked: string[][] = [];
    const queue = new GenerationQueue(
      store,
      config,
      async (request) => {
        seen.push({ title: request.title, company: request.company, description: request.description });
        return {
          resume: [{ factId: "a", text: profile.facts[0].text }],
          coverLetter: [{ text: "Dear Hiring Team,", factIds: [] }, { text: profile.facts[0].text, factIds: ["a"] }],
          answers: [],
        };
      },
      async () => {
        throw new Error("no tailoring in this test");
      },
      async () => ({ answers: [], warnings: [], withheld: [], sources: {} }),
      async (urls) => {
        asked.push(urls);
        return posting;
      },
    );
    const job = await queue.enqueue({
      ...request([]),
      title: "Work Summary",
      description: "Job application form Upload Resume Full name Email",
      pageUrls: ["https://jobs.lever.co/acme/34cf5ad0-840a-4c1b-8231-02a433d0479e/apply"],
    });
    const deadline = Date.now() + 30000;
    while (["queued", "running"].includes(job.status)) {
      assert.ok(Date.now() < deadline);
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(job.status, "complete", job.error);
    return { job, seen: seen[0], asked: asked[0] };
  };
  const found = await run({ source: "Lever", title: "Software Engineer Intern", company: "Acron Aviation", description: "Build avionics software in C++ and Python." });
  // The tracked URL first, then the pages being filled.
  assert.deepEqual(found.asked.slice(1), ["https://jobs.lever.co/acme/34cf5ad0-840a-4c1b-8231-02a433d0479e/apply"]);
  assert.equal(found.seen.title, "Software Engineer Intern");
  assert.equal(found.seen.company, "Acron Aviation");
  assert.match(found.seen.description, /Build avionics software/);
  assert.doesNotMatch(found.seen.description, /Upload Resume/);
  assert.deepEqual(found.job.posting, { source: "Lever", title: "Software Engineer Intern" });
  assert.doesNotMatch((found.job.narrative!.warnings || []).join(" "), /could not be read/);

  const missing = await run(undefined);
  assert.equal(missing.seen.title, "Work Summary");
  assert.equal(missing.job.posting, undefined);
  assert.match(missing.job.narrative!.warnings!.join(" "), /job posting could not be read from this site, so your resume went out unchanged/);
});

test("later steps of one application reuse its documents and answer only their own questions", async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), "lane-reuse-queue-")));
  await store.init();
  store.data.profile = structuredClone(profile);
  const transcripts = await mkdtemp(join(tmpdir(), "lane-reuse-transcripts-"));
  const config = configSchema.parse({ postingLookup: false, token: "synthetic-token-".repeat(4), model: "fixture", endpoint: "http://127.0.0.1:9/v1", tailorDir: "unused", transcriptsDir: transcripts });
  let drafts = 0;
  const answered: string[][] = [];
  const queue = new GenerationQueue(
    store,
    config,
    async () => {
      drafts++;
      return {
        resume: [{ factId: "a", text: profile.facts[0].text }],
        coverLetter: [{ text: "Dear Hiring Team,", factIds: [] }, { text: profile.facts[0].text, factIds: ["a"] }],
        answers: [],
      };
    },
    async () => {
      throw new Error("no tailoring in this test");
    },
    async (request) => {
      answered.push(request.fields.map((f) => f.label));
      return { answers: request.fields.map((f) => ({ fieldId: f.id, value: `About ${f.label}`, factIds: [] })), warnings: [], withheld: [], sources: {} };
    },
  );
  const applicationId = randomUUID();
  const settle = async (job: { status: string; error?: string }) => {
    const deadline = Date.now() + 30000;
    while (["queued", "running"].includes(job.status)) {
      assert.ok(Date.now() < deadline);
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(job.status, "complete", job.error);
  };
  const first = await queue.enqueue({ ...request([field("Why are you interested in Acme?")]), operation: 1, applicationId });
  await settle(first);
  assert.equal(drafts, 1);
  // The first draft fell back from a provider: that was then, not this step
  // (a report: the notice reappeared after the model was fixed).
  first.narrative!.warnings = [...(first.narrative!.warnings || []), "Codex could not draft this (usage limit reached), so Claude was used instead."];
  // A demographics step: no written question, so no model at all.
  const demographics = await queue.enqueue({ ...request([field("Gender", { kind: "select", options: ["Male", "Female"] })]), operation: 2, applicationId });
  await settle(demographics);
  assert.equal(drafts, 1);
  assert.ok(!(demographics.narrative!.warnings || []).some((warning) => /could not draft this/.test(warning)));
  assert.equal(answered.length, 1);
  // The same documents, copied for the step's own run.
  assert.deepEqual(demographics.artifacts.map((a) => [a.kind, a.name, a.operation]), first.artifacts.map((a) => [a.kind, a.name, 2]));
  assert.deepEqual(demographics.narrative!.answers, []);
  // A step with its own question: only that question is answered.
  const questions = await queue.enqueue({ ...request([field("What are you proud of?")]), operation: 3, applicationId });
  await settle(questions);
  assert.equal(drafts, 1);
  assert.deepEqual(answered.at(-1), ["What are you proud of?"]);
  assert.deepEqual(questions.narrative!.answers.map((a) => a.value), ["About What are you proud of?"]);
  assert.deepEqual(questions.artifacts.map((a) => [a.kind, a.name, a.operation]), first.artifacts.map((a) => [a.kind, a.name, 3]));
  // A transcript added after the documents were drafted goes with the next
  // step all the same: it used to wait for a full redraft, and the form's
  // transcript field stayed empty.
  assert.ok(!first.artifacts.some((a) => a.kind === "transcript"));
  await writeFile(join(transcripts, "Spring transcript.pdf"), "%PDF-1.4 synthetic");
  const later = await queue.enqueue({ ...request([field("Gender", { kind: "select", options: ["Male", "Female"] })]), operation: 4, applicationId });
  await settle(later);
  assert.equal(drafts, 1);
  assert.deepEqual(later.artifacts.map((a) => [a.kind, a.name, a.operation]), [...first.artifacts.map((a) => [a.kind, a.name, 4]), ["transcript", "Spring transcript.pdf", 4]]);
  // A newer one replaces it; the earlier step's copy is not carried along.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(join(transcripts, "Fall transcript.pdf"), "%PDF-1.4 synthetic, newer");
  const latest = await queue.enqueue({ ...request([field("Gender", { kind: "select", options: ["Male", "Female"] })]), operation: 5, applicationId });
  await settle(latest);
  assert.deepEqual(latest.artifacts.filter((a) => a.kind === "transcript").map((a) => [a.name, a.operation]), [["Fall transcript.pdf", 5]]);
  // Redraft documents writes them anew: it took the earlier letter as it was,
  // its sentences already cut (Tesla).
  const redrafted = await queue.enqueue({ ...request([field("Gender", { kind: "select", options: ["Male", "Female"] })]), operation: 6, applicationId, redraft: true });
  await settle(redrafted);
  assert.equal(drafts, 2);
});

test("the word check knows the applicant's school by its short name, R², and plurals", () => {
  const own = profileSchema.parse({
    firstName: "Alex",
    lastName: "Fixture",
    email: "t@example.test",
    confirmed: true,
    revision: 1,
    education: [{ organization: "Pennsylvania State University, University Park", title: "B.S.", startDate: "2020", endDate: "2024" }],
    facts: [{ id: "a", text: "Benchmarked Kolmogorov–Arnold Networks at matched accuracy (R 2 0.86)." }],
  });
  const support = own.facts.map((fact) => fact.text);
  assert.deepEqual(unsupportedClaims("I hold a B.S. from Penn State University Park.", support, own), []);
  assert.deepEqual(unsupportedClaims("I matched accuracy at R² 0.86 on a Kolmogorov-Arnold Network.", support, own), []);
  // Its initials name it too (one employer's letter), but only its own.
  assert.deepEqual(unsupportedClaims("I finished my B.S. at Penn State UP.", support, own), []);
  assert.deepEqual(unsupportedClaims("I finished my B.S. at UCLA.", support, own), ["UCLA."]);
  // A school's common name is its name too.
  const official = profileSchema.parse({ ...own, education: [{ organization: "Virginia Polytechnic Institute and State University", title: "B.S.", startDate: "2020", endDate: "2024" }] });
  assert.deepEqual(unsupportedClaims("I hold a B.S. from Virginia Tech.", support, official), []);
  // Still a claim: a name the applicant's own names do not start.
  assert.deepEqual(unsupportedClaims("I studied at Stanford.", support, own), ["Stanford."]);
});

test("an answer that talks about the draft is left, and volunteered logistics come out", () => {
  assert.ok("reason" in screenAnswer("What product would you build?", "For principles, I do not have Samsara's list of operating principles in the posting, so I will speak to its themes."));
  assert.ok("reason" in screenAnswer("Why Samsara?", "I am drawn to Samsara, but the job text does not describe the product."));
  assert.deepEqual(
    screenAnswer("Why do you want to join Figma?", "I build tools people use daily. I'm a U.S. citizen, open to relocating to San Francisco or New York."),
    { text: "I build tools people use daily." },
  );
  // A logistics question keeps its logistics.
  assert.deepEqual(screenAnswer("Are you willing to relocate?", "Yes, I am open to relocating."), { text: "Yes, I am open to relocating." });
});

test("a page is a posting only once its form labels are out of it, and a letter is written only for a form that takes one", () => {
  const form = request([
    field("Please describe your experience with distributed systems and the requirements you have met", { kind: "textarea" }),
  ]);
  form.description = "Please describe your experience with distributed systems and the requirements you have met ".repeat(30);
  assert.equal(postingReadable(form), false);
  const posting = request([]);
  posting.description =
    "About the role: you will build services. Responsibilities include APIs and tests. Qualifications: a degree in computer science. " +
    "We are looking for engineers who enjoy reliable systems and clear code reviews with their team every week. ".repeat(10);
  assert.equal(postingReadable(posting), true);
  assert.equal(wantsLetter([field("Resume", { kind: "file", documentKind: "resume" })]), false);
  assert.equal(wantsLetter([field("Cover Letter", { kind: "file", documentKind: "cover" })]), true);
  assert.equal(wantsLetter([field("Cover letter (optional)")]), true);
});

test("questions the model cannot answer are skipped with a reason, and follow-ups see the field they refer to", async (t) => {
  const { config, sent } = await endpoint(t, [
    { fieldId: "q1", skip: "Your profile names no product you would build." },
    { fieldId: "q2", text: "I listed backend work: I cut API latency 35% with a Redis cache at Initrode.", source: "Platform Engineer" },
  ]);
  const fields = [
    field("What product would you build at Acme?"),
    field("Based on the engineering work you listed above, what interests you most?"),
    field("Which area interests you most?", { kind: "select", options: ["Backend/Infrastructure", "Frontend"], value: "Backend/Infrastructure" }),
  ];
  const context = await skillContext(await checkout());
  const result = await writeAnswers(config, request(fields), profile, context, new AbortController().signal);
  const input = JSON.parse(sent().messages[1].content);
  assert.deepEqual(input.pageFields, [
    { label: "Which area interests you most?", chosen: "Backend/Infrastructure", options: ["Backend/Infrastructure", "Frontend"] },
  ]);
  assert.deepEqual(result.withheld, ["What product would you build at Acme?"]);
  assert.match(result.warnings.join(" "), /Left "What product would you build at Acme\?" for you: Your profile names no product you would build\./);
  assert.deepEqual(result.sources, { "Based on the engineering work you listed above, what interests you most?": "Platform Engineer" });
});

// an employer: "…our values center on doing what honor dictates,
// leading as a servant, and pursuing excellence. Which of these resonates
// most with you…?" was skipped because the posting did not list the values.
test("a set the question itself lists can be chosen from, and its names are not invented ones", async (t) => {
  const listed = "Our principles are Extreme Ownership, Customer Obsession and Bias for Action. Which resonates most with you, and how has it shown up in your work?";
  const unlisted = "Which of our principles resonates most with you?";
  const { config, sent } = await endpoint(t, [
    { fieldId: "q1", text: "Extreme Ownership resonates most. I cut API latency 35% with a Redis cache at Initrode.", sources: ["Platform Engineer"] },
    { fieldId: "q2", text: "Extreme Ownership resonates most. I cut API latency 35% with a Redis cache at Initrode.", sources: ["Platform Engineer"] },
  ]);
  const context = await skillContext(await checkout());
  const result = await writeAnswers(config, request([field(listed), field(unlisted)]), profile, context, new AbortController().signal);
  assert.match(sent().messages[0].content, /skipped unless the job text or the question itself lists that set/);
  // "Describe your experience with X", where X is thin or missing, gets an
  // honest answer instead of an empty box.
  assert.match(sent().messages[0].content, /is answered, never skipped: say plainly what they have not done, then the nearest real experience/);
  // The same words are an invented principle where nothing lists them.
  assert.deepEqual(result.withheld, [unlisted]);
  assert.match(result.warnings.join(" "), /Left "Which of our principles resonates most with you\?" for you: the drafted answer mentioned Ownership/);
  assert.deepEqual(result.answers.map((answer) => answer.value), ["Extreme Ownership resonates most. I cut API latency 35% with a Redis cache at Initrode."]);
});

// Three ways a sound answer was thrown away (a live application).
test("the verifier's word needs backing: rephrased figures stand, and an honest limit is not talk about the draft", async (t) => {
  // "over a full grid" in the profile, "across a full grid" in the draft,
  // and no quote from the verifying model.
  const entries = ["### Tide model\n- Reached MAE 0.42 m, RMSE 1.3 m, R² 0.91 over a full 300 x 200 harbour grid."];
  assert.equal(supportedBy("R² 0.91 across a full grid", "", "I reached R² 0.91 across a full grid.", entries), true);
  assert.equal(supportedBy("R² 0.95 across a full grid", "", "I reached R² 0.95 across a full grid.", entries), false);
  // A percentage in a claim about work is the entry's percentage: with the
  // profile's own line as the quote this was still "not what the profile says".
  const study = ["### Cache study\n- Found write-through at N=8 reached 82.0% at roughly 1/4 the peak-memory budget."];
  const said = "Write-through achieved 82.0% hits at roughly 1/4 the memory budget";
  assert.equal(supportedBy(said, "write-through at N=8 reached 82.0% at roughly 1/4 the peak-memory budget", `${said}.`, study), true);
  assert.equal(supportedBy(said.replace("82.0%", "92.0%"), "write-through at N=8 reached 82.0% at roughly 1/4 the peak-memory budget", `${said.replace("82.0%", "92.0%")}.`, study), false);
  // Calling one's own experience limited overstates nothing, and "limited"
  // is not a verb of work done.
  for (const modest of ["My Rust experience is limited", "I have limited Rust experience"])
    assert.equal(supportedBy(modest, "", `${modest}.`, ["### Coursework\n- Unix utilities in C."]), true, modest);
  assert.equal(supportedBy("My Rust experience is extensive", "", "My Rust experience is extensive.", ["### Coursework\n- Unix utilities in C."]), false);
  // A draft is "talking about the draft" only when it names its sources or
  // its claims; the verifying model said so of the first of these.
  assert.equal(talksAboutSources("My Rust experience is coursework-level. I have not written Rust day-to-day recently."), false);
  for (const meta of ["The job text does not describe the product.", "I do not have their list of principles, so I will speak to its themes.", "I would rather not claim more."])
    assert.equal(talksAboutSources(meta), true, meta);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const asked = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages[1].content);
    const verdict = { claims: [], addressesReader: true, filler: [] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(asked.drafts ? { drafts: asked.drafts.map((draft: { id: string }) => ({ id: draft.id, ...verdict })) } : verdict) } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const check = verifier(configSchema.parse({ token: "synthetic-token-".repeat(4), provider: "http", model: "drafter", verifyModel: "checker", endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` }))!;
  const verdicts = await check(
    [
      { id: "answer:honest", kind: "answer", question: "Please briefly describe your Rust experience", text: "My Rust experience is coursework-level. I have not written Rust day-to-day recently." },
      { id: "answer:meta", kind: "answer", question: "Which of our principles resonates?", text: "I do not have their list of principles, so I will speak to its themes." },
    ],
    { profile: "### Coursework\n- Rust in systems programming.", posting: "" },
    new AbortController().signal,
  );
  assert.equal(verdicts.get("answer:honest")?.addressesReader, false);
  assert.equal(verdicts.get("answer:meta")?.addressesReader, true);
  // A long question is named whole or cut at a word with a mark, never mid-phrase.
  const long = "If you are interested in infrastructure roles, please briefly describe your experience with Rust";
  assert.equal(shortLabel(long), long);
  assert.equal(shortLabel(`${"word ".repeat(30)}end`), `${"word ".repeat(24).trim()}…`);
});

// A weaker verifying model quotes each claim back as its own evidence, so
// the claim rests on one entry alone. Reading that loosely (figures and names
// exact, most other words) was tried and passed invented results, causes
// and events against a real profile: what a claim adds is where they live.
test("with no usable quote, one entry has to hold every word of a claim that says something", () => {
  const entries = [
    "### Cache Eviction Study for Read-Heavy Services\n- Implemented LRU eviction as the base policy and a write-through policy.\n- Found write-through at N=8 reached 82.0% at roughly 1/4 the peak-memory budget.\n- Diagnosed the gap as a queue-bounded write-stall failure.",
    "### Search service\n- Designed the PostgreSQL data model for the search service.",
    "## Skills inventory\n- Languages: Python, C/C++, Go, Kubernetes",
  ];
  const stands = (claim: string) => supportedBy(claim, claim, `${claim}.`, entries);
  // The entry's own words, in another order or with a connecting word changed.
  for (const claim of ["Write-through reached 82.0% at roughly 1/4 the peak-memory budget", "I diagnosed the gap as a queue-bounded write-stall failure", "I designed the PostgreSQL data model across the search service"])
    assert.equal(stands(claim), true, claim);
  for (const claim of [
    // A result, a cause or an event the entry does not state.
    "I designed a PostgreSQL data model that eliminated outages and cut cloud costs",
    "I designed the PostgreSQL data model after customers complained about slow search",
    "I presented the cache eviction study at a conference",
    "I wrote unit tests and documentation for the cache eviction study",
    // Another figure, a technology the entry never names, leadership it does not state.
    "Write-through reached 92.0% at roughly 1/4 the peak-memory budget",
    "I implemented LRU eviction in Rust as the base policy",
    "I led a team that implemented LRU eviction as the base policy",
    "I ran the cache eviction study on Kubernetes",
  ])
    assert.equal(stands(claim), false, claim);
});

// Invented claims that each name something an entry really holds, checked
// against a real profile on: the looser reading passed eight of
// seventeen, and "won a hackathon with FastAPI" passed even the strict one,
// as a statement of a skill. Entries here are made up to the same shape.
test("an invented event, result, audience or figure is not vouched for by an entry that names its technology", () => {
  const entries = [
    "### Founder — Quizbank (quizbank.example) · Mar 2025 – Present\nTech: Flask, React, PostgreSQL, OAuth, OCR\n- OCR ingestion pipelines convert past papers into a queryable bank of 12,700+ questions.\n- Implemented LLM-based answer feedback and grading.\n- Implemented OAuth authentication and lazy loading to cut initial payload and memory.",
    "### Software Engineer Intern — Initech · Jul 2023 – Sep 2023\nTech: C#, JavaScript, REST APIs\n- Integrated retrieval-augmented generation into Initech's production platform.\n- Built and maintained REST APIs and webhooks powering chatbot–CRM integrations.\n- Reworked the chatbot web UI for desktop and mobile.",
    "### Fan-Out Backend System · Aug–Dec 2025\nTech: Python, FastAPI, Redis Cluster, MongoDB\n- Built a scalable fan-out backend on a MongoDB sharded cluster and a Redis Cluster.\n- Implemented delivery with a Redis Streams worker.\n- Measured <200ms small fanout at 1K followers.",
    "### Budget App (Hackathon) · Apr 2026\nTech: React, FastAPI\n- Built and deployed a budgeting app in one weekend.",
    "## Skills inventory\n- **Backend:** FastAPI, Flask, REST API design, OAuth",
  ];
  for (const claim of [
    "I implemented OAuth authentication and lazy loading to cut the initial payload",
    "I integrated retrieval-augmented generation into Initech's production platform",
    "I built a scalable fan-out backend on a MongoDB sharded cluster and a Redis Cluster",
  ])
    assert.equal(heldByOneEntry(claim, entries), true, claim);
  for (const claim of [
    // Events told with a past tense that does not end in -ed.
    "I won a hackathon with the FastAPI fan-out backend",
    "I taught a workshop on OAuth",
    "I gave a talk on the Redis Cluster at a conference",
    "I grew Quizbank with React and Flask",
    // Results, causes and audiences.
    "I implemented OAuth authentication, which reduced support tickets and improved user retention",
    "I built REST APIs and webhooks that doubled customer engagement across enterprise clients",
    "I integrated retrieval-augmented generation into Initech's production platform and trained the team on it",
    "I mentored junior engineers while building REST APIs at Initech",
    "I led the migration of Initech's REST APIs to microservices",
    "I built the Redis Cluster deployment that serves production traffic for paying customers",
    "I operated Quizbank for thousands of daily students",
    "I presented the MongoDB sharded cluster work at a conference",
    "I implemented LLM-based grading that teachers adopted in classrooms",
    "I reworked the chatbot web UI, which increased conversion",
    "I deployed the Redis Streams worker to Kubernetes on AWS",
    "I wrote unit tests and documentation for the OCR ingestion pipelines",
    // Figures the entry does not hold.
    "I converted past papers into a bank of 20,000 questions",
    "I measured small fanout under 100ms at 1K followers",
  ])
    assert.equal(heldByOneEntry(claim, entries), false, claim);
});

// A report on an Ashby form: "What AI technologies are you
// comfortable with?" was left empty because every "I'm comfortable with X"
// was read as a claim of work done.
test("a skill said as \"comfortable with\" rests on an entry naming it, and never on a line of known gaps", () => {
  const entries = evidenceEntries(
    [
      "## Skills inventory",
      "- **ML / AI:** PyTorch, Hugging Face Transformers, Claude API, embeddings",
      "## Projects",
      "### Paper search",
      "- Built retrieval over 12,000 papers with embeddings.",
      "## Known gaps (state honestly)",
      "- **Docker:** single-node only. No cluster orchestration, no Kubernetes.",
    ].join("\n"),
  );
  const sentence = "I'm comfortable with PyTorch, Hugging Face Transformers and Claude APIs, and I've used them in projects.";
  for (const claim of ["I'm comfortable with Hugging Face Transformers", "I am comfortable with PyTorch", "I'm comfortable with Claude APIs", "I'm familiar with embeddings"])
    assert.equal(supportedBy(claim, claim, sentence, entries), true, claim);
  // A skill the profile never names, and one it names only to say it is missing.
  for (const claim of ["I'm comfortable with TensorFlow Serving", "I'm comfortable with Kubernetes operators", "Comfortable with Kubernetes"])
    assert.equal(supportedBy(claim, claim, sentence, entries), false, claim);
  // Saying what is missing is still an honest statement.
  assert.equal(supportedBy("I have not used Kubernetes", "", "I have not used Kubernetes.", entries), true);
});

// A report: two written questions were empty after the first
// fill and answered after the applicant chose Fill this step again. That
// second click was the only retry a rejected draft ever got.
test("an answer a check throws out is written once more, told why, before it is left for the applicant", async (t) => {
  const store = new Store(await mkdtemp(join(tmpdir(), "lane-second-attempt-")));
  await store.init();
  store.data.profile = structuredClone(profile);
  const config = configSchema.parse({ postingLookup: false, token: "synthetic-token-".repeat(4), model: "fixture", endpoint: "http://127.0.0.1:9/v1", tailorDir: "unused" });
  const calls: { ids: string[] | undefined; rejected?: Record<string, string> }[] = [];
  const queue = new GenerationQueue(
    store,
    config,
    async () => ({ resume: [{ factId: "a", text: profile.facts[0].text }], coverLetter: [{ text: "Dear Hiring Team,", factIds: [] }, { text: profile.facts[0].text, factIds: ["a"] }], answers: [] }),
    async () => {
      throw new Error("no tailoring in this test");
    },
    async (request, _profile, _signal, rejected) => {
      calls.push({ ids: request.questionIds, rejected });
      const asked = request.fields.filter((f) => !request.questionIds || request.questionIds.includes(f.id));
      return {
        // First attempt: two answers carry an invented result. Second: plain.
        answers: asked.map((f) => ({ fieldId: f.id, value: rejected ? `Second answer to ${f.label}.` : f.label.startsWith("sound") ? `First answer to ${f.label}.` : `First answer to ${f.label}, which doubled revenue.`, factIds: [] })),
        warnings: [],
        withheld: [],
        sources: {},
      };
    },
    async () => undefined,
    async (drafts) =>
      new Map(
        drafts.map((draft) => [
          draft.id,
          {
            // The invented result is always faulted; "stubborn" is faulted whatever it says.
            unsupported: /doubled revenue/.test(draft.text) ? ["doubled revenue"] : /stubborn/.test(draft.text) ? ["Second answer"] : [],
            addressesReader: false,
            filler: [],
          },
        ]),
      ),
  );
  const fields = [field("fixable"), field("stubborn"), field("sound from the start")];
  const job = await queue.enqueue({ ...request(fields), purpose: "answers", questionIds: fields.map((f) => f.id) });
  const deadline = Date.now() + 30000;
  while (["queued", "running"].includes(job.status)) {
    assert.ok(Date.now() < deadline);
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(job.status, "complete", job.error);
  // Two attempts and no third; the second is only for what was thrown out, with the reason.
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].ids, ["fixable", "stubborn"]);
  assert.match(calls[1].rejected!.fixable, /doubled revenue/);
  const drafts = Object.fromEntries(job.answerDrafts!.map((draft) => [draft.label, draft.value]));
  assert.equal(drafts.fixable, "Second answer to fixable.");
  assert.equal(drafts["sound from the start"], "First answer to sound from the start.");
  // What fails twice is left, once, with the second attempt's reason.
  assert.equal(drafts.stubborn, "");
  const left = job.warnings!.filter((warning) => warning.startsWith('Left "stubborn"'));
  assert.equal(left.length, 1);
  assert.match(left[0], /what the draft said: "Second answer"/);
  assert.ok(!job.warnings!.some((warning) => warning.startsWith('Left "fixable"')));

  // The writer is told why, in the question itself.
  const { config: live, sent } = await endpoint(t, [{ fieldId: "q1", text: "I built a TypeScript web application used by 2,000 students.", sources: ["Student app"] }]);
  const context = await skillContext(await checkout());
  await writeAnswers(live, request([field("What did you build?")]), profile, context, new AbortController().signal, { rejected: { "What did you build?": "the drafted answer mentioned Initech, which your profile and this posting do not contain" } });
  assert.match(JSON.parse(sent().messages[1].content).questions[0].notUsed, /mentioned Initech/);
  assert.match(sent().messages[0].content, /notUsed on a question says why your earlier answer to it could not be used/);
});

test("without a readable posting, why-this-company questions are the applicant's", async (t) => {
  const { config, sent } = await endpoint(t, []);
  const blank = request([field("Why do you want to work at Acme?"), field("Describe a project you are proud of")]);
  blank.description = "";
  const context = await skillContext(await checkout());
  const result = await writeAnswers(config, blank, profile, context, new AbortController().signal);
  const input = JSON.parse(sent().messages[1].content);
  assert.deepEqual(input.questions.map((q: { label: string }) => q.label), ["Describe a project you are proud of"]);
  assert.deepEqual(result.withheld, ["Why do you want to work at Acme?", "Describe a project you are proud of"]);
  assert.match(result.reasons!["Describe a project you are proud of"], /omitted/);
  assert.match(result.warnings.join(" "), /posting could not be read/);
});

// The checker follows the Drafting order in Settings, passing over the model
// that wrote the draft (: it was the endpoint's model every time,
// though the applicant had set Claude, then Codex, then that endpoint).
test("the verifier is never the drafting model, and follows the Drafting order", () => {
  const base = { token: "synthetic-token-".repeat(4), endpoint: "http://127.0.0.1:9/v1" };
  const names = (steps: { provider: string; model: string }[]) => steps.map((step) => `${step.provider}:${step.model}`);
  const ordered = configSchema.parse({
    ...base,
    model: "qwen",
    verifyModel: "qwen",
    draftProviders: [
      { id: "claude", provider: "claude-cli", model: "sonnet" },
      { id: "codex", provider: "codex-cli", model: "gpt" },
      { id: "endpoint", provider: "http", model: "qwen" },
    ],
  });
  assert.deepEqual(names(checkers(ordered, { provider: "claude-cli", model: "sonnet" })), ["codex-cli:gpt", "http:qwen"]);
  assert.deepEqual(names(checkers(ordered, { provider: "codex-cli", model: "gpt" })), ["claude-cli:sonnet", "http:qwen"]);
  assert.deepEqual(names(checkers(ordered, { provider: "http", model: "qwen" })), ["claude-cli:sonnet", "codex-cli:gpt"]);
  // A checking model named on its own comes after the order.
  assert.deepEqual(names(checkers(configSchema.parse({ ...base, provider: "http", model: "qwen", verifyModel: "devstral" }), { provider: "http", model: "qwen" })), ["http:devstral"]);
  // A Checking order of its own is the whole policy, minus the draft's
  // writer, and one checker in it is enough.
  const chosen = configSchema.parse({
    ...ordered,
    checkProviders: [
      { id: "checker", provider: "codex-cli", model: "codex-checker-model", effort: "low" },
      { id: "endpoint", provider: "http", model: "qwen" },
    ],
  });
  assert.deepEqual(names(checkers(chosen, { provider: "claude-cli", model: "sonnet" })), ["codex-cli:codex-checker-model", "http:qwen"]);
  assert.deepEqual(names(checkers(chosen, { provider: "http", model: "qwen" })), ["codex-cli:codex-checker-model"]);
  assert.ok(verifier(configSchema.parse({ ...base, provider: "http", model: "gemma", checkProviders: [{ id: "checker", provider: "codex-cli", model: "codex-checker-model" }] })));
  // One model alone checks nothing.
  assert.equal(verifier(configSchema.parse({ ...base, provider: "http", model: "gemma" })), undefined);
  assert.equal(verifier(configSchema.parse({ ...base, provider: "http", model: "gemma", verifyModel: "gemma" })), undefined);
  assert.ok(verifier(configSchema.parse({ ...base, provider: "claude-cli", model: "gemma" })));
});

test("a claim stands on a quote the profile really holds, never on the verifier's say-so", async (t) => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const asked = JSON.parse(body.messages[1].content);
    const claimsOf = (draft: string) => draft.startsWith("Acme")
      ? [
          // What the employer says of itself in the question: supported there.
          { claim: "Acme asks for Extreme Ownership", quote: "Our principles are Extreme Ownership" },
          // The question never vouches for the applicant.
          { claim: "I led Extreme Ownership training", quote: "Our principles are Extreme Ownership" },
        ]
      : draft.startsWith("I built")
      ? [
          // Quoted from the profile, with an elision: supported.
          { claim: "built a fan-out backend on Redis Streams", quote: "Built a hybrid push/pull fan-out backend ... Redis Streams" },
          // A quote the profile does not hold: not supported.
          { claim: "used PostgreSQL on it", quote: "Used PostgreSQL for the fan-out backend" },
        ]
      : [
          // No quote, but one entry holds every word: supported after all.
          { claim: "founded Pixelforge", quote: null },
          // No quote, and no entry holds it all: not supported.
          { claim: "ran Pixelforge on Kubernetes", quote: null },
        ];
    const answer = asked.drafts
      ? { drafts: asked.drafts.map((draft: { id: string; text: string }) => ({ id: draft.id, claims: claimsOf(draft.text), addressesReader: false, filler: [] })) }
      : { claims: claimsOf(asked.draft.text), addressesReader: false, filler: [] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const check = verifier(configSchema.parse({
    token: "synthetic-token-".repeat(4),
    provider: "http",
    model: "drafter",
    verifyModel: "checker",
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
  }))!;
  const profileText = [
    "## Education",
    "- M.S. Data Science, in progress.",
    "### Distributed Fan-Out Backend",
    "- Built a hybrid push/pull fan-out backend on MongoDB and Redis Streams.",
    "### Founder — Pixelforge",
    "- Founded Pixelforge and built its PDF ingestion.",
    "### Brightline.AI",
    "- Shipped RAG integrations.",
  ].join("\n");
  const drafter = { provider: "http" as const, model: "drafter" };
  const verdicts = await check(
    [
      { id: "letter:1", kind: "letter", draftedWith: drafter, text: "I built a fan-out backend on Redis Streams. I used PostgreSQL on it." },
      { id: "answer:x", kind: "answer", question: "Tell us about a project", draftedWith: drafter, text: "I founded Pixelforge. I ran Pixelforge on Kubernetes." },
      { id: "answer:y", kind: "answer", question: "Our principles are Extreme Ownership and Bias for Action. Which resonates most?", draftedWith: drafter, text: "Acme asks for Extreme Ownership. I led Extreme Ownership training." },
    ],
    { profile: profileText, posting: "" },
    new AbortController().signal,
  );
  // One request for the three, to the verifying model, with only the entries
  // they touch (: a request each cost a CLI checker three times).
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "checker");
  assert.match(requests[0].messages[0].content, /several drafts/);
  assert.match(requests[0].messages[1].content, /Fan-Out Backend/);
  assert.doesNotMatch(requests[0].messages[1].content, /Brightline/);
  assert.deepEqual(verdicts.get("letter:1")?.unsupported, ["used PostgreSQL on it"]);
  assert.deepEqual(verdicts.get("answer:x")?.unsupported, ["ran Pixelforge on Kubernetes"]);
  assert.deepEqual(verdicts.get("answer:y")?.unsupported, ["I led Extreme Ownership training"]);
});

test("the queue applies the verifier's reading, keeps withheld questions empty, and leads with eligibility", async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), "lane-verify-queue-")));
  await store.init();
  store.data.profile = structuredClone(profile);
  const config = configSchema.parse({ postingLookup: false, token: "synthetic-token-".repeat(4), model: "fixture", endpoint: "http://127.0.0.1:9/v1", tailorDir: "unused" });
  let seen: Draft[] = [];
  const run = async (verify: (drafts: Draft[]) => Promise<Map<string, Verdict>>, keptAnswer = "From the letter request.") => {
    const queue = new GenerationQueue(
      store,
      config,
      async () => ({
        resume: [{ factId: "a", text: profile.facts[0].text }],
        coverLetter: [
          { text: "Dear Hiring Team,", factIds: [] },
          {
            text: "I built a TypeScript web application used by 2,000 students. I use it daily. I did this as an intern. Students used it for course planning. It ran on a small server. I wrote its tests.",
            factIds: ["a"],
          },
        ],
        answers: [
          { fieldId: "skipped", value: "Written by the letter request.", factIds: ["a"] },
          { fieldId: "kept", value: keptAnswer, factIds: ["a"] },
        ],
      }),
      async () => ({
        checkout: "unused",
        variant: "software",
        file: "resume.tex",
        brief: { summary_line: "Engineer who led a team of five." },
        cautions: [],
        eligibility: ["Requires graduation between Spring 2028 and Winter 2029; you finish in December 2027."],
        warnings: [],
      }),
      async () => ({
        answers: [{ fieldId: "written", value: "I built a TypeScript web application used by 2,000 students.", factIds: [] }],
        warnings: ['Left "skipped" for you: nothing in your profile answers it.'],
        withheld: ["skipped"],
        sources: { written: "Student app" },
      }),
      async () => undefined,
      async (drafts) => {
        seen = drafts;
        return verify(drafts);
      },
    );
    const req = request([field("skipped"), field("kept"), field("written"), field("Cover Letter", { kind: "file", documentKind: "cover" })]);
    const job = await queue.enqueue(req);
    const deadline = Date.now() + 30000;
    while (["queued", "running"].includes(job.status)) {
      assert.ok(Date.now() < deadline);
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(job.status, "complete", job.error);
    return job.narrative!;
  };
  const verdict = (overrides: Partial<Verdict> = {}): Verdict => ({ unsupported: [], addressesReader: false, filler: [], ...overrides });
  const narrative = await run(async () =>
    new Map([
      ["answer:kept", verdict({ unsupported: ["From the letter request"] })],
      ["answer:written", verdict()],
      ["letter:1", verdict({ unsupported: ["daily"], filler: ["I did this as an intern."] })],
      ["summary", verdict({ unsupported: ["led a team of five"] })],
    ]),
  );
  // The verifier saw each answer with its source, each letter paragraph and the summary.
  assert.deepEqual(seen.map((draft) => [draft.id, draft.source]), [
    ["answer:written", "Student app"],
    ["answer:kept", undefined],
    ["letter:1", undefined],
    ["summary", undefined],
  ]);
  // "skipped" was withheld by the answer writer, so the letter request's draft does not fill it.
  assert.deepEqual(narrative.answers.map((a) => a.fieldId), ["written"]);
  assert.equal(
    narrative.coverLetter[1].text,
    "I built a TypeScript web application used by 2,000 students. Students used it for course planning. It ran on a small server. I wrote its tests.",
  );
  assert.match(narrative.warnings![0], /^Eligibility: Requires graduation between Spring 2028/);
  const warnings = narrative.warnings!.join(" ");
  assert.match(warnings, /Left "kept" for you: the checking model did not find in your profile what the draft said: "From the letter request"/);
  assert.match(warnings, /Took 2 sentences out of the cover letter/);
  assert.match(warnings, /Kept your resume's own summary: the tailored one claimed "led a team of five"/);
  // Each question left for the applicant is said once.
  assert.equal(narrative.warnings!.filter((w) => w.startsWith('Left "kept"')).length, 1);
  // A report: an essay asking for a tradeoff and a lesson was
  // left empty for two sentences the profile could not hold. Those come out,
  // as they do from the letter, and the rest of the answer is used.
  const essay = "I built a TypeScript web application used by 2,000 students. I wrote its tests. It ran on a small server. The tradeoff was speed against safety.";
  const trimmed = await run(
    async () => new Map([["answer:kept", verdict({ unsupported: ["The tradeoff was speed against safety"] })], ["answer:written", verdict()]]),
    essay,
  );
  assert.equal(trimmed.answers.find((a) => a.fieldId === "kept")?.value, "I built a TypeScript web application used by 2,000 students. I wrote its tests. It ran on a small server.");
  assert.match(trimmed.warnings!.join(" "), /Took a sentence out of your answer to "kept" that the checking model did not find in your profile: "The tradeoff was speed against safety\."/);
  assert.doesNotMatch(trimmed.warnings!.join(" "), /Left "kept"/);
  // More than half of an answer faulted is no answer: it is left, whole.
  const gutted = await run(
    async () => new Map([["answer:kept", verdict({ unsupported: ["I wrote its tests", "It ran on a small server", "The tradeoff was speed against safety"] })], ["answer:written", verdict()]]),
    essay,
  );
  assert.deepEqual(gutted.answers.map((a) => a.fieldId), ["written"]);
  assert.match(gutted.warnings!.join(" "), /Left "kept" for you: the checking model did not find in your profile what the draft said/);
  // A paragraph's opening is not taken out from under the rest of it: the
  // rest began mid-thought ("Delivery is hybrid push/pull, …", Tesla). It stays, and the card names it to check.
  const opened = await run(async () => new Map([["answer:written", verdict()], ["letter:1", verdict({ unsupported: ["I built a TypeScript web application used by 2,000 students"] })]]));
  assert.match(opened.coverLetter[1].text, /^I built a TypeScript web application used by 2,000 students\. I use it daily\./);
  assert.match(opened.warnings!.join(" "), /Kept a paragraph of the cover letter whole whose opening the checking model did not find in your profile: "I built a TypeScript web application/);
  assert.doesNotMatch(opened.warnings!.join(" "), /Took a sentence out of the cover letter/);
  // A verifier that faults most of the letter is telling about itself: the
  // letter stands, and the card says so. Two answers both faulted is no such
  // sign (the same report: an essay was filled unchecked whenever a second
  // answer happened to be drafted beside it), so each is left with its reason.
  const sweeping = await run(async (drafts) =>
    new Map(drafts.map((draft) => [draft.id, verdict({ unsupported: draft.text.split(". ").slice(0, 3) })])),
  );
  assert.deepEqual(sweeping.answers.map((a) => a.fieldId), []);
  assert.match(sweeping.coverLetter[1].text, /^I built .* I use it daily\. I did this as an intern\./);
  assert.doesNotMatch(sweeping.warnings!.join(" "), /questioned every answer/);
  assert.match(sweeping.warnings!.join(" "), /Left "written" for you/);
  assert.match(sweeping.warnings!.join(" "), /questioned 3 of the cover letter's 6 sentences/);
  // Fast checking asks no second model.
  config.checking = "fast";
  seen = [];
  const fast = await run(async () => new Map());
  config.checking = "thorough";
  assert.deepEqual(seen, []);
  assert.deepEqual(fast.answers.map((a) => a.fieldId), ["written", "kept"]);
  // A verifier that cannot answer leaves the drafts as they are, and says so.
  const unchecked = await run(async () => {
    throw new Error("HTTP 503");
  });
  assert.deepEqual(unchecked.answers.map((a) => a.fieldId), ["written", "kept"]);
  assert.match(unchecked.warnings!.join(" "), /could not check these drafts .*HTTP 503/);
});

test("a skills list never vouches for a mix of its items, and address details are the profile's", () => {
  const entries = [
    "## Skills inventory\n- Node.js (Next.js), FastAPI, Flask\n- PostgreSQL, MongoDB, Redis\n- distributed systems",
    "### Distributed Fan-Out Backend\n- Built a distributed fan-out backend with FastAPI, MongoDB and Redis.",
  ];
  assert.equal(heldByOneEntry("developed distributed systems using Node.js and PostgreSQL", entries), false);
  assert.equal(heldByOneEntry("built a distributed fan-out backend with FastAPI", entries), true);
  assert.equal(applicationQuestion(field("What is the zip code of your primary residence?", { kind: "text" })), false);
});

test("work claims need a project that names their technologies; plain skills and quotes the profile holds stand", () => {
  const entries = evidenceEntries(
    [
      "## Skills inventory",
      "- Node.js (Next.js), FastAPI, Flask, PostgreSQL, MongoDB, Redis",
      "- distributed systems, Docker",
      "### Distributed Fan-Out Backend",
      "- Built a distributed fan-out backend with FastAPI, MongoDB and Redis Streams.",
      "## Education",
      "- Pennsylvania State University, B.S. Computer Science, graduated 2024.",
    ].join("\n"),
  );
  const sentence = "I developed distributed systems using Node.js, FastAPI, and PostgreSQL.";
  // The skills line names everything, but it lists skills, not work done.
  assert.equal(supportedBy("developed distributed systems using Node.js", "Node.js (Next.js), FastAPI, Flask", sentence, entries), false);
  assert.equal(supportedBy("developed distributed systems using FastAPI", "", sentence, entries), false);
  assert.equal(supportedBy("built a distributed fan-out backend with FastAPI", "", "I built a distributed fan-out backend with FastAPI.", entries), true);
  // A plain statement of a skill rests on the skills line; an amount does not.
  assert.equal(supportedBy("I write TypeScript", "", "I write TypeScript.", evidenceEntries("## Skills inventory\n- TypeScript, React")), true);
  // A skill named in a sentence about work done is still a skill statement.
  const summary = "Software engineer who built a fan-out backend on Redis Streams and is skilled in Java, C# and SQL.";
  const skills = evidenceEntries("## Skills inventory\n- **Languages:** Python, C#, Java, SQL\n### Fan-out backend\n- Built a fan-out backend on Redis Streams.");
  for (const claim of ["skilled in Java", "skilled in C#", "skilled in SQL"]) assert.equal(supportedBy(claim, "", summary, skills), true, claim);
  assert.equal(supportedBy("built a fan-out backend in Java", "", "I built a fan-out backend in Java.", skills), false);
  assert.equal(supportedBy("three years of Redis", "", "I have three years of Redis.", entries), false);
  // A quote the profile really holds stands, short names and all.
  assert.equal(
    supportedBy("I hold a B.S. from Penn State", "Pennsylvania State University, B.S. Computer Science", "I hold a B.S. from Penn State.", entries),
    true,
  );
  // A quote copied from the draft is no evidence.
  assert.equal(supportedBy("I led a team of five", "I led a team of five", "I led a team of five.", entries), false);
  assert.equal(heldByOneEntry("built a distributed fan-out backend with FastAPI", entries), true);
});

test("letters and answers lose orphan role sentences, and R² reads as R² again", async () => {
  const { tidyProse } = await import("../src/server/generation");
  assert.equal(
    tidyProse("I shipped RAG at Brightline.AI. That work was my AI/ML Software Engineer internship. That internship ran from July to September 2023. It was fast."),
    "I shipped RAG at Brightline.AI. It was fast.",
  );
  // A sentence that says something about the internship stays.
  assert.equal(tidyProse("That internship taught me to ship features fast."), "That internship taught me to ship features fast.");
  assert.equal(tidyProse("I matched accuracy (R 2 0.86)."), "I matched accuracy (R² 0.86).");
  assert.equal(tidyProse("R2 0.998 over a full scene."), "R² 0.998 over a full scene.");
});

test("skills spread over a section's lines, employer facts beside an I, and plain self-description stand; bullets stay bullets", async () => {
  const { tidyProse } = await import("../src/server/generation");
  const entries = evidenceEntries("## Skills inventory\n- **Languages:** Python, TypeScript\n- **Frontend:** React, Vite");
  assert.equal(supportedBy("Full-stack with TypeScript, React, and Python", "", "Full-stack with TypeScript, React, and Python.", entries), true);
  // Still not a work claim's evidence.
  assert.equal(supportedBy("built a React app in Python", "", "I built a React app in Python.", entries), false);
  const posting = "Figma helps teams work together in real time from anywhere in the world.";
  assert.equal(
    supportedBy("Figma lets teams work together in real time", "work together in real time", "Figma lets teams work together in real time, and I work across layers.", entries, posting),
    true,
  );
  assert.equal(supportedBy("I work across layers", "", "Figma lets teams work together in real time, and I work across layers.", entries, posting), true);
  assert.equal(supportedBy("I have led teams for years", "", "I have led teams for years.", entries, posting), false);
  assert.equal(supportedBy("I have not shipped Go yet", "", "I have not shipped Go yet.", entries), true);
  assert.equal(supportedBy("migrated the database with no downtime", "", "I migrated the database with no downtime.", entries), false);
  assert.equal(tidyProse("- Scale: 81K users.\n- Stack: FastAPI and Redis."), "- Scale: 81K users.\n- Stack: FastAPI and Redis.");
});

test("documents are drafted from the posting the applicant gave: pasted text first, then their link", async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), "lane-given-posting-")));
  await store.init();
  store.data.profile = structuredClone(profile);
  const config = configSchema.parse({ postingLookup: true, token: "synthetic-token-".repeat(4), model: "fixture", endpoint: "http://127.0.0.1:9/v1" });
  const seen: string[] = [];
  const pages: string[] = [];
  const long = "Own the data pipelines behind our pricing models, in Python and SQL, with the analytics team. ".repeat(3);
  const queue = new GenerationQueue(
    store,
    config,
    async (request) => {
      seen.push(request.description);
      return {
        resume: [{ factId: "a", text: profile.facts[0].text }],
        coverLetter: [{ text: "Dear Hiring Team,", factIds: [] }, { text: profile.facts[0].text, factIds: ["a"] }],
        answers: [],
      };
    },
    undefined,
    undefined,
    // The site itself offers nothing.
    async () => undefined,
    undefined,
    async (url) => {
      pages.push(url);
      return url.includes("readable") ? { source: "Posting page", title: "Pricing Analyst", company: "Acme", description: long } : undefined;
    },
  );
  const run = async (given: { postingUrl?: string; postingText?: string }) => {
    const job = await queue.enqueue({ ...request([field("Cover Letter", { kind: "file", documentKind: "cover" })]), ...given });
    while (["queued", "running"].includes(job.status)) await new Promise((r) => setTimeout(r, 25));
    assert.equal(job.status, "complete", job.error);
    return job;
  };
  const pasted = await run({ postingText: long, postingUrl: "https://careers.acme.example/readable" });
  assert.equal(pasted.posting?.source, "Pasted");
  assert.match(seen.at(-1)!, /pricing models/);
  // Pasted text wins outright: the link was not even fetched.
  assert.deepEqual(pages, []);
  const linked = await run({ postingUrl: "https://careers.acme.example/readable" });
  assert.deepEqual([linked.posting?.source, linked.posting?.title], ["Posting page", "Pricing Analyst"]);
  // A link that cannot be read says to paste the posting instead.
  const unreadable = await run({ postingUrl: "https://careers.acme.example/script-built" });
  assert.equal(unreadable.posting, undefined);
  assert.match(unreadable.narrative!.warnings!.join(" "), /could not be read from the link you added.*Paste the posting's text/);
  // Unless the page's own text, read by the extension, is the posting: the
  // letter was written from it (Tesla, read in a tab the backend could not
  // fetch).
  const readInTab = await queue.enqueue({ ...request([field("Cover Letter", { kind: "file", documentKind: "cover" })]), postingUrl: "https://careers.acme.example/script-built", description: `Responsibilities and qualifications. ${long.repeat(4)}` });
  while (["queued", "running"].includes(readInTab.status)) await new Promise((r) => setTimeout(r, 25));
  assert.doesNotMatch((readInTab.narrative!.warnings || []).join(" "), /could not be read/);

  // The form's own ATS publishes the posting: it comes before a linked page
  // read as HTML, which was Simplify's list of internships on GitHub
  // (Oracle).
  const own = new GenerationQueue(
    store,
    config,
    async (request) => {
      seen.push(request.description);
      return { resume: [{ factId: "a", text: profile.facts[0].text }], coverLetter: [{ text: profile.facts[0].text, factIds: ["a"] }], answers: [] };
    },
    undefined,
    undefined,
    async () => ({ source: "Oracle", title: "Data Science Intern", company: "Acme", description: long }),
    undefined,
    async () => ({ source: "Posting page", title: "GitHub - SimplifyJobs/Summer2027-Internships", description: "Company Role Location Application ".repeat(40) }),
  );
  const listed = await own.enqueue({ ...request([field("Cover Letter", { kind: "file", documentKind: "cover" })]), postingUrl: "https://github.com/SimplifyJobs/Summer2027-Internships" });
  while (["queued", "running"].includes(listed.status)) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual([listed.posting?.source, listed.posting?.title], ["Oracle", "Data Science Intern"]);
});

const technicalQuestion = "Please give brief examples of technical products/work that you have worked on which has allowed you to demonstrate your strongest technical competencies (300 word limit).";

test("TalNet work-example questions are eligible and word limits retain complete sentences", async () => {
  const { wordLimit, wordCount, fitAnswerLength, answerLimitError } = await import("../src/shared/questions");
  assert.ok(applicationQuestion(field(technicalQuestion, { section: "Work examples" })));
  assert.ok(applicationQuestion(field(technicalQuestion, { section: technicalQuestion })));
  assert.equal(applicationQuestion(field("Description", { section: "Work Experience 2" })), false);
  assert.equal(applicationQuestion(field("School Name", { kind: "text", section: "Education Information 1" })), false);
  assert.equal(applicationQuestion(field("Years Completed", { kind: "text", section: "Academic Background #2" })), false);
  assert.equal(wordLimit(technicalQuestion), 300);
  assert.equal(wordLimit("Maximum Word Count of 300words"), 300);
  assert.equal(wordLimit("You used 300 words"), undefined);
  const fitted = fitAnswerLength("I built a web application. I improved API latency with Redis.", { maxWords: 8 });
  assert.equal(fitted, "I built a web application.");
  assert.equal(wordCount(fitted), 5);
  assert.match(answerLimitError("word ".repeat(301), { maxWords: 300 })!, /300 words/);
  assert.match(answerLimitError("a".repeat(21), { maxLength: 20 })!, /20 characters/);
});

test("structured fallback includes unresolved profile fields but never prose, secrets, attestations or protected values", () => {
  assert.equal(
    structuredFallbackField(
      field("School Attended", {
        kind: "text",
        section: "Education Information 1",
      }),
    ),
    true,
  );
  assert.equal(structuredFallbackField(field("Describe a project")), false);
  assert.equal(
    structuredFallbackField(field("I certify this application is true", { kind: "checkbox" })),
    false,
  );
  assert.equal(
    structuredFallbackField(field("Social Security Number", { kind: "text" })),
    false,
  );
  assert.equal(
    structuredFallbackField(field("School Attended", { kind: "text", protected: true })),
    false,
  );
});

test("AI structured-field suggestions require saved sources and exact available choices", async (t) => {
  let sent: any;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    sent = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                suggestions: [
                  {
                    fieldId: "q1",
                    value: "Michigan State University",
                    sourceIds: ["education.1"],
                  },
                  {
                    fieldId: "q2",
                    value: "Bachelor's degree",
                    sourceIds: ["education.1"],
                  },
                  {
                    fieldId: "q3",
                    value: "12",
                    sourceIds: [],
                  },
                  {
                    fieldId: "q4",
                    value: "N/A",
                    sourceIds: ["education.1"],
                  },
                  {
                    fieldId: "q5",
                    value: "N/A",
                    sourceIds: ["education.1"],
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const config = configSchema.parse({
    postingLookup: false,
    token: "fallback-token-".repeat(4),
    model: "fallback-fixture",
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
  });
  const withEducation = profileSchema.parse({
    ...profile,
    education: [
      {
        organization: "Michigan State University",
        title: "Bachelor of Science",
        fieldOfStudy: "Computer Science",
        startDate: "2022-08",
        endDate: "2026-05",
        location: "Tucson, Arizona",
      },
    ],
  });
  const fields = [
    field("School Attended", {
      id: "school",
      kind: "text",
      section: "Education Information 1",
    }),
    field("Degree level", {
      id: "degree",
      kind: "select",
      section: "Education Information 1",
      options: ["High school", "Bachelor's degree", "Master's degree"],
    }),
    field("Years Completed", {
      id: "years",
      kind: "text",
      section: "Education Information 1",
      // What the rest of its row shows, for the model to tell the entries
      // apart.
      row: 'Entry 1 of "Education Information 1": School Attended: Michigan State University',
    }),
    field("Date Of Clearance", {
      id: "clearance-date",
      kind: "text",
      section: "Job-Specific Information",
    }),
    field("If Yes, what is your relationship to the employee(s)", {
      id: "relationship",
      kind: "text",
      required: false,
      section: "Job-Specific Information",
    }),
  ];
  const result = await writeFieldFallback(
    config,
    {
      ...request(fields),
      purpose: "field-fallback",
      fallbackReasons: fields.map((candidate) => ({
        fieldId: candidate.id,
        reason: "Normal fill could not match this field.",
      })),
    },
    withEducation,
    new AbortController().signal,
  );
  assert.equal(result.drafts[0].value, "Michigan State University");
  assert.match(result.drafts[0].source!, /Michigan State University/);
  assert.deepEqual(result.drafts[0].draftedWith, {
    provider: "http",
    model: "fallback-fixture",
  });
  assert.equal(result.drafts[1].value, "Bachelor's degree");
  assert.equal(result.drafts[2].value, "");
  assert.match(result.drafts[2].skipReason!, /did not cite/);
  // A date box takes only a date: "N/A" there was invalid.
  assert.equal(result.drafts[3].value, "");
  assert.match(result.drafts[3].skipReason!, /not a date/);
  // An optional follow-up to a Yes is left empty: its "N/A" beside the
  // question it follows read as a contradiction.
  assert.equal(result.drafts[4].value, "");
  assert.match(result.drafts[4].skipReason!, /follow-up to a Yes/);
  const input = JSON.parse(sent.messages[1].content);
  assert.ok(
    input.sources.some(
      (source: { id: string; text: string }) =>
        source.id === "education.1" &&
        source.text.includes("Michigan State University"),
    ),
  );
  assert.equal(
    input.sources.some((source: { id: string }) => source.id === "profile.email"),
    false,
  );
  assert.deepEqual(input.fields[1].options, fields[1].options);
  assert.equal(input.fields[2].row, fields[2].row);
  assert.equal(input.fields[0].row, undefined);
  assert.match(sent.messages[0].content, /"row" belongs to one entry/);
  assert.ok(fieldFallbackSources(withEducation).some((source) => source.id === "education.1"));
});

test("single-question drafts keep page context, plural project sources, model identity and limits", async (t) => {
  const { config, sent } = await endpoint(t, [
    { fieldId: "q1", text: "I built a TypeScript web application used by 2,000 students. I cut API latency 35% with a Redis cache at Initrode.", sources: ["Student web application", "Platform Engineer"] },
  ]);
  const context = await skillContext(await checkout());
  const selected = field(technicalQuestion, { id: "technical", section: "Work examples", maxWords: 300 });
  const req = { ...request([selected, field("Tell us about a difficult problem", { id: "other" }), field("Area selected", { kind: "select", value: "Backend", options: ["Backend"] })]), purpose: "answers" as const, questionIds: ["technical"] };
  const written = await writeAnswers(config, req, profile, context, new AbortController().signal);
  const input = JSON.parse(sent().messages[1].content);
  assert.equal(input.questions.length, 1);
  assert.equal(input.questions[0].maxWords, 300);
  assert.equal(input.pageFields[0].chosen, "Backend");
  assert.equal(written.answers.length, 1);
  assert.equal(written.answers[0].fieldId, "technical");
  assert.match(written.sources.technical, /Student web application; Platform Engineer/);
  assert.deepEqual(written.providers!.technical, { provider: "http", model: "fixture" });
  assert.match(sent().messages[0].content, /multiple relevant real projects/);
});

test("all empty questions are drafted in bounded batches, including more than 25 questions", async (t) => {
  const { config } = await endpoint(t, [1, 2, 3, 4, 5].map((i) => ({ fieldId: `q${i}`, text: "I built a TypeScript web application used by 2,000 students.", source: "Student web application" })));
  const fields = Array.from({ length: 27 }, (_, i) => field(`Describe project example ${i}`, { id: `field-${i}` }));
  const written = await writeAnswers(config, request(fields), profile, { profile: "", preferences: "", guidance: "", warnings: [] }, new AbortController().signal);
  assert.equal(written.answers.length, 27);
  assert.deepEqual(new Set(written.answers.map((answer) => answer.fieldId)), new Set(fields.map((field) => field.id)));
});

test("suggestions for unfilled fields read the graduation date this application states", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lane-fallback-graduation-"));
  await writeFile(join(dir, "preferences.md"), "## Education timeline\n- **Graduation by role:** internships and co-ops: December 13, 2098. Full-time and new-grad roles: May 10, 2099.\n");
  const store = new Store(await mkdtemp(join(tmpdir(), "lane-fallback-store-")));
  await store.init();
  store.data.profile = profileSchema.parse({ ...profile, education: [{ organization: "Michigan State University", title: "Master of Science", startDate: "2025-08-21", endDate: "2099-05-10" }] });
  const config = configSchema.parse({ token: "test-token-".repeat(5), postingLookup: false, tailorDir: dir });
  const seen: string[] = [];
  const queue = new GenerationQueue(store, config, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async (_request, given) => { seen.push(given.education[0].endDate); return { drafts: [], warnings: [] }; });
  const graduation = field("Expected graduation date", { id: "graduation", kind: "text" });
  for (const title of ["Software Engineer Intern", "Software Engineer, New Grad"]) {
    const job = await queue.enqueue({ ...request([graduation]), title, purpose: "field-fallback", fallbackReasons: [{ fieldId: "graduation", reason: "Normal fill could not match this field." }] });
    const deadline = Date.now() + 5000;
    while (["queued", "running"].includes(job.status)) { assert.ok(Date.now() < deadline); await new Promise((r) => setTimeout(r, 10)); }
    assert.equal(job.status, "complete", job.error);
  }
  // The internship's date moves to the rule's day; the full-time one is the
  // profile's own (its month already agrees with the rule).
  assert.deepEqual(seen, ["2098-12-13", "2099-05-10"]);
});

test("answers-only jobs do not generate documents or assess fit, and do not verify a model with itself", async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), "lane-answer-only-")));
  await store.init(); store.data.profile = structuredClone(profile);
  // The Drafting order holds one model: nothing else can check what it wrote.
  const config = configSchema.parse({ token: "test-token-".repeat(5), provider: "http", model: "gemma", postingLookup: false });
  let verified = false;
  const queue = new GenerationQueue(store, config,
    async () => { throw new Error("document generator must not run"); },
    async () => { throw new Error("tailoring must not run"); },
    async () => ({ answers: [{ fieldId: "technical", value: profile.facts[0].text, factIds: [] }], warnings: [], withheld: [], sources: { technical: "Student web application" }, providers: { technical: { provider: "http", model: "gemma" } } }),
    async () => undefined,
    async () => { verified = true; return new Map(); },
    undefined,
    async () => { throw new Error("fit must not run"); },
  );
  const job = await queue.enqueue({ ...request([field(technicalQuestion, { id: "technical", maxWords: 300 })]), purpose: "answers", questionIds: ["technical"] });
  const deadline = Date.now() + 5000;
  while (["queued", "running"].includes(job.status)) { assert.ok(Date.now() < deadline); await new Promise((r) => setTimeout(r, 10)); }
  assert.equal(job.status, "complete", job.error);
  assert.equal(job.narrative, undefined);
  assert.deepEqual(job.artifacts, []);
  assert.equal(job.fit, undefined);
  assert.equal(job.answerDrafts![0].maxWords, 300);
  assert.equal(job.answerDrafts![0].source, "Student web application");
  assert.equal(verified, false);
  assert.match(job.warnings!.join(" "), /without a second model check/);
});

test("cancelled and superseded answer jobs never complete a usable review", async () => {
  for (const cancel of [true, false]) {
    const store = new Store(await mkdtemp(join(tmpdir(), "lane-answer-cancel-")));
    await store.init(); store.data.profile = structuredClone(profile);
    const config = configSchema.parse({ token: "test-token-".repeat(5), postingLookup: false, checking: "fast" });
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((r) => { started = r; });
    const queue = new GenerationQueue(store, config, undefined, undefined, async () => {
      started(); await new Promise<void>((r) => { release = r; });
      return { answers: [{ fieldId: "technical", value: profile.facts[0].text, factIds: [] }], warnings: [], withheld: [], sources: {} };
    });
    const job = await queue.enqueue({ ...request([field(technicalQuestion, { id: "technical" })]), purpose: "answers" });
    await ready;
    if (cancel) await queue.cancel(job.id); else store.data.profile.revision++;
    release();
    const deadline = Date.now() + 5000;
    // A cancelled/superseded synthetic job can finish within the same clock
    // millisecond. Zero is a completed duration, not an unfinished job.
    while (job.durationMs === undefined) { assert.ok(Date.now() < deadline); await new Promise((r) => setTimeout(r, 10)); }
    assert.equal(job.status, cancel ? "cancelled" : "failed");
    assert.deepEqual(job.artifacts, []);
  }
});

test("an option carrying its own short code matches only on its full remaining text", async () => {
  const { pickOption } = await import("../src/shared/answers");
  const pick = (value: string, options: string[]) => pickOption({ value }, options, (o) => o);
  assert.equal(pick("Computer Science", ["CE - Computer Engineering", "CS - Computer Science", "Data Science"]), "CS - Computer Science");
  assert.equal(pick("Computer Science", ["Computer Science (CS)", "Computer Engineering (CE)"]), "Computer Science (CS)");
  // Exact wording still wins, and a longer or different remainder is no match.
  assert.equal(pick("Computer Science", ["CS - Computer Science", "Computer Science"]), "Computer Science");
  assert.equal(pick("Computer Science", ["CS - Computer Science and Engineering", "No - Computer Science degree"]), undefined);
  assert.equal(pick("Science", ["CS - Computer Science"]), undefined);
  // A phone-country list appends dial codes; several countries share "+1".
  assert.equal(pick("United States", ["United States +1", "Canada +1", "United States Minor Outlying Islands +1"]), "United States +1");
  assert.equal(pick("Canada", ["United States +1", "Canada (+1)"]), "Canada (+1)");
});

// A report: a required essay was left empty, and the card showed
// the question in one line and why in another, under a label cut short.
test("the reason a required question was left empty is paired with that question", () => {
  const question = "Describe one project in 200 words or less: what you built, what you owned or decided, a tradeoff you wrestled with, and what you learned from it afterwards.";
  const items = [
    'Left "If you selected "Other", please say more." for you: nothing has Other selected.',
    `Left "${question.slice(0, 118)}…" for you: the checking model did not find in your profile what the draft said: "the tradeoff was speed".`,
    "Required: I agree to the hours.",
    `Required: ${question}`,
  ];
  const { reasons, used } = leftReasons(items);
  assert.deepEqual([...reasons], [[items[3], 'the checking model did not find in your profile what the draft said: "the tradeoff was speed".']]);
  assert.deepEqual([...used], [items[1]]);
});

// A report: a draft naming "Kolmogorov–Arnold Networks" reached
// the checker as "Kolmogorov, Arnold Networks", which the profile does not say.
test("a dash that joins two words in a draft is kept, and one used as punctuation becomes a comma", async (t) => {
  const { config } = await endpoint(t, [
    { fieldId: "q1", text: "I enjoy read–write caches – they are quick — and simple." },
  ]);
  const context = await skillContext(await checkout());
  const result = await writeAnswers(config, request([field("What do you enjoy building?")]), profile, context, new AbortController().signal);
  assert.equal(result.answers[0]?.value, "I enjoy read–write caches, they are quick, and simple.");
});

// Measured on with eighteen claims, true and false, against a real
// profile: the checking model quotes the nearest entry for any claim, and a
// real quote passed whatever the claim added to it. These are made-up
// entries of the same shape.
test("a real quote vouches only for what its entry says: figures, durations and standing included", () => {
  const entries = [
    "- Cut a benchmark's runtime from 172 min to 15 min (11x) by moving evaluation to the CPU.",
    "- Integrated retrieval into Orbitly's production chat platform (600+ brands).",
    "- Software Engineer Intern Jul 2023 – Sep 2023 Orbitly",
    "- Built the U-Net baseline (~1.9M params) on a 6-node cluster; A100 ran it ~52x faster than the old cards.",
  ];
  const quote = (index: number) => entries[index].slice(2, 60);
  const check = (claim: string, index: number) => supportedBy(claim, quote(index), `I ${claim}.`, entries);
  // A figure the entry does not hold.
  assert.equal(check("cut a benchmark's runtime from 172 minutes to 5", 0), false);
  assert.equal(check("cut a benchmark's runtime from 172 minutes to 15", 0), true);
  // Standing the entry does not give.
  assert.equal(check("led the team that integrated retrieval into Orbitly's platform", 1), false);
  assert.equal(supportedBy("worked at Orbitly for two years", quote(2), "I worked at Orbitly for two years.", entries), false);
  // The same figure written another way is the same figure.
  assert.equal(supportedBy("Orbitly's platform serves more than 600 brands", quote(1), "Orbitly's platform serves more than 600 brands.", entries), true);
  assert.equal(supportedBy("Orbitly's platform serves more than 6,000 brands", quote(1), "Orbitly's platform serves more than 6,000 brands.", entries), false);
  assert.equal(supportedBy("my internship at Orbitly ran from July to September 2023", quote(2), "My internship at Orbitly ran from July to September 2023.", entries), true);
  assert.equal(supportedBy("my internship at Orbitly ran from January to August 2023", quote(2), "My internship at Orbitly ran from January to August 2023.", entries), false);
  assert.equal(check("built a U-Net baseline of roughly 1.9 million parameters on a six-node cluster", 3), true);
  assert.equal(check("built a U-Net baseline that the A100 ran about 52 times faster", 3), true);
  assert.equal(check("built a U-Net baseline that the A100 ran about 25 times faster", 3), false);
});

test("what a sentence says that the checker left out of its claims is checked as well", () => {
  const entries = ["- Built a fan-out backend on a 12-node Docker deployment with Redis Streams.", "- Integrated retrieval into Orbitly's production chat platform."];
  // The checker took up only what it could vouch for.
  assert.deepEqual(
    unclaimed("I built a fan-out backend on a 40-node Kubernetes deployment with Kafka.", ["built a fan-out backend"], entries),
    ["I built a fan-out backend on a 40-node Kubernetes deployment with Kafka."],
  );
  assert.deepEqual(unclaimed("At Orbitly I led the team that integrated retrieval.", ["integrated retrieval into Orbitly's platform"], entries), [
    "At Orbitly I led the team that integrated retrieval.",
  ]);
  // Nothing left out, or what is left out is in the entry, or is the employer's own.
  assert.deepEqual(unclaimed("I built a fan-out backend on a 12-node Docker deployment.", ["built a fan-out backend"], entries), []);
  // Words that begin like a month are no month (found by the Linux session:
  // "decision", "junior" and "augmented" read as December, June and August).
  const dated = ["- Built a search tool in React for course notes, Mar 2025."];
  for (const sentence of [
    "I made a design decision to keep the search tool in React.",
    "I built the junior developer onboarding guide for the search tool in React.",
    "I augmented the search tool in React with novel features.",
  ])
    assert.deepEqual(unclaimed(sentence, ["search tool in React"], dated), [], sentence);
  assert.deepEqual(unclaimed("I built the search tool in React in March 2025.", ["built the search tool in React"], dated), []);
  assert.deepEqual(unclaimed("I built the search tool in React in June 2025.", ["built the search tool in React"], dated), ["I built the search tool in React in June 2025."]);
  assert.deepEqual(unclaimed("I built a fan-out backend with Redis Streams, the kind Acme runs.", ["built a fan-out backend with Redis Streams"], entries, "Acme runs Redis"), []);
});

// Measured on: checking models that reason first took 65 to over
// 150 seconds a draft on a hosted endpoint, and one told not to answered in
// about five. A chosen checking model is asked not to; an endpoint that
// refuses the option is asked again without it.
test("the checking model is asked not to reason, and asked again plainly if the endpoint refuses", async (t) => {
  const bodies: any[] = [];
  let refuse = true;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    bodies.push(body);
    if (refuse && body.reasoning_effort) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unrecognized request argument: reasoning_effort" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ claims: [], addressesReader: false, filler: [] }) } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const draft: Draft = { id: "answer:q", kind: "answer", draftedWith: { provider: "claude-cli", model: "sonnet" }, text: "I like tidy code." };
  const evidence = { profile: "- Wrote tidy code.", posting: "" };
  // Claude drafts; the checking model named on its own checks.
  const claudeOnly = [{ id: "claude", provider: "claude-cli" as const, model: "sonnet" }];
  const chosen = configSchema.parse({ postingLookup: false, token: "synthetic-token-".repeat(4), model: "writer", verifyModel: "checker", draftProviders: claudeOnly, endpoint });
  assert.ok((await verifier(chosen)!([draft], evidence, new AbortController().signal)).has("answer:q"));
  assert.deepEqual(bodies.map((body) => body.reasoning_effort), ["none", undefined]);
  // An endpoint that takes the option is asked once.
  refuse = false;
  bodies.length = 0;
  await verifier(chosen)!([draft], evidence, new AbortController().signal);
  assert.deepEqual(bodies.map((body) => body.reasoning_effort), ["none"]);
  // So is the endpoint's own model when it does the checking: an applicant
  // put the model they chose for checking there.
  bodies.length = 0;
  await verifier(configSchema.parse({ postingLookup: false, token: "synthetic-token-".repeat(4), model: "writer", draftProviders: [...claudeOnly, { id: "endpoint", provider: "http", model: "writer" }], endpoint }))!([draft], evidence, new AbortController().signal);
  assert.deepEqual(bodies.map((body) => body.reasoning_effort), ["none"]);
});

// A report (one employer's form): the checking model slowed to its
// limit of three minutes a draft, the fill showed nothing for five, and the
// applicant gave up. Checking stops at its deadline: what was checked by
// then counts, the rest goes unchecked, and none at all is said plainly.
test("checking stops at its deadline with what it has checked", async (t) => {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    // The slow draft is never answered.
    if (Buffer.concat(chunks).toString().includes("slow")) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ claims: [], addressesReader: false, filler: [] }) } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const check = verifier(configSchema.parse({ postingLookup: false, token: "synthetic-token-".repeat(4), model: "writer", verifyModel: "checker", draftProviders: [{ id: "claude", provider: "claude-cli", model: "sonnet" }], endpoint }))!;
  const evidence = { profile: "- Wrote tidy code.", posting: "" };
  const claude = { provider: "claude-cli" as const, model: "sonnet" };
  const quick: Draft = { id: "answer:quick", kind: "answer", draftedWith: claude, text: "I like tidy code." };
  // Drafts of one writer go in one request; another writer's in another.
  const slow: Draft = { id: "answer:slow", kind: "answer", draftedWith: { provider: "http", model: "writer" }, text: "I like slow code." };
  const started = Date.now();
  const verdicts = await check([quick, slow], evidence, new AbortController().signal, AbortSignal.timeout(300));
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual([...verdicts.keys()], ["answer:quick"]);
  await assert.rejects(check([slow], evidence, new AbortController().signal, AbortSignal.timeout(300)), /took too long/);
});

// A report (one employer's form): "If you do require employee
// sponsorship or assistance…, please list the type of support" was optional,
// and the draft answered it with "I do not require…".
test("an optional question asked only if something holds stays empty when the draft says it does not", async (t) => {
  const { config } = await endpoint(t, [
    { fieldId: "q1", text: "I do not require employer sponsorship or assistance for work authorization." },
    { fieldId: "q2", text: "I built a TypeScript web application used by 2,000 students." },
  ]);
  const context = await skillContext(await checkout());
  const result = await writeAnswers(
    config,
    request([
      field("If you do require employee sponsorship or assistance for work authorization, please list the type of support you may require.", { required: false }),
      field("What did you build?"),
    ]),
    profile,
    context,
    new AbortController().signal,
  );
  assert.deepEqual(result.answers.map((answer) => answer.fieldId), ["What did you build?"], result.warnings.join(" | "));
  assert.match(result.warnings.join(" "), /applies only if its condition holds/);
});

// one employer's SuccessFactors called "I accept the posted rate of $25.40 to
// $29.00 per hour." an invalid number, as one employer's did
// "$100,000 per year" (b5d63aeb): a one-line salary box takes the figure.
test("a one-line salary box gets the figure the drafted answer names", () => {
  const asked = "What is your desired salary?";
  assert.equal(salaryFigure(asked, "text", "I accept the posted rate of $25.40 to $29.00 per hour."), "25.40");
  assert.equal(salaryFigure(asked, "text", "$100,000 per year"), "100000");
  assert.equal(salaryFigure("Salary expectations", "text", "Around $95k base."), "95000");
  assert.equal(salaryFigure(asked, "number", "100000"), "100000");
  // A written question keeps its words; so do other questions and no figure.
  assert.equal(salaryFigure(asked, "textarea", "I accept the posted rate of $25.40 to $29.00 per hour."), undefined);
  assert.equal(salaryFigure("Why do you want this job?", "text", "It pays $30 an hour."), undefined);
  assert.equal(salaryFigure(asked, "text", "Open to discussing the posted range."), undefined);
});

test("a degree listed with the subjects it covers, and a Low-to-High language scale, are picked", async () => {
  // one employer's Workday: Degree and each language level were left.
  const { pickOption } = await import("../src/shared/answers");
  const { levelChoices } = await import("../src/shared/languages");
  const degrees = ["Select One", "High School", "Associates of Arts or Science (Associates)", "Bachelors of Arts or Science (Bachelors)", "Masters of Technology (Masters)", "Masters of Arts or Science or Business Administration (Masters)", "Doctor of Philosophy or Juris Doctor (Doctorate)"];
  const pick = (value: string, choices: string[], options: string[]) => pickOption({ value, choices }, options, (option) => option);
  assert.equal(pick("M.S. - Master of Science", ["Masters of Science", "Master of Science"], degrees), "Masters of Arts or Science or Business Administration (Masters)");
  assert.equal(pick("B.S. - Bachelor of Science", ["Bachelor of Science"], degrees), "Bachelors of Arts or Science (Bachelors)");
  // Another subject, or another level, is not it.
  assert.equal(pick("Master of Engineering", [], degrees), undefined);
  assert.equal(pick("Bachelor of Engineering", [], ["Masters of Arts or Science (Masters)", "Bachelors of Arts or Science (Bachelors)"]), undefined);
  // one employer's: the degree's name with "Degree" after it.
  const levelsWithDegree = ["Select One", "Associate of Science Degree", "Bachelor of Science Degree", "Bachelor's Degree or equivalent", "Master of Science Degree", "Master of Laws (LLM)"];
  assert.equal(pick("M.S. - Master of Science", ["Masters of Science", "Master of Science"], levelsWithDegree), "Master of Science Degree");
  assert.equal(pick("B.S. - Bachelor of Science", ["Bachelor of Science"], levelsWithDegree), "Bachelor of Science Degree");
  // one employer's: the level alone.
  const levelsOnly = ["Select One", "Advanced Diploma/Associate's Level Degree", "Bachelor's Level Degree", "Master's Level Degree", "Doctorate's Level Degree"];
  assert.equal(pick("M.S. - Master of Science", ["Masters of Science", "Master of Science"], levelsOnly), "Master's Level Degree");
  assert.equal(pick("B.S. - Bachelor of Science", ["Bachelor of Science"], levelsOnly), "Bachelor's Level Degree");
  // one employer's: the bare level, for the profile's whole degree name.
  const program = ["Select One", "Associates", "Bachelors", "Masters", "Ph.D."];
  assert.equal(pick("M.S. Data Science, Analytics & Engineering (Human-Centered Applications)", [], program), "Masters");
  assert.equal(pick("Bachelors of Science", [], program), "Bachelors");
  assert.equal(pick("Computer Science", [], program), undefined);
  const scale = ["Select One", "1 - Low", "2 - Medium", "3 - High"];
  const [first, ...rest] = levelChoices("native");
  assert.equal(pick(first, rest, scale), "3 - High");
  const [basic, ...basics] = levelChoices("basic");
  assert.equal(pick(basic, basics, scale), "1 - Low");
  // one employer's Workday: "1 - Minimal Competency" to "5 - Complete Mastery".
  const mastery = ["Select One", "1 - Minimal Competency", "2 - Limited Competency", "3 - Professional Competency", "4 - Advanced Professional Competency", "5 - Complete Mastery"];
  for (const [level, expected] of [["native", "5 - Complete Mastery"], ["fluent", "4 - Advanced Professional Competency"], ["intermediate", "3 - Professional Competency"], ["basic", "2 - Limited Competency"]] as const) {
    const [first, ...others] = levelChoices(level);
    assert.equal(pick(first, others, mastery), expected, level);
  }
});

test("a figure the draft rounded and a verb in another form are still the profile's", async () => {
  // an employer: "a U-Net that predicts sensor surface temperature
  // to 0.85 K" was taken out, the profile saying "predicting" and "0.854 K".
  const { supportedBy } = await import("../src/server/verify");
  const entries = [
    "### Thermal-cGAN\n- Built the supervised U-Net baseline predicting per-pixel sensor surface temperature from six raw thermal camera bands.\n- Reached MAE 0.854 K over a full test plate.",
  ];
  const sentence = "I have trained models on real data: a U-Net that predicts sensor surface temperature to 0.85 K.";
  const stands = (claim: string) => supportedBy(claim, "", sentence, entries);
  assert.equal(stands("a U-Net that predicts sensor surface temperature to 0.85 K"), true);
  assert.equal(stands("a U-Net that predicted sensor surface temperature"), true);
  // Another figure, or one rounded the wrong way, is not the profile's.
  assert.equal(stands("a U-Net that predicts sensor surface temperature to 0.86 K"), false);
  assert.equal(stands("a U-Net that predicts sensor surface temperature to 0.8 K"), false);
  // Nor is a result the entry does not state, in any form.
  assert.equal(stands("a U-Net that predicts sensor surface temperature and cut costs"), false);
  // Read whole, the figure keeps its unit: "0.85 K" is the entry's 0.854 K.
  const { unclaimed } = await import("../src/server/verify");
  assert.deepEqual(unclaimed(sentence, [], entries), []);
  assert.deepEqual(unclaimed("I trained a U-Net to 0.86 K.", [], entries), ["I trained a U-Net to 0.86 K."]);
});

test("saying what one is applying for is not a claim the profile has to hold", async () => {
  // Tesla: "I am applying for an engineering role at Tesla." was
  // taken out of the letter, which then opened on nothing.
  const { supportedBy, unclaimed } = await import("../src/server/verify");
  const entries = ["### Pixelforge\n- Built a live exam-prep platform."];
  const opening = "I am applying for an engineering role at Tesla.";
  assert.equal(supportedBy("applying for an engineering role at Tesla", "", opening, entries), true);
  assert.deepEqual(unclaimed(opening, [], entries), []);
  // What follows it in another sentence is still checked.
  assert.deepEqual(unclaimed(`${opening} I led a team of ten at Tesla.`, [], entries), ["I led a team of ten at Tesla."]);
});

test("a claim the checker reworded is held to the sentence it came from", async (t) => {
  // an employer: "I am applying for the Robotics Software Developer
  // role at an employer" came back reworded, was matched to the whole paragraph,
  // and missed the exemption an opening like it has.
  const server = createServer(async (req, res) => {
    for await (const _ of req) void _;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ claims: [{ claim: "applying for the Robotics Software Developer position at Acme Labs", quote: null }], addressesReader: false, filler: [] }) } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const check = verifier(configSchema.parse({ token: "synthetic-token-".repeat(4), provider: "http", model: "drafter", verifyModel: "checker", endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` }))!;
  const verdicts = await check(
    [{ id: "letter:1", kind: "letter", draftedWith: { provider: "http", model: "drafter" }, text: "I am applying for the Robotics Software Developer role at Acme Labs. I built a U-Net baseline." }],
    { profile: "### Thermal\n- Built the supervised U-Net baseline.", posting: "" },
    new AbortController().signal,
  );
  assert.deepEqual(verdicts.get("letter:1")?.unsupported, []);
});

// one employer's Greenhouse questions: a GPA list noting its scale
// after each range, and a graduation list of academic seasons.
test("a GPA takes a range noted with its 4.0 scale, and a graduation month its season", () => {
  const gpa = ["2.4 or below", "2.5 - 2.7 (out of 4.0)", "2.8 - 3.0 (out of 4.0)", "3.1 - 3.3 (out of 4.0)", "3.4 - 3.5 (out of 4.0)",
    "3.6 or above (out of 4.0)", "80% or above (Canadian Institutions)", "70-79% (Canadian Institutions)"];
  const pick = (value: string, options: string[], numeric?: number) => pickOption({ value, numeric }, options, (option) => option);
  assert.equal(pick("3.84", gpa, 3.84), "3.6 or above (out of 4.0)");
  assert.equal(pick("3.2", gpa, 3.2), "3.1 - 3.3 (out of 4.0)");
  assert.equal(pick("2.1", gpa, 2.1), "2.4 or below");
  const terms = ["Earlier than Fall 2026", "Fall 2026", "Spring 2027", "Later than Summer 2027"];
  assert.equal(pick("May 2027", terms), "Spring 2027");
  assert.equal(pick("December 2026", terms), "Fall 2026");
  assert.equal(pick("December 2027", terms), "Later than Summer 2027");
  assert.equal(pick("May 2026", terms), "Earlier than Fall 2026");
  // Summer 2027 itself is none of them.
  assert.equal(pick("July 2027", terms), undefined);
});
