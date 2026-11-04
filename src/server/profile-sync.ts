import { answerChoices, canonicalAnswer, type ChoiceField } from "../shared/answers";
import type { Profile } from "../shared/model";
import { authorizationAnswer } from "../shared/authorization";
import { latestRow, thisMonth } from "../shared/education";
import { formatSalary, parseSalary } from "../shared/salary";
import { questionTopic } from "../shared/standing";
import { skillContext, type SkillContext } from "./answers";
import type { Config } from "./store";

// Answers kept both in the extension profile and in the job-applier
// markdown. Direct fills (yes/no, demographics, history rows) come from the
// extension profile and written answers from the markdown, so when the two
// disagree one application can contradict itself. This names each
// disagreement; it never picks a side.
export type ProfileConflict = {
  field: string;
  extension: string;
  markdown: string;
  file: "preferences.md" | "profile.md";
};

// "- **Label:** value" and "- **Label?** value" lines, with continuation
// lines folded in.
export function markdownEntries(markdown: string): Map<string, string> {
  const entries = new Map<string, string>();
  let last: string | undefined;
  for (const line of markdown.split("\n")) {
    const entry = line.match(/^\s*-\s+\*\*(.+?)[:?]?\*\*[:?]?\s*(.*)$/u);
    if (entry) {
      last = entry[1].trim().toLowerCase();
      entries.set(last, entry[2].trim());
    } else if (last && /^\s{2,}\S/u.test(line))
      entries.set(last, `${entries.get(last)} ${line.trim()}`);
    else last = undefined;
  }
  return entries;
}

const choiceFields: { label: RegExp; field: ChoiceField; name: string }[] = [
  { label: /^work authori[sz]ation/, field: "workAuthorization", name: "Work authorization" },
  { label: /sponsorship/, field: "sponsorship", name: "Visa sponsorship" },
  { label: /^relocation/, field: "willingToRelocate", name: "Relocation" },
  { label: /^veteran/, field: "veteranStatus", name: "Veteran status" },
];

const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// "December 13, 2027" as 2027-12, or with its day as 2027-12-13.
const monthYear = (text: string, withDay = false) => {
  const match = text.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:(\d{1,2}),?\s+)?(\d{4})\b/u);
  if (!match) return "";
  const month = months.findIndex((name) => name.startsWith(match[1])) + 1;
  const day = withDay && match[2] ? `-${match[2].padStart(2, "0")}` : "";
  return `${match[3]}-${String(month).padStart(2, "0")}${day}`;
};

// "Graduation by role" in preferences.md: the date an internship or co-op
// application states, and the date a full-time or new-grad one states.
// Some applicants graduate later on purpose so they are still enrolled after
// a summer internship.
export type GraduationRule = { internship?: string; fullTime?: string };
export function graduationRule(preferences: string, withDay = false): GraduationRule {
  const entry = [...markdownEntries(preferences)].find(([key]) => /^graduation by role/.test(key))?.[1];
  if (!entry) return {};
  const after = (pattern: RegExp) => {
    const at = entry.search(pattern);
    return at < 0 ? "" : monthYear(entry.slice(at), withDay);
  };
  return {
    internship: after(/intern|co-?op/i) || undefined,
    fullTime: after(/full.?time|new.?grad/i) || undefined,
  };
}

// Banks call their internships summer analyst and summer associate programs
// ("Global Technology Summer Analyst 2027").
export const internshipRole = (title: string) =>
  /\b(intern|interns|internship|co-?op|summer (analyst|associate|program|scholar))\b/i.test(title);

export function graduationFor(rule: GraduationRule, title: string): string | undefined {
  return internshipRole(title) ? rule.internship : rule.fullTime;
}

// The degree still in progress (the latest end date not yet past) ends on
// this application's graduation date; completed degrees are left alone.
export function withGraduation(profile: Profile, endDate: string): Profile {
  const now = thisMonth();
  const current = profile.education
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.endDate.slice(0, 7) >= now)
    .sort((a, b) => b.row.endDate.localeCompare(a.row.endDate))[0];
  // Same date, or the same month given without a day: keep the stored date.
  if (!current || current.row.endDate === endDate || current.row.endDate.slice(0, 7) === endDate) return profile;
  const education = profile.education.map((row, index) => (index === current.index ? { ...row, endDate } : row));
  return { ...profile, education };
}

// This application's graduation month (YYYY-MM), when preferences.md has a
// rule by role; undefined otherwise.
export async function applicationGraduation(config: Config, title: string): Promise<string | undefined> {
  if (!config.tailorDir) return;
  const context = await skillContext(config.tailorDir).catch(() => undefined);
  return context ? graduationFor(graduationRule(context.preferences), title) : undefined;
}

