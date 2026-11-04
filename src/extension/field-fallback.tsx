import React, { useEffect, useState } from "react";
import type {
  Application,
  FieldFallbackProblem,
  GenerationJob,
  QueueState,
} from "../shared/model";

async function command<T = any>(message: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok)
    throw new Error(
      response?.error || "Extension background worker is unavailable.",
    );
  return response.data;
}

const providerName = (
  draft: NonNullable<GenerationJob["fieldDrafts"]>[number],
) =>
  draft.draftedWith?.name || (draft.draftedWith?.provider === "claude-cli"
    ? `Claude (${draft.draftedWith.model})`
    : draft.draftedWith?.provider === "codex-cli"
      ? `Codex (${draft.draftedWith.model})`
      : draft.draftedWith?.model);

type Draft = NonNullable<GenerationJob["fieldDrafts"]>[number];

// The options of one checkbox question, shown and decided together; every
// other field stands alone.
function grouped<T extends { fieldId: string; kind: string; question?: string }>(items: T[]): { question?: string; items: T[] }[] {
  const groups: { question?: string; items: T[] }[] = [];
  for (const item of items) {
    const question = item.kind === "checkbox" ? item.question : undefined;
    const last = groups.at(-1);
    if (question && last?.question === question) last.items.push(item);
    else groups.push({ question, items: [item] });
  }
  return groups;
}
// An option's own text: its label without the question it carries.
const optionText = (item: { label: string; question?: string }) =>
  item.question && item.label.startsWith(`${item.question}: `) ? item.label.slice(item.question.length + 2) : item.label;
const defaultReason = /^Normal fill could not match this field/;

// A cited source can be a whole work-history entry: one line, expandable.
function Source({ text }: { text: string }) {
  const short = text.length > 90 ? `${text.slice(0, 88).trimEnd()}…` : text;
  return short === text ? (
    <p className="answer-source">From: {text}</p>
  ) : (
    <details className="answer-source">
      <summary>From: {short}</summary>
      {text}
    </details>
  );
}

