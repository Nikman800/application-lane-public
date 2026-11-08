export type Adapter = {
  name: string;
  matches: (url: URL) => boolean;
  root: string;
  next: string;
  final: RegExp;
  // The job's description where the page keeps it outside the root (a
  // collapsed card beside the apply steps), and the element naming the
  // employer where the address does not.
  posting?: string;
  company?: string;
  // The job's description as HTML where the page keeps it only in its data,
  // never drawn.
  postingHTML?: (document: Document) => string;
};
const final =
  /submit|send application|finish|complete application|sign|agree|certif|accept|create account|register|log ?in/i;
const domain = (url: URL, suffix: string) =>
  url.hostname === suffix || url.hostname.endsWith(`.${suffix}`);
export const adapters: Adapter[] = [
  {
    name: "Workday",
    matches: (u) =>
      domain(u, "myworkdayjobs.com") || domain(u, "myworkdaysite.com"),
    root: '[data-automation-id="jobPostingDescription"], [data-automation-id="applicationPage"]',
    next: '[data-automation-id="bottom-navigation-next-button"]',
    final,
  },
  {
    name: "Greenhouse",
    matches: (u) => domain(u, "greenhouse.io"),
    root: "#application, #content, .job__description",
    next: 'button[data-testid="next-button"]',
    final,
  },
  {
    name: "Lever",
    matches: (u) => domain(u, "lever.co"),
    root: ".application-form, .posting-page",
    next: 'button[data-qa="next"]',
    final,
  },
  {
    name: "Ashby",
    matches: (u) => domain(u, "ashbyhq.com"),
    root: '[data-testid="application-form"], main',
    next: 'button[data-testid="next-button"]',
    final,
  },
  {
    name: "iCIMS",
    matches: (u) => domain(u, "icims.com"),
    root: "#iCIMS_MainWrapper, .iCIMS_JobContent",
    next: 'button[data-action="next"]',
    final,
  },
  {
    // Indeed's own apply steps: read for the job they belong to and for
    // drafting answers. Its Continue is the applicant's to press.
    name: "General",
    matches: (u) => domain(u, "indeed.com"),
    root: 'main, [role="main"], form',
    next: "",
    final,
    posting: ".ia-JobDescription, #jobDescriptionText",
    company: '.ia-JobHeader-information > span, [data-testid="inlineHeader-companyName"]',
  },
  {
    // Breezy's apply page shows only the job's title; the posting is in the
    // position its page script reads (data-position).
    name: "General",
    matches: (u) => domain(u, "breezy.hr"),
    root: 'main, [role="main"], form',
    next: "",
    final,
    postingHTML: (document) => {
      try {
        const position = JSON.parse(document.querySelector("[data-position]")?.getAttribute("data-position") || "{}");
        return typeof position?.description === "string" ? position.description : "";
      } catch {
        return "";
      }
    },
  },
];
export const generic: Adapter = {
  name: "General",
  matches: () => true,
  root: 'main, [role="main"], form',
  next: "",
  final,
};
export function adapterFor(url: string): Adapter {
  try {
    return adapters.find((a) => a.matches(new URL(url))) || generic;
  } catch {
    return generic;
  }
}
