import type {
  FillAction,
  InputSelector,
  GlobalConfig,
  SelectorConfig,
  SiteConfig,
} from "./schema";
import {
  canonicalValues,
  fallbackValues,
  matchOption,
  relatedFieldsOfStudy,
  selectorValues,
  type ValueContext,
} from "../values";
import { normalize, type Profile } from "../../shared/model";
import { skillNames } from "../../shared/skill-names";
import { pickMonth } from "../page/month-picker";
import { listedNames, type OptionsSource, type SiteOptions } from "./options-source";
import { nameVariants } from "../../shared/matching";
import { profileLanguages } from "../../shared/languages";
import { degreeAliases } from "../../shared/education";

export type FillStatus =
  // caution: the value was written, but the applicant should look at it.
  | { key: string; status: "filled"; caution?: string }
  | { key: string; status: "skipped" | "failed"; reason: string };

export type MethodRequest = {
  guardElement?: Element;
  action?: FillAction;
  element: Element;
  forbidden?: Set<Element>;
  globals: GlobalConfig;
  method: string;
  signal?: AbortSignal;
  values: string[];
  // A click that saves one entry of the repeated section being filled
  // through its own small form (see entrySave).
  entrySave?: boolean;
};

export type InterpreterOptions = {
  context?: Element;
  // Only these configured keys run (a later pass that uploads documents),
  // or every key but these.
  onlyKeys?: string[];
  skipKeys?: string[];
  // Told the element a rule is about to write, and the rule's key, for the
  // card's progress.
  onField?: (element: Element, key: string) => void;
  valueContext?: ValueContext;
  used?: Set<Element>;
  execute?: (request: MethodRequest) => Promise<boolean>;
  // Selects an option of a component-driven dropdown (react-select) through
  // the page, or reports that the element is not one.
  reactSelect?: (
    element: Element,
    choose: (labels: string[]) => string | undefined,
    searches: string[],
  ) => Promise<"selected" | "unsupported" | "no-match" | "skipped">;
  isLocked?: (element: Element) => boolean;
  // Records a decision for an issue report (rows found, rows added).
  note?: (data: Record<string, unknown>) => void;
  // A value the site pre-filled (from a parsed resume) that may be replaced.
  isReplaceable?: (element: Element) => boolean;
  // A site value the rule found already right: checked, so the review does
  // not ask the applicant to check it (AMD's iCIMS "Did You Graduate?" and
  // dates, 2026-11-07).
  onConfirmed?: (element: Element) => void;
  // Reads the site's own list of a field's answers from a rule's
  // optionsSource (fetchSiteOptions); undefined when it cannot.
  listOptions?: (source: OptionsSource, terms: string[]) => Promise<SiteOptions | undefined>;
  now?: () => number;
  pollMs?: number;
  signal?: AbortSignal;
};

const dangerousLabel =
  /\b(submit|send|finish|sign|agree|certify|certification)\b|\bcomplete application\b/i;
const nonMutatingMethods = new Set([
  "blur",
  "scrollListboxToOption",
  "scrollToBottom",
]);

export const paths = (path: string | string[] | undefined) =>
  path === undefined ? [] : Array.isArray(path) ? path : [path];
const isTag = (element: Element, name: string) =>
  element.localName.toLowerCase() === name;
const viewOf = (element: Element) =>
  element.ownerDocument.defaultView || window;

function documents(root: Document): Document[] {
  const found = [root];
  const visit = (document: Document) => {
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument && !found.includes(frame.contentDocument)) {
          found.push(frame.contentDocument);
          visit(frame.contentDocument);
        }
      } catch {
        // Cross-origin frames are handled by their own extension content script.
      }
    }
  };
  visit(root);
  return found;
}

// Today as a number, YYYYMMDD, for a path that compares a date the page
// shows ("Last Modified: 10/14/2026") with it.
function today() {
  const now = new Date();
  return String(now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate());
}

function xpathInNode(path: string, context: Node): Element[] {
  path = path.replaceAll("%TODAY%", today());
  const document =
    context.nodeType === Node.DOCUMENT_NODE
      ? (context as Document)
      : context.ownerDocument || undefined;
  if (!document) return [];
  try {
    const result = document.evaluate(
      path,
      context,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    const elements: Element[] = [];
    for (let index = 0; index < result.snapshotLength; index++) {
      const node = result.snapshotItem(index);
      if (node?.nodeType === Node.ELEMENT_NODE) elements.push(node as Element);
    }
    return elements;
  } catch {
    return [];
  }
}

function xpathInShadow(path: string, root: ShadowRoot): Element[] {
  const simple = path
    .replace(/^\.?\/+/, "")
    .match(/^([a-zA-Z*][\w-]*)(\[.*\])?$/);
  if (!simple) return [];
  const [, tag, predicates = ""] = simple;
  return [...root.querySelectorAll("*")].filter((element) =>
    xpathInNode(`self::${tag}${predicates}`, element).includes(element),
  );
}

function xpathWithShadows(
  path: string,
  context: Document | Element,
): Element[] {
  const segments = path.split(/\/shadow-root\/?/);
  let current: (Document | Element | ShadowRoot)[] = [context];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index] || ".";
    const matched = current.flatMap((node) =>
      node instanceof ShadowRoot
        ? xpathInShadow(segment, node)
        : xpathInNode(segment, node),
    );
    if (index === segments.length - 1) return matched;
    current = matched.flatMap((element) =>
      element.shadowRoot ? [element.shadowRoot] : [],
    );
  }
  return [];
}

export function queryXPathAll(
  root: Document,
  path: string,
  context?: Document | Element,
): Element[] {
  if (context) return xpathWithShadows(path, context);
  const results: Element[] = [];
  for (const document of documents(root)) {
    results.push(...xpathWithShadows(path, document));
    for (const host of document.querySelectorAll("*")) {
      if (!host.shadowRoot || path.includes("/shadow-root")) continue;
      results.push(...xpathInShadow(path, host.shadowRoot));
    }
  }
  return [...new Set(results)];
}

const groupMatches = (root: Document, groups: string[][]) =>
  documents(root).some((document) =>
    groups.some(
      (group) =>
        group.length > 0 &&
        group.every((path) => xpathWithShadows(path, document).length > 0),
    ),
  );

function glob(pattern: string): RegExp {
  return new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*")}$`,
    "i",
  );
}

export function matchesSiteConfig(
  config: SiteConfig,
  url: string,
  root: Document,
): boolean {
  if (groupMatches(root, config.pathsExcluded)) return false;
  if (config.urlsExcluded.some((pattern) => glob(pattern).test(url)))
    return false;
  return (
    config.urls.some((pattern) => glob(pattern).test(url)) ||
    groupMatches(root, config.embeddedPaths)
  );
}

const promptSelection = (element: Element): string | undefined => {
  const container = element.closest(
    '[data-uxi-widget-type="multiselect"],[data-automation-id="multiSelectContainer"]',
  );
  if (!container) return;
  const selected = [...container.querySelectorAll('[data-automation-id="selectedItem"]')]
    .map((item) => item.textContent?.trim() || "")
    .filter((text) => text && !/^no (items|matches|results)$/i.test(text));
  return selected.join(", ");
};

const textValue = (element: Element) => {
  const paylocity = element.closest(".pcty-input-select__input");
  if (paylocity) {
    const value = paylocity.parentElement?.querySelector(".input-select-input-single-value")?.textContent?.trim() || "";
    return /^(select|choose|--)/i.test(value) ? "" : value;
  }
  const selection = promptSelection(element);
  if (selection !== undefined) return selection;
  if (isTag(element, "input")) {
    const input = element as HTMLInputElement;
    if (input.type === "checkbox" || input.type === "radio")
      return input.checked ? input.value || "true" : "";
    return input.value;
  }
  if (isTag(element, "select")) {
    const select = element as HTMLSelectElement;
    return !select.selectedOptions[0] ||
      placeholderSelectOption(select.selectedOptions[0])
      ? ""
      : select.value;
  }
  if (isTag(element, "textarea"))
    return (element as HTMLTextAreaElement | HTMLSelectElement).value;
  const text =
    element.getAttribute("aria-valuetext") || element.textContent?.trim() || "";
  // An unselected Workday dropdown reads "Select One"; that is a placeholder,
  // not an answer.
  return /^(select one|select\u2026|select\.\.\.|select|choose one|choose)$/i.test(text) ||
    /^[\s\u2014-]*(make a selection|please select|type to search)[\s\u2014-]*$/i.test(text)
    ? ""
    : text;
};

function nativeSet(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const view = viewOf(element);
  const prototype = isTag(element, "input")
    ? view.HTMLInputElement.prototype
    : view.HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
}

async function defaultExecute(request: MethodRequest): Promise<boolean> {
  const { element, method, values, globals, action } = request;
  if (request.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (action?.event) dispatchConfiguredEvent(element, action);
  if (method === "event") return true;
  if (method === "click" || method === "reactClick") {
    if (isForbiddenClick(element, request.forbidden || new Set()))
      throw new Error(
        "Refused to activate a submit or certification control.",
      );
    const clickable = element as HTMLElement;
    if (typeof clickable.click !== "function") return false;
    clickable.click();
    // As the page's own executor does (mainWorld.ts): SuccessFactors'
    // picklists load only once focused too.
    if (clickable.matches?.('input.rcmpaginatedselectinput[role="combobox"]')) clickable.focus?.({ preventScroll: true });
    return true;
  }
  if (method === "blur") {
    const focusable = element as HTMLElement;
    if (typeof focusable.blur !== "function") return false;
    focusable.blur();
    return true;
  }
  // A month picked from its flatpickr calendar (month-picker.ts).
  if (method === "pickMonth")
    return element instanceof HTMLInputElement && pickMonth(element, values[0] || "");
  // Real keystrokes exist only inside the extension, where the background can
  // drive CDP. Everywhere else (unit tests, the offline eval) trustedType falls
  // back to these synthetic keys, which at least leave the value set.
  if (method === "keyType" || method === "trustedType" || method === "trustedSearch" || method === "trustedChoose") {
    // Widgets that keep their own state (Workday date sections, search
    // prompts) update from key events, not from an assigned value.
    const field = element as HTMLInputElement;
    field.focus?.();
    const setValue = (value: string) =>
      Object.getOwnPropertyDescriptor(
        viewOf(element).HTMLInputElement.prototype,
        "value",
      )?.set?.call(field, value);
    if ("value" in field) {
      setValue("");
      field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }
    for (const character of values[0] ?? "") {
      const init: KeyboardEventInit = {
        bubbles: true,
        composed: true,
        key: character,
        code: /[0-9]/.test(character)
          ? `Digit${character}`
          : `Key${character.toUpperCase()}`,
        keyCode: character.charCodeAt(0),
        which: character.charCodeAt(0),
      };
      element.dispatchEvent(new (viewOf(element).KeyboardEvent)("keydown", init));
      element.dispatchEvent(new (viewOf(element).KeyboardEvent)("keypress", init));
      if ("value" in field) {
        setValue(field.value + character);
        field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      }
      element.dispatchEvent(new (viewOf(element).KeyboardEvent)("keyup", init));
    }
    field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    if (method === "trustedChoose") {
      await sleep(1_500);
      for (const key of [{ key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40 }, { key: "Enter", code: "Enter", keyCode: 13, which: 13 }])
        element.dispatchEvent(new (viewOf(element).KeyboardEvent)("keydown", { bubbles: true, composed: true, ...key }));
    }
    if (method === "trustedSearch")
      element.dispatchEvent(
        new (viewOf(element).KeyboardEvent)("keydown", {
          bubbles: true,
          composed: true,
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
        }),
      );
    return true;
  }
  if (method === "scrollToBottom") {
    element.scrollTo?.({ top: element.scrollHeight });
    return true;
  }
  if (method === "clearValue") values.splice(0, values.length, "");
  const value = values[0];
  if (value === undefined) return action?.valueRequired === false;
  if (isTag(element, "select")) {
    const select = element as HTMLSelectElement;
    const option = matchOption(
      values,
      [...select.options]
        .filter((item) => !item.disabled && !placeholderSelectOption(item))
        .map((item) => ({ label: item.label, value: item.value })),
      globals,
    );
    if (!option) return false;
    Object.getOwnPropertyDescriptor(
      viewOf(element).HTMLSelectElement.prototype,
      "value",
    )?.set?.call(select, option.value);
  } else if (
    isTag(element, "input") &&
    ["checkbox", "radio"].includes((element as HTMLInputElement).type)
  ) {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(
      viewOf(element).HTMLInputElement.prototype,
      "checked",
    )?.set?.call(
      input,
      input.type === "radio" ||
        !["", "false", "no", "0"].includes(value.toLowerCase()),
    );
  } else if (isTag(element, "input") || isTag(element, "textarea")) {
    nativeSet(element as HTMLInputElement | HTMLTextAreaElement, value);
  } else return false;
  if (method !== "setValueOnly") {
    const EventConstructor = viewOf(element).Event;
    element.dispatchEvent(
      new EventConstructor("input", { bubbles: true, composed: true }),
    );
    element.dispatchEvent(
      new EventConstructor("change", { bubbles: true, composed: true }),
    );
  }
  if (!["defaultWithoutBlur", "setValue", "setValueOnly"].includes(method))
    (element as HTMLElement).blur?.();
  return true;
}

function placeholderSelectOption(option: HTMLOptionElement) {
  if (!option.value) return true;
  // A blank choice ("<option value='0'></option>") selects nothing.
  if (!option.label.trim() && !option.text.trim()) return true;
  const label = option.label
    .replace(/[—–….-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(month|day|year)$/i.test(label)) return true;
  return /^(?:please )?(?:select(?: (?:an? |your )?[\w ]{1,35})?|choose(?: (?:an? |your )?[\w ]{1,35})?|make (?:a )?selection)$/i.test(
    label,
  );
}

function dispatchConfiguredEvent(element: Element, action: FillAction) {
  if (!action.event) return;
  const view = viewOf(element);
  const init = {
    bubbles: true,
    composed: true,
    ...action.eventOptions,
  };
  element.dispatchEvent(
    /^key/i.test(action.event)
      ? new view.KeyboardEvent(action.event, init)
      : /^(mouse|pointer|click|dblclick)/i.test(action.event)
        ? new view.MouseEvent(action.event, { button: 0, buttons: 1, cancelable: true, ...init })
        : new view.Event(action.event, init),
  );
}

function replacePlaceholders(path: string, inputPath: string, value: string) {
  const lower = value.toLowerCase();
  const upper = value.toUpperCase();
  return path
    .replaceAll("%INPUTPATH%", inputPath)
    .replaceAll("%VALUE%", value)
    .replaceAll("%LOWERVALUE%", lower)
    .replaceAll("%UPPERVALUE%", upper);
}

// How a wait is kept: the page code gives one that a hidden tab's timer
// throttling does not stretch to a minute (content.ts, pause).
let wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export function setEngineWait(next: (ms: number) => Promise<void>) {
  wait = next;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted)
      return reject(new DOMException("Aborted", "AbortError"));
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      reject(new DOMException("Aborted", "AbortError"));
    };
    wait(ms).then(() => {
      signal?.removeEventListener("abort", abort);
      if (settled) return;
      settled = true;
      resolve();
    });
    signal?.addEventListener("abort", abort, { once: true });
  });

