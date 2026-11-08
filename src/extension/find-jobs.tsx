import React, { useEffect, useState } from "react";
import type { QueueState } from "../shared/model";

async function command<T = any>(message: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok)
    throw new Error(
      response?.error || "Extension background worker is unavailable.",
    );
  return response.data;
}
const api = <T = any,>(path: string, method = "GET", body?: unknown) =>
  command<T>({ type: "API", path, method, ...(body === undefined ? {} : { body }) });

// As the backend keeps them (src/server/job-search.ts).
type Settings = {
  roles: string[];
  locations: string[];
  remote: boolean;
  country: string;
  skipSenior: boolean;
  fromProfile: boolean;
  sources: { newGrad: boolean; internships: boolean; boards: boolean };
  companies: string[];
  postedWithinDays: number;
  limit: number;
};
type Listing = {
  id: string;
  title: string;
  company: string;
  locations: string[];
  url: string;
  postedAt?: number;
  source: string;
  category?: string;
  matched: string[];
  tracked?: boolean;
  // Where it is applied and whether a site rule covers it (site-check.ts).
  site?: { ats?: string; by: string; via?: string };
  // What its form will ask and how much a fill answers (form-preview.ts).
  preview?: {
    gaps?: string[];
    history?: {
      site?: { name: string; applications: number; leftSome: number; common: { label: string; count: number }[] };
      company?: { applications: number; left: string[] };
    };
    questions?: { total: number; profile: number; ai: number; you: string[]; optional: number };
  };
};
type Result = {
  at: number;
  roles: string[];
  locations: string[];
  country: string;
  listings: Listing[];
  sources: { id: string; count: number; error?: string }[];
};

const lines = (text: string) => text.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
const posted = (at?: number) => {
  if (!at) return "";
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days < 1 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
};

