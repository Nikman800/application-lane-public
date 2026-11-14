// Answer-bank choices. Stored as a fixed vocabulary (not free text) so one
// answer can be translated to each portal's own option wording.

export const answerChoices = {
  workAuthorization: ["Yes", "No"],
  sponsorship: ["Yes", "No"],
  age18OrOlder: ["Yes", "No"],
  willingToRelocate: ["Yes", "No"],
  priorEmployment: ["Yes", "No"],
  hispanic: ["Yes", "No", "Decline"],
  disabilityStatus: ["Yes", "No", "Decline"],
  veteranStatus: ["Yes", "No", "Decline"],
  gender: ["Male", "Female", "Non-binary", "Decline"],
  transgender: ["Yes", "No", "Decline"],
  ethnicity: [
    "African American",
    "East Asian",
    "South Asian",
    "Southeast Asian",
    "Hispanic/Latinx",
    "Middle Eastern",
    "Native American",
    "Pacific Islander",
    "White",
    "Two or More",
    "Decline",
  ],
  pronouns: ["He/Him", "She/Her", "They/Them", "He/They", "She/They", "Other", "Decline"],
  sexualOrientation: [
    "Straight",
    "Gay",
    "Lesbian",
    "Bisexual",
    "Queer",
    "Asexual",
    "Other",
    "Decline",
  ],
} as const;

// These recorded sentences assert more than a binary answer. Exact saved
// statements or explicitly confirmed choices can select them; a bare prefix
// cannot, including when a remote menu exposes its options only after opening.
export const qualifiedBinarySentences = {
  workAuthorization: [
    "Yes - I have US work authorization as a Citizen or US Permanent Resident / Green Card Holder",
    "Yes - I have US work authorization via a non-immigrant visa (e.g. F-1, H-1B, L-1, TN)",
  ],
  sponsorship: [
    "No, I do not require sponsorship now or in the future",
    "No, I do not require sponsorship now, but may require it in the future",
    "Yes, I currently hold a visa status that would require a transfer to a new employer",
    "Yes, I would require new sponsorship",
  ],
} as const;

export type ChoiceField = keyof typeof answerChoices;

// How each choice reads in the panel.
export const choiceLabels: Partial<Record<ChoiceField, Record<string, string>>> = {
  veteranStatus: { Yes: "I am a protected veteran", No: "I am not a protected veteran", Decline: "Decline to answer" },
  disabilityStatus: { Yes: "Yes, I have a disability", No: "No, I do not have a disability", Decline: "Decline to answer" },
  hispanic: { Decline: "Decline to answer" },
  gender: { Decline: "Decline to answer" },
  transgender: { Decline: "Decline to answer" },
  ethnicity: { Decline: "Decline to answer" },
  pronouns: { Other: "Not listed", Decline: "Decline to answer" },
  sexualOrientation: {
    Straight: "Straight / heterosexual",
    Other: "Not listed",
    Decline: "Decline to answer",
  },
};

// Other ways portals word each choice. Matching is on normalized text, so
// punctuation and case differences ("He/Him/His", "Bi-Sexual") need no entry.
export const choiceSynonyms: Record<string, string[]> = {
  "He/Him": ["He/Him/His"],
  "She/Her": ["She/Her/Hers"],
  "They/Them": ["They/Them/Theirs"],
  Straight: ["Heterosexual", "Straight/Heterosexual", "Heterosexual or straight"],
  Gay: ["Gay or lesbian"],
  Lesbian: ["Gay or lesbian"],
  Bisexual: ["Bi-Sexual", "Bi"],
  Other: [
    "Not listed",
    "I identify as an orientation not listed",
    "I use a pronoun not listed",
    "Self-describe",
  ],
};

