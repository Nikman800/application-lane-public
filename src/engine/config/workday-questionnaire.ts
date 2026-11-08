// Workday's application questions list their answers only once a question's
// dropdown is opened, but the page loads them all at once: each questionnaire
// is one request (/questionnaire/<id>) answering every question with its
// possible answers, and each question's button is named by the question's id.
// Read from there, a question's choices are known before anything is opened,
// and a question nobody could answer blind is answered from its real list
// (one employer's "…in that country?").

export type QuestionnaireAnswers = Map<string, string[]>;

// The questionnaire requests the page has made, from its resource timings.
export function questionnaireUrls(resources: string[], origin: string): string[] {
  return [...new Set(resources.filter((url) => {
    try {
      const parsed = new URL(url);
      return parsed.origin === origin && /\/questionnaire\/[0-9a-f]{16,}$/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }))].slice(0, 6);
}

// Question id to its answers, in the order the site lists them.
export function questionnaireAnswers(body: unknown): QuestionnaireAnswers {
  const answers: QuestionnaireAnswers = new Map();
  const questions = body && typeof body === "object" ? (body as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(questions)) return answers;
  for (const question of questions) {
    if (!question || typeof question !== "object") continue;
    const { id, possibleAnswers } = question as { id?: unknown; possibleAnswers?: unknown };
    if (typeof id !== "string" || !Array.isArray(possibleAnswers)) continue;
    const listed = possibleAnswers
      .filter((answer): answer is { answerText: string; order?: unknown } =>
        Boolean(answer) && typeof answer === "object" && typeof (answer as { answerText?: unknown }).answerText === "string")
      .sort((a, b) => String(a.order ?? "").localeCompare(String(b.order ?? "")))
      .map((answer) => answer.answerText.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (listed.length) answers.set(id, listed.slice(0, 300));
  }
  return answers;
}

const cache = new Map<string, Promise<QuestionnaireAnswers>>();

// Every question the page's questionnaires list, one request per
// questionnaire, read with the page's own session.
export async function loadQuestionnaires(urls: string[], signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<QuestionnaireAnswers> {
  const all: QuestionnaireAnswers = new Map();
  const lists = await Promise.all(urls.map((url) => {
    let request = cache.get(url);
    if (!request) {
      const timeout = AbortSignal.timeout(5_000);
      request = fetcher(url, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
        .then((response) => (response.ok ? response.json() : undefined))
        .then((body) => questionnaireAnswers(body))
        .catch(() => new Map() as QuestionnaireAnswers);
      cache.set(url, request);
      request.then((answers) => answers.size || cache.delete(url));
    }
    return request;
  }));
  for (const list of lists) for (const [id, answers] of list) all.set(id, answers);
  return all;
}