export function FieldFallback({
  app,
  tabId,
  profileRevision,
  disabled,
  prerequisite,
  onState,
  draftOnly = false,
}: {
  app: Application;
  tabId: number;
  profileRevision: number;
  disabled: boolean;
  prerequisite: string;
  onState: (state: QueueState) => void;
  // A site that is only read: drafts are copied, never filled.
  draftOnly?: boolean;
}) {
  const [available, setAvailable] = useState(false);
  const [problems, setProblems] = useState<FieldFallbackProblem[]>([]);
  const [inaccessible, setInaccessible] = useState<string[]>([]);
  // Whether suggestions are filled automatically, and whether asking the AI
  // again could find anything that step did not (background.ts).
  const [autoFill, setAutoFill] = useState(false);
  const [askAgain, setAskAgain] = useState(true);
  const [job, setJob] = useState<GenerationJob>();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const session = app.fieldFallbackSession;
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
    const data = await command<{
      available: boolean;
      problems: FieldFallbackProblem[];
      inaccessible: string[];
      autoFill: boolean;
      askAgain: boolean;
    }>({ type: "UNRESOLVED_FIELDS", id: app.id, tabId });
    setAvailable(data.available);
    setProblems(data.problems);
    setInaccessible(data.inaccessible);
    setAutoFill(data.autoFill);
    setAskAgain(data.askAgain);
  }
  useEffect(() => {
    let stopped = false;
    setLoading(true);
    command<{
      available: boolean;
      problems: FieldFallbackProblem[];
      inaccessible: string[];
      autoFill: boolean;
      askAgain: boolean;
    }>({ type: "UNRESOLVED_FIELDS", id: app.id, tabId })
      .then((data) => {
        if (stopped) return;
        setAvailable(data.available);
        setProblems(data.problems);
        setInaccessible(data.inaccessible);
        setAutoFill(data.autoFill);
        setAskAgain(data.askAgain);
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
  }, [app.id, app.operation, app.status, app.assisting, profileRevision, tabId]);
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
        const next = await command<GenerationJob>({
          type: "API",
          path: `/v1/jobs/${jobId}`,
        });
        if (stopped) return;
        setJob(next);
        if (["queued", "running"].includes(next.status))
          timer = setTimeout(poll, 1500);
        else if (next.status === "complete") {
          setEdits(
            Object.fromEntries(
              (next.fieldDrafts || []).map((draft) => [
                draft.fieldId,
                draft.value,
              ]),
            ),
          );
          setSelected(
            (next.fieldDrafts || [])
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
  const draft = () =>
    void action(async () => {
      onState(
        await command({
          type: "DRAFT_FIELD_FALLBACK",
          id: app.id,
          tabId,
          fieldIds: problems.map((problem) => problem.fieldId),
        }),
      );
    });
  const fill = (ids: string[]) =>
    void action(async () => {
      const response = await command({
        type: "FILL_FIELD_FALLBACK",
        id: app.id,
        tabId,
        jobId,
        answers: ids.map((fieldId) => ({
          fieldId,
          value: edits[fieldId] || "",
        })),
      });
      onState(response.state);
      setResults((previous) => ({
        ...previous,
        ...Object.fromEntries(
          response.results.map(
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
            !response.results.some(
              (result: { fieldId: string; ok: boolean }) =>
                result.fieldId === id && result.ok,
            ),
        ),
      );
      await scan();
    });
  if (!loading && !problems.length && !session) return null;
  if (!available && !session) return null;
  const invalidSelection = selected.some((id) => {
    const field = job?.fieldDrafts?.find((draft) => draft.fieldId === id);
    const value = edits[id]?.trim() || "";
    return (
      !field ||
      !value ||
      results[id] === "Filled" ||
      Boolean(
        field.options.length &&
        !field.options.some(
          (option) => option.toLowerCase() === value.toLowerCase(),
        ),
      )
    );
  });
  return (
    <section
      className="field-fallback"
      aria-label="AI review for unfilled fields"
    >
      <div className="fit-heading">
        <strong>Unfilled structured fields</strong>
        <button
          className="text-button"
          disabled={blocked || drafting}
          onClick={() => void action(scan)}
        >
          Scan remaining fields
        </button>
      </div>
      {autoFill && !askAgain && !session ? (
        <p>
          AI already looked at these and found nothing in your saved details
          to answer them. Add what they ask to your profile, and AI can try
          again.
        </p>
      ) : autoFill ? (
        <p>
          The automatic AI step did not cover these fields. Ask it to try
          again, or answer them yourself.
        </p>
      ) : (
        <p>
          Normal fill left these fields unresolved. Review the exact fields below
          before choosing whether to ask AI for suggestions.
        </p>
      )}
      {prerequisite && <p>{prerequisite}</p>}
      {error && <p role="alert">{error}</p>}
      {inaccessible.length > 0 && (
        <p>Some embedded frames could not be read and are not included.</p>
      )}
      {problems.length > 0 && (
        <ul className="fallback-problems">
          {grouped(problems).map(({ question, items }) =>
            question ? (
              <li key={items[0].fieldId}>
                <strong>{question}</strong>
                {items.some((item) => item.required) ? " · required" : " · optional"}
                <span>
                  {items.length} options: {items.map(optionText).join("; ")}
                </span>
              </li>
            ) : (
              <li key={items[0].fieldId}>
                <strong>{items[0].label}</strong>
                {items[0].section ? ` · ${items[0].section}` : ""}
                {items[0].required ? " · required" : " · optional"}
                <span>{items[0].reason}</span>
              </li>
            ),
          )}
        </ul>
      )}
      {problems.length > 0 && (askAgain || drafting) && (
        <div className="context-actions">
          <button
            className="secondary"
            disabled={blocked || drafting}
            onClick={draft}
          >
            {autoFill ? "Try AI again" : "Ask AI for suggestions"} ({problems.length})
          </button>
          {drafting && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void action(async () =>
                  onState(
                    await command({
                      type: "CANCEL_FIELD_FALLBACK",
                      id: app.id,
                    }),
                  ),
                )
              }
            >
              Cancel AI review
            </button>
          )}
        </div>
      )}
      {drafting && <p role="status">Reviewing saved information…</p>}
      {stale && (
        <p role="alert">
          The page or profile changed. Scan and ask AI again before filling.
        </p>
      )}
      {job?.status === "failed" && (
        <p role="alert">
          {job.error || "AI could not review these fields. Try again."}
        </p>
      )}
      {job?.status === "cancelled" && <p>AI review was cancelled.</p>}
      {job?.warnings?.length ? (
        <details>
          <summary>Review notices ({job.warnings.length})</summary>
          <ul>
            {job.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {job?.status === "complete" && (job.fieldDrafts?.length || 0) > 0 && (
        <p className="draft-summary">
          {job.fieldDrafts!.filter((draft) => draft.value).length} of {job.fieldDrafts!.length} have a suggestion. Untick or change any before filling.
        </p>
      )}
      {job?.status === "complete" &&
        grouped(job.fieldDrafts || []).map(({ question, items }) => {
          const toggle = (draft: Draft, on: boolean) => {
            if (on) setEdits((previous) => ({ ...previous, [draft.fieldId]: previous[draft.fieldId] || "Yes" }));
            setSelected((ids) => (on ? [...new Set([...ids, draft.fieldId])] : ids.filter((id) => id !== draft.fieldId)));
          };
          const status = (draft: Draft) =>
            results[draft.fieldId] && (
              <span role="status" className={results[draft.fieldId] === "Filled" ? "draft-status filled" : "draft-status"}>
                {results[draft.fieldId]}
              </span>
            );
          if (question) {
            const sources = [...new Set(items.map((draft) => draft.source).filter(Boolean))] as string[];
            const blanks = items.filter((draft) => !draft.value && draft.skipReason);
            return (
              <div className="field-draft" key={items[0].fieldId}>
                <strong className="draft-question">{question}</strong>
                {items.some((item) => item.required) && <span className="draft-tag">required</span>}
                <ul className="draft-options">
                  {items.map((draft) => (
                    <li key={draft.fieldId}>
                      <label className="question-choice">
                        <input
                          type="checkbox"
                          aria-label={`Select ${draft.label}`}
                          checked={selected.includes(draft.fieldId)}
                          disabled={results[draft.fieldId] === "Filled"}
                          onChange={(event) => toggle(draft, event.target.checked)}
                        />
                        <span>{optionText(draft)}</span>
                      </label>
                      {status(draft)}
                    </li>
                  ))}
                </ul>
                {blanks.length > 0 && (
                  <details className="answer-source">
                    <summary>
                      {blanks.length} left unticked by AI
                    </summary>
                    <ul>
                      {blanks.map((draft) => (
                        <li key={draft.fieldId}>
                          {optionText(draft)}: {draft.skipReason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {sources.map((source) => (
                  <Source key={source} text={source} />
                ))}
              </div>
            );
          }
          const draft = items[0];
          const value = edits[draft.fieldId] || "";
          const filled = results[draft.fieldId] === "Filled";
          const choices =
            draft.options.length > 0
              ? draft.options
              : draft.kind === "checkbox"
                ? ["Yes", "No"]
                : [];
          return (
            <div className="field-draft" key={draft.fieldId}>
              <label className="question-choice">
                <input
                  type="checkbox"
                  aria-label={`Select ${draft.label}`}
                  checked={selected.includes(draft.fieldId)}
                  disabled={filled || !value}
                  onChange={(event) => toggle(draft, event.target.checked)}
                />
                <strong className="draft-question">{draft.label}</strong>
                {draft.required && <span className="draft-tag">required</span>}
              </label>
              {choices.length ? (
                <select
                  aria-label={`Suggested value: ${draft.label}`}
                  value={value}
                  onChange={(event) =>
                    setEdits((previous) => ({
                      ...previous,
                      [draft.fieldId]: event.target.value,
                    }))
                  }
                >
                  <option value="">Choose a value</option>
                  {choices.map((choice) => (
                    <option key={choice}>{choice}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  aria-label={`Suggested value: ${draft.label}`}
                  value={value}
                  onChange={(event) =>
                    setEdits((previous) => ({
                      ...previous,
                      [draft.fieldId]: event.target.value,
                    }))
                  }
                />
              )}
              {draftOnly && (
                <button
                  className="text-button"
                  disabled={!value}
                  onClick={() => void action(() => navigator.clipboard.writeText(value))}
                >
                  Copy
                </button>
              )}
              {draft.skipReason && (
                <p className="answer-source">AI left this blank: {draft.skipReason}</p>
              )}
              {!defaultReason.test(draft.reason) && <p className="answer-source">{draft.reason}</p>}
              {draft.source && <Source text={draft.source} />}
              {status(draft)}
            </div>
          );
        })}
      {job?.status === "complete" &&
        [...new Set((job.fieldDrafts || []).filter((draft) => draft.draftedWith).map(providerName))].map((name) => (
          <p className="answer-source" key={name}>
            Suggested by {name}
          </p>
        ))}
      {job?.status === "complete" && !draftOnly && (
        <button
          className="primary small"
          disabled={
            blocked || Boolean(stale) || !selected.length || invalidSelection
          }
          onClick={() => fill(selected)}
        >
          Fill selected suggestions ({selected.length})
        </button>
      )}
    </section>
  );
}
