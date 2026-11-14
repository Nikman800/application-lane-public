// Facts computed when a form is filled. They are never saved as extra profile
// fields (which would go stale), and the date of birth never goes to a model.
import { normalize, type Field, type Profile, type Proposal } from "./model";
import { degreeAliases, degreeLevel, graduated, highestRow, latestRow, levelRank, studying } from "./education";
import { writtenDate } from "./dates";
import { schoolNames } from "./schools";

type Answer = Pick<Proposal, "value" | "choices" | "numeric">;
type Education = Profile["education"][number];

// Strip control decorations, not conditions embedded in the question.
function question(text: string): string {
  return normalize(text.replace(/\b(\d+)\s*\+/g, "$1 or older").split("?")[0])
    .replace(/^\d+ /, "").replace(/ (yes no|no yes)$/, "")
    .replace(/ (optional|required|if applicable)$/, "");
}

export function ageInYears(dateOfBirth: string, now = new Date()): number | undefined {
  const parts = dateOfBirth.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts || !Number.isFinite(now.getTime())) return;
  const [, y, m, d] = parts.map(Number);
  // Construct in UTC only to validate the calendar date. Age uses the local
  // calendar, so a birthday does not happen early in an American evening.
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return;
  const age = now.getFullYear() - y - Number(now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d));
  return age >= 0 && age < 130 ? age : undefined;
}

type AgeTest = { minimum: number; inclusive: boolean; below: boolean };
function ageTest(text: string): AgeTest | undefined {
  // A second question or condition is not proved by a birthday alone.
  const tail = text.split("?").slice(1).join("?").trim();
  if (tail && !/^(yes\s*no|no\s*yes|\(?required\)?|\(?optional\)?|\*)$/i.test(tail)) return;
  let q = question(text).replace(/\beighteen\b/g, "18").replace(/\bsixteen\b/g, "16").replace(/\btwenty one\b/g, "21");
  q = q.replace(/^at the time of (application|applying) /, "").replace(/ (as of today|today)$/, "");
  q = q.replace(/^(are you|is your age) /, "").replace(/^(age|aged) /, "");
  const lower = q.match(/^(at least|over|older than|under|younger than|less than) (?:the age of )?(\d{1,3})(?: years?(?: of age| old)?)?$/);
  if (lower) return { minimum: Number(lower[2]), inclusive: lower[1] === "at least", below: /under|younger|less/.test(lower[1]) };
  const after = q.match(/^(\d{1,3})(?: years?(?: of age| old)?)? (?:or|and) (older|over|above|younger)(?: years?(?: of age| old)?)?$/);
  if (after) return { minimum: Number(after[1]), inclusive: true, below: after[2] === "younger" };
}

function binary(value: boolean, field: Field): Answer {
  const word = value ? "Yes" : "No";
  return { value: word, choices: field.options.filter(option => new RegExp(`^${word}\\b`, "i").test(option.trim()) && !/^no selection$/i.test(option.trim())) };
}

export function ageAnswer(field: Field, profile: Profile, now = new Date()): Answer | undefined {
  const test = ageTest(field.label);
  if (!test || test.minimum < 1 || test.minimum > 120) return;
  const age = ageInYears(profile.dateOfBirth, now);
  if (age !== undefined) {
    // Conflicting explicit profile facts need review rather than a guess.
    const saved = profile.age18OrOlder.trim().toLowerCase();
    if ((saved === "yes" && age < 18) || (saved === "no" && age >= 18)) return;
    return binary(test.below ? (test.inclusive ? age <= test.minimum : age < test.minimum) : (test.inclusive ? age >= test.minimum : age > test.minimum), field);
  }
  // A saved 18+ answer is not evidence of being over 21, or strictly over 18.
  if (test.minimum === 18 && ((!test.below && test.inclusive) || (test.below && !test.inclusive))) {
    const own = profile.age18OrOlder || profile.answers.find(a => {
      const other = ageTest(a.question);
      return other?.minimum === test.minimum && other.inclusive === test.inclusive && other.below === test.below;
    })?.answer;
    if (/^(yes|no)$/i.test(own?.trim() || "")) {
      const yes = own!.trim().toLowerCase() === "yes";
      // Only the profile's 18+ flag is inverted for an under-18 question.
      return binary(profile.age18OrOlder && test.below ? !yes : yes, field);
    }
  }
}

function currentRows(profile: Profile, now: Date): Education[] {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return profile.education.filter(row => studying(row, now) === true && (!row.startDate || row.startDate.slice(0, 7) <= month));
}

