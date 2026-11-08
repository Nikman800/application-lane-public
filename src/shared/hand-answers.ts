import { normalize } from "./model";

// Whether an answer the applicant gave by hand is worth keeping as a
// candidate saved answer (background.ts recordHandAnswers, recurringAnswers).
// A saved answer is filled on other sites by its wording, so only a real
// question with an answer as the applicant saw it is kept.
export function keptHandAnswer(field: { label: string; value: string; kind?: string; section?: string }): boolean {
  const question = normalize(field.label);
  const answer = field.value.trim();
  if (!question || question === "unlabelled field" || !answer || answer.length > 120) return false;
  if (field.kind === "textarea" || field.kind === "file") return false;
  // Row fields (a school, an employer) belong to the profile's history.
  if (/education|experience|employment|work/.test(normalize(field.section || ""))) return false;
  if (/signature|initials|password|captcha|^(first|last|middle|full|legal|preferred) name$|^name$|e ?mail|phone/.test(question)) return false;
  // A phone number's country code picker ("Search by country/region or
  // code" = "+1", an employer).
  if (/\b(country|region)\b.*\bcode\b|\b(dial|dialing|calling) code\b/.test(question) || /^\+\d{1,4}$/.test(answer)) return false;
  // A calendar's month heading read as the label ("November 2026" = "No",
  // Tesla), or any label that is only a date.
  if (/^((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+)?\d{1,4}(\s+\d{1,4})*$/.test(question)) return false;
  // A list's hidden option value, not what the applicant picked: an id
  // (one employer's location "65f5e6fd-0ec6-…") or a code ("7_months_or_more", Tesla).
  if (machineValue(answer)) return false;
  return true;
}

export function machineValue(answer: string): boolean {
  const value = answer.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    /^[0-9a-f]{16,}$/i.test(value) ||
    /^[a-z0-9]+(_[a-z0-9]+)+$/i.test(value);
}
