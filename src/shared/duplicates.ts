import { activeStatuses, type Application } from "./model";
import { canonicalURL, sameOpening } from "./matching";

// What the page badge warns of beyond the fill's own state: two
// copies of one application worked at once clash, and one already submitted
// must not be sent again.
export type ApplicationWarning = {
  kind: "being-fixed" | "copy-submitted" | "copy-open";
  title: string;
  detail: string;
};

type Link = { url: string; sourceUrl?: string; postingUrl?: string };
type Candidate = Link & Pick<Application, "id" | "title" | "status" | "workflowStage" | "tabId">;

const addresses = (app: Link) => [app.url, app.sourceUrl, app.postingUrl].filter((link): link is string => Boolean(link));

// A page that stands for one job: not a site's front page or a bare address.
const specific = (link: string) => {
  try {
    return new URL(canonicalURL(link)).pathname.replace(/\/+$/, "").length > 1;
  } catch {
    return false;
  }
};

// An address without the parts that only say where the visitor came from.
const tracking = /^(utm_\w+|source|src|ref|referrer|gh_src|lever-source|fbclid|gclid|ats)$/i;
function withoutTracking(link: string): string | undefined {
  try {
    const url = new URL(link);
    for (const key of [...url.searchParams.keys()]) if (tracking.test(key)) url.searchParams.delete(key);
    url.hash = "";
    return canonicalURL(url.href);
  } catch {
    return;
  }
}

// Whether two applications are for one opening: any address of one is the
// same page, or the same Workday requisition, as any address of the other.
export function sameJob(a: Link, b: Link): boolean {
  for (const left of addresses(a))
    for (const right of addresses(b)) {
      if (!specific(left) || !specific(right)) continue;
      if (sameOpening(left, right)) return true;
      const clean = withoutTracking(left);
      if (clean !== undefined && clean === withoutTracking(right)) return true;
    }
  return false;
}

export function applicationWarning(
  app: Candidate,
  all: Candidate[],
  repair?: "needs-fixing" | "being-fixed" | "released",
): ApplicationWarning | undefined {
  if (repair === "needs-fixing" || repair === "being-fixed")
    return {
      kind: "being-fixed",
      title: "Being fixed",
      detail: "The fixer has this application. Leave it alone until it is released.",
    };
  // A submitted application says so itself (badgeInfo); the rest are about
  // another record of the same job.
  if (app.workflowStage === "submitted") return;
  const copies = all.filter(
    (other) => other.id !== app.id && other.status !== "cancelled" && other.workflowStage !== "abandoned" && sameJob(app, other),
  );
  const submitted = copies.find((other) => other.workflowStage === "submitted");
  if (submitted)
    return {
      kind: "copy-submitted",
      title: "Already submitted",
      detail: "Another copy of this job was submitted. Applying again can create a duplicate.",
    };
  const open = copies.find(
    (other) => other.tabId !== undefined && (activeStatuses.includes(other.status) || other.status === "queued" || other.workflowStage === "applying" || other.workflowStage === "review"),
  );
  if (open)
    return {
      kind: "copy-open",
      title: "Open in another tab",
      detail: "Another copy of this job is open. Working on both can clash.",
    };
}
