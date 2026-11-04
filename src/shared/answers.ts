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
export function rankOption(
  proposal: { value: string; choices?: string[]; decline?: boolean; numeric?: number },
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
  // A list that prefixes or suffixes its own short code: "CS - Computer
  // Science", "Computer Science (CS)", "Master of Science (M.S)" (WEX's
  // Workday, report 6a57344f). The rest must be the whole answer.
  // Likewise a phone-country list, which appends each dial code:
  // "United States +1".
  const coded =
    optionText.match(/^\s*[A-Z][A-Z&/]{1,7}\s*[-–—:]\s+(.+)$/)?.[1] ??
    optionText.match(/^(.+?)\s*\([A-Z][A-Z&/.]{1,7}\)\s*$/)?.[1] ??
    optionText.match(/^(.+?)\s*\(?\+\d{1,4}\)?\s*$/)?.[1];
  if (coded && norm(coded) === norm(proposal.value)) return 40;
  // Or one of the answer's other names: "United States +1" for the
  // profile's "United States of America".
  const codedChoice = coded ? (proposal.choices || []).findIndex((c) => norm(c) === norm(coded)) : -1;
  if (codedChoice >= 0) return 41 + codedChoice / 100;
  // Or one explained in brackets after it: "Masters (±18 years of
  // education)" (HPE's Workday, report 451b9877), "Asian (United States of
  // America)" (TSC's). The rest must be the whole answer, or one of its names.
  const explained = optionText.match(/^(.+?)\s*\([^()]*\)\s*$/)?.[1];
  if (explained && norm(explained) === norm(proposal.value)) return 42;
  const explainedChoice = explained ? (proposal.choices || []).findIndex((c) => norm(c) === norm(explained)) : -1;
  if (explainedChoice >= 0) return 43 + explainedChoice / 100;
  // A degree named with "Degree" after it: Argonne's Workday lists "Master
  // of Science Degree" for the profile's "Master of Science" (report
  // 2845e1d5, 2026-11-02).
  const named = optionText.match(/^(.+?)\s+degree(?:\s+or\s+equivalent)?\s*$/i)?.[1];
  if (named) {
    const at = [proposal.value, ...(proposal.choices || [])].findIndex((wording) => norm(wording) === norm(named));
    if (at >= 0) return 44.5 + at / 100;
  }
  // A degree listed only by its level: Micron's "Master's Level Degree" and
  // "Bachelor's Level Degree" (report 88608f31, 2026-11-02).
  // Or by the bare level: RTX's "What is your Current Degree Program?"
  // lists Associates, Bachelors, Masters and Ph.D., and "M.S. Data Science,
  // Analytics & Engineering" matched none (report 273de71c, 2026-11-02).
  const levelOnly = (
    norm(optionText).match(/\b(associate|bachelor|master|doctor(?:ate)?)(?: s|s)? level degree$/)?.[1] ||
    norm(optionText).match(/^(associate|bachelor|master|doctor(?:ate)?)(?: s|s)?( degree)?$/)?.[1] ||
    (/^(ph ?d|doctorate)$/.test(norm(optionText)) ? "doctor" : undefined)
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
  // or Business Administration (Masters)" is a Master of Science (KLA's
  // Workday, 2026-11-02). Same level, and the answer's subject is one named.
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
  if (proposal.numeric !== undefined) {
    const n = proposal.numeric;
    const range = optionText.match(/^\s*(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*$/i);
    if (range && n >= Number(range[1]) && n <= Number(range[2]) + 0.005) return 60;
    const below = optionText.match(/^\s*(?:below|under|less than)\s*(\d+(?:\.\d+)?)\s*$/i);
    if (below && n < Number(below[1])) return 61;
    const above = optionText.match(/^\s*(\d+(?:\.\d+)?)\s*(?:\+|or (?:above|higher|more|greater|older|over))\s*$/i);
    if (above && n >= Number(above[1])) return 61;
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
    // long dash; a Greenhouse school list, 2026-10-13), is one answer: the
    // one written as the answer is, else the first. Different names tie, and
    // so do options written exactly alike: nothing on the page tells them
    // apart, so they may be two different things.
    const written = tied.map((option) => text(option).trim());
    if (
      !tied.every((option) => norm(text(option)) === norm(text(tied[0]))) ||
      new Set(written).size !== written.length
    )
      throw new Error("Dropdown has duplicate matching options; choose manually.");
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
