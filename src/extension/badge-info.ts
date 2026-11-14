import type { Application } from "../shared/model";
import type { ApplicationWarning } from "../shared/duplicates";

// What the small badge on an application's page says (badge.ts): whether
// the step is filling, done, or needs the applicant, without the side panel
// open.
export type BadgeInfo = {
  tone: "working" | "done" | "attention" | "paused" | "idle" | "submitted" | "warn";
  title: string;
  detail: string;
};

export function badgeInfo(
  app: Pick<Application, "status" | "workflowStage" | "attempts" | "missing" | "note" | "documentJobId"> & { assisting?: boolean },
  shortcut: string,
  warning?: ApplicationWarning,
): BadgeInfo {
  const last = app.attempts.at(-1);
  const filled = last?.filled ?? 0;
  const required = app.missing.filter((item) => /^Required:/.test(item)).length;
  const hint = shortcut ? `${shortcut} fills this step` : "";
  // Another record of the job, or the fixer, outranks what the fill is doing:
  // the applicant should not work on it.
  if (warning) return { tone: "warn", title: warning.title, detail: warning.detail };
  if (app.workflowStage === "submitted") return { tone: "submitted", title: "Submitted", detail: "Already applied: do not apply again" };
  if (app.status === "queued" || app.status === "inspecting" || app.status === "preparing" || app.status === "filling") {
    const doing = {
      queued: "Waiting to fill…",
      inspecting: "Reading the form…",
      // Documents are made once; a later step only gets its answers ready
      // ("Preparing documents…" on one employer's Self Identify step).
      preparing: app.documentJobId ? "Getting this step's answers ready…" : "Preparing documents…",
      filling: "Filling…",
    }[app.status];
    return { tone: "working", title: doing, detail: filled ? `${filled} fields so far` : "" };
  }
  // The fill has done its own part while the model still suggests values for
  // the rest: the side panel says "Still filling" and the badge said the step
  // was done (Wise).
  if (app.assisting && (app.status === "awaiting-user" || app.status === "ready"))
    return { tone: "working", title: "Still filling…", detail: filled ? `${filled} fields so far · the model is suggesting more` : "The model is suggesting values for the rest" };
  if (app.status === "paused") return { tone: "paused", title: "Paused", detail: hint };
  if (app.status === "failed") return { tone: "attention", title: "Fill failed", detail: app.note.slice(0, 140) };
  if (!last) return { tone: "idle", title: "Ready to fill", detail: hint };
  if (required)
    return { tone: "attention", title: `${filled} filled · ${required} ${required === 1 ? "needs" : "need"} you`, detail: hint };
  return { tone: "done", title: `${filled} filled`, detail: hint };
}
