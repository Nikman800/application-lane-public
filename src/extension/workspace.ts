import type { Application, QueueState, RelatedTab } from "../shared/model";

// Hosted job boards put the employer in the path, not the host.
const sharedBoardHosts = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com)$/;
const genericCompany = /^(job-boards|boards|jobs|apply|careers|www|application)$/i;
const titleCase = (slug: string) =>
  slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
export const companyFor = (url: string, title = "") => {
  const { hostname, pathname, searchParams } = new URL(url);
  const board = sharedBoardHosts.test(hostname);
  // Greenhouse's embedded form names its board in "for", not its path:
  // ".../embed/job_app?for=databricks" was filed as "Embed".
  const embedded = board && /^\/embed\//.test(pathname) ? searchParams.get("for") : "";
  if (embedded) return titleCase(embedded).slice(0, 300);
  const fromTitle =
    (board || /^job application for /i.test(title)) &&
    title.match(/\bat ([^|–—]+?)\s*$/)?.[1]?.trim();
  if (fromTitle) return fromTitle.slice(0, 300);
  const slug = pathname.split("/").filter(Boolean)[0];
  if (board && slug) return titleCase(slug);
  // Paylocity serves every employer from recruiting.paylocity.com and titles
  // its pages "<Employer> - <Job title>": two applications were filed as
  // "recruiting".
  if (/(^|\.)paylocity\.com$/.test(hostname)) return title.match(/^(.+?)\s+-\s+\S/)?.[1]?.trim().slice(0, 300) || "Application";
  // careers.acme.com and jobs.acme.com name the employer in the next label.
  const labels = hostname.split(".").slice(0, -1);
  return labels.find((label) => !genericCompany.test(label)) || "Application";
};

export const tabRole = (url: string, title: string, fieldCount: number) =>
  fieldCount > 0
    ? ("form" as const)
    : /login|sign[ -]?in|account|candidate home/i.test(`${url} ${title}`)
      ? ("login" as const)
      : ("posting" as const);

export function relatedTab(
  tab: { id?: number; url?: string; pendingUrl?: string; title?: string },
  fieldCount = 0,
  now = Date.now(),
  id: () => string = () => crypto.randomUUID(),
): RelatedTab {
  const url = tab.url || tab.pendingUrl || "";
  return {
    id: id(),
    tabId: tab.id,
    url,
    title: tab.title || (url ? new URL(url).hostname : "Application"),
    role: tabRole(url, tab.title || "", fieldCount),
    fieldCount,
    state: fieldCount ? "form" : "no-form",
    lastSeenAt: now,
  };
}

export function migrateQueue(
  raw: QueueState,
  now = Date.now(),
  id: () => string = () => crypto.randomUUID(),
): QueueState {
  return {
    schemaVersion: 2,
    settings: raw.settings || { concurrency: 4, generationConcurrency: 2 },
    applications: (raw.applications || []).map((app) => {
      const legacy = app as Application & { sourceUrl?: string };
      const tabs = Array.isArray(legacy.tabs)
        ? legacy.tabs
        : legacy.tabId
          ? [
              relatedTab(
                { id: legacy.tabId, url: legacy.url, title: legacy.title },
                0,
                now,
                id,
              ),
            ]
          : [];
      return {
        ...legacy,
        sourceUrl: legacy.sourceUrl || legacy.url,
        company:
          legacy.company && !genericCompany.test(legacy.company)
            ? legacy.company
            : companyFor(legacy.url, legacy.tabs?.[0]?.title || legacy.title),
        workflowStage:
          legacy.workflowStage ||
          (legacy.status === "cancelled"
            ? "abandoned"
            : legacy.status === "ready"
              ? "review"
              : "applying"),
        stageUpdatedAt: legacy.stageUpdatedAt || legacy.updatedAt || now,
        tabs,
        attempts: Array.isArray(legacy.attempts) ? legacy.attempts : [],
        issueCount: legacy.issueCount || 0,
        explicitFill: legacy.explicitFill ?? false,
        advance: undefined,
      };
    }),
  };
}

// Names of controls whose values must never leave the browser in a report.
export const secretName =
  /password|passcode|passwd|(?<![a-z])otp(?![a-z])|one.?time|verification.?code|csrf|xsrf|session|token|nonce|secret|api.?key/i;
const secretParam =
  /token|session|auth|code|key|sig|otp|nonce|ticket|jwt|sso|saml|secret|state|hash|csrf|xsrf|^t$/i;

// Emailed session links carry their credential in the URL; keep the path for
// debugging but drop token-like query values and any key=value fragment.
export function redactURL(url: string) {
  try {
    const parsed = new URL(url);
    for (const name of new Set(parsed.searchParams.keys()))
      if (secretParam.test(name)) parsed.searchParams.set(name, "[redacted]");
    if (parsed.hash.includes("=")) parsed.hash = "#[redacted]";
    return parsed.toString();
  } catch {
    return url;
  }
}

// Builds before locks version 2 saved locks created by failed fills and by
// sites reformatting values, which kept empty fields from ever filling. They
// cannot be told apart from real edits, so they are dropped once. Fields that
// have a value stay protected by that value.
export const LOCKS_VERSION = 2;
export function migrateLocks(
  locks: Record<string, string[]> | undefined,
  version: number | undefined,
): { locks: Record<string, string[]>; migrated: boolean } {
  if ((version || 1) < LOCKS_VERSION) return { locks: {}, migrated: true };
  return { locks: locks || {}, migrated: false };
}
