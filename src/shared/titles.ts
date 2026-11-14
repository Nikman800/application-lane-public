// A title that names no job: none, the site's address, or a page every
// application of the site shares (its sign-in, profile or home page).
export function genericTitle(title: string, url: string): boolean {
  const text = title.replace(/\s+/g, " ").trim();
  let host = "";
  try { host = new URL(url).hostname; } catch {}
  return !text || text === host || /^https?:\/\//i.test(text) ||
    /^(candidate profile|my profile|profile|candidate home|my (applications?|account|dashboard)|sign ?in|log ?in|sign ?up|create (an )?account|your session (has expired|is about to time out|timed out)\.?|session (expired|timeout)|career opportunities|careers?|find a job|job search|search jobs|jobs|apply|application|job application|welcome)\b.{0,60}$/i.test(text) ||
    /\bhomepage/i.test(text);
}

// Whether an address is one job's own page rather than a list or a search:
// the page an application was opened from is read as its posting only when it
// is. A job's page names the job (a "job", "position" or "opening" segment
// followed by its slug and number, or a number or id of its own); a list of
// jobs (GitHub's, a search, a company's openings) does not.
export function singlePostingUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  if (/(^|\.)(github\.com|githubusercontent\.com|simplify\.jobs|reddit\.com|google\.com)$/.test(url.hostname)) return false;
  const parts = url.pathname.split("/").filter(Boolean);
  const at = parts.findIndex((part) => /^(jobs?|positions?|postings?|openings?|opportunit(y|ies)|requisitions?|vacanc(y|ies)|careers?)$/i.test(part));
  if (at < 0 || at === parts.length - 1) return false;
  const after = parts.slice(at + 1);
  // Its number or id ("1449510400", an uuid, "R-101337"), or a slug of
  // several words ("Bethpage-Intern-Operations-Data-Analyst-NY").
  return after.some((part) => /^\d{5,}$/.test(part) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(part) || /\d{4,}/.test(part) || (part.match(/[A-Za-z]+/g) || []).length >= 4 && /[-_+]/.test(part));
}
