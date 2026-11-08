import { type Field } from "../shared/model";
import { wordLimit } from "../shared/questions";
import { askedLevel } from "../shared/transcripts";

export function fieldWordLimit(element: Element, label: string): number | undefined {
  const texts = [label];
  const root = element.getRootNode() as Document | ShadowRoot;
  for (const id of (element.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean))
    texts.push(root.querySelector(`#${CSS.escape(id)}`)?.textContent || "");
  for (const attr of ["data-max-words", "data-word-limit"]) {
    const value = Number(element.getAttribute(attr));
    if (value > 0 && Number.isInteger(value) && value <= 10000) texts.push(`maximum ${value} words`);
  }
  let parent = element.parentElement;
  for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
    if (parent.querySelectorAll('input:not([type="hidden"]),textarea,select').length !== 1) break;
    texts.push(labelText(parent));
  }
  return wordLimit(texts.join(" "));
}

export type Control =
  HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;
export const cleanLabel = (text: string) =>
  text
    // Markup a site escaped into its text (PageUp's hidden option names:
    // "<b>White</b><br> A person having origins\, …").
    .replace(/<\/?[a-z][a-z0-9]*\s*\/?>/gi, " ")
    .replace(/\\,/g, ",")
    // Invisible joiners around a required mark ("First Name\u2060*\u2060:",
    // one employer's Greenhouse form) and a closing colon are no part of a name.
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(\s*[*✱✳✴:])+\s*$/, "")
    .replace(/\s*\(required\)\s*$/i, "")
    .trim()
    .slice(0, 1000);
const controlSelector =
  'input:not([type="hidden"]), textarea, select, button[aria-haspopup="listbox"], [role="checkbox"], [role="radio"], [role="combobox"]';

// Labels must not absorb option lists, validation messages, or uploaded names.
const notLabelText =
  'input,textarea,select,button,script,style,svg,iframe,[role="checkbox"],[role="radio"],[role="combobox"],[role="button"],[role="listbox"],[role="option"],[role="status"],[role="alert"],[aria-live],[hidden],.application-field,.select__menu,.select__value-container,.input-select-input-single-value';
// The text a label shows, with what its <slot>s show in their place: a web
// component's label inside its shadow root is only slots, and SmartRecruiters'
// questions are the page's own text slotted in.
function shownText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;
  if (element.matches(notLabelText)) return "";
  if (element.localName === "slot") {
    const assigned = (element as HTMLSlotElement).assignedNodes({ flatten: true });
    return (assigned.length ? assigned : [...element.childNodes]).map(shownText).join("");
  }
  return [...element.childNodes].map(shownText).join(element.localName === "br" ? " " : "");
}
export function labelText(node: Element | null): string {
  if (!node) return "";
  if (node.querySelector("slot")) return cleanLabel(shownText(node));
  const copy = node.cloneNode(true) as Element;
  copy.querySelectorAll(notLabelText).forEach((e) => e.remove());
  return cleanLabel(copy.textContent || "");
}

export function questionLabel(element: Element): string {
  const question = element.closest(".application-question");
  if (question) return labelText(question.querySelector(".application-label"));
  // Breezy heads each of the employer's questions with an <h3> and binds no
  // label, so its inputs read as their names ("section_…_question_0").
  const breezy = element.closest("li.question");
  return labelText(breezy?.querySelector("h3") || null);
}

// A choice drawn as two or more toggle buttons side by side (Ashby's yes/no
// questions): the pressed button is the answer. A lone toggle (an editor's
// Bold button) is not a form choice.
export function toggleGroup(element: Element): HTMLElement[] {
  if (!element.matches("button[aria-pressed]") || !element.parentElement) return [];
  const group = [
    ...element.parentElement.querySelectorAll<HTMLElement>(":scope > button[aria-pressed]"),
  ];
  return group.length >= 2 ? group : [];
}
export const isToggleChoice = (element: Element) => toggleGroup(element).length > 0;

// The question a toggle group answers: the nearest label or legend around
// the group, never one of the buttons' own texts.
function toggleQuestion(element: Element): Element | null {
  const group = element.parentElement!;
  const labelled = group.getAttribute("aria-labelledby");
  if (labelled) {
    const root = element.getRootNode() as Document | ShadowRoot;
    const node = root.querySelector(`#${CSS.escape(labelled.split(/\s+/)[0])}`);
    if (node) return node;
  }
  let node: Element | null = group.parentElement;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const label = [...node.querySelectorAll("label, legend")].find((l) => !group.contains(l));
    if (label && labelText(label)) return label;
  }
  return null;
}

// The question a group of same-named radios or checkboxes answers when the
// page marks it up as plain text above them (Paylocity's screener questions:
// a paragraph, then one row per option). It is whatever precedes the first
// option inside the smallest block holding the whole group; the text as
// written is returned too, since "(required)" is often part of it.
export function groupQuestion(element: Element): { text: string; raw: string } | undefined {
  if (!(element instanceof HTMLInputElement) || !/^(radio|checkbox)$/.test(element.type) || !element.name) return;
  const root = element.form || (element.getRootNode() as Document | ShadowRoot);
  const members = [...root.querySelectorAll<HTMLInputElement>(`input[name="${CSS.escape(element.name)}"]`)].filter((input) => input.type === element.type);
  if (members.length < 2) return;
  let block: Element | null = element.parentElement;
  for (let depth = 0; block && depth < 5 && !members.every((member) => block!.contains(member)); depth++) block = block.parentElement;
  if (!block || !members.every((member) => block!.contains(member))) return;
  // Another group's controls in the same block mean it is a whole form
  // section, not one question.
  if ([...block.querySelectorAll("input,textarea,select")].some((control) => !members.includes(control as HTMLInputElement) && (control as HTMLInputElement).type !== "hidden")) return;
  const before: string[] = [];
  const raw: string[] = [];
  for (const child of block.children) {
    if (members.some((member) => child.contains(member))) break;
    raw.push(child.textContent || "");
    before.push(labelText(child));
  }
  const text = cleanLabel(before.filter(Boolean).join(" "));
  return text ? { text, raw: raw.join(" ") } : undefined;
}