// Finding jobs to apply for (2026-10-30): what to look for, from the
// applicant and, if they like, their profile; where (SimplifyJobs' lists and
// companies' own Greenhouse, Lever and Ashby boards); and the openings found,
// each tracked in one click. The command line has the same (lane search).
export function FindJobs({ onState }: { onState: (state: QueueState) => void }) {
  const [settings, setSettings] = useState<Settings>();
  const [suggested, setSuggested] = useState<{ roles: string[]; locations: string[] }>({ roles: [], locations: [] });
  const [result, setResult] = useState<Result | null>(null);
  const [roles, setRoles] = useState("");
  const [places, setPlaces] = useState("");
  const [companies, setCompanies] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    void api<{ settings: Settings; suggested: { roles: string[]; locations: string[] } }>("/v1/search/settings")
      .then((loaded) => {
        setSettings(loaded.settings);
        setSuggested(loaded.suggested);
        setRoles(loaded.settings.roles.join("\n"));
        setPlaces(loaded.settings.locations.join("\n"));
        setCompanies(loaded.settings.companies.join("\n"));
      })
      .catch((failure) => setError((failure as Error).message));
    void api<Result | null>("/v1/search").then(setResult).catch(() => {});
  }, []);
  if (!settings) return <section className="card">{error ? <p className="error">{error}</p> : <p className="help">Loading…</p>}</section>;
  const current = (): Settings => ({ ...settings, roles: lines(roles), locations: lines(places), companies: lines(companies) });
  const work = async (job: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await job();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const search = () =>
    work(async () => {
      const saved = await api<{ settings: Settings }>("/v1/search/settings", "PUT", current());
      setSettings(saved.settings);
      setResult(await api<Result>("/v1/search", "POST", {}));
    });
  const track = (listing: Listing) =>
    work(async () => {
      // Site access first, from this click: Chrome allows it no other way.
      const origin = `${new URL(listing.url).origin}/*`;
      if (!(await chrome.permissions.request({ origins: [origin] })))
        throw new Error("Site access was not granted, so it was not tracked.");
      onState(await command<QueueState>({ type: "TRACK_ITEMS", items: [{ url: listing.url }] }));
      setResult((shown) => shown && { ...shown, listings: shown.listings.map((item) => (item.id === listing.id ? { ...item, tracked: true } : item)) });
      setNotice(`Tracking ${listing.company} — ${listing.title}. It opened in a background tab.`);
    });
  const toggle = (key: keyof Settings["sources"]) => setSettings({ ...settings, sources: { ...settings.sources, [key]: !settings.sources[key] } });
  return (
    <>
      <section className="card" aria-label="What to look for">
        <div className="section-title">
          <h2>Find jobs</h2>
        </div>
        <p className="help">
          Openings from SimplifyJobs' lists and from the job boards of companies you name. Nothing is
          applied to: a job you track opens in a tab, and filling starts only when you ask.
        </p>
        <div className="form-grid">
          <label>
            Roles, one per line
            <textarea rows={4} value={roles} onChange={(event) => setRoles(event.target.value)} placeholder="software engineer&#10;machine learning" />
          </label>
          <label>
            Places, one per line (empty: anywhere)
            <textarea rows={4} value={places} onChange={(event) => setPlaces(event.target.value)} placeholder="e.g. Toronto or Remote" />
          </label>
        </div>
        <label className="check-line">
          <input type="checkbox" checked={settings.fromProfile} onChange={() => setSettings({ ...settings, fromProfile: !settings.fromProfile })} />
          Also look for what my profile suggests
          {settings.fromProfile && suggested.roles.length > 0 && (
            <small> ({suggested.roles.join(", ")}{suggested.locations.length ? `; near ${suggested.locations.join(", ")}` : ""})</small>
          )}
        </label>
        <label className="check-line">
          <input type="checkbox" checked={settings.remote} onChange={() => setSettings({ ...settings, remote: !settings.remote })} />
          Include remote openings
        </label>
        <label className="check-line">
          <input type="checkbox" checked={settings.skipSenior} onChange={() => setSettings({ ...settings, skipSenior: !settings.skipSenior })} />
          Leave out senior, staff, lead and manager roles
        </label>
        <div className="form-grid">
          <label>
            Country (empty: my profile's)
            <input value={settings.country} onChange={(event) => setSettings({ ...settings, country: event.target.value })} placeholder="e.g. Canada" />
          </label>
          <label>
            Posted within (days)
            <input type="number" min={1} max={365} value={settings.postedWithinDays} onChange={(event) => setSettings({ ...settings, postedWithinDays: Math.max(1, Math.min(365, Number(event.target.value) || 30)) })} />
          </label>
        </div>
        <fieldset>
          <legend>Where to look</legend>
          <label className="check-line"><input type="checkbox" checked={settings.sources.newGrad} onChange={() => toggle("newGrad")} /> SimplifyJobs new-grad list</label>
          <label className="check-line"><input type="checkbox" checked={settings.sources.internships} onChange={() => toggle("internships")} /> SimplifyJobs internship list</label>
          <label className="check-line"><input type="checkbox" checked={settings.sources.boards} onChange={() => toggle("boards")} /> These companies' job boards</label>
          <label>
            Companies (Greenhouse, Lever or Ashby board links, one per line)
            <textarea rows={3} value={companies} onChange={(event) => setCompanies(event.target.value)} placeholder="https://jobs.ashbyhq.com/notion&#10;https://boards.greenhouse.io/anthropic" />
          </label>
        </fieldset>
        <div className="row">
          <button className="primary" type="button" disabled={busy} onClick={() => void search()}>
            {busy ? "Searching…" : "Search"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {notice && <p className="help">{notice}</p>}
      </section>
      {result && (
        <section className="card" aria-label="Openings found">
          <div className="section-title">
            <h2>{result.listings.length} openings</h2>
            <small>{posted(result.at) === "today" ? "searched today" : `searched ${posted(result.at)}`}</small>
          </div>
          <p className="help">
            {result.sources.map((source) => `${source.id}: ${source.error ? source.error : `${source.count} open`}`).join(" · ")}
          </p>
          {result.listings.map((listing) => (
            <div className="history-row" key={listing.id}>
              <span>
                <strong>{listing.company} — {listing.title}</strong>
                <small>
                  {listing.locations.slice(0, 3).join("; ")}
                  {listing.postedAt ? ` · posted ${posted(listing.postedAt)}` : ""} · {listing.source} · for {listing.matched.join(" in ")}
                </small>
                {listing.site && (
                  listing.site.ats ? (
                    <small title={listing.site.via ? `Applied on ${listing.site.via}` : undefined}>Applies on {listing.site.ats}</small>
                  ) : (
                    <small className="warning-text" title="No site rule covers where this opening is applied, so only the general fill runs there.">No site rule for this site</small>
                  )
                )}
                {listing.preview?.questions && (
                  <small title="Read from the site before applying and answered offline with the profile rules a fill uses. A fill can still answer some of the rest through the site's own rule or AI review.">
                    {listing.preview.questions.total} questions: {listing.preview.questions.profile} from your profile
                    {listing.preview.questions.ai ? `, ${listing.preview.questions.ai} written by AI` : ""}
                    {listing.preview.questions.you.length ? `, ${listing.preview.questions.you.length} may be left to you` : ", none left to you"}
                  </small>
                )}
                {!!listing.preview?.questions?.you.length && (
                  <details>
                    <summary><small>May be left to you</small></summary>
                    <ul>{listing.preview.questions.you.map((label) => <li key={label}><small>{label}</small></li>)}</ul>
                  </details>
                )}
                {listing.preview?.gaps?.map((gap) => <small key={gap} className="warning-text">{gap}</small>)}
                {listing.preview?.history?.company && listing.preview.history.company.left.length > 0 && (
                  <small title="From your earlier applications at this company.">
                    Earlier here, left to you: {listing.preview.history.company.left.slice(0, 3).join("; ")}
                  </small>
                )}
                {listing.preview?.history?.site && listing.preview.history.site.leftSome > 0 && (
                  <small title="From your earlier fills on this site.">
                    {listing.preview.history.site.leftSome} of {listing.preview.history.site.applications} past fills on {listing.preview.history.site.name} left something to you
                    {listing.preview.history.site.common.length ? `, most often ${listing.preview.history.site.common.map((entry) => `“${entry.label}” (${entry.count})`).join(", ")}` : ""}
                  </small>
                )}
              </span>
              <div className="row">
                <a className="text-button" href={listing.url} target="_blank" rel="noreferrer">Open</a>
                {listing.tracked ? (
                  <span className="tag">Tracked</span>
                ) : (
                  <button className="secondary" type="button" disabled={busy} onClick={() => void track(listing)}>Track</button>
                )}
              </div>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