// Standing answers preferences.md states plainly, as saved answers the
// extension matches by topic (shared/standing.ts). Only an entry that reads
// one way is used; anything hedged or missing is left for the applicant.
export function preferenceAnswers(preferences: string, title: string): Profile["answers"] {
  const entries = markdownEntries(preferences);
  const find = (label: RegExp) => [...entries].find(([key]) => label.test(key))?.[1] || "";
  const yesNo = (text: string) => (/^\s*yes\b/i.test(text) ? "Yes" : /^\s*no(ne)?\b/i.test(text) ? "No" : "");
  const answers: Profile["answers"] = [];
  const add = (question: string, answer: string) => {
    if (answer) answers.push({ question, answer });
  };
  add("Are you willing to relocate?", yesNo(find(/^relocation/)));
  const authorization = find(/^work authori[sz]ation/);
  if (/\bu\.?s\.? citizen\b/i.test(authorization) && !/\bnot a\b/i.test(authorization)) {
    add("Are you a U.S. citizen?", "Yes");
    // A citizen is a U.S. person under the export-control rules.
    add("Are you a U.S. person under export control regulations?", "Yes");
  }
  const place = find(/^remote vs\.? ?onsite/);
  if (/\bonsite\b|\bon-site\b/i.test(place) && !/\b(no|not|never|cannot|can't) (work )?(onsite|on-site)\b|remote only/i.test(place))
    add("Are you willing to work onsite?", "Yes");
  // A figure for full-time roles; an internship takes the posted rate. In
  // any currency and form the notes give it ("$95,000", "55k", "€55.000",
  // "£40,000-50,000"), with no currency added that they do not give.
  const salary = parseSalary(find(/^salary expectation/).split(/[;(]/)[0], "year");
  if (salary && salary.period === "year" && (salary.min || 0) >= 1000 && !internshipRole(title))
    add("What are your salary expectations?", formatSalary(salary));
  const start = find(/^earliest start date/);
  if (/^\s*immediately\b/i.test(start)) add("When can you start?", "Immediately");
  if (/^\s*full-?time\b/i.test(find(/^internship \/ co-op hours|^hours/))) add("Are you available to work full-time?", "Yes");
  const clearance = find(/^security clearance/);
  add("Do you hold an active security clearance?", yesNo(clearance));
  add("Are you willing to complete a coding assessment?", yesNo(find(/take-home|coding assessment/)));
  return answers;
}

// The profile as one application should state it.
export async function applicationProfile(profile: Profile, config: Config, title: string): Promise<Profile> {
  if (!config.tailorDir) return profile;
  const context = await skillContext(config.tailorDir).catch(() => undefined);
  if (!context) return profile;
  // With its day: a date picker takes a whole date (Amazon's "Year-Month-
  // Day"), and the 1st would misstate it.
  const date = graduationFor(graduationRule(context.preferences, true), title);
  const dated = date ? withGraduation(profile, date) : profile;
  // What the applicant saved in the extension wins over the markdown.
  const own = new Set<string | undefined>(dated.answers.map((answer) => questionTopic(answer.question)).filter(Boolean));
  if (dated.willingToRelocate) own.add("relocate");
  const added = preferenceAnswers(context.preferences, title).filter((answer) => !own.has(questionTopic(answer.question)));
  return added.length ? { ...dated, answers: [...dated.answers, ...added].slice(0, 300) } : dated;
}

export function profileConflicts(profile: Profile, context: Pick<SkillContext, "profile" | "preferences">): ProfileConflict[] {
  const conflicts: ProfileConflict[] = [];
  const preferences = markdownEntries(context.preferences);
  const find = (label: RegExp) => [...preferences].find(([key]) => label.test(key))?.[1];

  for (const { label, field, name } of choiceFields) {
    const written = find(label);
    // Authorization is per country now; the notes are about the U.S.
    const kept = field === "workAuthorization" || field === "sponsorship"
      ? authorizationAnswer(profile, "in the United States", field) || ""
      : field === "willingToRelocate" || field === "veteranStatus" ? profile[field] : "";
    if (!written || !kept) continue;
    const a = canonicalAnswer(field, kept);
    const b = canonicalAnswer(field, written);
    const known = answerChoices[field] as readonly string[];
    // Only two readable answers that differ are a contradiction.
    if (known.includes(a) && known.includes(b) && a !== b)
      conflicts.push({ field: name, extension: kept, markdown: written.slice(0, 120), file: "preferences.md" });
  }

  const home = find(/^home base/);
  if (home && profile.city && !home.toLowerCase().includes(profile.city.trim().toLowerCase()))
    conflicts.push({ field: "Home city", extension: [profile.city, profile.state].filter(Boolean).join(", "), markdown: home, file: "preferences.md" });

  // The latest education end date the extension has, against the markdown's
  // graduation date. A month is enough; days are rarely on both.
  const graduation = find(/^graduation$/);
  const ends = profile.education.map((row) => row.endDate.slice(0, 7)).filter((d) => /^\d{4}-\d{2}$/u.test(d)).sort();
  const written = graduation ? monthYear(graduation) : "";
  // With a rule by role, either of its dates agrees: the application picks.
  const rule = graduationRule(context.preferences);
  const allowed = [written, rule.internship, rule.fullTime].filter(Boolean);
  if (written && ends.length && !allowed.includes(ends.at(-1)!))
    conflicts.push({ field: "Graduation", extension: ends.at(-1)!, markdown: graduation!.slice(0, 60), file: "preferences.md" });

  const gpa = context.profile.match(/\bGPA\s*:?\s*(\d\.\d{1,3})\b/u)?.[1];
  const ownGPA = latestRow(profile.education.filter((row) => row.gpa?.trim()))?.gpa?.trim();
  if (gpa && ownGPA && Number(gpa) !== Number(ownGPA))
    conflicts.push({ field: "GPA", extension: ownGPA, markdown: gpa, file: "profile.md" });

  return conflicts;
}

export function conflictWarning(conflicts: ProfileConflict[]): string[] {
  if (!conflicts.length) return [];
  const list = conflicts.map((c) => `${c.field} (extension: ${c.extension}; ${c.file}: ${c.markdown})`).join("; ");
  return [
    `Your extension profile and your tailoring notes disagree, so this application may contradict itself. Yes/no answers use the extension profile; written answers use the files. ${list}`.slice(0, 350),
  ];
}
