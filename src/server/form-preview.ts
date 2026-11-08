import type { Field, Profile } from "../shared/model";
import { normalize } from "../shared/model";
import { proposals } from "../shared/matching";
import { siteOfAddress } from "./site-check";

// What a searched opening's form will ask and how much of it a fill can
// answer, known before it is opened. Three sources, each as far
// as it reaches:
//  1. history: what past fills on the same site and at the same company left
//     to the applicant (queue.json's "needs"), for every site;
//  2. gaps: what a site rule is known not to handle yet;
//  3. questions: the form itself, where the site publishes it before anyone
//     applies (Greenhouse's job board API), answered offline with the same
//     rules a fill uses.

export type Preview = {
  gaps?: string[];
  history?: {
    site?: { name: string; applications: number; leftSome: number; common: { label: string; count: number }[] };
    company?: { applications: number; left: string[] };
  };
  questions?: { total: number; profile: number; ai: number; you: string[]; optional: number };
};

// 2. Known gaps, by the rule's ATS name or, for a site no rule covers, its
// host. Only what fills have shown; history adds the rest as it happens.
const gaps: { ats?: string; host?: RegExp; note: string }[] = [
  {
    host: /(^|\.)careers\.microsoft\.com$/,
    note: "Microsoft's careers form: newly handled (its lists and address); check its sponsorship answer, address and résumé choice before submitting.",
  },
  {
    ats: "SmartRecruiters",
    note: "SmartRecruiters: the résumé upload often needs choosing or checking by hand.",
  },
];
export function siteGaps(url: string, ats: string | undefined): string[] {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    /* No host: only the rule's own gaps. */
  }
  return gaps.filter((gap) => (gap.ats && gap.ats === ats) || (gap.host && gap.host.test(host))).map((gap) => gap.note);
}

// 1. Past fills.
export type QueuedApplication = {
  url: string;
  company?: string;
  needs?: string[];
  lastFill?: unknown;
};
type Tally = { applications: number; leftSome: number; labels: Map<string, { label: string; count: number }> };
const companyKey = (name: string) => normalize(name).replace(/\b(inc|llc|ltd|corp|corporation|company|co|the)\b/g, " ").replace(/\s+/g, " ").trim();
const siteKey = (url: string) => {
  const ats = siteOfAddress(url)?.ats;
  if (ats) return ats;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};
export function fillHistory(applications: QueuedApplication[]) {
  const sites = new Map<string, Tally>();
  const companies = new Map<string, { applications: number; left: Set<string> }>();
  for (const app of applications) {
    // Only openings a fill ran on say anything about what a fill leaves.
    if (!app.lastFill) continue;
    const needs = (app.needs || []).filter((label) => typeof label === "string" && label.trim());
    const key = siteKey(app.url);
    if (key) {
      const tally = sites.get(key) || { applications: 0, leftSome: 0, labels: new Map() };
      tally.applications++;
      if (needs.length) tally.leftSome++;
      for (const label of new Set(needs.map((need) => need.trim()))) {
        const id = normalize(label);
        const seen = tally.labels.get(id) || { label: label.slice(0, 200), count: 0 };
        seen.count++;
        tally.labels.set(id, seen);
      }
      sites.set(key, tally);
    }
    const company = companyKey(app.company || "");
    if (company) {
      const entry = companies.get(company) || { applications: 0, left: new Set<string>() };
      entry.applications++;
      for (const label of needs) entry.left.add(label.trim().slice(0, 200));
      companies.set(company, entry);
    }
  }
  return {
    forListing(listing: { url: string; company: string; site?: { ats?: string } }): Preview["history"] {
      const key = listing.site?.ats || siteKey(listing.url);
      const site = sites.get(key);
      const company = companies.get(companyKey(listing.company));
      if (!site && !company) return undefined;
      return {
        ...(site
          ? {
            site: {
              name: key,
              applications: site.applications,
              leftSome: site.leftSome,
              // What recurs: asked of the applicant on two fills or more.
              common: [...site.labels.values()].filter((entry) => entry.count >= 2).sort((a, b) => b.count - a.count).slice(0, 3),
            },
          }
          : {}),
        ...(company ? { company: { applications: company.applications, left: [...company.left].slice(0, 5) } } : {}),
      };
    },
  };
}

