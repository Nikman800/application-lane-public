// Exact, controlled degree equivalents. Generic degree levels are allowed;
// an adjacent specialization or a different level is never an equivalent.
export function degreeAliases(title: string): string[] {
  const text = title
    .toLowerCase()
    .replace(/[.']/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Profiles and resumes often put the level in the plural: "Masters of
  // Science" missed one employer's "Master of Science" (Workday).
  const specific: [RegExp, string[]][] = [
    [
      /^(bachelors? of science\b|bs\b|bsc\b)/,
      ["Bachelor of Science", "Bachelors of Science", "BS", "BSc"],
    ],
    [/^(bachelors? of arts\b|ba\b)/, ["Bachelor of Arts", "BA"]],
    [/^(masters? of science\b|ms\b|msc\b)/, ["Master of Science", "Masters of Science", "MS", "MSc"]],
    [/^(masters? of arts\b|ma\b)/, ["Master of Arts", "MA"]],
    [
      /^(masters? of business administration\b|mba\b)/,
      ["Master of Business Administration", "MBA"],
    ],
    [/^(masters? of engineering\b|meng\b)/, ["Master of Engineering", "MEng"]],
    [/^(masters? of fine arts\b|mfa\b)/, ["Master of Fine Arts", "MFA"]],
    [
      /^(bachelors? of engineering\b|beng\b)/,
      ["Bachelor of Engineering", "BEng"],
    ],
    [/^(bachelors? of fine arts\b|bfa\b)/, ["Bachelor of Fine Arts", "BFA"]],
    [
      /^(bachelors? of business administration\b|bba\b)/,
      ["Bachelor of Business Administration", "BBA"],
    ],
    [/^(associates? of science\b|as\b)/, ["Associate of Science", "AS"]],
    [/^(associates? of arts\b|aa\b)/, ["Associate of Arts", "AA"]],
  ];
  const precise = specific.find(([pattern]) => pattern.test(text))?.[1] || [];
  const generic =
    /^(bachelor\b|bachelors\b|bs\b|ba\b|bsc\b|beng\b|bfa\b|bba\b)/.test(text)
      ? ["Bachelor's", "Bachelor's degree", "Bachelors", "Bachelor", "Bachelors Degree", "Bachelor Degree"]
      : /^(master\b|masters\b|ms\b|ma\b|msc\b|meng\b|mfa\b|mba\b)/.test(text)
        ? ["Master's", "Master's degree", "Masters", "Master", "Masters Degree", "Master Degree"]
        : /^(associate\b|associates\b|as\b|aa\b)/.test(text)
          ? ["Associate's", "Associate's degree", "Associate"]
          : /^(phd\b|doctor of philosophy\b)/.test(text)
            ? ["PhD", "Ph.D.", "Doctor of Philosophy", "Doctorate"]
            : [];
  return [...new Set([...precise, ...generic])];
}

type Row = { title: string; startDate: string; endDate: string; current?: boolean; gpa?: string; gpaScale?: string };

// A degree's level from its title ("M.S. Data Science" is a master's).
export function degreeLevel(text: string): "mba" | "doctorate" | "master" | "bachelor" | "associate" | "" {
  const read = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return /\bmba\b|business administration/.test(read) ? "mba"
    : /\b(ph ?d|doctor\w*)\b/.test(read) ? "doctorate"
    : /\b(masters?|m ?s|m ?a|msc|meng|graduate degree)\b/.test(read) && !/under ?grad/.test(read) ? "master"
    : /\b(bachelors?|b ?s|b ?a|bsc|beng|undergrad\w*)\b/.test(read) ? "bachelor"
    : /\bassociates?\b/.test(read) ? "associate"
    : "";
}
export const levelRank = { "": 0, associate: 1, bachelor: 2, master: 3, mba: 3, doctorate: 4 };

// This month, in the applicant's own time zone ("2026-11").
export const thisMonth = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

// Whether the applicant is still at this school (or job): its own say, else
// an end date still ahead. An empty end date alone says nothing.
export function studying(row: Row, now = new Date()): boolean | undefined {
  if (row.current !== undefined) return row.current;
  if (/^\d{4}-\d{2}/.test(row.endDate)) return row.endDate.slice(0, 7) >= thisMonth(now);
  return undefined;
}

// Graduated here: an end date passed, and not marked as still studying.
export function graduated(row: Row, now = new Date()): boolean | undefined {
  if (row.current) return false;
  if (/^\d{4}-\d{2}/.test(row.endDate)) return row.endDate.slice(0, 7) < thisMonth(now);
  return undefined;
}

// The row held now or ended last: current rows first, then by end date.
export function latestRow<T extends Row>(rows: T[]): T | undefined {
  return [...rows].sort((a, b) =>
    Number(Boolean(b.current)) - Number(Boolean(a.current)) ||
    (b.endDate || "").localeCompare(a.endDate || "") ||
    (b.startDate || "").localeCompare(a.startDate || ""))[0];
}

// The row of the highest degree, by its level; the latest of several at
// that level. Undefined when no title names a level.
export function highestRow<T extends Row>(rows: T[]): T | undefined {
  const top = Math.max(0, ...rows.map((row) => levelRank[degreeLevel(row.title)]));
  return top ? latestRow(rows.filter((row) => levelRank[degreeLevel(row.title)] === top)) : undefined;
}
