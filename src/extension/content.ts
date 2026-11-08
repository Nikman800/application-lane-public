import { clicksAround, setEngineWait } from "../engine/config/interpreter";
import { setMonthPickerWait } from "../engine/page/month-picker";
import { fetchSiteOptions } from "../engine/config/options-source";
import { pickMonth } from "../engine/page/month-picker";
import { loadQuestionnaires, questionnaireUrls, type QuestionnaireAnswers } from "../engine/config/workday-questionnaire";
import { adapterFor } from "./adapters";
import { redactURL, secretName } from "./workspace";
import { DRAFT_ONLY_NOTE, draftOnlySite } from "../shared/matching";
import { startRecorder } from "./recorder";
import { PAGE_TIMER_EVENT } from "../engine/page/timers";
import { pickOption } from "../shared/answers";
import { nameVariants } from "../shared/matching";
import { configEngineEnabled } from "../engine/mode";
import { configPassTimeout } from "../shared/timing";
import {
  addableCollections,
  configuredFileControls,
  configuredRadioControls,
  submittedOnPage,
  confirmationInPlace,
  fillDocument,
  searchSiteList,
} from "../engine/runtime";
import {
  requestMainWorld,
  requestTrustedType,
  authorizeMainWorld,
} from "../engine/page/bridge";
import {
  ownLabel as nativeOwnLabel,
  fieldWordLimit,
  fieldLabel as nativeFieldLabel,
  legacyLabels,
  sectionFor,
  fileKind as nativeFileKind,
  documentKind,
  currentFileName,
  replacesForm,
  groupQuestion,
  checkboxEntryTitle,
  hiddenAnswerQuestion,
  profileImport,
  uploadError,
  rendered,
  select2Selection,
  writable,
  controlVisible,
  placeholderOption,
  isRequired,
  validationState,
  selectedCustomValue,
  toggleGroup,
  isToggleChoice,
  redundantAutofill,
  type Control,
} from "./semantics";
import {
  normalize,
  CONTENT_VERSION,
  type Field,
  type Observation,
  type Proposal,
  type Artifact,
  type Profile,
} from "../shared/model";

// Chrome runs a hidden tab's chained timers about once a minute after five
// minutes out of sight, so a fill left in a background tab took a minute for
// each wait inside a dropdown or an upload (a 25-minute Greenhouse fill). A wait is also ended by the extension's background, whose
// timers are not the page's: whichever comes first.
// An older react-select's input has no combobox role: its own id, or the
// container class a site gives it (one employer's "dropdown-autocomplete").
// A read-only box whose value comes from a picker opened by the button
// beside it (a calendar).
const pickerBox = (element: Element) =>
  element instanceof HTMLInputElement && element.readOnly && Boolean(element.parentElement?.querySelector('button[type="button"]'));
const listButton = (element: Element) => element.matches('button[type="button"][aria-haspopup="listbox"]');
const legacyReactSelect ='input[id^="react-select-"][aria-autocomplete="list"],.dropdown-autocomplete input[aria-autocomplete="list"]';
// A text box that calls itself a combobox for the calendar it opens (Amazon's
// "YYYY-MM-DD"): it is typed into, not picked from.
const calendarBox = (element: Element) =>
  element instanceof HTMLInputElement && element.type === "text" &&
  element.getAttribute("aria-haspopup") === "dialog" && /\b(yyyy|mm|dd)\b/i.test(element.placeholder);

let wakePort: chrome.runtime.Port | undefined;
const wakes = new Map<number, () => void>();
let wakeCount = 0;
// A date format the control shows: its placeholder, pattern, title or the
// text it is described by ("DD/MM/YYYY", "yyyy-mm-dd", "JJ/MM/AAAA").
function dateFormatHint(element: Element): string | undefined {
  const own = ["placeholder", "pattern", "title", "aria-placeholder", "data-date-format"].map((name) => element.getAttribute(name) || "");
  const described = (element.getAttribute("aria-describedby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => element.ownerDocument.getElementById(id)?.textContent || "");
  const hint = [...own, ...described].find((text) => /\b(dd|jj|tt|mm|yyyy|aaaa|jjjj)\b[\s./-]+\b(dd|jj|tt|mm|yyyy|yy|aaaa|jjjj)\b/i.test(text));
  return hint ? hint.trim().slice(0, 100) : undefined;
}

function wakeChannel(): chrome.runtime.Port | undefined {
  if (wakePort) return wakePort;
  try {
    const port = chrome.runtime.connect({ name: "lane-wake" });
    port.onMessage.addListener((message: { id?: number }) => {
      const done = typeof message?.id === "number" ? wakes.get(message.id) : undefined;
      done?.();
    });
    port.onDisconnect.addListener(() => {
      if (wakePort === port) wakePort = undefined;
      for (const done of [...wakes.values()]) done();
    });
    wakePort = port;
  } catch {
    wakePort = undefined;
  }
  return wakePort;
}
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const id = ++wakeCount;
    const done = () => {
      wakes.delete(id);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (document.visibilityState !== "hidden") return;
    const port = wakeChannel();
    if (!port) return;
    wakes.set(id, done);
    try {
      port.postMessage({ id, ms });
    } catch {
      wakes.delete(id);
    }
  });
}

type RecordEntry = {
  element: Control;
  id: string;
  last: string;
  revision: number;
  protected: boolean;
  label: string;
  attachmentId?: string;
  automationWritten?: boolean;
  // When the engine last wrote this field. Site-driven follow-ups (framework
  // re-renders, dependent fields) arriving within writeGrace are attributed to
  // that write instead of to the user; after that the attribution expires.
  writePendingAt?: number;
  conflict?: boolean;
  fillWarning?: string;
  // Why this field is protected, so a skipped field can be explained.
  protectedBy?: string;
  // The fill operation in which writing this field failed.
  failedOperation?: number;
  // The answer that failed: another one is still tried in the same fill.
  failedValue?: string;
  // Put there by the site from a parsed resume, so the profile may replace it.
  siteValue?: boolean;
  // A site value a site rule found already right (see onConfirmed).
  confirmed?: boolean;
};
type Command = {
  type: string;
  applicationId: string;
  operation: number;
  documentId?: string;
  proposals?: Proposal[];
  fieldId?: string;
  expectedValue?: string;
  revision?: number;
  artifact?: Artifact & { data: string };
  locks?: string[];
  // OPTIONS: the fields whose option lists to read.
  fieldIds?: string[];
  listButtonsOnly?: boolean;
  profile?: Profile;
  token?: string;
  session?: string;
  startedAt?: number;
  replaceSiteValues?: boolean;
  section?: string;
  index?: number;
  // A config pass limited to these keys, with the documents its upload
  // steps hand to the site (uploads made through a dialog, SuccessFactors).
  onlyKeys?: string[];
  uploads?: Partial<Record<Artifact["kind"], Artifact & { data: string }>>;
  // ATTACHED: the document file name to look for.
  name?: string;
  // ATTACH: the applicant asked to replace a document the site already held.
  replaceExisting?: boolean;
  // PAGE_TIMERS: whether the page's own timers are kept on time while hidden.
  on?: boolean;
};
declare global {
  interface Window {
    __applicationLane?: { inspect: () => Observation; version?: string };
  }
}