// 3. Greenhouse publishes each opening's form on its job board API.
export function greenhouseJob(url: string): { board: string; id: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!/(^|\.)greenhouse\.io$/i.test(parsed.hostname)) return;
  const path = parsed.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
  if (path && path[1] !== "embed") return { board: path[1], id: path[2] };
  const board = parsed.searchParams.get("for");
  const id = parsed.searchParams.get("token");
  return board && id && /^\d+$/.test(id) ? { board, id } : undefined;
}

type GreenhouseField = { type?: string; values?: { label?: string }[] };
type GreenhouseQuestion = { label?: string; required?: boolean; fields?: GreenhouseField[] };
// The form's questions as fields a fill would see.
export function greenhouseFields(job: {
  questions?: GreenhouseQuestion[];
  compliance?: { questions?: GreenhouseQuestion[] }[];
  location_questions?: GreenhouseQuestion[];
}): Field[] {
  const asked = [
    ...(job.questions || []),
    ...(job.location_questions || []),
    ...(job.compliance || []).flatMap((group) => group.questions || []),
  ];
  return asked.flatMap((question, index) => {
    // Its equal-opportunity questions are named in one word ("VeteranStatus").
    const raw = (question.label || "").replace(/\s+/g, " ").trim();
    const label = /\s/.test(raw) ? raw : raw.replace(/([a-z])([A-Z])/g, "$1 $2");
    // The coordinates its location question keeps beside the city are no
    // question.
    if (/^(longitude|latitude)$/i.test(label)) return [];
    const types = (question.fields || []).map((field) => field.type || "");
    if (!label || !types.length) return [];
    const options = (question.fields || []).flatMap((field) => (field.values || []).map((value) => (value.label || "").trim())).filter(Boolean);
    const kind = types.includes("input_file") ? "file"
      : types.includes("multi_value_multi_select") ? "checkbox"
      : types.some((type) => /select/.test(type)) ? "select"
      : types.includes("textarea") ? "textarea"
      : "text";
    return [{ id: `q${index}`, label: label.slice(0, 1000), kind, required: question.required === true, value: "", options: options.slice(0, 300), revision: 1, protected: false }];
  });
}

// Answered offline: from the profile (a fill's own rules), by AI (an open
// question it writes from the applicant's facts), or left to the applicant.
export function classify(fields: Field[], profile: Profile, company: string): NonNullable<Preview["questions"]> {
  const who = { ...profile, applyingTo: { ...(profile.applyingTo || {}), company } } as Profile;
  const answered = new Set(proposals(fields, who).map((proposal) => proposal.fieldId));
  let fromProfile = 0;
  let ai = 0;
  let optional = 0;
  const you: string[] = [];
  for (const field of fields) {
    // The résumé and cover letter are the documents a fill makes and uploads.
    const document = field.kind === "file" && /\b(resume|résumé|cv|cover letter)\b/i.test(field.label);
    if (answered.has(field.id) || document) fromProfile++;
    else if (field.kind === "textarea") ai++;
    else if (field.required) you.push(field.label);
    else optional++;
  }
  return { total: fields.length, profile: fromProfile, ai, you, optional };
}

export async function readGreenhouse(url: string, fetcher: typeof fetch = fetch): Promise<Field[] | undefined> {
  const job = greenhouseJob(url);
  if (!job) return;
  try {
    const response = await fetcher(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(job.board)}/jobs/${job.id}?questions=true`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return;
    return greenhouseFields(await response.json());
  } catch {
    return;
  }
}
