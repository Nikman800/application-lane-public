import { normalize, type Field } from "./model";

const identity =
  /^(first|last|full|legal|preferred|middle|given|family)?\s*name\b|\be-?mail\b|\bphone\b|\bmobile\b|linkedin|github|\bwebsite\b|portfolio|\burl\b|\baddress\b|^(city|state|province|zip|postal|country)\b|twitter|behance|dribbble|pronoun|\bzip\b|postal code|post code|street|residen(ce|tial) address/i;
const neverWritten =
  /\bgender\b|\brace\b|ethnic|hispanic|latin[oax]|veteran|disabilit|sexual orientation|\bconsent\b|\bagree\b|signature|sign here|initials|certif|criminal|convict|felony|password|captcha|verification code|one.time/i;
const questionShaped =
  /\?\s*$|^\s*(what|why|how|when|where|which|who|describe|tell|explain|share|list|give|provide|please)\b/i;
// Never the model's to give, whatever the settings: secrets, signatures and
// attestations. Legal and eligibility questions are a separate, adjustable
// rule (legalQuestion below).
// (A "Degree Conferred" box takes a date the model can only guess at; it
// wrote a degree's name there, L3Harris, 2026-10-15.)
const manualOnly =
  /password|passcode|captcha|verification code|one.time|signature|sign here|initials|\bconsent\b|\bagree\b|certif|social security|\bssn\b|tax id|bank account|\b(degree|diploma) (conferred|received|awarded)\b/i;
export const logisticsQuestion =
  /salary|compensation|pay (expectation|requirement|range)|hourly (rate|pay)|start date|when can you start|availab|notice period|relocat|remote|on-?site|hybrid|work authori[sz]|sponsor|\bvisa\b/i;

export function applicationQuestion(field: Field): boolean {
  if (field.protected || field.value.trim() || field.options.length)
    return false;
  if (!["textarea", "text"].includes(field.kind)) return false;
  const label = field.label.trim();
  if (
    !label ||
    label === "Unlabelled field" ||
    neverWritten.test(label) ||
    // A legal or eligibility question, written explanations included, is
    // answered from the applicant's saved details by the suggestion step.
    legalQuestion(`${field.question || ""} ${label}`) ||
    /cover.?letter/i.test(label)
  )
    return false;
  // History rows use names such as "Education Information 1" and "Work
  // Experience 2". Narrative prompts may still mention work or education.
  if (
    /^(?:education(?: information| history| background)?|academic(?: information| history| background)?|school(?: information| history)?|work(?: experience| history| information)?|experience|employment(?: history| information)?)\s*(?:#?\d+)?$/i.test(
      field.section || "",
    )
  )
    return false;
  if (identity.test(label) && !logisticsQuestion.test(label)) return false;
  return (
    field.kind === "textarea" ||
    questionShaped.test(label) ||
    logisticsQuestion.test(label)
  );
}

// Empty structured controls that normal profile matching could not finish.
// Written responses have their own reviewed workflow; attestations and
// secret/financial fields always stay with the applicant, and so does a
// legal or eligibility question unless the applicant lets the model answer.
export function structuredFallbackField(field: Field, legalToo = false): boolean {
  if (field.protected || field.value.trim() || applicationQuestion(field))
    return false;
  if (!legalToo && legalQuestion(`${field.question || ""} ${field.label}`)) return false;
  if (
    manualOnly.test(field.label) ||
    /file|password|hidden|submit|button/.test(field.kind)
  )
    return false;
  // A box that adds one choice per search ("Type to Add Skills", Workday)
  // holds no written answer: a list typed into it was the model's, in the
  // wrong form (Jabil, 2026-10-16). Its site rule picks each one.
  if (/^(type to (add|search)|search( for)?)\b/i.test(field.label.trim())) return false;
  // A job's or school's dates are the profile's, row by row: one it leaves
  // empty (an end date for a job still held) stays empty. The model, told
  // only "End Date" under "Previous employment", gave a current job another
  // job's end date (SuccessFactors, report 7810d2d5, 2026-10-15).
  if (
    /education|academic|school|work|employment|experience/i.test(field.section || "") &&
    /\b(date|from|to|start|end|month|year)\b/i.test(field.label)
  )
    return false;
  // So is a school's GPA: one the profile leaves out is left out on purpose.
  // The model put one school's GPA on another (Workday, report e63ffa89).
  if (/\b(c?gpa|grade point)\b/i.test(field.label)) return false;
  return Boolean(field.label.trim() && field.label !== "Unlabelled field");
}

// A question whose answer is a statement about the applicant's legal
// standing or eligibility. A wrong answer is a false statement on an
// application, so by default the model never gives one: the applicant's
// saved profile answers it, or the applicant does.
const legalOrEligibility =
  /\b(convict\w*|felon\w*|misdemeano\w*|criminal\w*|arrest\w*|pending charges?|probation|parole|security clearance|clearance|polygraph|background (check|investigation)|drug (test|screen)\w*|non ?compete|non ?solicit\w*|restrictive covenant|confidentiality agreement|asked to resign|disciplinary action|disciplined|debar\w*|sanctioned|sanctions list|export control\w*|itar|conflicts? of interest|government (official|employee|agency)|public official|bankrupt\w*|lawsuit\w*|litigation|licen[cs]e (been )?(revoked|suspended))\b|\b(terminated|termination|fired|dismissed|discharged)\b.{0,60}\b(employ\w*|job|position|company)\b|\b(employ\w*|job|position)\b.{0,60}\b(terminated|termination|fired|dismissed|discharged)\b|\b(relatives?|family members?|related to (any|anyone|someone|an?|current|our|employees?))\b.{0,60}\b(work|works|working|employ\w*|company)\b|\b(work|employ)\w*\b.{0,40}\b(relatives?|family members?|related to (any|anyone|someone|an?|current|our|employees?))\b/;
export function legalQuestion(label: string): boolean {
  return legalOrEligibility.test(normalize(label));
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}
export function wordLimit(text: string): number | undefined {
  const matches = [
    ...text.matchAll(
      /(?:max(?:imum)?\s*(?:word\s*count)?\s*(?:of|:)?\s*(\d[\d,]*)\s*words?|(\d[\d,]*)\s*[- ]?words?\s*(?:limit|max(?:imum)?)|word\s*limit\s*(?:of|:)?\s*(\d[\d,]*))/giu,
    ),
  ];
  const limits = matches
    .map((m) => Number((m[1] || m[2] || m[3]).replaceAll(",", "")))
    .filter((n) => n > 0 && n <= 10000);
  return limits.length ? Math.min(...limits) : undefined;
}
export function answerLimitError(
  text: string,
  field: Pick<Field, "maxLength" | "maxWords">,
): string | undefined {
  if (field.maxWords && wordCount(text) > field.maxWords)
    return `Use at most ${field.maxWords} words.`;
  const characters = Math.min(field.maxLength || 4000, 4000);
  if (text.length > characters) return `Use at most ${characters} characters.`;
}
// Keep complete sentences; never turn an oversized draft into a fragment.
export function fitAnswerLength(
  text: string,
  field: Pick<Field, "maxLength" | "maxWords">,
): string {
  if (!answerLimitError(text, field)) return text;
  let kept = "";
  for (const sentence of text.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“])/u)) {
    const next = [kept, sentence].filter(Boolean).join(" ");
    if (answerLimitError(next, field)) break;
    kept = next;
  }
  return kept;
}
