// Checks that hold on any application form, so a problem is found on every
// form it happens on without anyone writing down the right answer for each
// question. They read only what a form shows: each field's label, kind,
// value, options and error state. The same checks run on what a real fill
// left behind (a fill capture or issue report, eval/check.ts) and on an
// offline re-fill of that page with the current build.
//
// Like the scanner, this shares no code with src/: a check must not agree
// with the engine because it was built from the same rules.

export type CheckField = {
  label: string;
  kind: string;
  required: boolean;
  value: string;
  // Choices the field offers, when it shows them without a server lookup.
  options?: string[];
  // How many choices there really are, when `options` is cut short.
  optionCount?: number;
  // The site marks the field invalid.
  invalid?: boolean;
  // What the extension itself noted on the field after filling it.
  warning?: string;
  frame?: string;
  // The question a checkbox or radio button is one choice of, when known.
  group?: string;
  // The extension leaves it alone on purpose (an applicant's edit).
  protected?: boolean;
  // Why, when it is an edit lock: an empty field kept empty by one is
  // worth a look (a test typed into it once, then cleared by the site).
  lock?: string;
  // Only known on a re-fill: the field was empty before the fill, held a
  // value during it, and what that value was.
  heldDuringFill?: string;
};

export type PageFacts = {
  // Site name for grouping: the ATS, or the host's registrable domain.
  site: string;
  // How many jobs and schools the applicant's profile has.
  profileWork?: number;
  profileEducation?: number;
  // Sections the page lets you add rows to ("Work Experience").
  addable?: string[];
  // Only known on a re-fill: menus still open after the fill settled.
  openMenus?: string[];
  // How the fill ended, and the extension's note when it failed.
  fillStatus?: string;
  fillNote?: string;
  // The re-fill gave every field left over a stand-in value (engines.ts,
  // standInValue): those values are the eval's, not junk the engine wrote.
  standIn?: boolean;
  // Fields the stand-in pass offered a value for that the extension could
  // not write, with its reason.
  writeFailures?: { label: string; reason: string }[];
  // Questions the extension left alone because another field has the same
  // label (its own list of what it did not fill): rows it could not tell
  // apart. Optional ones too, which no other check sees (Intuit's Avature
  // left "Did you graduate?" and "End date" this way, 2026-10-17).
  sameLabel?: string[];
};
const standInValues = /^(stand-in answer|stand\.in@example\.com|https:\/\/example\.com)$/i;

export type Severity = "high" | "medium" | "low";
export type Violation = {
  rule: Rule;
  severity: Severity;
  label: string;
  value?: string;
  detail: string;
  site: string;
  // The kind of control it is on (text, combobox, checkbox…), for grouping
  // problems by widget as well as by check and site.
  kind?: string;
  // Which of the fields given to checkForm it is on, when it is on one: a
  // label can be on several ("Zip Code" of the applicant's address and of an
  // employer's in a Work History row).
  field?: number;
  // The same problem on another form, on any site, has the same signature.
  signature: string;
};
export type Rule =
  | "required-empty"
  | "required-left-for-you"
  | "open-question-empty"
  | "locked-empty"
  | "same-label-skipped"
  | "upload-missing"
  | "fill-warning"
  | "site-rejected"
  | "placeholder-value"
  | "not-an-option"
  | "wrong-shape"
  | "lost-value"
  | "rows-short"
  | "menu-open"
  | "fill-error"
  | "write-failed";

