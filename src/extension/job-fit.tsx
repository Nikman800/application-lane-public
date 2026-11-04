import React from "react";
import type { Application } from "../shared/model";

const verdicts = { good: "Good fit", partial: "Partial fit", poor: "Poor fit", unknown: "Not enough information" };
const statuses = { matched: "Supported by your background", gap: "Gap in your background evidence", uncertain: "Details to confirm", unmet: "Eligibility issue" };

export function JobFitAssessment({ app, profileRevision, onCheck, disabled = false, prerequisite }: {
  app: Application;
  profileRevision: number;
  onCheck?: (app: Application) => void;
  disabled?: boolean;
  prerequisite?: string;
}) {
  const fit = app.fit?.profileRevision === profileRevision ? app.fit : undefined;
  const checking = Boolean(app.fitJobId);
  return (
    <section className={`job-fit ${fit?.verdict || "unknown"}`} aria-label={`Job fit for ${app.title}`}>
      <div className="fit-heading">
        <strong>Job fit{fit && <> · <span>{verdicts[fit.verdict]}</span></>}</strong>
        {onCheck && (
          <button className="text-button" disabled={disabled || checking || Boolean(prerequisite)} onClick={() => onCheck(app)}>
            {checking ? "Checking fit…" : fit ? "Check fit again" : "Check fit"}
          </button>
        )}
      </div>
      {checking ? <p role="status">Comparing the posting with your saved background…</p>
        : fit ? <p>{fit.summary}</p>
          : <p>{app.fitError || prerequisite || "Check how this job's requirements match your saved background."}</p>}
      {fit?.requirements.some((item) => item.status === "unmet") && (
        <ul className="fit-blockers">
          {fit.requirements.filter((item) => item.status === "unmet").map((item, index) => (
            <li key={index}><strong>Eligibility issue:</strong> {item.requirement}{item.evidence.map((quote, i) => <p key={i}>Your background: {quote}</p>)}</li>
          ))}
        </ul>
      )}
      {fit?.requirements.length ? (
        <details>
          <summary>Evidence and gaps ({fit.requirements.length})</summary>
          <ul className="fit-requirements">
            {fit.requirements.map((item, index) => (
              <li key={index}>
                <strong>{item.requirement}</strong>
                <span className={`fit-match ${item.status}`}>{item.importance === "preferred" ? "Preferred · " : "Required · "}{statuses[item.status]}</span>
                {item.evidence.map((quote, i) => <p key={i}>{quote}</p>)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