async function waitFor(
  root: Document,
  candidates: string[],
  context: Document | Element,
  timeout: number,
  removed: boolean,
  options: InterpreterOptions,
  accept: (element: Element) => boolean = () => true,
  settled?: () => boolean,
): Promise<Element | undefined> {
  const deadline = (options.now || Date.now)() + timeout;
  let nudged = (options.now || Date.now)();
  do {
    if (options.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    const element = candidates
      .flatMap((path) =>
        queryXPathAll(root, path, path.startsWith(".") ? context : undefined),
      )
      .find((element) => element.isConnected && accept(element));
    if (removed ? !element : element)
      return (
        element ||
        (context.nodeType === Node.DOCUMENT_NODE
          ? (context as Document).documentElement
          : (context as Element))
      );
    if (settled?.()) return;
    // SuccessFactors lists show a hundred options, alphabetically, and load
    // the next as the list is scrolled to its end; typing does not narrow
    // them. "Pennsylvania State University-University Park" and
    // "Computer Science" were never drawn, so never picked (Expand Energy,
    // report 8f198b5b, 2026-10-29).
    if (!removed && (options.now || Date.now)() - nudged >= 400) {
      nudged = (options.now || Date.now)();
      // As the applicant scrolls: the last option is brought into view, and
      // each box around it that scrolls is taken to its end and told so.
      // One box told once loaded a school list's next page but never Area
      // of Study's (report 8f198b5b).
      // Workday's search results are a virtual list that draws only the rows
      // in view: NVIDIA's drew two of five, and "Computer Science", third,
      // was never on the page to pick (2026-11-04). A screen at a time, back
      // to the top after the end, as the applicant would scroll it.
      for (const grid of root.querySelectorAll<HTMLElement>('[data-automation-id="activeListContainer"].ReactVirtualized__Grid, .ReactVirtualized__List[role="listbox"]')) {
        if (grid.scrollHeight <= grid.clientHeight + 4) continue;
        const atEnd = grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 4;
        grid.scrollTop = atEnd ? 0 : grid.scrollTop + Math.max(32, grid.clientHeight - 32);
        grid.dispatchEvent(new Event("scroll"));
      }
      for (const list of root.querySelectorAll("ul.sf-list-select")) {
        list.querySelector(":scope > li:last-child")?.scrollIntoView({ block: "end" });
        for (let box: Element | null = list, up = 0; box && up < 5; box = box.parentElement, up++) {
          if (box.scrollHeight > box.clientHeight + 4) box.scrollTop = box.scrollHeight;
          box.dispatchEvent(new Event("scroll"));
        }
      }
    }
    await sleep(options.pollMs || 25, options.signal);
  } while ((options.now || Date.now)() < deadline);
}

// What a field is called, never what it holds.
function fieldLabelText(element: Element) {
  return [
    element.getAttribute("aria-label") || "",
    ...[...((element as HTMLInputElement).labels || [])].map((label) => label.textContent || ""),
    element.closest(".RCMFormField, .input-row")?.querySelector("label")?.textContent || "",
  ].join(" ");
}

function labelOf(element: Element) {
  // Ashby's canonical school option has a separate name, country and domain.
  // Compare the one explicit name; concatenated metadata is not the answer.
  const schoolNames = element.matches('[role="option"].ashby-application-form-input-autocomplete-popup-result')
    ? element.querySelectorAll('[class*="canonicalSchoolResultName_"]') : [];
  const schoolName = schoolNames.length === 1 ? schoolNames[0].textContent : undefined;
  return (
    element.getAttribute("aria-label") ||
    schoolName ||
    [...((element as HTMLInputElement).labels || [])]
      .map((label) => label.textContent || "")
      .join(" ") ||
    element.textContent ||
    (element as HTMLInputElement).value ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim();
}

const isAbortError = (error: unknown) =>
  (error as { name?: string })?.name === "AbortError";

// The question a control belongs to: its associated label, wrapping label,
// fieldset legend, or the label immediately preceding it. Unassociated labels
// elsewhere in the form are ignored.
function questionText(element: Element): string {
  // React-select configs often target a wrapper, while the actual question
  // association belongs to its single input. Read that association first.
  if (!element.matches('input,textarea,select,button,[role="combobox"]')) {
    const controls = element.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]),textarea,select,button[aria-haspopup="listbox"]');
    if (controls.length === 1) {
      const own = questionText(controls[0]);
      if (own) return own;
    }
  }
  const document = element.ownerDocument;
  const parts: (string | null | undefined)[] = [element.getAttribute("aria-label")];
  const id = element.getAttribute("id");
  if (id && document)
    parts.push(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent);
  const labelled = element.getAttribute("aria-labelledby");
  if (labelled && document)
    for (const target of labelled.split(/\s+/))
      parts.push(document.getElementById(target)?.textContent);
  parts.push((element as HTMLElement).closest("label")?.textContent);
  parts.push(
    (element as HTMLElement).closest("fieldset")?.querySelector("legend")?.textContent,
  );
  for (
    let sibling = element.previousElementSibling, steps = 0;
    sibling && steps < 3;
    sibling = sibling.previousElementSibling, steps++
  )
    if (isTag(sibling, "label") && !sibling.getAttribute("for")) {
      parts.push(sibling.textContent);
      break;
    }
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

// "Do you require work authorization?" and "Do you need visa sponsorship?"
// ask whether the applicant needs sponsorship. Answering either from the
// work-authorization answer states the opposite of the truth.
function asksForSponsorship(element: Element): boolean {
  const text = questionText(element);
  return /\b(require|requires|need|needs|obtain)\b/i.test(text) && /authoriz|sponsor|visa/i.test(text);
}

function fallbackLabel(key: string): RegExp | undefined {
  const labels: Record<string, RegExp> = {
    address: /^(street |mailing |home )?address( (line )?1)?$/i,
    city: /^(city|current city)$/i,
    company: /^(company|employer|organization)( name)?$/i,
    country: /^country( region| of residence)?$/i,
    degree: /^degree$/i,
    email: /^e ?mail( address)?$/i,
    end_month: /^(end|grad|graduation)( date)? month$/i,
    end_year: /^(end|grad|graduation)( date)? year$/i,
    first_name: /^(legal )?(first|given) name$/i,
    full_name: /^(full |legal )?name$/i,
    last_name: /^(legal )?(last|family|sur) ?name$/i,
    linkedin: /^linkedin( profile| url| profile url)?$/i,
    location: /^(location( city)?|current location)$/i,
    major: /^(major|discipline|field of study)$/i,
    phone: /^(phone|mobile|telephone)( number)?$/i,
    postal_code: /^(zip|postal)( code)?$/i,
    school: /^(school|university|college|institution)( name)?$|^(school|college|university)\s*(or|\/|and)\s*(school|college|university)$/i,
    references:
      /professional references|list (three|3|two|2|your) .{0,40}references/i,
    relationship:
      /^(relationship|relationship to (you|applicant)|how do you know)/i,
    source: /how did you hear/i,
    // Also claims authorization questions phrased as a need ("Do you require
    // work authorization?"), which work_auth deliberately declines.
    sponsorship: /sponsor|\b(require|requires|need|needs)\b.*(authoriz|visa)/i,
    start_month: /^(start|from)( date)? month$/i,
    start_year: /^(start|from)( date)? year$/i,
    state: /^(state|province|state province)$/i,
    title: /^(job )?(title|position)$/i,
    work_auth: /authoriz|eligible to work/i,
    gender: /^(sex|gender)\b|gender identity/i,
    ethnicity: /race|ethnic/i,
    veteran: /veteran/i,
    disability: /disabilit/i,
    hispanic: /hispanic|latin/i,
    over18: /age of majority|18 years old|at least 18|over 18/i,
    relocation: /willing to relocate|relocat/i,
    prior_employment: /currently work for|employed by (this|the) (company|employer)|work for (td|us)\b/i,
    acknowledge_terms: /terms and conditions/i,
  };
  return labels[key.replace(/_[234]$/, "")];
}

// Workday renders questionnaire answers as a button whose accessible name is
// only "Select One"; the question itself sits in the surrounding field
// container (legend, label or rich text).
function listboxQuestion(button: Element): string {
  const field = button.closest(
    '[data-automation-id^="formField-"],fieldset,[role="group"]',
  );
  const text = [
    field?.querySelector("legend,label")?.textContent,
    field?.querySelector('[data-automation-id="richText"]')?.textContent,
    button.getAttribute("aria-label"),
  ]
    .filter(Boolean)
    .join(" ");
  return text
    .replace(/\bselect one\b|\brequired\b/gi, " ")
    .replace(/[✱✳✴*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function labeledFallback(
  key: string,
  context: Document | Element,
  // Some keys only make sense on one kind of control; narrowing before the
  // ambiguity check keeps a differently-worded neighbour from hiding the match.
  accept: (element: Element) => boolean = () => true,
): Element | undefined {
  const pattern = fallbackLabel(key);
  if (!pattern) return;
  const document =
    context.nodeType === Node.DOCUMENT_NODE
      ? (context as Document)
      : context.ownerDocument;
  if (!document) return;
  const view = document.defaultView;
  // A label inside a hidden part of the page belongs to a step the applicant
  // is not on (Oracle keeps every step in the page and hides the others).
  const shown = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement)
      if (view?.getComputedStyle(node).display === "none") return false;
    return true;
  };
  const labels = [...context.querySelectorAll("label")].filter((label) => {
    if (!shown(label)) return false;
    const text = (label.textContent || "")
      .replace(/[✱✳✴*]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!pattern.test(text)) return false;
    if (/^(work_auth|sponsorship)$/.test(key.replace(/_[234]$/, "")) && /^does your work authorization\b.*\binvolve (cpt|opt)\b/i.test(text)) return false;
    if (key.replace(/_[234]$/, "") === "relocation" && /^(please )?(provide|enter)\b.*\bpermanent address\b/i.test(text)) return false;
    if (key.replace(/_[234]$/, "") === "sponsorship" && /\bwithout\b.*\bsponsor/i.test(text)) return false;
    if (/^(work_auth|sponsorship)$/.test(key.replace(/_[234]$/, "")) &&
        /\b(proof|document\w*|temporary|permit type)\b/i.test(text)) return false;
    return (
      key.replace(/_[234]$/, "") !== "work_auth" ||
      !/sponsor|\b(require|requires|need|needs)\b/i.test(text)
    );
  });
  const controls = labels.flatMap((label) => {
    if (label.htmlFor) {
      const explicit = document.querySelector(`#${CSS.escape(label.htmlFor)}`);
      return explicit ? [explicit] : [];
    }
    const nested = label.querySelector(
      'input:not([type="hidden"]),textarea,select,[role="combobox"]',
    );
    if (nested) return [nested];
    const parent = label.parentElement;
    if (!parent || /^(FORM|BODY|HTML)$/.test(parent.tagName)) return [];
    const nearby = parent.querySelectorAll(
      'input:not([type="hidden"]),textarea,select,[role="combobox"]',
    );
    return nearby.length === 1 ? [nearby[0]] : [];
  });
  const buttons = [
    ...context.querySelectorAll('button[aria-haspopup="listbox"]'),
  ].filter((button) => {
    const text = listboxQuestion(button);
    if (!text || !pattern.test(text)) return false;
    if (/^(work_auth|sponsorship)$/.test(key.replace(/_[234]$/, "")) && /^does your work authorization\b.*\binvolve (cpt|opt)\b/i.test(text)) return false;
    if (key.replace(/_[234]$/, "") === "relocation" && /^(please )?(provide|enter)\b.*\bpermanent address\b/i.test(text)) return false;
    if (key.replace(/_[234]$/, "") === "sponsorship" && /\bwithout\b.*\bsponsor/i.test(text)) return false;
    if (/^(work_auth|sponsorship)$/.test(key.replace(/_[234]$/, "")) &&
        /\b(proof|document\w*|temporary|permit type)\b/i.test(text)) return false;
    return (
      key.replace(/_[234]$/, "") !== "work_auth" ||
      !/sponsor|\b(require|requires|need|needs)\b/i.test(text)
    );
  });
  // A box or a radio reached by its own label is one option of a question,
  // never the question: "Veteran" among "Which of these communities do you
  // belong to?" was ticked for an applicant whose answer is that they are
  // not one, because any value written to a box ticks it.
  const option = (element: Element) => element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio");
  const unique = [...new Set([...controls, ...buttons])].filter((element) => !option(element)).filter(accept);
  return unique.length === 1 ? unique[0] : undefined;
}

// iCIMS search dropdowns (a[id$=_icimsDropdown]) list options only for what
// is typed into their search box, and full names often find nothing ("M.S.
// Data Science, Statistics & Engineering (…)"). Search with the full name and
// then shorter forms, pick the result that best fits the full name, and fall
// back to the list's own "not found" entry when a school is missing from it.
// A dropdown already searched in this pass is not searched again by another
// configured path to the same control.
const searchedDropdowns = new WeakMap<Element, "selected" | "no-match">();

// A Select2 list that has no options until something is typed: its choices
// come from the site's server (Avature's University/School, Intuit
// 2026-10-17). Typing "Pennsylvania State University, University
// Park" found nothing, so the second school was left empty.
function remoteSelect2(target: Element) {
  const container = target.closest(".select2-container") || target.querySelector(".select2-container");
  const control = container?.querySelector('.select2-selection[role="combobox"]');
  const select = container?.previousElementSibling;
  if (!control || !select || !isTag(select, "select")) return;
  const listed = [...(select as HTMLSelectElement).options].filter((option) => option.value && option.text.trim());
  // At most the choice already made: the rest would be listed.
  return listed.length <= 1 ? control : undefined;
}

// A search list the general fill meets outside a site rule's paths (iCIMS'
// job rows: each job's Country, India not on the unfiltered first page,
// AMD 2026-11-07): searched and picked as a rule would.
export function searchListDropdown(
  target: Element,
  values: string[],
  globals: GlobalConfig,
  options: Pick<InterpreterOptions, "signal" | "isLocked"> = {},
) {
  return viaSearchDropdown(target, values, globals, options as InterpreterOptions);
}

async function viaSearchDropdown(
  target: Element,
  values: string[],
  globals: GlobalConfig,
  options: InterpreterOptions,
): Promise<"selected" | "unsupported" | "no-match"> {
  // A configured path can resolve to the field's label; the dropdown is the
  // anchor in the same iCIMS row.
  const anchor = target.matches('a[id$="_icimsDropdown"]')
    ? target
    : target.closest(".iCIMS_TableRow")?.querySelector('a[id$="_icimsDropdown"]') || remoteSelect2(target);
  if (!anchor || !values.length) return "unsupported";
  if (options.isLocked?.(anchor)) return "unsupported";
  const earlier = searchedDropdowns.get(anchor);
  if (earlier) return earlier;
  const outcome = await searchDropdown(anchor, target, values, globals, options);
  searchedDropdowns.set(anchor, outcome);
  setTimeout(() => searchedDropdowns.delete(anchor), 20_000);
  return outcome;
}

// A search that found nothing leaves its list open, and an open list
// aria-hides the rest of the page (Ashby's floating-ui combobox), which hides
// every field filled after it. Escape closes it; blur for widgets that only
// close on focus loss. Events only: focus is never moved.
function dismissPopup(element: Element) {
  const control = element.matches('[role="combobox"]')
    ? element
    : element.querySelector('[role="combobox"]');
  // A box that does not say it is open or closed (SuccessFactors' search
  // lists) is closed the same way, unless it says it already is.
  if (!control || control.getAttribute("aria-expanded") === "false") return;
  // A box that keeps whatever is typed (SmartRecruiters' Title and Company,
  // components marked allowcustomvalues) takes Escape as "discard": the
  // typed title was cleared and the entry refused (2026-11-04). Its list is
  // closed by leaving it instead.
  let host = (control.getRootNode() as ShadowRoot).host as Element | undefined;
  for (let depth = 0; host && depth < 3 && !host.hasAttribute("allowcustomvalues"); depth++)
    host = ((host.getRootNode() as ShadowRoot).host as Element | undefined);
  if (host?.hasAttribute("allowcustomvalues")) {
    (control as HTMLElement).blur?.();
    control.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    return;
  }
  for (const type of ["keydown", "keyup"])
    control.dispatchEvent(
      new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, composed: true }),
    );
  if (control.getAttribute("aria-expanded") !== "true") return;
  control.dispatchEvent(new FocusEvent("blur"));
  control.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
}

