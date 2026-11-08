import { configs } from "../engine/config/catalog";

// Which site an opening is applied on, and whether a site rule covers it,
// known before the applicant opens it (2026-11-04): Microsoft's careers site
// had no rule and was found out one failed fill at a time. A company's own
// careers page often hands its form to an ATS (Rubrik's to Greenhouse, AMD's
// to iCIMS, Paccar's to SuccessFactors); the page is read for where it leads.
export type SiteCheck = {
  // The rule's ATS name ("Workday"), or none when no rule covers it.
  ats?: string;
  // The address the ATS was found at, when it is not the listing's own.
  via?: string;
  // How it was told: the listing's address, its host, a query parameter,
  // a link on its page, or nothing found.
  by: "address" | "host" | "parameter" | "page" | "none";
};

const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*")}$`);

type Rule = { ats: string; urls: RegExp[]; excluded: RegExp[]; hosts: string[] };
const rules: Rule[] = configs.map((config) => ({
  ats: config.ats,
  urls: config.urls.map(glob),
  excluded: (config.urlsExcluded || []).map(glob),
  // "*://*.myworkdayjobs.com/*" → ".myworkdayjobs.com"; "*://www.tesla.com/…" → "www.tesla.com".
  hosts: config.urls
    .map((pattern) => /^[^:]+:\/\/([^/]+)/.exec(pattern)?.[1] || "")
    .filter(Boolean)
    .map((host) => host.replace(/^\*\./, ".").replace(/^\*/, "")),
}));

// The last two labels, or three under a two-letter country suffix
// ("co.uk"): account.amazon.jobs and amazon.jobs are one site.
function registered(host: string): string {
  const parts = host.toLowerCase().split(".");
  return parts.slice(parts.length > 2 && parts.at(-2)!.length <= 3 && parts.at(-1)!.length === 2 ? -3 : -2).join(".");
}

export function siteOfAddress(url: string): SiteCheck | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  for (const rule of rules)
    if (rule.urls.some((pattern) => pattern.test(url)) && !rule.excluded.some((pattern) => pattern.test(url)))
      return { ats: rule.ats, by: "address" };
  const host = parsed.hostname.toLowerCase();
  for (const rule of rules)
    if (rule.hosts.some((ruled) => (ruled.startsWith(".") ? host.endsWith(ruled) || host === ruled.slice(1) : host === ruled) ||
        (!ruled.startsWith(".") && registered(ruled) === registered(host))))
      return { ats: rule.ats, by: "host" };
  // Boards that embed an ATS name it in the address they link to.
  const params = parsed.searchParams;
  const named = (ats: string) => rules.find((rule) => rule.ats.toLowerCase() === ats.toLowerCase())?.ats;
  if (params.has("gh_jid") && named("Greenhouse")) return { ats: named("Greenhouse"), by: "parameter" };
  const hinted = (params.get("ats") || "").toLowerCase();
  if (hinted) {
    const rule = rules.find((candidate) => candidate.ats.toLowerCase().replace(/\s+/g, "") === hinted.replace(/\s+/g, ""));
    if (rule) return { ats: rule.ats, by: "parameter" };
  }
  if (params.has("icims") && named("iCIMS")) return { ats: named("iCIMS"), by: "parameter" };
  return undefined;
}

// The ATS a page's own links lead to, the first a rule covers.
export function siteOfPage(html: string): SiteCheck | undefined {
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) {
    const link = match[0].replace(/&amp;/g, "&");
    const found = siteOfAddress(link);
    if (found?.ats && found.by !== "parameter") return { ats: found.ats, via: link, by: "page" };
  }
  return undefined;
}

export async function checkSite(url: string, fetcher: typeof fetch = fetch): Promise<SiteCheck> {
  const direct = siteOfAddress(url);
  if (direct) return direct;
  // Reserved names (RFC 2606) are no one's careers page: never fetched.
  try {
    if (/(^|\.)(test|example|invalid|localhost)$/i.test(new URL(url).hostname)) return { by: "none" };
  } catch {
    return { by: "none" };
  }
  try {
    const response = await fetcher(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", accept: "text/html" },
      signal: AbortSignal.timeout(8_000),
    });
    // Sent on to an ATS by the server itself.
    const landed = response.url && response.url !== url ? siteOfAddress(response.url) : undefined;
    if (landed?.ats) return { ats: landed.ats, via: response.url, by: "page" };
    if (!response.ok) return { by: "none" };
    const page = siteOfPage((await response.text()).slice(0, 2_000_000));
    if (page) return page;
  } catch {
    /* Unreadable: no rule known to cover it. */
  }
  return { by: "none" };
}

// Each opening checked once: a site does not change between searches.
export async function checkSites(
  urls: string[],
  cache: Map<string, SiteCheck>,
  fetcher: typeof fetch = fetch,
  concurrency = 6,
): Promise<Map<string, SiteCheck>> {
  const pending = [...new Set(urls)].filter((url) => !cache.has(url));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (next < pending.length) {
      const url = pending[next++];
      cache.set(url, await checkSite(url, fetcher));
    }
  }));
  return cache;
}
