import {
  interpretConfig,
  searchListDropdown,
  matchesSiteConfig,
  paths,
  queryXPathAll,
  type InterpreterOptions,
} from "./config/interpreter";
import { configs, globals } from "./config/catalog";
import type { Profile } from "../shared/model";
import { labelText } from "../extension/semantics";

function siteConfig() {
  const matching = configs.filter((config) =>
    matchesSiteConfig(config, location.href, document),
  );
  // Prefer a host-specific configuration over a generic embedded ATS probe.
  const direct = (urls: string[]) =>
    urls.some((pattern) =>
      new RegExp(
        `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*")}$`,
        "i",
      ).test(location.href),
    );
  matching.sort((a, b) => Number(direct(b.urls)) - Number(direct(a.urls)));
  return matching[0];
}

export async function fillDocument(
  profile: Profile,
  options: InterpreterOptions,
  fileControl?: HTMLElement,
) {
  const config = siteConfig();
  if (!config) return { statuses: [], ats: undefined };
  const file = fileControl && configuredFileControls().find((field) => field.element === fileControl);
  if (fileControl && !file)
    throw new Error("Configured file control is no longer available.");
  const scopedConfig = file ? {
    ...config,
    inputSelectors: [["file", [{ path: ".", valueRequired: false, actions: file.actions }]]] as typeof config.inputSelectors,
  } : config;
  return {
    ats: config.ats,
    statuses: await interpretConfig(
      document,
      location.href,
      scopedConfig,
      globals,
      profile,
      file ? { ...options, context: file.element } : options,
    ),
  };
}

// Whether the page has an empty resume slot its site rewrites the form from
// (the rule's resumeFirstPaths): the resume then goes first and alone.
export function resumeSlotOpen(): boolean {
  const config = siteConfig();
  return paths(config?.resumeFirstPaths).some((path) => queryXPathAll(document, path).length > 0);
}

// Some sites expose a document slot before creating its native file input.
// Track the slot itself so missing documents and manual uploads stay visible.
export function configuredFileControls() {
  const config = siteConfig();
  return (config?.trackedInputSelectors || [])
    .filter((selector) => selector.kind === "file")
    .flatMap((selector) =>
      paths(selector.fieldPath).flatMap((path) => queryXPathAll(document, path)).map((element) => {
        const nodes = (path: string | string[] | undefined) =>
          paths(path).flatMap((p) => queryXPathAll(document, p, element));
        return {
          element: element as HTMLElement,
          label: selector.label || nodes(selector.labelPath).map(labelText).join(" "),
          // A native file input names its own file (JazzHR's resume, kept
          // behind an "Attach resume" link).
          value: selector.inputTextPath
            ? nodes(selector.inputTextPath).map((node) => node.textContent?.trim() || "").join(" ")
            : element instanceof HTMLInputElement && element.type === "file" ? element.files?.[0]?.name || "" : "",
          required: nodes(selector.requiredPath).length > 0,
          actions: selector.fillActions || [],
        };
      }),
    );
}

// Custom radios can keep the question outside the group and each option's
// label in its shadow root (ADP). Use the site's tracked selectors for both.
export function configuredRadioControls() {
  const config = siteConfig();
  return (config?.trackedInputSelectors || [])
    .filter((selector) => selector.optionsPath)
    .flatMap((selector) =>
      paths(selector.fieldPath).flatMap((path) => queryXPathAll(document, path)).flatMap((field) => {
        const nodes = (path: string | string[] | undefined, context = field) =>
          paths(path).flatMap((p) => queryXPathAll(document, p, context));
        const label = nodes(selector.labelPath).map(labelText).join(" ");
        const required = selector.requiredPath ? nodes(selector.requiredPath).length > 0 : undefined;
        return nodes(selector.optionsPath)
          .filter((element) => element.getAttribute("role") === "radio")
          .map((element) => ({
            element: element as HTMLElement,
            label,
            required,
            option: nodes(selector.optionsTextPath, element).map(labelText).join(" "),
          }));
      }),
    );
}

// Whether this page is the site's own "application submitted" page or shows
// its confirmation, as the site's rules describe it. Only something drawn
// counts: a hidden template of the message is not the message.
export function submittedOnPage(): boolean {
  const config = siteConfig();
  return (config?.submittedSuccessPaths || []).some((path) => {
    try {
      return queryXPathAll(document, path).some((element) => (element as HTMLElement).getClientRects?.().length > 0);
    } catch {
      return false;
    }
  });
}

// A site's own confirmation that no rule knows (an employer:
// "Your application has been submitted successfully." where its form was):
// a short message saying the application went in, on a page that no longer
// holds a form to fill. A form page that mentions applying keeps its boxes,
// so it never reads as this. Only a frame the extension filled may say it
// (background.ts): an employer's page around a framed form has no boxes of
// its own, and its job text may thank applicants.
// TikTok's: "Thanks for your interest in TikTok. We have received your
// resume." on /resume/applied.
const confirmationWording =
  /\b(your )?application (has been|was|is|has) (successfully |now )?(submitted|received|sent|been received)\b|\b(your )?application is in(?=\s*(?:[.!]|$))|\bthank you for (applying|your application|submitting)\b|\bapplication (submitted|received)\b|\byou(?: have|'ve) successfully applied\b|\bwe(?: have|'ve) received your (resume|application|submission)\b/i;
export function confirmationInPlace(): boolean {
  const shown = (element: Element) =>
    (element as HTMLElement).getClientRects?.().length > 0 && !element.closest("[hidden],[aria-hidden='true']");
  const boxes = [
    ...document.querySelectorAll(
      'input:not([type="hidden"]):not([type="search"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]),textarea,select',
    ),
  ].filter(shown);
  if (boxes.length > 1) return false;
  const says = (text: string) => text.length > 0 && text.length <= 200 && confirmationWording.test(text);
  if ([...document.querySelectorAll("h1,h2,h3,h4,h5,p,[role='status'],[role='alert']")].some((element) =>
    says((element.textContent || "").replace(/\s+/g, " ").trim()) && shown(element)))
    return true;
  // A message box drawn as a plain div or span (iCIMS' green "Your
  // application was submitted successfully. Thank you for applying.",
  // General Dynamics): read by its own text, so a block
  // holding a whole posting is never read as one message.
  return [...document.querySelectorAll("div,span")].some((element) => {
    const own = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent || "").join(" ");
    return says(own.replace(/\s+/g, " ").trim()) && shown(element);
  });
}

// Repeated sections (education, experience…) the site's config can add rows
// to from Add buttons shown now. A step can hold nothing but those buttons
// (Oracle's "Add Education"), and it is still a step the profile fills.
export function addableCollections(): string[] {
  const config = siteConfig();
  if (!config) return [];
  return config.inputSelectors
    .filter(([, selectors]) =>
      (Array.isArray(selectors) ? selectors : [selectors]).some(
        (selector) =>
          typeof selector === "object" &&
          selector !== null &&
          "addButtonPath" in selector &&
          paths(selector.addButtonPath).some((path) =>
            queryXPathAll(document, path).some((button) => (button as HTMLElement).getClientRects().length > 0),
          ),
      ),
    )
    .map(([key]) => key);
}

// An iCIMS search list in a row no site rule reaches, searched as a rule
// would (see searchListDropdown).
export function searchSiteList(target: Element, values: string[], signal?: AbortSignal) {
  return searchListDropdown(target, values, globals, { signal });
}