export const ruleInfo: Record<Rule, { severity: Severity; meaning: string }> = {
  "fill-error": { severity: "high", meaning: "The fill ended in an error or never finished." },
  "write-failed": { severity: "high", meaning: "Given a valid value for a field, the extension could not write it (re-fill only)." },
  "lost-value": { severity: "high", meaning: "A value written during the fill was gone when it ended." },
  "fill-warning": { severity: "high", meaning: "The extension noted a problem on a field it filled." },
  "placeholder-value": { severity: "high", meaning: "A field holds a placeholder or junk value." },
  "wrong-shape": { severity: "high", meaning: "A value is the wrong kind for its question (a word in a date, no @ in an email)." },
  "site-rejected": { severity: "high", meaning: "The site marks a filled value as invalid." },
  "required-empty": { severity: "high", meaning: "A required field the profile should answer is empty." },
  "not-an-option": { severity: "medium", meaning: "A choice field holds a value that is not one of its options." },
  "locked-empty": { severity: "medium", meaning: "An empty field the extension skipped because of an earlier edit. If that edit was a test, unlock empty fields." },
  "same-label-skipped": { severity: "medium", meaning: "A field left empty because another field has the same label: the extension could not tell which job or school row it belongs to." },
  "rows-short": { severity: "medium", meaning: "Fewer job or school rows than the profile has." },
  "menu-open": { severity: "medium", meaning: "A dropdown menu was left open after the fill." },
  "upload-missing": { severity: "medium", meaning: "A required resume or cover letter upload is empty." },
  "open-question-empty": { severity: "low", meaning: "A required open-ended question is empty in the offline re-fill, which has no real model to write it." },
  "required-left-for-you": { severity: "low", meaning: "A required question left for the applicant (consent, signature, self-identification)." },
};

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// A label as a group key: no numbers or row positions, at most six words.
export const labelKey = (label: string) =>
  norm(label).replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ") || "(no label)";
// Messages differ in the values they quote; the problem is the rest.
const messageKey = (text: string) =>
  norm(text.replace(/"[^"]*"|'[^']*'|“[^”]*”/g, " ")).replace(/\b\d+\b/g, "n").split(" ").slice(0, 10).join(" ");

// What a select shows when nothing is chosen counts as empty.
// JazzHR sends "resumator_no_selection" for its empty choice.
const showsNothing = /^(select( one| an option)?|choose( one| an option)?|please (select|choose)\b.*|-+|—|none selected|no[ _]selection|\w+_no_selection)\.?$/i;
export const isEmpty = (value: string) => !squash(value) || showsNothing.test(squash(value));

// Values no applicant gives: stand-ins, site placeholders, serialisation slips.
const placeholderValue =
  /^(example (organization|company|school|university)|stand[- ]in answer|stand\.in@example\.com|unspecified|undefined|null|nan|\[object object\]|lorem ipsum.*|xxx+|tbd|todo|test|asdf|placeholder|your (answer|name|email) here)$/i;
// Not example.com: the synthetic applicant's own email is there.
const placeholderInside = /\[object Object\]|\bundefined\b(?! (behaviou?r|terms?))|\{\{[^}]*\}\}|\bNaN\b/;

// Questions the extension leaves to the applicant by design.
const leftForYou =
  /\b(signature|sign(ed)? (here|name)|initials|consent|i (agree|acknowledge|certify|attest|confirm|understand)|agree|acknowledg|certif|attest|captcha|gender|sex|race|ethnic|hispanic|latino|disabilit|veteran|pronoun|sexual orientation|transgender|lgbt|user ?name|password|log ?in|sign ?in|create (an )?account)/i;

