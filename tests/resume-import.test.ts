import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProfile } from "../src/shared/model";
import {
  mergeResumeFacts,
  profileEditorReducer,
  resumeFacts,
  type ProfileEditorState,
} from "../src/extension/profile-state";

test("cumulative imports deduplicate whitespace and bullets while preserving facts and IDs", () => {
  const existing = [
    { id: "original", text: "Built accessible web applications." },
  ];
  const incoming = resumeFacts(
    "• Built accessible  web applications.\r\nWrote C++.\nWrote C#.\nImproved performance by 30%.\nImproved performance by 40%.\nWrote C++.\n",
  );
  const merged = mergeResumeFacts(existing, incoming);
  assert.equal(merged.added, 4);
  assert.equal(merged.duplicates, 2);
  assert.equal(merged.facts[0], existing[0]);
  assert.deepEqual(
    merged.facts.map((f) => f.text),
    [
      existing[0].text,
      "Wrote C++.",
      "Wrote C#.",
      "Improved performance by 30%.",
      "Improved performance by 40%.",
    ],
  );
  assert.equal(mergeResumeFacts(merged.facts, incoming).added, 0);
});

test("late import results append to the latest edited profile and require fresh confirmation", () => {
  let state: ProfileEditorState = {
    profile: {
      ...structuredClone(emptyProfile),
      firstName: "Alex",
      confirmed: true,
      facts: [{ id: "original", text: "Original experience." }],
    },
    imports: [],
  };
  state = profileEditorReducer(state, { type: "start-import" });
  state = profileEditorReducer(state, {
    type: "edit",
    update: (p) => ({
      ...p,
      firstName: "Jamie",
      facts: [
        ...p.facts,
        { id: "typed", text: "Fact typed while import was running." },
      ],
    }),
  });
  state = profileEditorReducer(state, {
    type: "import",
    name: "resume.docx",
    facts: resumeFacts("Another experience."),
  });
  assert.equal(state.profile.firstName, "Jamie");
  assert.deepEqual(state.profile.facts.map((f) => f.id).slice(0, 2), [
    "original",
    "typed",
  ]);
  assert.equal(state.profile.facts.length, 3);
  assert.equal(state.profile.confirmed, false);
});

test("failed or duplicate-only imports preserve confirmation and earlier successes", () => {
  const initial = {
    profile: {
      ...structuredClone(emptyProfile),
      confirmed: true,
      facts: [{ id: "original", text: "Existing fact." }],
    },
    imports: [],
  };
  const duplicate = profileEditorReducer(initial, {
    type: "import",
    name: "same.pdf",
    facts: resumeFacts("Existing fact."),
  });
  assert.equal(duplicate.profile, initial.profile);
  assert.equal(duplicate.imports[0].duplicates, 1);
  const success = profileEditorReducer(duplicate, {
    type: "import",
    name: "good.docx",
    facts: resumeFacts("A different fact."),
  });
  const failed = profileEditorReducer(success, {
    type: "import",
    name: "bad.pdf",
    facts: [],
    error: "Cannot extract PDF",
  });
  assert.equal(failed.profile, success.profile);
  assert.equal(failed.imports.length, 3);
  assert.match(failed.imports[2].error!, /Cannot extract PDF/);
});

test("fact and length limits reject a file atomically, without silently dropping existing facts", () => {
  const full = Array.from({ length: 300 }, (_, i) => ({
    id: String(i),
    text: `Fact ${i}`,
  }));
  assert.equal(mergeResumeFacts(full, resumeFacts("Fact 0")).duplicates, 1);
  const overflow = mergeResumeFacts(full, resumeFacts("New experience."));
  assert.equal(overflow.facts, full);
  assert.match(overflow.error!, /300-fact/);
  const long = mergeResumeFacts(
    [],
    resumeFacts(`Valid short fact.\n${"x".repeat(3001)}`),
  );
  assert.equal(long.added, 0);
  assert.equal(long.facts.length, 0);
  assert.match(long.error!, /3,000/);
  assert.match(
    mergeResumeFacts([], resumeFacts("\n  \n")).error!,
    /No resume text/,
  );
});

test("a résumé's wrapped lines become whole facts, without its headings or contact block", () => {
  // A PDF emits one line per rendered line, so a paragraph arrives in pieces.
  const facts = resumeFacts(
    [
      "Alex Example",
      "Tucson, AZ | someone@example.test | 623-555-0101",
      "github.com/example | linkedin.com/in/example | example.com",
      "Summary",
      "Software engineer specializing in scalable backend services. Built a hybrid",
      "push/pull fan-out backend on Redis Streams, shipped chatbot APIs,",
      "and founded a live exam-prep platform.",
      "",
      "Professional Experience",
      "- Implemented hybrid push/pull delivery with a Redis Streams worker, using",
      "dynamic hot-user detection with TTL tracking to curb write amplification under",
      "comment-storm workloads.",
      "- Reworked the chatbot web UI for desktop and mobile.",
      "Tech: Python, FastAPI, Redis | github.com/example/demo",
    ].join("\n"),
  ).map((f) => f.text);
  assert.deepEqual(facts, [
    "Software engineer specializing in scalable backend services. Built a hybrid push/pull fan-out backend on Redis Streams, shipped chatbot APIs, and founded a live exam-prep platform.",
    "- Implemented hybrid push/pull delivery with a Redis Streams worker, using dynamic hot-user detection with TTL tracking to curb write amplification under comment-storm workloads.",
    "- Reworked the chatbot web UI for desktop and mobile.",
    // A tech line names a repository but is mostly content, so it is kept.
    "Tech: Python, FastAPI, Redis | github.com/example/demo",
  ]);
});

test("a heading-shaped line inside a sentence is not mistaken for furniture", () => {
  const facts = resumeFacts(
    [
      "- Built a U-Net reproducing thermal sensor surface temperature to 0.85 K",
      "MAE on MSU Research Computing hardware.",
      "Awards",
      "- First place, MSU Innovation Challenge.",
    ].join("\n"),
  ).map((f) => f.text);
  assert.deepEqual(facts, [
    "- Built a U-Net reproducing thermal sensor surface temperature to 0.85 K MAE on MSU Research Computing hardware.",
    "- First place, MSU Innovation Challenge.",
  ]);
});