// How well one option's text answers a proposal. Lower is better; undefined
// means it does not answer it. Exact wording always beats a rule-based match.
const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const seasonRank: Record<string, number> = { spring: 0, summer: 1, fall: 2, autumn: 2 };
// A month's academic term: the year's index times three plus its season's.
function termOf(value: string): number | undefined {
  const dated = value.trim().toLowerCase().match(/^([a-z]+)\.?\s+(\d{4})$/);
  if (!dated) return undefined;
  const month = months.findIndex((name) => name === dated[1] || (dated[1].length >= 3 && name.startsWith(dated[1])));
  if (month < 0) return undefined;
  return Number(dated[2]) * 3 + (month <= 4 ? 0 : month <= 7 ? 1 : 2);
}
function seasonOption(value: string, optionText: string): number | undefined {
  const term = termOf(value);
  if (term === undefined) return undefined;
  const option = optionText.trim().toLowerCase().match(/^(?:(earlier than|before|later than|after)\s+)?(spring|summer|fall|autumn)\s+(\d{4})$/);
  if (!option) return undefined;
  const asked = Number(option[3]) * 3 + seasonRank[option[2]];
  if (!option[1]) return asked === term ? 46 : undefined;
  return /^(earlier|before)/.test(option[1]) ? (term < asked ? 47 : undefined) : term > asked ? 47 : undefined;
}

