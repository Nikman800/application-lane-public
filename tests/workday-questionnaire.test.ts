import assert from "node:assert/strict";
import { test } from "node:test";
import { loadQuestionnaires, questionnaireAnswers, questionnaireUrls } from "../src/engine/config/workday-questionnaire";

// NVIDIA's questionnaire (2026-11-04), as the page loads it.
const body = {
  id: "2f2764b3a82910064296831695150000",
  questions: [
    { id: "2f2764b3a829100642af26ec534f0000", body: "<p>Will you require employer support to obtain or maintain authorization to work in that country? e.g. (work permit)</p>", order: "b",
      possibleAnswers: [{ id: "x2", answerText: "No", order: "b" }, { id: "x1", answerText: "Yes", order: "a" }], required: true },
    { id: "2f2764b3a829100642af25b88deb0000", body: "<p>Are you legally authorized to work in the country where this position is located?</p>", order: "a",
      possibleAnswers: [{ id: "y1", answerText: " Yes ", order: "a" }, { id: "y2", answerText: "No", order: "b" }], required: true },
    { id: "free", body: "<p>Anything else?</p>", order: "c", type: { descriptor: "Text" } },
  ],
};

test("a Workday questionnaire gives each question its answers in the site's order", () => {
  const answers = questionnaireAnswers(body);
  assert.deepEqual(answers.get("2f2764b3a829100642af26ec534f0000"), ["Yes", "No"]);
  assert.deepEqual(answers.get("2f2764b3a829100642af25b88deb0000"), ["Yes", "No"]);
  assert.equal(answers.has("free"), false);
  assert.equal(questionnaireAnswers({ nothing: true }).size, 0);
});

test("only the page's own questionnaire requests are read, once each", async () => {
  const origin = "https://acme.wd5.myworkdayjobs.com";
  const urls = questionnaireUrls([
    `${origin}/wday/cxs/common/acme/questionnaire/2f2764b3a82910064296831695150000`,
    `${origin}/wday/cxs/common/acme/questionnaire/2f2764b3a82910064296831695150000`,
    `${origin}/wday/cxs/acme/jobapplication/123/questionnaireanswers?type=primary`,
    "https://elsewhere.example/questionnaire/2f2764b3a82910064296831695150000",
  ], origin);
  assert.deepEqual(urls, [`${origin}/wday/cxs/common/acme/questionnaire/2f2764b3a82910064296831695150000`]);
  let requests = 0;
  const fetcher = (async () => { requests++; return new Response(JSON.stringify(body)); }) as typeof fetch;
  const first = await loadQuestionnaires(urls, undefined, fetcher);
  const second = await loadQuestionnaires(urls, undefined, fetcher);
  assert.equal(first.size, 2);
  assert.equal(second.size, 2);
  assert.equal(requests, 1);
});
