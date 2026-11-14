// Finding jobs to apply for, from listings that gather many
// employers' openings: SimplifyJobs' new-grad and internship lists, and the
// public job boards (Greenhouse, Lever, Ashby) of companies the applicant
// names. Only these public, read-only listings: never a site whose terms
// forbid it (an employer, Indeed). What to look for is the applicant's own
// (roles, places), drawn from their profile when they ask.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { normalize, type Profile } from "../shared/model";
import { workdayOpening } from "../shared/matching";
import globals from "../engine/config/globals.json" with { type: "json" };
import { countryCode, findRegion, locationCountry, type Geography } from "../shared/geography";

const geography = globals as Geography;

// An opening's address as two pages of it agree on: no query, fragment or
// closing slash, the host in lower case.
export function openingKey(url: string): string {
  const workday = workdayOpening(url);
  if (workday) return workday;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

// An application or submission, as the queue and the submission log keep it.
// Its address follows the applicant's tab through the apply flow (a
// success page, Workday's "userHome", SmartRecruiters' one-click form), so
// it is seldom the listing's own, and is matched by more than that
// (: of the day's submitted openings, only those whose apply page
// kept the listing's address were marked tracked).
export type KnownOpening = { url: string; company?: string; title?: string };

// Each address an application or submission is known by: where its tab is
// now (a confirmation page once submitted), the listing it began at, and
// its posting. one employer's and one employer's listings were offered again once their
// applications were sent.
export function knownOpenings(saved: (KnownOpening & { sourceUrl?: string; postingUrl?: string })[]): KnownOpening[] {
  return saved.flatMap(({ url, sourceUrl, postingUrl, company, title }) =>
    [...new Set([url, sourceUrl, postingUrl].filter((address): address is string => Boolean(address)))].map((address) => ({ url: address, company, title })));
}

const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
// "jmfamily" is "an employer"; "LinkedIn3" is "an employer"; "an employer" is
// "an employer Surgical". Generic words do not make two companies one.
function sameCompany(a: string, b: string): boolean {
  const first = (text: string) => compact(text.split(/[\s,(&-]+/).find((word) => compact(word)) || "");
  const x = compact(a).replace(/\d+$/, "");
  const y = compact(b).replace(/\d+$/, "");
  if (!x || !y) return false;
  if (x === y) return true;
  const head = (text: string) => first(text).replace(/\d+$/, "");
  return [[x, head(b)], [y, head(a)]].some(([whole, word]) => word.length >= 3 && whole.startsWith(word));
}

// Long numbers in an address: a job's own id (one employer's 93894 is short and
// read by its path, Greenhouse's gh_jid, Microsoft's pid, a board's id).
function jobIds(url: string): string[] {
  let text = url;
  try { text = decodeURIComponent(url); } catch {}
  return [...new Set([
    ...(text.match(/\d{5,}/g) || []),
    // Workday's "…Intern_R121996": an underscore before it is no word break.
    ...(text.match(/(?<![A-Za-z0-9])[JR]R?\d{4,}(?:-\d+)?\b/gi) || []).map((id) => id.toUpperCase()),
    // Workable's "DE75CD20B8".
    ...(text.match(/\/j\/([A-Z0-9]{8,12})\b/g) || []).map((id) => id.slice(3)),
    // Lever's and Ashby's job UUIDs.
    ...(text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) || []).map((id) => id.toLowerCase()),
  ])];
}
const host = (url: string) => {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
};

// A title's words without its season, year, dates or the listing's places:
// "Compiler Software Engineering Intern - Summer 2027" is the listing's
// "Compiler Software Engineer Intern".
function titleWords(title: string, places: string[]): Set<string> {
  const placeWords = new Set(places.flatMap((place) => place.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean));
  const skip = /^(summer|fall|spring|winter|20\d\d|january|february|march|april|may|june|july|august|september|october|november|december|to|the|and|of|a|an|in|for|with|at)$/;
  // A requisition number or season in brackets is no part of the title:
  // "Data Analyst Intern (73956)" is the listing's "Data Analyst Intern"
  // (PACCAR).
  return new Set(
    title.toLowerCase().replace(/[([]\s*(?:[a-z]*\d[\w-]*|(?:summer|fall|spring|winter)\s+20\d\d)\s*[)\]]/g, " ").replace(/engineering/g, "engineer").split(/[^a-z0-9]+/)
      .filter((word) => word && !skip.test(word) && !placeWords.has(word)),
  );
}
function sameTitle(a: string, b: string, places: string[]): boolean {
  const x = titleWords(a, places);
  const y = titleWords(b, places);
  if (x.size < 2 || x.size !== y.size) return false;
  return [...x].every((word) => y.has(word));
}

export function isTracked(listing: { url: string; company: string; title: string; locations?: string[] }, known: KnownOpening[]): boolean {
  const key = openingKey(listing.url);
  const ids = jobIds(listing.url);
  return known.some((opening) => {
    if (openingKey(opening.url) === key) return true;
    const theirs = jobIds(opening.url);
    // A job's id on the same site, or a UUID anywhere, is that job whatever
    // the company was saved as: one employer's Workday application was "sec",
    // and an employer's Ashby one was named by its board's UUID.
    // A UUID can be a board's own (Ashby's), so the last one is the job's.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/;
    const ownUuid = (list: string[]) => list.filter((id) => uuid.test(id)).at(-1);
    if (ownUuid(ids) && ownUuid(ids) === ownUuid(theirs)) return true;
    if (host(opening.url) === host(listing.url) && ids.some((id) => !uuid.test(id) && theirs.includes(id))) return true;
    if (!opening.company || !sameCompany(opening.company, listing.company)) return false;
    if (ids.length && theirs.some((id) => ids.includes(id))) return true;
    // Two openings of one site, each named by its own id, are two openings
    // whatever their titles (neurohire's two "Business Data Analyst" jobs).
    if (ids.length && theirs.length && host(opening.url) === host(listing.url)) return false;
    return Boolean(opening.title) && sameTitle(opening.title!, listing.title, listing.locations || []);
  });
}

export const searchSettingsSchema = z.object({
  // Job titles to look for ("software engineer", "machine learning").
  roles: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  // Places ("Arizona", "San Francisco", "AZ"); none means anywhere.
  locations: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  // Remote openings count wherever they are, in the country below.
  remote: z.boolean().default(true),
  // Only openings in this country ("United States"); empty is the
  // profile's country when searching from it, else anywhere.
  country: z.string().trim().max(100).default(""),
  // Leave out senior, staff, principal, lead and manager titles unless a
  // role asked for names one.
  skipSenior: z.boolean().default(true),
  // Add the roles and places the profile suggests to the ones above.
  fromProfile: z.boolean().default(true),
  sources: z
    .object({
      newGrad: z.boolean().default(true),
      internships: z.boolean().default(false),
      boards: z.boolean().default(true),
    })
    .default({}),
  // Companies whose own job boards are read: a board's address
  // (boards.greenhouse.io/acme, jobs.lever.co/acme, jobs.ashbyhq.com/acme)
  // or "greenhouse:acme".
  companies: z.array(z.string().trim().min(1).max(300)).max(200).default([]),
  postedWithinDays: z.number().int().min(1).max(365).default(30),
  limit: z.number().int().min(10).max(500).default(100),
});
export type SearchSettings = z.infer<typeof searchSettingsSchema>;

// What a search looks through when the applicant has not chosen, by where
// they are in their career: a student, internships and new-grad roles; a
// new graduate, new-grad roles; anyone with experience, companies' own
// boards with senior roles kept. Saved settings always win.
export function stageDefaults(profile: Pick<Profile, "careerStage">): Partial<SearchSettings> {
  switch (profile.careerStage) {
    case "student":
      return { sources: { newGrad: true, internships: true, boards: true }, skipSenior: true };
    case "new-grad":
      return { sources: { newGrad: true, internships: false, boards: true }, skipSenior: true };
    case "experienced":
    case "career-change":
      return { sources: { newGrad: false, internships: false, boards: true }, skipSenior: false };
    default:
      return {};
  }
}

export type Listing = {
  id: string;
  title: string;
  company: string;
  locations: string[];
  url: string;
  postedAt?: number;
  source: string;
  category?: string;
  // The role and place it was found for.
  matched: string[];
  score: number;
  // Already an application here (tracked, or submitted).
  tracked?: boolean;
  // The site it is applied on and whether a rule covers it (site-check.ts).
  site?: { ats?: string; by: string; via?: string };
};
export type SearchResult = {
  at: number;
  roles: string[];
  locations: string[];
  country: string;
  remote: boolean;
  listings: Listing[];
  sources: { id: string; count: number; error?: string }[];
};

// SimplifyJobs keeps one internship list per summer ("Summer2027-
// Internships"); from August the next summer's is the one being filled.
export function internshipSeason(now: number): number {
  const date = new Date(now);
  return date.getMonth() >= 7 ? date.getFullYear() + 1 : date.getFullYear();
}
const internshipList = (year: number) =>
  `https://raw.githubusercontent.com/SimplifyJobs/Summer${year}-Internships/dev/.github/scripts/listings.json`;
const simplifyLists = (now: number) => ({
  newGrad: { id: "simplify-new-grad", url: "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json", fallback: undefined as string | undefined },
  // The season before, when the new one is not up yet (a 404).
  internships: { id: "simplify-internships", url: internshipList(internshipSeason(now)), fallback: internshipList(internshipSeason(now) - 1) },
});

// Words in a job title that say how senior, not what the job is.
const levelWords = /\b(intern(ship)?|co ?op|associate|assistant|junior|jr|senior|sr|staff|lead|principal|chief|head|i{1,3}|iv|new grad(uate)?|entry level|early career|part time|full time|temporary|contract|trainee|apprentice)\b/g;
// Titles that name no kind of work to search for.
const notRoles = /^(founder|co founder|cofounder|owner|solo|volunteer|freelancer?|self employed|member|student|research|teaching|graduate|undergraduate)$/;
// A field of study, and the roles it leads to.
const fieldRoles: [RegExp, string[]][] = [
  [/computer science|software|computer engineering/, ["software engineer", "software developer"]],
  [/data science|analytics|statistics/, ["data scientist", "data engineer", "machine learning", "data analyst"]],
  [/machine learning|artificial intelligence|\bai\b/, ["machine learning", "ai engineer"]],
  [/electrical/, ["electrical engineer"]],
  [/mechanical/, ["mechanical engineer"]],
];

// The roles and places a profile suggests: its jobs' titles without their
// level, its degrees' fields, and where the applicant lives unless they will
// relocate anywhere (their preferences say so).
export function profileTargets(profile: Profile, preferences = ""): { roles: string[]; locations: string[] } {
  const roles = new Set<string>();
  // Each job's title without its level, in any field ("Senior Registered
  // Nurse" is "registered nurse", "Marketing Manager" stays one): a title
  // that names no kind of work ("Founder") is not searched for.
  for (const row of profile.work) {
    const title = normalize(row.title.replace(/\(.*?\)|[,|].*$/g, " ")).replace(levelWords, " ").replace(/\s+/g, " ").trim();
    if (!title || notRoles.test(title) || title.split(" ").length > 4) continue;
    const words = title.split(" ");
    // "Creative Technology" after "Associate" is gone names a field, not
    // work done; a kind of work ends the title.
    if (words.length > 1 && /^(technology|technologies|operations|services|solutions)$/.test(words.at(-1)!)) continue;
    roles.add(title);
  }
  for (const row of profile.education)
    for (const [field, suggested] of fieldRoles)
      if (field.test(normalize(`${row.fieldOfStudy || ""} ${row.title}`))) for (const role of suggested) roles.add(role);
  const anywhere = /relocat\w*[^\n]*\b(anywhere|yes)\b/i.test(preferences);
  const locations = anywhere ? [] : [profile.state, profile.city].filter(Boolean) as string[];
  return { roles: [...roles].slice(0, 15), locations };
}

// A board named by its address or "ats:slug".
export function boardFor(entry: string): { ats: "greenhouse" | "lever" | "ashby"; slug: string } | undefined {
  const plain = entry.trim();
  const named = plain.match(/^(greenhouse|lever|ashby):([\w.-]+)$/i);
  if (named) return { ats: named[1].toLowerCase() as "greenhouse" | "lever" | "ashby", slug: named[2] };
  try {
    const url = new URL(/^https?:/.test(plain) ? plain : `https://${plain}`);
    const slug = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] || "");
    if (!/^[\w.-]+$/.test(slug)) return;
    if (/(^|\.)greenhouse\.io$/.test(url.hostname)) return { ats: "greenhouse", slug };
    if (/(^|\.)lever\.co$/.test(url.hostname)) return { ats: "lever", slug };
    if (/(^|\.)ashbyhq\.com$/.test(url.hostname)) return { ats: "ashby", slug };
  } catch {
    /* not an address */
  }
}