// A list button whose rule opened its list and found nothing to pick is
// closed, not left over the form: NVIDIA's Phone Device Type stayed open
// after "Mobile" matched none of "Home" and "Home Cellular" (2026-11-04).
// Its own Escape, then a press on the page as Workday's rules make.
async function closeOpenedList(element: Element, options: InterpreterOptions) {
  if (!element.matches('button[aria-haspopup="listbox"]') || element.getAttribute("aria-expanded") !== "true") return;
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, composed: true }));
  await sleep(150, options.signal);
  if (element.getAttribute("aria-expanded") !== "true") return;
  const page = element.ownerDocument.querySelector<HTMLElement>('[data-automation-id="mainContent"], #mainContent');
  if (!page) return;
  for (const type of ["mousedown", "mouseup", "click"]) page.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  await sleep(150, options.signal);
}

// A search list saying it found nothing ("There were no results" in
// SuccessFactors' lists), not one still loading.
function listFoundNothing(element: Element) {
  return [...element.ownerDocument.querySelectorAll('.no-results, [role="alert"]')].some((node) =>
    /^\s*(there were )?no (results|matches)( found)?\.?\s*$/i.test(node.textContent || ""),
  );
}

async function searchDropdown(
  anchor: Element,
  target: Element,
  values: string[],
  globals: GlobalConfig,
  options: InterpreterOptions,
): Promise<"selected" | "no-match"> {
  const row = anchor.closest(".iCIMS_TableRow") || anchor.parentElement;
  // Select2 opens its search box and results in a list of its own at the end
  // of the page, one at a time; "Searching…" and "No results found" are
  // messages there, not options.
  const select2 = anchor.matches(".select2-selection");
  const list = () => anchor.ownerDocument.querySelector(".select2-container--open .select2-dropdown");
  const search = () =>
    (select2
      ? list()?.querySelector<HTMLInputElement>("input.select2-search__field")
      : row?.querySelector<HTMLInputElement>("input.dropdown-search")) ?? undefined;
  const results = () =>
    select2
      ? [...(list()?.querySelectorAll('li.select2-results__option[role="option"]:not(.loading-results):not(.select2-results__message):not([aria-disabled="true"])') || [])]
      : [...(row?.querySelectorAll("ul.dropdown-results li.result-selectable") || [])];
  const label = (item: Element) => (item.textContent || "").replace(/\s+/g, " ").trim();
  const signature = () => results().map(label).join("\n");
  // What Select2 picks lands in the hidden select beside it: guarded with
  // the control, so the pick is not taken for the applicant's own edit.
  const guard = select2 ? anchor.closest(".select2-container")?.parentElement || anchor : anchor;
  const execute = (request: MethodRequest) =>
    (options.execute || defaultExecute)({ ...request, guardElement: guard });
  const before = textValue(anchor).trim();
  // Open the dropdown and let its first page of options load: iCIMS shows
  // an unfiltered list ("ABC School", …) before any search. It opens on a
  // mousedown (a click alone does nothing), and clicking an open dropdown
  // closes it.
  const isOpen = () =>
    anchor.getAttribute("aria-expanded") === "true" ||
    Boolean(search()?.getClientRects().length);
  const event = (element: Element, type: string, eventOptions: Record<string, unknown> = {}) =>
    execute({
      element,
      globals,
      method: "event",
      action: { event: type, eventOptions } as FillAction,
      signal: options.signal,
      values: [],
    });
  const open = async () => {
    if (!isOpen()) {
      await event(anchor, "mousedown");
      if (!isOpen())
        await execute({ element: anchor, globals, method: "click", signal: options.signal, values: [] });
    }
    let previous = "";
    for (let attempt = 0; attempt < 12; attempt++) {
      await sleep(150, options.signal);
      const now = signature();
      if (isOpen() && now && now === previous) break;
      previous = now;
    }
    return isOpen();
  };
  const choose = async (item: Element | undefined) => {
    if (!item) return false;
    await event(item, "mousedown");
    // Select2 takes the choice on the button's release.
    if (select2) await event(item, "mouseup");
    if (
      item.isConnected &&
      !(await execute({ element: item, globals, method: "click", signal: options.signal, values: [] }))
    )
      return false;
    await sleep(200, options.signal);
    return textValue(anchor).trim() !== before || textValue(anchor).trim() === label(item);
  };
  // Search on the site: the list must change after typing (the site asks its
  // server, which takes about a second), and only those results count.
  let opened = false;
  const searchFor = async (term: string) => {
    // Stay in the open dropdown between terms; reopen only if it closed.
    if (!opened || !isOpen()) {
      if (!(await open())) return [];
      opened = true;
    }
    const box = search();
    if (!box) return [];
    const unfiltered = signature();
    if (
      !(await execute({
        element: box,
        globals,
        method: "defaultWithoutBlur",
        signal: options.signal,
        values: [term],
      }))
    )
      return [];
    // The site searches on key release, as when someone types.
    const key = term.slice(-1);
    await event(box, "keydown", { key });
    await event(box, "keyup", { key });
    let previous = unfiltered;
    let settled = false;
    for (let attempt = 0; attempt < 27 && !settled; attempt++) {
      await sleep(150, options.signal);
      const now = signature();
      settled = now !== unfiltered && now === previous;
      // Nothing found (an empty list, steady for over a second).
      if (!now && now === previous && attempt >= 8) break;
      previous = now;
    }
    return settled ? results() : [];
  };
  // Search terms: the answer, its shorter forms, then the config's other
  // wordings ("Master's degree", then "Masters").
  const terms = [
    ...new Set([values[0], ...nameVariants(values[0]), ...values.slice(1)]),
  ]
    .filter((term) => /[a-z]{3}/i.test(term))
    .slice(0, 5);
  for (const term of terms) {
    const items = await searchFor(term);
    // Matched against the full answers and the term searched, never against
    // a fragment of a long name ("Engineering" in a data science degree).
    const option = matchOption(
      [...values, term],
      items.map((item) => ({ label: label(item), value: label(item) })),
      globals,
    );
    if (option && (await choose(items.find((item) => label(item) === option.label))))
      return "selected";
    if (option) opened = false;
  }
  // A school missing from the list: the list's own entry for that ("*School
  // Not Found (enter into Other School)", "Other") says so, and "Other
  // School" (filled next) names it.
  if (/school|institution|university|college/i.test(`${anchor.id} ${anchor.getAttribute("aria-label") || ""}`)) {
    const notListed = (items: Element[]) =>
      items.find((item) => /not found|not listed|^\W*other\b/i.test(label(item)));
    if (!opened || !isOpen()) await open();
    opened = true;
    if (await choose(notListed(results()))) return "no-match";
    for (const term of ["Not Found", "Other"]) {
      if (await choose(notListed(await searchFor(term)))) break;
    }
  }
  return "no-match";
}

// "unsupported" means the caller should use its ordinary methods.
async function viaReactSelect(
  element: Element,
  values: string[],
  globals: GlobalConfig,
  options: InterpreterOptions,
) {
  if (!options.reactSelect || !values.length) return "unsupported" as const;
  return options.reactSelect(
    element,
    (labels) =>
      matchOption(
        values,
        labels.map((label) => ({ label, value: label })),
        globals,
      )?.label,
    values,
  );
}

async function fillFallback(
  element: Element,
  values: string[],
  root: Document,
  globals: GlobalConfig,
  options: InterpreterOptions,
) {
  const executor = options.execute || defaultExecute;
  const execute = (request: MethodRequest) =>
    executor({ ...request, guardElement: element });
  if (element.matches('button[aria-haspopup="listbox"]')) {
    // A dropdown already showing an acceptable answer is left as it is: Jabil's
    // Degree showed "Masters" and its list was opened for nothing, and left
    // open (2026-10-16).
    // (A degree in any of its wordings: an education row's fallback has only
    // the profile's "Masters of Science".)
    const shown = element.textContent?.trim() || "";
    if (shown && matchOption([...values, ...values.flatMap(degreeAliases)], [{ label: shown, value: shown }], globals)) return true;
    // A previous attempt may have left this dropdown open; clicking again
    // would close it.
    const opened = element.getAttribute("aria-expanded") !== "true";
    if (
      opened &&
      !(await execute({
        element,
        globals,
        method: "click",
        signal: options.signal,
        values: [],
      }))
    )
      return false;
    // Options render into a popup after the click.
    let available: Element[] = [];
    for (let attempt = 0; attempt < 12 && !available.length; attempt++) {
      await sleep(100, options.signal);
      available = documents(root).flatMap((document) => [
        ...document.querySelectorAll(
          '[data-automation-activepopup="true"] [data-automation-id="promptLeafNode"],[data-automation-id="activeListContainer"] [data-automation-id="promptLeafNode"],[role="listbox"] [role="option"]',
        ),
      ]);
    }
    const option = matchOption(
      values,
      available.map((candidate) => ({
        label: candidate.textContent?.trim() || "",
        value: candidate.textContent?.trim() || "",
      })),
      globals,
    );
    const selected = option
      ? available.find(
          (candidate) => (candidate.textContent?.trim() || "") === option.label,
        )
      : undefined;
    if (selected)
      return execute({
        element: selected,
        globals,
        method: "click",
        signal: options.signal,
        values: [],
      });
    // Nothing to choose: the list this opened is closed again, from its own
    // button, rather than left over the form. Workday's stays open after
    // that click; a press on the page around it closes it, as the site's own
    // rules do (Booz Allen's Veteran Status, report 424d47c0, 2026-11-02).
    if (opened && element.getAttribute("aria-expanded") === "true")
      await execute({ element, globals, method: "click", signal: options.signal, values: [] });
    const stillOpen = () => available.some((candidate) => candidate.isConnected && (candidate as HTMLElement).getClientRects().length > 0);
    if (opened && stillOpen()) {
      await sleep(150, options.signal);
      const around = documents(root).map((document) => document.querySelector('[data-automation-id="mainContent"]') || document.body).find(Boolean);
      if (around && stillOpen()) await execute({ element: around, guardElement: element, globals, method: "click", signal: options.signal, values: [] });
    }
    return false;
  }
  // Workday search prompts: typing alone leaves the field empty, the value
  // must be picked from the filtered list.
  if (
    element.matches('input[placeholder="Search"]') ||
    element.closest('[data-uxi-widget-type="multiselect"],[data-automation-id="multiSelectContainer"]')
  ) {
    for (const value of values) {
      if (
        !(await execute({
          element,
          globals,
          method: "keyType",
          signal: options.signal,
          values: [value],
        }))
      )
        continue;
      let available: Element[] = [];
      for (let attempt = 0; attempt < 15 && !available.length; attempt++) {
        await sleep(150, options.signal);
        available = documents(root).flatMap((document) => [
          ...document.querySelectorAll(
            '[data-automation-activepopup="true"] [data-automation-id="promptLeafNode"],[data-automation-id="activeListContainer"] [data-automation-id="promptLeafNode"],[role="listbox"] [role="option"]',
          ),
        ]);
      }
      const option = matchOption(
        [value],
        available.map((candidate) => ({
          label: candidate.textContent?.trim() || "",
          value: candidate.textContent?.trim() || "",
        })),
        globals,
      );
      const selected = option
        ? available.find(
            (candidate) => (candidate.textContent?.trim() || "") === option.label,
          )
        : undefined;
      if (
        selected &&
        (await execute({
          element: selected,
          globals,
          method: "click",
          signal: options.signal,
          values: [],
        }))
      )
        return true;
    }
    return false;
  }
  if (element.getAttribute("role") === "combobox") {
    const outcome = await viaReactSelect(element, values, globals, options);
    if (outcome === "selected") return true;
    // Never leave typed search text behind as if it were an answer.
    if (outcome === "no-match" || outcome === "skipped") return false;
    const run = (method: string, methodValues: string[] = []) =>
      execute({ element, globals, method, signal: options.signal, values: methodValues });
    // The open list's choices. Oracle's are grid cells ("cx-select__list-item"),
    // not options, and render a moment after the click or the search.
    // A combobox that names its list chooses only from that one: another
    // field's list left open over the form gave Veteran Status Gender's
    // "No Selection" (L3Harris, report 92f363c7).
    const own = ownLists(element);
    const listed = async () => {
      let available: Element[] = [];
      for (let attempt = 0; attempt < 10 && !available.length; attempt++) {
        await sleep(100, options.signal);
        available = documents(root).flatMap((document) =>
          [
            ...document.querySelectorAll(
              '[role="option"],[role="gridcell"][class*="cx-select__list-item"]',
            ),
          ].filter(
            (option) =>
              option.getAttribute("aria-disabled") !== "true" &&
              (option as HTMLElement).getClientRects().length > 0 &&
              (!own.length || own.some((id) => option.closest(`#${CSS.escape(id)}`))),
          ),
        );
      }
      return available;
    };
    const pick = (available: Element[]) => {
      const option = matchOption(
        values,
        available.map((candidate) => ({
          label: candidate.textContent?.trim() || "",
          value:
            candidate.getAttribute("data-value") ||
            candidate.textContent?.trim() ||
            "",
        })),
        globals,
      );
      return option
        ? available.find(
            (candidate) =>
              (candidate.textContent?.trim() || "") === option.label &&
              (candidate.getAttribute("data-value") ||
                candidate.textContent?.trim() ||
                "") === option.value,
          )
        : undefined;
    };
    // The click opens the full list (Oracle's race list): choose from it.
    // Only when it holds no match is a search typed, since some lists show
    // nothing until searched, and others ignore text a script writes.
    if (!(await run("click"))) return false;
    let selected = pick(await listed());
    if (!selected) {
      if (!(await run("clearValue")) || !(await run("defaultWithoutBlur", values))) return false;
      selected = pick(await listed());
    }
    if (!selected) {
      // Never leave typed search text behind as if it were an answer, nor
      // the search it started: a list still loading for it is closed too.
      await run("clearValue");
      dismissPopup(element);
      return false;
    }
    const chosen = await execute({
      element: selected,
      globals,
      method: "click",
      signal: options.signal,
      values: [],
    });
    // SuccessFactors checks a list only as focus leaves it: L3Harris's
    // Veteran Status, the last list of its section, kept "Veteran Status is
    // required" beside the pick, and the fill picked it again and again
    // (2026-11-07).
    // It checks only with its list closed (its _onBlur), and the list stays
    // open after a pick: Escape closes it, keeping the pick.
    if (chosen && element.matches('input.rcmpaginatedselectinput[role="combobox"]')) {
      await sleep(150, options.signal);
      if (element.getAttribute("aria-expanded") === "true") {
        dismissPopup(element);
        await sleep(150, options.signal);
      }
      await run("blur");
      // In a tab in the background the box may hold no focus to lose, and
      // no blur came (L3Harris, 2026-11-07): its own blur handler is called
      // with one.
      element.dispatchEvent(new FocusEvent("blur"));
    }
    return chosen;
  }
  return execute({
    element,
    globals,
    method: "react",
    signal: options.signal,
    values,
  });
}