// What each kind of question needs a value to look like. Only plain text
// boxes: a choice field's shape is its options' business.
type Shape = { asks: RegExp; except?: RegExp; fits: (value: string) => boolean; wants: string };
const monthNames = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
const shapes: Shape[] = [
  { asks: /\be-?mail\b/i, except: /\b(opt|consent|subscribe|receive|send)\b/i, fits: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), wants: "an email address" },
  {
    asks: /\b(phone|mobile|cell|telephone)\b/i,
    except: /\b(type|device|extension|ext|country|code|consent|text messages?|sms|opt)\b/i,
    fits: (v) => (v.match(/\d/g) || []).length >= 7 && !/[a-z]{3,}/i.test(v.replace(/\b(ext|x)\b/gi, "")),
    wants: "a phone number",
  },
  {
    asks: /\b(url|website|web site|linkedin|github|portfolio|personal site)\b/i,
    except: /\b(hear|how did|source|referr|other)\b/i,
    fits: (v) => /^(https?:\/\/)?[^\s/]+\.[^\s]{2,}$/i.test(v),
    wants: "a web address",
  },
  { asks: /\b(gpa|grade point)\b/i, except: /\bscale|out of|type\b/i, fits: (v) => /^\d(\.\d{1,3})?(\s*\/\s*\d(\.\d+)?)?$/.test(v), wants: "a grade point average" },
  { asks: /\b(zip|postal) ?(code)?\b/i, fits: (v) => /^[a-z0-9][a-z0-9 -]{1,9}$/i.test(v), wants: "a postal code" },
  { asks: /^(year|start year|end year|graduation year|year of graduation)$/i, fits: (v) => /^(19|20)\d\d$/.test(v), wants: "a year" },
  { asks: /^(month|start month|end month)$/i, fits: (v) => /^(0?[1-9]|1[0-2])$/.test(v) || monthNames.test(v), wants: "a month" },
  {
    // Only questions that ask for a date outright. Yes/no questions mention
    // time in passing ("now or in the future"); their options decide.
    asks: /\b(date|when did you|when do you|when will you|when can you|graduat\w* (date|on))\b/i,
    except: /^(are|have|has|do|does|did|will|would|can|could|is|were|was|should)\b|\b(update|candidate|validate|accommodat|mandate|consent)\b/i,
    fits: (v) => /\d/.test(v) || monthNames.test(v) || /^n\/?a$/i.test(v) || /\b(present|current|now|immediately|asap|upon|flexible|negotiable|spring|summer|fall|autumn|winter)\b/i.test(v),
    wants: "a date",
  },
  {
    asks: /^(legal |preferred )?(first|last|given|family|middle|sur) ?name$/i,
    fits: (v) => !/[@\d]/.test(v) && v.length <= 60,
    wants: "a name",
  },
];

function shapeProblem(field: CheckField): string | undefined {
  if (field.options?.length || !/^(text|textarea|number|spinbutton|date|email|tel|url|search|combobox)$/.test(field.kind)) return;
  const label = squash(field.label);
  const value = squash(field.value);
  if (!value || label.length > 140) return;
  for (const shape of shapes)
    if (shape.asks.test(label) && !shape.except?.test(label) && !shape.fits(value)) return shape.wants;
}

// Exact, up to case and punctuation: "United States of America" for an
// option "United States" is the alias slip this check is for.
const sameChoice = (value: string, option: string) => norm(value) === norm(option);

// Checkboxes and radio buttons of one question: the question is answered
// when any of them is. Without a known question, a run of neighbouring
// required choices of one kind is taken as one.
function choiceGroups(fields: CheckField[]): Map<CheckField, CheckField[]> {
  const groups = new Map<CheckField, CheckField[]>();
  let run: CheckField[] = [];
  const close = () => { if (run.length > 1) for (const member of run) groups.set(member, run); run = []; };
  const named = new Map<string, CheckField[]>();
  for (const field of fields) {
    const choice = /^(checkbox|radio)$/.test(field.kind);
    if (choice && field.group) {
      const key = `${field.frame}|${field.group}`;
      named.set(key, [...(named.get(key) || []), field]);
      close();
      continue;
    }
    const last = run.at(-1);
    if (choice && field.required && (!last || (last.kind === field.kind && last.frame === field.frame))) run.push(field);
    else { close(); if (choice && field.required) run.push(field); }
  }
  close();
  for (const members of named.values()) if (members.length > 1) for (const member of members) groups.set(member, members);
  return groups;
}