type Fetch = typeof fetch;
// A listing file, kept for a few hours: SimplifyJobs' are 13 MB each.
async function cachedJSON(cacheDir: string, key: string, url: string, fetcher: Fetch, hours = 6): Promise<any> {
  const file = join(cacheDir, `${key}.json`);
  const fresh = await stat(file).then((info) => Date.now() - info.mtimeMs < hours * 3_600_000, () => false);
  if (fresh) return JSON.parse(await readFile(file, "utf8"));
  const response = await fetcher(url, { signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "Application Lane job search" } });
  if (!response.ok) throw new Error(`${new URL(url).hostname} answered ${response.status}`);
  const body = await response.json();
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, JSON.stringify(body));
  return body;
}

async function readBoard(board: { ats: string; slug: string }, cacheDir: string, fetcher: Fetch): Promise<Omit<Listing, "matched" | "score">[]> {
  const key = `${board.ats}-${board.slug}`;
  if (board.ats === "greenhouse") {
    const body = await cachedJSON(cacheDir, key, `https://boards-api.greenhouse.io/v1/boards/${board.slug}/jobs`, fetcher, 2);
    return (body.jobs || []).map((job: any) => ({
      id: `greenhouse:${board.slug}:${job.id}`, title: String(job.title || ""), company: board.slug,
      locations: [job.location?.name].filter(Boolean), url: job.absolute_url,
      postedAt: Date.parse(job.first_published || job.updated_at) || undefined, source: "Greenhouse",
    }));
  }
  if (board.ats === "lever") {
    const body = await cachedJSON(cacheDir, key, `https://api.lever.co/v0/postings/${board.slug}?mode=json`, fetcher, 2);
    return (Array.isArray(body) ? body : []).map((job: any) => ({
      id: `lever:${board.slug}:${job.id}`, title: String(job.text || ""), company: board.slug,
      locations: [...new Set([job.categories?.location, ...(job.categories?.allLocations || [])].filter(Boolean))] as string[],
      url: job.hostedUrl, postedAt: job.createdAt || undefined, source: "Lever",
    }));
  }
  const body = await cachedJSON(cacheDir, key, `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.slug)}`, fetcher, 2);
  return (body.jobs || []).filter((job: any) => job.isListed !== false).map((job: any) => ({
    id: `ashby:${board.slug}:${job.id}`, title: String(job.title || ""), company: board.slug,
    locations: [job.location, ...(job.secondaryLocations || []).map((other: any) => other.location), job.isRemote ? "Remote" : ""].filter(Boolean),
    url: job.jobUrl || job.applyUrl, postedAt: Date.parse(job.publishedAt) || undefined, source: "Ashby",
  }));
}

