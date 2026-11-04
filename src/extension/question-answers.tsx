import React, { useEffect, useState } from "react";
import type {
  Application,
  Field,
  GenerationJob,
  QueueState,
} from "../shared/model";
import { answerLimitError, wordCount } from "../shared/questions";

async function command<T = any>(message: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok)
    throw new Error(
      response?.error || "Extension background worker is unavailable.",
    );
  return response.data;
}

export function QuestionAnswers({
  app,
  tabId,
  profileRevision,
  disabled,
  prerequisite,
  onState,
  draftOnly = false,
  autoFill = false,
}: {
  app: Application;
  tabId: number;
  profileRevision: number;
  disabled: boolean;
  prerequisite: string;
  onState: (state: QueueState) => void;
  // A site that is only read: drafts are copied, never filled.
  draftOnly?: boolean;
  // Fill this step writes the model's answers itself: drafting them all
  // here would be the same work twice. One question can still be drafted.
  autoFill?: boolean;
}) {
  const [fields, setFields] = useState<Field[]>([]);
  const [inaccessible, setInaccessible] = useState<string[]>([]);
  const [job, setJob] = useState<GenerationJob>();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const session = app.answerSession;
  const jobId = session?.tabId === tabId ? session.jobId : undefined;
  const drafting = Boolean(
    jobId && (!job || ["queued", "running"].includes(job.status)),
  );
  const stale =
    session &&
    (session.operation !== app.operation ||
      session.profileRevision !== profileRevision ||
      session.tabId !== tabId);
  const blocked = busy || disabled || Boolean(prerequisite);

  async function scan() {
    const data = await command<{ fields: Field[]; inaccessible: string[] }>({
      type: "QUESTION_FIELDS",
      tabId,
    });
    setFields(data.fields);
    setInaccessible(data.inaccessible);
  }
  useEffect(() => {
    let stopped = false;
    command<{ fields: Field[]; inaccessible: string[] }>({
      type: "QUESTION_FIELDS",
      tabId,
    })
      .then((data) => {
        if (!stopped) {
          setFields(data.fields);
          setInaccessible(data.inaccessible);
        }
      })
      .catch((error: Error) => {
        if (!stopped) setError(error.message);
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [tabId]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setJob(undefined);
    setEdits({});
    setSelected([]);
    setResults({});
    if (!jobId) return;
    const poll = async () => {
      try {
        const job = await command<GenerationJob>({
          type: "API",
          path: `/v1/jobs/${jobId}`,
        });
        if (stopped) return;
        setJob(job);
        if (["queued", "running"].includes(job.status))
          timer = setTimeout(poll, 1500);
        else if (job.status === "complete") {
          setEdits(
            Object.fromEntries(
              (job.answerDrafts || []).map((draft) => [
                draft.fieldId,
                draft.value,
              ]),
            ),
          );
          setSelected(
            (job.answerDrafts || [])
              .filter((draft) => draft.value)
              .map((draft) => draft.fieldId),
          );
        }
      } catch (error) {
        if (!stopped) {
          setError((error as Error).message);
          timer = setTimeout(poll, 3000);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [jobId]);
  async function action(work: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await work();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const draft = (ids?: string[]) =>
    void action(async () => {
      try {
        onState(
          await command({
            type: "DRAFT_ANSWERS",
            id: app.id,
            tabId,
            questionIds: ids,
          }),
        );
      } catch (error) {
        // A dynamic page can change between the panel scan and the protected
        // scan before drafting. Refresh the count before showing the refusal.
        await scan().catch(() => {});
        throw error;
      }
    });
  const fill = (ids: string[]) =>
    void action(async () => {
      const result = await command({
        type: "FILL_ANSWERS",
        id: app.id,
        tabId,
        jobId,
        answers: ids.map((fieldId) => ({
          fieldId,
          value: edits[fieldId] || "",
        })),
      });
      onState(result.state);
      setResults((previous) => ({
        ...previous,
        ...Object.fromEntries(
          result.results.map(
            (result: { fieldId: string; ok: boolean; reason?: string }) => [
              result.fieldId,
              result.ok ? "Filled" : result.reason || "Not filled",
            ],
          ),
        ),
      }));
      setSelected((previous) =>
        previous.filter(
          (id) =>
            !result.results.some(
              (result: { fieldId: string; ok: boolean }) =>
                result.fieldId === id && result.ok,
            ),
        ),
      );
      await scan();
    });
  const invalidSelection = selected.some((id) => {
    const draft = job?.answerDrafts?.find((draft) => draft.fieldId === id);
    return (
      !draft ||
      !edits[id]?.trim() ||
      answerLimitError(edits[id], draft) ||
      results[id] === "Filled"
    );
  });
  return (
    <section
      className="question-answers"
      aria-label="Application question answers"
    >
      <div className="fit-heading">
        <strong>Application questions</strong>
        <button
          className="text-button"
          disabled={blocked || drafting}
          onClick={() => void action(scan)}
        >
          Scan questions
        </button>
      </div>
      <p>
        Draft written responses from your saved background, edit them, then
        fill the ones you choose.
      </p>
      {prerequisite && <p>{prerequisite}</p>}
      {error && <p role="alert">{error}</p>}
      {inaccessible.length > 0 && (
        <p>
          Some frames could not be read. Grant page access to include their
          questions.
        </p>
      )}
      {!loading && !fields.length && (
        <p>
          No empty written-response questions are on this page. Education,
          contact, and other structured fields are handled by Fill this step.
        </p>
      )}
      {fields.length > 0 && (
        <div className="context-actions">
          <button
            className="secondary"
            hidden={autoFill && !draftOnly}
            disabled={blocked || drafting}
            onClick={() => draft()}
          >
            Draft all written responses ({fields.length})
          </button>
          {drafting && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void action(async () =>
                  onState(
                    await command({ type: "CANCEL_ANSWERS", id: app.id }),
                  ),
                )
              }
            >
              Cancel drafting
            </button>
          )}
        </div>
      )}
      {drafting && <p role="status">Drafting answers…</p>}
      {job?.status === "failed" && (
        <p role="alert">
          {job.error || "The answers could not be drafted. Try again."}
        </p>
      )}
      {job?.status === "cancelled" && (
        <p>Drafting was cancelled. Draft again when ready.</p>
      )}
      {stale && (
        <p role="alert">
          The page or profile changed. Draft again before filling.
        </p>
      )}
      {job?.warnings?.length ? (
        <details>
          <summary>Draft notices ({job.warnings.length})</summary>
          <ul>
            {job.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {job?.status === "complete" &&
        job.answerDrafts?.map((answer) => {
          const value = edits[answer.fieldId] || "";
          const limit = answerLimitError(value, answer);
          const filled = results[answer.fieldId] === "Filled";
          return (
            <div className="question-draft" key={answer.fieldId}>
              <label className="question-choice">
                <input
                  type="checkbox"
                  aria-label={`Select ${answer.label}`}
                  checked={selected.includes(answer.fieldId)}
                  disabled={filled}
                  onChange={(event) =>
                    setSelected((ids) =>
                      event.target.checked
                        ? [...ids, answer.fieldId]
                        : ids.filter((id) => id !== answer.fieldId),
                    )
                  }
                />{" "}
                <strong>{answer.label}</strong>
              </label>
              {answer.skipReason && <p>Left for you: {answer.skipReason}</p>}
              <textarea
                aria-label={`Draft answer: ${answer.label}`}
                value={value}
                onChange={(event) =>
                  setEdits((previous) => ({
                    ...previous,
                    [answer.fieldId]: event.target.value,
                  }))
                }
                rows={6}
              />
              <p className="answer-count">
                {wordCount(value)}
                {answer.maxWords ? ` / ${answer.maxWords}` : ""} words ·{" "}
                {value.length}
                {answer.maxLength ? ` / ${answer.maxLength}` : ""} characters
              </p>
              {answer.source && (
                <p className="answer-source">Sources: {answer.source}</p>
              )}
              {answer.draftedWith && (
                <p className="answer-source">
                  Drafted by{" "}
                  {answer.draftedWith.name || (answer.draftedWith.provider === "claude-cli"
                    ? `Claude (${answer.draftedWith.model})`
                    : answer.draftedWith.provider === "codex-cli"
                      ? `Codex (${answer.draftedWith.model})`
                      : answer.draftedWith.model)}
                </p>
              )}
              {limit && <p role="alert">{limit}</p>}
              {results[answer.fieldId] && (
                <p role="status">{results[answer.fieldId]}</p>
              )}
              <div className="context-actions">
                <button
                  className="secondary"
                  hidden={draftOnly}
                  disabled={
                    blocked ||
                    drafting ||
                    Boolean(stale) ||
                    filled ||
                    !value.trim() ||
                    Boolean(limit)
                  }
                  onClick={() => fill([answer.fieldId])}
                >
                  Fill this answer
                </button>
                <button
                  className="text-button"
                  disabled={!value}
                  onClick={() =>
                    void action(() => navigator.clipboard.writeText(value))
                  }
                >
                  Copy
                </button>
                <button
                  className="text-button"
                  disabled={
                    blocked ||
                    drafting ||
                    !fields.some((field) => field.id === answer.fieldId)
                  }
                  onClick={() => draft([answer.fieldId])}
                >
                  Draft this again
                </button>
              </div>
            </div>
          );
        })}
      {job?.status === "complete" && !draftOnly && (
        <button
          className="primary small"
          disabled={
            blocked || Boolean(stale) || !selected.length || invalidSelection
          }
          onClick={() => fill(selected)}
        >
          Fill selected answers ({selected.length})
        </button>
      )}
      {fields.length > 0 && (
        <details>
          <summary>Draft one question</summary>
          {fields.map((field) => (
            <div className="question-option" key={field.id}>
              <p>{field.label}</p>
              <button
                className="text-button"
                disabled={blocked || drafting}
                onClick={() => draft([field.id])}
              >
                Draft this question
              </button>
            </div>
          ))}
        </details>
      )}
      {job && (
        <p className="answer-source">Drafting again starts a new review.</p>
      )}
    </section>
  );
}