export function checkForm(fields: CheckField[], page: PageFacts): Violation[] {
  const found: Violation[] = [];
  const groups = choiceGroups(fields);
  const add = (rule: Rule, field: { label: string; value?: string; kind?: string } | undefined, detail: string, key?: string) => {
    const label = squash(field?.label || "");
    const index = field ? fields.indexOf(field as CheckField) : -1;
    found.push({
      rule,
      severity: ruleInfo[rule].severity,
      label,
      ...(field?.value ? { value: squash(field.value).slice(0, 120) } : {}),
      detail,
      site: page.site,
      ...(field?.kind ? { kind: field.kind } : {}),
      ...(index >= 0 ? { field: index } : {}),
      signature: `${rule} | ${key ?? labelKey(label)}`,
    });
  };

  const failed = Boolean(page.fillStatus && /^(failed|timeout|engine-error|error)$/.test(page.fillStatus));
  if (failed)
    // Said with how it ended: "timeout" with the card's generic note read
    // as if the fill had failed in some particular way.
    add("fill-error", undefined, `${page.fillStatus}${page.fillNote ? `: ${page.fillNote}` : ""}`, messageKey(`${page.fillStatus} ${page.fillNote || ""}`));

  for (const field of fields) {
    const value = squash(field.value);
    // A value the extension kept out of the report says nothing either way.
    if (value === "[redacted]") continue;
    const empty = isEmpty(value);
    if (field.warning) add("fill-warning", field, field.warning, messageKey(field.warning));
    if (field.heldDuringFill && empty && !field.warning)
      add("lost-value", field, `Held "${squash(field.heldDuringFill).slice(0, 80)}" during the fill, empty after it.`);
    const standIn = page.standIn && standInValues.test(value);
    if (!empty && !standIn && placeholderValue.test(value)) add("placeholder-value", field, `Holds "${value.slice(0, 80)}".`);
    else if (!empty && !standIn && placeholderInside.test(value)) add("placeholder-value", field, `Contains "${value.match(placeholderInside)![0]}".`);
    // An upload's error state says nothing offline, where uploads are blocked.
    if (!empty && field.invalid && field.kind !== "file") add("site-rejected", field, "The site marks this value invalid.");
    const shape = !empty ? shapeProblem(field) : undefined;
    if (shape) add("wrong-shape", field, `Asks for ${shape}, holds "${value.slice(0, 80)}".`);
    if (!empty && field.options?.length && !(field.optionCount && field.optionCount > field.options.length) && /^(select|radio|combobox|listbox|select-one|select-multiple)$/.test(field.kind)) {
      const chosen = value.split(/\s*;\s*/).filter(Boolean);
      const offered = field.options.filter((option) => !isEmpty(option));
      if (offered.length && chosen.some((choice) => !offered.some((option) => sameChoice(choice, option))))
        add("not-an-option", field, `"${value.slice(0, 80)}" is not among ${offered.length} options.`);
    }
    if (empty && field.lock) add("locked-empty", field, `Left empty: ${field.lock.slice(0, 120)}.`);
    const group = groups.get(field);
    if (group && (group[0] !== field || group.some((member) => !isEmpty(member.value)))) continue;
    // A fill that never finished leaves every field after it empty; that is
    // its fill-error, not a problem class per field (the corpus's four
    // timed-out embedded forms made eight of the top thirty, 2026-10-17).
    if (empty && field.required && !field.protected && !failed) {
      if (group) {
        const question = field.group || `${field.label} (one of ${group.length} choices)`;
        const asked = { label: question };
        if (leftForYou.test(question)) add("required-left-for-you", asked, "Required, left for the applicant.");
        else add("required-empty", asked, `None of its ${group.length} choices is picked after the fill.`);
      } else if (field.kind === "file") {
        if (/resume|\bcv\b|cover letter|curriculum/i.test(field.label)) add("upload-missing", field, "Required upload is empty.");
      } else if (leftForYou.test(field.label)) add("required-left-for-you", field, "Required, left for the applicant.");
      // Offline, a written answer comes from the eval's stand-in writer, and
      // the engine may withhold it: not the same as a field it cannot fill.
      else if (page.standIn && field.kind === "textarea") add("open-question-empty", field, "Required open-ended question, empty offline.");
      else add("required-empty", field, "Required and empty after the fill.");
    }
  }

  // Repeating sections: each job and school in the profile needs a row.
  const rows = (asks: RegExp) => {
    const matching = fields.filter((field) => asks.test(squash(field.label)) && !field.options?.length);
    return { present: matching.length, filled: matching.filter((field) => !isEmpty(field.value)).length };
  };
  const sections: { name: string; asks: RegExp; addable: RegExp; profile?: number }[] = [
    { name: "work", asks: /^(company|employer|company name|employer name|organization|organisation)( name)?$/i, addable: /work|experience|employ|job|position/i, profile: page.profileWork },
    { name: "education", asks: /^(school|university|college|institution|school or university|school name|name of (school|institution))$/i, addable: /educat|school|degree|academic/i, profile: page.profileEducation },
  ];
  for (const section of sections) {
    if (!section.profile || failed) continue;
    const { present, filled } = rows(section.asks);
    const canAdd = (page.addable || []).some((name) => section.addable.test(name));
    // Only where the step asks for these rows at all, and repeats them: a
    // form asking for one "current employer" is not short of rows.
    if (!(present || canAdd) || filled >= section.profile) continue;
    if (!canAdd && present < 2 && present <= filled) continue;
    add("rows-short", { label: section.name }, `${filled} of ${section.profile} ${section.name} entries have a row${canAdd ? "; the page can add more" : ""}.`, section.name);
  }

  for (const label of new Set(page.sameLabel || [])) {
    const named = fields.filter((field) => labelKey(field.label) === labelKey(label));
    const empty = named.filter((field) => isEmpty(field.value));
    // Only where no row got an answer: one row's empty End date may be a
    // current job's, rightly left empty.
    if (empty.length < named.length) continue;
    add("same-label-skipped", empty[0] || { label }, `Left empty in ${named.length ? `all ${named.length}` : "every"} field${named.length === 1 ? "" : "s"} with this label: another field has the same label.`);
  }

  for (const failure of page.writeFailures || [])
    if (!/^no value proposed/.test(failure.reason)) add("write-failed", { label: failure.label }, failure.reason, `${labelKey(failure.label)} | ${messageKey(failure.reason)}`);
  for (const menu of page.openMenus || []) add("menu-open", { label: menu }, "Still open after the fill settled.");
  return found;
}