export function rankOption(
  proposal: { value: string; choices?: string[]; decline?: boolean; numeric?: number; scale?: number },
  optionText: string,
): number | undefined {
  const text = norm(optionText);
  if (!text) return;
  // Literal text first: normalizing drops punctuation, so "3+" reads as "3".
  if (optionText.trim().toLowerCase() === proposal.value.trim().toLowerCase())
    return 0;
  if (text === norm(proposal.value)) return 0.5;
  const choice = (proposal.choices || []).findIndex((c) => norm(c) === text);
  if (choice >= 0) return 1 + choice;
  // A street search's listing is the whole address ("323 EAST VETERANS WAY,
  // TEMPE, ARIZONA"), with directions and suffixes spelled out (Oracle's
  // Address Line 1). The saved street with its city (and state,
  // ZIP) says which; the street alone is the listing when only one fits.
  if (/^\d/.test(optionText.trim()) && optionText.includes(",")) {
    const listed = streetKey(optionText);
    const choiceAt = (proposal.choices || []).findIndex((c) => streetKey(c) === listed);
    if (choiceAt >= 0) return 20 + choiceAt / 100;
    const street = optionText.split(",")[0];
    if (/^\d/.test(proposal.value.trim()) && streetKey(street) === streetKey(proposal.value)) return 48;
  }
  // A list that prefixes or suffixes its own short code: "CS - Computer
  // Science", "Computer Science (CS)", "Master of Science (M.S)" (one employer's
  // Workday). The rest must be the whole answer.
  // Likewise a phone-country list, which appends each dial code:
  // "United States +1".
  const coded =
    optionText.match(/^\s*[A-Z][A-Z&/]{1,7}\s*[-–—:]\s+(.+)$/)?.[1] ??
    optionText.match(/^(.+?)\s*\([A-Z][A-Z&/.]{1,7}\)\s*$/)?.[1] ??
    optionText.match(/^(.+?)\s*\(?\+\d{1,4}\)?\s*$/)?.[1] ??
    // Or one that puts the dial code first: "+1 (United States)" (Oracle's).
    optionText.match(/^\s*\+\d{1,4}\s*\((.+)\)\s*$/)?.[1];
  if (coded && norm(coded) === norm(proposal.value)) return 40;
  // Or one of the answer's other names: "United States +1" for the
  // profile's "United States of America".
  const codedChoice = coded ? (proposal.choices || []).findIndex((c) => norm(c) === norm(coded)) : -1;
  if (codedChoice >= 0) return 41 + codedChoice / 100;
  // Or one explained in brackets after it: "Masters (±18 years of
  // education)" (one employer's Workday), "Asian (United States of
  // America)". The rest must be the whole answer, or one of its names.
  const explained = optionText.match(/^(.+?)\s*\([^()]*\)\s*$/)?.[1];
  if (explained && norm(explained) === norm(proposal.value)) return 42;
  const explainedChoice = explained ? (proposal.choices || []).findIndex((c) => norm(c) === norm(explained)) : -1;
  if (explainedChoice >= 0) return 43 + explainedChoice / 100;
  // A degree named with "Degree" after it: one employer's Workday lists "Master
  // of Science Degree" for the profile's "Master of Science".
  const named = optionText.match(/^(.+?)\s+degree(?:\s+or\s+equivalent)?\s*$/i)?.[1];
  if (named) {
    const at = [proposal.value, ...(proposal.choices || [])].findIndex((wording) => norm(wording) === norm(named));
    if (at >= 0) return 44.5 + at / 100;
  }
  // A degree listed only by its level: one employer's "Master's Level Degree" and
  // "Bachelor's Level Degree".
  // Or by the bare level: one employer's "What is your Current Degree Program?"
  // lists Associates, Bachelors, Masters and Ph.D., and "M.S. Data Science,
  // Analytics & Engineering" matched none.
  const levelOnly = (
    norm(optionText).match(/\b(associate|bachelor|master|doctor(?:ate)?)(?: s|s)? level degree$/)?.[1] ||
    norm(optionText).match(/^(associate|bachelor|master|doctor(?:ate)?)(?: s|s)?( degree)?$/)?.[1] ||
    (/^(ph ?d|doctorate)$/.test(norm(optionText)) ? "doctor" : undefined) ||
    // Or by its level with examples after it: Oracle's "Graduate Master's
    // Degrees (e.g., Master of Arts, …)" and "Undergraduate Bachelor's
    // Degrees (e.g., …)" (hdde's education form).
    norm(optionText.replace(/\s*\(\s*e\.?\s*g\.?[^()]*\)\s*$/i, ""))
      .match(/^(?:graduate|undergraduate) (associate|bachelor|master|doctor)(?:al)?(?: s|s)? degrees?$/)?.[1]
  )?.replace(/ate$/, "");
  if (levelOnly) {
    const level = (wording: string) =>
      norm(wording).match(/\b(associate|bachelor|master|doctor)/)?.[1] ||
      (/^(b s|b a|bsc|bs|ba)\b/.test(norm(wording)) ? "bachelor"
        : /^(m s|m a|msc|ms|ma|mba)\b/.test(norm(wording)) ? "master"
        : /^(ph d|phd)\b/.test(norm(wording)) ? "doctor" : undefined);
    const at = [proposal.value, ...(proposal.choices || [])].findIndex((wording) => level(wording) === levelOnly);
    if (at >= 0) return 44.7 + at / 100;
  }
  // A degree listed with the subjects it covers: "Masters of Arts or Science
  // or Business Administration (Masters)" is a Master of Science (one employer's
  // Workday). Same level, and the answer's subject is one named.
  const listed = degreeSubjects(optionText);
  if (listed) {
    const wanted = [proposal.value, ...(proposal.choices || [])]
      .map((wording) => degreeSubjects(wording))
      .find((degree) => degree && degree.level === listed.level && degree.subjects.length === 1);
    if (wanted && listed.subjects.length > 1 && listed.subjects.includes(wanted.subjects[0])) return 44;
  }
  // A plain Yes or No also answers a list that words it as a sentence
  // ("Yes, I am authorized to work…"). Two options beginning the same way
  // tie, and a tie is never chosen.
  if (/^(yes|no)$/i.test(proposal.value.trim()) &&
      !Object.values(qualifiedBinarySentences).some(sentences => sentences.some(sentence => norm(sentence) === text)) &&
      new RegExp(`^${proposal.value.trim()}\\b`, "i").test(optionText.trim())) return 45;
  if (proposal.decline && declines.test(text)) return 50;
  // A date as a list's academic season (one employer's "Spring 2027" for a May
  // 2027 graduation): January to May is spring, June to August
  // summer, September to December fall; "Earlier than Fall 2026" and "Later
  // than Summer 2027" by the same reckoning.
  const seasonal = seasonOption(proposal.value, optionText);
  if (seasonal !== undefined) return seasonal;
  // A salary as a list's range (Oracle's Desired Salary Range):
  // "$90,000 - $110,000", "$100K to $120K", "$150,000+", "Under $80,000".
  const written = proposal.value.trim().match(/^\$\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?$/i);
  const money = written ? Number(written[1].replace(/,/g, "")) * (written[2] ? 1000 : 1) : proposal.numeric !== undefined && optionText.includes("$") ? proposal.numeric : undefined;
  if (money !== undefined) {
    const amount = money;
    const sums = [...optionText.matchAll(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?/gi)].map((found) => Number(found[1].replace(/,/g, "")) * (found[2] ? 1000 : 1));
    const ranged = sums.length === 2 && /\$[^$]*?\s*(?:-|–|—|to)\s*\$/i.test(optionText);
    if (ranged && amount >= sums[0] && amount < sums[1]) return 60;
    if (ranged && amount === sums[1]) return 60.5;
    if (sums.length === 1 && /^\s*\$[^$]*(?:\+|or (?:more|above|higher|over))\s*$/i.test(optionText) && amount >= sums[0]) return 61;
    if (sums.length === 1 && /^\s*(?:below|under|less than|up to)\s*\$/i.test(optionText) && amount < sums[0]) return 61;
  }
  // A band with figures past the scale the number is on is another scale's:
  // "Below 50" and "70 - 79" are never a 3.84 on four points.
  const pastScale = proposal.scale !== undefined && (optionText.replace(/\s*\(\s*out of \d+(?:\.0+)?\s*\)\s*$/i, "").match(/\d+(?:\.\d+)?/g) || []).some((figure) => Number(figure) > proposal.scale! + 1e-9);
  if (proposal.numeric !== undefined && !pastScale) {
    const n = proposal.numeric;
    // A note of the scale after it, "3.6 or above (out of 4.0)": a GPA is
    // answered on 4 (matching.ts), so only that scale's note is set aside.
    optionText = optionText.replace(/\s*\(\s*out of 4(?:\.0+)?\s*\)\s*$/i, "");
    // With its unit after it or not: one employer's "1–2 years", "Less than 1
    // year" and "5+ years" read as no option for 1.
    const unit = "(?:\\s*(?:years?|yrs?|months?|hours?|hrs?)(?:\\s+of\\s+experience)?)?";
    const range = optionText.match(new RegExp(`^\\s*(\\d+(?:\\.\\d+)?)\\s*(?:-|–|—|to)\\s*(\\d+(?:\\.\\d+)?)${unit}\\s*$`, "i"));
    // From its start, short of its end: two years is "2 - 3", not also
    // "1 - 2" (a tie, and no choice, on one employer's list). A value
    // at a list's top ("4.0" in "3.5-4.0") still falls in, scored lower.
    if (range && n >= Number(range[1]) && n < Number(range[2])) return 60;
    if (range && n >= Number(range[1]) && n <= Number(range[2]) + 0.005) return 59.5;
    const below = optionText.match(new RegExp(`^\\s*(?:below|under|less than|fewer than)\\s*(\\d+(?:\\.\\d+)?)${unit}\\s*$`, "i"));
    if (below && n < Number(below[1])) return 61;
    const above = optionText.match(new RegExp(`^\\s*(\\d+(?:\\.\\d+)?)\\s*(?:\\+|or (?:above|higher|more|greater|older|over))${unit}\\s*(?:or (?:more|above))?\\s*$`, "i"));
    if (above && n >= Number(above[1])) return 61;
    // "2.4 or below" (one employer's GPA list).
    const atMost = optionText.match(new RegExp(`^\\s*(\\d+(?:\\.\\d+)?)\\s*or (?:below|less|lower|under|fewer)${unit}\\s*$`, "i"));
    if (atMost && n <= Number(atMost[1])) return 61;
    // A list of single values in tenths ("4.0", "3.9", … "3.0 or under",
    // one employer's Lever GPA list): 3.84 is "3.8", the value
    // it does not fall short of; never rounded up to one it hasn't reached.
    const step = optionText.match(/^\s*(\d+)\.(\d+)\s*$/);
    if (step && n !== Number(optionText)) {
      const at = Number(optionText);
      if (n > at && n < at + 10 ** -step[2].length - 1e-9) return 62;
    }
  }
  return;
}

