import type { Profile } from "../shared/model";

type Fact = Profile["facts"][number];
export type ImportReport = {
  name: string;
  added: number;
  duplicates: number;
  error?: string;
};
export type ProfileEditorState = { profile: Profile; imports: ImportReport[] };
type ProfileAction =
  | { type: "edit"; update: Profile | ((profile: Profile) => Profile) }
  | { type: "start-import" }
  | { type: "import"; name: string; facts: Fact[]; error?: string };

// Keep punctuation, case and quantities significant. For example, C, C++, C#,
// $5M and $5K are different facts; near-duplicates need the user's review.
const clean = (text: string) =>
  text
    .normalize("NFC")
    .trim()
    .replace(/^[•●▪◦]\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();

// A PDF carries one newline per rendered line, so splitting on newlines stored
// wrapped sentences as separate facts ("…full-stack web development. Built a
// hybrid") and kept the contact block and section headings as facts of their
// own. Every draft then quoted fragments. Lines are now joined back into whole
// bullets, and the résumé's furniture is left out.
const bullet = /^[-•●▪◦*‣·]\s+/u;
const heading =
  /^(summary|objective|profile|about|education|experience|work experience|professional experience|employment|employment history|projects?|selected projects?|technical skills|skills|technologies|certifications?|awards?|honors?|publications?|activities|leadership|interests|references|coursework|languages)\s*:?$/iu;
const terminal = /[.!?][")'\]]?$/u;
// The start of a new résumé entry rather than the rest of the line above it:
// a date or date range, or a short label such as "Tech:" or "Languages:".
const entry =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b|\b(?:19|20)\d{2}\s*[–—-]\s*(?:present|current|\d{4})\b|^\p{L}[\p{L} /&+.-]{0,24}:/iu;
// Long enough to be a claim on its own; past this a fact stops absorbing.
const factLimit = 400;

// The name and section headings: a few capitalised words, no digits, no
// sentence punctuation. These describe the document, not the applicant.
const label = (text: string) =>
  heading.test(text) ||
  (/^[\p{Lu}][\p{L}'’.-]*(\s+[\p{Lu}&][\p{L}'’.-]*){0,3}$/u.test(text) &&
    !/\d/u.test(text));

// A line that is only contact details, such as "Tucson, AZ | me@example.com |
// 623-555-0101". It must carry a contact token and little else: a technology
// line that happens to name a repository is content, not a contact block.
const contactToken =
  /[\w.+-]+@[\w.-]+\.\w{2,}|\bhttps?:\/\/|\b(?:www\.)?[\w-]+\.(?:com|io|dev|org|net|ai|me|co|edu)\b|\+?\d[\d ().-]{7,}\d/iu;
const contact = (text: string) => {
  if (!contactToken.test(text)) return false;
  const remainder = text
    .replace(/[\w.+-]+@[\w.-]+\.\w{2,}/gu, " ")
    .replace(/\bhttps?:\/\/\S+/giu, " ")
    .replace(
      /\b(?:www\.)?[\w-]+\.(?:com|io|dev|org|net|ai|me|co|edu)\b\S*/giu,
      " ",
    )
    .replace(/\+?\d[\d ().-]{7,}\d/gu, " ")
    .replace(/[|,·•\-–—/]/gu, " ");
  return remainder.split(/\s+/u).filter(Boolean).length <= 3;
};

export function resumeFacts(text: string): Fact[] {
  const facts: string[] = [];
  let pending = "";
  const flush = () => {
    const text = clean(pending);
    if (text) facts.push(text);
    pending = "";
  };
  for (const raw of text.split(/\r?\n/u)) {
    const line = clean(raw);
    // A blank line, a heading or the contact block ends whatever came before.
    if (!line || label(line) || contact(line)) {
      flush();
      continue;
    }
    if (
      pending &&
      pending.length < factLimit &&
      !bullet.test(line) &&
      !entry.test(line) &&
      !terminal.test(pending)
    ) {
      pending = `${pending} ${line}`;
      continue;
    }
    flush();
    pending = line;
  }
  flush();
  return facts.map((text) => ({ id: crypto.randomUUID(), text }));
}

export function mergeResumeFacts(existing: Fact[], incoming: Fact[]) {
  const seen = new Set(existing.map((f) => clean(f.text)).filter(Boolean));
  const additions: Fact[] = [];
  let duplicates = 0;
  for (const fact of incoming) {
    const text = clean(fact.text);
    if (!text) continue;
    if (text.length > 3000)
      return {
        facts: existing,
        added: 0,
        duplicates: 0,
        error:
          "A fact exceeds 3,000 characters. Shorten the paragraph in the source resume and import it again.",
      };
    if (seen.has(text)) {
      duplicates++;
      continue;
    }
    seen.add(text);
    additions.push({ ...fact, text });
  }
  if (existing.length + additions.length > 300)
    return {
      facts: existing,
      added: 0,
      duplicates: 0,
      error:
        "This file would exceed the 300-fact limit. Combine or remove facts in the list, then import this file again.",
    };
  if (!additions.length && !duplicates)
    return {
      facts: existing,
      added: 0,
      duplicates: 0,
      error: "No resume text was found in this file.",
    };
  return {
    facts: additions.length ? [...existing, ...additions] : existing,
    added: additions.length,
    duplicates,
  };
}

export function profileEditorReducer(
  state: ProfileEditorState,
  action: ProfileAction,
): ProfileEditorState {
  if (action.type === "edit")
    return {
      ...state,
      profile:
        typeof action.update === "function"
          ? action.update(state.profile)
          : action.update,
    };
  if (action.type === "start-import") return { ...state, imports: [] };
  const result = action.error
    ? {
        facts: state.profile.facts,
        added: 0,
        duplicates: 0,
        error: action.error,
      }
    : mergeResumeFacts(state.profile.facts, action.facts);
  return {
    profile: result.added
      ? { ...state.profile, facts: result.facts, confirmed: false }
      : state.profile,
    imports: [
      ...state.imports,
      {
        name: action.name,
        added: result.added,
        duplicates: result.duplicates,
        error: result.error,
      },
    ],
  };
}