function educationQuestion(field: Field): "current" | "completed" | "highest" | "level" | "status" | "major" | "school" | "diploma" | "bachelor" | "enrolled" | undefined {
  const q = question(field.question || field.label);
  if (/^(what|which) degree are you currently (pursuing|enrolled in|working toward|working towards)$|^(what is your )?current degree program$|^degree in progress$|^please indicate your degree of study$/.test(q)) return "current";
  if (/^are you currently (pursuing|working toward|working towards|enrolled in) (a |an )?(bachelor s|bachelors|master s|masters|doctorate|doctoral|phd|ph d)( or (bachelor s|bachelors|master s|masters|doctorate|doctoral|phd|ph d))? degree( program)?$/.test(q)) return "enrolled";
  if (/^(what is (the |your )?)?highest (level of )?(education|degree)( you have| that you have)? (completed|earned|achieved|obtained|received)$|^highest degree achieved$/.test(q)) return "completed";
  if (/^(what is (the |your )?)?highest (level of )?(education|degree) (you are pursuing or have completed|completed or in progress|completed or in progress degree)$/.test(q)) return "highest";
  if (/^(education level|level high school college university other)$/.test(q)) return "level";
  if (/^(please choose the appropriate )?degree status$/.test(q)) return "status";
  if (/^what is was your major or field of study$/.test(q)) return "major";
  if (/^(current school or university|name of school|please select your college or university|select a university or college)$/.test(q)) return "school";
  if (/^(do you have|have you (obtained|earned|completed|received)) (a |an |your )?(minimum of )?(a |an )?(high school diploma|secondary school certificate|ged)( or (ged|equivalent|secondary school certificate))?( etc)?$/.test(q) || /^have you obtained a high school diploma secondary school certificate or equivalent ged etc$/.test(q)) return "diploma";
  if (/^(do you have|have you (completed|earned|received|obtained)) (a |your )?bachelor s degree$/.test(q)) return "bachelor";
}

// These questions have a precise profile source or calculation. An absent
// fact is a reason to leave them for the applicant, not to ask AI to guess.
export function profileFactQuestion(field: Field): boolean {
  const q = question(field.label);
  return Boolean(ageTest(field.label) || educationQuestion(field) ||
    /^(what (is|s) )?(your )?(current )?age( range| group| bracket)?$|^how old are you$|^(date of birth|birth date|birthdate|dob)( (mm dd yyyy|dd mm yyyy|yyyy mm dd))?$/.test(q));
}

function degreeAnswer(row: Education | undefined, field: Field): Answer | undefined {
  if (!row?.title) return;
  const level = degreeLevel(row.title);
  if (field.kind === "checkbox" && field.question) {
    const option = normalize(field.label).replace(normalize(field.question), "").trim();
    if (/^i have not yet completed a degree$/.test(option)) return binary(false, field);
    const levels = [
      ...(/\bbachelor/.test(option) ? ["bachelor"] : []),
      ...(/\bmaster/.test(option) ? ["master", "mba"] : []),
      ...(/\bassociate/.test(option) ? ["associate"] : []),
      ...(/\bdoctor|\bph ?d\b/.test(option) ? ["doctorate"] : []),
    ];
    return levels.length && level ? binary(levels.includes(level), field) : undefined;
  }
  const offered = field.options.filter(option => {
    const offeredLevel = degreeLevel(option);
    return level && offeredLevel && (offeredLevel === level ||
      (/\bor higher\b/i.test(option) && levelRank[level] >= levelRank[offeredLevel]) ||
      (/master.*(ph\.?\s?d|doctor)/i.test(option) && (level === "master" || level === "mba")));
  });
  return offered.length === 1 ? { value: offered[0] } : { value: row.title, choices: degreeAliases(row.title) };
}

// An explicitly listed skill can answer an "at least one" language question.
// It does not establish years, professional experience, or an unlisted skill.
function programmingAnswer(field: Field, profile: Profile): Answer | undefined {
  const raw = field.label.split("?")[0];
  const match = raw.match(/^\s*Do you have experience (?:with|using) at least one (?:general[ -]purpose )?(?:programming )?language(?:s)?(?:\s*,?\s*(?:such as|e\.g\.?))?\s*[:,(]?\s*(.+?)\)?\s*$/i);
  if (!match) return;
  const names = ["JavaScript", "TypeScript", "PowerShell", "Python", "C++", "C#", "Java", "Ruby", "Rust", "Go", "C"];
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found: string[] = [];
  let rest = match[1];
  for (const name of names) {
    const pattern = new RegExp(`(?<![a-z0-9+#])${escape(name)}(?![a-z0-9+#])`, "gi");
    if (pattern.test(rest)) found.push(name.toLowerCase());
    rest = rest.replace(pattern, " ");
  }
  if (rest.replace(/\b(or|and|etc)\b/gi, "").replace(/[^a-z0-9]/gi, "")) return;
  return profile.skills.some(skill => found.includes(skill.trim().toLowerCase())) ? binary(true, field) : undefined;
}