// A place and its other names in its country: "Arizona" and "AZ",
// "Ontario" and "ON".
const placeWords = (place: string, country = "") => {
  const region = findRegion(geography, place, country || undefined);
  return region ? [...new Set([region.code, ...region.names].map(normalize))] : [normalize(place)];
};

// Whether a title is one of the roles: every word of the role in it.
function roleMatch(title: string, roles: string[]): string | undefined {
  const words = new Set(normalize(title).split(" "));
  const plain = ` ${normalize(title)} `;
  return roles.find((role) => {
    const wanted = normalize(role);
    return wanted && (plain.includes(` ${wanted} `) || wanted.split(" ").every((word) => words.has(word)));
  });
}
// Whether a listing's place is in a country, told from the place itself
// ("Phoenix, AZ", "Toronto, ON, Canada", "Remote in USA"). A place whose
// country cannot be told ("Remote", "Georgia") is not counted as in it.
function inCountry(location: string, country: string): boolean {
  if (!country) return true;
  const wanted = countryCode(geography, country);
  if (!wanted) return normalize(location).includes(normalize(country));
  return locationCountry(geography, location) === wanted;
}
function placeMatch(locations: string[], places: string[], remote: boolean, country = ""): string | undefined {
  locations = locations.filter((location) => inCountry(location, country));
  if (!locations.length) return;
  if (remote && locations.some((location) => /\bremote\b/i.test(location))) return "Remote";
  if (!places.length) return "anywhere";
  for (const place of places) {
    const words = placeWords(place, country);
    if (locations.some((location) => {
      const plain = ` ${normalize(location)} `;
      return words.some((word) => plain.includes(` ${word} `));
    }))
      return place;
  }
}

