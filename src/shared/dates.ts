// Dates written as a form wants them: in the format the field itself shows
// (its placeholder, pattern or label: "DD/MM/YYYY", "Year-Month-Day"), else
// the applicant's own (profile.locale.dateFormat), else the usual one of
// their country. A date box (type=date) always takes ISO. With none of
// these known the date is not written: 03/04 is two different days.
import type { Field, Profile } from "./model";

export type DateFormat = "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM-DD";

// Today in the applicant's own time zone, "" (not UTC's, which
// is tomorrow in the evening in the Americas).
export function localDate(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

// A format a field states: "MM/DD/YYYY", "dd.mm.yyyy", "JJ/MM/AAAA",
// "YYYY-MM-DD", "Year-Month-Day", "mm/yyyy". Undefined when it states none.
export function hintedFormat(text: string): string | undefined {
  const words = text.toLowerCase();
  const tokens = words.match(/\b(dd|jj|tt|mm|yyyy|yy|aaaa|jjjj)([\s./\-]+)(dd|jj|tt|mm|yyyy|yy|aaaa|jjjj)(?:\2(dd|jj|tt|mm|yyyy|yy|aaaa|jjjj))?\b/);
  if (tokens) {
    const part = (token: string | undefined) =>
      !token ? "" : /^(dd|jj|tt)$/.test(token) ? "DD" : token === "mm" ? "MM" : /^(yyyy|aaaa|jjjj)$/.test(token) ? "YYYY" : "YY";
    const parts = [part(tokens[1]), part(tokens[3]), part(tokens[4])].filter(Boolean);
    if (new Set(parts).size === parts.length && parts.includes("MM")) return parts.join(tokens[2].trim() || " ");
  }
  const spelled = words.match(/\b(year|month|day)[\s/\-]+(year|month|day)(?:[\s/\-]+(year|month|day))?\b/);
  if (spelled) {
    const order = spelled.slice(1).filter(Boolean).join(" ");
    return { "year month day": "YYYY-MM-DD", "month day year": "MM/DD/YYYY", "day month year": "DD/MM/YYYY", "month year": "MM/YYYY" }[order];
  }
}

// The applicant's date format: their own, else their country's.
export function profileDateFormat(profile: Pick<Profile, "country"> & { locale?: Profile["locale"] }): DateFormat | undefined {
  if (profile.locale?.dateFormat) return profile.locale.dateFormat;
  const country = (profile.country || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (!country) return;
  return /^(us|usa|unitedstates|unitedstatesofamerica|america)$/.test(country) ? "MM/DD/YYYY" : "DD/MM/YYYY";
}

// An ISO date ("", "2027-05") in a format. A format with a day
// gets the 1st for a date saved without one, as the profile editor says;
// asDefault drops the day instead (a format the field did not ask for).
export function formatDate(iso: string, format: string, asDefault = false): string | undefined {
  const match = iso.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!match) return;
  const [, year, month, day] = match;
  let pattern = format;
  if (!day && asDefault) pattern = format === "YYYY-MM-DD" ? "YYYY-MM" : format.replace(/DD[^MY]?/, "");
  return pattern.replace("YYYY", year).replace("YY", year.slice(2)).replace("MM", month).replace("DD", day || "01");
}

// The date to write into a field, or undefined when its format is unknown.
export function writtenDate(
  iso: string,
  field: Pick<Field, "kind" | "label"> & { format?: string },
  profile: Pick<Profile, "country"> & { locale?: Profile["locale"] },
): string | undefined {
  if (field.kind === "date") return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : /^\d{4}-\d{2}$/.test(iso) ? `${iso}-01` : undefined;
  const hinted = hintedFormat(`${field.format || ""} ${field.label}`);
  if (hinted) return formatDate(iso, hinted);
  const own = profileDateFormat(profile);
  return own ? formatDate(iso, own, true) : undefined;
}

// The paper letters are printed on: the applicant's choice, else Letter in
// the United States and Canada (and where the country is not given), A4
// elsewhere.
export function paperSize(profile: Pick<Profile, "country"> & { locale?: Profile["locale"] }): "letter" | "a4" {
  if (profile.locale?.paperSize) return profile.locale.paperSize;
  const country = (profile.country || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  return !country || /^(us|usa|unitedstates|unitedstatesofamerica|america|ca|canada)$/.test(country) ? "letter" : "a4";
}

// A letter's date as the applicant's country writes it: "November 3, 2026"
// in the U.S. (and where nothing says otherwise), "3 November 2026" where
// days come first.
export function letterDateText(profile?: Pick<Profile, "country"> & { locale?: Profile["locale"] }, now = new Date()): string {
  const dayFirst = profile && profileDateFormat(profile) !== undefined && profileDateFormat(profile) !== "MM/DD/YYYY";
  return now.toLocaleDateString(dayFirst ? "en-GB" : "en-US", { year: "numeric", month: "long", day: "numeric" });
}