export function profileFactAnswer(field: Field, profile: Profile, now = new Date()): Answer | undefined {
  const q = question(field.label);
  if (ageTest(field.label)) return ageAnswer(field, profile, now);
  if (/^(what (is|s) )?(your )?(current )?age( range| group| bracket)?$|^how old are you$/.test(q)) {
    const age = ageInYears(profile.dateOfBirth, now);
    return age === undefined ? undefined : { value: String(age), numeric: age };
  }
  if (/^(date of birth|birth date|birthdate|dob)( (mm dd yyyy|dd mm yyyy|yyyy mm dd))?$/.test(q)) {
    if (ageInYears(profile.dateOfBirth, now) === undefined) return;
    const value = writtenDate(profile.dateOfBirth, field, profile);
    return value ? { value } : undefined;
  }
  const type = educationQuestion(field);
  if (type) {
    const completed = profile.education.filter(row => graduated(row, now) === true);
    const current = currentRows(profile, now);
    const inRow = /education|academic|school/i.test(field.section || "") && (field.section || "").length < 80 && (field.section || "") !== field.label;
    const row = inRow ? profile.education[field.index || 0] : highestRow([...current, ...completed]);
    if (type === "current") return degreeAnswer(highestRow(current), field);
    if (type === "enrolled") {
      const named = question(field.label);
      const levels = [
        ...(/\bbachelor/.test(named) ? ["bachelor"] : []),
        ...(/\bmaster/.test(named) ? ["master", "mba"] : []),
        ...(/\bdoctor|\bph ?d\b/.test(named) ? ["doctorate"] : []),
      ];
      const known = current.map(row => degreeLevel(row.title));
      return known.length && known.every(Boolean) ? binary(known.some(level => levels.includes(level)), field) : undefined;
    }
    if (type === "completed") return degreeAnswer(highestRow(completed), field);
    if (type === "highest" || type === "level") {
      if (type === "level" && /high school college university other/.test(q)) {
        if (!row) return;
        if (/\b(high school|secondary school)\b/i.test(`${row.title} ${row.organization}`)) return { value: "High School" };
        if (/\buniversity\b/i.test(row.organization)) return { value: "University", choices: ["College / University"] };
        if (/\bcollege\b/i.test(row.organization)) return { value: "College", choices: ["College / University"] };
        return;
      }
      return degreeAnswer(row, field);
    }
    if (type === "major") return row?.fieldOfStudy ? { value: row.fieldOfStudy } : undefined;
    if (type === "school") {
      const school = latestRow(current) || latestRow(completed);
      return school?.organization ? { value: school.organization, choices: schoolNames(school.organization) } : undefined;
    }
    if (type === "status") {
      if (!row) return;
      if (studying(row, now) === true) return { value: "In Progress", choices: ["Currently enrolled", "Currently attending", "Still studying", "Pursuing", "Ongoing"] };
      if (graduated(row, now) === true) return { value: "Completed", choices: ["Graduated", "Awarded", "Degree received"] };
      return;
    }
    if (type === "diploma") return completed.some(row => degreeLevel(row.title) || /high school|secondary school|ged/i.test(row.title)) ? binary(true, field) : undefined;
    if (type === "bachelor") {
      if (completed.some(row => degreeLevel(row.title) === "bachelor")) return binary(true, field);
      if (current.some(row => degreeLevel(row.title) === "bachelor")) return binary(false, field);
    }
    return;
  }
  if (/^preferred( first)? name(?: what would you like us to call you)?$/.test(q))
    return { value: profile.preferredName || profile.firstName };
  if (/^(phone device type|contact phone type)$/.test(q) && profile.phoneDeviceType)
    return { value: profile.phoneDeviceType, choices: /mobile|cell/i.test(profile.phoneDeviceType) ? ["Mobile", "Cellular", "Cell Phone"] : undefined };
  if (/^(skills|technical skills)$/.test(q) && /^(text|textarea)$/.test(field.kind) && !field.options.length && profile.skills.length)
    return { value: profile.skills.join(", ") };
  const programming = programmingAnswer(field, profile);
  if (programming) return programming;
  if (/^how many years of (total |overall )?(work |professional )?experience do you have$/.test(q) && profile.yearsExperience !== undefined)
    return { value: String(profile.yearsExperience), numeric: profile.yearsExperience, choices: profile.yearsExperience === 0 ? ["None", "Zero"] : undefined };
  if (/^(address( line)? 2|apartment suite unit)$/.test(q) && !/work|employ|education|school/i.test(field.section || "") && profile.addressLine2)
    return { value: profile.addressLine2 };
}

export function missingOptionalProfileField(field: Field): boolean {
  if (field.required) return false;
  const q = question(field.label);
  return /^(address( line)? [23]|phone extension|alternate phone( number)?|secondary phone( number)?|suffix|prefix|i have a preferred name)$/.test(q);
}