// Group findings from many forms into ranked problem classes: the class seen on forms
// of the most vendors (Workday, Greenhouse…), then on the most forms, comes
// first: by hosts, one vendor's many employers outranked a class twice its size.
export type Finding = { capture: string; url: string; build?: string; violation: Violation };
export type ProblemClass = {
  signature: string;
  rule: Rule;
  severity: Severity;
  siteNames: string[];
  // The kinds of control it was found on.
  widgets: string[];
  forms: number;
  sites: number;
  examples: { capture: string; url: string; label: string; value?: string; detail: string; build?: string }[];
};
const severityRank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
export function rankProblems(findings: Finding[]): ProblemClass[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) groups.set(finding.violation.signature, [...(groups.get(finding.violation.signature) || []), finding]);
  const host = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };
  return [...groups.entries()]
    .map(([signature, items]) => ({
      signature,
      rule: items[0].violation.rule,
      severity: items[0].violation.severity,
      siteNames: [...new Set(items.map((item) => item.violation.site))],
      widgets: [...new Set(items.map((item) => item.violation.kind).filter((kind): kind is string => Boolean(kind)))],
      forms: new Set(items.map((item) => item.capture)).size,
      sites: new Set(items.map((item) => host(item.url))).size,
      examples: items.slice(0, 5).map((item) => ({
        capture: item.capture,
        url: item.url,
        label: item.violation.label,
        ...(item.violation.value ? { value: item.violation.value } : {}),
        detail: item.violation.detail,
        ...(item.build ? { build: item.build } : {}),
      })),
    }))
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.siteNames.length - a.siteNames.length || b.forms - a.forms || b.sites - a.sites || a.signature.localeCompare(b.signature));
}

// The site a form belongs to, for grouping: the ATS when it is a known one,
// otherwise the host without its tenant ("career8.successfactors.com" and
// "career4.successfactors.com" are one site).
export function siteOf(ats: string | undefined, url: string): string {
  if (ats && !/^(general|other|unknown)$/i.test(ats)) return ats;
  try {
    const parts = new URL(url).hostname.split(".");
    return parts.slice(-2).join(".");
  } catch {
    return ats || "unknown";
  }
}
