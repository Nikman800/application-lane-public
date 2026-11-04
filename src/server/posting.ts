// The job posting behind an application URL, read from the ATS's public
// posting endpoint. An application step's own page is a form ("Full name,
// Email, Resume…"), and tailoring from it is tailoring from nothing; these
// endpoints serve the title and the full description without a login.
//
// Only the hosts below are ever fetched, and only at the address derived from
// the URL's own job identifier.

export type Posting = {
  title: string;
  company?: string;
  location?: string;
  description: string;
  // "Posting page": a page the applicant linked; "Pasted": text they pasted.
  source: "Greenhouse" | "Lever" | "Ashby" | "Workday" | "Oracle" | "Workable" | "SmartRecruiters" | "Posting page" | "Pasted";
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  bull: "•",
  hellip: "…",
};
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) =>
    name[0] === "#"
      ? String.fromCodePoint(
          name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)),
        )
      : (entities[name.toLowerCase()] ?? whole),
  );

// Posting HTML as readable text: block elements and list items on their own
// lines, everything else as its text.
export function htmlText(html: string): string {
  // Greenhouse escapes its HTML once more.
  const markup = /&lt;\w/.test(html) && !/<\w/.test(html) ? decode(html) : html;
  return decode(
    markup
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<li\b[^>]*>/gi, "\n• ")
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/ul|\/ol|\/tr)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    // A list item follows its lead-in directly.
    .replace(/\n\n• /g, "\n• ")
    .trim();
}

const join = (...parts: (string | undefined)[]) =>
  parts.map((part) => (part || "").trim()).filter(Boolean).join("\n\n");

type Endpoint = {
  source: Posting["source"];
  api: string;
  read: (body: any) => Posting | undefined;
};