// The single best option, or an error when two options tie for best.
export function pickOption<T>(
  proposal: Parameters<typeof rankOption>[0],
  options: T[],
  text: (option: T) => string,
): T | undefined {
  let best: T | undefined;
  let bestRank = Infinity;
  let tied: T[] = [];
  for (const option of options) {
    const rank = rankOption(proposal, text(option));
    if (rank === undefined) continue;
    if (rank < bestRank) [best, bestRank, tied] = [option, rank, [option]];
    else if (rank === bestRank) tied.push(option);
  }
  if (tied.length > 1) {
    // The same name written twice, differing only in punctuation ("Pennsylvania
    // State University - University Park" and the same with a
    // long dash; a Greenhouse school list), is one answer: the
    // one written as the answer is, else the first. Different names tie, and
    // so do options written exactly alike: nothing on the page tells them
    // apart, so they may be two different things.
    const written = tied.map((option) => text(option).trim());
    if (
      !tied.every((option) => norm(text(option)) === norm(text(tied[0]))) ||
      new Set(written).size !== written.length
    )
      throw new Error(`Dropdown has duplicate matching options (${tied.slice(0, 4).map((option) => text(option).trim().slice(0, 40)).join(" | ")}); choose manually.`);
    const wordings = [proposal.value, ...(proposal.choices || [])].map((wording) => wording.trim().toLowerCase());
    return tied.find((option) => wordings.includes(text(option).trim().toLowerCase())) || tied[0];
  }
  return best;
}

