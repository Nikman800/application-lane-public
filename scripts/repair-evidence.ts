// What a report or settled capture shows: the defects the software can fix,
// and what only the applicant can do (src/shared/repairs.ts says why the two
// are kept apart). Two sources, read together:
//
// - the form checks of eval/invariants.ts on the page's fields as the
//   extension read them (rejected, wrong-shape and placeholder values, values
//   the site cleared, rows short, uploads missing, fields skipped for a
//   shared label);
// - the fill's own account of what it could not do (application.missing):
//   "<field>: not filled (…)", "Answer not filled: …", an upload that did
//   not finish, a site rule that failed, and what it left for the applicant.
//
// A required field that is only empty (invariants' required-empty) is not a
// defect here: the checks cannot tell whether the profile has an answer. It
// is one when the fill's notes say it had a value and failed to write it.
// Both upload-missing and same-label-skipped, which eval/fix-tasks.ts leaves
// out of its automatic tasks, are defects here: on a live page they are the
// fill's to do.

import { checkForm, labelKey, type CheckField, type Rule } from "../eval/invariants";
import { defectId, type Defect, type DefectKind, type Found } from "../src/shared/repairs";

type SavedField = {
  label: string;
  kind: string;
  required?: boolean;
  value?: string;
  options?: string[];
  invalid?: boolean;
  fillWarning?: string;
  protected?: boolean;
  protectedReason?: string;
};
export type Evidence = {
  id: string;
  applicationId?: string;
  createdAt?: number;
  tab?: { url?: string; ats?: string };
  application?: { missing?: string[]; attempts?: { status?: string; note?: string; completedAt?: number }[] };
  frames?: { observation?: { fields?: SavedField[] } }[];
};

const ruleKind: Partial<Record<Rule, DefectKind>> = {
  "fill-error": "fill-failed",
  "write-failed": "widget",
  "lost-value": "lost-value",
  "placeholder-value": "wrong-value",
  "wrong-shape": "wrong-value",
  "not-an-option": "wrong-value",
  "site-rejected": "rejected",
  "rows-short": "wrong-value",
  "menu-open": "widget",
  "upload-missing": "upload",
  "same-label-skipped": "empty-answerable",
};

const strip = (text: string) => text.replace(/\s+/g, " ").trim();

export function findDefects(evidence: Evidence): Found {
  const defects = new Map<string, Defect>();
  const userActions = new Set<string>();
  const add = (kind: DefectKind, field: string | undefined, detail: string) => {
    const id = defectId(kind, field ? labelKey(field) : undefined, detail);
    if (!defects.has(id)) defects.set(id, { id, kind, ...(field ? { field: strip(field).slice(0, 300) } : {}), detail: strip(detail).slice(0, 600), status: "open", seenIn: evidence.id });
  };
  const missing = evidence.application?.missing || [];
  // Fields the fill said it had an answer for and could not write.
  const failedLabels = new Set<string>();

  for (const raw of missing) {
    const line = strip(raw);
    let match: RegExpMatchArray | null;
    if ((match = line.match(/^Left "(.+?)" for you: (.+)$/))) userActions.add(`Answer "${match[1].slice(0, 120)}": ${match[2].slice(0, 200)}`);
    else if (/captcha|verify you are human|sign in again|log in again|session (has )?expired|signed out/i.test(line)) userActions.add(line.slice(0, 300));
    else if ((match = line.match(/^Required: (.+?) \(left alone: (.+)\)/))) {
      // The applicant's own edit holds it: theirs to clear or fill. A site
      // rule that was to fill it and did not is the fill's.
      if (/edit lock|your edit|you (typed|changed|cleared)|existing value/i.test(match[2])) userActions.add(`"${match[1].slice(0, 120)}" holds your earlier edit: fill it, or choose Unlock empty fields.`);
      else { add("empty-answerable", match[1], `Left empty: ${match[2]}`); failedLabels.add(labelKey(match[1])); }
    } else if ((match = line.match(/^(.+?): not filled \((.+?)\)\.?$/))) {
      if (!/paused by you|you interacted/i.test(match[2])) { add("widget", match[1], `Not filled: ${match[2]}`); failedLabels.add(labelKey(match[1])); }
    } else if ((match = line.match(/^Answer not filled: (.+?)\. (.+)$/))) { add("widget", match[1], match[2]); failedLabels.add(labelKey(match[1])); }
    else if ((match = line.match(/^(.+?): Dropdown options were not available/))) { add("widget", match[1], line); failedLabels.add(labelKey(match[1])); }
    else if ((match = line.match(/^Site validation failed: (.+)$/))) add("rejected", match[1], "The site marks the value invalid.");
    else if ((match = line.match(/^(Resume|Cover letter|.+?) upload did not finish/))) add("upload", match[1], line);
    else if ((match = line.match(/^Verify upload: (.+)$/))) add("upload", match[1], "The upload was not confirmed on the page.");
    else if ((match = line.match(/^Choose a file manually: (.+)$/))) {
      // A document the lane makes (résumé, cover letter, transcript) left
      // unattached is the fill's; any other file (a photo) is the applicant's.
      if (/resume|résumé|\bcv\b|cover letter|transcript|choose a file or drop it here/i.test(match[1])) add("upload", match[1], "No document was attached.");
      else userActions.add(`Attach "${match[1].slice(0, 120)}" yourself if you want to.`);
    }
    else if (/^AI suggestions were not filled automatically/.test(line)) add("widget", undefined, line);
    else if ((match = line.match(/^(.+?): "(.+?)" was filled in by the site from your resume and not corrected/))) add("wrong-value", match[1], line);
    else if (/^The job posting could not be read/.test(line)) userActions.add("Add the posting's link or text to the application, then fill again.");
  }

  const fields: CheckField[] = (evidence.frames || []).flatMap((frame) =>
    (frame.observation?.fields || []).map((field) => ({
      label: field.label,
      kind: field.kind,
      required: Boolean(field.required),
      value: field.value || "",
      ...(field.options ? { options: field.options } : {}),
      ...(field.invalid ? { invalid: true } : {}),
      ...(field.fillWarning ? { warning: field.fillWarning } : {}),
      ...(field.protected ? { protected: true } : {}),
      ...(field.protected && /edit lock/i.test(field.protectedReason || "") ? { lock: field.protectedReason } : {}),
    })),
  );
  const last = evidence.application?.attempts?.at(-1);
  for (const violation of checkForm(fields, { site: evidence.tab?.ats || "", fillStatus: last?.status, fillNote: last?.note })) {
    if (violation.rule === "required-left-for-you") userActions.add(`Answer "${violation.label.slice(0, 120)}" yourself (consent, signature or self-identification).`);
    else if (violation.rule === "locked-empty") userActions.add(`"${violation.label.slice(0, 120)}" is kept empty by your earlier edit: fill it, or choose Unlock empty fields.`);
    else if (violation.rule === "required-empty") {
      // Only with the fill's word that it had an answer (above).
      if (failedLabels.has(labelKey(violation.label))) continue;
    } else if (violation.rule === "fill-warning") add(/cleared/i.test(violation.detail) ? "lost-value" : /replaced/i.test(violation.detail) ? "wrong-value" : "widget", violation.label, violation.detail);
    else if (ruleKind[violation.rule]) add(ruleKind[violation.rule]!, violation.label || undefined, violation.detail);
  }
  return { defects: [...defects.values()], userActions: [...userActions] };
}