// A row's fields with any group inside it opened up, its "name" called by
// the group's key (Workday's language row: language > name).
function flattenGroups(selectors: InputSelector[]): InputSelector[] {
  return selectors.flatMap(([key, choices]): InputSelector[] => {
    const plain = choices.filter((choice) => typeof choice === "string" || !choice.inputSelectors);
    const groups = choices.flatMap((choice) =>
      typeof choice === "string" || !choice.inputSelectors || choice.array
        ? []
        : flattenGroups(choice.inputSelectors.map(([child, inner]): InputSelector => [child === "name" ? key : child, inner])),
    );
    return [...(plain.length ? [[key, plain] as InputSelector] : []), ...groups];
  });
}

// The links for a form's Websites section: the profile's LinkedIn, GitHub
// and website, less any the form asks for in a box of its own (its LinkedIn
// field), so each is given once (the applicant, 2026-10-15).
function linksToShare(config: SiteConfig, profile: Profile, root: Document, context: Document | Element): string[] {
  const asked = (keys: string[]) =>
    config.inputSelectors.some(([name, choices]) =>
      keys.includes(name) &&
      choices.some((choice) =>
        paths(typeof choice === "string" ? choice : choice.path).some((path) =>
          queryXPathAll(root, path, path.startsWith(".") ? context : undefined).some((element) => element.isConnected),
        ),
      ),
    );
  const full = (value: string) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  return ([
    [["linkedin"], profile.linkedin],
    [["github"], profile.github],
    [["portfolio", "website", "personal_website"], profile.website],
  ] as [string[], string | undefined][])
    .filter(([keys, value]) => value?.trim() && !asked(keys))
    .map(([, value]) => full(value!.trim()));
}

// The profile's own row lists a page draws as repeated sections of fields.
type RowCollection = "education" | "experience" | "references";

async function fillRepeatedFallback(
  collection: RowCollection,
  context: Document | Element,
  root: Document,
  globals: GlobalConfig,
  profile: Profile,
  used: Set<Element>,
  options: InterpreterOptions,
) {
  const scopes = repeatedScopes(collection, context);
  const rows = {
    education: profile.education,
    experience: profile.work,
    references: profile.references || [],
  }[collection] as unknown[];
  const fields = {
    education: [
      "school",
      "degree",
      "major",
      "start_month",
      "start_year",
      "end_month",
      "end_year",
    ],
    experience: [
      "company",
      "title",
      "start_month",
      "start_year",
      "end_month",
      "end_year",
    ],
    // No site config covers references yet, so these labels are all the
    // engine has to go on.
    references: ["full_name", "relationship", "phone", "email"],
  }[collection];
  let filled = 0;
  for (const [index, scope] of scopes.entries()) {
    if (!rows[index]) break;
    for (const key of fields) {
      const values = canonicalValues(key, profile, { collection, index });
      const element = values.length ? labeledFallback(key, scope) : undefined;
      // A configured rule may have claimed this control and left it empty
      // (its conditions skipped every step), so "used" does not disqualify a
      // field that still has no value.
      if (
        !element ||
        options.isLocked?.(element) ||
        (textValue(element) && !options.isReplaceable?.(element))
      )
        continue;
      if (await fillFallback(element, values, root, globals, options)) {
        used.add(element);
        filled++;
      }
    }
  }
  return filled;
}

// Some forms ask for every reference in one box ("List three professional
// references… Name, Relationship, Phone Number and email"). Only a textarea
// qualifies: a single-line input with that label is asking something else.
async function fillReferencesText(
  context: Document | Element,
  root: Document,
  globals: GlobalConfig,
  profile: Profile,
  used: Set<Element>,
  options: InterpreterOptions,
) {
  const values = canonicalValues("references", profile);
  if (!values.length) return false;
  const element = labeledFallback("references", context, (candidate) =>
    isTag(candidate, "textarea"),
  );
  if (
    !element ||
    used.has(element) ||
    options.isLocked?.(element) ||
    textValue(element)
  )
    return false;
  if (!(await fillFallback(element, values, root, globals, options)))
    return false;
  used.add(element);
  return true;
}

function repeatedScopes(
  collection: RowCollection,
  context: Document | Element,
): Element[] {
  const pattern = {
    education: /education|academic/i,
    experience: /experience|employment|work history|workexperience/i,
    references: /reference/i,
  }[collection];
  const candidates = [
    ...context.querySelectorAll(
      'fieldset,section,[role="group"],.education--form,.education-form,.experience--form,.experience-form,.employment--form,.employment-form,[data-ui="education"],[data-ui="experience"]',
    ),
  ];
  const matches = candidates.filter((element) =>
    pattern.test(
      [
        // Workday names its rows "education-1" / "workExperience-1".
        element.getAttribute("data-automation-id"),
        element.getAttribute("data-fkit-id"),
        element.getAttribute("aria-label"),
        element.className,
        element.getAttribute("data-ui"),
        element.querySelector(
          ":scope > legend,:scope > h2,:scope > h3,:scope > h4",
        )?.textContent,
      ]
        .filter(Boolean)
        .join(" "),
    ),
  );
  return matches.filter(
    (element) =>
      !matches.some((other) => other !== element && element.contains(other)),
  );
}

const plainText = (value: string | null | undefined) =>
  (value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// What a row already says, for fields whose identity matches `pattern`:
// input values, selected options, and the text of custom dropdown anchors.
function rowValues(
  scope: Element,
  pattern: RegExp,
  ignore: (element: Element) => boolean = () => false,
) {
  return [
    ...scope.querySelectorAll("input,select,textarea,a[id],[role='combobox']"),
  ]
    .filter((element) => !ignore(element))
    // Hidden controls behind a custom dropdown (iCIMS keeps a native select
    // with the parser's pick) are not something the applicant entered.
    .filter((element) => (element as HTMLElement).getClientRects().length > 0)
    .filter(
      (element) =>
        !(
          element instanceof HTMLSelectElement &&
          element.id &&
          element.ownerDocument.getElementById(`${element.id}_icimsDropdown`)
        ),
    )
    .filter((element) =>
      pattern.test(
        `${element.id} ${element.getAttribute("name") || ""} ${element.getAttribute("aria-label") || ""}`,
      ),
    )
    .map((element) =>
      plainText(
        element instanceof HTMLSelectElement
          ? element.selectedOptions[0]?.text
          : element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement
            ? element.value
            : element.textContent,
      ),
    )
    .filter(
      (value) => value && !/make a selection|^select|type to search/.test(value),
    );
}

// Sites can pre-fill education rows from a parsed resume in their own order
// (iCIMS put one degree's major beside another's school). Pair each profile
// row with the page row that already names its school (or, weaker, its
// major) instead of filling rows by position. Unmatched rows keep position.
function matchHistoryRows(
  collection: "education" | "experience",
  rows: Profile["education"],
  scopes: Element[],
  isReplaceable: (element: Element) => boolean = () => false,
) {
  const matches = (value: string, wanted: string) =>
    Boolean(wanted) &&
    (value === wanted || value.includes(wanted) || wanted.includes(value));
  const pairs: { row: number; scope: number; score: number }[] = [];
  const exact: { row: number; scope: number }[] = [];
  rows.forEach((row, rowIndex) =>
    scopes.forEach((scope, scopeIndex) => {
      const organization = plainText(row.organization);
      const subject = plainText(row.fieldOfStudy || row.title);
      // A site's guesses (parsed from a resume) are no evidence of which
      // profile row a page row holds; only the applicant's entries are.
      const names = rowValues(
        scope,
        collection === "education"
          ? /school|university|institution|college/i
          : /company|employer|organization/i,
        isReplaceable,
      );
      const details = rowValues(
        scope,
        collection === "education" ? /major|discipline|field|study/i : /title|position/i,
        isReplaceable,
      );
      const shown = names.length
        ? []
        : rowValues(
          scope,
          collection === "education" ? /school|university|institution|college/i : /company|employer|organization/i,
          // Not a "school not listed" box: the row's own list names it.
          (element) => /other/i.test(`${element.id} ${element.getAttribute("name") || ""}`),
        );
      if (organization && shown.includes(organization)) exact.push({ row: rowIndex, scope: scopeIndex });
      const score =
        (names.some((value) => matches(value, organization)) ? 2 : 0) +
        (details.some((value) => matches(value, subject)) ? 1 : 0);
      if (score) pairs.push({ row: rowIndex, scope: scopeIndex, score });
    }),
  );
  // Without any entry of the applicant's, the site's own rows still say
  // which is which when each profile row's school or employer is shown
  // exactly, in a row of its own: AMD's iCIMS redrew two schools the other
  // way round, and paired by position each took the other's graduation and
  // "school not listed" box (2026-11-07). A parser's partial guesses (one
  // school shown twice, another nowhere) still give way to profile order.
  const exactRows = new Set(exact.map((pair) => pair.row));
  const exactScopes = new Set(exact.map((pair) => pair.scope));
  if (!pairs.length && rows.length > 1 && exactRows.size === rows.length && exactScopes.size === rows.length &&
      rows.every((_, row) => exact.filter((pair) => pair.row === row).length === 1))
    for (const pair of exact) pairs.push({ ...pair, score: 2 });
  const assigned = new Map<number, Element>();
  const taken = new Set<number>();
  for (const pair of pairs.sort((a, b) => b.score - a.score || a.row - b.row))
    if (!assigned.has(pair.row) && !taken.has(pair.scope)) {
      assigned.set(pair.row, scopes[pair.scope]);
      taken.add(pair.scope);
    }
  // Everything else follows the profile's order down the page.
  const free = scopes.filter((_, index) => !taken.has(index));
  rows.forEach((_, rowIndex) => {
    if (!assigned.has(rowIndex) && free.length)
      assigned.set(rowIndex, free.shift()!);
  });
  return assigned;
}

function historySelectors(
  selectors: InputSelector[],
  collection: "education" | "experience",
  index: number,
): InputSelector[] {
  const substitute = (value: unknown): any => {
    if (typeof value === "string")
      return value
        .replaceAll("%INDEX0%", String(index))
        .replaceAll("%NUMBER0%", String(index + 1));
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, substitute(entry)]),
      );
    return value;
  };
  const flattened: InputSelector[] = [];
  for (const [key, choices] of selectors) {
    const plain = choices.filter(
      (choice) => typeof choice === "string" || !choice.inputSelectors,
    );
    if (plain.length) flattened.push([key, substitute(plain)]);
    for (const choice of choices) {
      if (typeof choice === "string" || !choice.inputSelectors || choice.array)
        continue;
      const nested = choice.inputSelectors.map(
        ([child, selectors]): InputSelector => [
          child === "name"
            ? key === "education"
              ? "school"
              : key === "company"
                ? "company"
                : key
            : child,
          selectors,
        ],
      );
      flattened.push(...historySelectors(nested, collection, index));
    }
  }
  return flattened;
}

// Oracle saves each education or experience entry with a button that is,
// to the browser, a submit button of the whole application form; the page's
// own click handler saves the entry instead. It may be clicked only when it
// sits inside the section being filled, is none of the site's Submit buttons
// and is not labelled as a submit or certification, and the click itself is
// made with every form submission blocked (content.ts), so no form can be
// submitted by it whatever the page does.
function entrySave(element: Element, scope: Element | undefined, forbidden: Set<Element>) {
  if (!scope || !isTag(element, "button") || !scope.contains(element)) return false;
  return (
    ![...forbidden].some((submit) => submit === element || element.contains(submit)) &&
    !dangerousLabel.test(labelOf(element))
  );
}

