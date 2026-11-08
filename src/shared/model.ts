import { z } from "zod";
import { canonicalAnswer } from "./answers";
import { parseSalary, salarySchema } from "./salary";
import { splitPhone } from "./phone";

// Text compared as words: compatibility forms folded ("ﬁ", full-width
// letters), Latin accents dropped ("José" reads "jose"), letters and digits
// of any script kept ("北京大学"), everything else a single space. Marks
// outside the Latin accents stay, as some scripts' vowels are written with
// them.
export const normalize = (value: string) =>
  value
    // Punctuation a page without a charset shows as "â€" and a byte or two
    // ("self‐identify" read as "selfâ€identify") is punctuation still.
    .replace(/â€[\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u02c6\u02dc\u2013-\u203a\u20ac\u2122]?/g, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();

export const factSchema = z.object({
  id: z.string().min(1).max(100),
  text: z.string().min(1).max(3000),
});
export const historySchema = z.object({
  organization: z.string(),
  title: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  location: z.string().default(""),
  details: z.string().default(""),
  fieldOfStudy: z.string().max(300).optional(),
  // Some forms ask for each employer's (or school's) postal address and why
  // the applicant left. `location` stays the short "City, ST" most forms want.
  address: z.string().max(300).optional(),
  city: z.string().max(150).optional(),
  state: z.string().max(150).optional(),
  county: z.string().max(150).optional(),
  postalCode: z.string().max(50).optional(),
  country: z.string().max(150).optional(),
  reasonForLeaving: z.string().max(500).optional(),
  // An education row's own grade average, on its own scale ("3.62" of 4,
  // "8.7" of 10, "85" of 100). Compared with a stated minimum only on the
  // same scale.
  gpa: z.string().max(20).optional(),
  gpaScale: z.enum(["4", "5", "10", "100", "other"]).optional(),
  // Still studying here (or still working here). An empty end date alone
  // does not say so.
  current: z.boolean().optional(),
  // An education entry's own transcript: a file's name in the transcripts
  // folder. A form asking for one level's transcript gets that entry's.
  transcript: z.string().max(200).optional(),
});
// A professional reference the applicant is willing to have contacted. Phone
// and email are optional because forms differ in which one they require.
export const referenceSchema = z.object({
  name: z.string().max(200),
  relationship: z.string().max(300).default(""),
  phone: z.string().max(100).default(""),
  email: z.string().email().or(z.literal("")).default(""),
});
// What the applicant has saved about their own legal standing and
// eligibility, in their words. It is the only thing a legal or eligibility
// question is answered from unless they let the model use everything.
export const legalDetailLabels = {
  criminal: "Criminal record",
  clearance: "Security clearance",
  exportControl: "Export-control status",
  agreements: "Non-compete or other agreements",
  terminations: "Dismissals or discipline",
  government: "Government or public-office employment",
  relatives: "Relatives at employers",
  screening: "Background checks and drug screening",
  other: "Anything else",
} as const;
export type LegalDetailKey = keyof typeof legalDetailLabels;
// The statements most applicants would make, offered as choices so nobody
// has to compose a sentence about their record. Each is saved as written: a
// legal detail is still the applicant's own sentence, and they may write
// another.
export const legalDetailChoices: Record<LegalDetailKey, readonly string[]> = {
  criminal: ["No convictions and no pending charges"],
  clearance: ["No security clearance, and never held one"],
  exportControl: [
    "U.S. citizen (a U.S. person under ITAR and EAR)",
    "U.S. lawful permanent resident (a U.S. person under ITAR and EAR)",
    "Not a U.S. person under ITAR and EAR",
  ],
  agreements: ["Not bound by any non-compete, non-solicitation or other agreement that limits my work"],
  terminations: ["Never dismissed, disciplined or asked to resign"],
  government: ["Never a government employee or public official"],
  relatives: ["No relatives at any company I apply to"],
  screening: ["Willing to complete a background check and drug screening"],
  other: [],
};
const legalDetail = z.string().max(600).default("");
export const legalDetailsSchema = z
  .object({
    criminal: legalDetail,
    clearance: legalDetail,
    exportControl: legalDetail,
    agreements: legalDetail,
    terminations: legalDetail,
    government: legalDetail,
    relatives: legalDetail,
    screening: legalDetail,
    other: legalDetail,
  })
  .default({});
export const hasLegalDetails = (profile: { legal?: Partial<Record<LegalDetailKey, string>> }) =>
  Object.values(profile.legal || {}).some((text) => Boolean(text?.trim()));
// Work authorization in one country. "authorized" is an older profile's
// plain Yes, which did not say on what basis.
export const workAuthorizationStatuses = ["citizen", "permanent-resident", "visa", "authorized", "none"] as const;
export const workAuthorizationSchema = z.object({
  country: z.string().min(1).max(60),
  status: z.enum(workAuthorizationStatuses).optional(),
  visaType: z.string().max(100).optional(),
  // Unset: not said, and a sponsorship question is left to the applicant.
  needsSponsorship: z.boolean().optional(),
});
export type WorkAuthorization = z.infer<typeof workAuthorizationSchema>;

// A profile's country is the United States, or is not given (older
// profiles were all U.S. ones).
export const usOrUnset = (country: string | undefined) =>
  /^(|us|usa|u s|u s a|united states|united states of america|america)$/.test(normalize(country || ""));

// An older profile's single Yes/No answers as entries: one U.S. entry,
// when the profile's country is the United States or unset. A citizen or
// permanent resident is one whatever the country says.
export function legacyWorkAuthorization(
  authorization: string | undefined,
  sponsorship: string | undefined,
  country: string | undefined,
): { entries: WorkAuthorization[]; citizenships: string[] } {
  const text = normalize(authorization || "");
  const sponsor = canonicalAnswer("sponsorship", sponsorship);
  const citizen = /\b(u s|us|united states|american) (citizen|national)\b|^citizen$/.test(text) && !/\bnot\b/.test(text);
  const resident = /\b(permanent resident|green card|lawful permanent)\b/.test(text) && !/\bnot\b/.test(text);
  const answer = canonicalAnswer("workAuthorization", authorization);
  const status: WorkAuthorization["status"] = citizen
    ? "citizen"
    : resident
      ? "permanent-resident"
      : answer === "Yes"
        ? "authorized"
        : answer === "No"
          ? "none"
          : undefined;
  const needsSponsorship = sponsor === "Yes" ? true : sponsor === "No" ? false : undefined;
  if (!status && needsSponsorship === undefined) return { entries: [], citizenships: [] };
  if (!citizen && !resident && !usOrUnset(country)) return { entries: [], citizenships: [] };
  return {
    entries: [{ country: "US", ...(status ? { status } : {}), ...(needsSponsorship === undefined ? {} : { needsSponsorship }) }],
    citizenships: citizen ? ["US"] : [],
  };
}

const PROFILE_VERSION = 2;
// An older profile in today's shape: its single work authorization and
// sponsorship answers, one GPA, free-text salaries, a global "previously
// employed here" answer and a phone number with its country code each
// become today's fields. A profile already migrated is left as it is.
export function migrateProfile(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const profile = { ...(raw as Record<string, unknown>) };
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  if (!Array.isArray(profile.workAuthorization) || "sponsorship" in profile) {
    const legacy = legacyWorkAuthorization(
      text(profile.workAuthorization),
      text(profile.sponsorship),
      text(profile.country),
    );
    if (!Array.isArray(profile.workAuthorization) || !profile.workAuthorization.length) profile.workAuthorization = legacy.entries;
    const own = Array.isArray(profile.citizenships) ? (profile.citizenships as string[]) : [];
    profile.citizenships = [...new Set([...own, ...legacy.citizenships])];
    delete profile.sponsorship;
  }
  const education = Array.isArray(profile.education)
    ? (profile.education as Record<string, unknown>[]).map((row) => ({ ...row }))
    : undefined;
  // The most recent school: the one ending last, or begun last.
  const latest = education
    ?.map((row, index) => ({ row, index, end: text(row.endDate), start: text(row.startDate) }))
    .sort((a, b) => (b.end || "9999").localeCompare(a.end || "9999") || b.start.localeCompare(a.start))[0];
  const gpa = text(profile.gpa).trim();
  if (gpa && latest && !text(latest.row.gpa)) {
    latest.row.gpa = gpa;
    // A U.S. profile's GPA is on a four-point scale; a figure above 4 says
    // nothing of its scale.
    if (Number(gpa) <= 4 && !latest.row.gpaScale) latest.row.gpaScale = "4";
  }
  delete profile.gpa;
  if (education && Number(profile.schemaVersion || 0) < 2) {
    // An empty end date was "still studying". Only the most recent school,
    // begun within six years, is taken to be; any other is unknown.
    const recent = education
      .map((row, index) => ({ row, index }))
      .sort((a, b) => text(b.row.startDate).localeCompare(text(a.row.startDate)))[0];
    const sixYears = new Date();
    sixYears.setFullYear(sixYears.getFullYear() - 6);
    const since = `${sixYears.getFullYear()}-${String(sixYears.getMonth() + 1).padStart(2, "0")}`;
    if (
      recent &&
      recent.row.current === undefined &&
      !text(recent.row.endDate) &&
      /^\d{4}-\d{2}/.test(text(recent.row.startDate)) &&
      text(recent.row.startDate).slice(0, 7) >= since
    )
      recent.row.current = true;
  }
  if (education) profile.education = education;
  if (!profile.salary) {
    const salary =
      parseSalary(text(profile.salaryYearly), "year") || parseSalary(text(profile.salaryHourly), "hour");
    if (salary) profile.salary = salary;
  }
  delete profile.salaryYearly;
  delete profile.salaryHourly;
  if ("priorEmployment" in profile) {
    if (profile.neverWorkedForApplyingCompanies === undefined && canonicalAnswer("priorEmployment", text(profile.priorEmployment)) === "No")
      profile.neverWorkedForApplyingCompanies = true;
    delete profile.priorEmployment;
  }
  if (!text(profile.phoneCountryCode) && /^\s*(\+|00)/.test(text(profile.phone))) {
    const split = splitPhone(text(profile.phone));
    if (split.code) {
      profile.phoneCountryCode = split.code;
      profile.phone = split.national;
    }
  }
  profile.schemaVersion = PROFILE_VERSION;
  return profile;
}

const profileObject = z.object({
  revision: z.number().int().nonnegative().default(0),
  confirmed: z.boolean(),
  firstName: z.string().max(100),
  lastName: z.string().max(100),
  // Asked for by a "Middle name" box and part of a full legal name; an
  // everyday "Full name" is the first and last name.
  middleName: z.string().max(100).optional(),
  email: z.string().email().or(z.literal("")),
  phone: z.string().max(100).default(""),
  phoneDeviceType: z.string().max(100).default("Mobile"),
  city: z.string().max(150).default(""),
  state: z.string().max(150).default(""),
  county: z.string().max(150).default(""),
  country: z.string().max(150).default(""),
  address: z.string().max(300).default(""),
  addressLine2: z.string().max(300).default(""),
  postalCode: z.string().max(50).default(""),
  linkedin: z.string().max(500).default(""),
  website: z.string().max(500).default(""),
  github: z.string().max(500).optional(),
  preferredName: z.string().max(100).optional(),
  currentCompany: z.string().max(300).optional(),
  skills: z.array(z.string().max(300)).max(100).default([]),
  // One line per language with how well: "English: Native", "Hindi: Fluent".
  languages: z.array(z.string().max(120)).max(20).default([]),
  referralSource: z.array(z.string().max(300)).max(20).default([]),
  disabilityStatus: z.string().max(300).default(""),
  veteranStatus: z.string().max(300).default(""),
  gender: z.string().max(300).default(""),
  ethnicity: z.string().max(300).default(""),
  pronouns: z.string().max(100).default(""),
  sexualOrientation: z.string().max(100).default(""),
  transgender: z.string().max(100).default(""),
  // How the applicant's name is said ("NICK-hill"), for a form that asks.
  namePronunciation: z.string().max(100).default(""),
  // For a form that asks the applicant's age or age range. Kept in the
  // profile like the rest; no prompt sent to a model includes it.
  dateOfBirth: z
    .string()
    .regex(/^$|^\d{4}-\d{2}-\d{2}$/, "Enter a date like 1999-04-23")
    .default(""),
  internshipCount: z
    .string()
    .max(3)
    .regex(/^$|^\d{1,2}$/, "Enter the number of internships, like 2")
    .default(""),
  // Expected pay: a figure or a range, per year, month or hour, in the
  // currency the applicant gave ("" when they gave none).
  salary: salarySchema.optional(),
  hispanic: z.string().max(300).default(""),
  // Where the applicant may work, country by country. A question is
  // answered from the entry for the country it asks about (or the job's).
  workAuthorization: z.array(workAuthorizationSchema).max(30).default([]),
  // Countries the applicant is a citizen of (ISO codes).
  citizenships: z.array(z.string().max(60)).max(10).default([]),
  age18OrOlder: z.string().max(300).default(""),
  willingToRelocate: z.string().max(300).default(""),
  // "I have never worked for any company I apply to": lets a question
  // whether they worked for this employer be answered No when no job in
  // their history is with it. Unset leaves that question to them.
  neverWorkedForApplyingCompanies: z.boolean().optional(),
  // The phone number's country code ("+44"); the number itself is national.
  phoneCountryCode: z.string().max(8).default(""),
  careerStage: z.enum(["student", "new-grad", "experienced", "career-change"]).optional(),
  yearsExperience: z.number().min(0).max(70).optional(),
  // How dates are written where a form does not say, and the paper
  // letters are printed on. Unset: by the applicant's country.
  locale: z
    .object({
      dateFormat: z.enum(["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"]).optional(),
      paperSize: z.enum(["letter", "a4"]).optional(),
    })
    .default({}),
  // Which migrations (migrateProfile) this profile has had.
  schemaVersion: z.number().int().optional(),
  legal: legalDetailsSchema,
  acknowledgeTerms: z.boolean().default(false),
  facts: z.array(factSchema).max(300),
  work: z.array(historySchema).max(30).default([]),
  education: z.array(historySchema).max(30).default([]),
  references: z.array(referenceSchema).max(10).default([]),
  answers: z
    .array(
      z.object({
        question: z.string().min(1).max(1000),
        answer: z.string().max(4000),
      }),
    )
    .max(300)
    .default([]),
});
export const profileSchema = z.preprocess(migrateProfile, profileObject);
export type Reference = z.infer<typeof referenceSchema>;
// The job a fill is for, set on the profile it is given (never saved): its
// country (ISO code) and employer, when known.
export type ApplyingTo = { country?: string; company?: string };
export type Profile = z.infer<typeof profileObject> & { applyingTo?: ApplyingTo };
export const emptyProfile: Profile = profileSchema.parse({
  firstName: "",
  lastName: "",
  email: "",
  confirmed: false,
  facts: [],
});
export const fieldSchema = z.object({
  id: z.string().max(300),
  label: z.string().max(1000),
  kind: z.string().max(100),
  required: z.boolean(),
  value: z.string().max(10000),
  options: z.array(z.string().max(1000)).max(300),
  // How many options the control really has when the list above is cut
  // short (a school list of thousands). The answer is then matched against
  // the whole list on the page, not only against what was sent.
  optionCount: z.number().int().nonnegative().optional(),
  revision: z.number().int(),
  protected: z.boolean(),
  accept: z.string().max(1000).optional(),
  section: z.string().max(500).optional(),
  index: z.number().int().optional(),
  attachmentId: z.string().uuid().optional(),
  invalid: z.boolean().optional(),
  validationWarning: z.string().max(350).optional(),
  fillWarning: z.string().max(350).optional(),
  documentKind: z.enum(["resume", "cover", "transcript"]).optional(),
  // The field's own character limit, when it sets one.
  maxLength: z.number().int().positive().optional(),
  maxWords: z.number().int().positive().optional(),
  // A resume uploader that parses the file and rewrites the form.
  replacesForm: z.boolean().optional(),
  // The question this control is one option of (a checkbox in a group). Its
  // label already carries it ("Question: Option"); this lets a reviewer see
  // the options of one question together.
  question: z.string().max(1000).optional(),
  conflict: z.boolean().optional(),
  // Why a protected field is left alone (a user edit, a value the page set).
  protectedReason: z.string().max(300).optional(),
  // Put there by the site from a parsed resume; the profile may replace it.
  siteValue: z.boolean().optional(),
  // For the AI pass: what the rest of this field's row of a repeated section
  // holds ("School Name: Michigan State University; Degree: Masters"), so a
  // school's or job's own question is answered from that entry. Without it,
  // "Still Student?" was ticked for both schools (Applied Intuition, report
  // 3fcbf55d, 2026-10-28).
  row: z.string().max(1000).optional(),
  // A date format the control itself shows ("DD/MM/YYYY" as its
  // placeholder, pattern or description), when it shows one.
  format: z.string().max(100).optional(),
  // A list's chosen option as it reads, where its value is a code ("28595"
  // for iCIMS's "In Progress"), for the review to read and show.
  valueText: z.string().max(300).optional(),
});
export type Field = z.infer<typeof fieldSchema>;
export type Observation = {
  documentId: string;
  url: string;
  title: string;
  description: string;
  // The employer as the page names it, where its address does not.
  company?: string;
  ats: string;
  fields: Field[];
  paused: boolean;
  // What paused it: the event and the control it landed on.
  pausedBy?: string;
  blockers: string[];
  // Document slots the page draws without a file box (SuccessFactors'
  // attachment widgets): "resume", "cover".
  documentSlots?: string[];
  canAdvance: boolean;
  atReview: boolean;
  // Sections the site config can add rows to when the step shows no fields
  // yet, only Add buttons.
  addable?: string[];
  // The page this one was reached from, as the browser tells it: on a site
  // that keeps the form apart from the posting, usually the posting.
  referrer?: string;
};
export const CONTENT_VERSION = "2026-11-08-lists-handled";
export type Proposal = {
  fieldId: string;
  value: string;
  // For dropdowns whose options are only known once opened: other acceptable
  // wordings, whether a "decline to answer" option is acceptable, and a
  // number to place within range options like "3.5 - 3.74" or "3+".
  choices?: string[];
  decline?: boolean;
  numeric?: number;
  expectedValue: string;
  revision: number;
  source: string;
};
export const generationSchema = z.object({
  // A fit check reads the posting and profile without preparing or filling forms.
  purpose: z.enum(["application", "fit", "answers", "field-fallback"]).optional(),
  questionIds: z.array(z.string().max(300)).max(250).optional(),
  fallbackReasons: z
    .array(
      z.object({
        fieldId: z.string().max(300),
        reason: z.string().max(350),
      }),
    )
    .max(250)
    .optional(),
  applicationId: z.string().uuid(),
  operation: z.number().int().nonnegative(),
  profileRevision: z.number().int(),
  url: z.string().url().max(3000),
  title: z.string().max(1000),
  // As the tracker names it, which may be a URL slug: the letter greets it
  // only when the posting writes the same name.
  company: z.string().max(300).optional(),
  description: z.string().max(25000),
  fields: z.array(fieldSchema).max(250),
  // The pages being filled; one of them may lead to the job posting when
  // the tracked URL does not (an account page, a later application step).
  pageUrls: z.array(z.string().url().max(3000)).max(10).optional(),
  // The posting as the applicant gave it, when the site's own could not be
  // read: its link, or its text pasted.
  postingUrl: z.string().url().max(3000).optional(),
  postingText: z.string().max(25000).optional(),
  // Asked for again by the applicant (Redraft documents): written anew, not
  // taken from an earlier step's documents (2026-11-02).
  redraft: z.boolean().optional(),
  // Suggestions for legal and eligibility questions: from the applicant's
  // saved legal details alone (the default), or from any saved source.
  legalAnswers: z.enum(["details", "any"]).optional(),
});
export type GenerationRequest = z.infer<typeof generationSchema>;
export const jobFitSchema = z.object({
  verdict: z.enum(["good", "partial", "poor", "unknown"]),
  summary: z.string().max(600),
  requirements: z.array(z.object({
    requirement: z.string().max(500),
    importance: z.enum(["required", "preferred"]),
    status: z.enum(["matched", "gap", "uncertain", "unmet"]),
    // Exact excerpts from the applicant's saved background, never new claims.
    evidence: z.array(z.string().max(350)).max(3),
  })).max(8),
  profileRevision: z.number().int(),
  checkedAt: z.number(),
  needsPosting: z.boolean().optional(),
});
export type JobFit = z.infer<typeof jobFitSchema>;
export const narrativeSchema = z.object({
  draftedWith: z.object({ provider: z.enum(["http", "claude-cli", "codex-cli"]), model: z.string(), name: z.string().max(60).optional() }).optional(),
  // Locally generated review notices, never copied from model output.
  warnings: z.array(z.string().max(350)).max(10).optional(),
  resume: z
    .array(z.object({ factId: z.string(), text: z.string().max(3000) }))
    .min(1)
    .max(150),
  coverLetter: z
    .array(
      z.object({ text: z.string().max(3000), factIds: z.array(z.string()) }),
    )
    // Empty when the form has no cover letter field.
    .max(15),
  answers: z
    .array(
      z.object({
        fieldId: z.string(),
        value: z.string().max(4000),
        // Empty for an answer written from the job-applier profile, which
        // grounds it in profile.md rather than in lane facts.
        factIds: z.array(z.string()),
      }),
    )
    .max(100),
  // What the job-applier checkout did to the applicant's own LaTeX resume:
  // the only new prose is the summary, and everything else is reordering.
  tailoring: z
    .object({
      source: z.string().max(200),
      summary: z.string().max(600),
      summaryReplaced: z.boolean(),
      changes: z.array(z.string().max(300)).max(12),
      cautions: z.array(z.string().max(200)).max(5),
    })
    .optional(),
});
export type Narrative = z.infer<typeof narrativeSchema>;
export type Artifact = {
  id: string;
  // A transcript is the applicant's own file (transcripts/), never generated.
  kind: "resume" | "cover" | "transcript";
  format: "pdf" | "docx";
  name: string;
  mime: string;
  applicationId: string;
  operation: number;
  // A transcript attached to an education entry: that entry's index and its
  // degree's level (see shared/transcripts.ts).
  education?: number;
  level?: "undergraduate" | "graduate";
};
export type GenerationJob = {
  id: string;
  purpose?: "application" | "fit" | "answers" | "field-fallback";
  applicationId: string;
  operation: number;
  profileRevision: number;
  status: "queued" | "running" | "complete" | "failed" | "cancelled";
  artifacts: Artifact[];
  narrative?: Narrative;
  answerDrafts?: AnswerDraft[];
  fieldDrafts?: FieldFallbackDraft[];
  warnings?: string[];
  fit?: JobFit;
  // The job posting the documents were tailored from, when it was found.
  posting?: { source: string; title: string; location?: string };
  postingKey?: string;
  // The same role at the same company (see generation.ts).
  postingRole?: string;
  // The documents as files the applicant can pick in a site's file chooser:
  // a folder under the backend's documentsDir (under its Sent once submitted).
  exported?: {
    folder: string;
    sent: boolean;
    files: { artifactId: string; kind: Artifact["kind"]; name: string }[];
  };
  error?: string;
  createdAt: number;
  durationMs?: number;
};
export type DraftProvider = { provider: "http" | "claude-cli" | "codex-cli"; model: string; name?: string };
export type AnswerDraft = {
  fieldId: string;
  label: string;
  value: string;
  required: boolean;
  maxLength?: number;
  maxWords?: number;
  source?: string;
  draftedWith?: DraftProvider;
  skipReason?: string;
};
export type AnswerSession = {
  jobId: string;
  tabId: number;
  operation: number;
  profileRevision: number;
  // Snapshots bind reviewed drafts to this page and these empty fields.
  frames: { frameId: number; documentId: string; fields: Field[] }[];
};
export type FieldFallbackProblem = {
  fieldId: string;
  label: string;
  question?: string;
  section?: string;
  kind: string;
  required: boolean;
  options: string[];
  reason: string;
};
export type FieldFallbackDraft = FieldFallbackProblem & {
  value: string;
  source?: string;
  draftedWith?: DraftProvider;
  skipReason?: string;
};
export type FieldFallbackSession = {
  jobId?: string;
  tabId: number;
  operation: number;
  profileRevision: number;
  problems: FieldFallbackProblem[];
  // Snapshots bind reviewed suggestions to this page and these empty fields.
  frames: { frameId: number; documentId: string; fields: Field[] }[];
};
export type AppStatus =
  | "queued"
  | "inspecting"
  | "preparing"
  | "filling"
  | "awaiting-user"
  | "paused"
  | "ready"
  | "failed"
  | "cancelled";
export type WorkflowStage =
  "applying" | "review" | "submitted" | "blocked" | "abandoned";
export type RelatedTab = {
  id: string;
  tabId?: number;
  url: string;
  title: string;
  role: "posting" | "login" | "form" | "other";
  fieldCount: number;
  state: "unscanned" | "no-form" | "form" | "closed" | "unavailable";
  lastSeenAt: number;
  closedAt?: number;
};
export type FillAttempt = {
  id: string;
  tabId: number;
  startedAt: number;
  completedAt?: number;
  status: "queued" | "filling" | "filled" | "needs-review" | "error" | "paused";
  filled: number;
  note: string;
};
export type Application = {
  id: string;
  tabId?: number;
  url: string;
  sourceUrl: string;
  sourceDescription?: string;
  // The latest fill's failed site-config steps, for issue reports.
  configNotes?: string[];
  // A fingerprint of each document this application uploaded, by kind: a
  // file of the same name in the slot may be an earlier application's.
  // By kind; an education entry's own transcript as "transcript:<entry>".
  uploadedDocuments?: Partial<Record<string, string>>;
  // The last fill's own recording, attached to an issue report.
  lastRecordingId?: string;
  // The job posting as the applicant gave it: a link, or the text pasted.
  postingUrl?: string;
  // The page that led here has been looked for (once: a later step's
  // referrer is the step before it).
  postingSought?: boolean;
  postingText?: string;
  // The job posting the latest documents were tailored from, when found,
  // with where the job is as the posting says.
  posting?: { source: string; title: string; location?: string };
  fit?: JobFit;
  fitJobId?: string;
  fitError?: string;
  // The model's suggestion step after a fill is still running.
  assisting?: boolean;
  // The last automatic suggestion step: the fields it was given, on which
  // tab and profile, and whether it ran to the end. Its leftovers are only
  // worth asking about again when something here has changed.
  aiPass?: { tabId: number; profileRevision?: number; fieldIds: string[]; finished: boolean };
  // The question being written right now, and those worked on before it, in
  // order, for the card. Kept until the applicant starts over.
  progress?: { current?: string; answered: string[] };
  // The site's own confirmation has marked this submitted once. It is not
  // acted on again, so a stage the applicant sets afterwards stands.
  confirmedBySite?: boolean;
  // The frames of the tab a fill wrote to (by frame id, kept across that
  // frame's own navigations): only they may report a confirmation read from
  // a page's words.
  formFrames?: number[];
  // What the model filled in the last fill, for the applicant to check.
  aiFilled?: { label: string; value: string }[];
  // Questions the applicant answered by hand on this application, as last
  // seen: the same answer given on several applications is offered to save
  // ("Military Status: No Military", Expand Energy, 2026-10-30).
  handAnswers?: { question: string; answer: string; at: number }[];
  // Documents being drafted on request, with nothing filled on the page.
  draftJobId?: string;
  draftError?: string;
  answerSession?: AnswerSession;
  fieldFallbackSession?: FieldFallbackSession;
  title: string;
  company: string;
  ats?: string;
  status: AppStatus;
  workflowStage: WorkflowStage;
  archivedAt?: number;
  stageUpdatedAt: number;
  blockedReason?: string;
  submittedAt?: number;
  tabs: RelatedTab[];
  attempts: FillAttempt[];
  issueCount: number;
  explicitFill: boolean;
  // A resume was uploaded to a site that fills the form from it; the next
  // fill may replace what the site parsed.
  siteFillPending?: boolean;
  // Continue this fill once the site finishes rewriting the form.
  continueAfterSiteFill?: boolean;
  // The applicant asked to replace documents the site already held (a
  // resume Amazon stores with the account) with this application's own, for
  // the next fill only, whatever the Pre-filled answers setting.
  replaceDocuments?: boolean;
  // Fill this step on a posting with no form used its Apply control: the
  // pages it was used on (each once, three at most), and the request that
  // carries on to the form.
  applyUsed?: { from: string[]; operation: number; tabId: number; at: number };
  // The resume-first upload has been tried on this application. It happens
  // once: if the site did not take the file (or the dialog stayed up), the
  // next fill goes on with the form instead of uploading and waiting again.
  siteFillTried?: boolean;
  operation: number;
  profileRevision: number;
  jobId?: string;
  documentJobId?: string;
  artifacts: Artifact[];
  narrative?: Narrative;
  missing: string[];
  accessOrigins?: string[];
  note: string;
  createdAt: number;
  updatedAt: number;
  filled: number;
  generationKey?: string;
  advance?: { fingerprint: string; deadline: number; origin: string };
  steps: number;
  startedAt?: number;
  completedAt?: number;
  preparationMs?: number;
  activeSince?: number;
};
export type Settings = {
  concurrency: number;
  // Answers the applicant chose not to save when offered ("question=answer"
  // keys, see RecurringAnswer), so they are not offered again.
  dismissedAnswers?: string[];
  generationConcurrency: number;
  // thorough: a second model checks answers, letters and summaries against
  // the profile (slower); fast: the drafts go out with the word check only.
  checking?: "thorough" | "fast";
  // replace: answers the site had filled in before this extension (a saved
  // profile, an earlier application) give way to the profile's; keep: they
  // stay. Edits the applicant makes are kept either way.
  prefilled?: "replace" | "keep";
  // on: application tabs' network traffic is kept for issue reports.
  networkCapture?: "on" | "off";
  // What Fill this step lets the model do (default "auto"):
  // auto: its written answers and its suggestions for fields the profile
  //   rules did not recognise are filled, and listed as filled by AI;
  // review: neither is filled; both are drafted for approval in the panel;
  // off: only what the profile rules match is filled.
  // "written" is how it worked before 2026-10-11 (written answers filled,
  // suggestions on request); the test suite and offline eval pin it, and
  // Settings does not offer it.
  modelFill?: "auto" | "review" | "off" | "written";
  // Legal and eligibility questions the profile has no answer for (a
  // conviction, a clearance, a relative at the company). manual (default):
  // never answered by the model, listed for the applicant; model: answered
  // like any other question.
  legalQuestions?: "manual" | "model";
};
// One application that went in, kept by the backend apart from the list
// of applications being worked on: removing an application, or archiving it,
// leaves its record here (/v1/submissions).
export type SubmissionRecord = {
  applicationId: string;
  company: string;
  title: string;
  url: string;
  ats?: string;
  submittedAt: number;
  // The site showed its own confirmation; otherwise the applicant marked it.
  confirmedBySite: boolean;
};
// What the extension's queue looks like, mirrored to the backend for the
// command line (scripts/lane.ts): the queue itself lives in the extension.
export type QueueSummaryItem = {
  id: string;
  url: string;
  company: string;
  title: string;
  status: AppStatus;
  stage: WorkflowStage;
  note: string;
  // Required fields the last fill left for the applicant, and optional
  // questions it left empty, at most ten each.
  needs: string[];
  optional?: string[];
  updatedAt: number;
  lastFill?: { status: FillAttempt["status"]; note: string; completedAt?: number; filled: number };
  reports: number;
  // The model is filling what the profile's rules left: still busy.
  assisting?: boolean;
};
export type QueueSnapshot = { at: number; applications: QueueSummaryItem[] };
// An answer the applicant gave by hand on several applications, offered to
// save so that later fills give it.
export type RecurringAnswer = {
  key: string;
  question: string;
  answer: string;
  applications: number;
};
export type QueueState = {
  schemaVersion?: number;
  applications: Application[];
  settings: Settings;
  // Links queued from the command line for a site this extension has no
  // access to yet: the panel asks for it, then tracks them.
  inboxWaiting?: string[];
};
export type TabSuggestion = {
  applicationId: string;
  confidence: "strong" | "possible";
  reason: string;
};
export type TabContext = {
  tabId: number;
  url: string;
  title: string;
  // Fields across every readable frame (a form can sit in an embedded frame).
  fieldCount?: number;
  accessible: boolean;
  permissionOrigin?: string;
  // Embedded frames shown on the page that the extension may not read yet:
  // Fill this step asks for them first.
  frameOrigins?: string[];
  observation?: Observation;
  applicationId?: string;
  suggestions: TabSuggestion[];
  // A site the extension only reads and drafts for (matching.ts).
  draftOnly?: boolean;
};
export type IssueCategory =
  | "wrong-value"
  | "field-not-detected"
  | "fill-failure"
  | "upload"
  | "tab-matching"
  | "other";
export type IssueFrame = {
  url: string;
  observation?: Observation;
  html?: string;
  error?: string;
};
export type IssueReport = {
  id: string;
  createdAt: number;
  category: IssueCategory;
  note: string;
  applicationId?: string;
  application?: {
    title: string;
    company: string;
    workflowStage: WorkflowStage;
    status: AppStatus;
    operation: number;
    missing: string[];
    attempts: FillAttempt[];
    configNotes?: string[];
  };
  tab: { tabId: number; url: string; title: string; ats?: string };
  extension: { version: string; contentVersion: string };
  // The recording of what happened: the last fill's (every fill records
  // itself), or the applicant's own.
  recordingId?: string;
  // The page's network traffic, saved beside the report as a HAR to replay.
  // fromLoad: it holds the page from its first request.
  network?: { entries: number; fromLoad: boolean; recovered?: number; missing?: number };
  frames: IssueFrame[];
  // What the report fixer did with it (scripts/fixer.ts).
  fixer?: FixerResult;
};
// What the fixer is doing, for the dashboard's Fixer page (/v1/fixer): the
// reports and the tasks the form checks queued, newest work first.
export type FixerItem = {
  id: string;
  kind: "report" | "task";
  title: string;
  site?: string;
  // For a task: what the checks found, in their words.
  problem?: string;
  createdAt: number;
  result?: FixerResult;
};
export type FixerOverview = {
  // When the fixer last said it was running (it beats every minute).
  heartbeatAt?: number;
  branch?: string;
  // Fills saved up to this time have been checked for new tasks.
  checkedThrough?: number;
  checkRetryAt?: number;
  // The agents and models the running fixer uses now (its heartbeat).
  inUse?: import("./fixer-settings").FixerSettings;
  // Whether each agent could run a command when last asked (the fixer
  // asks before a task, and passes over one that cannot).
  health?: Partial<Record<import("./fixer-settings").FixerAgent, { ok: boolean; checkedAt: number; detail: string; version?: string }>>;
  items: FixerItem[];
};
// One problem the applicant's note names, and what came of it. A note often
// lists several; the fixer once fixed a report's phone number, called the
// report fixed, and its end dates, school, salary and citizenship problems
// came back in the next report (63ee7aa5, cc40f1fb, 2026-10-27).
export type FixerProblem = {
  problem: string;
  // "left": not reached in this run, so another run takes it up.
  status: "fixed" | "needs-live-check" | "not-a-bug" | "could-not-fix" | "left";
  summary?: string;
};
export type FixerResult = {
  // partly-fixed: some of the note's problems were fixed and others could not be.
  status: "queued" | "working" | "fixed" | "needs-live-check" | "partly-fixed" | "not-a-bug" | "could-not-fix" | "failed";
  summary?: string;
  problems?: FixerProblem[];
  // What to try on the live site, when the fix could not be proven offline.
  liveCheck?: string;
  commit?: string;
  startedAt?: number;
  finishedAt?: number;
};
// A recorded session of page activity (another tool or the user filling a
// form), kept locally for comparison with our own fills.
export type Recording = {
  id: string;
  // Made by a fill, not started by the applicant.
  auto?: boolean;
  createdAt: number;
  durationMs: number;
  tab: { url: string; title: string };
  pages: string[];
  eventCount: number;
  // Field values that changed, how many with no event on the field just
  // before (set directly), and calls into page functions by who made them.
  summary?: {
    valueChanges: number;
    directChanges: number;
    callsBySource: Record<string, number>;
    pageCalls: number;
  };
  events?: {
    t: number;
    kind: string;
    frameId?: number;
    data: Record<string, unknown>;
  }[];
};
export const activeStatuses: AppStatus[] = [
  "inspecting",
  "preparing",
  "filling",
];
export const BACKEND = "http://127.0.0.1:4318";
export const sensitiveQuestion =
  /\b(gender|sex|race|ethnic\w*|disabilit\w*|veteran\w*|criminal|convict\w*|citizen\w*|sponsor\w*|visa|authoriz\w*|eligible|eligibility|consent|agree\w*|certif\w*|signature|salary|compensation|relocat\w*|background check|over 18|at least 18)\b/i;