// Ashby names each box of a checkbox question after its own option
// ("Veteran", "Master's"); the question is the title of the entry they sit
// in. Without it a box reads as a question of its own.
export function checkboxEntryTitle(element: Element): string {
  if (!(element instanceof HTMLInputElement) || element.type !== "checkbox") return "";
  const entry = element.closest('.ashby-application-form-field-entry,fieldset[class*="_fieldEntry_"]');
  const title = entry?.querySelector(":scope > .ashby-application-form-question-title, :scope > legend");
  return entry && title && entry.querySelectorAll('input[type="checkbox"]').length > 1 ? cleanLabel(labelText(title)) : "";
}

// JazzHR names each box of a checkbox question on its own
// (resumator-checkbox-<question>-<n>) and binds the question's <label> to the
// hidden input that collects the ticked boxes, which no label can name.
export function hiddenAnswerQuestion(element: Element): string {
  if (!(element instanceof HTMLInputElement) || element.type !== "checkbox") return "";
  let block = element.parentElement;
  for (let depth = 0; block && depth < 3; depth++, block = block.parentElement) {
    // A label with an empty "for" names nothing: searching for it built
    // 'input[type="hidden"]#', which the browser rejects, and the whole
    // fill stopped with no field filled.
    const label = [...block.querySelectorAll<HTMLLabelElement>(":scope > label[for]")].find((candidate) =>
      Boolean(candidate.htmlFor) && block!.querySelector(`input[type="hidden"]#${CSS.escape(candidate.htmlFor)}`),
    );
    if (!label) continue;
    const controls = [...block.querySelectorAll<HTMLInputElement>("input,select,textarea")].filter((control) => control.type !== "hidden");
    return controls.length > 1 && controls.every((control) => control.type === "checkbox") ? cleanLabel(labelText(label)) : "";
  }
  return "";
}

// an employer names every radio of a group with the question itself and leaves
// each one's label empty; the option is the text drawn beside the radio.
function sameNamedRadios(element: Element): HTMLInputElement[] {
  if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name) return [];
  const root = element.form || (element.getRootNode() as Document | ShadowRoot);
  return [...root.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(element.name)}"]`)];
}
export function sharedRadioQuestion(element: Element): string {
  const members = sameNamedRadios(element);
  const asked = cleanLabel(element.getAttribute("aria-label") || "");
  return asked && members.length > 1 && members.every((member) => cleanLabel(member.getAttribute("aria-label") || "") === asked) ? asked : "";
}
function radioOptionBeside(element: Element): string {
  const members = sameNamedRadios(element);
  let block: Element = element;
  for (let depth = 0; depth < 5; depth++) {
    const parent = block.parentElement;
    if (!parent || members.some((member) => member !== element && parent.contains(member))) break;
    block = parent;
  }
  return block === element ? "" : cleanLabel(labelText(block));
}

// iCIMS's EEO forms draw a radio inside a span of its own, its option as
// bare text after it up to a line break, and the question as the text
// before the first of them ("…please indicate by checking the appropriate
// box below", one employer's veteran question).
function bareWrapper(element: Element): Element {
  const parent = element.parentElement;
  return parent && parent.tagName === "SPAN" && parent.childElementCount === 1 && !(parent.textContent || "").trim() ? parent : element;
}
function textAfterRadio(element: Element): string {
  let text = "";
  for (let node = bareWrapper(element).nextSibling; node; node = node.nextSibling) {
    if (node instanceof HTMLBRElement) { if (text.trim()) break; continue; }
    if (node instanceof Element && node.querySelector("input,select,textarea")) break;
    text += node.textContent || "";
    if (text.length > 300) break;
  }
  return cleanLabel(text);
}
function textBeforeRadios(element: Element): string {
  const members = sameNamedRadios(element);
  const first = members[0] && bareWrapper(members[0]);
  if (!first || members.length < 2 || members.some((member) => member.labels?.length)) return "";
  const parts: string[] = [];
  for (let node = first.previousSibling; node; node = node.previousSibling) {
    if (node instanceof Element && node.querySelector("input,select,textarea")) break;
    const text = (node.textContent || "").trim();
    if (text) parts.unshift(text);
    if (parts.join(" ").length > 400) break;
  }
  // The last sentences: the ask comes just before the boxes.
  const text = cleanLabel(parts.join(" "));
  return text.length > 300 ? cleanLabel(text.slice(-300).replace(/^\S*\s/, "")) : text;
}