function isForbiddenClick(
  element: Element,
  forbidden: Set<Element>,
  checkLabel = true,
  scope?: Element,
) {
  for (
    let node: Element | null = element;
    node;
    node = node.parentElement || (node.getRootNode() as ShadowRoot).host || null
  ) {
    if ([...forbidden].some((item) => item === node)) return true;
    if (
      isTag(node, "button") &&
      (node as HTMLButtonElement).type === "submit" &&
      (node as HTMLButtonElement).form &&
      !entrySave(node, scope, forbidden)
    )
      return true;
    if (node.matches('input[type="submit"],input[type="image"]')) return true;
    if (
      checkLabel &&
      node.matches('button,a,[role="button"]') &&
      dangerousLabel.test(labelOf(node))
    )
      return true;
  }
  return false;
}

// A click on the page around the field being filled (Workday's
// "//div[@id='mainContent']", which closes the field's list) lands on no
// control inside it: only the field's own lock counts, and the field is
// judged on its own. Judged by every control within, one answer the
// applicant gave by hand anywhere on the page refused it, and each list was
// left open over the form (Citi, report aad8b81e, 2026-10-27).
export function clicksAround(element: Element, field: Element | undefined, method: string | undefined, event?: string) {
  return Boolean(field && field !== element && element.contains(field)) &&
    (["click", "reactClick"].includes(method || "") || event === "click");
}

// A list's empty choice ("No Selection") is no answer, though "No" begins
// it: SuccessFactors' Hispanic rule, matching an "Ethnicity/Race" list,
// picked it for the answer No and kept the race rule out (WEC Energy Group,
// report 6c3b81b6, 2026-10-15).
// The field itself is never one: a click that opens its list targets it,
// and Rippling's dropdowns show "Select..." until answered, so their
// Hispanic and Veteran questions were never opened (report ee348448,
// 2026-11-01).
function placeholderOption(target: Element, values: string[], base?: Element): boolean {
  if (target === base) return false;
  const text = normalize(target.textContent || "");
  return /^(no selection|select( one| an option)?|please select|choose( one)?|none selected|-+|-- select --)$/.test(text) &&
    !values.some((value) => normalize(value) === text);
}

// An option in a list another control owns is not this control's to pick.
// SuccessFactors draws each picklist's options in one overlay, and a list
// that came late for the field before took the next field's pick (report
// b3028a5e, 2026-10-14).
// The lists a field names as its own (aria-owns, aria-controls).
function ownLists(element: Element): string[] {
  return `${element.getAttribute("aria-owns") || ""} ${element.getAttribute("aria-controls") || ""}`.split(/\s+/).filter(Boolean);
}

// The control a field's own steps opened a list from: an "If other" box's
// rule opens the list beside it to choose its "Other" (SuccessFactors), and
// that list is then the box's to pick from (Expand Energy, 2026-10-29).
const openedFor = new WeakMap<Element, Element>();

function ownedElsewhere(target: Element, base: Element): boolean {
  const list = target === base ? null : target.closest('[role="listbox"][id]');
  if (!list) return false;
  const opened = openedFor.get(base);
  if (opened && ownLists(opened).includes(list.id)) return false;
  // A field that names its list takes no option from another: one left open
  // by a field the site has since rebuilt has no owner left on the page, and
  // its "Malaysia" was picked for Gender's "M" (L3Harris, report 92f363c7).
  const own = ownLists(base);
  if (own.length) return !own.includes(list.id);
  const owner = [...(list.getRootNode() as Document | ShadowRoot).querySelectorAll("[aria-owns],[aria-controls]")].find((element) =>
    `${element.getAttribute("aria-owns") || ""} ${element.getAttribute("aria-controls") || ""}`.split(/\s+/).includes(list.id));
  return Boolean(owner && owner !== base && !owner.contains(base) && !base.contains(owner));
}

// The list a button has open (aria-expanded, aria-controls), loaded and
// unchanged for a second, holds no option the step is waiting for: the rest
// of the wait finds nothing more. Each miss cost KLA's Workday form its full
// four seconds (degree, levels, demographics), so a page took minutes
// (report 6d839e90, 2026-11-04). The step then fails as it would have.
function openListSettled(root: Document, options: InterpreterOptions) {
  let seen = "";
  let since = 0;
  return () => {
    const now = (options.now || Date.now)();
    const opener = root.querySelector('[aria-expanded="true"][aria-controls]');
    const list = opener && root.getElementById((opener.getAttribute("aria-controls") || "").split(/\s+/)[0]);
    const shown = list ? [...list.querySelectorAll('[role="option"]')].map((option) => option.textContent || "").join("\n") : "";
    if (!list || list.querySelectorAll('[role="option"]').length < 2) {
      seen = "";
      return false;
    }
    if (shown !== seen) {
      seen = shown;
      since = now;
      return false;
    }
    return now - since >= 1_000;
  };
}

// Steps that take the site's first entry for a value: a skill's other names
// (skill-names.ts) are only for when its own finds nothing, and the library's
// "Python (Programming Language)", listed first, is not passed over for a
// stray "python" further down (2026-11-04).
const siteOrdered = new WeakSet<object>();

function heldBy(field: Element, values: string[]) {
  const plain = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  return [...(field.closest('[data-automation-id="multiSelectContainer"]')?.querySelectorAll('[data-automation-id="selectedItem"]') || [])].some((item) => {
    const shown = plain(item.getAttribute("title") || item.textContent || "");
    return values.some((value) => {
      const wanted = plain(value);
      return Boolean(wanted) && (shown === wanted || shown.startsWith(`${wanted} (`) || shown.endsWith(` (${wanted})`));
    });
  });
}