export function postingEndpoint(raw: string): Endpoint | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== "https:") return;
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const host = url.hostname.toLowerCase();

  const greenhouse = host.match(/^(?:job-boards|boards)(\.eu)?\.greenhouse\.io$/);
  if (greenhouse) {
    const board = parts[0] === "embed" ? url.searchParams.get("for") || "" : parts[0] || "";
    const id = parts[0] === "embed" ? url.searchParams.get("token") || "" : parts[1] === "jobs" ? parts[2] || "" : "";
    if (!/^[\w-]+$/.test(board) || !/^\d+$/.test(id)) return;
    return {
      source: "Greenhouse",
      // One API serves EU boards too: there is no boards-api.eu host
      // (ASM's EU board, 2026-10-02).
      api: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`,
      read: (body) =>
        body?.title
          ? {
              source: "Greenhouse",
              title: body.title,
              company: body.company_name || board,
              location: body.location?.name,
              description: htmlText(body.content || ""),
            }
          : undefined,
    };
  }

  // https://apply.workable.com/<account>/j/<shortcode>/apply: its page builds
  // itself from this address (NeuroHire's, 2026-10-31: the extension could not
  // read the posting from the page).
  if (host === "apply.workable.com" && parts[1] === "j") {
    const [account, , shortcode] = parts;
    if (!/^[\w.-]+$/.test(account || "") || !/^[0-9A-Za-z]{6,16}$/.test(shortcode || "")) return;
    return {
      source: "Workable",
      api: `https://apply.workable.com/api/v2/accounts/${account}/jobs/${shortcode}`,
      read: (body) =>
        body?.title
          ? {
              source: "Workable",
              title: body.title,
              company: account,
              location: [body.location?.city, body.location?.region, body.location?.country].filter(Boolean).join(", ") || undefined,
              description: join(htmlText(body.description || ""), htmlText(body.requirements || ""), htmlText(body.benefits || "")),
            }
          : undefined,
    };
  }

  // https://jobs.smartrecruiters.com/oneclick-ui/company/<company>/publication/<uuid>
  // (its apply form, built by script) or /<company>/<id>-<slug>: the public
  // posting API takes either id (LLNL and Syngenta, 2026-11-02: the posting
  // could not be read from the apply form).
  if (host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") {
    const oneClick = parts[0] === "oneclick-ui" && parts[1] === "company" && parts[3] === "publication";
    const company = oneClick ? parts[2] : parts[0];
    const id = oneClick ? parts[4] : parts[1]?.match(/^(\d+)(?:-|$)/)?.[1];
    if (!/^[\w.-]+$/.test(company || "") || !(/^[0-9a-f-]{36}$/i.test(id || "") || /^\d+$/.test(id || ""))) return;
    return {
      source: "SmartRecruiters",
      api: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company!)}/postings/${id}`,
      read: (body) => {
        const sections = body?.jobAd?.sections || {};
        return body?.name
          ? {
              source: "SmartRecruiters",
              title: body.name,
              company: body.company?.name || company,
              location: body.location?.fullLocation || [body.location?.city, body.location?.region].filter(Boolean).join(", ") || undefined,
              description: join(
                ...["companyDescription", "jobDescription", "qualifications", "additionalInformation"].map((key) =>
                  sections[key]?.text ? [sections[key].title, htmlText(sections[key].text)].filter(Boolean).join("\n") : undefined,
                ),
              ),
            }
          : undefined;
      },
    };
  }

  const lever = host.match(/^jobs(\.eu)?\.lever\.co$/);
  if (lever) {
    const [company, id] = parts;
    if (!/^[\w.-]+$/.test(company || "") || !/^[0-9a-f-]{36}$/i.test(id || "")) return;
    return {
      source: "Lever",
      api: `https://api${lever[1] || ""}.lever.co/v0/postings/${company}/${id}`,
      read: (body) =>
        body?.text
          ? {
              source: "Lever",
              title: body.text,
              company,
              location: body.categories?.location,
              description: join(
                body.descriptionPlain,
                ...(Array.isArray(body.lists)
                  ? body.lists.map((list: { text?: string; content?: string }) =>
                      [list.text, htmlText(list.content || "")].filter(Boolean).join("\n"),
                    )
                  : []),
                body.additionalPlain,
              ),
            }
          : undefined,
    };
  }

  if (host === "jobs.ashbyhq.com") {
    const [org, id] = parts;
    if (!/^[\w.%-]+$/.test(org || "") || !/^[0-9a-f-]{36}$/i.test(id || "")) return;
    return {
      source: "Ashby",
      api: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`,
      read: (body) => {
        const job = (Array.isArray(body?.jobs) ? body.jobs : []).find(
          (candidate: { id?: string }) => candidate.id === id,
        );
        return job?.title
          ? {
              source: "Ashby",
              title: job.title,
              company: org,
              location: job.location,
              description: job.descriptionPlain || htmlText(job.descriptionHtml || ""),
            }
          : undefined;
      },
    };
  }

  // https://intel.wd1.myworkdayjobs.com/en-US/External/job/<location>/<slug>_JR0286834/apply
  const workday = host.match(/^([\w-]+)\.wd\d+\.myworkdayjobs\.com$/);
  if (workday) {
    const at = parts.indexOf("job");
    const site = parts[at - 1];
    const rest = parts.slice(at + 1);
    const end = rest.findIndex((part) => /^apply$/i.test(part));
    const segments = end >= 0 ? rest.slice(0, end) : rest;
    // A location holding a slash ("St.-Petersburg/Tampa, FL") is refused by
    // the API as an encoded slash (400); the job's own slug alone finds it
    // (Jabil, report b4fef18b, 2026-10-14).
    const path = (segments.some((part) => part.includes("/")) ? segments.slice(-1) : segments).map(encodeURIComponent).join("/");
    if (at < 1 || !site || /^[a-z]{2}-[A-Z]{2}$/.test(site) || !path) return;
    return {
      source: "Workday",
      api: `https://${host}/wday/cxs/${workday[1]}/${encodeURIComponent(site)}/job/${path}`,
      read: (body) => {
        const info = body?.jobPostingInfo;
        return info?.title
          ? {
              source: "Workday",
              title: info.title,
              // "100 Intel Corporation": Workday prefixes a company code.
              company: body.hiringOrganization?.name?.replace(/^\d+\s+/, "") || undefined,
              location: info.location,
              description: htmlText(info.jobDescription || ""),
            }
          : undefined;
      },
    };
  }

  // https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26011784/apply/section/2
  if (/\.oraclecloud\.com$/.test(host)) {
    const sites = parts.indexOf("sites");
    const site = parts[sites + 1];
    const id = parts[sites + 2] === "job" ? parts[sites + 3] : undefined;
    if (sites < 0 || !/^[\w-]+$/.test(site || "") || !/^\d+$/.test(id || "")) return;
    return {
      source: "Oracle",
      api: `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${id}%22,siteNumber=${site}`,
      read: (body) => {
        const item = Array.isArray(body?.items) ? body.items[0] : undefined;
        return item?.Title
          ? {
              source: "Oracle",
              title: item.Title,
              location: item.PrimaryLocation,
              description: join(
                htmlText(item.ExternalDescriptionStr || ""),
                htmlText(item.ExternalResponsibilitiesStr || ""),
                htmlText(item.ExternalQualificationsStr || ""),
              ),
            }
          : undefined;
      },
    };
  }
}