export function fieldLabel(element: Control): string {
  if (isToggleChoice(element))
    return cleanLabel(labelText(toggleQuestion(element)) || element.parentElement!.getAttribute("aria-label") || "") || "Unlabelled field";
  if (
    (element instanceof HTMLInputElement && element.type === "radio") ||
    element.getAttribute("role") === "radio"
  ) {
    // Or the group a component draws around it in its own shadow root
    // (SmartRecruiters' spl-radio-group).
    const group = element.closest('fieldset,[role="radiogroup"]') ||
      element.parentElement?.shadowRoot?.querySelector('fieldset[role="radiogroup"],[role="radiogroup"]') || null;
    const root = (group || element).getRootNode() as Document | ShadowRoot;
    const labelled = (group?.getAttribute("aria-labelledby") || "").split(/\s+/)
      .filter(Boolean).map((id) => labelText(root.querySelector(`#${CSS.escape(id)}`))).filter(Boolean).join(" ");
    // Ashby titles a fieldset with a <label> (not a <legend>) whose "for"
    // names no element; option labels are the ones bound to a radio. Of
    // several, the radio's own: the one whose "for" begins its id (Tesla's
    // "<id>" question over "<id>_yes" and "<id>_no"), else the nearest before
    // it. Tesla puts every question in one fieldset, and each was read as the
    // first.
    const titles = [...(group?.querySelectorAll("label") || [])].filter(
      (label) => !label.control && !label.querySelector("input"),
    );
    const title =
      titles.find((label) => label.htmlFor && element.id.startsWith(`${label.htmlFor}_`)) ||
      titles.filter((label) => label.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1) ||
      titles[0];
    const name = element instanceof HTMLInputElement ? element.name : "";
    return (
      cleanLabel(
        labelText(group?.querySelector("legend") || null) ||
          group?.getAttribute("aria-label") ||
          labelled ||
          sharedRadioQuestion(element) ||
          labelText(title || null) ||
          ripplingQuestion(element) ||
          questionLabel(element) ||
          groupQuestion(element)?.text ||
          textBeforeRadios(element) ||
          // Generated names (Ashby's form and field UUIDs) are not labels.
          (/[a-f0-9]{8}-[a-f0-9-]{20,}|cards\[/i.test(name) ? "" : name) ||
          ownLabel(element),
      ) || "Unlabelled field"
    );
  }
  // One option of a checkbox question reads as nothing on its own ("C#",
  // "I am comfortable with both"): it carries its question.
  const asked = element instanceof HTMLInputElement && element.type === "checkbox" ? groupQuestion(element)?.text : undefined;
  const own = ownLabel(element);
  const root = element.getRootNode() as Document | ShadowRoot;
  const description = (element.getAttribute("aria-describedby") || "").split(/\s+/)
    .filter(Boolean).map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent || "").join(" ");
  if (/^Address$/i.test(own) && /\binclude your city, region, and country\b/i.test(description))
    return "Address (city, region, country)";
  if (asked && own) return cleanLabel(`${asked}: ${own}`);
  // A lone box named only by its answer ("Yes") whose question is the
  // group's, named by aria-labelledby: Microsoft's three acknowledgments
  // each read "Yes", and as one label repeated all three were left alone.
  if (element instanceof HTMLInputElement && /^(checkbox|radio)$/.test(element.type) && /^(yes|no|i agree|agree|i accept|accept|i acknowledge|acknowledge)$/i.test(own.trim())) {
    for (let box = element.parentElement, depth = 0; box && depth < 4; box = box.parentElement, depth++) {
      const ids = (box.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
      if (!ids.length || box === element) continue;
      const question = cleanLabel(ids.map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent || "").join(" "));
      if (question && question.toLowerCase() !== own.trim().toLowerCase()) return cleanLabel(`${question}: ${own}`);
    }
  }
  // A Workday date's Month, Day and Year are named only so: the question is
  // its field's legend ("What is your first available start date?", an employer).
  if (/^(month|day|year)$/i.test(own) && element.matches('[data-automation-id^="dateSection"]')) {
    const legend = labelText(element.closest('[data-automation-id^="formField-"]')?.querySelector("legend") || null);
    if (legend) return cleanLabel(`${legend}: ${own}`);
  }
  if (promptOnly.test(own)) {
    const question = questionAbove(element);
    if (question) return cleanLabel(question);
  }
  return own || "Unlabelled field";
}

// A label that only says to pick ("Make Selection Here") carries no question:
// one employer's SuccessFactors asks "Are you one of the following? U.S.
// Citizen or National…" in a note above the list.
const promptOnly = /^\W*(please )?(make (a )?selection( here)?|select( one| an option)?( here)?|choose( one| an option)?( here)?)\W*$/i;
function questionAbove(element: Element): string {
  for (let node: Element | null = element, depth = 0; node && depth < 8; node = node.parentElement, depth++)
    for (let before = node.previousElementSibling, steps = 0; before && steps < 4; before = before.previousElementSibling, steps++) {
      // Another field between them asks something else.
      if (before.querySelector("input:not([type=hidden]),select,textarea,[role=combobox]")) return "";
      // Its pieces spaced apart: the list's items ran together ("following?U.S.").
      const pieces: string[] = [];
      const walker = before.ownerDocument.createTreeWalker(before, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) pieces.push(walker.currentNode.textContent || "");
      const text = pieces.join(" ").replace(/\s+/g, " ").trim();
      if (text.includes("?") && text.length <= 1500) return text.replace(/^\d+\.\s*/, "");
    }
  return "";
}

// Keep legacy locks effective when improved detection replaces opaque names.
export function legacyLabels(element: Control): string[] {
  // A radio's own label is its option ("Yes"), which names no question: a
  // lock under ":0:yes" from one answer held every Yes/No question of the
  // step (Tesla).
  const option = element.matches('input[type="radio"],[role="radio"]');
  const labels =
    !option && "labels" in element && element.labels
      ? [...(element.labels as NodeListOf<HTMLLabelElement>)]
          .map((label) => {
            const copy = label.cloneNode(true) as Element;
            copy
              .querySelectorAll(
                'input,textarea,select,button,[role="checkbox"],[role="radio"],[role="combobox"],[role="button"]',
              )
              .forEach((e) => e.remove());
            return copy.textContent || "";
          })
          .join(" ")
      : "";
  return [
    labels,
    option ? "" : element.getAttribute("aria-label") || "",
    element.getAttribute("placeholder") || "",
    element.getAttribute("name") || "",
    element.id,
  ].filter(Boolean);
}