async function runAction(
  action: FillAction,
  base: Element,
  inputPath: string,
  values: string[],
  root: Document,
  container: Document | Element,
  forbidden: Set<Element>,
  globals: GlobalConfig,
  options: InterpreterOptions,
) {
  if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (action.delay) await sleep(action.delay, options.signal);
  const value = values[0] || "";
  const actionPaths = (values.length ? values : [""]).flatMap((candidate) =>
    paths(action.path).map((path) =>
      replacePlaceholders(path, inputPath, candidate),
    ),
  );
  const conditions = paths(action.condition).map((path) =>
    replacePlaceholders(path, inputPath, value),
  );
  if (
    conditions.length &&
    !conditions.some((path) => queryXPathAll(root, path, container).length)
  )
    return true;
  let target = base;
  // "%INPUTPATH%/." is the matched field itself. Re-running the configured
  // path could find a different first match (iCIMS's school search box
  // before "Other School"), so the matched element is used as it is.
  const selfOnly =
    paths(action.path).length > 0 &&
    paths(action.path).every((path) => /^%INPUTPATH%(\/\.)?$/.test(path.trim()));
  if (actionPaths.length && !selfOnly) {
    const timeout = action.removedTime ?? action.time;
    const found =
      action.removed || timeout
        ? await waitFor(
            root,
            actionPaths,
            container,
            timeout ?? 0,
            Boolean(action.removed),
            options,
            action.removed ? undefined : (element) => !ownedElsewhere(element, base) && !placeholderOption(element, values, base),
            // Only a list a button opens: a search's list stays as it was
            // until its answer comes, and Sonos's skills answered after a
            // second, past this wait (2026-11-04).
            action.removed || !base.matches('button[aria-haspopup="listbox"]') ? undefined : openListSettled(root, options),
          )
        : actionPaths.flatMap((path) =>
            queryXPathAll(
              root,
              path,
              path.startsWith(".") ? container : undefined,
            ),
          ).find((element) => !ownedElsewhere(element, base) && !placeholderOption(element, values, base));
    if (action.removed) {
      if (found) return true;
      throw new Error("Action target was not removed before timeout.");
    }
    if (!found) throw new Error("Action target was not found before timeout.");
    target = found;
    // An option that is one of the values, whatever its case, is taken over
    // a looser match of a value before it, the earliest value first: the
    // generic "Bachelor" chose "Bachelor in Business Administration" by its
    // start while "Bachelor of Science" was listed (Expand Energy,
    // 2026-10-29). Value order still decides among exact ones ("fluent"
    // before "Intermediate", both listed). Punctuation does not count:
    // "Pennsylvania State University-University Park" is the
    // profile's "…University, University Park", and the list's "…University
    // University Park Dietetic Internship", before it, is not (report
    // 8f198b5b).
    if (values.length > 1 && !selfOnly && !siteOrdered.has(action)) {
      const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const rank = (element: Element) =>
        values.findIndex((candidate) => {
          const wanted = plain(candidate);
          return Boolean(wanted) && (plain(element.textContent || "") === wanted || plain(element.getAttribute("title") || "") === wanted);
        });
      const exact = actionPaths
        .flatMap((path) => queryXPathAll(root, path, path.startsWith(".") ? container : undefined))
        .filter((element) => !ownedElsewhere(element, base) && !placeholderOption(element, values, base))
        .map((element) => [element, rank(element)] as const)
        .filter(([, index]) => index >= 0)
        .sort((a, b) => a[1] - b[1])[0];
      if (exact && (rank(found) < 0 || exact[1] < rank(found))) target = exact[0];
    }
  } else if (action.time) {
    await sleep(action.time, options.signal);
  }
  // A skill the search's own Enter already added (one match is taken at once:
  // Axiom Space's "PyTorch") is not clicked again: a second click takes it
  // back off (2026-11-04). Judged once its option has appeared, when the
  // site's own pick has been made.
  // Only the pick itself: the step after it that closes the list (a press on
  // the page) still runs, or the list stayed open over the form (Axiom
  // Space, 2026-11-04).
  if (siteOrdered.has(action) && target !== base &&
      target.closest('[role="listbox"],[role="option"],[data-automation-id="activeListContainer"],[data-automation-activepopup="true"],[data-automation-id="promptOption"]') &&
      heldBy(base, values)) return true;
  const mutates = action.method
    ? !nonMutatingMethods.has(action.method)
    : Boolean(action.event);
  // A step that removed its own starting point ("Remove Resume", after
  // which the site shows an empty upload slot) acts on what replaced it:
  // the element gone from the page no longer guards the next one.
  const baseGone = target !== base && !base.isConnected && target.isConnected;
  if (
    mutates &&
    ((!baseGone && options.isLocked?.(base)) ||
      (target !== base && !clicksAround(target, base, action.method, action.event) && options.isLocked?.(target)))
  )
    throw new Error("Field is locked by a trusted user edit.");
  if (
    (["click", "reactClick"].includes(action.method || "") ||
      action.event === "click") &&
    isForbiddenClick(target, forbidden, true, options.context)
  )
    throw new Error("Refused to activate a submit or certification control.");
  if (mutates && target.matches('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"],[role="option"]') &&
      /^(?:other|not listed)(?:$|\s*[(:])/i.test(labelOf(target)) &&
      !values.some((candidate) => /^(?:other|not listed)$/i.test(candidate.trim())))
    throw new Error("Other is not a fallback for an unconfirmed option.");
  if (!action.method && !action.event) return true;
  if (target !== base && ownLists(target).length && (action.method === "click" || action.event === "click")) openedFor.set(base, target);
  return (options.execute || defaultExecute)({
    action,
    element: target,
    guardElement: base,
    globals,
    method: action.method || "event",
    signal: options.signal,
    values: [...values],
  });
}

function selectPath(selector: SelectorConfig, values: string[]) {
  if (selector.valuePathMap) {
    for (const value of values) {
      const candidates = [value];
      if (/^yes$/i.test(value)) candidates.push("true", "1");
      if (/^no$/i.test(value)) candidates.push("", "false", "0");
      for (const candidate of candidates) {
        const entry = Object.entries(selector.valuePathMap).find(
          ([key]) =>
            key === candidate || key.toLowerCase() === candidate.toLowerCase(),
        );
        if (entry) return paths(entry[1]);
      }
    }
  }
  return paths(selector.path);
}

export async function interpretConfig(
  root: Document,
  url: string,
  config: SiteConfig,
  globals: GlobalConfig,
  profile: Profile,
  options: InterpreterOptions = {},
): Promise<FillStatus[]> {
  if (!matchesSiteConfig(config, url, root)) return [];
  const foundContainer =
    options.context ||
    config.containerPath.flatMap((path) => queryXPathAll(root, path))[0];
  if (config.containerRequired && !foundContainer)
    return config.inputSelectors.map(([key]) => ({
      key,
      status: "skipped" as const,
      reason: "Required form container was not found.",
    }));
  const container =
    foundContainer && isTag(foundContainer, "iframe")
      ? (foundContainer as HTMLIFrameElement).contentDocument || foundContainer
      : foundContainer;
  const context = container || root;
  const scopedContext = container ? context : undefined;
  const forbidden = new Set(
    config.submitButtonPaths.flatMap((path) => queryXPathAll(root, path)),
  );
  const used = options.used || new Set<Element>();
  const executor = options.execute || defaultExecute;
  options = {
    ...options,
    execute: async (request) => {
      if (options.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      if (
        (!clicksAround(request.element, request.guardElement, request.method, request.action?.event) && options.isLocked?.(request.element)) ||
        (request.guardElement &&
          // As above: a guard the step itself removed guards nothing.
          !(request.guardElement !== request.element && !request.guardElement.isConnected && request.element.isConnected) &&
          options.isLocked?.(request.guardElement))
      )
        throw new Error("Field is locked by a trusted user edit.");
      const currentForbidden = new Set(
        config.submitButtonPaths.flatMap((path) => queryXPathAll(root, path)),
      );
      const clicks =
        ["click", "reactClick"].includes(request.method) ||
        request.action?.event === "click";
      // A row's own pass wraps this one and checks against the row; an
      // entry save it already verified is not re-judged without the row.
      const save =
        clicks &&
        (request.entrySave || entrySave(request.element, options.context, currentForbidden));
      if (!save && isForbiddenClick(request.element, currentForbidden, clicks, options.context))
        throw new Error(
          "Refused to activate a submit or certification control.",
        );
      if (!nonMutatingMethods.has(request.method) &&
          request.element.matches('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"],[role="option"]') &&
          /^(other\b|not listed\b)/i.test(labelOf(request.element)) &&
          !request.values.some((value) => /^(other|not listed)$/i.test(value.trim()) || normalize(value) === normalize(labelOf(request.element))))
        throw new Error("Other is not a fallback for an unconfirmed option.");
      if ((request.method === "click" || request.method === "reactClick" || (request.method === "event" && request.action?.event === "click")) &&
          request.element.matches('option,[role="option"]') && request.values.length &&
          // Its name as shown counts too: Workday names each search result
          // with its state ("Data Science not checked"), and KLA's field of
          // study was never picked (2026-11-03).
          ![labelOf(request.element), normalize(request.element.textContent || "")].some((label) =>
            Boolean(label) && matchOption(request.values, [{ label, value: request.element.getAttribute("value") || label }], globals)))
        throw new Error("The configured option does not exactly match a confirmed value.");
      const accepted = await executor({
        ...request,
        forbidden: currentForbidden,
        entrySave: save,
      });
      if (options.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      return accepted;
    },
  };
  const results: FillStatus[] = [];
  const notMatched = "No configured selector matched.";

  // Country first on Workday, Greenhouse and Ashby: a site
  // redraws its state list, postal format and phone code when the country
  // changes, and can clear a state or city filled before it. A country not on
  // the page yet (behind a section the rules open) is tried again in its own
  // place.
  const order = [
    ...config.inputSelectors.filter(([key]) => key === "country").map((entry) => ({ entry, early: true })),
    ...config.inputSelectors.map((entry) => ({ entry, early: false })),
  ];
  const earlyCountry = order.some(({ early }) => early);
  for (const { entry: [key, choices], early } of order) {
    if (key === "country" && earlyCountry && !early) {
      const tried = results.filter((result) => result.key === key);
      if (tried.some((result) => result.status !== "failed" || result.reason !== notMatched)) continue;
      for (const result of tried) results.splice(results.indexOf(result), 1);
    }
    if (options.onlyKeys && !options.context && !options.onlyKeys.includes(key)) continue;
    if (options.skipKeys && !options.context && options.skipKeys.includes(key)) continue;
    if (options.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    // iCIMS pairs the school list with an "Other School" text box that is
    // only for schools missing from the list.
    if (key === "name_optional") {
      const school = results.find((result) => result.key === "school");
      if (
        school &&
        (school.status === "filled" ||
          /already has a value|locked/i.test(school.reason || ""))
      ) {
        results.push({
          key,
          status: "skipped",
          reason: "The school was chosen from the list; Other School is not needed.",
        });
        continue;
      }
    }
    let lastReason = notMatched;
    let lastStatus: "skipped" | "failed" = "failed";
    let completed = false;
    const addedRows = new Set<number>();
    selectorChoices: for (const choice of choices) {
      const selector: SelectorConfig =
        typeof choice === "string" ? { path: choice } : choice;
      if (selector.manual) {
        lastReason = "Configuration requires manual input.";
        lastStatus = "skipped";
        continue;
      }
      if (selector.array || selector.inputSelectors) {
        const collection =
          key === "education"
            ? "education"
            : key === "experience"
              ? "experience"
              : undefined;
        // Lists the profile keeps as plain values, one row each: languages,
        // and the links a form's Websites section takes (Workday, report
        // f062d50f, 2026-10-15).
        const list = key === "language" ? "languages" : key === "websites" ? "websites" : undefined;
        if (list && selector.array && selector.inputSelectors) {
          // A link the page already holds (the site read it from the resume)
          // is not added again, and a row holding one is left as it is: KLA's
          // Workday listed GitHub twice (report 5c049c5a, 2026-11-02).
          const linkKey = (value: string) => value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
          const held = (row: Element) =>
            [...row.querySelectorAll<HTMLInputElement>('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')].map((input) => input.value).filter((value) => value.trim());
          const onPage = new Set(
            list === "websites"
              ? paths(selector.containerPath)
                  .flatMap((path) => Array.from({ length: 20 }, (_, n) => queryXPathAll(root, path.replaceAll("%INDEX0%", String(n)).replaceAll("%NUMBER0%", String(n + 1)), context)).flat())
                  .flatMap(held)
                  .map(linkKey)
              : [],
          );
          const items = list === "languages"
            ? profileLanguages(profile.languages).map((row) => row.language)
            : linksToShare(config, profile, root, context).filter((link) => !onPage.has(linkKey(link)));
          let count = 0;
          // What a row's fill wants the applicant to look at (a closest pick).
          const cautions: string[] = [];
          const visited = new Set<Element>();
          for (let index = 0; index < Math.min(items.length, selector.limit ?? items.length); index++) {
            const substitute = (path: string) =>
              path.replaceAll("%INDEX0%", String(index)).replaceAll("%NUMBER0%", String(index + 1));
            const free = (row: Element) => !visited.has(row) && !(list === "websites" && held(row).length);
            // Its own number first; for links, any empty row the site
            // numbered otherwise (the first one held the site's GitHub, and
            // the row added after it was confirmed by the first's number).
            const rowAt = () =>
              paths(selector.containerPath)
                .flatMap((path) => queryXPathAll(root, substitute(path), context))
                .find(free) ||
              (list === "websites"
                ? paths(selector.containerPath)
                    .flatMap((path) => Array.from({ length: 20 }, (_, n) => queryXPathAll(root, path.replaceAll("%INDEX0%", String(n)).replaceAll("%NUMBER0%", String(n + 1)), context)).flat())
                    .find(free)
                : undefined);
            let scope = rowAt();
            if (!scope && selector.addButtonPath) {
              const add = paths(selector.addButtonPath)
                .flatMap((path) => queryXPathAll(root, path, context))
                .find((candidate) => candidate.isConnected);
              if (!add || options.isLocked?.(add) || isForbiddenClick(add, forbidden)) break;
              if (!(await (options.execute || defaultExecute)({ element: add, globals, method: "click", signal: options.signal, values: [] }))) break;
              const confirmed = await waitFor(root, paths(selector.confirmAddedPath).map(substitute), context, selector.time ?? 5_000, false, options);
              scope = rowAt() || (confirmed && (list !== "websites" || free(confirmed)) ? confirmed : undefined);
            }
            if (!scope) {
              lastReason = `The added ${list} row was not confirmed.`;
              lastStatus = "failed";
              break;
            }
            visited.add(scope);
            const statuses = await interpretConfig(
              root,
              url,
              { ...config, containerPath: [], containerRequired: false, inputSelectors: flattenGroups(selector.inputSelectors) },
              globals,
              profile,
              { ...options, context: scope, valueContext: { collection: list, index, item: items[index] }, used },
            );
            count += statuses.filter((status) => status.status === "filled").length;
            for (const status of statuses) {
              if (status.status === "failed") results.push({ ...status, key: `${key}[${index}].${status.key}` });
              if (status.status === "filled" && status.caution) cautions.push(status.caution);
            }
          }
          if (count) {
            results.push({ key, status: "filled", ...(cautions.length ? { caution: cautions.join(" ") } : {}) });
            completed = true;
            break;
          }
          lastReason ||= "Repeated section requires a profile row.";
          lastStatus = "skipped";
          continue;
        }
        if (collection && selector.inputSelectors) {
          const rows =
            collection === "education" ? profile.education : profile.work;
          let count = 0;
          // A row's cautions (a closest pick, a search left unpicked) were
          // dropped with its count; the applicant needs to see them.
          const cautions: string[] = [];
          const visitedScopes = new Set<Element>();
          // Every row on the page, in the order they appear.
          const pageRows = () => {
            const addButton = paths(selector.addButtonPath)
              .flatMap((path) => queryXPathAll(root, path, context))
              .find((candidate) => candidate.isConnected);
            const detected = repeatedScopes(collection, context).filter(
              (candidate) => !addButton || !candidate.contains(addButton),
            );
            // Row numbers in container ids are the site's own (iCIMS numbers
            // its rows 3, 1, 2 down the page), so collect every row and use
            // the order they appear in.
            const found: Element[] = [];
            for (let number = 0; number <= rows.length + 20; number++)
              for (const path of paths(selector.containerPath))
                for (const scope of queryXPathAll(
                  root,
                  path
                    .replaceAll("%INDEX0%", String(number))
                    .replaceAll("%NUMBER0%", String(number)),
                  context,
                ))
                  // A fallback can name an ancestor of an already found row
                  // (Citi's education section); it is still the same entry.
                  if (!found.some((row) => row === scope || row.contains(scope) || scope.contains(row))) found.push(scope);
            for (const scope of detected)
              if (
                !found.includes(scope) &&
                !found.some((row) => row.contains(scope) || scope.contains(row))
              )
                found.push(scope);
            return found.sort((a, b) =>
              a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
            );
          };
          const existingScopes = pageRows();
          // Rows that were on the page, or added already, are other entries:
          // a row added for this one must be a new one.
          const knownRows = [...existingScopes];
          // A container a site reuses for each entry (Oracle's, below) is new
          // again once empty.
          const fresh = (element: Element) =>
            ![...element.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),textarea')].some(
              (control) => (control as HTMLInputElement).value,
            );
          const knownRow = (row: Element) =>
            !(selector.allowReuse && fresh(row)) && knownRows.some((known) => known === row || known.contains(row) || row.contains(known));
          let matchedScopes = existingScopes.length
            ? matchHistoryRows(collection, rows, existingScopes, (element) =>
                Boolean(options.isReplaceable?.(element)),
              )
            : new Map<number, Element>();
          // Oracle shows the entries already saved to the candidate's profile
          // as tiles with no fields: the title and subtitle name the job and
          // employer (or major) and its dates. A profile row a tile already
          // names is kept, not added again (egug.fa.us2.oraclecloud.com,
          // report e5a51b64).
          // Each piece of text on its own: Workable's cards put "Title" and
          // "Software Engineer Intern" in elements with no space between
          // them (report c98cf17c, 2026-10-31).
          const tileText = (tile: Element) => {
            const pieces: string[] = [];
            const walker = tile.ownerDocument.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) pieces.push(node.textContent || "");
            return pieces.join(" ");
          };
          const savedTileElements = paths(selector.savedRowPath)
            .flatMap((path) => queryXPathAll(root, path, context));
          const savedTiles = savedTileElements.map((tile) => ` ${plainText(tileText(tile))} `);
          // A saved entry is an existing row too: Workable draws a new entry's
          // editor first in its list, and the confirmation, by position, named
          // the saved MSU card instead. Nothing of Penn State's went in, the
          // editor was never saved, and MSU's name reached it from the page's
          // first school (report bb39258c, 2026-10-31).
          knownRows.push(...savedTileElements.filter((tile) => !tile.querySelector('input:not([type="hidden"]),textarea,select')));
          const saved = new Set(
            rows.flatMap((row, index) => {
              if (!savedTiles.length) return [];
              const subject = plainText(row.fieldOfStudy || row.title);
              const organization = plainText(row.organization);
              const year = row.startDate?.match(/\d{4}/)?.[0];
              // The same school or employer from the same year is that row,
              // however the tile names the subject: Nokia's tile said "Data
              // Science" for the profile's "M.S. Data Science, Analytics &
              // Engineering", and the degree was added again (report 1f68e4f9).
              return savedTiles.some(
                (tile) =>
                  (Boolean(subject) &&
                    tile.includes(` ${subject} `) &&
                    ((Boolean(organization) && tile.includes(` ${organization} `)) ||
                      (Boolean(year) && tile.includes(` ${year} `)))) ||
                  (Boolean(organization) && tile.includes(` ${organization} `) &&
                    Boolean(year) && tile.includes(` ${year} `)),
              )
                ? [index]
                : [];
            }),
          );
          // An entry already saved is no open row's: the rows still open
          // are matched among the profile's unsaved ones only. An editor a
          // cut-off pass left open (SmartRecruiters' second school, its fields in
          // shadow roots no match could read) went by page order to the saved
          // first school, the second was added again, and the open one was
          // never saved (report a8c856cd, 2026-11-05).
          if (saved.size && existingScopes.length) {
            const unsaved = rows.map((row, index) => ({ row, index })).filter(({ index }) => !saved.has(index));
            const rematched = matchHistoryRows(collection, unsaved.map(({ row }) => row), existingScopes, (element) =>
              Boolean(options.isReplaceable?.(element)),
            );
            matchedScopes = new Map([...rematched].map(([at, scope]) => [unsaved[at].index, scope]));
          }
          options.note?.({
            rows: collection,
            profileRows: rows.length,
            pageRows: existingScopes.length,
            matched: [...matchedScopes.keys()],
            ...(saved.size ? { saved: [...saved] } : {}),
          });
          for (
            let index = 0;
            index < Math.min(rows.length, selector.limit ?? rows.length);
            index++
          ) {
            if (saved.has(index)) continue;
            const substituteIndex = (path: string) =>
              path
                .replaceAll("%INDEX0%", String(index))
                .replaceAll("%NUMBER0%", String(index + 1));
            const containerPaths = paths(selector.containerPath);
            // Workday numbers its rows arbitrarily ("education-184"), so a
            // configured container path keyed on the row index often misses;
            // structural detection finds the row either way. A section that
            // holds the Add button is not a row.
            const addButton = paths(selector.addButtonPath)
              .flatMap((path) => queryXPathAll(root, path, context))
              .find((candidate) => candidate.isConnected);
            const detectedScopes = () =>
              repeatedScopes(collection, context).filter(
                (candidate) => !addButton || !candidate.contains(addButton),
              );
            let scope: Element | undefined = matchedScopes.size
              ? matchedScopes.get(index)
              : containerPaths.flatMap((path) =>
                  queryXPathAll(root, substituteIndex(path), context),
                )[0] || detectedScopes()[index];
            options.note?.({ rows: collection, index, scope: Boolean(scope), add: !scope && Boolean(selector.addButtonPath) });
            if (!scope && selector.addButtonPath) {
              if (!addedRows.has(index)) {
                const add = paths(selector.addButtonPath)
                  .flatMap((path) => queryXPathAll(root, path, context))
                  .find((candidate) => candidate.isConnected);
                if (!add) {
                  lastReason = `No Add button was found for ${collection}.`;
                  lastStatus = "skipped";
                  break selectorChoices;
                }
                if (options.isLocked?.(add)) {
                  lastReason = "Field is locked by a trusted user edit.";
                  lastStatus = "skipped";
                  break selectorChoices;
                }
                if (isForbiddenClick(add, forbidden)) {
                  lastReason =
                    "Refused to activate a submit or certification control.";
                  lastStatus = "failed";
                  break selectorChoices;
                }
                const added = await (options.execute || defaultExecute)({
                  element: add,
                  globals,
                  method: "click",
                  signal: options.signal,
                  values: [],
                });
                if (!added) {
                  lastReason = `The ${collection} Add button was not accepted.`;
                  lastStatus = "failed";
                  break selectorChoices;
                }
                addedRows.add(index);
              }
              const confirmation = paths(selector.confirmAddedPath).map(
                substituteIndex,
              );
              if (confirmation.length)
                scope = await waitFor(
                  root,
                  confirmation,
                  context,
                  selector.time ?? 5_000,
                  false,
                  options,
                );
              // A confirmation can name a field inside the new row
              // (SuccessFactors' points at the row's Company input); the row
              // itself is what its fields are found in.
              if (scope) {
                const confirmed = scope;
                scope =
                  containerPaths
                    .flatMap((path) => queryXPathAll(root, substituteIndex(path), context))
                    .find((row) => row === confirmed || row.contains(confirmed)) ||
                  detectedScopes().find((row) => row === confirmed || row.contains(confirmed)) ||
                  confirmed;
              }
              // The confirmation is index-keyed, and with the page's rows
              // matched out of order it names one of them: Westinghouse's
              // SuccessFactors had Penn State's row first, MSU was added as the
              // first entry, and MSU's school went into Penn State's row before
              // the new one was drawn (report cc40f1fb). Only a new row will do.
              if (scope && knownRow(scope)) scope = undefined;
              // Accept a newly rendered row that structural detection can see.
              if (!scope) {
                const deadline = (options.now?.() ?? Date.now()) + (selector.time ?? 5_000);
                while (!scope && (options.now?.() ?? Date.now()) < deadline) {
                  await sleep(options.pollMs ?? 100, options.signal);
                  scope = [
                    ...containerPaths.flatMap((path) => queryXPathAll(root, substituteIndex(path), context)),
                    ...pageRows(),
                  ].find((row) => !knownRow(row));
                }
              }
              if (!scope) {
                lastReason = `The added ${collection} row was not confirmed.`;
                lastStatus = "failed";
                break selectorChoices;
              }
              knownRows.push(scope);
            }
            // Oracle opens every entry's form in the same container. It is
            // used again only once empty (the entry before was saved): an
            // unsaved entry still showing its values is never overwritten.
            if (!scope || (visitedScopes.has(scope) && !(selector.allowReuse && fresh(scope)))) continue;
            visitedScopes.add(scope);
            const statuses = await interpretConfig(
              root,
              url,
              {
                ...config,
                containerPath: [],
                containerRequired: false,
                inputSelectors: historySelectors(
                  selector.inputSelectors,
                  collection,
                  index,
                ),
              },
              globals,
              profile,
              {
                ...options,
                context: scope,
                valueContext: { collection, index },
                used,
              },
            );
            count += statuses.filter(
              (status) => status.status === "filled",
            ).length;
            // What the row's own rules left is still the row's: a page-wide
            // rule (a second address's State and City) put the applicant's
            // home in Penn State's row, and its school list then held only
            // Arizona's (Expand Energy, 2026-10-29).
            for (const control of scope.querySelectorAll('input,select,textarea,[role="combobox"],[role="listbox"],button[aria-haspopup="listbox"]'))
              used.add(control);
            // Kept for diagnosis (issue reports): what each row could not do.
            for (const status of statuses) {
              if (status.status === "failed")
                results.push({ ...status, key: `${key}[${index}].${status.key}` });
              if (status.status === "filled" && status.caution) cautions.push(status.caution);
            }
          }
          if (count || saved.size) {
            results.push({ key, status: "filled", ...(cautions.length ? { caution: cautions.join(" ") } : {}) });
            completed = true;
            break;
          }
        }
        lastReason = "Repeated section requires a profile row.";
        lastStatus = "skipped";
        continue;
      }
      let values = selectorValues(
        key,
        selector,
        profile,
        globals,
        options.valueContext,
      );
      // A current job has no end date, so one the site filled in from the
      // resume is another job's ("05/27/2025" under a job still held, on
      // Westinghouse's SuccessFactors, report cc40f1fb): it is emptied.
      const emptiesEnd =
        !values.length &&
        /^(end|to)(_date)?(_|$)/.test(key) &&
        Boolean(options.valueContext?.collection) &&
        options.valueContext?.collection !== "education" &&
        profile.work[options.valueContext?.index || 0]?.endDate === "";
      if (emptiesEnd) values = [""];
      if (!values.length && selector.valueRequired !== false) {
        lastReason = "No confirmed profile value.";
        lastStatus = "skipped";
        continue;
      }
      // Try every candidate in preference order (as actions already do): an
      // answer's site phrase ("I am authorized") and its plain form ("Yes")
      // label different controls, and %VALUE% paths must reach either.
      const configuredPaths = [
        ...new Set(
          (values.length ? values : [""]).flatMap((candidate) =>
            selectPath(selector, values).map((path) =>
              replacePlaceholders(
                path,
                paths(selector.path)[0] || path,
                candidate,
              ),
            ),
          ),
        ),
      ];
      const candidates = configuredPaths
        .flatMap((path) =>
          queryXPathAll(
            root,
            path,
            path.startsWith(".") ? scopedContext : undefined,
          ),
        )
        .filter(
          (candidate) =>
            (selector.allowReuse || !used.has(candidate)) &&
            // The answer's broader wording ("Asian" for South Asian) is also a
            // word of other groups' names: a box naming one part of Asia is
            // taken only when it is the answer itself.
            !(
              key.replace(/_[234]$/, "") === "ethnicity" &&
              candidate.matches('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"]') &&
              /\b(east|south|southeast|south east|central|west)\s+asian\b/i.test(labelOf(candidate)) &&
              !values.some((value) => normalize(value) === normalize(labelOf(candidate)))
            ) &&
            // A dropdown's own search box is not a field: only the dropdown
            // handler types into it (iCIMS's "Other School" path otherwise
            // lands in the school search, whose list mentions "Other School").
            !(
              candidate.matches("input.dropdown-search") &&
              !/^(school|major|degree|name|discipline|country|state)$/.test(key)
            ),
        );
      // A candidate named exactly as one of the values is taken over a looser
      // match of a value before it, the earliest value first: "US" began "US
      // Virgin Islands" where "United States" was listed (SmartRecruiters'
      // phone country, Syngenta, 2026-11-02).
      const named = (candidate: Element) =>
        normalize(candidate.getAttribute("label") || candidate.getAttribute("aria-label") || (candidate.textContent || "").trim());
      const exactly = values.length > 1
        ? values.map((value) => candidates.find((candidate) => named(candidate) === normalize(value))).find(Boolean)
        : undefined;
      let element: Element | undefined = exactly || candidates[0];
      if (!element && selector.time)
        element = await waitFor(
          root,
          configuredPaths,
          context,
          selector.time,
          false,
          options,
        );
      if (!element) continue;
      if (/^(work_auth|sponsorship)$/.test(key.replace(/_[234]$/, "")) &&
          /^does your work authorization\b.*\binvolve (cpt|opt)\b/i.test(questionText(element))) {
        lastReason = "Generic authorization does not confirm CPT or OPT immigration status.";
        lastStatus = "skipped";
        continue;
      }
      if (key.replace(/_[234]$/, "") === "relocation" &&
          /^(please )?(provide|enter)\b.*\bpermanent address\b/i.test(questionText(element))) {
        lastReason = "A permanent address is not a willingness-to-relocate answer.";
        lastStatus = "skipped";
        continue;
      }
      if (key.replace(/_[234]$/, "") === "sponsorship" &&
          /\bassist/i.test(questionText(element)) &&
          !/sponsor|visa|authori[sz]|\b(require|need)\b.*\bassistance\b/i.test(questionText(element))) {
        lastReason = "Assistance in an unrelated question is not visa sponsorship.";
        lastStatus = "skipped";
        continue;
      }
      if (/^(work_auth|sponsorship)$/.test(key.replace(/_[234]$/, "")) &&
          /\b(proof|document\w*|temporary|permit type)\b/i.test(questionText(element))) {
        lastReason = "Authorization does not confirm documentary proof or immigration status.";
        lastStatus = "skipped";
        continue;
      }
      // Leave sponsorship-worded questions to the sponsorship key, which owns
      // that answer; filling them from the authorization answer inverts them.
      if (
        key.replace(/_[234]$/, "") === "work_auth" &&
        asksForSponsorship(element)
      ) {
        lastReason = "This question asks whether sponsorship is required.";
        lastStatus = "skipped";
        continue;
      }
      // A positive authorization-without-sponsorship question has the
      // opposite polarity of sponsorship. Let confirmed semantic matching
      // answer it; the sponsorship selector must not write a bare No.
      if (key.replace(/_[234]$/, "") === "sponsorship" && /\bwithout\b.*\bsponsor/i.test(questionText(element))) {
        lastReason = "This question asks whether the applicant can work without sponsorship.";
        lastStatus = "skipped";
        continue;
      }
      // A name asked of someone else is not the applicant's: Greenhouse's
      // "last name" label match filled "If you were referred by a current
      // Built employee, please list their first and last name" with the
      // applicant's (report 9b657c26, 2026-10-31).
      if (/^(?:first_name|last_name|full_name|middle_name|preferred_first_name|preferred_last_name|preferred_name)$/.test(key.replace(/_[234]$/, "")) &&
          /\brefer(?:red|ral|rer|ring)?\b|\bemergency\b|\btheir\b|\b(?:spouse|relative|recruiter|hiring manager)\b/i.test(questionText(element))) {
        lastReason = "This asks for someone else's name, not the applicant's.";
        lastStatus = "skipped";
        continue;
      }
      if (/^(?:current_company_name|company_name|current_company)$/.test(key.replace(/_[234]$/, "")) &&
          /non[ -]?(?:compete|disclosure|solicitation)|post[ -]?employment agreement/i.test(questionText(element))) {
        lastReason = "An employment agreement is not the applicant's company name.";
        lastStatus = "skipped";
        continue;
      }
      // Generic date fallbacks ("any iCIMS year box") must not put a
      // graduation date into a start date field, or the reverse.
      const identity = `${element.getAttribute("name") || ""} ${element.id} ${element.getAttribute("aria-label") || ""}`
        .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[^a-z0-9]+/gi, " ");
      // Match date markers, not the "end" inside Workday's "Attended".
      // Their word forms still count: "starting date", "have not graduated".
      const start = /\b(?:start(?:s|ed|ing)?|first)(?:date|year|month|day)?\b/i.test(identity);
      const end = /\b(?:end(?:s|ed|ing)?|last|grad(?:uat(?:e|ed|es|ing|ion))?)(?:date|year|month|day)?\b/i.test(identity);
      if (
        (/^(grad|end)/.test(key) && start && !end) ||
        (/^start/.test(key) && end && !start)
      ) {
        lastReason = "This field holds a different date.";
        lastStatus = "skipped";
        continue;
      }
      if (!selector.allowReuse) used.add(element);
      if (options.isLocked?.(element)) {
        lastReason = "Field is locked by a trusted user edit.";
        lastStatus = "skipped";
        continue;
      }
      // Custom dropdowns can retain their selected option in a hidden list.
      // Reopening and picking it again causes another form-change pass.
      const pick = selector.actions?.at(-1);
      if (
        !selector.everyValue &&
        element.matches('[role="button"][aria-expanded],[role="combobox"][aria-expanded]') &&
        pick?.method === "click" &&
        paths(pick.path).some((path) =>
          values.some((value) =>
            queryXPathAll(
              root,
              replacePlaceholders(path, configuredPaths[0] || ".", value),
              context,
            ).some((option) => option.matches('[role="option"][aria-selected="true"]')),
          ),
        )
      ) {
        results.push({ key, status: "skipped", reason: "The configured option is already selected." });
        completed = true;
        break;
      }
      // Only a date the site put there is emptied, and only when there is one.
      if (emptiesEnd && (!textValue(element).trim() || !options.isReplaceable?.(element))) {
        results.push({ key, status: "skipped", reason: "A current job has no end date." });
        completed = true;
        break;
      }
      // A site-filled value that is already the right one is left alone:
      // re-picking it can reset dependent fields (a country resets its state).
      if (options.isReplaceable?.(element) && values.length) {
        // Exactly, case included: a parser's "Michigan state university" is
        // free text, not the list's "Michigan State University".
        const current = textValue(element).trim();
        // A rule may cut a value short for partial matching
        // ("United State" for "United States"); that is still the same one.
        const same = (value: string) =>
          value.trim() === current ||
          (value.trim().length >= 6 &&
            current.startsWith(value.trim()) &&
            current.length - value.trim().length <= 2);
        // Not when the site itself calls it invalid: Microsoft's form showed
        // the profile's address while its own state held none ("Address
        // cannot be left blank"), and it was never typed again (2026-11-07).
        if (current && values.some(same) && element.getAttribute("aria-invalid") !== "true") {
          options.onConfirmed?.(element);
          results.push({ key, status: "skipped", reason: "The site's value is already right." });
          completed = true;
          break;
        }
      }
      // A rule that types and must then pick from the site's list is done
      // once the box holds anything but the text it types: the site's own
      // wording of the pick ("Tucson, AZ, USA" for "Tucson, Arizona"), or the
      // applicant's. Run again, it clears that pick and types over it, and a
      // fill paused before the new pick leaves text the site holds no answer
      // for. Its own typed text, left by such a pause, is still redone.
      if (selector.actions?.some((action) => action.pickRequired) && !options.isReplaceable?.(element)) {
        const current = textValue(element).trim();
        if (current && !values.some((value) => value.trim() === current)) {
          results.push({ key, status: "skipped", reason: "The site's list already holds a pick." });
          completed = true;
          break;
        }
      }
      try {
        if (options.signal?.aborted)
          throw new DOMException("Aborted", "AbortError");
        let accepted = true;
        let unpicked = false;
        // A pick that is the closest the site lists, not the profile's own.
        let approximate: string | undefined;
        // Values searched one by one that the site's list did not take.
        const notPicked: string[] = [];
        // The site's own list, where the rule names it: the wordings it holds
        // are tried first, in its spelling, and from a whole list, only those.
        const site = selector.optionsSource && values.length
          ? await options.listOptions?.(selector.optionsSource, values).catch(() => undefined)
          : undefined;
        const onList = site ? listedNames(values, site) : [];
        if (onList.length) values = site!.complete ? onList : [...new Set([...onList, ...values])];
        // A whole list with none of them: searching each wording finds nothing.
        const unlisted = Boolean(site?.complete) && !onList.length;
        options.onField?.(element, key);
        // A list already showing one of its answers (a second fill of the
        // step) is not opened again: Workday's Degree was left open over the
        // form (Jabil, report f0a42a0f, 2026-10-15). Checked before any way
        // of opening it: the search-dropdown handling pressed Workday's Degree
        // button showing "Masters" (2026-10-16).
        const showing = !isTag(element, "input") && !isTag(element, "textarea") ? normalize(textValue(element) || "") : "";
        if (!selector.everyValue && showing && selector.actions?.some((action) => action.path) && values.some((value) => normalize(value) === showing)) {
          options.onConfirmed?.(element);
          results.push({ key, status: "filled" });
          completed = true;
          break;
        }
        const searched = /^(school|major|degree|name|discipline|country|state|education)$/.test(key)
          ? await viaSearchDropdown(element, values, globals, options)
          : "unsupported";
        if (searched === "selected") {
          results.push({ key, status: "filled" });
          completed = true;
          break;
        }
        if (searched === "no-match")
          throw new Error("No list option matches the confirmed answer.");
        const outcome = await viaReactSelect(element, values, globals, options);
        if (outcome === "skipped") {
          lastReason = "Field already has a value.";
          lastStatus = "skipped";
          continue;
        }
        if (outcome === "no-match")
          throw new Error("No dropdown option matches the confirmed answer.");
        if (outcome === "selected") {
          // Handled through the component; configured clicks are not replayed.
        } else if (selector.actions?.length) {
          // A search box that was typed into, whose pick from the site's list
          // then found nothing to press: the text is on the page, but the site
          // holds no answer (Lever keeps the chosen location in a hidden
          // field). Not a failure, and not silent either. Only for a pick the
          // rule marks pickRequired: elsewhere typed text can be the answer.
          const typing = /^(default|defaultWithoutBlur|jQuery|react|keyType|trustedType|trustedSearch|trustedChoose|setValue)$/;
          const picks = (action: FillAction) =>
            Boolean(action.pickRequired && action.path) && (["click", "reactClick"].includes(action.method || "") || /^(mousedown|click)$/.test(action.event || ""));
          // browse: the list opened with nothing typed, the pick made from
          // the whole of it, its options already loaded.
          const runActions = async (actionValues: string[], browse = false) => {
            let typed = false;
            unpicked = false;
            for (const configured of selector.actions!) {
              if (browse && !configured.path && (configured.event || typing.test(configured.method || config.defaultMethod))) continue;
              const action = browse && configured.path && configured.time ? { ...configured, time: Math.min(configured.time, 2_500) } : configured;
              const missed = () => {
                if (typed && picks(action)) unpicked = true;
              };
              try {
                const actionAccepted = await runAction(
                  action,
                  element,
                  configuredPaths[0] || paths(selector.path)[0] || ".",
                  actionValues,
                  root,
                  context,
                  forbidden,
                  globals,
                  options,
                );
                if (!actionAccepted && !action.allowFailure)
                  throw new Error("Configured action was not accepted.");
                if (!actionAccepted) missed();
                else if (!action.path && !action.event && typing.test(action.method || config.defaultMethod)) typed = true;
                else if (picks(action)) unpicked = false;
              } catch (error) {
                if (isAbortError(error)) throw error;
                if (!action.allowFailure) throw error;
                missed();
              }
            }
          };
          // A search typed from the first value can find nothing ("United
          // States of America" where the site lists "United States"); the
          // next few values are typed in turn until one is found and picked.
          const typesThenPicks =
            !selector.everyValue &&
            values.length > 0 &&
            selector.actions.some((action) =>
              /^(default|defaultWithoutBlur|keyType|trustedType|trustedSearch|trustedChoose)$/.test(action.method || ""),
            ) &&
            selector.actions.some((action) =>
              paths(action.path).some((path) => /%(LOWER|UPPER)?VALUE%/.test(path)),
            );
          if (typesThenPicks) {
            // Search confirmed names before short codes. A missing named
            // field of study never falls back to Other: in a Workday list it
            // takes the closest related field, with a caution (below).
            const extends_ = (value: string) =>
              values.some((other) => other !== value && normalize(other).startsWith(`${normalize(value)} `));
            const rank = (value: string) => (extends_(value) ? 0 : value.trim().length <= 3 ? 2 : 1);
            const attempts = [...values.slice(0, 4)].sort((a, b) => rank(a) - rank(b));
            // Already holding one of them (an earlier pass picked it): typing
            // again would only reopen the list over a finished answer.
            const current = normalize(textValue(element) || "");
            if (current && attempts.some((attempt) => normalize(attempt) === current)) {
              results.push({ key, status: "filled" });
              completed = true;
              break;
            }
            let failure: unknown;
            let picked = false;
            // A field of study in a list of picks (Workday's): typing finds
            // nothing to pick when the site lists none of its wordings, and
            // the typed text is dropped when the box loses focus. Each try is
            // judged by the pick it left, and with none, the closest standard
            // field the list holds is tried (relatedFieldsOfStudy).
            const pickBox = element.closest('[data-automation-id="multiSelectContainer"]');
            const studyField = Boolean(pickBox) && /^(major|field_of_study|discipline)(_[234])?$/.test(selector.valueKey || key);
            const holdsPick = (wanted: string[]) =>
              [...(pickBox?.querySelectorAll('[data-automation-id="selectedItem"]') || [])].some((item) => {
                const shown = normalize(item.getAttribute("title") || item.textContent || "");
                return Boolean(shown) && wanted.some((value) => normalize(value) === shown);
              });
            const clearSearch = () =>
              (options.execute || defaultExecute)({ element, globals, method: "clearValue", signal: options.signal, values: [] }).catch(() => false);
            // Workday searches for the text anywhere in a name: a longer
            // wording holding one that found nothing cannot find more, and
            // each empty search costs about 20 s of the pass.
            const foundNothing: string[] = [];
            let browsed = false;
            if (studyField && unlisted) failure = new Error(`The site's list has no "${values[0]}".`);
            for (const first of attempts) {
              if (studyField && unlisted) break;
              if (studyField && foundNothing.some((term) => normalize(first).includes(normalize(term)))) continue;
              try {
                await runActions([first, ...values.filter((value) => value !== first)]);
                // Workday adds the pick a moment after its option is clicked;
                // judged at once, KLA's "Data Science" read as not found and
                // its search was cleared (2026-11-03).
                for (let waited = 0; studyField && !holdsPick(values) && waited < 1_500; waited += 100)
                  await sleep(100, options.signal);
                if (studyField && !holdsPick(values)) {
                  foundNothing.push(first);
                  throw new Error(`The site's list has no "${first}".`);
                }
                picked = true;
                break;
              } catch (error) {
                if (isAbortError(error)) throw error;
                // A pick made by the search itself (its Enter chose the one
                // match) is a pick: the next wording's first step cleared it,
                // and RTX's "Data Science" became "Computer Science" (report
                // 9b6ea678, 2026-11-02).
                if (pickBox && holdsPick(values)) {
                  picked = true;
                  break;
                }
                failure = error;
                // The site's search found nothing for a name its list holds
                // (SuccessFactors finds no "Telangana" among India's states,
                // which list it): the answer is picked from the whole list
                // before other spellings are searched the same way.
                const nothing = !studyField && !browsed && listFoundNothing(element);
                // A list left open answers the next field's search.
                dismissPopup(element);
                if (studyField) await clearSearch();
                if (nothing) {
                  browsed = true;
                  await clearSearch();
                  try {
                    await runActions(values, true);
                    picked = true;
                    break;
                  } catch (browseError) {
                    if (isAbortError(browseError)) throw browseError;
                    dismissPopup(element);
                  }
                }
              }
            }
            // From the site's whole list, only the related fields it holds.
            const closest = relatedFieldsOfStudy(values[0] || "");
            if (!picked && studyField)
              for (const related of site?.complete ? listedNames(closest, site) : closest) {
                try {
                  await runActions([related]);
                  if (!holdsPick([related])) throw new Error(`The site's list has no "${related}".`);
                  picked = true;
                  approximate = related;
                  break;
                } catch (error) {
                  if (isAbortError(error)) throw error;
                  dismissPopup(element);
                  await clearSearch();
                }
              }
            // A pick made, focus leaves the search box: the next look at the
            // page takes a focused field for one the applicant is in, and
            // reported this one unfilled (OpenAI's location on Ashby too).
            if (picked && studyField && element.ownerDocument.activeElement === element) (element as HTMLElement).blur();
            if (!picked) {
              // Never leave typed search text behind as if it were an answer.
              await (options.execute || defaultExecute)({
                element,
                globals,
                method: "clearValue",
                signal: options.signal,
                values: [],
              }).catch(() => false);
              dismissPopup(element);
              // Nor the focus the search took: the page's own selection of
              // this field refuses one it finds focused by something else.
              if (element.ownerDocument.activeElement === element) (element as HTMLElement).blur();
              throw failure;
            }
          } else {
            // A list already showing one of its answers (a second fill of the
            // step) is not opened again: Workday's Degree was left open over
            // the form (Jabil, report f0a42a0f, 2026-10-15).
            const showing = !isTag(element, "input") && !isTag(element, "textarea") ? normalize(textValue(element) || "") : "";
            if (!selector.everyValue && showing && selector.actions.some((action) => action.path) && values.some((value) => normalize(value) === showing)) {
              results.push({ key, status: "filled" });
              completed = true;
              break;
            }
            // Each value searched in turn (Workday's skills, one search each):
            // a limit keeps a long profile list from taking minutes.
            // A skill is searched by its own name and picked under the
            // library's (skill-names.ts): "C#" as "C Sharp (Programming
            // Language)".
            const skillList = selector.everyValue && /^skills?$/.test(selector.valueKey || key);
            if (skillList) for (const action of selector.actions) siteOrdered.add(action);
            const valueBatches = selector.everyValue
              ? values.slice(0, selector.limit ?? values.length).map((value) => [value, ...(skillList ? skillNames(value) : [])])
              : [values];
            // In a list of picks, one it already holds is not searched again
            // (a second fill pressed nothing for each and waited 3 s), and one
            // searched that left no pick is named for the applicant: the site
            // listed 16 of a profile's first 25 skills, and the other nine went
            // unmentioned (Cisco, 2026-10-17). Its own wording may add a kind:
            // "Python (Programming Language)".
            const pickBox = selector.everyValue ? element.closest('[data-automation-id="multiSelectContainer"]') : null;
            const held = (value: string) =>
              [...(pickBox?.querySelectorAll('[data-automation-id="selectedItem"]') || [])].some((item) => {
                const shown = (item.getAttribute("title") || item.textContent || "").trim().toLowerCase();
                return [value, ...(skillList ? skillNames(value) : [])].some((name) => {
                  const wanted = name.trim().toLowerCase();
                  return shown === wanted || shown.startsWith(`${wanted} (`) || shown.endsWith(` (${wanted})`);
                });
              });
            try {
              for (const actionValues of valueBatches) {
                if (pickBox && held(actionValues[0])) continue;
                await runActions(actionValues);
                if (pickBox && !held(actionValues[0])) notPicked.push(actionValues[0]);
              }
            } catch (error) {
              if (!isAbortError(error)) await closeOpenedList(element, options);
              throw error;
            }
          }
        } else {
          const method = selector.method || config.defaultMethod;
          if (
            ["click", "reactClick"].includes(method) &&
            isForbiddenClick(element, forbidden, true, options.context)
          )
            throw new Error(
              "Refused to activate a submit or certification control.",
            );
          if (
            !nonMutatingMethods.has(method) &&
            !["click", "reactClick", "event"].includes(method) &&
            textValue(element) &&
            !options.isReplaceable?.(element)
          ) {
            lastReason = "Field already has a value.";
            lastStatus = "skipped";
            continue;
          }
          accepted = await (options.execute || defaultExecute)({
            element,
            globals,
            method,
            signal: options.signal,
            values: [...values],
          });
        }
        if (!accepted)
          throw new Error("Site did not accept the configured value.");
        // A search whose optional pick found nothing ("No results") leaves
        // its list open, and an open list hides the rest of the form from
        // the next look at it (Ashby, Talos's Location; nightly 2026-10-02).
        const opened = element.matches('[aria-expanded="true"]')
          ? element
          : element.querySelector('[role="combobox"][aria-expanded="true"]');
        if (opened) dismissPopup(opened);
        // The question's own heading where the site marks one (Lever wraps
        // the whole widget, list included, in the label).
        const heading = element.closest("label, fieldset")?.querySelector('legend, [class*="label" i]')?.textContent;
        const asked = (heading || questionText(element)).replace(/[*✱]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || key;
        results.push({
          key,
          status: "filled",
          ...(approximate
            ? { caution: `${asked}: the site lists no "${values[0]}", so the closest field it lists, "${approximate}", was picked. Change it if another fits better.` }
            : unpicked ? { caution: `${asked}: typed, but nothing was picked from the site's own list. Choose it there yourself.` }
            : notPicked.length ? { caution: `${asked}: the site's list has no ${notPicked.map((value) => `"${value}"`).join(", ")}. Add any that fit under another name there.` } : {}),
        });
        completed = true;
        break;
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastReason = (error as Error).message || "Configured action failed.";
        dismissPopup(element);
        // A failed attempt must not keep the control reserved: the accessible
        // fallback (or another selector) should still get a chance at it.
        if (!selector.allowReuse) used.delete(element);
      }
    }
    // Configured row rules can report success while leaving fields untouched
    // (their conditions skip every step), so the row fallback also runs after a
    // successful pass and fills only what is still empty.
    if (["education", "experience", "references"].includes(key)) {
      try {
        const count = await fillRepeatedFallback(
          key as RowCollection,
          context,
          root,
          globals,
          profile,
          used,
          options,
        );
        if (count && !completed) {
          results.push({ key, status: "filled" });
          completed = true;
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastReason =
          (error as Error).message || "Repeated section fallback failed.";
      }
    }
    if (!completed) {
      const values = fallbackValues(key, profile, globals, options.valueContext);
      const element = values.length ? labeledFallback(key, context) : undefined;
      if (
        element &&
        !used.has(element) &&
        !options.isLocked?.(element) &&
        (!textValue(element) || options.isReplaceable?.(element))
      ) {
        try {
          if (await fillFallback(element, values, root, globals, options)) {
            used.add(element);
            results.push({ key, status: "filled" });
            completed = true;
          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          lastReason =
            (error as Error).message || "Accessible fallback failed.";
        }
      }
    }
    if (!completed)
      results.push({
        key,
        status: options.signal?.aborted ? "skipped" : lastStatus,
        reason: options.signal?.aborted
          ? "Operation was cancelled."
          : lastReason,
      });
  }
  // No site config describes a references section, so this pass is the only
  // thing that fills one. Like every row fallback it writes only inside a
  // scope that names itself as references, and only into empty fields.
  if (
    // An older panel or a hand-built payload can arrive without the field.
    profile.references?.length &&
    !results.some((result) => result.key === "references")
  ) {
    try {
      const count = await fillRepeatedFallback(
        "references",
        context,
        root,
        globals,
        profile,
        used,
        options,
      );
      if (count) results.push({ key: "references", status: "filled" });
      else if (
        await fillReferencesText(context, root, globals, profile, used, options)
      )
        results.push({ key: "references", status: "filled" });
    } catch (error) {
      if (isAbortError(error)) throw error;
      results.push({
        key: "references",
        status: "failed",
        reason: (error as Error).message || "References fallback failed.",
      });
    }
  }
  return results;
}

export function valuesForRepeatedSection(
  key: string,
  profile: Profile,
  collection: ValueContext["collection"],
  index: number,
) {
  return canonicalValues(key, profile, { collection, index });
}
