import { normalize, type Field, type Profile } from "../shared/model";

// A value in a job's or school's row that the profile's own row holds,
// though no rule answers it: a Workday job's Month and Year, its
// description, whether it is current. The site's
// reading of the resume got it right.
export function rowHolds(field: Field, fields: Field[], profile: Profile): boolean {
  const rows = /education/.test(normalize(field.section || "")) ? profile.education : profile.work;
  // The profile's entry this page row's other fields name (its school or
  // employer; not the field itself, which would vouch for its own guess),
  // else the one at its position: a site that saved and redrew the rows
  // can list them in another order (one employer's iCIMS put the bachelor's
  // first, and both schools' details were flagged).
  const siblings = fields.filter((other) => other !== field && other.section === field.section && (other.index || 0) === (field.index || 0));
  const named = (candidates: Field[]) => {
    const names = candidates.map((other) => normalize(other.value || "")).filter((value) => value.length > 3);
    return rows.find((entry) => entry.organization && names.includes(normalize(entry.organization)));
  };
  // The row's own School or Employer first: its "school not listed" box can
  // hold another school's name (one employer's iCIMS), which is to be
  // checked, not taken as the row's.
  const own = siblings.filter((other) =>
    /^(school|university|college|institution|employer|company|organization)( name)?( dropdown)?$/.test(normalize(other.label)));
  const row = named(own) || named(siblings) || rows[field.index || 0];
  // A list coded in numbers ("06" for June) is read by its number; one coded
  // otherwise ("28595"), by its text ("In Progress").
  const raw = normalize(field.value);
  const value = /^\d{1,2}$|^\d{4}$/.test(raw) ? raw : normalize(field.valueText || field.value);
  if (!row || !value) return false;
  if (field.kind === "checkbox")
    return /\bcurrent/.test(normalize(field.label)) && (value === "yes") === !row.endDate;
  // Graduated when the end date has passed (as the profile answers it):
  // iCIMS's "Received", or "In Progress" and "Not Received" before then.
  if (/\b(graduate|graduated|degree received|completed)\b/.test(normalize(field.label)) && /^\d{4}-\d{2}/.test(row.endDate)) {
    const done = row.endDate.slice(0, 7) <= new Date().toISOString().slice(0, 7);
    if (/^(yes|received|completed|graduated)$/.test(value)) return done;
    if (/^(no|in progress|not received|pursuing|not completed)$/.test(value)) return !done;
  }
  const dates = [row.startDate, row.endDate].filter((date) => /^\d{4}-\d{2}/.test(date));
  // A day is a date's day (one employer's "Date Received" Day), not
  // its month.
  if (/^\d{1,2}$/.test(value) && /\bday\b/.test(normalize(field.label)))
    return dates.some((date) => /^\d{4}-\d{2}-\d{2}/.test(date) && Number(date.slice(8, 10)) === Number(value));
  if (/^\d{1,2}$/.test(value)) return dates.some((date) => Number(date.slice(5, 7)) === Number(value));
  if (/^\d{4}$/.test(value)) return dates.some((date) => date.slice(0, 4) === value);
  return [row.organization, row.title, row.fieldOfStudy, row.location, row.details]
    .map((text) => normalize(text || ""))
    .some((text) => text && (text.includes(value) || (value.length > 20 && value.includes(text))));
}