function associatedLabel(element: Control): string {
  const root = element.getRootNode() as Document | ShadowRoot;
  if (element.matches('button[aria-haspopup="listbox"]')) {
    const workdayField = element.closest(
      '[data-automation-id^="formField-"]',
    );
    const workdayLabel =
      workdayField?.querySelector(
        element.id ? `label[for="${CSS.escape(element.id)}"]` : "label",
      ) || workdayField?.querySelector("legend, label");
    const stable = labelText(workdayLabel || null);
    if (stable) return stable;
  }
  // A radio's name is its option alone: PageUp also lists the group's
  // question in each option's aria-labelledby.
  const question = element.matches('input[type="radio"],[role="radio"]')
    ? element.closest("fieldset")?.querySelector("legend")
    : null;
  const group = element.matches('input[type="radio"],[role="radio"]') ? element.closest('fieldset,[role="radiogroup"]') : null;
  const questionIds = new Set((group?.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean));
  const labelled = (element.getAttribute("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((id) => !questionIds.has(id))
    .map((id) => root.querySelector(`#${CSS.escape(id)}`))
    .filter((node) => node !== question)
    .map(labelText)
    .filter(Boolean)
    .join(" ");
  const labels =
    "labels" in element && element.labels
      ? [...(element.labels as NodeListOf<HTMLLabelElement>)]
          .map(labelText)
          .filter(Boolean)
          .join(" ")
      : "";
  // A web component's own label attribute names it (SmartRecruiters'
  // <spl-radio label="Yes">).
  const component = element.localName.includes("-") ? element.getAttribute("label") || "" : "";
  return cleanLabel(labelled || element.getAttribute("aria-label") || labels || component);
}

export type DocumentKind = "resume" | "cover" | "transcript";
// What an uploader asks for, when its words name exactly one document.
export const documentKind = (text: string): DocumentKind | undefined => {
  const named = (
    [
      ["cover", /cover[\s_-]*letter/i],
      ["resume", /resume|curriculum|\bcv\b/i],
      ["transcript", /transcript/i],
    ] as const
  ).filter(([, pattern]) => pattern.test(text));
  return named.length === 1 ? named[0][0] : undefined;
};

// An uploader that imports the applicant's profile from a resume and
// rewrites the form with it (Oracle's "Import your profile from resume"), as
// opposed to the application's own resume slot. It is never filled: the
// profile fills the form directly, and it would share the slot's "Resume".
export function profileImport(element: Control): boolean {
  if (!(element instanceof HTMLInputElement) || element.type !== "file") return false;
  const text = [
    element.name,
    element.id,
    element.className,
    element.getAttribute("aria-label"),
    associatedLabel(element),
  ].join(" ");
  return /\bimport\b.{0,30}\bprofile\b|\bprofile[\s_-]*import/i.test(text);
}

export function fileKind(element: Control): DocumentKind | undefined {
  return fileQuestion(element)?.kind;
}

// What a file field is for, and the words that say so ("Please provide a
// recent transcript of your undergraduate studies"): the degree a transcript
// field asks for is read from them (shared/transcripts.ts).
export function fileQuestion(element: Control): { kind: DocumentKind; text: string } | undefined {
  if (!(element instanceof HTMLInputElement) || element.type !== "file") return;
  const named = (text: string) => {
    const kind = documentKind(text);
    return kind ? { kind, text } : undefined;
  };
  const direct = named(
    [
      element.name,
      element.id,
      element.getAttribute("data-automation-id"),
      associatedLabel(element),
    ].join(" "),
  );
  if (direct) return direct;
  // Bounded, single-file containers only. Never infer one file's purpose from
  // a neighboring uploader or the document title.
  let parent = element.parentElement;
  for (
    let depth = 0;
    parent && depth < 7;
    depth++, parent = parent.parentElement
  ) {
    if (
      parent.matches("body,html") ||
      parent.querySelectorAll('input[type="file"]').length !== 1
    )
      break;
    const labels = [
      ...parent.querySelectorAll(
        'label,legend,h2,h3,h4,[role="heading"],.application-label,[data-automation-id="file-upload-drop-zone"]',
      ),
    ];
    // Some uploaders (Workday) label the area only through the section's
    // identity: id="Resume/CV-section", data-fkit-id="resumeAttachments--…".
    const section = parent;
    const identity = [
      section.id,
      section.getAttribute("data-automation-id"),
      section.getAttribute("data-fkit-id"),
      ...(section.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .map((id) => (id ? section.ownerDocument.getElementById(id) : null))
        .map((label) => (label ? labelText(label) : "")),
    ].join(" ");
    const found = named([labels.map(labelText).join(" "), identity].join(" "));
    if (found) return found;
  }
  // Oracle's block names what goes in its one uploader, nine levels up, in
  // its title and instructions: "Additional Documents. Add any additional
  // documents. E.g.: Cover Letter, Certificate, Reference letter.".
  const block = element.closest(".apply-flow-block");
  if (block && block.querySelectorAll('input[type="file"]').length === 1)
    return named(
      [...block.querySelectorAll(".apply-flow-block__title,.apply-flow-block__instructions")].map(labelText).join(" "),
    );
}

// The single-uploader container of a file input, up to a few levels out.
function uploaderScope(element: HTMLInputElement) {
  let scope: Element = element;
  for (
    let parent = element.parentElement, depth = 0;
    parent && depth < 9 && !parent.matches("body,html,form");
    parent = parent.parentElement, depth++
  ) {
    if (parent.querySelectorAll('input[type="file"]').length !== 1) break;
    scope = parent;
  }
  return scope;
}

// Sites that keep an uploaded document server-side show its name beside an
// empty file input (iCIMS "current file"). That is an existing document.
export function currentFileName(element: Control): string {
  if (!(element instanceof HTMLInputElement) || element.type !== "file")
    return "";
  // Only the uploader's own few levels: once a site swaps another uploader's
  // input for a filename chip, a wider single-input scope reaches that chip.
  let scope: Element = element;
  for (
    let parent = element.parentElement, depth = 0;
    parent && depth < 4 && !parent.matches("body,html,form");
    parent = parent.parentElement, depth++
  ) {
    if (parent.querySelectorAll('input[type="file"]').length !== 1) break;
    scope = parent;
  }
  const purpose = fileKind(element);
  for (const candidate of scope.querySelectorAll<HTMLElement>(
    // Amazon's saved resume: "Download Name.pdf" beside its Replace input,
    // which Fill had used to upload the same resume again.
    '[class*="CurrentFile" i],[class*="current-file" i],[class*="uploaded-file" i],[id$="_FileNameLabel"],[class*="file-name" i],[class*="filename" i],.document-block-title',
  )) {
    if (/NoDisplay|hidden/i.test(candidate.className)) continue;
    // Earlier uploads offered to pick from ("Use"), as Oracle lists them,
    // are not this uploader's file.
    if (candidate.closest('attachment-preuploaded, [class*="preupload" i]')) continue;
    const style = candidate.ownerDocument.defaultView?.getComputedStyle(candidate);
    if (style && (style.display === "none" || style.visibility === "hidden"))
      continue;
    const name = (candidate.textContent || "").replace(/\s+/g, " ").trim().replace(/^download /i, "");
    // A resume's file name never stands in for a cover letter, or vice versa.
    const named = documentKind(name);
    if (purpose && named && named !== purpose) continue;
    if (/\.(pdf|docx?|rtf|txt|odt)\b/i.test(name)) return name.slice(0, 300);
  }
  return "";
}

// An error the site shows beside this uploader after an upload attempt.
export function uploadError(element: Control): string {
  if (!(element instanceof HTMLInputElement) || element.type !== "file")
    return "";
  for (const candidate of uploaderScope(element).querySelectorAll<HTMLElement>(
    '[role="alert"],[class*="error" i],[class*="invalid" i]',
  )) {
    if (candidate.querySelector("input,button,select,textarea")) continue;
    const style = candidate.ownerDocument.defaultView?.getComputedStyle(candidate);
    if (style && (style.display === "none" || style.visibility === "hidden"))
      continue;
    const text = (candidate.textContent || "").replace(/\s+/g, " ").trim();
    // An alert can announce success or progress too: Workday's "Resume.pdf
    // successfully uploaded" and "Resume.pdf loading" read as failed uploads.
    if (/\bsuccess(ful(ly)?)?\b|\b(has been|was) uploaded\b|\bupload(ed)? complete\b|\b(loading|uploading|processing|scanning)\b/i.test(text) &&
        !/\b(fail\w*|error|invalid|too (large|big)|not (allowed|supported|accepted)|unsupported|could not|couldn t|unable)\b/i.test(text.replace(/[’']/g, " ")))
      continue;
    if (text && text.length < 300) return text;
  }
  return "";
}

// A resume uploader that parses the file and overwrites the form with it.
// An uploader that rewrites the form from the resume, beside an ordinary
// uploader for the same document (Ashby's "Autofill from resume" pane next
// to its Resume field). The ordinary field is the application's; the
// autofill pane is an optional shortcut and is left to the applicant.
// Paylocity opens an application under an "Apply with resume" dialog and
// also has an ordinary resume field in the form. While the dialog is showing
// its upload is the one the site wants first (it fills the form from it), so
// it is the resume field and the ordinary one waits; once the dialog is gone
// the ordinary field is the application's. The dialog keeps aria-hidden="true"
// even while shown, so its wrapper's display says whether it is up.
export function paylocityForcedResume(doc: Document): HTMLInputElement | undefined {
  if (!/(^|\.)paylocity\.com$/i.test(location.hostname)) return;
  const input = doc.querySelector<HTMLInputElement>('#forceUploadResumeModal input[type="file"]#btn-forceResume');
  const shell = input?.closest<HTMLElement>('[id$="citrus-modal-wrapper"]') || doc.getElementById("forceUploadResumeModal");
  if (!input || !shell) return;
  return getComputedStyle(shell).display !== "none" && shell.getClientRects().length > 0 ? input : undefined;
}

export function redundantAutofill(element: Control): boolean {
  if (element instanceof HTMLInputElement && /(^|\.)paylocity\.com$/i.test(location.hostname)) {
    const forced = paylocityForcedResume(element.ownerDocument);
    if (element.id === "btn-resume" && forced) return true;
    if (element.id === "btn-forceResume") return !forced && Boolean(element.ownerDocument.querySelector('input[type="file"][id="btn-resume"]'));
  }
  const kind = fileKind(element);
  if (!kind || !replacesForm(element)) return false;
  const root = element.getRootNode() as Document | ShadowRoot;
  return [...root.querySelectorAll<HTMLInputElement>('input[type="file"]')].some(
    (other) => other !== element && fileKind(other) === kind && !replacesForm(other),
  );
}

export function replacesForm(element: Control): boolean {
  if (!(element instanceof HTMLInputElement) || element.type !== "file")
    return false;
  if (element === paylocityForcedResume(element.ownerDocument)) return true;
  const scope = uploaderScope(element);
  // The nearest notice beside this uploader, never a whole page section.
  for (let node: Element | null = element; node; node = node.parentElement) {
    const text = node.textContent || "";
    if (text.length > 3000) return false;
    if (
      // (Paylocity's forced dialog: "Upload your resume and we'll
      // automatically fill out your application".)
      /pre-?fill|auto-?fill|automatically fill|fill (out|in) (your|the) application|populate|parse|existing data in the form will be replaced/i.test(
        text,
      )
    )
      return true;
    if (node === scope) return false;
  }
  return false;
}

// Rippling writes a custom question above its field, outside it; a dropdown's
// own name is only its placeholder ("Select"), and a radio group has none.
function ripplingQuestion(element: Element): string {
  const field = element.closest('[data-testid^="customQuestions."]')?.closest('[data-testid="field"]');
  if (!field || field.querySelector('[id$="-label"]:not([id^="label-customQuestions."])')) return "";
  const above = field.previousElementSibling;
  return above && !above.querySelector(controlSelector) ? labelText(above) : "";
}

export function ownLabel(element: Control): string {
  // A toggle choice's option is its own text ("Yes", "No").
  if (isToggleChoice(element)) return cleanLabel(element.textContent || "");
  const question = fileQuestion(element);
  const purpose = question?.kind;
  // A transcript for one degree says which: "Undergraduate transcript".
  if (purpose === "transcript") {
    const level = askedLevel(question!.text);
    return level ? `${level === "undergraduate" ? "Undergraduate" : "Graduate"} transcript` : "Transcript";
  }
  if (purpose) return { resume: "Resume", cover: "Cover letter", transcript: "Transcript" }[purpose];
  // An ARIA radio or checkbox drawn around a native input is named by that
  // input's label (Rippling), or by its own text.
  if (element.matches('[role="radio"],[role="checkbox"]') && !(element instanceof HTMLInputElement) && !associatedLabel(element)) {
    const native = element.querySelector('input[type="radio"],input[type="checkbox"]');
    const root = element.getRootNode() as Document | ShadowRoot;
    const named = (native?.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((id) => labelText(root.querySelector(`#${CSS.escape(id)}`))).filter(Boolean).join(" ");
    if (named || (native && labelText(element))) return named || labelText(element);
  }
  if (sharedRadioQuestion(element)) {
    const option = radioOptionBeside(element);
    if (option) return option;
  }
  // (A radio's or checkbox's own label is its option, not the question.)
  if (!element.matches('[role="radio"],[role="checkbox"],input[type="radio"],input[type="checkbox"]')) {
    const asked = ripplingQuestion(element);
    if (asked) return asked;
  }
  // An Ashby dropdown's title is the label just before its input container;
  // its "for" names no element (a custom question, or School in an
  // education row).
  if (element.matches("input.ashby-application-form-input-autocomplete")) {
    const title = element.parentElement?.previousElementSibling;
    if (title?.matches("label.ashby-application-form-question-title") && labelText(title)) return labelText(title);
  }
  const explicit = associatedLabel(element);
  if (explicit) return explicit;
  if (element instanceof HTMLInputElement && /^(radio|checkbox)$/.test(element.type)) {
    const after = textAfterRadio(element);
    if (after) return after;
  }
  // Select2's hidden select is named by its visible selection (Amazon's,
  // whose only name is the selection's aria-labelledby).
  const selection = select2Selection(element);
  const shown = selection && ownLabel(selection as unknown as Control);
  if (shown) return shown;
  const lever = questionLabel(element);
  if (lever) return lever;
  // A nearby standalone label is useful only in a single-control field, not
  // across an entire form or a repeated row.
  const wrapper = element.closest(
    '.field-wrapper,.form-field,.field,.form-group,.iCIMS_FieldRow,.ashby-application-form-field-entry,fieldset[class*="_fieldEntry_"],[data-automation-id^="formField-"]',
  );
  if (wrapper && wrapper.querySelectorAll(controlSelector).length === 1) {
    const labels = [
      ...wrapper.querySelectorAll(
        'label,.field-label,[data-automation-id="formLabel"]',
      ),
    ];
    if (labels.length === 1 && labelText(labels[0]))
      return labelText(labels[0]);
    // A Workday questionnaire's text answer is titled only by its fieldset's
    // legend; read as its id, the draft took it for no question.
    const legend = wrapper.matches('[data-automation-id^="formField-"]') && !labels.length
      ? labelText(wrapper.querySelector("legend"))
      : "";
    if (legend) return legend;
  }
  // A label whose "for" names no element (one employer's Greenhouse form:
  // <label for="First Name">, its input with no id) belongs to the one
  // control beside it: the nearest block holding only that label and it.
  // (A dropdown's input sits several blocks below its label.)
  for (let block = element.parentElement, depth = 0; block && depth < 10; block = block.parentElement, depth++) {
    if (block.querySelectorAll(controlSelector).length > 1) break;
    const labels = [...block.querySelectorAll("label")].filter((label) => !label.control);
    if (labels.length > 1) break;
    if (labels.length === 1 && labelText(labels[0])) return labelText(labels[0]);
  }
  const fallback =
    element.getAttribute("placeholder") ||
    element.getAttribute("name") ||
    element.id;
  return /cards\[|[a-f0-9]{8}-[a-f0-9-]{20,}|^react-select-|^question_\d+$/i.test(
    fallback,
  )
    ? ""
    : cleanLabel(fallback);
}

export function rendered(element: Element): boolean {
  if (element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  return (
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    element.getClientRects().length > 0
  );
}

// Select2 keeps the options and submitted value on an inaccessible native
// select. Its adjacent selection is the visible control, not another field.
export function select2Selection(element: Element): HTMLElement | undefined {
  if (!element.matches("select.select2-hidden-accessible")) return;
  const container = element.nextElementSibling;
  if (!container?.matches(".select2-container")) return;
  return container.querySelector<HTMLElement>(".select2-selection") || undefined;
}

export function controlVisible(element: Control): boolean {
  if (rendered(element)) return true;
  if (element instanceof HTMLInputElement && element === paylocityForcedResume(element.ownerDocument)) return true;
  const selection = select2Selection(element);
  if (selection) return rendered(selection);
  if (
    !(element instanceof HTMLInputElement) ||
    element.type !== "file" ||
    element.closest("[hidden],[inert]")
  )
    return false;
  let parent = element.parentElement;
  for (let i = 0; parent && i < 7; i++, parent = parent.parentElement) {
    if (parent.matches("body,html")) break;
    if (rendered(parent) && (fileKind(element) || associatedLabel(element)))
      return true;
  }
  return false;
}

export function placeholderOption(option: HTMLOptionElement): boolean {
  if (option.value === "") return true;
  // A blank choice ("<option value='0'></option>") selects nothing.
  if (!option.label.trim() && !option.text.trim()) return true;
  // JazzHR's empty choice ("-- No answer --", an employer) has a value
  // of its own; the dashes set it apart from a choice that answers "none".
  if (/^\s*[-—–]+\s*no (?:answer|selection)\s*[-—–]+\s*$/i.test(option.label)) return true;
  // Without the dashes as a list's first choice (one employer's citizenship list,
  // "No answer" with a value of 0, read as answered and left so).
  if (/^\s*no (?:answer|selection)\s*$/i.test(option.label) && option.index === 0) return true;
  const label = option.label
    .replace(/[—–….-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /^(month|day|year)$/i.test(label) &&
    option.parentElement instanceof HTMLSelectElement &&
    /\b(start|end|date|birth|from|to)\b/i.test(ownLabel(option.parentElement))
  )
    return true;
  return /^(?:please )?(?:select(?: (?:an? |your )?[\w ]{1,35})?|choose(?: (?:an? |your )?[\w ]{1,35})?|make (?:a )?selection)$/i.test(
    label,
  );
}

export function writable(element: Control): boolean {
  // A read-only combobox naming its list is chosen from, not typed into:
  // Microsoft's careers form draws every list so, and its sponsorship
  // question was refused as "no longer writable".
  const chosenFrom = element.getAttribute("role") === "combobox" && Boolean(element.getAttribute("aria-controls"));
  return (
    controlVisible(element) &&
    !(element as HTMLInputElement).disabled &&
    (!(element as HTMLInputElement).readOnly || chosenFrom) &&
    element.getAttribute("aria-disabled") !== "true" &&
    element.getAttribute("aria-readonly") !== "true"
  );
}

export function sectionFor(element: Control): {
  section: string;
  index: number;
} {
  const known = element.closest(
    '.education--form,[data-automation-id="educationSection"],[data-automation-id^="education-"]',
  );
  if (known) {
    const root = element.getRootNode() as Document | ShadowRoot;
    const rows = [
      ...root.querySelectorAll(
        '.education--form,[data-automation-id="educationSection"],[data-automation-id^="education-"]',
      ),
    ];
    return { section: "Education", index: Math.max(0, rows.indexOf(known)) };
  }
  // Greenhouse's employment rows, as its education rows: without them each
  // job's "Current role" and end date were the same field asked three
  // times, and all were left.
  const job = element.closest(".employment--form,.employment-form");
  if (job) {
    const root = element.getRootNode() as Document | ShadowRoot;
    return { section: "Experience", index: Math.max(0, [...root.querySelectorAll(".employment--form,.employment-form")].indexOf(job)) };
  }
  // SuccessFactors: each row is an .rcmSectionComponent inside the section
  // whose top bar names it ("Work Experiences"). Without this every row's
  // "Country" is the same field, and one row's edit locks them all.
  // A date's input is inside its UI5 picker's shadow root: the row is
  // found from the picker (an employer: every "From Date" was
  // one field, and the site's own dates were never corrected).
  let sfRow: Element | null = null;
  for (let node: Element | null = element; node && !sfRow; ) {
    sfRow = node.closest(".rcmSectionComponent");
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  const sfSection = sfRow?.closest(".rcmFormSection");
  if (sfRow && sfSection) {
    const title = cleanLabel(
      sfSection.querySelector(
        '.rcmFormSectionTopBar span:not([aria-hidden="true"]):not(.hiddenAriaContent):not([role])',
      )?.textContent || "",
    );
    if (title)
      return {
        section: title.slice(0, 500),
        index: Math.max(0, [...sfSection.querySelectorAll(".rcmSectionComponent")].indexOf(sfRow)),
      };
  }
  // Paylocity: each job and each school is a block ("Work History 2",
  // "Education History 1") whose fields repeat the same labels, and its
  // address parts repeat the applicant's own. Without a row they are all one
  // ambiguous field, refused as "another field has the same label", and every
  // school was answered from the first one.
  // Greenhouse's own form on an employer's site:
  // each school is an .education-form-fields block repeating School, Degree
  // and the date boxes.
  const educationBlock = element.closest(".education-form-fields");
  if (educationBlock) {
    const root = element.getRootNode() as Document | ShadowRoot;
    return { section: "Education", index: Math.max(0, [...root.querySelectorAll(".education-form-fields")].indexOf(educationBlock)) };
  }
  const paylocityRow = element.closest(".work-history-group,.education-history-group");
  if (paylocityRow) {
    const work = paylocityRow.classList.contains("work-history-group");
    const root = element.getRootNode() as Document | ShadowRoot;
    const rows = [...root.querySelectorAll(work ? ".work-history-group" : ".education-history-group")];
    return { section: work ? "Work History" : "Education History", index: Math.max(0, rows.indexOf(paylocityRow)) };
  }
  // Avature: each job and school is a datasetField__row fieldset in a group
  // named by the section's title ("Work experience"). Read as one section,
  // every row's End date and "Did you graduate?" was refused as "another
  // field has the same label", and one row's school locked the next's
  //. Its hidden sample row is not a row.
  const avatureRow = element.closest("fieldset.datasetField__row");
  const avatureGroup = avatureRow?.closest('[role="group"][aria-labelledby]');
  if (avatureRow && avatureGroup) {
    const root = element.getRootNode() as Document | ShadowRoot;
    const id = avatureGroup.getAttribute("aria-labelledby") || "";
    const title = cleanLabel(labelText(/\s/.test(id) ? null : root.querySelector(`#${CSS.escape(id)}`)));
    const rows = [...avatureGroup.querySelectorAll("fieldset.datasetField__row:not(.datasetField__row--sample)")];
    if (title) return { section: title.slice(0, 500), index: Math.max(0, rows.indexOf(avatureRow)) };
  }
  // Workday: each job or school is a group labelled by its panel's heading
  // ("Work or Other Experience 2", an h5), and the first legend inside it is
  // a date's ("From"). Read as the section, every job's Location was one
  // field, answered with the applicant's home.
  const root = element.getRootNode() as Document | ShadowRoot;
  for (let panel = element.closest('[role="group"][aria-labelledby$="-panel"]'); panel; panel = panel.parentElement?.closest('[role="group"][aria-labelledby$="-panel"]') || null) {
    const id = panel.getAttribute("aria-labelledby") || "";
    const titled = cleanLabel(labelText(/\s/.test(id) ? null : root.querySelector(`#${CSS.escape(id)}`))).match(/^(.*\S)\s+(\d{1,3})$/);
    if (titled) return { section: titled[1].slice(0, 500), index: Number(titled[2]) - 1 };
  }
  const selector =
    'fieldset,[role="group"],[data-automation-id*="workExperience"],[data-automation-id*="education"]';
  const heading = (r: Element) =>
    labelText(r.querySelector('legend,h2,h3,h4,[role="heading"]')) ||
    r.getAttribute("aria-label") ||
    r.getAttribute("data-automation-id") ||
    "";
  // An untitled inner group (iCIMS's "Start Date (Month / Day / Year)")
  // belongs to the titled row around it.
  let row = element.closest(selector);
  while (row && !cleanLabel(heading(row)) && row.parentElement?.closest(selector))
    row = row.parentElement.closest(selector);
  const title = row ? cleanLabel(heading(row)).slice(0, 500) : "";
  // Numbered row titles ("Education (2)", "Addresses (1)* required.") name
  // the section and the row: section Education, second row.
  const numbered = title.match(/^(.*?)\s*\((\d{1,3})\)/);
  if (numbered && numbered[1].trim())
    return { section: numbered[1].trim(), index: Number(numbered[2]) - 1 };
  const section = title;
  const same = [...root.querySelectorAll(selector)].filter(
    (r) => cleanLabel(heading(r)).slice(0, 500) === section,
  );
  return { section, index: Math.max(0, same.indexOf(row!)) };
}

export function isRequired(element: Control): boolean {
  if (
    (element as HTMLInputElement).required ||
    element.getAttribute("aria-required") === "true" ||
    // Select2 marks its visible selection (Amazon's), not the hidden select.
    select2Selection(element)?.getAttribute("aria-required") === "true"
  )
    return true;
  if (element.getAttribute("role") === "combobox") {
    const shell = element.closest(".select__container");
    if (shell?.querySelector('input[required][aria-hidden="true"]'))
      return true;
  }
  // Toggle questions mark required on the question label (Ashby's _required_).
  if (isToggleChoice(element))
    return /required/i.test(String(toggleQuestion(element)?.className || ""));
  if (element.closest(".required-field")) return true;
  // Workday's question dropdowns: the button's own name ends "Required"
  // (" Select One Required"), and the question's legend carries the
  // asterisk. one employer's OPT questions were listed as optional.
  if (/\brequired\s*$/i.test(element.getAttribute("aria-label") || "")) return true;
  const fieldset = element.closest("fieldset");
  const legend = fieldset?.querySelector(":scope > legend");
  if (legend && fieldset!.querySelectorAll(controlSelector).length <= 2 &&
      (legend.querySelector('abbr[title="required"], abbr.requiredAsterisk') || /[*✱]\s*$/.test((legend.textContent || "").trim())))
    return true;
  const ashbyTitle = element.matches("input.ashby-application-form-input-autocomplete") ? element.parentElement?.previousElementSibling : null;
  if (ashbyTitle?.matches("label.ashby-application-form-question-title")) return /required/i.test(String(ashbyTitle.className));
  // (A custom Ashby dropdown's entry is a fieldset without the public class.)
  const ashby = element.closest('.ashby-application-form-field-entry,fieldset[class*="_fieldEntry_"]');
  const title = ashby?.querySelector(":scope > .ashby-application-form-question-title");
  // Each box of a checkbox question is as required as the question: its
  // title carries the mark, and one employer's "locations you would relocate to"
  // read as two optional boxes.
  const entryTitle = ashby?.querySelector(":scope > .ashby-application-form-question-title, :scope > legend");
  if (entryTitle && element instanceof HTMLInputElement && element.type === "checkbox" && ashby!.querySelectorAll('input[type="checkbox"]').length > 1)
    return /required/i.test(String(entryTitle.className)) || /[*✱]|\(required\)/i.test(entryTitle.textContent || "");
  if (title && ashby?.querySelectorAll(controlSelector).length === 1)
    return /required/i.test(String(title.className)) || /[*✱]|\(required\)/i.test(title.textContent || "");
  // A label of its own that ends in the mark (JazzHR's <i class="asterisk">,
  // an employer: its required questions were listed as optional).
  const own = ("labels" in element && element.labels?.[0]?.textContent) || "";
  if (/(?:[*✱]|\(required\))\s*$/i.test(own.trim())) return true;
  // A question written as text above its options says so in that text.
  return /\(required\)\s*$|\*\s*$/i.test((groupQuestion(element)?.raw || "").trim());
}

const patterns = new Map<string, boolean>();
export function validationState(
  element: Control,
  current: string,
): Pick<Field, "invalid" | "validationWarning"> {
  const ariaInvalid = element.getAttribute("aria-invalid") === "true";
  const pattern = element.getAttribute("pattern");
  if (pattern !== null) {
    if (!patterns.has(pattern)) {
      if (patterns.size > 500) patterns.clear();
      try {
        new RegExp(pattern, "v");
        patterns.set(pattern, true);
      } catch {
        patterns.set(pattern, false);
      }
    }
    if (!patterns.get(pattern))
      return {
        invalid: ariaInvalid,
        validationWarning:
          "The site has an invalid validation pattern; check this field manually.",
      };
  }
  try {
    const validity = "validity" in element ? (element as HTMLInputElement).validity : undefined;
    // A picker shows its answer beside its own input, which stays empty and
    // "required": missing a value it never holds is not a rejected answer
    // (Paylocity's Country and State).
    const pickerOnly = Boolean(validity?.valueMissing) && !(element as HTMLInputElement).value &&
      !(["badInput", "customError", "patternMismatch", "rangeOverflow", "rangeUnderflow", "stepMismatch", "tooLong", "tooShort", "typeMismatch"] as const)
        .some((fault) => validity![fault]);
    return {
      invalid:
        ariaInvalid ||
        Boolean(current && validity && !validity.valid && !pickerOnly),
    };
  } catch {
    return {
      invalid: ariaInvalid,
      validationWarning:
        "The site's validation check failed; check this field manually.",
    };
  }
}

export function selectedCustomValue(element: Control): string | undefined {
  const paylocity = element.closest(".pcty-input-select__input");
  if (paylocity) {
    const value = paylocity.parentElement?.querySelector(".input-select-input-single-value")?.textContent?.trim() || "";
    return /^(select|choose|--)/i.test(value) ? "" : value;
  }
  // An older react-select (no combobox role; one employer's form) shows its
  // choice as a "…-singleValue" block in its container. A flag drawn there
  // has a title, which is no part of the choice.
  if (element.matches('input[id^="react-select-"][aria-autocomplete="list"],.dropdown-autocomplete input[aria-autocomplete="list"]')) {
    const container = element.closest('.dropdown-autocomplete,[class*="-container"]');
    const single = container?.querySelector('[class*="singleValue"],[class*="single-value"]');
    if (!single) return "";
    const copy = single.cloneNode(true) as Element;
    copy.querySelectorAll("svg,title").forEach((node) => node.remove());
    return (copy.textContent || "").replace(/\s+/g, " ").trim();
  }
  if (element.getAttribute("role") !== "combobox") return;
  // iCIMS search dropdowns show their placeholder as the anchor's text.
  if (
    element.matches('a[id$="_icimsDropdown"]') &&
    /^[\s\u2014-]*(make a selection|please select|select one|loading\.*)[\s\u2014-]*$/i.test(
      element.textContent || "",
    )
  )
    return "";
  const shell = element.closest(".select__container");
  const selected = shell?.querySelector(".select__single-value");
  if (selected) return selected.textContent?.trim() || "";
  const chosen = [...(shell?.querySelectorAll(".select__multi-value__label") || [])];
  if (chosen.length)
    return chosen.map((item) => item.textContent?.trim() || "").join(", ");
  // Text in a react-select's search box is a query, not an answer: the site
  // discards it on blur. With no selected value the field is empty.
  if (shell) return "";
  return element.getAttribute("aria-valuetext") ?? undefined;
}
