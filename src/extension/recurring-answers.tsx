import React, { useEffect, useState } from "react";
import type { Profile, RecurringAnswer } from "../shared/model";

async function command<T = any>(message: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok)
    throw new Error(
      response?.error || "Extension background worker is unavailable.",
    );
  return response.data;
}

// Answers the applicant keeps giving by hand, offered to save so later fills
// give them: nobody adds "Military Status: No Military" to a profile
// themselves (Expand Energy, 2026-10-30).
export function RecurringAnswers({
  profileRevision,
  onSaved,
}: {
  profileRevision: number;
  onSaved: (profile: Profile) => void;
}) {
  const [answers, setAnswers] = useState<RecurringAnswer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    command<RecurringAnswer[]>({ type: "RECURRING_ANSWERS" })
      .then(setAnswers)
      .catch(() => setAnswers([]));
  }, [profileRevision]);
  if (!answers.length) return null;
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-label="Answers you keep giving">
      <div className="section-title">
        <h2>Answers you keep giving</h2>
      </div>
      <p className="help">
        You answered these the same way on several applications. Save one and
        later fills give it for you.
      </p>
      {error && <p className="error">{error}</p>}
      {answers.map((item) => (
        <div className="history-row" key={item.key}>
          <span>
            <strong>{item.question}</strong>
            <span className="answer-value">{item.answer}</span>
            <small>
              On {item.applications} applications
            </small>
          </span>
          <div className="row">
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const saved = await command<Profile>({
                    type: "SAVE_ANSWERS",
                    answers: [{ question: item.question, answer: item.answer }],
                  });
                  onSaved(saved);
                  setAnswers((current) => current.filter((other) => other.key !== item.key));
                })
              }
            >
              Save
            </button>
            <button
              className="text-button muted"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setAnswers(await command<RecurringAnswer[]>({ type: "DISMISS_RECURRING_ANSWER", key: item.key }));
                })
              }
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
