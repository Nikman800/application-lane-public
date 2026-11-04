import type { z } from "zod";
import { normalize } from "../../shared/model";
import type { optionsSourceSchema } from "./schema";

// A rule's optionsSource names the site's own endpoint for a list's answers
// (Workday's degrees and fields of study, Greenhouse's schools). Read before
// the list is searched, it tells which of the profile's wordings the site
// holds: Workday dropped a field of study typed in a wording it does not list
// (25 forms, 2026-10-16), and each search that finds nothing costs about 20 s.
export type OptionsSource = z.infer<typeof optionsSourceSchema>;

// complete: the whole list, not one search's results, so a wording missing
// from it is missing from the site.
export type SiteOptions = { names: string[]; complete: boolean };

// "/recruiting/:tenant(/*)": a named segment, "*" any one segment, "(/*)"
// whatever follows.
function matchPattern(pattern: string, pathname: string): Record<string, string> | undefined {
  const names: string[] = [];
  let source = "";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("(/*)", i)) {
      source += "(?:/.*)?";
      i += 4;
      continue;
    }
    const name = /^:([A-Za-z_]\w*)/.exec(pattern.slice(i));
    if (name) {
      names.push(name[1]);
      source += "([^/]+)";
      i += name[0].length;
      continue;
    }
    source += pattern[i] === "*" ? "[^/]*" : pattern[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  const found = new RegExp(`^${source}/?$`).exec(pathname);
  if (!found) return undefined;
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(found[index + 1])]));
}

// Fills "{{name}}" and "{{name[0]}}"; undefined when any part is unknown.
function render(template: string, lookup: (name: string, index?: string) => string | undefined) {
  let missing = false;
  const text = template.replace(/\{\{(\w+)(?:\[([^\]]+)\])?\}\}/g, (_, name: string, index?: string) => {
    const value = lookup(name, index);
    if (!value) missing = true;
    return value || "";
  });
  return missing ? undefined : text;
}

export function sourceUrl(source: OptionsSource, pageUrl: string, term = ""): string | undefined {
  const page = new URL(pageUrl);
  const host = page.hostname.split(".");
  const variables: Record<string, string> = {};
  for (const [name, extractors] of Object.entries(source.extractors || {})) {
    for (const extractor of Array.isArray(extractors) ? extractors : [extractors]) {
      const groups = extractor.urlPattern ? matchPattern(extractor.urlPattern, page.pathname) : {};
      if (!groups) continue;
      const value = render(extractor.template, (key, index) =>
        key === "hostname" ? page.hostname
          : key === "hostnameSplit" ? host[Number(index)]
          : key === "searchParams" ? page.searchParams.get(index || "") || undefined
          : groups[key],
      );
      if (value) {
        variables[name] = value;
        break;
      }
    }
  }
  return render(source.urlTemplate, (key) =>
    key === "term" ? encodeURIComponent(term) : variables[key] && encodeURIComponent(variables[key]),
  );
}

// "items" or "" (the body itself) to the array; "descriptor" to each name.
export function readOptions(body: unknown, source: OptionsSource): string[] | undefined {
  const at = (value: unknown, path: string) =>
    path.split(".").filter(Boolean).reduce<unknown>(
      (node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
      value,
    );
  const items = at(body, source.responseItemsPath);
  if (!Array.isArray(items)) return undefined;
  // Folders of the list, not its entries: RTX's Workday answers its fields of
  // study with "Partial List (First 500 Entries)" and "All", each a link to
  // its own page, and "Data Science" was taken as unlisted (report 6e6db787).
  // Without the list, the rule searches as it always did.
  if (items.some((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).href === "string")) return undefined;
  return items
    .map((item) => at(item, source.responseTextPath))
    .filter((name): name is string => typeof name === "string" && Boolean(name.trim()));
}

// One request per list and page: an education row and the next share it.
const cache = new Map<string, Promise<string[] | undefined>>();

export async function fetchSiteOptions(
  source: OptionsSource,
  pageUrl: string,
  terms: string[],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SiteOptions | undefined> {
  const searched = source.urlTemplate.includes("{{term}}");
  const queries = searched
    ? [...new Set(terms.map((term) => term.trim()))]
        .filter((term) => term && term.length >= (source.minTermLength ?? 1))
        .slice(0, source.maxRequests ?? 1)
    : [""];
  const urls = queries.map((term) => sourceUrl(source, pageUrl, term)).filter((url): url is string => Boolean(url));
  if (!urls.length) return undefined;
  const lists = await Promise.all(
    urls.map((url) => {
      let request = cache.get(url);
      if (!request) {
        // A slow endpoint must not hold up the fill: without the list, the
        // rule searches as it always did.
        const timeout = AbortSignal.timeout(5_000);
        request = fetcher(url, {
          credentials: "same-origin",
          headers: { accept: "application/json" },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
          .then((response) => (response.ok ? response.json() : undefined))
          .then((body) => readOptions(body, source))
          .catch(() => undefined);
        cache.set(url, request);
        request.then((names) => names || cache.delete(url));
      }
      return request;
    }),
  );
  if (lists.some((names) => !names)) return undefined;
  return { names: [...new Set(lists.flat() as string[])], complete: !searched };
}

// The site's own spelling of each value it lists, in the values' order. A
// wording two of its entries share is left out: the list cannot tell which.
export function listedNames(values: string[], site: SiteOptions): string[] {
  const byName = new Map<string, string[]>();
  for (const name of site.names) byName.set(normalize(name), [...(byName.get(normalize(name)) || []), name]);
  const names = values.flatMap((value) => {
    const same = byName.get(normalize(value));
    return same?.length === 1 ? same : [];
  });
  return [...new Set(names)];
}

// Clears the cache between tests.
export function forgetSiteOptions() {
  cache.clear();
}