// "Master's of Arts or Science (Masters)": the level and each subject.
function degreeSubjects(text: string): { level: string; subjects: string[] } | undefined {
  const match = norm(text.replace(/\([^()]*\)\s*$/, "")).match(/^(?:[a-z]{1,4} )*?(associate|bachelor|master|doctor)(?: s|s)? (?:degree )?(?:of|in) (.+)$/);
  if (!match) return;
  return { level: match[1], subjects: match[2].split(/ or | and /).map((subject) => subject.trim()).filter(Boolean) };
}

// A street address with its directions and suffixes spelled out, to be
// compared as written differently: "323 E. Veterans Way" and "323 EAST
// VETERANS WAY" are one street.
const streetWords: Record<string, string> = {
  n: "north", s: "south", e: "east", w: "west", ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
  st: "street", ave: "avenue", av: "avenue", blvd: "boulevard", dr: "drive", rd: "road", ln: "lane", ct: "court",
  pl: "place", cir: "circle", pkwy: "parkway", hwy: "highway", ter: "terrace", trl: "trail", sq: "square",
};
function streetKey(text: string): string {
  return norm(text).split(" ").map((word) => streetWords[word] || word).join(" ");
}

// As model.ts normalizes (not imported: model.ts reads this file).
const norm = (value: string) =>
  value
    // Punctuation a page without a charset shows as "â€" and a byte or two
    // ("self‐identify" read as "selfâ€identify") is punctuation still.
    .replace(/â€[\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u02c6\u02dc\u2013-\u203a\u20ac\u2122]?/g, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();

const declines = /\b(decline|prefer not|not disclosed|don t wish|do not wish|dont wish|choose not|not to (say|answer|disclose|identify)|no answer|rather not|self identify|(do not|don t|dont) want to (answer|say|disclose|identify))\b/;

// Words a decline option may repeat from its question without saying
// anything else ("I decline to self-identify for protected veteran status").
const questionWords = new Set(
  "i to for or and the a my of this be not do don t dont wish want prefer rather say answer answers disclose identify self describe choose provide information voluntary question protected veteran status gender race ethnic ethnicity ethnicities origin disability hispanic latino latina latinx".split(" "),
);

// An option read as a choice for this field. A decline option that also
// states something else ("Other ethnic group (Prefer not to say)") is no
// decline, and reads as nothing: choosing it would claim a group.
export function readOption(field: ChoiceField, option: string): string {
  const answer = canonicalAnswer(field, option);
  if (answer !== "Decline") return answer;
  const said = norm(option)
    .replace(new RegExp(declines.source, "g"), " ")
    .split(" ")
    .filter((word) => word && !questionWords.has(word));
  return said.length ? "" : answer;
}

// Normalizes an existing (possibly hand-typed) answer to a choice. Unknown
// text is returned trimmed so nothing the user wrote is silently discarded.
export function canonicalAnswer(field: ChoiceField, raw: string | undefined): string {
  const value = (raw || "").trim();
  if (!value) return "";
  const text = norm(value);
  const choices: readonly string[] = answerChoices[field];
  const direct = choices.find((choice) => norm(choice) === text);
  if (direct) return direct;
  if (declines.test(text) && choices.includes("Decline")) return "Decline";
  if (field === "gender") {
    if (/\b(non ?binary|nonbinary|genderqueer|they them)\b/.test(text)) return "Non-binary";
    if (/\b(female|woman|she her)\b/.test(text)) return "Female";
    if (/\b(male|man|he him)\b/.test(text)) return "Male";
    return value;
  }
  if (field === "pronouns") {
    const table: [RegExp, string][] = [
      [/^he (him )?(his )?they\b|^he they$/, "He/They"],
      [/^she (her )?(hers )?they\b|^she they$/, "She/They"],
      [/^he\b/, "He/Him"],
      [/^she\b/, "She/Her"],
      [/^they\b/, "They/Them"],
    ];
    return table.find(([pattern]) => pattern.test(text))?.[1] || value;
  }
  if (field === "sexualOrientation") {
    const table: [RegExp, string][] = [
      [/\b(straight|heterosexual)\b/, "Straight"],
      [/\bbi ?sexual\b|^bi$/, "Bisexual"],
      [/\blesbian\b/, "Lesbian"],
      [/\bgay\b/, "Gay"],
      [/\bqueer\b/, "Queer"],
      [/\basexual\b/, "Asexual"],
    ];
    return table.find(([pattern]) => pattern.test(text))?.[1] || value;
  }
  if (field === "ethnicity") {
    const table: [RegExp, string][] = [
      [/\b(two or more|multiple|multiracial|mixed)\b/, "Two or More"],
      [/\b(hispanic|latino|latina|latinx)\b/, "Hispanic/Latinx"],
      [/\b(black|african)\b/, "African American"],
      // Before South Asian's "indian": "American Indian or Alaska Native".
      [/\b(native american|alaska|american indian)\b/, "Native American"],
      [/\b(southeast asian|filipino|vietnamese|thai)\b/, "Southeast Asian"],
      [/\b(south asian|indian|pakistani|bangladeshi)\b/, "South Asian"],
      [/\b(east asian|asian|chinese|japanese|korean)\b/, "East Asian"],
      [/\b(middle eastern|arab)\b/, "Middle Eastern"],
      [/\b(pacific islander|native hawaiian)\b/, "Pacific Islander"],
      [/\b(white|caucasian)\b/, "White"],
    ];
    return table.find(([pattern]) => pattern.test(text))?.[1] || value;
  }
  // Citizenship and residency answers mean "authorized, no sponsorship needed".
  if (field === "workAuthorization" && /\b(citizen|permanent resident|green card|lawful permanent|national)\b/.test(text))
    return "Yes";
  if (field === "sponsorship" && /\b(citizen|permanent resident|green card|lawful permanent)\b/.test(text))
    return "No";
  // "I have no military experience" is not a veteran; read by its "I have",
  // it was taken as one (one employer's Workday).
  if (field === "veteranStatus" && /\b(no (prior )?military|never served|not a veteran|have not served|no service)\b/.test(text)) return "No";
  // Yes/No families, checked after declines so "I do not wish…" is Decline.
  if (/^(no|n|false|none|never)\b|\b(not|do not|don t|dont|am not|have not|i m not)\b/.test(text)) return "No";
  if (/^(yes|y|true)\b|\b(i am|i have|i identify|authorized|eligible)\b/.test(text)) return "Yes";
  return value;
}

// Why a required question was left empty is said in its own line ("Left
// "…" for you: …"), under a shortened label. The two are shown as one, so
// the reason is read with the question it is about.
export function leftReasons(items: string[]) {
  const reasons = new Map<string, string>();
  const used = new Set<string>();
  const left = items.flatMap((item) => {
    const at = item.startsWith('Left "') ? item.lastIndexOf('" for you: ') : -1;
    return at < 0 ? [] : [{ item, label: item.slice(6, at).replace(/…$/u, "").trim(), reason: item.slice(at + 11) }];
  });
  for (const item of items) {
    if (!item.startsWith("Required: ")) continue;
    const question = item.slice(10);
    const match = left.find((entry) => entry.label && !used.has(entry.item) && (question.startsWith(entry.label) || entry.label.startsWith(question)));
    if (!match) continue;
    used.add(match.item);
    reasons.set(item, match.reason);
  }
  return { reasons, used };
}