// A copy left by an earlier build (the extension reloaded since, its own
// line to the extension cut) gives way to this one, so a page need not be
// reloaded to take the new build: reloading lost unsaved entries, and on
// one employer's SuccessFactors its one-time address showed only an error.
if (window.__applicationLane && window.__applicationLane.version !== CONTENT_VERSION) window.__applicationLane = undefined;
if (!window.__applicationLane) {
  const documentId = crypto.randomUUID();
  const records = new Map<string, RecordEntry>();
  const semanticIds = new Map<string, string>();
  const nodeRecords = new WeakMap<HTMLElement, RecordEntry>();
  const ownedAutocompleteSearches = new WeakMap<HTMLInputElement, string>();
  let fileControls = new Map<HTMLElement, ReturnType<typeof configuredFileControls>[number]>();
  let radioControls = new Map<HTMLElement, ReturnType<typeof configuredRadioControls>[number]>();
  const fieldLabel = (element: Control) => fileControls.get(element)?.label || radioControls.get(element)?.label || nativeFieldLabel(element);
  const ownLabel = (element: Control) => radioControls.get(element)?.option || nativeOwnLabel(element);
  const fileKind = (element: Control) => fileControls.has(element) ? documentKind(fieldLabel(element)) : nativeFileKind(element);
  const lockedLabels = new Set<string>();
  // What created each lock, so a protected field can say why.
  const lockOrigins = new Map<string, string>();
  const addLock = (key: string, origin: string) => {
    // No label, no field: such a lock held every field (see elementLockKeys).
    if (/:$/.test(key)) return;
    lockedLabels.add(key);
    if (!lockOrigins.has(key)) lockOrigins.set(key, origin);
  };
  let paused = false;
  // When the applicant last pressed, typed or touched anything on the page.
  let lastApplicantInput = -Infinity;
  // The event that paused the fill and the control it landed on, for the
  // card: "You interacted" alone cannot be told from a false alarm.
  let pausedBy = "";
  let applicationId = "";
  let replaceSiteValues = false;
  // Until when value changes nobody made by hand are the site filling the
  // form from an uploaded resume (set when such an upload is attached).
  let siteFillUntil = 0;
  let operation = -1;
  let configController = new AbortController();
  let stopRecording: ReturnType<typeof startRecorder> | undefined;
  let recordingSession = "";
  let configPass = "";
  // The cautions of the last pass (a closest pick): a repeat of the pass
  // skips its work, and without them the review list would lose them.
  let configCautions: { key: string; status: "filled"; caution: string }[] = [];
  let writing = false;
  // The element a burst of real keystrokes is landing in, while it is in
  // flight. Nothing else is exempt from the user-edit rules.
  let trustedWrite: Element | undefined;
  // A search box our real Enter searched: the site answers on its own a
  // moment later, moving focus into its results, and the box's trusted
  // input or change that follows is still ours (one employer's field of study paused
  // the fill as the applicant's edit). Only those two events,
  // only on that box, only briefly, and never while the applicant is active.
  let searchSettle: { element: Element; until: number } | undefined;
  // The applicant is using the page while their last click or key on it is
  // recent, or from when they touch a form control until they click away
  // from the form or leave the page; the fill moving focus off their control
  // does not end it. A tab merely in front is not that: it was refused real
  // keys, so Workday's dates were assigned and dropped in a focused tab and
  // typed in a background one. Focus Chrome hands the page when the debugger
  // types counts for nothing.
  const attentionSpan = 3000;
  let applicantGesture = -Infinity;
  let applicantControl: Element | undefined;
  const userAttention = () =>
    document.hasFocus() &&
    (performance.now() - applicantGesture < attentionSpan || !!applicantControl?.isConnected);
  window.addEventListener("blur", () => {
    applicantControl = undefined;
  });
  const trustedKeyEvents = ["keydown", "beforeinput", "input", "change"];
  // A real click the fill itself made on a menu's entry (see trustedChoose),
  // inside the component being written: no sign of the applicant.
  const ourClick = (event: Event) => /^(pointer|mouse)(down|up)$|^click$/.test(event.type);
  // Our keys that reached another field. A page without focus gets it from
  // our first key, and only then runs its focus handlers: Workday's sends a
  // date's Year back to Month after the check before typing had passed. The
  // rest of the burst is kept from the page, so it neither edits Month nor
  // reads as the applicant's key press, and the field is typed again.
  // A key's release is not counted: Workday moves focus to Year as soon as
  // Month holds two digits, so the last key's release lands there, as it does
  // for the applicant. Counted, the month was retyped and then assigned, and
  // Workday dropped the assigned month.
  let misdirected = false;
  for (const type of ["keydown", "keypress", "beforeinput"])
    window.addEventListener(
      type,
      (event) => {
        if (
          !trustedWrite ||
          !event.isTrusted ||
          userAttention() ||
          event.composedPath().includes(trustedWrite)
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        misdirected = true;
      },
      true,
    );
  let ownedActivation:
    | { control: HTMLInputElement; events: Set<string> }
    | undefined;
  let composing = false;
  let lastFingerprint = "";
  let autoDocumentMutation = false;
  const clip = (s: string, max = 1000) =>
    s.replace(/\s+/g, " ").trim().slice(0, max);
  // The words a block holds, without its scripts and styles: SuccessFactors
  // keeps inline scripts inside its content region, and their code filled
  // the whole page description.
  const readableText = (root: Element | null) => {
    if (!root) return "";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest("script,style,noscript,template") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let text = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) text += node.textContent;
    return text;
  };
  const tell = (message: unknown) => {
    try {
      void chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      /* Extension may have been reloaded. */
    }
  };
  // Ashby saves each answer to its server as it is entered, one request per
  // field (ApiSetFormValue), and overlapping saves lose each other: the page
  // shows the answer while Submit reports it missing. On such a site every
  // write waits for the save it started before the next write. Completed
  // requests are read from resource timing; the page's code is not touched.
  const pacesSaves = /(^|\.)ashbyhq\.com$/.test(location.hostname);
  let savesFinished = 0;
  if (pacesSaves)
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          if (/[?&]op=ApiSetFormValue/.test(entry.name)) savesFinished++;
      }).observe({ type: "resource" });
    } catch {
      /* Without resource timing, writes are not paced. */
    }
  const awaitSiteSave = async (before: number) => {
    if (!pacesSaves) return;
    // Bounded: a write the site does not save (an unchanged value, a click
    // that only opens a list) costs at most this long.
    const deadline = performance.now() + 1000;
    while (savesFinished <= before && performance.now() < deadline)
      await pause(40);
  };
  const trackedControlSelector =
    'input,textarea,select,button[aria-haspopup="listbox"],button[aria-pressed],[role="checkbox"],[role="radio"],[role="combobox"]';
  // The hidden checkbox Ashby keeps beside a yes/no toggle pair; the pair is
  // the control.
  const behindToggle = (element: Control) => {
    const first = element.parentElement?.querySelector(":scope > button[aria-pressed]");
    return element instanceof HTMLInputElement && Boolean(first && isToggleChoice(first));
  };
  // The site's own job search and language menu, in the header of a posting
  // (Amazon's: the posting read as a form of three fields, its
  // search boxes listed as optional questions, and Fill filled nothing).
  const siteChrome = (element: Control) => {
    if (element.closest('[role="search"],search') || element.matches('[role="combobox"][aria-haspopup="menu"]')) return true;
    const form = element.closest("form");
    if (!form || (form.getAttribute("method") || "get").toLowerCase() !== "get") return false;
    try {
      return /\/search\/?$/i.test(new URL(form.action, location.href).pathname);
    } catch {
      return false;
    }
  };
  const isTrackableControl = (element: Control) =>
    (!element.matches("button[aria-pressed]") || isToggleChoice(element)) &&
    !siteChrome(element) &&
    !redundantAutofill(element) &&
    !behindToggle(element) &&
    !profileImport(element) &&
    // Select2's visible selection: the hidden select beside it is the field,
    // with the options and the submitted value (Amazon listed each question
    // twice, once unlabelled and once without options).
    !(element.matches(".select2-selection") &&
      select2Selection(element.closest(".select2-container")?.previousElementSibling || element) === element) &&
    // A native radio or checkbox drawn inside an ARIA one is that control's
    // own input (Rippling); counted as well, every option appears twice.
    // One inside a list option only marks that option chosen (Workday's
    // multiselect lists): the dropdown is the field, not its options.
    !(element instanceof HTMLInputElement && ["radio", "checkbox"].includes(element.type) &&
      element.parentElement?.closest(`[role="${element.type}"],[role="option"]`)) &&
    (element.getAttribute("aria-hidden") !== "true" ||
      Boolean(select2Selection(element)) ||
      (element instanceof HTMLInputElement && element.type === "file")) &&
    (!(element instanceof HTMLInputElement) ||
      !["hidden", "password", "submit", "reset", "button"].includes(
        element.type,
      ));
  const valueOf = (element: Control): string => {
    if (element.matches('.ashby-application-form-input-autocomplete[role="combobox"][aria-expanded="true"]')) return "";
    // Our own autocomplete query is not a selected application answer.
    if (element instanceof HTMLInputElement &&
      ownedAutocompleteSearches.has(element) &&
      element.value === ownedAutocompleteSearches.get(element)) return "";
    // A SuccessFactors list where "No Selection" was picked holds nothing:
    // read as an answer, it stayed locked as the applicant's, and Unlock
    // empty fields could not release it.
    if (element instanceof HTMLInputElement && element.classList.contains("rcmpaginatedselectinput") &&
      /^no selection$/i.test(element.value.trim())) return "";
    const file = fileControls.get(element);
    if (file) return file.value;
    if (isToggleChoice(element)) {
      const pressed = toggleGroup(element).find(
        (button) => button.getAttribute("aria-pressed") === "true",
      );
      return pressed ? ownLabel(pressed) : "";
    }
    const role = element.getAttribute("role");
    if (role === "radio" && !(element instanceof HTMLInputElement)) {
      const selected = radioGroup(element).find(
        (candidate) => candidate.getAttribute("aria-checked") === "true",
      );
      return selected ? ownLabel(selected) : "";
    }
    if (element.matches('button[aria-haspopup="listbox"]')) {
      const value = clip(element.textContent || "");
      return /^(?:select(?: one)?|select[.…]*|choose|--)?$/i.test(value)
        ? ""
        : value;
    }
    if (
      ["checkbox", "radio"].includes(role || "") &&
      (!(element instanceof HTMLInputElement) ||
        !["checkbox", "radio"].includes(element.type))
    )
      return element.getAttribute("aria-checked") === "true"
        ? role === "checkbox" ? "Yes" : ownLabel(element) || element.getAttribute("value") || "true"
        : "";
    if (element instanceof HTMLSelectElement) {
      const option = element.selectedOptions[0];
      return !option || placeholderOption(option) ? "" : element.value;
    }
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox") {
        const group = radioGroup(element);
        if (group.length > 1) {
          const selected = group.find(
            (candidate) =>
              candidate instanceof HTMLInputElement && candidate.checked,
          );
          return selected ? ownLabel(selected) || "Yes" : "";
        }
        return element.checked ? "Yes" : "";
      }
      if (element.type === "radio") {
        const selected = radioGroup(element).find(
          (candidate) =>
            candidate instanceof HTMLInputElement && candidate.checked,
        );
        return selected
          ? ownLabel(selected) ||
              (selected instanceof HTMLInputElement ? selected.value : "")
          : "";
      }
      if (element.type === "file")
        return (
          [...(element.files || [])].map((f) => f.name).join(", ") ||
          currentFileName(element)
        );
    }
    if ((element.getAttribute("role") === "combobox" && !calendarBox(element)) || element.closest(".pcty-input-select__input") || element.matches(legacyReactSelect)) {
      const accessibleValue = selectedCustomValue(element);
      if (accessibleValue !== undefined) return accessibleValue;
      if (element instanceof HTMLInputElement) return element.value;
      const shown = element.textContent?.trim() || "";
      // Rippling shows its placeholder ("Select", "Select...") as the text,
      // and repeats it as the control's own name.
      if (shown === (element.getAttribute("aria-label") || "").trim() && /^select[.…]*$/i.test(shown) &&
          element.closest('[data-testid="select-controller"]')) return "";
      return element.getAttribute("data-placeholder") === "true"
        ? ""
        : shown;
    }
    return "value" in element
      ? String(element.value)
      : element.getAttribute("aria-valuetext") ||
          element.textContent?.trim() ||
          "";
  };
  function controls(): Control[] {
    const result: Control[] = [];
    const visit = (root: Document | ShadowRoot) => {
      result.push(
        ...root.querySelectorAll<Control>(trackedControlSelector),
      );
      for (const element of root.querySelectorAll("*"))
        if (element.shadowRoot) visit(element.shadowRoot);
    };
    visit(document);
    fileControls = new Map((configEngineEnabled ? configuredFileControls() : []).map((field) => [field.element, field]));
    radioControls = new Map((configEngineEnabled ? configuredRadioControls() : []).map((field) => [field.element, field]));
    // A configured slot may be the native input found above (JazzHR's
    // resume): it is one field, not two of the same label.
    result.push(...[...fileControls.keys()].filter((element) => !result.includes(element)));
    const tracked = result.filter(isTrackableControl);
    // A modal dialog is the whole form while it is open: what lies behind
    // it cannot be reached (one employer's search filters behind Easy Apply).
    const modal = openModal(tracked);
    return modal ? tracked.filter((element) => modal.contains(element)) : tracked;
  }
  function openModal(tracked: Control[]): Element | undefined {
    const holds = (dialog: Element) => tracked.some((element) => dialog.contains(element));
    // A cookie notice calls itself a modal dialog too (Pinpoint's, and its
    // preferences box, which stays in the page drawn but invisible): it is
    // not the form, and the form behind it can be reached.
    const consent = (dialog: Element) =>
      /\bcookies?\b|\bconsent\b/i.test(dialog.textContent || "") &&
      tracked.every(
        (element) => !dialog.contains(element) || (element instanceof HTMLInputElement && element.type === "checkbox") || element instanceof HTMLButtonElement,
      );
    const open = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"]')].filter(
      (dialog) =>
        dialog.getClientRects().length &&
        dialog.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
        holds(dialog) &&
        !consent(dialog),
    );
    return open.reverse().find(
      (dialog) =>
        dialog.matches('[aria-modal="true"]') ||
        (dialog instanceof HTMLDialogElement && dialog.matches(":modal")) ||
        // Opened without showModal, yet drawn over the page as one.
        (getComputedStyle(dialog).position === "fixed" &&
          tracked.some((element) => dialog.contains(element) && element.matches("[required],[aria-required='true']"))),
    );
  }
  const radioGroup = (element: Control): Control[] => {
    if (isToggleChoice(element)) return toggleGroup(element);
    const role = element.getAttribute("role");
    if (element instanceof HTMLInputElement && element.type === "checkbox") {
      const group = element.closest(
        'fieldset[data-automation-id$="-CheckboxGroup"]',
      );
      if (group)
        return [...group.querySelectorAll<Control>('input[type="checkbox"]')].filter(
          isTrackableControl,
        );
    }
    if (element instanceof HTMLInputElement && element.type === "radio") {
      const root = element.getRootNode() as Document | ShadowRoot;
      if (element.name)
        return [
          ...root.querySelectorAll<Control>(
            `input[type="radio"][name="${CSS.escape(element.name)}"]`,
          ),
        ].filter(
          (candidate) =>
            candidate instanceof HTMLInputElement &&
            candidate.form === element.form &&
            isTrackableControl(candidate),
        );
      const group = element.closest(
        'fieldset,[role="radiogroup"],.application-question',
      );
      return group
        ? [
            ...group.querySelectorAll<Control>(
              'input[type="radio"]:not([name]),input[type="radio"][name=""]',
            ),
          ]
        : [element];
    }
    if (role === "radio") {
      const group = element.closest('[role="radiogroup"]');
      if (group) return [...group.querySelectorAll<Control>('[role="radio"]')];
      // A group drawn in its component's own shadow root with the choices
      // slotted into it (SmartRecruiters' spl-radio-group): each Yes and No
      // read as a question of its own, both refused as "another field has
      // the same label" (one employer's screening questions).
      const parent = element.parentElement;
      if (parent && element.assignedSlot?.closest('[role="radiogroup"]'))
        return [...parent.children].filter((child): child is Control => child.getAttribute("role") === "radio");
      return [element];
    }
    return [element];
  };
  const controlsWithin = (element: Element): Control[] => {
    const candidates: Control[] = [];
    for (const control of fileControls.keys())
      if (control === element || control.contains(element)) candidates.push(control);
    if (element.matches(trackedControlSelector))
      candidates.push(element as Control);
    candidates.push(
      ...element.querySelectorAll<Control>(trackedControlSelector),
    );
    const owner = element.closest<Control>(trackedControlSelector);
    if (owner) candidates.push(owner);
    return [...new Set(candidates)].filter(isTrackableControl);
  };
  const writeGrace = 5000;
  const writePending = (record?: { writePendingAt?: number }) =>
    record?.writePendingAt !== undefined &&
    performance.now() - record.writePendingAt < writeGrace;
  // When the fill last wrote, started or finished, and where: see the site
  // answering a write below.
  let lastEngineWrite = -Infinity;
  let lastWritten: Element | undefined;
  // The control is another part of the small group the fill just wrote in,
  // as a date's Year is beside its Month: the smallest block holding both
  // holds no more than three controls. A field elsewhere on the form the
  // site fills after a write (its resume parser's output) is not.
  const besideLastWrite = (element: Element) => {
    if (!lastWritten?.isConnected || lastWritten.contains(element)) return false;
    let block = lastWritten.parentElement;
    while (block && !block.contains(element)) block = block.parentElement;
    return Boolean(block) && block!.querySelectorAll(trackedControlSelector).length <= 3;
  };
  const markEngineWrite = (...elements: (Element | undefined)[]) => {
    lastEngineWrite = performance.now();
    lastWritten = elements.find(Boolean) || lastWritten;
    for (const element of elements) {
      if (!element) continue;
      for (const control of controlsWithin(element))
        for (const member of radioGroup(control)) {
          const record = nodeRecords.get(member as HTMLElement);
          if (record) record.writePendingAt = performance.now();
        }
    }
  };
  const clearPendingWrites = () => {
    for (const record of records.values()) record.writePendingAt = undefined;
  };
  const listPlaceholder = /^(no selection|select( one| an option)?|please select( one)?|choose( one)?)$/;
  const lockKey = (field: Pick<Field, "label" | "section" | "index">) =>
    `${normalize(field.section || "")}:${field.index || 0}:${normalize(field.label)}`;
  const elementLockKeys = (element: Control, label: string) => {
    const section = sectionFor(element);
    // A key with no label names no field: SmartRecruiters' <label>s hold
    // only whitespace around a slot, every field read ":0:" under its older
    // label, and one lock under it left a whole screening step unfilled.
    return keysFor(element, label, section).filter((key) => !/:$/.test(key));
  };
  const keysFor = (element: Control, label: string, section: ReturnType<typeof sectionFor>) => {
    return [
      lockKey({ label, ...section }),
      // A lock saved before sections were told apart covers only a field
      // that still has none: in a section, it cannot say which row it was
      // (SuccessFactors' ":0:country" held every row's Country).
      // A list's placeholder, which every list of the row shows, names only
      // a list holding an answer: one lock under "No Selection" kept Expand
      // Energy's empty Education Type, Country, Degree and Status empty
      //, and without it the applicant's own picks there
      // (Brightline's "State of Andhra Pradesh") were filled over.
      ...legacyLabels(element).filter((legacy) => !listPlaceholder.test(normalize(legacy)) || Boolean(valueOf(element))).flatMap((legacy) => [
        lockKey({ label: legacy, ...section }),
        ...(section.section ? [] : [lockKey({ label: legacy, section: "", index: 0 })]),
      ]),
    ];
  };
  // The applicant's own edits: a real event on the page, or a lock saved
  // with the application from one. Other locks record what the site did.
  const applicantLock = (key: string) =>
    /^(a real|an edit saved)/.test(lockOrigins.get(key) || "an edit saved");
  // A lock from the site's behaviour guards the value it saw; once the field
  // is empty again there is nothing left to guard.
  // The search box of a list of picks (Workday's Field of Study, Skills):
  // what is typed there is a search, and the site drops it unless something
  // is picked. The answer is the pick. With none, an applicant's typing
  // protects nothing, and a lock from it kept both fields empty in every
  // later fill (an employer: "python" and "Data Science" typed to show
  // the site's search, then cleared by it).
  const searchWithoutPick = (element: Element) => {
    const box = element.matches('input[data-uxi-widget-type="selectinput"]')
      ? element.closest('[data-automation-id="multiSelectContainer"]')
      : null;
    return Boolean(box) && !box!.querySelector('[data-automation-id="selectedItem"]');
  };
  // What a list of picks holds is its picks, not its search box: Workday
  // picks a phone code itself once the country is set, and an empty box
  // reported it as a required field left empty (GE Vernova, an employer). Only for what is reported: the record, and what it
  // protects, still go by the box.
  const picksOf = (element: Element) => {
    const box = element.matches('input[data-uxi-widget-type="selectinput"]')
      ? element.closest('[data-automation-id="multiSelectContainer"]')
      : null;
    // Microsoft's careers form shows a multiselect's picks as pills beside
    // its read-only box ("United States, Washington, Redmond"): read as
    // empty, a chosen location was reported as missing.
    const pills = element.matches('input[class*="select-module_select-input"]')
      ? [...(element.closest('[class*="select-module_select-wrapper"]')?.querySelectorAll('[class*="select-module_multi-select-pill"] [class*="pills-module_label"]') || [])]
      : [];
    return [...[...(box?.querySelectorAll('[data-automation-id="selectedItem"]') || [])]
      .map((item) => clip(item.getAttribute("title") || item.textContent || "")), ...splPicks(element),
      ...pills.map((pill) => clip(pill.textContent || ""))]
      .filter(Boolean)
      .join("; ");
  };
  // A SmartRecruiters multiselect keeps its picks as its own value, the ids
  // of the entries chosen; its box stays empty. Read as empty, a list already
  // holding "Not Applicable" was picked again, and the second pick undid
  // the first.
  const splChosen = (element: Element): string[] => {
    let host = (element.getRootNode() as ShadowRoot).host as Element | undefined;
    for (let depth = 0; host && depth < 4 && !host.matches("spl-multiselect-autocomplete"); depth++)
      host = ((host.getRootNode() as ShadowRoot).host as Element | undefined) || undefined;
    if (!host?.matches("spl-multiselect-autocomplete")) return [];
    return (host.getAttribute("value") || "").split(/[\s,;]+/).filter(Boolean);
  };
  const splPicks = (element: Element): string[] => {
    const chosen = splChosen(element);
    if (!chosen.length) return [];
    const named = [...(controlledList(element)?.children || [])]
      .filter((option) => chosen.includes(option.getAttribute("value") || ""))
      .map((option) => clip(option.textContent || ""))
      .filter(Boolean);
    return named.length ? named : [`${chosen.length} selected`];
  };
  const hasEditLock = (element: Control, label: string) =>
    !searchWithoutPick(element) &&
    elementLockKeys(element, label).some(
      (key) => lockedLabels.has(key) && (applicantLock(key) || Boolean(valueOf(element))),
    );
  const lockReason = (element: Control, label: string) => {
    const key = elementLockKeys(element, label).find((candidate) =>
      lockedLabels.has(candidate),
    );
    return key
      ? `edit lock "${key}" from ${lockOrigins.get(key) || "an earlier fill of this application"}`
      : "edit lock";
  };
  // A placeholder a site writes where its resume parser found nothing
  // ("UNSPECIFIED" as a company, an employer) is no answer to
  // keep, whatever the setting for site values.
  const placeholder = (value: string) =>
    /^\s*(unspecified|not specified|unknown|n\/?a|none|null|undefined|-+|\.+)\s*$/i.test(value);
  const adoptSiteValue = (record: RecordEntry) => {
    if ((replaceSiteValues || placeholder(record.last)) && record.protectedBy === "existing value") {
      record.protected = false;
      record.protectedBy = undefined;
      record.siteValue = true;
      record.confirmed = false;
    }
  };
  const trackLocalControls = (candidates: Control[]) => {
    for (const element of candidates) {
      const group = radioGroup(element);
      const representative = group.find(writable) || element;
      let record = nodeRecords.get(representative as HTMLElement);
      if (!record) {
        const label = fieldLabel(representative);
        const current = valueOf(representative);
        record = {
          element: representative,
          id: crypto.randomUUID(),
          last: current,
          revision: 1,
          protected:
            Boolean(current) || hasEditLock(representative, label),
          protectedBy: hasEditLock(representative, label)
            ? lockReason(representative, label)
            : current
              ? "existing value"
              : undefined,
          label,
        };
        adoptSiteValue(record);
        nodeRecords.set(representative as HTMLElement, record);
        records.set(record.id, record);
      }
      for (const member of group) nodeRecords.set(member as HTMLElement, record);
    }
  };
  const nativeActivationControl = (element: Element) => {
    const candidate =
      element instanceof HTMLInputElement
        ? element
        : (element instanceof HTMLLabelElement
            ? element
            : element.closest("label"))?.control;
    return candidate instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(candidate.type)
      ? candidate
      : undefined;
  };
  const expectOwnedActivation = (
    element: Element,
    method: string,
    event?: string,
  ) => {
    // A checkbox or radio a rule sets is clicked too (mainWorld.ts), and the
    // browser reports that click's input and change as trusted: unclaimed,
    // they read as the applicant's edit and paused every fill (Workday's
    // "I am fluent").
    const writesChoice =
      // (Every method that writes a value: Workday's default is "react".)
      ["selectCheckboxOrRadio", "checkOption", "default", "defaultWithoutBlur", "react", "dijit", "jQuery", "setValue", "setValueOnly"].includes(method) &&
      nativeActivationControl(element) === element;
    if (!(["click", "reactClick"].includes(method) || event === "click" || writesChoice))
      return;
    const control = nativeActivationControl(element);
    if (control)
      ownedActivation = { control, events: new Set(["input", "change"]) };
  };
  // The date beside a signature is today's date, a fact and not the
  // applicant's mark (Lever's eeo[disabilitySignatureDate], Workday's
  // dateSignedOn): it is filled like any other date.
  const manualSigningControl = (element: Element) =>
    [element.id, element.getAttribute("name") || ""].some(identity => {
      const words = identity.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
      return (
        !/(?:signature|sign(?:ed)?)[_-]?(?:date|on)\b|date[_-]?signed/i.test(words) &&
        /(?:^|[_-])(?:cust_?sign(?:ature)?|e_?sign(?:ature)?|signature|initials)(?:$|[_-])/i.test(words)
      );
    });
  function inspect(): Observation {
    const ats = adapterFor(location.href);
    const fields: Field[] = [];
    const counts = new Map<string, number>();
    const positionedRadioGroups = new Set<string>();
    for (const element of controls()) {
      // A read-only box filled from its own picker (Tesla's start date) is a
      // question all the same: listed, so an empty one is said to need you
      //. Only a picker writes it.
      if (!writable(element) && !(pickerBox(element) && controlVisible(element))) continue;
      // A read-only combobox naming its list is a list, picker button or not:
      // Microsoft's careers form read its sponsorship and location lists as
      // date pickers, and their options were never read.
      const listBox = element.getAttribute("role") === "combobox" && Boolean(element.getAttribute("aria-controls")) && !calendarBox(element);
      const kind =
        pickerBox(element) && !listBox
          ? "datepicker"
          : fileControls.has(element)
          ? "file"
          : isToggleChoice(element)
          ? "radio"
          : element.matches(`button[aria-haspopup="listbox"],${legacyReactSelect}`) || element.closest(".pcty-input-select__input")
          ? "combobox"
          // A text box that opens a calendar (react-datepicker; Ashby's
          // "ashby-application-form-input-date") takes only a date: on
          // leaving it, the picker drops anything else ("Immediately").
          // (SuccessFactors' UI5 date picker's input calls itself a "Date
          // Input": "What year…will you receive your degree?" there takes a
          // date.)
          // Amazon's is a combobox opening a calendar dialog, "YYYY-MM-DD":
          // as a list, it was opened and waited on for options it never has.
          : element instanceof HTMLInputElement && element.type === "text" &&
              (element.closest(".react-datepicker__input-container") || /(^|[\s_-])input-date\b/.test(element.className) ||
                element.getAttribute("aria-roledescription") === "Date Input" ||
                calendarBox(element))
          ? "datepicker"
          // A native list is one whatever role it is given: one employer's iCIMS
          // screening questions are <select role="combobox"> naming a
          // listbox that never appears, and were waited on as custom lists
          // until "Dropdown options were not available".
          : element instanceof HTMLSelectElement
          ? "select"
          : element.getAttribute("role")
          ? element.getAttribute("role")!
          // A type the browser does not know reads as "text": SuccessFactors'
          // "currency" box takes a number only ("Invalid number." for
          // "$100,000 per year.", an employer).
          : element instanceof HTMLInputElement && /^(currency|decimal|integer)$/i.test(element.getAttribute("type") || "")
            ? "number"
          : element instanceof HTMLInputElement
            ? element.type
            : element instanceof HTMLTextAreaElement
              ? "textarea"
              : element instanceof HTMLSelectElement
                ? "select"
                : "combobox";
      const label = fieldLabel(element);
      const group = kind === "radio" ? radioGroup(element) : [element];
      const representative = group.find(writable) || element;
      if (representative !== element) {
        const record = nodeRecords.get(representative as HTMLElement);
        if (record) nodeRecords.set(element, record);
        continue;
      }
      const section = sectionFor(element);
      const base = `${lockKey({ label, ...section })}:${kind}`;
      const occurrence = counts.get(base) || 0;
      counts.set(base, occurrence + 1);
      const semanticKey = `${base}:${occurrence}`;
      let record = nodeRecords.get(element);
      let id = semanticIds.get(semanticKey);
      if (!id) {
        id = record?.id || crypto.randomUUID();
        semanticIds.set(semanticKey, id);
      }
      const current = valueOf(element);
      if (!record) {
        const previous = records.get(id);
        record = {
          element,
          id,
          last: current,
          revision: (previous?.revision || 0) + 1,
          protected:
            (Boolean(current) && !previous?.automationWritten) ||
            Boolean(previous?.protected) ||
            hasEditLock(element, label),
          protectedBy: hasEditLock(element, label)
            ? lockReason(element, label)
            : previous?.protected
              ? previous.protectedBy
              : current && !previous?.automationWritten
                ? "existing value"
                : undefined,
          label,
          automationWritten: previous?.automationWritten,
          writePendingAt: previous?.writePendingAt,
          conflict: previous?.conflict,
        };
        // A replacement node is never trusted based solely on positional matching.
        // A site rebuilding the form empty where we had written a value
        // (Workday after "discard changes") rejected our value, as when it
        // clears a field in place: the next fill may try again.
        const clearedOurs =
          previous?.automationWritten && !previous.protected && !current && !hasEditLock(element, label);
        if (clearedOurs) {
          record.automationWritten = false;
          record.fillWarning = "The site cleared the value that was filled.";
        } else if (
          previous?.automationWritten &&
          previous.element !== element &&
          previous.last !== current &&
          !writePending(previous) &&
          !hasEditLock(element, label)
        ) {
          // A site that rebuilds its form puts its own values where ours
          // were: SuccessFactors, saving an uploaded resume, wrote back what
          // it parsed from it ("UNSPECIFIED" for a company, the 1st and the
          // 30th for dates) and those were then kept as if the applicant had
          // chosen them. No one typed
          // there: it is the site's value, and the next fill corrects it.
          record.protected = false;
          record.protectedBy = undefined;
          record.automationWritten = false;
          record.siteValue = true;
          record.confirmed = false;
          record.fillWarning = "The site replaced the value that was filled.";
        } else if (
          previous &&
          previous.element !== element &&
          previous.last !== current &&
          !writePending(previous)
        ) {
          record.protected = true;
          record.protectedBy = `replaced element changed value (${JSON.stringify(previous.last.slice(0, 40))} to ${JSON.stringify(current.slice(0, 40))})`;
        }
        if (
          !clearedOurs &&
          writePending(previous) &&
          previous?.automationWritten &&
          previous.last !== current
        )
          record.conflict = true;
        adoptSiteValue(record);
        nodeRecords.set(element, record);
        records.set(id, record);
      }
      for (const member of group) nodeRecords.set(member, record);
      if (record.label !== label) {
        if (!writePending(record)) {
          record.protected = true;
          record.protectedBy = `label changed from ${JSON.stringify(record.label.slice(0, 60))}`;
          addLock(lockKey({ label, ...section }), `${label}: ${record.protectedBy}`);
        }
        record.revision++;
        record.label = label;
      }
      if (record.last !== current) {
        record.siteValue = false;
        const was = record.last;
        // The site reformatting a value we wrote ("6025550101" shown as
        // "(602) 555-0101") is still our value, whenever it happens.
        const reformatted =
          record.automationWritten &&
          Boolean(current) &&
          was.toLowerCase().replace(/[^a-z0-9]/g, "") ===
            current.toLowerCase().replace(/[^a-z0-9]/g, "");
        // The site clearing a value we wrote rejected it; that is not the
        // applicant's decision, so the next fill may try again.
        const rejected = record.automationWritten && !current;
        const engineRelated = writePending(record) || reformatted;
        record.revision++;
        record.last = current;
        record.attachmentId = undefined;
        record.conflict = engineRelated || rejected ? false : record.automationWritten;
        record.automationWritten = engineRelated;
        record.writePendingAt = undefined;
        if (rejected && !engineRelated)
          record.fillWarning = "The site cleared the value that was filled.";
        else if (!engineRelated && !paused && performance.now() < siteFillUntil) {
          // The site is filling the form from the resume this extension
          // just uploaded, and nobody has touched the page: what it writes
          // is the site's guess, to be corrected from the profile, not an
          // edit of the applicant's to lock.
          record.siteValue = true;
          record.confirmed = false;
        }
        else if (!engineRelated && !paused &&
          ((applicationId && element.closest(".RCMFormField")) ||
            element.closest('[data-automation-id="applicationPage"] [data-automation-id^="formField-"]')) &&
          performance.now() - lastApplicantInput > 2000) {
          // Workday's Autofill with Resume does the same, as its page loads
          // and before any fill: its parser set Phone Device Type to
          // Landline after the page was read, and the profile's Mobile was
          // never written.
          // SuccessFactors puts back an answer it stored ("No" to clearance
          // eligibility) whenever another field of its form changes, and that
          // was locked as the applicant's. Nobody touched the page, and an applicant's change
          // comes with their own click or keys: it is the site's value, for
          // the profile to correct. (Elsewhere a change nobody can account for
          // is kept, as it may be the applicant's own tool's.)
          record.siteValue = true;
          record.confirmed = false;
        }
        else if (!engineRelated && !paused && applicationId && besideLastWrite(element) &&
          performance.now() - lastEngineWrite < 1500 && performance.now() - lastApplicantInput > 2000) {
          // The site answering a write of ours in the same small group of
          // fields: Ashby puts this year in a date's empty Year once its Month is
          // picked. Locked as the applicant's, the saved year was never
          // written, and the end date, kept after the start, followed it.
          record.siteValue = true;
          record.confirmed = false;
        }
        else if (!engineRelated) {
          record.protected = true;
          record.protectedBy = `value changed outside a fill (${JSON.stringify(was.slice(0, 40))} to ${JSON.stringify(current.slice(0, 40))})`;
          addLock(lockKey({ label, ...section }), `${label}: ${record.protectedBy}`);
        }
      }
      // An empty field has no value left to guard: only the applicant's own
      // clearing or lock keeps it empty, never what the site did to it
      // (rebuilt it, cleared it, relabelled it).
      if (
        record.protected &&
        !current &&
        (!/^a real/.test(record.protectedBy || "") || searchWithoutPick(element)) &&
        !hasEditLock(element, label)
      ) {
        record.protected = false;
        record.protectedBy = undefined;
      }
      // A signature can be labelled only "First & Last Name". Explicit
      // control identities still keep signatures and initials manual,
      // including configured fills and reviewed fallback writes.
      if (manualSigningControl(element)) {
        record.protected = true;
        record.protectedBy = "manual signature or initials";
      }
      const options =
        element instanceof HTMLSelectElement
          ? [...element.options]
              .filter((o) => !o.disabled && !placeholderOption(o))
              .map((o) => clip(o.label))
          : kind === "checkbox"
            ? ["Yes", "No"]
            : kind === "radio"
              ? group.filter(writable).map((candidate) => ownLabel(candidate))
              : kind === "combobox"
                ? drawnOptions(element)
                : [];
      // Every text is clipped to the backend's limits: one over-long lock
      // reason would otherwise reject the whole generation request.
      fields.push({
        id: record.id,
        label: label.slice(0, 1000),
        kind,
        value: (current || picksOf(element)).slice(0, 10000),
        required: fileControls.get(element)?.required ?? radioControls.get(element)?.required ?? isRequired(element),
        revision: record.revision,
        // An entry editor SmartRecruiters has open is its site rule's to
        // fill (the rule still writes there): its fields name no school or
        // job, and the general fill wrote one school's major and degree into
        // another's.
        protected:
          record.protected ||
          /password/.test(kind) ||
          label === "Unlabelled field" ||
          inEntryEditor(element),
        options: options.slice(0, 300),
        ...(options.length > 300 ? { optionCount: options.length } : {}),
        accept: (element.getAttribute("accept") || "").slice(0, 1000),
        format: dateFormatHint(element),
        maxWords: fieldWordLimit(element, label),
        ...((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
        element.maxLength > 0
          ? { maxLength: element.maxLength }
          : {}),
        documentKind: fileKind(element),
        replacesForm: replacesForm(element) || undefined,
        question: (kind === "checkbox" && (groupQuestion(element)?.text || checkboxEntryTitle(element) || hiddenAnswerQuestion(element))) || undefined,
        attachmentId: record.attachmentId,
        conflict: record.conflict,
        fillWarning: record.fillWarning?.slice(0, 350),
        protectedReason: record.protected ? (record.protectedBy || "unknown").slice(0, 300) : inEntryEditor(element) ? "a job or school entry its site rule fills" : undefined,
        siteValue:
          record.siteValue && !record.automationWritten && !record.confirmed && current ? true : undefined,
        valueText: element instanceof HTMLSelectElement && element.selectedOptions[0] &&
          element.selectedOptions[0].text.trim() !== current
          ? element.selectedOptions[0].text.trim().slice(0, 300)
          : undefined,
        ...validationState(element, current),
        ...section,
        section: section.section.slice(0, 500),
      });
      // Separate multi-option groups may repeat the same question (Lever).
      // Their occurrence IDs distinguish their positions; APPLY still checks
      // the exact node, revision, value and applicant edit locks.
      if (kind === "radio" && group.filter(writable).length > 1)
        positionedRadioGroups.add(record.id);
    }
    // A repeated text/upload control still has an ambiguous purpose. Radio
    // groups with their own options remain independently answerable.
    // The same list asked twice with the same choices is one question, both
    // answered alike: one employer's form repeats "Are you currently or have you
    // ever been employed by an employer…", and both were held back.
    const sameList = (field: Field) => {
      if (!/select|combobox/.test(field.kind) || !field.options.length) return false;
      const twins = fields.filter((other) => `${lockKey(other)}:${other.kind}` === `${lockKey(field)}:${field.kind}`);
      return twins.every((other) => other.options.join("\n") === field.options.join("\n"));
    };
    for (const field of fields)
      if ((counts.get(`${lockKey(field)}:${field.kind}`) || 0) > 1 && !positionedRadioGroups.has(field.id) && !sameList(field)) {
        field.protected = true;
        field.protectedReason ||= "another field has the same label";
      }
    // A page without a main region whose root is only its form (one employer's
    // careers page) keeps the posting outside that form: the
    // whole page is read, or the answers and documents never see the job.
    const matchedRoot = document.querySelector(ats.root);
    const pageRoot = !matchedRoot || matchedRoot.matches("form") ? document.body : matchedRoot;
    // A description the page keeps apart from its steps comes first: it is
    // what documents and answers are written from.
    const postingBlock = ats.posting ? document.querySelector(ats.posting) : null;
    const postingHTML = ats.postingHTML?.(document);
    const postingText =
      postingBlock && !pageRoot?.contains(postingBlock)
        ? clip(readableText(postingBlock), 20000)
        : postingHTML
          ? clip(readableText(new DOMParser().parseFromString(postingHTML, "text/html").body), 20000)
          : "";
    const pageText = clip(
      `${postingText ? `${postingText}\n` : ""}${readableText(pageRoot)}`,
      25000,
    );
    // "Sound Decisions - Herriman, UT": the employer, then where.
    const company = ats.company
      ? clip(document.querySelector(ats.company)?.textContent || "", 300).split(/\s[-–—|·]\s/)[0].trim()
      : "";
    const blockers: string[] = [];
    if ([...document.querySelectorAll('input[type="password"]')].some(rendered))
      blockers.push("Sign in or create your account manually.");
    if (
      document.querySelector(
        '[data-upload-status="pending"], [data-upload-status="error"], [data-automation-id="file-upload-error"]',
      )
    )
      blockers.push(
        "Wait for the document upload to finish or resolve the upload error.",
      );
    // An invisible CAPTCHA has nothing to click and never renders, so it was
    // silently missed here: the application read as prepared and the site then
    // refused the submission with its own verification error.
    const captchas = [
      ...document.querySelectorAll(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-sitekey], script[src*="recaptcha/api.js"], script[src*="hcaptcha.com/1/api.js"]',
      ),
    ];
    const solved = [
      ...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
        '[name="g-recaptcha-response"],[name="h-captcha-response"]',
      ),
    ].some((e) => e.value.trim());
    if (captchas.length && !solved)
      blockers.push(
        captchas.some(rendered)
          ? "Complete the site’s CAPTCHA if requested."
          : "The site verifies submissions with a CAPTCHA you cannot see. If it reports a verification error, reload the page and submit again.",
      );
    const next = nextButton();
    const atReview = [
      ...document.querySelectorAll('button, input[type="submit"]'),
    ].some(
      (b) =>
        b.getClientRects().length &&
        /^(submit( application)?|send application|complete application)$/i.test(
          clip(b.textContent || b.getAttribute("value") || ""),
        ),
    );
    return {
      documentId,
      url: location.href,
      // Not a heading the page keeps hidden until it is done (Breezy's
      // "Application Submitted").
      title: clip(
        [...document.querySelectorAll("h1")].find(rendered)?.textContent || document.title,
        1000,
      ),
      description: pageText,
      ...(company ? { company } : {}),
      ats: ats.name,
      fields,
      paused,
      ...(paused && pausedBy ? { pausedBy } : {}),
      blockers,
      // SuccessFactors' Resume and Cover Letter are attachment widgets with
      // no file box: named here so a letter is drafted for its slot (an employer
      // drafted none).
      ...((slots) => (slots.length ? { documentSlots: slots } : {}))([...new Set([...document.querySelectorAll(".attachmentField label")]
        .map((label) => /cover\s*letter/i.test(label.textContent || "") ? "cover" : /\b(resume|cv)\b/i.test(label.textContent || "") ? "resume" : "")
        .filter(Boolean))]),
      canAdvance: Boolean(next),
      atReview,
      addable: fields.length || !configEngineEnabled ? undefined : addableCollections(),
      ...(/^https:/.test(document.referrer) && document.referrer !== location.href ? { referrer: document.referrer.slice(0, 3000) } : {}),
    };
  }
  function nextButton(): HTMLButtonElement | undefined {
    const ats = adapterFor(location.href);
    if (!ats.next) return;
    const button = document.querySelector<HTMLButtonElement>(ats.next);
    if (
      !button ||
      button.disabled ||
      button.type !== "button" ||
      !button.getClientRects().length
    )
      return;
    const label = clip(
      button.textContent || button.getAttribute("aria-label") || "",
    );
    if (
      !/^(next|continue|save and continue)$/i.test(label) ||
      ats.final.test(label)
    )
      return;
    return button;
  }
  const editingTarget = (entry: EventTarget) =>
    entry instanceof HTMLElement &&
    (nodeRecords.has(entry) ||
      entry.isContentEditable ||
      entry.matches(
        'input,textarea,select,button,label,.select2-selection,[role="combobox"],[role="listbox"],[role="option"],[role="radio"],[role="checkbox"],[role="switch"],[role="textbox"],[role="spinbutton"],[role="slider"]',
      ));
  function human(event: Event) {
    if (writing && !event.isTrusted) return;
    // Our own real keystrokes (CDP) are trusted, so this is the one case where
    // a trusted event is not the user's. Telling them apart is safe because we
    // only type while the page lacks the user's attention (no focus, or no
    // click or key of theirs lately and no control of theirs in use), and
    // only into the one element being typed into right now.
    if (
      trustedWrite &&
      event.isTrusted &&
      !userAttention() &&
      (trustedKeyEvents.includes(event.type) || ourClick(event)) &&
      event.composedPath().includes(trustedWrite)
    )
      return;
    if (
      searchSettle &&
      performance.now() < searchSettle.until &&
      event.isTrusted &&
      !userAttention() &&
      ["input", "change"].includes(event.type) &&
      event.composedPath().includes(searchSettle.element)
    )
      return;
    if (event.isTrusted && ["pointerdown", "keydown", "touchstart"].includes(event.type)) {
      applicantGesture = performance.now();
      // Only a control that takes typing keeps their attention: a click on
      // Next starts the step the fill is about to type into.
      const touched = event.composedPath().find(editingTarget);
      const control = touched instanceof HTMLLabelElement ? touched.control : touched;
      applicantControl =
        control instanceof HTMLElement &&
        (control.isContentEditable ||
          control.matches('textarea,[role="textbox"],[role="combobox"],[role="spinbutton"]') ||
          (control instanceof HTMLInputElement &&
            !["button", "submit", "reset", "checkbox", "radio", "file", "image", "range", "color"].includes(control.type)))
          ? control
          : undefined;
    }
    if (event.isTrusted) lastApplicantInput = performance.now();
    if (!event.isTrusted) {
      if (applicationId && ["input", "change"].includes(event.type)) {
        inspect();
        tell({ type: "FORM_CHANGED", applicationId, operation, documentId });
      }
      return;
    }
    if (
      ["pointerdown", "keydown", "touchstart"].includes(event.type)
    ) {
      // The applicant watches the tab while it fills. Scrolling, reading and
      // clicking empty space are not edits; only touching a form control is.
      if (!event.composedPath().some(editingTarget)) return;
      ownedActivation = undefined;
      clearPendingWrites();
    }
    if (
      ["input", "change"].includes(event.type) &&
      ownedActivation &&
      event.composedPath().includes(ownedActivation.control)
    ) {
      ownedActivation.events.delete(event.type);
      if (!ownedActivation.events.size) ownedActivation = undefined;
      return;
    }
    if (event.type === "compositionstart") composing = true;
    if (event.type === "compositionend") composing = false;
    const path = event.composedPath();
    let target = path.find(
      (entry) => entry instanceof HTMLElement && nodeRecords.has(entry),
    ) as HTMLElement | undefined;
    if (!target) {
      const control = path
        .filter((entry): entry is Element => entry instanceof Element)
        .map(nativeActivationControl)
        .find((entry) => entry && nodeRecords.has(entry));
      target = control;
    }
    if (
      target &&
      ["input", "change"].includes(event.type)
    ) {
      const record = nodeRecords.get(target)!;
      const current = valueOf(record.element);
      if (current !== record.last) {
        record.protected = true;
        record.protectedBy = `a real ${event.type} on "${record.label.slice(0, 60)}"`;
        record.siteValue = false;
        record.revision++;
        record.last = current;
        record.automationWritten = false;
        record.conflict = false;
        addLock(
          lockKey({ label: record.label, ...sectionFor(record.element) }),
          record.protectedBy,
        );
        for (const key of elementLockKeys(record.element, record.label))
          addLock(key, record.protectedBy);
      }
    }
    if (!applicationId) return;
    // Named even when the page is already paused: the extension pauses it
    // itself once a fill ends, and the applicant's next edit is the cause.
    if (!pausedBy) {
      const touched = event.composedPath().find((entry): entry is HTMLElement => entry instanceof HTMLElement);
      const kind = event.type === "pointerdown" || event.type === "touchstart" ? "a click" : event.type === "keydown" ? "a key press" : event.type.startsWith("composition") ? "typing" : "an edit";
      const where = (target && nodeRecords.get(target)?.label) || touched?.getAttribute("aria-label") || touched?.textContent || touched?.tagName.toLowerCase() || "the page";
      pausedBy = `${kind} on "${clip(where, 60)}"`;
    }
    paused = true;
    configController.abort();
    tell({
      type: "HUMAN_PAUSE",
      applicationId,
      operation,
      documentId,
      cause: pausedBy,
      // Only the applicant's own edits are remembered with the application.
      // Locks from site behaviour stay with this page and end with it.
      locks: [...lockedLabels].filter(
        (key) =>
          /^(a real|an edit saved)/.test(lockOrigins.get(key) || "an edit saved"),
      ),
    });
  }
  for (const type of [
    "pointerdown",
    "keydown",
    "beforeinput",
    "input",
    "change",
    "compositionstart",
    "compositionend",
    "touchstart",
  ])
    document.addEventListener(type, human, { capture: true, passive: true });

  const valid = (command: Command) =>
    !paused &&
    !composing &&
    command.applicationId === applicationId &&
    command.operation === operation &&
    command.documentId === documentId;
  function invalidCommandReason(command: Command): string | undefined {
    if (paused) return "The application is paused.";
    if (composing) return "Text composition is in progress.";
    if (command.applicationId !== applicationId) return "The application binding changed.";
    if (command.operation !== operation) return "The fill operation changed.";
    if (command.documentId !== documentId) return "The page document changed.";
  }
  function guardedRecord(
    command: Command,
    proposal: Pick<Proposal, "fieldId" | "revision" | "expectedValue">,
  ): { record: RecordEntry; reason?: never } | { record?: undefined; reason: string } {
    const record = records.get(proposal.fieldId);
    const invalid = invalidCommandReason(command);
    if (invalid) return { reason: invalid };
    if (!record) return { reason: "The field is no longer recorded." };
    if (!record.element.isConnected) return { reason: "The field was detached from the page." };
    if (!writable(record.element)) return { reason: "The field is no longer writable." };
    if (fieldLabel(record.element) !== record.label) return { reason: "The field label changed." };
    if (record.protected) return { reason: "The field is protected from automatic changes." };
    // Only the same answer: one planned before the list's options were read
    // ("No", "December 2027") failed, and its corrected one ("Not
    // Applicable", "December") was then never tried.
    if (record.failedOperation === operation && (!("value" in proposal) || (proposal as { value?: string }).value === record.failedValue))
      return { reason: "The field already failed in this fill." };
    if (record.revision !== proposal.revision) return { reason: "The field revision changed since inspection." };
    if (valueOf(record.element) !== proposal.expectedValue) return { reason: "The field value changed since inspection." };
    // Focus our own typing moved there is not the applicant's: Workday moves
    // a date's focus from its Month to its Day as the Month is typed, and the
    // Day was refused, the date left half typed.
    const ourFocus = performance.now() - lastEngineWrite < 3000 && performance.now() - lastApplicantInput > 2000;
    if (document.activeElement === record.element && !ourFocus) return { reason: "The field currently has focus." };
    return { record };
  }
  function guard(
    command: Command,
    proposal: Pick<Proposal, "fieldId" | "revision" | "expectedValue">,
  ): RecordEntry | undefined {
    return guardedRecord(command, proposal).record;
  }
  function changed(record: RecordEntry) {
    record.writePendingAt = performance.now();
    record.element.dispatchEvent(
      new Event("input", { bubbles: true, composed: true }),
    );
    record.element.dispatchEvent(
      new Event("change", { bubbles: true, composed: true }),
    );
    record.last = valueOf(record.element);
    record.revision++;
    record.automationWritten = true;
    // The write stays attributed for writeGrace: frameworks commonly rewrite
    // the field right after our events, and that is not a user edit.
  }
  // react-select widgets (Greenhouse and many others) ignore synthetic events,
  // so they are driven through their component API in the page: list the
  // options, let the caller choose one, then select exactly that option.
  // Typing into their search box never counts as an answer.
  async function reactSelect(
    element: Element,
    choose: (labels: string[]) => string | undefined,
    searches: string[],
    safe: () => boolean,
    signal?: AbortSignal,
  ): Promise<"selected" | "unsupported" | "no-match"> {
    const guard = { applicationId, operation, documentId };
    const call = (method: string, values: string[]) =>
      requestMainWorld(element, guard, { method, values }, signal, safe);
    const componentDeadline = Date.now() + 5000;
    let listed = await call("reactSelectOptions", []);
    if (!listed.ok && listed.reason === "not-react-select" &&
        element.closest(".select__container, .select-shell, .select__control")) {
      // Server-rendered select inputs can precede their component handlers.
      // This exact failure guarantees no component API was invoked, so only
      // these read-only probes may repeat. Never replay an opening or choice.
      while (!listed.ok && listed.reason === "not-react-select" && Date.now() < componentDeadline) {
        if (!safe()) throw new Error("Custom control changed while waiting for its component.");
        await pause(50);
        listed = await call("reactSelectOptions", []);
      }
      if (!listed.ok && listed.reason === "not-react-select")
        throw new Error("Dropdown component was not ready within 5 seconds. Select manually.");
    }
    if (!listed.ok) {
      if (listed.reason === "not-react-select") {
        // This search input is not the selected value. Native click/type
        // fallbacks on Paylocity reset the captured form; an unsupported
        // component must stay manual, not be treated as an ordinary input.
        return element.closest(".pcty-input-select__input") ? "no-match" : "unsupported";
      }
      throw new Error(listed.reason || "Dropdown options could not be read.");
    }
    let pick = choose(JSON.parse(listed.value || "[]"));
    // Long names search poorly; their shorter forms come after them.
    for (const search of [
      ...new Set(
        searches
          .flatMap((term) => [term, ...nameVariants(term)])
          .map((term) => term.trim())
          .filter(Boolean),
      ),
    ].slice(0, 5)) {
      if (pick) break;
      listed = await call("reactSelectOptions", [search]);
      if (listed.ok) pick = choose(JSON.parse(listed.value || "[]"));
    }
    // Choosing nothing clears any search text we typed.
    const chosen = await call("reactSelectChoose", pick ? [pick] : []);
    if (!pick) return "no-match";
    if (!chosen.ok)
      throw new Error(
        chosen.reason || "The dropdown did not keep the selection.",
      );
    return "selected";
  }
  const reactSelectInput = (element: Element) =>
    element.matches(`input[role="combobox"][aria-autocomplete="list"],.pcty-input-select__input input[aria-autocomplete="list"],${legacyReactSelect}`)
      ? element
      : (element.querySelector(`input[role="combobox"][aria-autocomplete="list"],.pcty-input-select__input input[aria-autocomplete="list"],${legacyReactSelect}`) ??
        element
          .closest(".select__container, .select-shell, .select__control")
          ?.querySelector('input[role="combobox"][aria-autocomplete="list"]') ??
        undefined);
  // The arrow beside an Ashby dropdown's input opens its whole list (a press
  // or focus on the input does not). It only ever opens or closes that list;
  // outside a form it cannot submit anything.
  const ashbyToggle = (element: Element): HTMLButtonElement | undefined => {
    if (!element.matches('input.ashby-application-form-input-autocomplete[role="combobox"]')) return;
    const buttons = element.parentElement?.querySelectorAll<HTMLButtonElement>(":scope > button") || [];
    return buttons.length === 1 && !buttons[0].form && !buttons[0].closest("a,form") ? buttons[0] : undefined;
  };
  // Rippling's dropdowns (a div, or a search input) open on a click and close
  // on a press anywhere outside them; neither chooses anything.
  const ripplingSelect = (element: Element) =>
    element.matches('[role="combobox"][aria-haspopup="listbox"]') && Boolean(element.closest('[data-testid="select-controller"]'));
  // SuccessFactors' picklists open on a click, not on a press, and draw each
  // option as one menu item link inside it.
  const successFactorsPicklist = (element: Element) =>
    element.matches('input.rcmpaginatedselectinput[role="combobox"]');
  const pressOutside = () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, view: window }));
  // SuccessFactors marks a picklist closed on its Escape but leaves the list
  // drawn over the form; a press elsewhere on the page takes it away, as the
  // applicant's own click did (an employer recordings: of 556
  // Escapes sent while a list showed, none took it away).
  let lastLanePicklistClick = 0;
  let lastApplicantPicklistUse = 0;
  const closeSuccessFactorsList = (element: Element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    pressOutside();
  };
  function inEntryEditor(element: Element): boolean {
    for (let node: Element | undefined = element, depth = 0; node && depth < 8; depth++) {
      if (node.closest("oc-education-entry, oc-experience-entry")) return true;
      node = ((node.getRootNode() as ShadowRoot).host as Element | undefined) || undefined;
    }
    return false;
  }
  // The list a combobox names, found in its own root or in the roots of the
  // components around it: SmartRecruiters' box sits in an spl-input inside
  // the spl-autocomplete whose shadow root holds the menu.
  function controlledList(element: Element): HTMLElement | null {
    const id = element.getAttribute("aria-controls") || element.getAttribute("aria-owns") || "";
    if (!id || /\s/.test(id)) return null;
    for (let root: Node = element.getRootNode(), depth = 0; depth < 4; depth++) {
      const found = (root as Document | ShadowRoot).querySelector?.<HTMLElement>(`#${CSS.escape(id)}`);
      if (found) return found;
      const host = (root as ShadowRoot).host;
      if (!host) break;
      root = host.getRootNode();
    }
    return null;
  }
  // An option component whose role="option" is drawn in its own shadow root
  // (SmartRecruiters' spl-select-option), its text slotted from outside.
  function shadowedOptions(list: Element): HTMLElement[] {
    return [...list.children].filter((child): child is HTMLElement =>
      child instanceof HTMLElement && !child.matches('[role="option"]') && Boolean(deepOption(child)));
  }
  function deepOption(host: Element): HTMLElement | null {
    const visit = (root: ShadowRoot | null, depth: number): HTMLElement | null => {
      if (!root || depth > 3) return null;
      const own = root.querySelector<HTMLElement>('[role="option"]');
      if (own) return own;
      for (const node of root.querySelectorAll("*")) {
        const found = visit(node.shadowRoot, depth + 1);
        if (found) return found;
      }
      return null;
    };
    return visit(host.shadowRoot, 0);
  }
  // Its options already in the page, closed (SmartRecruiters keeps them
  // drawn): read without opening, so the answer is one of them.
  function drawnOptions(element: Element): string[] {
    if (element.getAttribute("role") !== "combobox") return [];
    const list = controlledList(element);
    if (!list) return [];
    const own = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    // An option component draws its role="option" only once its list has
    // been opened: SmartRecruiters' Gender, Race and Veteran lists, never
    // opened, read as none, and Veteran went unanswered. Its own element, named for an option, is one.
    const drawn = own.length ? own : shadowedOptions(list);
    const options = drawn.length ? drawn : [...list.children].filter((child): child is HTMLElement =>
      child instanceof HTMLElement && /-option$/i.test(child.tagName) && !child.matches("[hidden]"));
    return [...new Set(options
      .filter((option) => option.getAttribute("aria-disabled") !== "true" && deepOption(option)?.getAttribute("aria-disabled") !== "true")
      .map((option) => (option.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean))];
  }

  async function selectCustom(
    command: Command,
    proposal: Proposal,
    record: RecordEntry,
  ) {
    const element = record.element;
    writing = false; // Never suppress trusted edits while awaiting site options.
    // A link with no address goes nowhere: iCIMS draws every list as an
    // <a role="combobox"> without one, and each job's Country and State were
    // refused as able to navigate.
    if (
      (element instanceof HTMLButtonElement && element.type !== "button") ||
      element.closest("a[href]")
    )
      throw new Error(
        "This custom control could navigate or submit; select it manually.",
      );
    let ownsFocus = false;
    const ashbyLocation = element instanceof HTMLInputElement &&
      element.matches('.ashby-application-form-input-autocomplete[role="combobox"]') &&
      (element.closest('[data-field-path="_systemfield_location"]') ||
        (proposal.source === "confirmed-profile" &&
          ["current location", "where are you located"].includes(normalize(record.label)) &&
          element.closest('.ashby-application-form-field-entry[data-field-path]'))) &&
      proposal.expectedValue === "" ? element : undefined;
    // A combobox that says typing filters its list (aria-autocomplete="list")
    // may hold the answer only behind a search: C3's school list asks its
    // server for what is typed. Searched once, and only after the open list
    // had no exact option.
    const typeahead = !ashbyLocation && element instanceof HTMLInputElement &&
      element.getAttribute("role") === "combobox" &&
      element.getAttribute("aria-autocomplete") === "list" &&
      (element.getAttribute("aria-controls") || ashbyToggle(element)) &&
      proposal.expectedValue === "" ? element : undefined;
    let searchInput: HTMLInputElement | undefined = ashbyLocation;
    let searchValue: string | undefined;
    let searchWritten = false;
    const changedReason = (): string | undefined => {
      const invalid = invalidCommandReason(command);
      if (invalid) return invalid;
      if (record.element !== element) return "The field element changed.";
      if (!element.isConnected) return "The field was detached from the page.";
      if (!writable(element)) return "The field is no longer writable.";
      if (fieldLabel(element) !== record.label) return "The field label changed.";
      if (record.protected) return "The field is protected from automatic changes.";
      if (record.revision !== proposal.revision) return "The field revision changed since inspection.";
      if (valueOf(element) !== proposal.expectedValue) return "The field value changed since inspection.";
      if (searchWritten && searchInput?.value !== searchValue) return "The autocomplete search changed during selection.";
    };
    const unsafeReason = () => changedReason() ||
      (document.activeElement === element && !ownsFocus ? "The field has focus outside this selection." : undefined);
    const safe = () => !unsafeReason();
    const assertSafe = (message: string) => {
      const reason = unsafeReason();
      if (reason) throw new Error(`${message} ${reason}`);
    };
    assertSafe("Custom control changed before selection.");
    if (reactSelectInput(element) === element) {
      writing = true;
      try {
        record.writePendingAt = performance.now();
        const outcome = await reactSelect(
          element,
          (labels) => pickOption(proposal, labels, (label) => label),
          [proposal.value, ...(proposal.choices || [])],
          safe,
        );
        if (outcome === "selected") {
          if (!valid(command) || record.protected || !element.isConnected)
            throw new Error("Custom selection was superseded.");
          record.last = valueOf(element);
          record.revision++;
          record.automationWritten = true;
          return;
        }
        if (outcome === "no-match")
          throw new Error(
            `No dropdown option matches "${proposal.value}". Choose it manually.`,
          );
      } finally {
        writing = false;
      }
    }
    // An iCIMS list shows a first page until searched: India was not on it,
    // and a job's Country stayed empty. Its own search box
    // is used, as its site rule does for schools.
    if (element.matches('a[id$="_icimsDropdown"]')) {
      writing = true;
      try {
        record.writePendingAt = performance.now();
        const outcome = await searchSiteList(element, [proposal.value, ...(proposal.choices || [])].filter(Boolean));
        if (outcome === "selected") {
          if (!valid(command) || record.protected || !element.isConnected) throw new Error("Custom selection was superseded.");
          record.last = valueOf(element);
          record.revision++;
          record.automationWritten = true;
          return;
        }
        // Nothing found by searching, or no search box to search with: the
        // list is still picked from as drawn, below.
      } finally {
        writing = false;
      }
    }
    let openingRequested = false;
    // An option of this selection was clicked (its list then closes itself).
    let picked = false;
    let openingInterrupted = false;
    const interruptOpeningFocus = (event: Event) => {
      if (event.isTrusted) {
        openingInterrupted = true;
        ownsFocus = false;
      }
    };
    const acquireOpenedFocus = () => {
      if (openingRequested && !openingInterrupted && !changedReason() &&
        document.activeElement === element) ownsFocus = true;
    };
    const attentionEvents = ["pointerdown", "keydown", "touchstart"];
    element.addEventListener("focus", acquireOpenedFocus);
    for (const type of attentionEvents)
      document.addEventListener(type, interruptOpeningFocus, true);
    // A SuccessFactors picklist can say it is open with no list drawn (one
    // opened and closed earlier, or before a refresh): taken at its word,
    // its list was waited on for 15 s and never came. It is opened as a closed one.
    const staleOpen = () => {
      if (!successFactorsPicklist(element) || element.getAttribute("aria-expanded") !== "true") return false;
      const owned = document.getElementById((element.getAttribute("aria-owns") || "").split(/\s+/)[0]);
      return !owned || !rendered(owned);
    };
    try {
      if (element.getAttribute("aria-expanded") !== "true" || staleOpen()) {
        writing = true;
        try {
          record.writePendingAt = performance.now();
          // React-style selects open on mousedown; do not type search text,
          // press Enter, or activate another tab.
          openingRequested = true;
          const toggle = ashbyLocation ? undefined : ashbyToggle(element);
          // Ashby's dropdowns list their options only from their arrow.
          if (toggle) toggle.click();
          // Clicked, then focused, as its site rule does: a click alone
          // marks it open and loads nothing.
          else if (successFactorsPicklist(element)) {
            element.click();
            element.focus({ preventScroll: true });
          }
          // An iCIMS list opens on a mousedown; a click alone does nothing,
          // and each job's Country waited 5 s on a list never opened.
          else if (element instanceof HTMLInputElement || element.matches('a[id$="_icimsDropdown"]'))
            element.dispatchEvent(
              new MouseEvent("mousedown", {
                bubbles: true,
                button: 0,
                view: window,
              }),
            );
          else element.click();
          // The opening handler can focus asynchronously. The scoped focus
          // listener attributes that focus only while this command and field
          // remain unchanged and no trusted pointer/key/touch has occurred.
          acquireOpenedFocus();
        } finally {
          writing = false;
        }
      }
      // Some comboboxes list their options when focused, not on a press
      // (C3's own form over Greenhouse). Focus is taken as this selection's
      // own, under the same checks, and released when the selection ends.
      if (element instanceof HTMLInputElement && ripplingSelect(element) && element.getAttribute("aria-expanded") !== "true") {
        assertSafe("Custom selection paused or superseded.");
        writing = true;
        try {
          record.writePendingAt = performance.now();
          element.click();
        } finally {
          writing = false;
        }
      }
      if (
        !ashbyLocation &&
        element instanceof HTMLInputElement &&
        element.getAttribute("role") === "combobox" &&
        element.getAttribute("aria-controls")
      ) {
        await pause(200);
        acquireOpenedFocus();
        assertSafe("Custom selection paused or superseded.");
        // Oracle's lists open from their own arrow button, not a press on
        // the box (one employer's graduation date). A click opens
        // them in a page out of view too, where focus comes with no event.
        const listId = element.getAttribute("aria-controls")!;
        const arrow = element.getAttribute("aria-expanded") !== "true"
          ? [...(element.getRootNode() as Document | ShadowRoot).querySelectorAll<HTMLElement>("button[aria-controls]")]
            .find((button) => button.getAttribute("aria-controls") === listId && button !== element)
          : undefined;
        if (arrow) {
          writing = true;
          try {
            record.writePendingAt = performance.now();
            arrow.click();
          } finally {
            writing = false;
          }
          await pause(200);
          acquireOpenedFocus();
          assertSafe("Custom selection paused or superseded.");
        }
        if (element.getAttribute("aria-expanded") !== "true" && document.activeElement !== element) {
          openingRequested = true;
          element.focus({ preventScroll: true });
          // Its own focus, though a page out of view sends no focus event.
          acquireOpenedFocus();
          assertSafe("Custom selection paused or superseded.");
        }
        // Still closed: a whole click on the box, then the arrow drawn beside
        // it (hidden from assistive tech, naming no list). Microsoft's
        // careers form opens neither on a press nor on focus. Only a list that stayed shut gets these.
        for (const press of [
          () => element,
          () => element.parentElement?.querySelector<HTMLButtonElement>('button[aria-hidden="true"][tabindex="-1"]:not([aria-label*="clear" i])') || undefined,
        ]) {
          await pause(150);
          if (element.getAttribute("aria-expanded") === "true") break;
          const target = press();
          if (!target) continue;
          assertSafe("Custom selection paused or superseded.");
          writing = true;
          try {
            record.writePendingAt = performance.now();
            target.click();
          } finally {
            writing = false;
          }
          acquireOpenedFocus();
        }
      }
      // A SuccessFactors list comes from the site's server, 2.5 to 3 seconds
      // on one employer's: it gets 15.
      const deadline = Date.now() + (successFactorsPicklist(element) ? 15000 : 5000);
      if (ashbyLocation && proposal.value.trim()) {
        assertSafe("Custom selection paused or superseded.");
        openingRequested = true;
        ashbyLocation.focus({ preventScroll: true });
        assertSafe("Custom selection paused or superseded.");
        searchValue = proposal.value.trim();
        ownedAutocompleteSearches.set(ashbyLocation, searchValue);
        writing = true;
        try {
          record.writePendingAt = performance.now();
          const searched = await requestMainWorld(ashbyLocation,
            { applicationId, operation, documentId },
            { method: "defaultWithoutBlur", values: [searchValue] }, undefined, safe);
          if (!searched.ok) throw new Error(searched.reason || "The autocomplete search could not be written.");
          searchWritten = true;
          assertSafe("Custom selection paused or superseded.");
        } finally {
          writing = false;
        }
      }
      const searchAfter = Date.now() + 1200;
      // What the list held when the search was typed, and when: the same
      // list just afterwards is still the unsearched one.
      let unsearched = "";
      let searchedAt = 0;
      const canSearch = () => Boolean(typeahead && !searchWritten && proposal.value.trim() &&
        document.activeElement === typeahead && ownsFocus);
      const search = async (listed: string) => {
        searchInput = typeahead!;
        searchValue = proposal.value.trim();
        ownedAutocompleteSearches.set(typeahead!, searchValue);
        writing = true;
        try {
          record.writePendingAt = performance.now();
          const searched = await requestMainWorld(typeahead!,
            { applicationId, operation, documentId },
            { method: "defaultWithoutBlur", values: [searchValue] }, undefined, safe);
          if (!searched.ok) throw new Error(searched.reason || "The autocomplete search could not be written.");
          searchWritten = true;
          unsearched = listed;
          searchedAt = Date.now();
          assertSafe("Custom selection paused or superseded.");
        } finally {
          writing = false;
        }
      };
      while (Date.now() < deadline) {
        acquireOpenedFocus();
        assertSafe("Custom selection paused or superseded.");
        // A list that never showed anything may also only answer a search.
        if (canSearch() && Date.now() > searchAfter) await search("");
        const root = element.getRootNode() as Document | ShadowRoot;
        const listId =
          element.getAttribute("aria-controls") ||
          element.getAttribute("aria-owns");
        // A list button that names no list (Workday's) has the one list open
        // on the page; while another question's list is still closing, two
        // are, and neither is taken.
        const openLists = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"]')].filter(rendered);
        // iCIMS' lists name none: theirs is in the "_ctnr" box drawn beside
        // the link (each job's Country on one employer's form).
        const icimsList = () => element.matches('a[id$="_icimsDropdown"]')
          ? document.getElementById(`${element.id}_ctnr`)?.querySelector<HTMLElement>('[role="listbox"]') || null
          : null;
        const list =
          listId && !/\s/.test(listId)
            ? root.querySelector(`#${CSS.escape(listId)}`) || controlledList(element)
            : listButton(element) && openLists().length === 1 ? openLists()[0] : icimsList();
        if (
          list &&
          rendered(list) &&
          element.getAttribute("aria-expanded") === "true" &&
          list.getAttribute("aria-busy") !== "true"
        ) {
          // Oracle's lists are grids of one cell per choice (one employer's
          // graduation date).
          const grid = list.matches('[role="grid"]') || element.getAttribute("aria-haspopup") === "grid";
          const roled = [
            ...list.querySelectorAll<HTMLElement>(grid ? '[role="option"],[role="gridcell"]' : '[role="option"]'),
          ];
          const shadowed = roled.length ? [] : shadowedOptions(list);
          const options = (roled.length ? roled : shadowed).filter(
            (o) => rendered(o) && o.getAttribute("aria-disabled") !== "true" && (!shadowed.length || deepOption(o)?.getAttribute("aria-disabled") !== "true"),
          );
          // An Ashby school result is a name with its country and web domain
          // beside it; the name alone is the option.
          const optionText = (o: HTMLElement) => {
            const names = o.querySelectorAll('[class*="canonicalSchoolResultName_"]');
            return (names.length === 1 ? names[0].textContent : o.textContent) || "";
          };
          // A list showing only its placeholder is still loading: Workday
          // opens with "Select One" and adds its answers a moment later, and
          // a pick read at once found nothing.
          if (options.length && options.every((o) => /^\s*(select one|select|select\.\.\.|choose one|please select|no selection)\s*$/i.test(optionText(o)))) {
            await pause(50);
            continue;
          }
          // "Select "Other" if it is not in list": the question's own rule,
          // for an answer the list does not hold; its follow-up asks for the
          // name (one employer's school).
          const otherAsked = /\bselect\s*["“']?other["”']?\s*if\b[^.?]*\bnot\b[^.?]*\blist/i.test(record.label);
          const option = pickOption(proposal, options, optionText) ||
            (otherAsked ? options.find((candidate) => /^other\b/i.test(optionText(candidate).trim())) : undefined);
          if (option) {
            const expected = optionText(option);
            // An option component (SmartRecruiters' spl-select-option)
            // ignores a script's click, as its location menu did: the box is
            // focused and real Down keys reach the option, then Enter takes it
            // (one employer's screening lists).
            // Microsoft's careers lists: a click on an option only lights it
            // (aria-activedescendant), the list stays open and nothing is
            // kept, and the applicant's next click on the box emptied it
            //. Real Down keys until the box names the option as
            // its active one, then Enter, as the applicant would.
            if (!shadowed.length && element.matches('input[class*="select-module_select-input"]') && option.id && !userAttention()) {
              const keys = new AbortController();
              const allowed = () => !changedReason() && !userAttention();
              const active = () => element.getAttribute("aria-activedescendant") || "";
              const at = (id: string) => options.findIndex((candidate) => candidate.id === id);
              writing = true;
              trustedWrite = element;
              try {
                record.writePendingAt = performance.now();
                openingRequested = true;
                (element as HTMLElement).focus({ preventScroll: true });
                acquireOpenedFocus();
                const target = at(option.id);
                for (let steps = 0; steps <= options.length + 1 && active() !== option.id && allowed(); steps++) {
                  await requestTrustedType(element, { applicationId, operation, documentId }, "", 0, keys.signal, allowed, false, at(active()) > target ? -1 : 1, true);
                  await pause(120);
                }
                if (active() === option.id)
                  await requestTrustedType(element, { applicationId, operation, documentId }, "", 0, keys.signal, allowed, true, 0);
                else if (window === window.top && allowed()) {
                  // Down moved nothing on the live list: a real click on the
                  // option, as the applicant would.
                  option.scrollIntoView({ block: "nearest" });
                  await pause(100);
                  const box = option.getBoundingClientRect();
                  if (!box.width || !box.height) throw new Error("The dropdown did not highlight the option. Choose it manually.");
                  // Its list is drawn elsewhere on the page: the click there is
                  // this write's, not the applicant's.
                  trustedWrite = option.closest('[role="listbox"]') || option.parentElement || element;
                  await requestTrustedType(element, { applicationId, operation, documentId }, "", 0, keys.signal, allowed, false, 0, false,
                    { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
                } else throw new Error("The dropdown did not highlight the option. Choose it manually.");
                picked = true;
              } finally {
                trustedWrite = undefined;
                writing = false;
              }
              for (let waited = 0; waited < 1500 && normalize(valueOf(element)) !== normalize(expected); waited += 100) await pause(100);
              if (element.getAttribute("aria-expanded") === "true") { pressOutside(); (element as HTMLElement).blur(); }
              if (!valid(command) || record.protected || !element.isConnected) throw new Error("Custom selection was superseded.");
              if (normalize(valueOf(element)) !== normalize(expected)) throw new Error("The dropdown did not confirm the exact selection. Verify it manually.");
              record.last = valueOf(element);
              record.revision++;
              record.automationWritten = true;
              return;
            }
            if (shadowed.length) {
              const position = shadowed.indexOf(option) + 1;
              let component: Element = element;
              for (let host = (element.getRootNode() as ShadowRoot).host as Element | undefined, depth = 0; host && depth < 4; host = (host.getRootNode() as ShadowRoot).host as Element | undefined, depth++) {
                component = host;
                if (host.matches("spl-autocomplete,spl-multiselect-autocomplete,[role='combobox']")) break;
              }
              assertSafe("Custom selection paused or superseded.");
              if (userAttention()) throw new Error("The applicant is using the page; choose it manually.");
              const keys = new AbortController();
              writing = true;
              trustedWrite = component;
              try {
                record.writePendingAt = performance.now();
                openingRequested = true;
                (element as HTMLElement).focus({ preventScroll: true });
                acquireOpenedFocus();
                // One Down at a time, reading which entry is lit, and Enter
                // once it is the one: one employer's lists open with their first
                // entry lit, so a count of Downs from the box overshot by one
                // (Graduation Year 2028 for 2027).
                const lit = () => shadowed.findIndex((candidate) => {
                  const inner = deepOption(candidate);
                  return Boolean(inner && (inner.classList.contains("active") || (inner.getRootNode() as ShadowRoot).activeElement === inner));
                });
                const allowed = () => !changedReason() && !userAttention();
                const target = position - 1;
                // Already chosen: Enter on it would take it away again.
                const already = () => splChosen(element).includes(shadowed[target].getAttribute("value") || "\u0000") ||
                  deepOption(shadowed[target])?.getAttribute("aria-selected") === "true";
                if (already()) {
                  if (element.getAttribute("aria-expanded") === "true") { pressOutside(); (element as HTMLElement).blur(); }
                  record.last = valueOf(element);
                  record.automationWritten = true;
                  return;
                }
                const step = (count: number) => requestTrustedType(element, { applicationId, operation, documentId }, "", 0, keys.signal, allowed, false, count, true).then(() => pause(80));
                let moved = false;
                for (let steps = 0; steps <= shadowed.length && lit() !== target; steps++) {
                  if (lit() > target) break;
                  // A menu that let a Down pass lets them all: on to the click.
                  if (moved && lit() < 0) break;
                  await step(1);
                  moved = true;
                }
                // The entry lit as the list opened was never reached by a key:
                // an Enter then took nothing, in the box (it closed a
                // multiselect) or on the entry focused by a script (the list
                // kept its own place), and one employer's "Not Applicable", first
                // in its lists, stayed empty.
                // Down and back Up reach it as the applicant would.
                if (!moved && lit() === target && shadowed.length > 1) {
                  await step(1);
                  await step(-1);
                }
                if (lit() === target)
                  await requestTrustedType(element, { applicationId, operation, documentId }, "", 0, keys.signal, allowed, true, 0);
                else {
                  // Down lit nothing (one employer's screening Gender and Race): a real click on the entry instead.
                  const entry = deepOption(shadowed[target]) || shadowed[target];
                  entry.scrollIntoView({ block: "nearest" });
                  await pause(100);
                  const box = entry.getBoundingClientRect();
                  if (window !== window.top || !box.width || !box.height || !allowed())
                    throw new Error("The dropdown did not highlight the option. Choose it manually.");
                  await requestTrustedType(element, { applicationId, operation, documentId }, "", 0, keys.signal, allowed, false, 0, false,
                    { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
                }
                picked = true;
              } catch (error) {
                // Never left open: a list the pick could not finish is closed.
                if (element.getAttribute("aria-expanded") === "true") { pressOutside(); (element as HTMLElement).blur(); }
                throw error;
              } finally {
                trustedWrite = undefined;
                writing = false;
              }
              const chosenValue = option.getAttribute("value");
              const chosen = () => Boolean(chosenValue && splChosen(element).includes(chosenValue)) || [valueOf(element), picksOf(element), component.getAttribute("value") || "",
                // A multiselect shows each pick as a tag named by its label
                // attribute (SmartRecruiters' spl-tag), in its shadow root.
                // (in spl-tags-list's own shadow root, a level further in).
                ...(() => {
                  const all: Element[] = [];
                  const visit = (root: ParentNode, depth: number) => {
                    for (const node of root.querySelectorAll("*")) {
                      all.push(node);
                      if (node.shadowRoot && depth < 4) visit(node.shadowRoot, depth + 1);
                    }
                  };
                  visit(component, 0);
                  if (component.shadowRoot) visit(component.shadowRoot, 1);
                  return all;
                })()
                  .filter((node) => /tag|chip|pill/i.test(node.tagName + " " + (node.getAttribute("class") || "")))
                  .map((node) => `${node.getAttribute("label") || ""} ${node.textContent || ""}`)]
                .some((text) => normalize(text).includes(normalize(expected)));
              for (let waited = 0; waited < 1500 && !chosen(); waited += 100) await pause(100);
              if (!valid(command) || record.protected || !element.isConnected)
                throw new Error("Custom selection was superseded.");
              if (!chosen()) {
                if (element.getAttribute("aria-expanded") === "true") { pressOutside(); (element as HTMLElement).blur(); }
                throw new Error("The dropdown did not confirm the exact selection. Verify it manually.");
              }
              // A list that stays open for more picks is closed.
              if (element.getAttribute("aria-expanded") === "true") (element as HTMLElement).blur();
              record.last = valueOf(element);
              record.revision++;
              record.automationWritten = true;
              return;
            }
            // An option drawn as a plain button (type="button", so it can
            // never submit) is still just the option.
            const plainButton = option.matches('button[type="button"]') && !option.parentElement?.closest("a,button,input");
            // A SuccessFactors option is its one menu item link.
            const menuItem = successFactorsPicklist(element) && option.querySelectorAll("a,button,input").length === 1
              ? option.querySelector<HTMLAnchorElement>(':scope > a[role="menuitem"]')
              : null;
            if (
              (!plainButton && option.closest("a,button,input")) ||
              (!menuItem && option.querySelector("a,button,input"))
            )
              throw new Error(
                "Dropdown option contains an action control; choose manually.",
              );
            // All revision/value/connection checks are synchronous immediately
            // before this one click. No click is retried after dispatch.
            assertSafe("Custom selection paused or superseded.");
            if (!option.isConnected || !list.contains(option))
              throw new Error("Custom selection paused or superseded. The option was detached or left its menu.");
            writing = true;
            try {
              record.writePendingAt = performance.now();
              (menuItem || option).click();
              picked = true;
              // A SuccessFactors list still loading its next page when the
              // pick was made opens itself again once the page arrives (a
              // Country list of 100, an employer): it is
              // waited for and closed.
              if (successFactorsPicklist(element)) {
                const listId = element.getAttribute("aria-owns") || "";
                for (let waited = 0; waited < 900; waited += 150) {
                  await pause(150);
                  const reopened = listId ? document.getElementById(listId) : null;
                  if ((reopened && rendered(reopened)) || element.getAttribute("aria-expanded") === "true")
                    closeSuccessFactorsList(element);
                }
              }
              if (searchInput) {
                await pause(0);
                ownedAutocompleteSearches.delete(searchInput);
                searchValue = undefined;
                searchWritten = false;
              }
              // Ashby closes its list and shows the choice a moment after the click.
              if (ashbyToggle(element) || ripplingSelect(element))
                for (let waited = 0; waited < 600 && element.getAttribute("aria-expanded") === "true"; waited += 30)
                  await pause(30);
            } finally {
              writing = false;
            }
            if (!valid(command) || record.protected || !element.isConnected)
              throw new Error("Custom selection was superseded.");
            if (normalize(valueOf(element)) !== normalize(expected) ||
              (ashbyLocation && element.getAttribute("aria-expanded") === "true"))
              throw new Error(
                "The dropdown did not confirm the exact selection. Verify it manually.",
              );
            // The widget already dispatched its own change events. Replaying
            // input/change on its search box can clear a confirmed selection.
            record.last = valueOf(element);
            record.revision++;
            record.automationWritten = true;
            return;
          }
          const listed = options.map((o) => o.textContent || "").join("\n");
          if (options.length && canSearch()) {
            await search(listed);
            continue;
          }
          if (options.length && !(typeahead && searchWritten && listed === unsearched && Date.now() - searchedAt < 2500))
            throw new Error(
              "No exact dropdown option. Search or select manually.",
            );
        }
        await pause(50);
      }
      throw new Error(
        `Dropdown options were not available within ${successFactorsPicklist(element) ? 15 : 5} seconds. Search or select manually.`,
      );
    } finally {
      if (searchInput && searchValue !== undefined) {
        // Clear only our unchanged query, never an applicant edit. A failed
        // search must not leave city text pretending to be a selected option.
        if (safe()) {
          writing = true;
          try {
            await requestMainWorld(searchInput,
              { applicationId, operation, documentId },
              { method: "defaultWithoutBlur", values: [""] }, undefined, safe);
          } catch {
            // A newly paused/stale command cannot clean up by writing.
          }
        }
        ownedAutocompleteSearches.delete(searchInput);
      }
      // A SuccessFactors picklist this selection opened stays over the form
      // when nothing in it was picked (no option matched, or none came): its
      // own Escape and a press elsewhere close it (one employer's profile, lists stacked open after a fill).
      // Its page may still arrive after that (2.5 to 3 seconds on one employer's
      // server) and open it again; it is watched for a moment and closed
      // again (lists left open over the form).
      if (successFactorsPicklist(element) && openingRequested && !picked && !openingInterrupted && element.isConnected) {
        const listId = element.getAttribute("aria-owns") || "";
        for (let waited = 0; waited <= 3000; waited += 250) {
          const shown = listId ? document.getElementById(listId) : null;
          if (element.getAttribute("aria-expanded") === "true" || (shown && rendered(shown)))
            closeSuccessFactorsList(element);
          if (waited < 3000) await pause(250);
        }
      }
      // An Ashby list left open hides every other question from assistive
      // technology (aria-hidden), and so from the next inspection. Close the
      // one this selection opened, from its own arrow, when nothing was chosen.
      const arrow = ashbyToggle(element);
      if (arrow && openingRequested && !openingInterrupted && valid(command) && element.isConnected &&
          element.getAttribute("aria-expanded") === "true" && !(element as HTMLInputElement).value) {
        writing = true;
        arrow.click();
        // The arrow hands focus to the input, sometimes a moment later.
        await pause(150);
        if (!openingInterrupted && document.activeElement === element) ownsFocus = true;
      }
      if (ripplingSelect(element) && openingRequested && !openingInterrupted && valid(command) && element.isConnected &&
          element.getAttribute("aria-expanded") === "true") pressOutside();
      // A Workday list this selection opened and picked nothing from is
      // closed, not left over the form: its own Escape, then a press on the
      // page as the site's rules make (one employer's Phone Device Type, with no exact option to pick).
      if (listButton(element) && openingRequested && !picked && !openingInterrupted && valid(command) && element.isConnected) {
        const shownLists = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"]')].filter(rendered);
        if (shownLists().length) {
          element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
          await pause(150);
        }
        if (shownLists().length) {
          writing = true;
          (document.querySelector<HTMLElement>('[data-automation-id="mainContent"]') || document.body).click();
          await pause(150);
        }
      }
      writing = false;
      element.removeEventListener("focus", acquireOpenedFocus);
      for (const type of attentionEvents)
        document.removeEventListener(type, interruptOpeningFocus, true);
      // Only release focus this selection took; never focus the user moved.
      if (ownsFocus && document.activeElement === element) element.blur();
    }
  }
  // Checks a native checkbox or radio with a click, as a person does: React
  // forms keep their own state and learn of a choice only from its click.
  // Workday leaves an assigned "checked" in place while its own state stays
  // empty (the box shows selected, the form reports it unanswered), and
  // Ashby puts it back. A page that ignores the click gets the assignment.
  // The click's trusted input/change are claimed as the engine's so they
  // aren't taken for the applicant's edit.
  // A box ticked or cleared with a real click, as the applicant would: a
  // script's click changed Greenhouse's box on screen but not its own
  // state, which drew "U.S. citizen" ticked again.
  // A script's click where real ones cannot be made (an embedded frame, no
  // debugger permission).
  async function clickBox(control: HTMLInputElement, checked: boolean, command: Command): Promise<boolean> {
    if (control.checked === checked) return true;
    if (window === window.top) {
      const target = (control.getClientRects().length ? control : control.labels?.[0]) as HTMLElement | undefined;
      target?.scrollIntoView({ block: "nearest" });
      await pause(80);
      const box = target?.getBoundingClientRect();
      if (box && box.width > 0 && box.height > 0) {
        trustedWrite = control.closest(".checkbox__wrapper,label,li,div") || control;
        try {
          await requestTrustedType(control, { applicationId, operation, documentId }, "", 0, undefined, () => valid(command), false, 0, false,
            { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
        } catch {
          // Falls back to a script's click below.
        } finally {
          trustedWrite = undefined;
        }
        await pause(120);
        if (control.checked === checked) return true;
      }
    }
    return checkControl(control, checked);
  }
  async function checkControl(control: HTMLInputElement, checked: boolean): Promise<boolean> {
    if (control.checked === checked) return true;
    expectOwnedActivation(control, "click");
    control.click();
    await pause(0);
    if (control.checked === checked) return true;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")!.set!.call(control, checked);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await pause(0);
    return control.checked === checked;
  }
  const associatedNativeChoice = (element: Control, type: "radio" | "checkbox"): HTMLInputElement | undefined => {
    const nested = [...element.querySelectorAll<HTMLInputElement>(`input[type="${type}"]`)];
    const label = element.closest("label");
    const labelled = label?.control;
    const candidates = [...new Set([...nested, ...(labelled instanceof HTMLInputElement && labelled.type === type ? [labelled] : [])])];
    if (candidates.length > 1) throw new Error("The native choice association is ambiguous.");
    if (candidates.length && (!candidates[0].isConnected || candidates[0].disabled)) throw new Error("The associated native choice is unavailable.");
    return candidates[0];
  };
  // Widgets that keep their own state ignore assigned values and synthetic
  // keys alike; Workday's date sections are the reason this path exists.
  // Where in the menu a typed box opened the entry naming a value sits,
  // counted from 1, not the box's own "fill manually" entry: SmartRecruiters'
  // "Lansing, MI, US" for "Lansing, MI". A script's click on it was
  // ignored, so it is reached with the keys the applicant uses. Its menu may
  // sit in the component's nested shadow roots. 0: none listed (after up to
  // 2.5 s for the menu).
  // The entries a component's menu lists, its role="option" elements in any
  // of its shadow roots, in order.
  function menuEntries(element: Element): HTMLElement[] {
    // The component around the box, not the box: an input that is itself a
    // combobox naming its list matched at once, and its menu (in the
    // component's shadow root) was never searched.
    let host: Element | undefined = ((element.getRootNode() as ShadowRoot).host as Element | undefined) || undefined;
    for (let depth = 0; host && depth < 4 && !host.matches("spl-autocomplete,spl-multiselect-autocomplete"); depth++)
      host = ((host.getRootNode() as ShadowRoot).host as Element | undefined) || undefined;
    if (!host) {
      const list = controlledList(element);
      return list ? [...list.querySelectorAll<HTMLElement>('[role="option"]')].filter((option) => option.getAttribute("aria-disabled") !== "true") : [];
    }
    const found: HTMLElement[] = [];
    const visit = (root: ParentNode) => {
      for (const node of root.querySelectorAll<HTMLElement>("*")) {
        if (node.getAttribute("role") === "option") found.push(node);
        if (node.shadowRoot) visit(node.shadowRoot);
      }
    };
    visit(host);
    if (host.shadowRoot) visit(host.shadowRoot);
    return found.filter((option) => option.getAttribute("aria-disabled") !== "true");
  }
  async function listedPosition(element: Element, values: string[], signal: AbortSignal): Promise<number> {
    const plain = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
    const wanted = values.map(plain).filter(Boolean);
    const options = () => menuEntries(element);
    // An entry drawn in its option component's shadow root shows the label
    // slotted into that component: the text is the component's.
    const label = (option: Element) => {
      let node: Element | undefined = option;
      for (let depth = 0; node && depth < 3; depth++) {
        const text = (node.textContent || "").trim();
        if (text) return text;
        node = ((node.getRootNode() as ShadowRoot).host as Element | undefined) || undefined;
      }
      return "";
    };
    for (let waited = 0; waited < 2_500 && !signal.aborted; waited += 150) {
      const listed = options();
      const names = listed.map((option) => (/\bmanual/i.test(label(option)) ? "" : plain(label(option))));
      let index = names.findIndex((name) => name && wanted.includes(name));
      if (index < 0) index = names.findIndex((name) => name && wanted.some((value) => name.startsWith(`${value},`) || name.startsWith(`${value} (`)));
      if (index >= 0) return index + 1;
      if (listed.length && names.some(Boolean)) return 0;
      await pause(150);
    }
    return 0;
  }

  async function typeTrusted(
    command: Command,
    element: Element,
    text: string,
    safe: () => boolean,
    signal: AbortSignal,
    retry = true,
    enter = false,
    choose = false,
  ): Promise<boolean> {
    if (!text || userAttention()) return false;
    const focusable = element as HTMLElement;
    if (typeof focusable.focus !== "function") return false;
    const focused = () =>
      (element.getRootNode() as Document | ShadowRoot).activeElement ===
      element;
    focusable.focus();
    // Some sites move focus on their own a moment later (Workday sends an
    // empty date's Year back to Month). Keys follow focus, so a field that
    // lost it is never typed into.
    await pause(150);
    if (!focused() || !safe()) return false;
    trustedWrite = element;
    misdirected = false;
    // A longer value than the Backspaces would reach is selected, and the
    // keys typed replace it: sixteen Backspaces left the start of an earlier
    // address in front of the new one (Microsoft).
    const held = ((element as HTMLInputElement).value || "").length;
    const selectAll = held > 16 && element instanceof HTMLInputElement && /^(text|search|email|tel|url)$/.test(element.type);
    if (selectAll) (element as HTMLInputElement).select();
    try {
      const result = await requestTrustedType(
        element,
        { applicationId, operation, documentId },
        text,
        // Only what this field actually holds: one Backspace too many
        // steps into the neighbouring date section and clears that. A
        // Workday date section empties on a single Backspace, and its "2005"
        // took two: the second sent focus back to the Day, and the year was
        // never typed.
        selectAll ? 0 : element.matches('input[role="spinbutton"][data-automation-id^="dateSection"]') ? Math.min(1, held) : Math.min(16, held),
        signal,
        () => safe() && !userAttention() && focused(),
        enter,
      );
      if (!result.ok) return false;
    } catch (error) {
      if (!valid(command)) throw error;
      return false;
    } finally {
      // Workday commits a date section when focus leaves it, and that blur
      // fires a trusted change event of our own making, so the exemption
      // has to outlive it.
      // A search box keeps focus: its results list closes when it blurs,
      // and the pick that follows is made from that list.
      if (!enter && !choose && !userAttention() && focused()) focusable.blur();
      if (enter || choose) searchSettle = { element, until: performance.now() + 4000 };
      trustedWrite = undefined;
    }
    // The page has focus now, so where it settles after focusing the field
    // again is what the check before typing sees.
    if (misdirected)
      return retry && typeTrusted(command, element, text, safe, signal, false, enter, choose);
    return true;
  }

  let boxesWanted: { operation: number; boxes: Map<HTMLInputElement, { element: HTMLInputElement; wanted: boolean; fieldId: string }> } = { operation: -1, boxes: new Map() };
  async function apply(command: Command) {
    const results: { id: string; ok: boolean; reason?: string }[] = [];
    // Date parts typed with their Month (see the Workday date below), and
    // the dates already tried so.
    const typedWhole = new Set<string>();
    const datesTried = new Set<Element>();
    // Boxes ticked or cleared in this fill, read again at the end of each
    // batch: the click that redraws one may come in a later batch.
    if (boxesWanted.operation !== operation) boxesWanted = { operation, boxes: new Map() };
    const boxesSet = boxesWanted.boxes;
    for (const proposal of command.proposals || []) {
      if (typedWhole.has(proposal.fieldId)) {
        results.push({ id: proposal.fieldId, ok: true });
        continue;
      }
      const guarded = guardedRecord(command, proposal);
      const record = guarded.record;
      // A report then says which answer the fill meant for a field and where
      // it came from: a clearance question was answered "No" in report after
      // report, and nothing showed whether this extension or the site did it.
      stopRecording?.note({
        label: (record?.label || proposal.fieldId).slice(0, 80),
        value: proposal.value.slice(0, 80),
        source: proposal.source,
        skipped: record ? undefined : guarded.reason,
      });
      if (!record) {
        results.push({
          id: proposal.fieldId,
          ok: false,
          reason: `Paused, protected, stale, or focused field. ${guarded.reason}`,
        });
        continue;
      }
      const element = record.element;
      let selectedLabel = proposal.value;
      let typedDate = false;
      const savesBefore = savesFinished;
      tell({ type: "FILL_PROGRESS", applicationId, operation, documentId, label: record.label });
      writing = true;
      try {
        record.writePendingAt = performance.now();
        if (
          element instanceof HTMLInputElement &&
          ["file", "password", "hidden"].includes(element.type)
        )
          throw new Error("Requires manual input.");
        // Text typed in a list of picks' search box is a search the site
        // drops: typed there, one employer's Field of Study was empty again at each
        // look and typed again every two seconds. Its
        // site rule picks from it; what that leaves is the applicant's.
        if (element.matches('[data-automation-id="multiSelectContainer"] input[data-uxi-widget-type="selectinput"]'))
          throw new Error("Pick it from the site's list; typed text there is only a search.");
        // A Workday list is a button that opens it (button[aria-haspopup]):
        // an answer no site rule wrote is picked from it like any other list.
        // It failed as "a custom control" instead (one employer's KPMG question).
        // Not a native list given the role (one employer's iCIMS screening questions):
        // it is set as a select.
        if ((element.getAttribute("role") === "combobox" && !(element instanceof HTMLSelectElement) && !calendarBox(element)) || element.closest(".pcty-input-select__input") || element.matches(legacyReactSelect) || listButton(element)) {
          await selectCustom(command, proposal, record);
          await awaitSiteSave(savesBefore);
          record.fillWarning = undefined;
          results.push({ id: proposal.fieldId, ok: true });
          continue;
        } else if (
          element instanceof HTMLInputElement &&
          element.type === "checkbox"
        ) {
          if (!["Yes", "No"].includes(proposal.value))
            throw new Error("Unknown checkbox value.");
          if (!(await clickBox(element, proposal.value === "Yes", command)))
            throw new Error("Site did not retain the value.");
          boxesSet.set(element, { element, wanted: proposal.value === "Yes", fieldId: proposal.fieldId });
        } else if (
          element instanceof HTMLInputElement &&
          element.type === "radio"
        ) {
          const selected = pickOption(
            proposal,
            radioGroup(element).filter(
              (c): c is HTMLInputElement =>
                c instanceof HTMLInputElement && c.type === "radio",
            ),
            (c) => ownLabel(c),
          );
          if (!selected) throw new Error("No exact radio option.");
          if (!(await checkControl(selected, true)))
            throw new Error("Site did not retain the value.");
        } else if (element.getAttribute("role") === "radio") {
          const selected = pickOption(proposal, radioGroup(element).filter(writable), (option) => ownLabel(option));
          stopRecording?.note({ label: record.label.slice(0, 80), chose: selected ? ownLabel(selected) : undefined, id: selected?.id });
          if (!selected) throw new Error("No exact radio option.");
          if (selected instanceof HTMLButtonElement && selected.type === "submit" && selected.form)
            throw new Error("This choice is a submit button inside the form; select it manually.");
          if (selected.getAttribute("aria-checked") !== "true") {
            const native = associatedNativeChoice(selected, "radio");
            if (native) {
              if (!(await checkControl(native, true))) throw new Error("Site did not retain the native choice.");
            } else selected.click();
          }
          await pause(0);
        } else if (element.getAttribute("role") === "checkbox") {
          if (!["Yes", "No"].includes(proposal.value)) throw new Error("Unknown checkbox value.");
          const wanted = proposal.value === "Yes";
          const native = associatedNativeChoice(element, "checkbox");
          if (native) {
            if (!(await checkControl(native, wanted))) throw new Error("Site did not retain the native choice.");
          } else if ((element.getAttribute("aria-checked") === "true") !== wanted) {
            if (element instanceof HTMLButtonElement && element.type === "submit" && element.form)
              throw new Error("This choice is a submit button inside the form; select it manually.");
            element.click();
          }
          await pause(0);
        } else if (isToggleChoice(element)) {
          const selected = pickOption(proposal, toggleGroup(element), (b) => ownLabel(b));
          if (!selected) throw new Error("No exact option.");
          // Ashby's toggles are type=submit outside any form. Inside a form,
          // clicking one could submit the application, which is never ours to do.
          if (selected instanceof HTMLButtonElement && selected.type === "submit" && selected.form)
            throw new Error("This choice is a submit button inside the form; select it manually.");
          // A click is how the site's own handler records the choice; the
          // pressed state follows its re-render.
          if (selected.getAttribute("aria-pressed") !== "true") selected.click();
          await pause(0);
        } else if (element instanceof HTMLSelectElement) {
          const option = pickOption(
            proposal,
            [...element.options].filter((o) => !o.disabled),
            (o) => o.label,
          );
          if (!option) throw new Error("No exact select option.");
          selectedLabel = option.label;
          Object.getOwnPropertyDescriptor(
            HTMLSelectElement.prototype,
            "value",
          )!.set!.call(element, option.value);
        } else if (element instanceof HTMLInputElement && element.matches('input[role="spinbutton"][data-automation-id^="dateSection"]')) {
          // A Workday date's Month, Day or Year keeps only what is typed:
          // set, one employer's graduation Month and Day read back empty. Typed as the site's rules type them.
          writing = true;
          try {
            // Its sections take numbers: December is typed as 12.
            const digits = (wanted: Proposal) => /^\d+$/.test(wanted.value.trim())
              ? wanted.value.trim()
              : (wanted.choices || []).find((choice) => /^\d+$/.test(choice.trim()))?.trim() || wanted.value;
            const typed = digits(proposal);
            // The whole date from its Month, as a person types it: Workday
            // moves focus on to the Day and the Year as each is typed, and a
            // Day or Year typed on its own after that had focus taken back to
            // the Month, the date left half typed and its year made 2005
            //. Parts this fill does not answer keep what
            // they hold.
            const wrapper = element.closest('[data-automation-id="dateInputWrapper"],[role="group"]');
            const part = (name: string) => wrapper?.querySelector<HTMLInputElement>(`input[data-automation-id="dateSection${name}-input"]`) || undefined;
            const wantedFor = (input?: HTMLInputElement) =>
              input ? (command.proposals || []).find((other) => records.get(other.fieldId)?.element === input) : undefined;
            const month = part("Month");
            const day = part("Day");
            const year = part("Year");
            const two = (text: string) => (/^\d$/.test(text) ? `0${text}` : text);
            const textOf = (input: HTMLInputElement | undefined, digitsOf: (input: HTMLInputElement) => string) =>
              input ? (input === element ? typed : wantedFor(input) ? digits(wantedFor(input)!) : digitsOf(input)) : "";
            const monthText = two(textOf(month, (input) => input.value));
            const dayText = two(textOf(day, (input) => input.value));
            const yearText = textOf(year, (input) => input.value);
            // Once per date in a fill: a site that does not move on gets
            // each part typed on its own.
            const whole = month && year && wrapper && !datesTried.has(wrapper) &&
              /^\d{2}$/.test(monthText) && /^\d{4}$/.test(yearText) && (!day || /^\d{2}$/.test(dayText));
            let advanced = false;
            let monthTyped = false;
            if (whole) {
              datesTried.add(wrapper!);
              monthTyped = true;
              // The Month first: a site that moves on by itself takes the rest
              // where focus goes; one that does not gets each part below.
              await typeTrusted(command, month!, monthText, () => valid(command), new AbortController().signal);
              await pause(200);
              const next = day || year!;
              advanced = month!.getRootNode() instanceof Document && (month!.ownerDocument.activeElement === next);
              if (advanced) {
                // Each part where focus has gone, at once: typing stops when
                // focus leaves the box it began in (typeTrusted).
                if (day) {
                  await typeTrusted(command, day, dayText, () => valid(command), new AbortController().signal);
                  await pause(200);
                }
                await typeTrusted(command, year!, yearText, () => valid(command), new AbortController().signal);
                await pause(300);
                const same = (input: HTMLInputElement | undefined, text: string) => !input || Number(input.value) === Number(text);
                if (!same(month, monthText) || !same(day, dayText) || !same(year, yearText))
                  throw new Error("Site did not retain the value.");
                // Every part typed is this fill's at once: the Year's change,
                // seen before its own proposal came up, was taken for the
                // applicant's edit and locked.
                for (const input of [month, day, year]) {
                  if (!input) continue;
                  const typedRecord = nodeRecords.get(input);
                  if (typedRecord && typedRecord !== record) {
                    typedRecord.last = valueOf(input);
                    typedRecord.revision++;
                    typedRecord.automationWritten = true;
                    typedRecord.writePendingAt = performance.now();
                  }
                  const done = wantedFor(input);
                  if (done && done.fieldId !== proposal.fieldId) typedWhole.add(done.fieldId);
                }
              }
            }
            if (!advanced && !(monthTyped && element === month) &&
                !(await typeTrusted(command, element, typed, () => valid(command), new AbortController().signal)))
              throw new Error("Site did not retain the value.");
          } finally {
            writing = false;
            // Its keys may move focus to the next part (see guardedRecord).
            lastEngineWrite = performance.now();
          }
          typedDate = true;
        } else if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          if (element.getAttribute("role") === "combobox" && !calendarBox(element))
            throw new Error("Custom autocomplete requires review.");
          Object.getOwnPropertyDescriptor(
            element instanceof HTMLInputElement
              ? HTMLInputElement.prototype
              : HTMLTextAreaElement.prototype,
            "value",
          )!.set!.call(element, proposal.value);
        } else throw new Error("Custom control requires manual selection.");
        if (typedDate) {
          // Its keys were the site's own events: only the record follows.
          record.writePendingAt = performance.now();
          record.last = valueOf(record.element);
          record.revision++;
          record.automationWritten = true;
        } else changed(record);
        // Left as when typed into: Amazon's text questions keep their answer
        // only on blur, and showed it while Continue still called it required.
        if (
          !typedDate && (
          element instanceof HTMLTextAreaElement ||
          (element instanceof HTMLInputElement && !["checkbox", "radio"].includes(element.type)))
        ) {
          element.dispatchEvent(new FocusEvent("blur"));
          element.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
        }
        await awaitSiteSave(savesBefore);
        const accepted =
          element instanceof HTMLSelectElement
            ? normalize(element.selectedOptions[0]?.label || "") ===
              normalize(selectedLabel)
            : element instanceof HTMLInputElement && element.type === "checkbox"
              ? element.checked === (proposal.value === "Yes")
              : element.getAttribute("role") === "checkbox"
                ? (element.getAttribute("aria-checked") === "true") === (proposal.value === "Yes")
              : valueOf(element) === proposal.value;
        if (accepted) record.fillWarning = undefined;
        results.push({
          id: proposal.fieldId,
          ok: accepted,
          reason: accepted ? undefined : "Site did not retain the value.",
        });
      } catch (error) {
        // Skipped for the rest of this fill only; the next request retries.
        record.failedOperation = operation;
        record.failedValue = proposal.value;
        record.fillWarning = (error as Error).message.slice(0, 350);
        results.push({
          id: proposal.fieldId,
          ok: false,
          reason: (error as Error).message,
        });
      } finally {
        writing = false;
      }
    }
    // Boxes a site's own list redraws: Greenhouse's put "U.S. citizen" back
    // when the next box of its list was ticked, after it had been unticked
    //. Each box this batch set is read again once
    // the page has redrawn, and set again where it drifted; one still wrong
    // is reported, never left as done.
    const drifted = () => [...boxesSet.values()].some((box) => box.element.isConnected && box.element.checked !== box.wanted);
    if (boxesSet.size) await pause(400);
    for (let round = 0; round < 2 && drifted(); round++) {
      for (const box of boxesSet.values()) {
        if (!box.element.isConnected || box.element.checked === box.wanted || !valid(command)) continue;
        const record = nodeRecords.get(box.element);
        writing = true;
        try {
          await clickBox(box.element, box.wanted, command);
          if (record) {
            record.last = valueOf(box.element);
            record.revision++;
            record.automationWritten = true;
          }
        } finally {
          writing = false;
        }
      }
      await pause(400);
    }
    for (const box of boxesSet.values())
      if (box.element.isConnected && box.element.checked !== box.wanted) {
        const result = results.find((entry) => entry.id === box.fieldId);
        if (result) Object.assign(result, { ok: false, reason: "The site set this box back after it was changed. Check it." });
      }
    return { results, observation: inspect() };
  }
  let pageTimersOn = false;
  let pumpingPageTimers = false;
  async function executeCommand(command: Command): Promise<unknown> {
    // The last line of defence for a draft-only site: whatever asked, this
    // page is not written to, opened or advanced.
    if (draftOnlySite(location.href) && /^(APPLY|ATTACH|CONFIG_FILL|ADVANCE|REMOVE_ROW|OPTIONS)$/.test(command.type))
      throw new Error(DRAFT_ONLY_NOTE);
    if (command.type === "ENGINE_INFO")
      return { version: CONTENT_VERSION, configEngine: configEngineEnabled };
    // While a fill runs, a hidden page's own timers are run when due
    // (engine/page/timers.ts): this frame's clock, which Chrome does not slow,
    // calls them a few times a second.
    if (command.type === "PAGE_TIMERS") {
      pageTimersOn = Boolean(command.on);
      if (pageTimersOn && !pumpingPageTimers) {
        pumpingPageTimers = true;
        void (async () => {
          try {
            while (pageTimersOn) {
              await pause(100);
              if (pageTimersOn && document.visibilityState === "hidden")
                document.dispatchEvent(new Event(PAGE_TIMER_EVENT));
            }
          } finally {
            pumpingPageTimers = false;
          }
        })();
      }
      return { on: pageTimersOn };
    }
    if (command.type === "INSPECT") return inspect();
    // Whether a file of this name is attached in an upload slot: its name
    // shown beside a control that removes it (Greenhouse's "Remove file",
    // Oracle's "Remove Resume"). A list of earlier uploads to pick from
    // ("Use") names files that are not attached.
    if (command.type === "ATTACHED") {
      const name = (command.name || "").trim();
      const removes = (element: Element) =>
        [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title")].some((text) =>
          // Workday's is "Delete".
          /^\s*(remove|delete)\b/i.test(text || ""),
        );
      // Only a file the applicant can see is attached: one employer's Oracle keeps
      // the cover letter and its "Remove Cover Letter" button in a part of
      // the page that is not shown, and it was taken for the one in
      // Additional Documents, which stayed empty.
      const shown = (element: Element) =>
        (element as HTMLElement).getClientRects().length > 0 &&
        (element as HTMLElement).checkVisibility({ visibilityProperty: true, opacityProperty: true });
      const named = name
        ? [...document.querySelectorAll("body *")].filter(
            (element) => !element.childElementCount && (element.textContent || "").trim() === name && shown(element),
          )
        : [];
      // A site that takes the file into a list of its own names it as that
      // list's choice: Microsoft's "Upload your resume" box held the name,
      // and the résumé was sent again on each fill, its parse emptying the
      // address typed before it.
      const chosen = Boolean(name) && [...document.querySelectorAll<HTMLInputElement>('input[role="combobox"]')]
        .some((box) => box.value.trim() === name && shown(box));
      return {
        attached: chosen || named.some((element) => {
          let scope: Element | null = element;
          for (let depth = 0; scope && depth < 4; depth++, scope = scope.parentElement)
            if ([...scope.querySelectorAll('button, a, [role="button"]')].some((control) => control !== element && removes(control)))
              return true;
          return false;
        }),
      };
    }
    if (
      command.type === "UNLOCK" &&
      command.applicationId === applicationId
    ) {
      // Forget edit locks on this page. Fields with a value stay protected
      // (they are never overwritten); empty ones may be filled again.
      lockedLabels.clear();
      lockOrigins.clear();
      for (const record of records.values()) {
        record.failedOperation = undefined;
        if (!valueOf(record.element)) {
          record.protected = false;
          record.protectedBy = undefined;
        }
      }
      return inspect();
    }
    if (
      command.type === "REMOVE_ROW" &&
      command.applicationId === applicationId
    ) {
      // A row the site added from a parsed resume, removed with the site's
      // own "Delete Education (3)" control. Nothing else is ever clicked.
      const section = String(command.section || "");
      const number = Number(command.index) + 1;
      const wanted = new RegExp(
        `^(delete|remove)\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(?${number}\\)?$`,
        "i",
      );
      const control = [
        ...document.querySelectorAll<HTMLElement>("a[aria-label],button[aria-label],[role='button'][aria-label]"),
      ].find((element) => wanted.test((element.getAttribute("aria-label") || "").trim()));
      if (!control) return { removed: false };
      // A field of that row, to confirm the row is really gone afterwards.
      const member = [...records.values()].find((record) => {
        const place = sectionFor(record.element);
        return place.section === section && place.index === Number(command.index);
      })?.element;
      writing = true;
      try {
        control.click();
      } finally {
        writing = false;
      }
      for (let waited = 0; waited < 1500; waited += 100) {
        await pause(100);
        if (!member || !member.isConnected || member.getClientRects().length === 0)
          return { removed: Boolean(member) };
      }
      return { removed: false };
    }
    if (command.type === "EDITED_ANSWERS") {
      // Answers the applicant (not this extension) put on the page, as
      // candidates for the saved-answer bank.
      const observation = inspect();
      // A native list's value is its option's hidden value (one employer's location
      // "65f5e6fd-…", Tesla's "7_months_or_more"); a saved answer is filled
      // by the text the applicant picked. A radio with no label of its own
      // reads as its hidden value too: that one has no text to keep.
      const shown = (field: Observation["fields"][number]): Observation["fields"][number] => {
        const element = records.get(field.id)?.element;
        if (element instanceof HTMLSelectElement) {
          const option = element.selectedOptions[0];
          return { ...field, value: option ? clip(option.label || option.text) : "" };
        }
        if (element instanceof HTMLInputElement && element.type === "radio") {
          const selected = radioGroup(element).find((candidate) => candidate instanceof HTMLInputElement && candidate.checked);
          return { ...field, value: selected ? ownLabel(selected) : "" };
        }
        return field;
      };
      return observation.fields.map(shown).filter((field) => {
        const record = records.get(field.id);
        return (
          record &&
          !record.automationWritten &&
          field.value &&
          !["file", "password", "hidden"].includes(field.kind) &&
          field.label !== "Unlabelled field" &&
          !secretName.test(field.label) &&
          /^(a real|value changed outside a fill|existing value)/.test(
            record.protectedBy || "",
          )
        );
      });
    }
    if (command.type === "RECORD_START") {
      const session = String(command.session || "");
      // Already recording this session in this document: keep going.
      if (stopRecording && recordingSession === session) return { recording: true };
      stopRecording?.();
      recordingSession = session;
      const labelOf = (element: Element) => {
        try {
          return fieldLabel(element as Control);
        } catch {
          return element.getAttribute("aria-label") || "";
        }
      };
      stopRecording = startRecorder({
        session,
        startedAt: Number(command.startedAt) || Date.now(),
        send: (events) => tell({ type: "RECORD_EVENTS", session, events }),
        label: labelOf,
        value: (element) => {
          try {
            return valueOf(element as Control).slice(0, 300);
          } catch {
            return undefined;
          }
        },
        secret: (element) =>
          (element instanceof HTMLInputElement && element.type === "password") ||
          secretName.test(
            `${element.getAttribute("name") || ""} ${element.id} ${labelOf(element)}`,
          ),
        fields: () =>
          inspect().fields.map((field) => ({
            label: field.label,
            kind: field.kind,
            value:
              /password/.test(field.kind) || secretName.test(field.label)
                ? "[redacted]"
                : field.value.slice(0, 300),
          })),
        redactURL,
      });
      return { recording: true };
    }
    if (command.type === "RECORD_CHECKPOINT") {
      return { events: stopRecording?.checkpoint() || [] };
    }
    if (command.type === "RECORD_STOP") {
      const events = stopRecording?.() || [];
      stopRecording = undefined;
      recordingSession = "";
      return { events };
    }
    if (command.type === "SNAPSHOT") {
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      // A clone leaves shadow roots behind, and with them what web components
      // hold (SuccessFactors' date pickers). Each open one is written in as a
      // declarative shadow root, as the browser would serialize it.
      const shadowRoots: ShadowRoot[] = [];
      const collect = (root: Document | ShadowRoot) => {
        for (const element of root.querySelectorAll("*"))
          if (element.shadowRoot) {
            shadowRoots.push(element.shadowRoot);
            collect(element.shadowRoot);
          }
      };
      collect(document);
      const liveElements = [...document.documentElement.querySelectorAll("*")];
      const cloneElements = [...clone.querySelectorAll("*")];
      liveElements.forEach((element, index) => {
        if (!element.shadowRoot || !cloneElements[index]) return;
        const template = document.createElement("template");
        template.setAttribute("shadowrootmode", "open");
        const root = element.shadowRoot as ShadowRoot & {
          getHTML?: (options: { shadowRoots: ShadowRoot[] }) => string;
        };
        template.innerHTML = root.getHTML ? root.getHTML({ shadowRoots }) : root.innerHTML;
        cloneElements[index].prepend(template);
      });
      clone.querySelectorAll("script,noscript").forEach((node) => node.remove());
      const sensitiveName = secretName;
      clone
        .querySelectorAll<HTMLMetaElement>("meta[name]")
        .forEach((meta) => {
          if (sensitiveName.test(meta.name)) meta.setAttribute("content", "[redacted]");
        });
      // Inline handlers are page code, not form state, and can embed tokens.
      for (const node of clone.querySelectorAll("*"))
        for (const attribute of [...node.attributes])
          if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
      for (const attribute of ["href", "src", "action", "formaction"])
        clone.querySelectorAll(`[${attribute}]`).forEach((node) => {
          const value = node.getAttribute(attribute) || "";
          if (/[?#]/.test(value))
            node.setAttribute(attribute, redactURL(new URL(value, location.href).href));
        });
      const secretValues = new Set<string>();
      const live = [
        ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
          "input,textarea,select",
        ),
      ];
      const copies = [
        ...clone.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
          "input,textarea,select",
        ),
      ];
      live.forEach((control, index) => {
        const copy = copies[index];
        if (!copy) return;
        const secret =
          (control instanceof HTMLInputElement && control.type === "password") ||
          sensitiveName.test(
            `${control.name} ${control.id} ${fieldLabel(control)}`,
          );
        if (secret && control.value) secretValues.add(control.value);
        const value = secret
          ? "[redacted]"
          : control instanceof HTMLInputElement && control.type === "file"
            ? control.files?.[0]?.name || ""
            : // Hidden fields can hold whole documents (iCIMS keeps the
              // uploaded resume as base64); reports never carry file contents.
              control instanceof HTMLInputElement &&
                control.type === "hidden" &&
                control.value.length > 200
              ? `[omitted ${control.value.length} characters]`
              : control.value;
        copy.setAttribute("data-lane-value", value);
        copy.removeAttribute("value");
        if (copy instanceof HTMLTextAreaElement) copy.textContent = value;
        if (copy instanceof HTMLSelectElement) {
          if (secret) copy.replaceChildren(new Option("[redacted]", "[redacted]"));
          else
            [...copy.options].forEach((option) => {
              if (option.value === value) option.setAttribute("selected", "");
              else option.removeAttribute("selected");
            });
        }
        if (control instanceof HTMLInputElement && control.checked)
          copy.setAttribute("data-lane-checked", "true");
      });
      const observation = inspect();
      observation.fields = observation.fields.map((field) =>
        sensitiveName.test(field.label) || secretValues.has(field.value)
          ? { ...field, value: "[redacted]" }
          : field,
      );
      observation.url = redactURL(observation.url);
      let html = clone.outerHTML;
      for (const value of secretValues) {
        observation.description = observation.description.replaceAll(value, "[redacted]");
        // Short values (a PIN, "1") would redact unrelated text.
        if (value.length >= 6) html = html.replaceAll(value, "[redacted]");
      }
      return {
        observation,
        html: html.slice(0, 2_000_000),
      };
    }
    if (command.type === "BIND") {
      if (applicationId && command.applicationId !== applicationId && !paused)
        throw new Error("This tab belongs to another active application.");
      if (
        command.applicationId === applicationId &&
        command.operation < operation
      )
        throw new Error("Stale operation.");
      applicationId = command.applicationId;
      // Dependent fields can appear after binding; their defaults follow the
      // same prefilled-value policy as the fields already visible.
      replaceSiteValues = Boolean(command.replaceSiteValues);
      clearPendingWrites();
      if (operation !== command.operation) {
        configController.abort();
        configController = new AbortController();
      }
      operation = command.operation;
      for (const key of command.locks || [])
        addLock(key, "an edit saved with this application earlier");
      inspect();
      // What was on the page before this extension wrote anything is the
      // site's (a saved profile, an earlier application, a parsed resume),
      // not an edit of the applicant's, which edit locks protect: the profile
      // may replace it.
      for (const record of records.values()) adoptSiteValue(record);
      for (const record of records.values())
        if (hasEditLock(record.element, record.label)) {
          record.protected = true;
          record.protectedBy = lockReason(record.element, record.label);
        }
      // Binding never silently resumes a human pause.
      return inspect();
    }
    if (
      command.type === "PAUSE" &&
      command.applicationId === applicationId &&
      command.operation >= operation
    ) {
      paused = true;
      configController.abort();
      return { paused };
    }
    if (
      command.type === "RESUME" &&
      command.applicationId === applicationId &&
      command.operation >= operation
    ) {
      operation = command.operation;
      paused = false;
      pausedBy = "";
      clearPendingWrites();
      configController.abort();
      configController = new AbortController();
      return inspect();
    }
    if (!valid(command)) throw new Error("Operation is paused or stale.");
    if (command.type === "AUTHORIZE_MAIN")
      return {
        authorized: authorizeMainWorld(
          { applicationId, documentId, operation },
          command.token || "",
        ),
      };
    if (command.type === "CONFIG_FILL" && configEngineEnabled) {
      if (!command.profile?.confirmed)
        throw new Error("A confirmed profile is required.");
      const pass = `${operation}:${command.profile.revision}:${command.fieldId || ""}:${(command.onlyKeys || []).join(",")}`;
      if (configPass === pass) return { statuses: configCautions, observation: inspect() };
      configPass = pass;
      configCautions = [];
      // A SuccessFactors application folds its sections (Profile Information,
      // Previous Employment, Education, Job-Specific Information) behind
      // their title bars, and nothing inside a folded one is on the page:
      // one employer's form was read as one Language field and nothing was filled
      //. Each is opened, as the applicant would
      // open it, before the pass reads the form.
      const folded = [...document.querySelectorAll<HTMLButtonElement>('.rcmFormSection button.rcmFormSectionTopBar[aria-expanded="false"]')];
      if (folded.length && !paused) {
        writing = true;
        try {
          for (const bar of folded) if (bar.isConnected && bar.getAttribute("aria-expanded") === "false") bar.click();
        } finally {
          writing = false;
        }
        for (let waited = 0; waited < 2_000 && document.querySelector('.rcmFormSection button.rcmFormSectionTopBar[aria-expanded="false"]'); waited += 100)
          await pause(100);
        await pause(300);
      }
      inspect();
      const signal = AbortSignal.any([
        configController.signal,
        // Long forms (iCIMS rows searched one dropdown at a time) need it.
        // Workday's My Experience searches its field of study and each
        // skill in turn, about 20 s for a search that finds nothing: at 60 s
        // the pass ended before Skills. SuccessFactors
        // waits out each of a place's wordings its list lacks, 5 s apiece:
        // with three jobs and two schools the pass ended a minute in, with
        // "Master" typed into Highest Degree Achieved and never picked.
        // (configPassTimeout: SmartRecruiters' real-key picks too.)
        AbortSignal.timeout(configPassTimeout(location.hostname)),
      ]);
      const locked = (element: Element) => {
        if (!valid(command)) return true;
        if (
          element.ownerDocument !== document ||
          !element.isConnected
        )
          return true;
        const candidates = controlsWithin(element);
        if (
          candidates.some((candidate) =>
            radioGroup(candidate).some(
              (member) => !nodeRecords.has(member as HTMLElement),
            ),
          )
        )
          trackLocalControls(candidates);
        if (!valid(command)) return true;
        const nodes = new Set(
          candidates.flatMap((candidate) => {
            const group = radioGroup(candidate);
            const writableMembers = group.filter(writable);
            return group.length > 1 && writableMembers.length
              ? [candidate, ...writableMembers]
              : group;
          }),
        );
        return [...nodes].some((node) => {
          const record = nodeRecords.get(node as HTMLElement);
          return (
            Boolean(
              record &&
              (record.protected || hasEditLock(record.element, record.label)),
            ) ||
            (node as HTMLInputElement).disabled ||
            // A read-only box with its own picker button is filled from that
            // picker, as Tesla's start date is: the site
            // writes it, never this.
            ((node as HTMLInputElement).readOnly && !pickerBox(node)) ||
            node.getAttribute("aria-disabled") === "true" ||
            node.getAttribute("aria-readonly") === "true"
          );
        });
      };
      const reconcileAutomation = (...elements: (Element | undefined)[]) => {
        const touched = new Set<RecordEntry>();
        for (const element of elements) {
          if (!element) continue;
          for (const control of controlsWithin(element))
            for (const member of radioGroup(control)) {
              const record = nodeRecords.get(member as HTMLElement);
              if (record) touched.add(record);
            }
        }
        for (const record of touched) {
          if (record.protected || !record.element.isConnected) continue;
          const value = valueOf(record.element);
          if (value !== record.last) {
            record.last = value;
            record.revision++;
            record.automationWritten = true;
          }
        }
      };
      // Widgets that keep their own state ignore assigned values and synthetic
      // keys alike; Workday's date sections are the reason this path exists.
      // CDP types into whatever the page has focused, so focus must be ours and
      // the page must not have the applicant's attention (see userAttention).
      const trustedType = (element: Element, text: string, safe: () => boolean, signal: AbortSignal, retry = true, enter = false, choose = false) =>
        typeTrusted(command, element, text, safe, signal, retry, enter, choose);
      // A signing date has one right answer: today. One the site or an earlier
      // fill left behind (a reloaded page keeps it) is retyped, Month first;
      // a date the applicant entered or locked is left alone.
      const now = new Date();
      const today = [
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        String(now.getFullYear()),
      ];
      for (const wrapper of document.querySelectorAll(
        '[data-automation-id="formField-todaysDate"],[data-automation-id="formField-dateSignedOn"],[data-automation-id="formField-currentDate"]',
      )) {
        const sections = ["Month", "Day", "Year"].map((name) =>
          wrapper.querySelector<HTMLInputElement>(`input[role="spinbutton"][aria-label="${name}"]`),
        );
        if (sections.some((section) => !section)) continue;
        const values = sections.map((section) => section!.value);
        if (values.every((value) => !value)) continue;
        if (values.every((value, i) => Number(value) === Number(today[i]))) continue;
        const records = sections.map((section) => nodeRecords.get(section!));
        if (
          records.some(
            (record) =>
              !record ||
              hasEditLock(record.element, record.label) ||
              (record.protected && record.protectedBy !== "existing value"),
          )
        )
          continue;
        for (const [i, section] of sections.entries()) {
          const record = records[i]!;
          record.protected = false;
          record.protectedBy = undefined;
          writing = true;
          try {
            await trustedType(section!, today[i], () => valid(command) && !locked(section!), signal);
          } finally {
            writing = false;
          }
          reconcileAutomation(section!);
        }
      }
      const result = await fillDocument(command.profile, {
        signal,
        onlyKeys: command.onlyKeys,
        // Without documents yet, an upload step would only open its dialog.
        skipKeys: command.uploads ? undefined : ["resume", "coverLetter"],
        onField: (element, key) => {
          // A rule may name a wrapper; the question is its one control's.
          const control = element.matches("input,textarea,select,button,[role]")
            ? element
            : element.querySelector('input:not([type="hidden"]),textarea,select,button[aria-haspopup="listbox"],[role="combobox"]');
          const label = control ? fieldLabel(control as Control) : "";
          tell({ type: "FILL_PROGRESS", applicationId, operation, documentId, label: label && label !== "Unlabelled field" ? label : key.replace(/_/g, " ") });
          stopRecording?.note({ config: key, label: label.slice(0, 80) });
        },
        isLocked: locked,
        note: (data) => stopRecording?.note(data),
        isReplaceable: (element) => {
          // A value that changed since the page was last read is read now:
          // the site may have answered the write just made (see above).
          const record = nodeRecords.get(element as HTMLElement);
          if (record && record.last !== valueOf(record.element)) inspect();
          // A value the site itself calls invalid is no answer to keep:
          // Microsoft's form showed an address assigned earlier that its own
          // state never took, flagged it, and it was never typed again.
          if (element.getAttribute("aria-invalid") === "true" && !hasEditLock(element as Control, record?.label || "")) return true;
          return Boolean(nodeRecords.get(element as HTMLElement)?.siteValue);
        },
        onConfirmed: (element) => {
          const record = nodeRecords.get(element as HTMLElement);
          if (record) record.confirmed = true;
        },
        // The site's own list of answers, read from this page's origin.
        listOptions: (source, terms) => fetchSiteOptions(source, location.href, terms, signal),
        async reactSelect(element, choose, searches) {
          const input = reactSelectInput(element);
          if (!input) return "unsupported";
          const safe = () =>
            valid(command) && !locked(input) && !locked(element);
          if (!safe()) return "skipped";
          // An existing selection is the user's or the site's; keep it,
          // unless the site parsed it from a resume.
          if (
            valueOf(input as Control) &&
            !nodeRecords.get(input as HTMLElement)?.siteValue
          )
            return "skipped";
          markEngineWrite(input, element);
          writing = true;
          try {
            return await reactSelect(input, choose, searches, safe, signal);
          } finally {
            writing = false;
            reconcileAutomation(input, element);
          }
        },
        async execute({ action, element, guardElement, method, values, entrySave }) {
          stopRecording?.note({ config: method, id: element.id || undefined, text: (element.textContent || "").trim().slice(0, 40) || undefined, values: values.slice(0, 3).map((value) => value.slice(0, 40)) });
          // A guard the step itself removed ("Remove Resume" before the
          // upload slot it reveals) guards nothing (see runAction).
          const guardGone = () =>
            Boolean(guardElement && guardElement !== element && !guardElement.isConnected && element.isConnected);
          // A click on the page around the field: see clicksAround.
          const around = clicksAround(element, guardElement, method, action?.event);
          const safe = () =>
            valid(command) &&
            (around ? element.isConnected : !locked(element)) &&
            (!guardElement || guardGone() || !locked(guardElement));
          if (!safe()) {
            // Why a write was refused, for the recording: a refusal otherwise
            // leaves only the write note, as a school's "Did You Graduate?" did on
            // an iCIMS form.
            const record = nodeRecords.get(element as HTMLElement);
            stopRecording?.note({ refused: element.id || method, reason: !valid(command) ? "stale command" : record?.protected ? `protected: ${record.protectedBy || ""}` : record && hasEditLock(record.element, record.label) ? lockReason(record.element, record.label) : "locked" });
            return false;
          }
          expectOwnedActivation(element, method, action?.event);
          markEngineWrite(element, guardElement);
          const savesBefore = savesFinished;
          writing = true;
          try {
            // A month picked from its calendar, in this page's own DOM.
            if (method === "pickMonth") {
              const picked = element instanceof HTMLInputElement && (await pickMonth(element, values[0] ?? ""));
              reconcileAutomation(element, guardElement);
              return picked;
            }
            if (method === "trustedType" || method === "trustedSearch" || method === "trustedChoose") {
              const typed = await trustedType(
                element,
                values[0] ?? "",
                safe,
                signal,
                true,
                method === "trustedSearch",
                method === "trustedChoose",
              );
              // The entry the menu lists for it: the site's own one where it
              // has it (SmartRecruiters' "Michigan State University" under its
              // "fill manually" one), else Down and Enter on the first, the
              // text as typed.
              if (typed && method === "trustedChoose") {
                // The site's own entry where it lists one, else the first
                // (the text as typed): Down to it, then Enter.
                const position = await listedPosition(element, values, signal);
                if (safe() && !userAttention()) {
                  // Down moves focus into the menu, so the Enter lands on its
                  // entry, not the box: the whole component is the write's,
                  // or that Enter was held back as a stray key and nothing
                  // was chosen (SmartRecruiters' Office location).
                  let component: Element = element;
                  for (let host = (element.getRootNode() as ShadowRoot).host as Element | undefined, depth = 0; host && depth < 4; host = (host.getRootNode() as ShadowRoot).host as Element | undefined, depth++) {
                    component = host;
                    if (host.matches("spl-autocomplete,[role='combobox']")) break;
                  }
                  trustedWrite = component;
                  try {
                    // One Down at a time until focus is on the wanted entry,
                    // then Enter there. A Down the menu let pass left focus in
                    // the box, and the Enter after it cleared what was typed:
                    // every Title, Company and School of a fill went empty
                    //. No Enter reaches the box.
                    const allowed = () => safe() && !userAttention();
                    const guard = { applicationId, operation, documentId };
                    const target = (position || 1) - 1;
                    // The entry a key reached: focused, or lit by the menu
                    // (its "active" mark; focus inside nested shadow roots
                    // did not read as the entry's on the site). Only after a
                    // key: the entry lit as the menu opens has no focus, and
                    // an Enter then lands in the box.
                    const reached = () => menuEntries(element).findIndex((entry) =>
                      (entry.getRootNode() as Document | ShadowRoot).activeElement === entry || entry.classList.contains("active") ||
                      entry.matches(":focus-within"));
                    let moved = false;
                    for (let tries = 0; tries < target + 4 && !(moved && reached() === target) && allowed(); tries++) {
                      // A menu that let one Down pass lets them all: the click
                      // below, at once, rather than seconds of keys.
                      if (moved && reached() < 0) break;
                      await requestTrustedType(element, guard, "", 0, signal, allowed, false, moved && reached() > target ? -1 : 1, true);
                      moved = true;
                      await pause(150);
                    }
                    if (moved && reached() === target && allowed())
                      await requestTrustedType(element, guard, "", 0, signal, allowed, true, 0);
                    // Every Down let pass (one employer's Company):
                    // a real click on the entry, as the applicant would.
                    else if (allowed() && window === window.top) {
                      const entry = menuEntries(element)[target];
                      if (entry) {
                        entry.scrollIntoView({ block: "nearest" });
                        await pause(100);
                        const box = entry.getBoundingClientRect();
                        if (box.width > 0 && box.height > 0)
                          await requestTrustedType(element, guard, "", 0, signal, allowed, false, 0, false,
                            { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
                      }
                    }
                  } catch {
                    /* Left as typed: the check after says so. */
                  } finally {
                    trustedWrite = undefined;
                  }
                  searchSettle = { element, until: performance.now() + 4000 };
                }
                reconcileAutomation(element, guardElement);
                return true;
              }
              reconcileAutomation(element, guardElement);
              if (typed) return true;
              // Real keystrokes were refused (this tab has the user's
              // attention, or the debugger is unavailable). Assigning the
              // value is what the engine did before; some widgets accept it.
            }
            // Saving one entry of the section being filled (see entrySave in
            // the interpreter). Its button can be a submit button of the whole
            // application form, so it is clicked only with every submission
            // stopped before any page code sees it: the page's click handler
            // saves the entry, and no form is submitted.
            if (entrySave && element instanceof HTMLButtonElement && ["click", "reactClick"].includes(method)) {
              const block = (event: Event) => {
                event.preventDefault();
                event.stopImmediatePropagation();
              };
              window.addEventListener("submit", block, true);
              try {
                expectOwnedActivation(element, "click");
                element.click();
              } finally {
                window.removeEventListener("submit", block, true);
              }
              await awaitSiteSave(savesBefore);
              return true;
            }
            // A configured option box is clicked, never assigned: see
            // checkControl.
            if (
              ["checkOption", "default", "defaultWithoutBlur"].includes(method) &&
              element instanceof HTMLInputElement &&
              ["checkbox", "radio"].includes(element.type)
            ) {
              // As the page-world writer reads a value for a box (Oracle's
              // "Current Job" gets "Yes").
              const wanted =
                method === "checkOption" ||
                element.type === "radio" ||
                !["", "false", "no", "0"].includes((values[0] ?? "").toLowerCase());
              const checked = (await checkControl(element, wanted)) && element.checked === wanted;
              reconcileAutomation(element, guardElement);
              await awaitSiteSave(savesBefore);
              return checked;
            }
            // An upload step gets the document this pass was given, or fails.
            const file =
              method === "uploadResume"
                ? command.uploads?.resume
                : method === "uploadCoverLetter"
                  ? command.uploads?.cover
                  : method === "uploadFile"
                    ? command.artifact
                    : undefined;
            if (/^upload(Resume|CoverLetter|File)$/.test(method) && !file) return false;
            const result = await requestMainWorld(
              element,
              { applicationId, operation, documentId },
              {
                ...(file ? { file } : {}),
                method: method === "trustedType" ? "default" : method === "trustedSearch" || method === "trustedChoose" ? "keyType" : method,
                values,
                event: action?.event,
                eventOptions: action?.eventOptions,
              },
              signal,
              safe,
            );
            // Without real keys a search box still gets its Enter, synthetic:
            // most Workday tenants search on it.
            // Without real keys, its menu's first entry chosen with synthetic
            // Down and Enter once the menu has had time to come.
            if (method === "trustedChoose" && result.ok) {
              await pause(1_500);
              for (const key of [{ key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40 }, { key: "Enter", code: "Enter", keyCode: 13, which: 13 }])
                await requestMainWorld(element, { applicationId, operation, documentId }, { method: "event", values, event: "keydown", eventOptions: key }, signal, safe);
            }
            if (method === "trustedSearch" && result.ok)
              await requestMainWorld(
                element,
                { applicationId, operation, documentId },
                {
                  method: "event",
                  values,
                  event: "keydown",
                  eventOptions: { key: "Enter", code: "Enter", keyCode: 13, which: 13 },
                },
                signal,
                safe,
              );
            reconcileAutomation(element, guardElement);
            // Written with the profile's answer, even one equal to what the
            // site parsed (no change to see): checked, not the site's guess
            // (one employer's "Did You Graduate?").
            const written = nodeRecords.get(element as HTMLElement);
            if (written && result.ok) written.confirmed = true;
            await awaitSiteSave(savesBefore);
            return result.ok;
          } finally {
            writing = false;
            lastEngineWrite = performance.now();
          }
        },
      }, command.fieldId ? records.get(command.fieldId)?.element : undefined).then((result) => {
        configCautions = (result.statuses as { key: string; status: string; caution?: string }[]).flatMap((status) =>
          status.status === "filled" && status.caution ? [{ key: status.key, status: "filled" as const, caution: status.caution }] : []);
        return result;
      }).catch((error) => {
        if (!valid(command)) throw error;
        return {
          statuses: [
            {
              key: "config",
              status: "failed",
              reason: (error as Error).message,
            },
          ],
        };
      });
      return { ...result, observation: inspect() };
    }
    // Reads, without choosing anything, the options of dropdowns that only
    // list them once opened (react-select). A reviewed AI suggestion has to
    // name one of a field's real options, and nothing can be suggested for a
    // list nobody has read.
    if (command.type === "OPTIONS") {
      // A read is allowed during a human pause; a stale page or operation is not.
      const current = () => !composing && command.applicationId === applicationId && command.operation === operation && command.documentId === documentId;
      if (!current()) throw new Error("Stale operation.");
      const read: { id: string; options: string[] }[] = [];
      const guard = { applicationId, operation, documentId };
      // Workday's questions, all answered by the questionnaire the page loaded
      // (see workday-questionnaire.ts): read there, nothing is opened.
      let questionnaire: QuestionnaireAnswers | undefined;
      const questionnaires = async () =>
        (questionnaire ??= await loadQuestionnaires(
          questionnaireUrls(performance.getEntriesByType("resource").map((entry) => entry.name), location.origin),
        ).catch(() => new Map() as QuestionnaireAnswers));
      for (const id of (command.fieldIds || []).slice(0, 40)) {
        const record = records.get(id);
        // A Workday list button: its question's answers from the
        // questionnaire, else opened, read and closed with nothing chosen
        // (one employer's Phone Device Type, "Home" and "Home Cellular", was
        // answered blind and missed).
        if (record && listButton(record.element) && !record.protected && record.element.isConnected &&
            record.element.getAttribute("aria-expanded") !== "true" && document.activeElement !== record.element) {
          const button = record.element as HTMLButtonElement;
          const listed = button.name ? (await questionnaires()).get(button.name) : undefined;
          if (listed?.length) {
            read.push({ id, options: listed });
            continue;
          }
          writing = true;
          try {
            button.click();
            let options: string[] = [];
            let steady = 0;
            for (let attempt = 0; attempt < 40 && steady < 2 && current(); attempt++) {
              await pause(50);
              const listId = (button.getAttribute("aria-controls") || "").split(/\s+/)[0];
              const list = listId ? document.getElementById(listId) : null;
              const shown = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') || [])]
                .filter((option) => option.getAttribute("aria-disabled") !== "true")
                .map((option) => (option.textContent || "").replace(/\s+/g, " ").trim())
                .filter((option) => option && !/^select one$/i.test(option));
              // Workday fills the list a moment after it opens.
              steady = shown.length && shown.length === options.length ? steady + 1 : 0;
              options = shown;
            }
            if (button.getAttribute("aria-expanded") === "true") {
              button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
              await pause(100);
            }
            if (button.getAttribute("aria-expanded") === "true") {
              (document.querySelector<HTMLElement>('[data-automation-id="mainContent"]') || document.body).click();
              await pause(100);
            }
            if (document.activeElement === button) button.blur();
            if (options.length) read.push({ id, options: options.slice(0, 300) });
          } finally {
            writing = false;
          }
          continue;
        }
        // A SmartRecruiters list draws its options only once first opened:
        // Gender, Race and Veteran were never open before their answers were
        // planned, read as none, and Veteran went unanswered. Opened, read and closed with nothing chosen;
        // quick, so also before a fill's plan.
        const splHost = (element: Element) => {
          for (let host = (element.getRootNode() as ShadowRoot).host as Element | undefined, depth = 0; host && depth < 4; host = (host.getRootNode() as ShadowRoot).host as Element | undefined, depth++)
            if (host.matches("spl-autocomplete,spl-multiselect-autocomplete")) return host;
          return undefined;
        };
        if (record && record.element instanceof HTMLInputElement && record.element.getAttribute("role") === "combobox" &&
            splHost(record.element) && controlledList(record.element) && !record.protected && record.element.isConnected &&
            !valueOf(record.element) && record.element.getAttribute("aria-expanded") !== "true") {
          const input = record.element;
          let options = drawnOptions(input);
          if (!options.length) {
            writing = true;
            try {
              input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true, button: 0, view: window }));
              input.click();
              for (let waited = 0; waited < 1500 && !options.length && current(); waited += 100) {
                await pause(100);
                options = drawnOptions(input);
              }
              if (input.getAttribute("aria-expanded") === "true") pressOutside();
              input.blur();
              await pause(150);
            } finally {
              writing = false;
            }
          }
          if (options.length) read.push({ id, options: options.slice(0, 300) });
          continue;
        }
        // Microsoft's careers form draws a list's options only once opened:
        // its sponsorship question, read with none, went unanswered
        //. Opened (a click on the box, else its arrow), read,
        // and closed with nothing chosen; quick, so also before a plan.
        if (record && record.element instanceof HTMLInputElement && record.element.matches('input[role="combobox"][class*="select-module_select-input"]') &&
            !record.protected && record.element.isConnected && !valueOf(record.element) && !picksOf(record.element) &&
            record.element.getAttribute("aria-expanded") !== "true" && document.activeElement !== record.element) {
          const input = record.element;
          const listed = () => {
            const list = controlledList(input);
            return [...(list?.querySelectorAll<HTMLElement>('[role="option"]') || [])]
              .filter((option) => option.getAttribute("aria-disabled") !== "true")
              .map((option) => (option.getAttribute("title") || option.textContent || "").replace(/\s+/g, " ").trim())
              .filter(Boolean);
          };
          let options = listed();
          if (!options.length) {
            writing = true;
            try {
              input.click();
              for (let waited = 0; waited < 300 && input.getAttribute("aria-expanded") !== "true"; waited += 50) await pause(50);
              if (input.getAttribute("aria-expanded") !== "true")
                input.parentElement?.querySelector<HTMLButtonElement>('button[aria-hidden="true"][tabindex="-1"]')?.click();
              for (let waited = 0; waited < 1500 && !options.length && current(); waited += 100) {
                await pause(100);
                options = listed();
              }
              if (input.getAttribute("aria-expanded") === "true") {
                input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
                await pause(100);
              }
              if (input.getAttribute("aria-expanded") === "true") pressOutside();
              // The site hands focus back to the box as its list closes, and a
              // focused field is the applicant's: the answer was then skipped
              // as "The field currently has focus".
              for (let waited = 0; waited < 600; waited += 50) {
                if (document.activeElement === input || input.matches(":focus")) input.blur();
                await pause(50);
              }
            } finally {
              writing = false;
            }
          }
          if (options.length) read.push({ id, options: options.slice(0, 300) });
          continue;
        }
        if (command.listButtonsOnly) continue;
        const arrow = record && ashbyToggle(record.element);
        if (record && arrow && !record.protected && record.element.isConnected && !valueOf(record.element) &&
            document.activeElement !== record.element && record.element.getAttribute("aria-expanded") !== "true") {
          // Opened and closed again from its own arrow; nothing is chosen.
          const input = record.element as HTMLInputElement;
          writing = true;
          try {
            arrow.click();
            let options: string[] = [];
            for (let attempt = 0; attempt < 20 && !options.length && current(); attempt++) {
              await pause(50);
              const listId = input.getAttribute("aria-controls");
              const list = listId && !/\s/.test(listId) ? (input.getRootNode() as Document | ShadowRoot).querySelector(`#${CSS.escape(listId)}`) : null;
              options = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') || [])]
                .map((option) => (option.textContent || "").trim()).filter(Boolean).slice(0, 100);
            }
            if (input.getAttribute("aria-expanded") === "true" && !input.value) arrow.click();
            // The arrow hands focus to the input, sometimes a moment later.
            for (let waited = 0; waited < 600; waited += 50) {
              await pause(50);
              if (document.activeElement === input && !input.value) input.blur();
            }
            if (options.length) read.push({ id, options });
          } finally {
            writing = false;
          }
          continue;
        }
        // A SuccessFactors list draws its options only once opened, a page at
        // a time as it is scrolled; the AI pass saw Status and Education Type
        // with none. Opened, scrolled while it
        // grows, read, and closed with nothing chosen.
        if (record && record.element instanceof HTMLInputElement && record.element.classList.contains("rcmpaginatedselectinput") &&
            !record.protected && record.element.isConnected && !valueOf(record.element) && document.activeElement !== record.element) {
          const input = record.element;
          writing = true;
          try {
            input.click();
            let options: string[] = [];
            let steady = 0;
            for (let attempt = 0; attempt < 60 && steady < 3 && options.length < 300 && current(); attempt++) {
              await pause(200);
              const listId = (input.getAttribute("aria-owns") || input.getAttribute("aria-controls") || "").split(/\s+/)[0];
              const list = listId ? document.getElementById(listId) : document.querySelector("ul.sf-list-select");
              const shown = [...new Set([...(list?.querySelectorAll<HTMLElement>('li[role="option"]') || [])]
                .map((option) => (option.textContent || "").replace(/\s+/g, " ").trim())
                .filter((option) => option && !/^no selection$/i.test(option)))];
              steady = shown.length && shown.length === options.length ? steady + 1 : 0;
              options = shown;
              list?.querySelector(":scope > li:last-child")?.scrollIntoView({ block: "end" });
              for (let box: Element | null = list, up = 0; box && up < 5; box = box.parentElement, up++) {
                if (box.scrollHeight > box.clientHeight + 4) box.scrollTop = box.scrollHeight;
                box.dispatchEvent(new Event("scroll"));
              }
            }
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            pressOutside();
            await pause(150);
            if (document.activeElement === input) input.blur();
            if (options.length) read.push({ id, options: options.slice(0, 300) });
          } finally {
            writing = false;
          }
          continue;
        }
        if (record && ripplingSelect(record.element) && !record.protected && record.element.isConnected && !valueOf(record.element) &&
            document.activeElement !== record.element && record.element.getAttribute("aria-expanded") !== "true") {
          const control = record.element;
          writing = true;
          try {
            control.click();
            let options: string[] = [];
            for (let attempt = 0; attempt < 20 && !options.length && current(); attempt++) {
              await pause(50);
              const listId = control.getAttribute("aria-controls");
              const list = listId && !/\s/.test(listId) ? (control.getRootNode() as Document | ShadowRoot).querySelector(`#${CSS.escape(listId)}`) : null;
              if (list?.getAttribute("aria-busy") === "true") continue;
              options = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') || [])]
                .filter((option) => option.getAttribute("aria-disabled") !== "true")
                .map((option) => (option.textContent || "").trim()).filter(Boolean).slice(0, 100);
            }
            if (control.getAttribute("aria-expanded") === "true") pressOutside();
            // Closed and unfocused before the next list is opened.
            await pause(120);
            if (document.activeElement === control) (control as HTMLElement).blur();
            if (options.length) read.push({ id, options });
          } finally {
            writing = false;
          }
          continue;
        }
        const element = record && reactSelectInput(record.element);
        if (!record || !element || record.protected || !record.element.isConnected || valueOf(record.element)) continue;
        const safe = () => current() && element.isConnected && !record.protected && document.activeElement !== element;
        const call = (method: string) => requestMainWorld(element, guard, { method, values: [] }, undefined, safe);
        writing = true;
        try {
          const listed = await call("reactSelectOptions");
          // Choosing nothing closes the menu and clears any search state.
          await call("reactSelectChoose").catch(() => undefined);
          if (listed.ok) {
            const options = (JSON.parse(listed.value || "[]") as string[]).filter((option) => typeof option === "string" && option.trim()).slice(0, 100);
            if (options.length) read.push({ id, options });
          }
        } catch {
          /* Unreadable lists stay without options. */
        } finally {
          writing = false;
        }
      }
      return read;
    }
    if (command.type === "APPLY") return apply(command);
    if (command.type === "ATTACH") {
      // A document the site held before this extension (Amazon's stored
      // resume), when the applicant asked for it to be replaced. One they
      // chose themselves stays theirs.
      const held = records.get(command.fieldId!);
      if (command.replaceExisting && held?.protected && held.protectedBy === "existing value") {
        held.protected = false;
        held.protectedBy = undefined;
        held.siteValue = true;
      }
      // Focus an upload of ours left on a configured slot is no applicant's:
      // the résumé's upload in Workday's shared uploader ends on its "Select
      // files" button, which is the cover letter's slot, and the cover letter
      // was refused as a field in use.
      const slot = records.get(command.fieldId!);
      if (slot && fileControls.has(slot.element) && document.activeElement === slot.element &&
          performance.now() - lastApplicantInput > 2000)
        (slot.element as HTMLElement).blur();
      const guarded = guardedRecord(command, {
        fieldId: command.fieldId!,
        revision: command.revision!,
        expectedValue: command.expectedValue!,
      });
      const record = guarded.record;
      if (record?.element instanceof HTMLInputElement && replacesForm(record.element)) siteFillUntil = performance.now() + 60_000;
      const artifact = command.artifact;
      const configured = record && fileControls.get(record.element);
      if (record && configured && artifact && artifact.applicationId === applicationId && artifact.operation === operation) {
        const result = await executeCommand({
          ...command,
          type: "CONFIG_FILL",
          uploads: { [artifact.kind]: artifact },
        }) as { statuses?: { status: string }[] };
        const attached = result.statuses?.some((status) => status.status === "filled") && valueOf(record.element) === artifact.name;
        if (attached) record.attachmentId = artifact.id;
        return { attached: Boolean(attached), observation: inspect() };
      }
      if (
        !record ||
        !(record.element instanceof HTMLInputElement) ||
        record.element.type !== "file" ||
        !artifact ||
        artifact.applicationId !== applicationId ||
        artifact.operation !== operation
      )
        throw new Error(`Stale or mismatched document attachment${guarded.reason ? ` (${guarded.reason})` : ""}.`);
      // Paylocity exposes a separate "Apply with resume" shortcut and a
      // parsing checkbox beside the ordinary uploader. Use the ordinary
      // upload without letting the parser discard fields already filled.
      if (record.element.id === "btn-resume" && /(^|\.)paylocity\.com$/i.test(location.hostname)) {
        const parser = document.getElementById("useAttachedResumeToFillOutApplication");
        if (parser instanceof HTMLInputElement && parser.checked) {
          const parserRecord = nodeRecords.get(parser);
          if (!valid(command) || hasEditLock(parser, fieldLabel(parser)) || (parserRecord?.protected && parserRecord.protectedBy !== "existing value"))
            throw new Error("Resume parsing is locked. Upload the resume manually.");
          markEngineWrite(parser);
          writing = true;
          try { await checkControl(parser, false); } finally { writing = false; }
          if (parser.checked || !valid(command)) throw new Error("Turn off resume parsing before uploading manually.");
          if (parserRecord) {
            parserRecord.last = valueOf(parser);
            parserRecord.revision++;
            parserRecord.automationWritten = true;
            parserRecord.protected = false;
            parserRecord.protectedBy = undefined;
          }
        }
      }
      const raw = atob(artifact.data);
      const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      const file = new File([bytes], artifact.name, { type: artifact.mime });
      const accept = record.element.accept.toLowerCase();
      if (
        accept &&
        !accept
          .split(",")
          .some(
            (a) =>
              a.trim() === `.${artifact.format}` ||
              a.trim() === artifact.mime ||
              a.trim() === "*/*" ||
              a.trim() === "application/*",
          )
      )
        throw new Error("Site does not accept this document format.");
      if (
        !guard(command, {
          fieldId: command.fieldId!,
          revision: command.revision!,
          expectedValue: command.expectedValue!,
        })
      )
        throw new Error("Attachment was superseded.");
      const errorBefore = uploadError(record.element);
      // Where the site shows an accepted file: some (Greenhouse's job boards)
      // empty or replace the input and show the file's name beside it.
      const uploadGroup = record.element.closest(
        '[role="group"], .file-upload, .field-wrapper, .application-question, fieldset, .field',
      );
      const transfer = new DataTransfer();
      transfer.items.add(file);
      writing = true;
      try {
        record.writePendingAt = performance.now();
        if (configEngineEnabled) {
          const result = await requestMainWorld(
            record.element,
            { applicationId, operation, documentId },
            {
              method:
                artifact.kind === "resume"
                  ? "uploadResume"
                  : "uploadCoverLetter",
              values: [],
              file: artifact,
            },
            configController.signal,
            () =>
              Boolean(
                guard(command, {
                  fieldId: command.fieldId!,
                  revision: command.revision!,
                  expectedValue: command.expectedValue!,
                }),
              ),
          );
          if (!result.ok)
            throw new Error(result.reason || "Attachment failed.");
          record.last = valueOf(record.element);
          record.revision++;
          record.automationWritten = true;
        } else {
          record.element.files = transfer.files;
          changed(record);
        }
        record.attachmentId = artifact.id;
      } finally {
        writing = false;
      }
      // Some sites fail the upload in their own handler and say so beside the
      // field; the file input alone would still look attached.
      let siteError = "";
      for (let waited = 0; waited < 2000 && !siteError; waited += 250) {
        await pause(250);
        const shown = uploadError(record.element);
        if (shown !== errorBefore) siteError = shown;
      }
      const shownName = Boolean(uploadGroup?.isConnected && uploadGroup.textContent?.includes(artifact.name));
      return {
        attached: (record.element.files?.[0]?.name === artifact.name || shownName) && !siteError,
        siteError,
        observation: inspect(),
      };
    }
    if (command.type === "ADVANCE") {
      const snapshot = inspect();
      if (
        snapshot.blockers.length ||
        snapshot.fields.some(
          (f) => (f.required && !f.value) || f.invalid || f.validationWarning,
        ) ||
        !valid(command)
      )
        throw new Error("This step needs review.");
      const next = nextButton();
      if (!next) throw new Error("No verified non-submitting Next button.");
      next.click();
      return { advanced: true };
    }
    throw new Error("Unknown content operation.");
  }
  chrome.runtime.onMessage.addListener((message: Command, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    void executeCommand(message).then(
      (data) => respond({ ok: true, data }),
      (error) => respond({ ok: false, error: error.message }),
    );
    return true;
  });
  // A SuccessFactors list that arrives long after its click, its fill having
  // given up on it, opens over the form, and a slow site left a stack of them
  // open. A list is closed when it
  // opens unasked: not within 20 seconds of a click this extension made on
  // its dropdown (a fill may still be waiting for it), nor within a minute
  // of the applicant's own.
  const picklistClicks = new WeakMap<Element, { lane: number; applicant: number }>();
  const notePicklistUse = (event: Event) => {
    const input = (event.target as Element | null)?.closest?.(".sfCascadingPicklist, .fieldComponentInput")
      ?.querySelector('input.rcmpaginatedselectinput[role="combobox"]');
    if (!input) return;
    // The applicant also opens one from the keyboard; a script's keys are
    // not a request to open it.
    if (event.type === "keydown" && !event.isTrusted) return;
    const seen = picklistClicks.get(input) || { lane: 0, applicant: 0 };
    seen[event.isTrusted ? "applicant" : "lane"] = Date.now();
    if (event.isTrusted) lastApplicantPicklistUse = Date.now();
    else lastLanePicklistClick = Date.now();
    picklistClicks.set(input, seen);
  };
  document.addEventListener("click", notePicklistUse, true);
  document.addEventListener("keydown", notePicklistUse, true);
  const closeUnaskedLists = (): void => {
    if (!applicationId) return;
    for (const list of document.querySelectorAll<HTMLElement>('ul.sf-list-select[role="listbox"][id]')) {
      if (!rendered(list)) continue;
      const owner = document.querySelector(`[aria-owns="${CSS.escape(list.id)}"]`);
      if (!owner || !successFactorsPicklist(owner)) continue;
      const seen = picklistClicks.get(owner) || { lane: 0, applicant: 0 };
      // Nor while the applicant is choosing in one of their own.
      if (Date.now() - seen.applicant < 60_000 || Date.now() - lastApplicantPicklistUse < 60_000) continue;
      // One still open when the fill's wait for it is over is looked at
      // again. The press that closes it closes every list on the page, so
      // nor while the fill may be waiting for another's.
      const since = Date.now() - Math.max(seen.lane, lastLanePicklistClick);
      if (since < 20_000) {
        void pause(20_000 - since + 100).then(closeUnaskedLists);
        return;
      }
      closeSuccessFactorsList(owner);
    }
  };
  // Checked a moment after a list is drawn, on this script's own clock (a
  // hidden page's timers are slowed).
  let unaskedCheck = false;
  new MutationObserver((mutations) => {
    if (unaskedCheck || !mutations.some((mutation) => [...mutation.addedNodes].some((node) =>
      node instanceof Element && (node.matches("ul.sf-list-select") || node.querySelector("ul.sf-list-select")))))
      return;
    unaskedCheck = true;
    void pause(100).then(() => {
      unaskedCheck = false;
      closeUnaskedLists();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.__applicationLane = { inspect, version: CONTENT_VERSION };
  setEngineWait(pause);
  setMonthPickerWait(pause);
  // The site's own confirmation that the application went in (its page after
  // Submit, or a banner drawn in place): said once, so the applicant does not
  // have to mark it submitted. Nothing here presses Submit.
  let toldSubmitted = false;
  let toldByWords = false;
  let submittedTimer: ReturnType<typeof setTimeout> | undefined;
  const checkSubmitted = () => {
    // In any frame: an employer's careers page shows the Greenhouse form,
    // and its "thank you", in a frame of its own (an employer, Roblox). The site rules for the frame's own address decide.
    if (toldSubmitted) return;
    if (submittedOnPage()) {
      toldSubmitted = true;
      tell({ type: "SUBMITTED_PAGE", generic: false });
      return;
    }
    // A message read from the page's words, not a site rule: the
    // background takes it only from a frame it filled, so it may be
    // dropped, and a site rule matching later is still told.
    if (toldByWords || !confirmationInPlace()) return;
    toldByWords = true;
    tell({ type: "SUBMITTED_PAGE", generic: true });
  };
  checkSubmitted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver(() => {
    if (!toldSubmitted) {
      clearTimeout(submittedTimer);
      submittedTimer = setTimeout(checkSubmitted, 400);
    }
    if (writing || autoDocumentMutation || !applicationId) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      autoDocumentMutation = true;
      try {
        const observation = inspect();
        const fingerprint = JSON.stringify(
          observation.fields.map((f) => [f.id, f.value, f.protected]),
        );
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          tell({ type: "FORM_CHANGED", applicationId, operation, documentId });
        }
      } finally {
        autoDocumentMutation = false;
      }
    }, 200);
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-expanded", "disabled", "required", "value"],
  });
}