export async function searchJobs(
  settings: SearchSettings,
  profile: Profile,
  options: { cacheDir: string; preferences?: string; known?: Set<string> | KnownOpening[]; fetcher?: Fetch; now?: number },
): Promise<SearchResult> {
  // Addresses as two pages of an opening agree on them (openingKey).
  const known: KnownOpening[] = [...(options.known || [])].map((opening) => (typeof opening === "string" ? { url: opening } : opening));
  const fetcher = options.fetcher || fetch;
  const now = options.now ?? Date.now();
  const suggested = settings.fromProfile ? profileTargets(profile, options.preferences) : { roles: [], locations: [] };
  const roles = [...new Set([...settings.roles, ...suggested.roles].map((role) => role.trim()).filter(Boolean))];
  const locations = [...new Set([...settings.locations, ...(settings.locations.length ? [] : suggested.locations)])];
  const country = settings.country || (settings.fromProfile ? profile.country || "" : "");
  const senior = /\b(senior|sr|staff|principal|lead|manager|director|head of)\b/;
  const sources: SearchResult["sources"] = [];
  const found: Omit<Listing, "matched" | "score">[] = [];
  for (const [key, list] of Object.entries(simplifyLists(now)) as [keyof ReturnType<typeof simplifyLists>, ReturnType<typeof simplifyLists>["newGrad"]][]) {
    if (!settings.sources[key]) continue;
    try {
      const body = await cachedJSON(options.cacheDir, list.id, list.url, fetcher).catch((error: Error) => {
        if (!list.fallback || !/ 404$/.test(error.message)) throw error;
        return cachedJSON(options.cacheDir, `${list.id}-previous`, list.fallback, fetcher);
      });
      const open = (Array.isArray(body) ? body : []).filter((job: any) => job.active && job.is_visible !== false && job.url);
      found.push(...open.map((job: any) => ({
        id: `simplify:${job.id}`, title: String(job.title || ""), company: String(job.company_name || ""),
        locations: Array.isArray(job.locations) ? job.locations : [], url: job.url,
        postedAt: job.date_posted ? job.date_posted * 1000 : undefined, source: "SimplifyJobs", category: job.category,
      })));
      sources.push({ id: list.id, count: open.length });
    } catch (error) {
      sources.push({ id: list.id, count: 0, error: (error as Error).message });
    }
  }
  if (settings.sources.boards)
    for (const entry of settings.companies) {
      const board = boardFor(entry);
      if (!board) {
        sources.push({ id: entry, count: 0, error: "Not a Greenhouse, Lever or Ashby board." });
        continue;
      }
      try {
        const jobs = await readBoard(board, options.cacheDir, fetcher);
        found.push(...jobs.filter((job) => job.url));
        sources.push({ id: `${board.ats}:${board.slug}`, count: jobs.length });
      } catch (error) {
        sources.push({ id: `${board.ats}:${board.slug}`, count: 0, error: (error as Error).message });
      }
    }
  const oldest = now - settings.postedWithinDays * 86_400_000;
  const seen = new Set<string>();
  const listings: Listing[] = [];
  for (const job of found) {
    if (!job.title || seen.has(job.url)) continue;
    if (job.postedAt && job.postedAt < oldest) continue;
    const role = roles.length ? roleMatch(job.title, roles) : "any role";
    if (!role) continue;
    if (settings.skipSenior && senior.test(normalize(job.title)) && !senior.test(normalize(role))) continue;
    const place = placeMatch(job.locations, locations, settings.remote, country);
    if (!place) continue;
    seen.add(job.url);
    // An exact role in the title first, then the newest.
    const exact = ` ${normalize(job.title)} `.includes(` ${normalize(role)} `) ? 2 : 1;
    const days = job.postedAt ? Math.max(0, (now - job.postedAt) / 86_400_000) : settings.postedWithinDays;
    listings.push({ ...job, matched: [role, place], score: exact * 100 - days, tracked: isTracked(job, known) || undefined });
  }
  listings.sort((a, b) => b.score - a.score);
  return { at: now, roles, locations, country, remote: settings.remote, listings: listings.slice(0, settings.limit), sources };
}