// The posting for the first URL that has one, or undefined. A failed or
// unrecognised fetch is not an error: the page's own text is used instead.
export async function fetchPosting(
  urls: string[],
  options: { fetch?: Fetch; signal?: AbortSignal } = {},
): Promise<Posting | undefined> {
  const fetcher = options.fetch || fetch;
  for (const url of urls) {
    const endpoint = postingEndpoint(url);
    if (!endpoint) continue;
    // A slow or dropped answer is asked once more: Workable's took over a
    // minute at times, and Waggoner Financial's internship was then taken
    // for a posting that could not be read (2026-10-31).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetcher(endpoint.api, {
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.any([
            ...(options.signal ? [options.signal] : []),
            AbortSignal.timeout(15_000),
          ]),
        });
        if (!response.ok) break;
        const posting = endpoint.read(await response.json());
        if (posting && posting.description.length >= 100)
          return {
            ...posting,
            title: posting.title.slice(0, 300),
            description: posting.description.slice(0, 25_000),
          };
        break;
      } catch {
        if (options.signal?.aborted) return;
        /* Asked once more, then the next URL, then the page's text. */
      }
    }
  }
}

// A posting page the applicant linked that no ATS endpoint above covers (a
// company's own careers site). Many embed the posting as schema.org
// JobPosting data, which names the title, company and description; others
// are read as text. Only https pages on public hosts, at most three
// redirects, each checked.
const privateHost = /^(localhost|.*\.local|.*\.internal|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?(::1|f[cd][0-9a-f]{2}:|fe80:))/i;
export function publicPostingURL(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== "https:" || privateHost.test(url.hostname)) return;
  return url;
}

type JobPosting = { "@type"?: unknown; title?: unknown; name?: unknown; description?: unknown; hiringOrganization?: { name?: unknown } | unknown; jobLocation?: unknown };
function jobPostings(value: unknown): JobPosting[] {
  if (Array.isArray(value)) return value.flatMap(jobPostings);
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  const type = item["@type"];
  const own = (Array.isArray(type) ? type : [type]).some((t) => t === "JobPosting") ? [item as JobPosting] : [];
  return [...own, ...jobPostings(item["@graph"])];
}
// A JobPosting's places ("Toronto, ON, CA; Austin, TX, US"), from its
// schema.org addresses.
function jobLocation(value: unknown): string | undefined {
  const places = (Array.isArray(value) ? value : [value]).flatMap((place) => {
    const address = (place as { address?: unknown } | undefined)?.address as Record<string, unknown> | string | undefined;
    if (typeof address === "string") return [address];
    if (!address || typeof address !== "object") return [];
    const country = address.addressCountry as unknown;
    const countryName = typeof country === "string" ? country : typeof (country as { name?: unknown })?.name === "string" ? String((country as { name: string }).name) : "";
    const parts = [address.addressLocality, address.addressRegion, countryName].filter((part) => typeof part === "string" && part.trim()) as string[];
    return parts.length ? [parts.join(", ")] : [];
  });
  return places.length ? places.join("; ").slice(0, 300) : undefined;
}
const decodeText = (text: string) => htmlText(text.replace(/&quot;/g, '"'));

export function postingFromPage(html: string): Omit<Posting, "source"> | undefined {
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    const job = jobPostings(data).find((candidate) => typeof candidate.description === "string");
    if (!job) continue;
    const organization = job.hiringOrganization as { name?: unknown } | undefined;
    const description = decodeText(String(job.description));
    if (description.length < 100) continue;
    return {
      title: String(job.title || job.name || "").trim(),
      company: typeof organization?.name === "string" ? organization.name : undefined,
      location: jobLocation(job.jobLocation),
      description,
    };
  }
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const text = htmlText(body.replace(/<(nav|header|footer|form|noscript|svg)\b[\s\S]*?<\/\1>/gi, ""));
  // A page built by script has no posting in its HTML: paste it instead.
  if (text.length < 400) return;
  const title = decode(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1] || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").trim();
  return { title, description: text };
}

export async function fetchPostingPage(
  raw: string,
  options: { fetch?: Fetch; signal?: AbortSignal } = {},
): Promise<Posting | undefined> {
  const fetcher = options.fetch || fetch;
  let url = publicPostingURL(raw);
  for (let hop = 0; url && hop < 4; hop++) {
    const response = await fetcher(url.href, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
      signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15_000)]),
    }).catch(() => undefined);
    if (!response) return;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      url = location ? publicPostingURL(new URL(location, url).href) : undefined;
      continue;
    }
    if (!response.ok || !/html|xml/i.test(response.headers.get("content-type") || "text/html")) return;
    const html = (await response.text()).slice(0, 3_000_000);
    const posting = postingFromPage(html);
    return posting && { ...posting, title: posting.title.slice(0, 300), description: posting.description.slice(0, 25_000), source: "Posting page" };
  }
}
