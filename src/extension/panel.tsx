import { answerChoices, canonicalAnswer, choiceLabels, leftReasons, type ChoiceField } from "../shared/answers";
import { DRAFT_ONLY_NOTE, draftOnlySite } from "../shared/matching";
import React, { useEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { profileEditorReducer, resumeFacts } from "./profile-state";
import { JobFitAssessment } from "./job-fit";
import { QuestionAnswers } from "./question-answers";
import { RecurringAnswers } from "./recurring-answers";
import { FindJobs } from "./find-jobs";
import { CareerEditor, LocaleEditor, SalaryEditor, WorkAuthorizationEditor } from "./profile-fields";
import { FieldFallback } from "./field-fallback";
import { DraftingSettings } from "./drafting-settings";
import { BrandMark } from "./brand";
import { FillLane } from "./fill-lane";
import { Momentum } from "./momentum";
import { ProgressBoard } from "./progress-board";
import { Appearance } from "./appearance";
import { isGoal, useStoredValue } from "./prefs";
import { ConnectCard, OnboardingChecklist } from "./onboarding";
import { computeProgress, DEFAULT_DAILY_GOAL } from "../shared/progress";
import {
  emptyProfile,
  type Application,
  type Artifact,
  type Profile,
  type QueueState,
  type TabContext,
  type IssueReport,
  type SubmissionRecord,
  type FixerOverview,
  type FixerResult,
  type IssueCategory,
  type Recording,
  type WorkflowStage,
  legalDetailChoices,
  legalDetailLabels,
  type LegalDetailKey,
} from "../shared/model";

// An education entry's own transcript (2026-11-08): uploaded to the
// transcripts folder, and its name kept on the entry, so a form asking for
// one degree's transcript gets that degree's (shared/transcripts.ts).
function TranscriptPicker({ value, onChange }: { value?: string; onChange: (name: string | undefined) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  async function choose(file: File | undefined) {
    if (!file) return;
    setProblem("");
    if (!/\.(pdf|docx)$/i.test(file.name)) return setProblem("A transcript must be a PDF or a Word (.docx) file.");
    if (file.size > 8 * 1024 * 1024) return setProblem("The transcript is larger than 8 MB.");
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      await command({ type: "API", path: "/v1/transcript", method: "PUT", body: { name: file.name, data: btoa(binary) } });
      onChange(file.name);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="transcript-picker">
      <label>
        Transcript for this school (optional)
        <input type="file" accept=".pdf,.docx" disabled={busy} onChange={(e) => void choose(e.target.files?.[0])} />
      </label>
      {value && (
        <small>
          {value}{" "}
          <button className="text-button muted" type="button" onClick={() => onChange(undefined)}>
            Remove
          </button>
        </small>
      )}
      {busy && <small>Saving…</small>}
      {problem && <small className="fill-blocker">{problem}</small>}
    </div>
  );
}

async function command<T = any>(message: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok)
    throw new Error(
      response?.error || "Extension background worker is unavailable.",
    );
  return response.data;
}
const api = <T,>(path: string, method = "GET", body?: unknown) =>
  command<T>({ type: "API", path, method, body });
import { codexEfforts, fixerAgents, type FixerAgent, type FixerSettings } from "../shared/fixer-settings";
import { devToolsBuild } from "../shared/dev-tools";
import { storeBuild } from "../shared/store-build";
import { describeBuild, extensionBuild, newerBuild, type BuildStamp } from "../shared/build";
const agentNames: Record<FixerAgent, string> = { claude: "Claude", claude2: "Claude (separate login)", codex: "Codex", endpoint: "OpenAI-compatible endpoint" };
// Suggestions only: any model name the agent's CLI takes is accepted.
// "default" is the Codex CLI's own configured model; an empty endpoint model
// is the backend's endpoint model.
const modelSuggestions: Record<"claude" | "codex" | "endpoint", string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["default"],
  endpoint: [],
};
// One bundle, two pages: the side panel (panel.html) is the applications
// being worked on; the profile, issue reports and settings are a full browser
// tab (dashboard.html), whose address names the page after a "#".
type Page = "queue" | "profile" | "jobs" | "submitted" | "fixer" | "issues" | "settings";
// The Fixer page is the owner's development tool, only in a build that has it.
const dashboardPages = (["profile", "jobs", "submitted", "fixer", "issues", "settings"] as const).filter((item) => item !== "fixer" || devToolsBuild);
// An application that went in, was given up on, or cannot go on: nothing in
// it needs the applicant, whatever its last fill left as its status.
const finished = (app: { workflowStage: string }) => ["submitted", "blocked", "abandoned"].includes(app.workflowStage);
const isDashboard = location.pathname.endsWith("/dashboard.html");
const dashboardPage = (): Page =>
  dashboardPages.find((item) => item === location.hash.slice(1)) || "profile";
async function openDashboard(page: Page = "profile") {
  const url = chrome.runtime.getURL("dashboard.html");
  const open = (await chrome.tabs.query({})).find((tab) => tab.url?.split("#")[0] === url);
  if (!open?.id) return void (await chrome.tabs.create({ url: `${url}#${page}` }));
  await chrome.tabs.update(open.id, { active: true, url: `${url}#${page}` });
  await chrome.windows.update(open.windowId, { focused: true });
}
// Examples only: nothing here is saved unless the applicant types it.
const legalDetailHints: Record<LegalDetailKey, string> = {
  criminal: "e.g. No convictions and no pending charges",
  clearance: "e.g. None; never held one",
  exportControl: "e.g. U.S. citizen (a U.S. person under ITAR and EAR)",
  agreements: "e.g. Not bound by any non-compete or non-solicitation agreement",
  terminations: "e.g. Never dismissed or asked to resign",
  government: "e.g. Never a government employee or public official",
  relatives: "e.g. No relatives at any company I apply to",
  screening: "e.g. Willing to complete a background check and drug screening",
  other: "Anything else an application may ask about your eligibility",
};
// What a fill is writing right now, and what it has worked on so far.
function FillProgress({ app }: { app: { progress?: { current?: string; answered: string[] } } }) {
  const progress = app.progress;
  if (!progress || (!progress.current && !progress.answered.length)) return null;
  return (
    <>
      {progress.current && (
        <p className="app-note" role="status">
          Answering: {progress.current}
        </p>
      )}
      {progress.answered.length > 0 && (
        <details className="attempt-history">
          <summary>Worked on so far ({progress.answered.length})</summary>
          <ol>
            {progress.answered.map((label, index) => (
              <li key={`${index}-${label}`}>{label}</li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}
// One legal or eligibility detail: a standard statement chosen from a list,
// the applicant's own sentence, or nothing (they answer that kind by hand).
// What is saved is always the sentence itself.
// An answer-bank choice, with text typed before choices existed kept visible.
function ChoiceSelect({ field, value, onChange }: { field: ChoiceField; value: string; onChange: (value: string) => void }) {
  const current = canonicalAnswer(field, value);
  return (
    <select value={current} onChange={(e) => onChange(e.target.value)}>
      <option value="">Leave for me to answer</option>
      {answerChoices[field].map((choice) => (
        <option key={choice} value={choice}>
          {choiceLabels[field]?.[choice] || choice}
        </option>
      ))}
      {current && !(answerChoices[field] as readonly string[]).includes(current) && (
        <option value={current}>{`${current} (unrecognized; choose an option)`}</option>
      )}
    </select>
  );
}
function LegalDetail({ topic, value, onChange }: { topic: LegalDetailKey; value: string; onChange: (value: string) => void }) {
  const choices = legalDetailChoices[topic];
  const [writing, setWriting] = useState(false);
  // A saved sentence that is none of the choices is the applicant's own.
  const own = writing || Boolean(value && !choices.includes(value)) || !choices.length;
  return (
    <label>
      {legalDetailLabels[topic]}
      {choices.length > 0 && (
        <select
          aria-label={legalDetailLabels[topic]}
          value={own ? "\__own__" : value}
          onChange={(e) => {
            const chosen = e.target.value;
            setWriting(chosen === "\__own__");
            onChange(chosen === "\__own__" ? (choices.includes(value) ? "" : value) : chosen);
          }}
        >
          <option value="">Leave for me to answer</option>
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
          <option value={"\__own__"}>Something else (write it)</option>
        </select>
      )}
      {own && (
        <input
          aria-label={`${legalDetailLabels[topic]}, in your own words`}
          maxLength={600}
          placeholder={legalDetailHints[topic]}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
// A fill that has finished its own part while the model is still suggesting
// values for the rest is not yet "Needs attention": more is about to be filled.
const suggesting = (app: { status: string; assisting?: boolean }) =>
  Boolean(app.assisting) && (app.status === "awaiting-user" || app.status === "ready");
const labels: Record<string, string> = {
  queued: "Queued",
  inspecting: "Reading form",
  preparing: "Tailoring",
  filling: "Filling",
  "awaiting-user": "Needs attention",
  paused: "Paused for you",
  ready: "Ready to review",
  failed: "Couldn’t complete",
  cancelled: "Cancelled",
};
const active = ["queued", "inspecting", "preparing", "filling"];
// The report fixer's outcome for a report (scripts/fixer.ts).
const fixerLabels: Record<string, string> = {
  queued: "Waiting for the fixer",
  working: "The fixer is working on it",
  fixed: "Fixed",
  "needs-live-check": "Fixed, needs a live check",
  "partly-fixed": "Partly fixed",
  "not-a-bug": "Not a bug",
  "could-not-fix": "The fixer could not fix it",
  failed: "The fixer failed",
};
// Each problem the note named, and what the fixer made of it.
const problemLabels: Record<string, string> = {
  fixed: "Fixed",
  "needs-live-check": "Fixed, check live",
  "not-a-bug": "Not a bug",
  "could-not-fix": "Not fixed",
  left: "Not reached",
};
function FixerProblems({ result }: { result: FixerResult }) {
  if (!result.problems?.length) return null;
  return (
    <ul className="fixer-problems">
      {result.problems.map((problem, index) => (
        <li key={index}>
          <strong>{problemLabels[problem.status]}</strong>: {problem.problem}
          {problem.summary ? ` (${problem.summary})` : ""}
        </li>
      ))}
    </ul>
  );
}
const matchesQuery = (app: Application, query: string) =>
  !query.trim() ||
  `${app.company} ${app.title} ${app.url}`
    .toLowerCase()
    .includes(query.trim().toLowerCase());
const hostname = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "Loading tab";
  }
};
// What an application still needs, split in two: problems only the
// applicant can resolve, listed openly wherever the application shows, and
// notes worth a look (optional questions left empty, protected fields).
const noteItem =
  /^(Optional unanswered:|Protected:|Verify any remaining steps|Additional unresolved fields|The job posting could not be read|Resume uploaded first)/;
const postingSource = (source: string) =>
  source === "Pasted"
    ? "the posting you pasted"
    : source === "Posting page"
      ? "the posting page you linked"
      : `the ${source} job posting`;
// The fill could not read the posting (the card says so): ask for it.
const postingMissing = (app: Application) =>
  app.fit?.needsPosting || app.missing.some((item) => /job posting could not be read/i.test(item));

// Where the applicant gives the posting the fill could not read. Defined
// here, not inside App, so a re-render keeps what was typed.
function PostingPrompt({
  app,
  onSave,
}: {
  app: Application;
  onSave: (app: Application, posting: { postingUrl: string; postingText: string }) => void;
}) {
  return (
    <form
      className="posting-prompt"
      aria-label="Add the job posting"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        onSave(app, {
          postingUrl: String(values.get("postingUrl") || ""),
          postingText: String(values.get("postingText") || ""),
        });
      }}
    >
      <strong>Add the job posting</strong>
      <label>
        Its link
        <input name="postingUrl" type="url" placeholder="https://…" defaultValue={app.postingUrl || ""} />
      </label>
      <details>
        <summary>Or paste its text</summary>
        <textarea name="postingText" rows={4} aria-label="Posting text" defaultValue={app.postingText || ""} />
      </details>
      <button className="secondary small" type="submit">Save posting</button>
    </form>
  );
}

// A question left for the applicant, marked as one the application needs or
// one it can go without; anything else reads as it is.
function IssueText({ item }: { item: string }) {
  const [, mark, question] = item.match(/^(Required|Optional unanswered): ([\s\S]*)$/) || [];
  if (!mark) return <>{item}</>;
  return (
    <>
      <span className={`question-mark ${mark === "Required" ? "required" : "optional"}`}>{mark === "Required" ? "Required" : "Optional"}</span>{" "}
      {question}
    </>
  );
}

function AppIssues({ app }: { app: Application }) {
  const { reasons, used } = leftReasons(app.missing);
  const problems = app.missing.filter((item) => !noteItem.test(item) && !used.has(item));
  const notes = app.missing.filter((item) => noteItem.test(item));
  return (
    <>
      {problems.length > 0 && (
        // Folded by default: a list of varying length above the buttons moved
        // Fill this step about as it grew (2026-11-04).
        <details className="app-problems" aria-label="Problems to resolve">
          <summary>
            <strong>
              {problems.length} {problems.length === 1 ? "problem needs" : "problems need"} you
            </strong>
          </summary>
          <ul>
            {problems.map((item, i) => (
              <li key={i}>
                <IssueText item={item} />
                {reasons.has(item) && <p className="app-note">Why it was not answered: {reasons.get(item)}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {notes.length > 0 && (
        <details className="app-notes">
          <summary>
            {notes.length} note{notes.length === 1 ? "" : "s"} to review
          </summary>
          <ul>
            {notes.map((item, i) => (
              <li key={i}>
                <IssueText item={item} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

// Where a "drafting is not set up" note leads: the dashboard's Settings.
function DraftingLink() {
  return (
    <button className="text-button" onClick={() => void (isDashboard ? (location.hash = "settings") : openDashboard("settings"))}>
      Open Settings → Drafting
    </button>
  );
}

function Icon({
  type,
}: {
  type: "arrow" | "plus" | "check" | "layers" | "pause" | "external";
}) {
  const paths = {
    arrow: "M4 12h15m-6-6 6 6-6 6",
    plus: "M12 5v14M5 12h14",
    check: "m5 12 4 4L19 6",
    layers: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
    pause: "M9 5v14M15 5v14",
    external: "M14 4h6v6m0-6L10 14M10 4H4v16h16v-6",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[type]} />
    </svg>
  );
}
function App() {
  const [page, showPage] = useState<Page>(isDashboard ? dashboardPage() : "queue");
  const setPage = (next: Page) => {
    if (!isDashboard) return void openDashboard(next);
    location.hash = next;
    showPage(next);
  };
  const [queue, setQueue] = useState<QueueState>({
    applications: [],
    settings: { concurrency: 4, generationConcurrency: 2 },
  });
  const [{ profile, imports }, dispatchProfile] = useReducer(
    profileEditorReducer,
    { profile: structuredClone(emptyProfile), imports: [] },
  );
  // Answers the extension profile and the job-applier files disagree on.
  const [conflicts, setConflicts] = useState<
    { field: string; extension: string; markdown: string; file: string }[]
  >([]);
  const setProfile = (update: Profile | ((profile: Profile) => Profile)) =>
    dispatchProfile({ type: "edit", update });
  const [connected, setConnected] = useState(false);
  // Whether any drafting provider is set (Settings → Drafting).
  const [draftingReady, setDraftingReady] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pairToken, setPairToken] = useState("");
  const [urls, setURLs] = useState("");
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [showTabs, setShowTabs] = useState(false);
  const [review, setReview] = useState<Application>();
  // Submitted, blocked and abandoned applications are kept under their own
  // choices and the Submitted page, not in the list of ones still to do.
  const [filter, setFilter] = useState("open");
  const [showArchived, setShowArchived] = useState(false);
  const [tabContext, setTabContext] = useState<TabContext>();
  const [scanError, setScanError] = useState("");
  const [attachChoice, setAttachChoice] = useState("");
  const [pickerQuery, setPickerQuery] = useState("");
  const [search, setSearch] = useState("");
  const [issueTarget, setIssueTarget] = useState<{ tabId: number; applicationId?: string }>();
  const [issueCategory, setIssueCategory] = useState<IssueCategory>("fill-failure");
  const [issueNote, setIssueNote] = useState("");
  const [issueConsent, setIssueConsent] = useState(false);
  const [issues, setIssues] = useState<Array<Omit<IssueReport, "frames">>>([]);
  const [submissions, setSubmissions] = useState<SubmissionRecord[] | undefined>();
  const [fixer, setFixer] = useState<FixerOverview | undefined>();
  // A build in dist/ newer than the one loaded: the extension needs a reload.
  const [waitingBuild, setWaitingBuild] = useState<BuildStamp | undefined>();
  // The fixer's agents and models as edited on its page, before saving.
  const [fixerSettings, setFixerSettings] = useState<FixerSettings | undefined>();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [activeRecordings, setActiveRecordings] = useState<
    { id: string; tabId: number; startedAt: number; eventCount: number }[]
  >([]);
  const [clock, setClock] = useState(Date.now());
  const [answerSuggestions, setAnswerSuggestions] = useState<
    { question: string; answer: string; replaces?: string; keep: boolean }[]
  >();
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteDocuments, setDeleteDocuments] = useState(false);
  const [dailyGoal] = useStoredValue<number>("dailyGoal", DEFAULT_DAILY_GOAL, isGoal);
  // The applicant as one file, for another installation: the profile, the
  // tailoring folder's files and this browser's settings. No pairing token,
  // API key or application history is in it.
  async function exportProfile() {
    const bundle = await api<Record<string, unknown>>("/v1/profile/bundle");
    saveBlob(
      `application-lane-profile-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify({ ...bundle, settings: queue.settings }, null, 2),
      "application/json",
    );
  }
  async function importProfile(file: File) {
    if (file.size > 12 * 1024 * 1024) throw new Error("That file is too large to be a profile export.");
    let bundle: unknown;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      throw new Error("That file is not a profile export.");
    }
    if ((bundle as { format?: string })?.format !== "application-lane-profile")
      throw new Error("That file is not a profile export.");
    const imported = await api<{ profile: Profile; tailoring: string[]; settings?: Partial<QueueState["settings"]> }>(
      "/v1/profile/bundle",
      "PUT",
      bundle,
    );
    setProfile(imported.profile);
    // This browser's own choices come with the profile; its concurrency stays.
    if (imported.settings)
      setQueue(
        await command({
          type: "SETTINGS",
          settings: { ...queue.settings, ...imported.settings, concurrency: queue.settings.concurrency, generationConcurrency: queue.settings.generationConcurrency },
        }),
      );
    return imported.tailoring.length;
  }
  async function loadBackend() {
    const [p, status, savedIssues, savedRecordings] = await Promise.all([
      api<Profile>("/v1/profile"),
      api<any>("/v1/status"),
      api<Array<Omit<IssueReport, "frames">>>("/v1/issues"),
      api<Recording[]>("/v1/recordings"),
    ]);
    setProfile(p);
    setWaitingBuild(newerBuild(extensionBuild, status?.extensionBuild));
    setDraftingReady(Boolean(status?.configured));
    setIssues(savedIssues);
    setRecordings(savedRecordings);
    setConnected(true);
  }
  // Single-page apps (Ashby, Workday) report a finished load before they
  // draw the form, so a scan that finds nothing looks again for a while
  // before "No form" stands. A new tab or navigation starts over.
  const rescan = useRef<number | undefined>(undefined);
  // Scans answer in their own time: only the newest one may set the card, or
  // a slow read of the tab just left would replace the tab now in front.
  const scanned = useRef(0);
  // The tab just brought to the front, named at once while its page is read:
  // a read takes seconds while a fill runs, and the card meanwhile showed
  // the tab left behind, its buttons acting on that application
  // (2026-11-07).
  const [switching, setSwitching] = useState<{ title: string; url: string } | undefined>();
  const scanActive = (attempt = 0) => {
    window.clearTimeout(rescan.current);
    const turn = ++scanned.current;
    return command<TabContext>({ type: "ACTIVE_TAB" })
      .then((value) => {
        if (turn !== scanned.current) return;
        setSwitching(undefined);
        setTabContext(value);
        setScanError("");
        if (!attempt) setAttachChoice(value.suggestions[0]?.applicationId || "");
        const found = value.fieldCount ?? value.observation?.fields.length ?? 0;
        if (value.accessible && value.observation && !found && attempt < 5)
          rescan.current = window.setTimeout(() => void scanActive(attempt + 1), 1500 * (attempt + 1));
      })
      .catch((error) => {
        if (turn !== scanned.current) return;
        setSwitching(undefined);
        // Keep the tab actions reachable; a failed scan must not hide them.
        setTabContext(undefined);
        setScanError((error as Error).message);
      });
  };
  useEffect(() => {
    void command<QueueState>({ type: "STATE" })
      .then(setQueue)
      .catch((e) => setError(e.message));
    void loadBackend().catch(() => setConnected(false));
    void scanActive();
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
    ) => {
      if (changes.queue) setQueue(changes.queue.newValue);
    };
    chrome.storage.onChanged.addListener(listener);
    const activated = (info: chrome.tabs.TabActiveInfo) => {
      void chrome.tabs.get(info.tabId).then((tab) => {
        setTabContext((shown) => {
          if (shown?.tabId === info.tabId) return shown;
          setSwitching({ title: tab.title || "This tab", url: tab.url || "" });
          return undefined;
        });
      }, () => {});
      void scanActive();
    };
    const updated = (_tabId: number, change: chrome.tabs.TabChangeInfo) => {
      if (change.status === "complete" || change.url) void scanActive();
    };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    const hashed = () => showPage(dashboardPage());
    // The profile is edited in the dashboard: the panel reads it again on
    // return. The dashboard does not, or it would drop unsaved edits.
    const returned = () => void loadBackend().catch(() => setConnected(false));
    if (isDashboard) window.addEventListener("hashchange", hashed);
    else window.addEventListener("focus", returned);
    return () => {
      window.removeEventListener("hashchange", hashed);
      window.removeEventListener("focus", returned);
      window.clearTimeout(rescan.current);
      chrome.storage.onChanged.removeListener(listener);
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(updated);
    };
  }, []);
  // The history of submissions, read again whenever one more goes in.
  const submittedNow = queue.applications.filter((app) => app.workflowStage === "submitted").length;
  useEffect(() => {
    if (!connected) return;
    // The history is written a moment after the list shows the stage: read
    // too soon, it lacks the newest one, so read it again until it has it.
    let timer: number | undefined;
    let tries = 0;
    const read = () =>
      void api<SubmissionRecord[]>("/v1/submissions").then((records) => {
        setSubmissions(records);
        if (records.length < submittedNow && ++tries < 10) timer = window.setTimeout(read, 1000);
      }, () => setSubmissions(undefined));
    read();
    return () => window.clearTimeout(timer);
  }, [connected, submittedNow, page]);
  // The fixer's work, read again every half minute while the page is open.
  useEffect(() => {
    if (page !== "fixer" || !devToolsBuild || !connected) return;
    const read = () => void api<FixerOverview>("/v1/fixer").then(setFixer, () => setFixer(undefined));
    read();
    void api<{ settings: FixerSettings }>("/v1/fixer/settings").then((result) => setFixerSettings(result.settings), () => setFixerSettings(undefined));
    const timer = setInterval(read, 30_000);
    return () => clearInterval(timer);
  }, [page, connected]);
  useEffect(() => {
    if (page !== "issues" || !connected) return;
    void Promise.all([
      api<Array<Omit<IssueReport, "frames">>>("/v1/issues").then(setIssues),
      api<Recording[]>("/v1/recordings").then(setRecordings),
    ]).catch(() => {});
  }, [page, connected]);
  useEffect(() => {
    if (page !== "profile" || !connected) return;
    // An older backend without the route simply shows nothing.
    void api<typeof conflicts>("/v1/profile/conflicts").then(setConflicts, () => setConflicts([]));
  }, [page, connected, profile?.revision]);
  const refreshRecordings = () =>
    command<typeof activeRecordings>({ type: "RECORDING_STATE" })
      .then(setActiveRecordings)
      .catch(() => {});
  useEffect(() => {
    void refreshRecordings();
  }, [tabContext?.tabId]);
  useEffect(() => {
    if (!activeRecordings.length) return;
    const timer = setInterval(() => {
      setClock(Date.now());
      void refreshRecordings();
    }, 1000);
    return () => clearInterval(timer);
  }, [activeRecordings.length]);
  // Submission can't be detected reliably on every site, so the applicant
  // marks it; the Stage menu changes it back.
  const markSubmitted = (id: string) =>
    void action(
      async () => setQueue(await command({ type: "SET_WORKFLOW", id, stage: "submitted", reason: "" })),
      "Marked submitted. Change the stage to undo.",
    );
  // Not applying after all: any fill stops, and the application leaves the
  // open list as Abandoned (the applicant, 2026-10-31).
  const abandon = (app: { id: string; title: string }) => {
    if (!window.confirm(`Abandon "${app.title}"? Any fill stops; what is on the page stays.`)) return;
    void action(
      async () => setQueue(await command({ type: "CANCEL_APP", id: app.id })),
      "Abandoned. Change the stage to undo.",
    );
  };
  async function action(work: () => Promise<unknown>, success?: string) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await work();
      if (success) setNotice(success);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const edit = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setProfile((p) => ({
      ...p,
      [key]: value,
      confirmed: key === "confirmed" ? (value as boolean) : false,
    }));
  const cleanLines = (values: string[]) =>
    values.map((value) => value.trim()).filter(Boolean);
  async function importResumes(files: File[]) {
    if (files.length > 10)
      throw new Error(
        "Select up to 10 resumes at a time. You can add more in another batch.",
      );
    dispatchProfile({ type: "start-import" });
    // Individual requests retain the existing 10 MB backend limit and avoid
    // holding a whole batch of base64-encoded resumes in memory.
    for (const file of files) {
      try {
        if (file.size > 10 * 1024 * 1024)
          throw new Error("Choose a file smaller than 10 MB.");
        const extension = file.name.toLowerCase().match(/\.(pdf|docx)$/)?.[1];
        if (!extension) throw new Error("Choose a PDF or DOCX resume.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const result = await api<{ text: string }>("/v1/import", "POST", {
          format: extension,
          data: btoa(binary),
        });
        dispatchProfile({
          type: "import",
          name: file.name,
          facts: resumeFacts(result.text),
        });
      } catch (error) {
        dispatchProfile({
          type: "import",
          name: file.name,
          facts: [],
          error: (error as Error).message,
        });
      }
    }
  }
  async function add(items: { url: string; tabId?: number }[]) {
    if (!items.length)
      throw new Error("Select application tabs or paste at least one URL.");
    const origins = [
      ...new Set(
        items.map((item) => {
          const u = new URL(item.url);
          if (!["https:", "http:"].includes(u.protocol))
            throw new Error("Only HTTP(S) application URLs are supported.");
          return `${u.origin}/*`;
        }),
      ),
    ];
    if (!(await chrome.permissions.request({ origins })))
      throw new Error("Site access was not granted.");
    setQueue(await command({ type: "TRACK_ITEMS", items }));
    setURLs("");
    setShowTabs(false);
    setSelected([]);
  }
  const saveBlob = (name: string, value: string, type: string) => {
    const url = URL.createObjectURL(new Blob([value], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  async function exportIssue(id: string) {
    const report = await api<IssueReport>(`/v1/issues/${id}`);
    saveBlob(
      `application-lane-issue-${id}.json`,
      JSON.stringify(report, null, 2),
      "application/json",
    );
  }
  async function copyIssue(id: string) {
    const report = await api<IssueReport>(`/v1/issues/${id}`);
    await navigator.clipboard.writeText(
      `## Application Lane issue\n\n- Category: ${report.category}\n- Page: ${report.tab.title}\n- URL: ${report.tab.url}\n- Captured: ${new Date(report.createdAt).toISOString()}\n- Status: ${report.application?.status || "untracked"}\n\n${report.note || "No note supplied."}`,
    );
  }
  // Tracking a tab needs access to its site (and to a form framed inside
  // it): asked first, inside the click, as Chrome grants it only to a user
  // gesture. Reading the page needs none (the panel's own click lets it), so
  // a page the card had scanned still failed with "Grant site access for…"
  // and no prompt. An origin already granted asks nothing.
  async function siteAccess(url: string | undefined, frames: string[] = []) {
    if (!url || !/^https?:/.test(url)) return;
    const origins = [...new Set([`${new URL(url).origin}/*`, ...frames])];
    if (!(await chrome.permissions.request({ origins })))
      throw new Error("Site access was not granted, so this tab cannot be tracked.");
  }
  async function access(app: Application) {
    if (!app.tabId) return;
    // Request inside the original click gesture; frame discovery happened
    // during inspection, so no asynchronous work precedes this permission call.
    const origins = app.accessOrigins?.length
      ? app.accessOrigins
      : [`${new URL(app.url).origin}/*`];
    if (origins.length && !(await chrome.permissions.request({ origins })))
      throw new Error("Embedded site access was not granted.");
    // The application's own tab is read again with the new access. The card
    // above stays on the tab in front, which may be a different one.
    await command<TabContext>({ type: "SCAN_TAB", tabId: app.tabId });
    await scanActive();
  }
  const savePosting = (app: Application, posting: { postingUrl: string; postingText: string }) =>
    void action(
      async () => setQueue(await command({ type: "UPDATE_APP", id: app.id, ...posting })),
      "Posting saved. Check fit or fill this step using the updated posting.",
    );
  const checkFit = (app: Application) =>
    void action(async () => setQueue(await command({ type: "CHECK_FIT", id: app.id })));
  async function documents(app: Application) {
    const job = await api<{ narrative: Application["narrative"] }>(
      `/v1/jobs/${app.documentJobId || app.jobId}`,
    );
    setReview({ ...app, narrative: job.narrative });
  }
  // A PDF opens in a tab to be read; saving is the separate, explicit action.
  // Other formats have no viewer in the browser and are always saved.
  async function download(artifact: Artifact, save = false) {
    const data = await api<Artifact & { data: string }>(
      `/v1/artifacts/${artifact.id}`,
    );
    const bytes = Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: data.mime }));
    if (!save && artifact.format === "pdf") {
      await chrome.tabs.create({ url });
      // The tab reads the document from this address for as long as it is open.
      setTimeout(() => URL.revokeObjectURL(url), 600000);
      return;
    }
    const link = document.createElement("a");
    link.href = url;
    link.download = data.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  // The drafted documents as files on this machine, for a site whose upload
  // the applicant does by hand: the path goes into its file chooser.
  const documentLabel = (artifact: Artifact) =>
    artifact.kind === "resume" ? "resume" : artifact.kind === "transcript" ? "transcript" : "cover letter";
  async function copyPath(app: Application, artifact: Artifact) {
    const saved = await api<{ files: { artifactId: string; path: string }[] }>(
      `/v1/jobs/${app.documentJobId || app.jobId}/files`,
    );
    const file = saved.files.find((candidate) => candidate.artifactId === artifact.id);
    if (!file) throw new Error("This document was not saved as a file. Draft it again.");
    await navigator.clipboard.writeText(file.path);
  }
  const uploadFiles = (app: Application) =>
    app.artifacts.length > 0 && (
      <div className="upload-files" role="group" aria-label="Files to upload yourself">
        <span>Upload yourself:</span>
        {app.artifacts.map((artifact) => (
          <button
            key={artifact.id}
            className="text-button"
            title="Copies where this file is saved. Paste it into the site’s file chooser."
            onClick={() =>
              void action(
                () => copyPath(app, artifact),
                "Path copied. Paste it into the site’s file chooser.",
              )
            }
          >
            Copy {documentLabel(artifact)}
            {app.artifacts.filter((other) => other.kind === artifact.kind).length > 1 ? ` ${artifact.format.toUpperCase()}` : ""} path
          </button>
        ))}
        <button
          className="text-button"
          onClick={() =>
            void action(() => api(`/v1/jobs/${app.documentJobId || app.jobId}/files/open`, "POST"))
          }
        >
          Open folder
        </button>
      </div>
    );
  const listed = queue.applications.filter(
    (a) =>
      (showArchived ? Boolean(a.archivedAt) : !a.archivedAt) &&
      matchesQuery(a, search) &&
      (filter === "all" ||
        (filter === "open" && !finished(a)) ||
        (filter === "active" && active.includes(a.status)) ||
        (filter === "attention" && !finished(a) &&
          ["paused", "awaiting-user", "failed"].includes(a.status)) ||
        (filter === "ready" && a.status === "ready") ||
        a.workflowStage === filter),
  );
  // An application AI is still filling is in progress, not waiting on you.
  const progressing = queue.applications.filter((a) =>
    active.includes(a.status) || suggesting(a),
  ).length;
  const ready = queue.applications.filter((a) => a.status === "ready" && !suggesting(a)).length;
  const attention = queue.applications.filter((a) =>
    !finished(a) && !suggesting(a) && ["paused", "awaiting-user", "failed"].includes(a.status),
  ).length;
  // From the history, which keeps removed applications too, and
  // never fewer than the list shows submitted now.
  const submittedCount = Math.max(submissions?.length ?? 0, submittedNow);
  const linkedApplication = queue.applications.find(
    (app) => app.id === tabContext?.applicationId,
  );
  const linkedFilling = Boolean(
    linkedApplication?.explicitFill &&
      active.includes(linkedApplication.status),
  );
  const recordingHere = activeRecordings.find(
    (recording) => recording.tabId === tabContext?.tabId,
  );
  // Streak, goal and level for the momentum card and the Progress board.
  const progress = computeProgress({ submissions, applications: queue.applications, goal: dailyGoal });
  const fillRunning = queue.applications.some((app) => active.includes(app.status) && app.status !== "queued");
  // The first-run checklist (onboarding.tsx), on the side panel and the dashboard.
  const onboardingSteps = [
    { label: "Connect the backend", done: connected, detail: "" },
    {
      label: "Choose how drafts are written",
      done: draftingReady,
      detail: "Pick Claude Code, Codex or an API for résumés, letters and answers. Filling works without one.",
      action: { label: "Open Settings → Drafting", run: () => setPage("settings") },
    },
    {
      label: "Import your résumé",
      done: profile.facts.length > 0 || profile.work.length > 0,
      detail: "Import a PDF or Word résumé to start your profile.",
      action: { label: "Import résumé", run: () => setPage("profile") },
    },
    {
      label: "Review and confirm your profile",
      done: profile.confirmed,
      detail: "Check each detail; only confirmed facts are used.",
      action: { label: "Review profile", run: () => setPage("profile") },
    },
    {
      label: "Track your first application",
      done: queue.applications.length > 0 || Boolean(submissions?.length),
      detail: "Open a job application in a tab and track it from the side panel, or paste links under Track application links.",
    },
  ];
  const fillPrerequisite = !connected
    ? "Connect the local backend before filling."
    : !profile.confirmed
      ? "Confirm your profile before filling."
      : "";
  return (
    <div className="shell">
      <header>
        <BrandMark running={fillRunning} />
        <div className="brand">
          application<span>lane</span>
        </div>
        {!isDashboard && (
          <button
            className="text-button expand"
            title="Your profile, issue reports and settings open in a browser tab"
            onClick={() => void openDashboard()}
          >
            Dashboard <Icon type="external" />
          </button>
        )}
      </header>
      {isDashboard && (
        <nav aria-label="Main navigation">
          {dashboardPages.map((item) => (
            <button
              key={item}
              className={page === item ? "selected" : ""}
              onClick={() => setPage(item)}
            >
              {item === "profile" ? "Your profile" : item === "jobs" ? "Find jobs" : item === "submitted" ? "Submitted" : item === "fixer" ? "Fixer" : item === "issues" ? "Issues" : "Settings"}
            </button>
          ))}
        </nav>
      )}
      <main>
        {error && (
          <div className="notice error" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {waitingBuild && (
          <div className="notice" role="status">
            A newer build is ready ({describeBuild(waitingBuild)}). Reload Application Lane at chrome://extensions
            to use it; this one is {extensionBuild ? describeBuild(extensionBuild) : "older"}.
          </div>
        )}
        {notice && (
          <div className="notice success" role="status">
            {notice}
          </div>
        )}
        {page === "queue" && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">APPLICATION WORKSPACE</div>
                <h1>Applications</h1>
              </div>
              <button className="icon-button" title="Scan current tab" aria-label="Scan current tab" onClick={() => void scanActive()}>
                <Icon type="check" />
              </button>
            </div>
            {!tabContext && switching && !scanError && (
              <section className="current-tab" aria-label="Current browser tab">
                <div className="section-title">
                  <div>
                    <span className="kicker">CURRENT TAB</span>
                    <h2>{switching.title}</h2>
                    <small>{switching.url ? hostname(switching.url) : ""}</small>
                  </div>
                  <span className="detect-badge">Reading…</span>
                </div>
                <p className="help">Reading this tab…</p>
              </section>
            )}
            {!tabContext && scanError && (
              <section className="current-tab" aria-label="Current browser tab">
                <span className="kicker">CURRENT TAB</span>
                <p className="fill-blocker">
                  Couldn’t read this tab: {scanError}
                </p>
                <div className="context-actions">
                  <button className="primary" disabled={busy} onClick={() => void action(scanActive)}>
                    Scan again
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
                        if (!tab?.id) throw new Error("Open a job or application tab first.");
                        await siteAccess(tab.url);
                        setQueue(await command({ type: "TRACK_TAB", tabId: tab.id }));
                        await scanActive();
                      })
                    }
                  >
                    Track as new
                  </button>
                </div>
              </section>
            )}
            {tabContext && (
              <section className="current-tab" aria-label="Current browser tab">
                <div className="section-title">
                  <div>
                    <span className="kicker">CURRENT TAB</span>
                    <h2>{tabContext.title}</h2>
                    <small>{tabContext.url ? hostname(tabContext.url) : ""}</small>
                  </div>
                  <span className={`detect-badge ${(tabContext.fieldCount ?? tabContext.observation?.fields.length) ? "found" : ""}`}>
                    {tabContext.observation
                      ? (tabContext.fieldCount ?? tabContext.observation.fields.length)
                        ? `${tabContext.fieldCount ?? tabContext.observation.fields.length} fields`
                        : "No form"
                      : "Not scanned"}
                  </span>
                </div>
                {tabContext.accessible && (
                  <div className="recording-row">
                    {recordingHere ? (
                      <>
                        <span className="recording-dot" aria-hidden="true" />
                        <span>
                          Recording · {recordingHere.eventCount} events ·{" "}
                          {Math.floor((clock - recordingHere.startedAt) / 60000)}:
                          {String(Math.floor(((clock - recordingHere.startedAt) / 1000) % 60)).padStart(2, "0")}
                        </span>
                        <button
                          className="secondary small"
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              const result = await command<{ recording: Recording; saved: boolean; saveError: string }>({
                                type: "STOP_RECORDING",
                                tabId: tabContext.tabId,
                              });
                              if (result.saved)
                                setRecordings((current) => [{ ...result.recording, events: undefined }, ...current]);
                              else
                                saveBlob(
                                  `application-lane-recording-${result.recording.id}.json`,
                                  JSON.stringify(result.recording, null, 2),
                                  "application/json",
                                );
                              await refreshRecordings();
                              setNotice(
                                result.saved
                                  ? `Recording saved with ${result.recording.eventCount} events. Find it under Issues.`
                                  : `Backend unavailable; recording downloaded instead. ${result.saveError}`,
                              );
                            })
                          }
                        >
                          Stop recording
                        </button>
                      </>
                    ) : (
                      <>
                      <button
                        className="text-button"
                        disabled={busy || !connected}
                        title="Save answers you typed or picked on this page, to fill the same questions next time"
                        onClick={() =>
                          void action(async () => {
                            const found = await command<{ question: string; answer: string; replaces?: string }[]>({
                              type: "SUGGEST_ANSWERS",
                              tabId: tabContext.tabId,
                            });
                            if (!found.length)
                              throw new Error(
                                "No new answers to save here. Answer a question on the page yourself, then try again.",
                              );
                            setAnswerSuggestions(found.map((item) => ({ ...item, keep: true })));
                          })
                        }
                      >
                        Save answers I entered
                      </button>
                      <button
                        className="text-button"
                        disabled={busy}
                        title="Record what happens on this page, for example while another autofill tool fills it"
                        onClick={() =>
                          void action(async () => {
                            setActiveRecordings(
                              await command({ type: "START_RECORDING", tabId: tabContext.tabId }),
                            );
                            setClock(Date.now());
                          })
                        }
                      >
                        Record page activity
                      </button>
                      </>
                    )}
                  </div>
                )}
                {!tabContext.accessible && tabContext.permissionOrigin ? (
                  <button
                    className="primary"
                    onClick={() =>
                      void action(async () => {
                        if (!(await chrome.permissions.request({ origins: [tabContext.permissionOrigin!] })))
                          throw new Error("Site access was not granted.");
                        await scanActive();
                      })
                    }
                  >
                    Grant access to scan
                  </button>
                ) : tabContext.applicationId ? (
                  <>
                  <p className="linked-application">
                    Part of{" "}
                    <strong>
                      {(() => {
                        const linked = queue.applications.find((app) => app.id === tabContext.applicationId);
                        return linked ? `${linked.company} — ${linked.title}` : "a tracked application";
                      })()}
                    </strong>
                    {queue.applications.find((app) => app.id === tabContext.applicationId)?.tabId !== tabContext.tabId &&
                      " · Filling here makes this the current fill tab."}
                  </p>
                  {tabContext.frameOrigins?.length ? (
                    <p className="app-posting">
                      The form is in an embedded frame from{" "}
                      {tabContext.frameOrigins.map((origin) => origin.replace(/^[a-z]+:\/\/(\*\.)?|\/\*$/gu, "")).join(", ")}.
                      Fill this step asks Chrome for access to it first.
                    </p>
                  ) : null}
                  {linkedApplication && (
                    <div className="current-status">
                      <span className={`status ${suggesting(linkedApplication) ? "filling" : linkedApplication.status}`}>
                        {suggesting(linkedApplication) ? "Still filling" : labels[linkedApplication.status]}
                      </span>
                      <small>
                        {linkedApplication.filled} field{linkedApplication.filled === 1 ? "" : "s"} filled
                      </small>
                      {(active.includes(linkedApplication.status) || suggesting(linkedApplication)) && <FillLane />}
                      <FillProgress app={linkedApplication} />
                      {suggesting(linkedApplication) && (
                        <p className="app-note">AI is suggesting values for the fields left open. You can carry on in the form: your own answers are kept.</p>
                      )}
                      {linkedApplication.note && <p className="app-note">{linkedApplication.note}</p>}
                      {linkedApplication.note?.includes("Settings → Drafting") && <DraftingLink />}
                    </div>
                  )}
                  {linkedApplication?.posting && (
                    <p className="app-posting">Documents tailored from {postingSource(linkedApplication.posting.source)}.</p>
                  )}
                  {linkedApplication?.blockedReason && (
                    <p className="blocked-reason"><strong>Blocked:</strong> {linkedApplication.blockedReason}</p>
                  )}
                  {linkedApplication && <AppIssues app={linkedApplication} />}
                  {linkedApplication?.aiFilled?.length ? (
                    <details className="ai-filled" open>
                      <summary>Filled by AI: check these ({linkedApplication.aiFilled.length})</summary>
                      <ul>
                        {linkedApplication.aiFilled.map((entry) => (
                          <li key={entry.label}>
                            <strong>{entry.label}</strong>: {entry.value}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {linkedApplication && <FieldFallback key={`fallback:${linkedApplication.id}:${tabContext.tabId}`} app={linkedApplication} tabId={tabContext.tabId} profileRevision={profile.revision} disabled={busy || linkedFilling} draftOnly={Boolean(tabContext.draftOnly)} prerequisite={!connected ? "Connect the backend to review unfilled fields." : !profile.confirmed || !profile.facts.length ? "Save and confirm your background to review unfilled fields." : ""} onState={setQueue} />}
                  {linkedApplication && <JobFitAssessment app={linkedApplication} profileRevision={profile.revision} onCheck={checkFit} disabled={busy} prerequisite={!connected ? "Connect the backend to check fit." : !profile.confirmed ? "Confirm your profile to check fit." : ""} />}
                  {linkedApplication && <QuestionAnswers key={`${linkedApplication.id}:${tabContext.tabId}`} app={linkedApplication} tabId={tabContext.tabId} profileRevision={profile.revision} disabled={busy || linkedFilling} draftOnly={Boolean(tabContext.draftOnly)} autoFill={(queue.settings.modelFill || "auto") === "auto"} prerequisite={!connected ? "Connect the backend to draft answers." : !profile.confirmed || !profile.facts.length ? "Save and confirm your background to draft answers." : ""} onState={setQueue} />}
                  {linkedApplication && postingMissing(linkedApplication) && <PostingPrompt app={linkedApplication} onSave={savePosting} />}
                  <div className="context-actions">
                    {tabContext.draftOnly ? (
                      <p className="app-posting" role="note">
                        {DRAFT_ONLY_NOTE} Use the drafts above and Copy.
                      </p>
                    ) : (
                      <button
                        className="primary"
                        disabled={busy || linkedFilling || Boolean(fillPrerequisite) || !((tabContext.fieldCount ?? tabContext.observation?.fields.length) || tabContext.frameOrigins?.length)}
                        onClick={() =>
                          void action(async () => {
                            // The form's own frame first, inside this click:
                            // Chrome grants access only to a user gesture.
                            if (tabContext.frameOrigins?.length && !(await chrome.permissions.request({ origins: tabContext.frameOrigins })))
                              throw new Error("Access to the application form's frame was not granted, so only the page around it can be filled.");
                            setQueue(
                              await command({
                                type: "FILL_STEP",
                                id: tabContext.applicationId,
                                tabId: tabContext.tabId,
                              }),
                            );
                          })
                        }
                      >
                        {linkedFilling ? "Filling…" : "Fill this step"}
                      </button>
                    )}
                    {linkedFilling && (
                      <p className="fill-blocker" role="status">
                        Filling now. Scroll and read freely; typing or clicking a field pauses it.
                      </p>
                    )}
                    {!linkedFilling && (fillPrerequisite || !((tabContext.fieldCount ?? tabContext.observation?.fields.length) || tabContext.frameOrigins?.length)) && (
                      <p className="fill-blocker" role="status">
                        {fillPrerequisite || "Open a form step with fillable fields."}
                        {fillPrerequisite && (
                          <button className="text-button" onClick={() => setPage(connected ? "profile" : "settings")}>
                            {connected ? "Your profile" : "Settings"}
                          </button>
                        )}
                      </p>
                    )}
                    {linkedApplication && linkedApplication.workflowStage !== "submitted" && (
                      <button className="secondary" onClick={() => markSubmitted(linkedApplication.id)}>
                        Mark submitted
                      </button>
                    )}
                    {linkedApplication && !finished(linkedApplication) && (
                      <button className="secondary" onClick={() => abandon(linkedApplication)}>
                        Abandon
                      </button>
                    )}
                    {linkedApplication && (
                      <button
                        className="secondary"
                        disabled={busy || Boolean(linkedApplication.draftJobId)}
                        title="Tailors your resume and cover letter to this job and saves them as files. Nothing is written to the page."
                        onClick={() =>
                          void action(async () =>
                            setQueue(await command({ type: "DRAFT_DOCUMENTS", id: linkedApplication.id })),
                          )
                        }
                      >
                        {linkedApplication.draftJobId
                          ? "Drafting documents…"
                          : linkedApplication.artifacts.length
                            ? "Redraft documents"
                            : "Draft documents"}
                      </button>
                    )}
                    {/* Also here, where the applicant works: the Applications list is out of view. */}
                    {linkedApplication?.missing.some((item) => /edit lock/.test(item)) && (
                      <button
                        className="secondary"
                        title="Fields you left empty are locked against filling. Unlock them so Fill this step can fill them; fields with a value are never overwritten."
                        onClick={() =>
                          void action(
                            async () => setQueue(await command({ type: "UNLOCK_APP", id: linkedApplication.id })),
                            "Empty fields unlocked. Choose Fill this step to fill them.",
                          )
                        }
                      >
                        Unlock empty fields
                      </button>
                    )}
                    {linkedApplication && linkedApplication.artifacts.length > 0 &&
                      linkedApplication.missing.some((item) => /^Review existing document:/.test(item)) && (
                      <button
                        className="secondary"
                        title="The site already held a document of its own (Amazon keeps your account's resume). Upload this application's tailored one in its place."
                        onClick={() =>
                          void action(
                            async () => setQueue(await command({ type: "REPLACE_DOCUMENTS", id: linkedApplication.id })),
                            "Replacing the site's document with this application's tailored one…",
                          )
                        }
                      >
                        Replace with tailored resume
                      </button>
                    )}
                    {linkedApplication?.missing.some((item) => /access|inspect frame/i.test(item)) && (
                      <button className="secondary" onClick={() => void action(() => access(linkedApplication))}>
                        Grant frame access
                      </button>
                    )}
                    {linkedApplication && linkedApplication.artifacts.length > 0 && (
                      <button className="secondary" onClick={() => void action(() => documents(linkedApplication))}>
                        Documents
                      </button>
                    )}
                    <button
                      className="secondary"
                      onClick={() => setIssueTarget({ tabId: tabContext.tabId, applicationId: tabContext.applicationId })}
                    >
                      Report issue
                    </button>
                    {linkedApplication && (
                      <button
                        className="secondary"
                        disabled={busy}
                        title="Forget every lock and note from earlier attempts and reload this tab, so Fill this step starts as it would the first time. Your tailored documents are kept. Anything typed into the page is lost."
                        onClick={() =>
                          void action(
                            async () => setQueue(await command({ type: "RESTART_APP", id: linkedApplication.id })),
                            "Started over. Choose Fill this step when the page has loaded.",
                          )
                        }
                      >
                        Start over (reloads tab)
                      </button>
                    )}
                  </div>
                  {linkedApplication?.draftError && (
                    <p className="fill-blocker" role="alert">{linkedApplication.draftError}</p>
                  )}
                  {linkedApplication && uploadFiles(linkedApplication)}
                  <details className="move-tab">
                    <summary>Wrong application? Move this tab</summary>
                    <input
                      type="search"
                      placeholder="Search applications"
                      aria-label="Search applications to move this tab to"
                      value={pickerQuery}
                      onChange={(event) => setPickerQuery(event.target.value)}
                    />
                    <div className="row">
                      <select
                        aria-label="Move this tab to"
                        value={attachChoice}
                        onChange={(event) => setAttachChoice(event.target.value)}
                      >
                        <option value="">Choose application…</option>
                        {queue.applications
                          .filter((app) => !app.archivedAt && app.id !== tabContext.applicationId && matchesQuery(app, pickerQuery))
                          .map((app) => (
                            <option key={app.id} value={app.id}>{app.company} — {app.title}</option>
                          ))}
                      </select>
                      <button
                        className="secondary"
                        disabled={!attachChoice || attachChoice === tabContext.applicationId || busy}
                        onClick={() =>
                          void action(async () => {
                            await siteAccess(tabContext.url, tabContext.frameOrigins);
                            setQueue(await command({ type: "ATTACH_TAB", id: attachChoice, tabId: tabContext.tabId }));
                            setPickerQuery("");
                            await scanActive();
                          })
                        }
                      >
                        Move tab
                      </button>
                    </div>
                  </details>
                  </>
                ) : (
                  <div className="attach-controls">
                    {tabContext.suggestions.length > 0 && (
                      <p className="suggestion">
                        Suggested: <strong>{queue.applications.find((app) => app.id === tabContext.suggestions[0].applicationId)?.title}</strong>
                        <small>{tabContext.suggestions[0].reason}</small>
                      </p>
                    )}
                    <input
                      type="search"
                      placeholder="Search applications"
                      aria-label="Search applications to attach this tab to"
                      value={pickerQuery}
                      onChange={(event) => setPickerQuery(event.target.value)}
                    />
                    <label>
                      Attach current tab
                      <select value={attachChoice} onChange={(event) => setAttachChoice(event.target.value)}>
                        <option value="">
                          {queue.applications.some((app) => !app.archivedAt)
                            ? "Choose application…"
                            : "No tracked applications yet"}
                        </option>
                        {queue.applications.filter((app) => !app.archivedAt && (app.id === attachChoice || matchesQuery(app, pickerQuery))).map((app) => (
                          <option key={app.id} value={app.id}>{app.company} — {app.title}</option>
                        ))}
                      </select>
                    </label>
                    <div className="context-actions">
                      <button
                        className="primary"
                        disabled={!attachChoice || busy}
                        onClick={() =>
                          void action(async () => {
                            await siteAccess(tabContext.url, tabContext.frameOrigins);
                            setQueue(await command({ type: "ATTACH_TAB", id: attachChoice, tabId: tabContext.tabId }));
                            setPickerQuery("");
                            await scanActive();
                          })
                        }
                      >
                        Attach tab
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await siteAccess(tabContext.url, tabContext.frameOrigins);
                            setQueue(await command({ type: "TRACK_TAB", tabId: tabContext.tabId }));
                            await scanActive();
                          })
                        }
                      >
                        Track as new
                      </button>
                      <button className="text-button" onClick={() => setIssueTarget({ tabId: tabContext.tabId })}>
                        Report issue
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}
            {!connected ? (
              <ConnectCard
                onConnected={() => action(loadBackend, "Connected to Application Lane on this computer.")}
                onUseToken={() => setPage("settings")}
              />
            ) : (
              <OnboardingChecklist steps={onboardingSteps} />
            )}
            <Momentum progress={progress} ready={submissions !== undefined} />
            <div className="stats">
              <div>
                <strong>{progressing}</strong>
                <span>In progress</span>
              </div>
              <div>
                <strong>{ready}</strong>
                <span>Ready to review</span>
              </div>
              <div>
                <strong>{attention}</strong>
                <span>Need you</span>
              </div>
              <button className="stat-link" title="Every application that went in" onClick={() => void openDashboard("submitted")}>
                <strong>{submittedCount}</strong>
                <span>Submitted</span>
              </button>
            </div>
            {/* Links queued from the command line (npm run lane -- add) for sites
                this extension may not reach yet: Chrome grants that only from
                a click here. */}
            {Boolean(queue.inboxWaiting?.length) && (
              <section className="card" aria-label="Links waiting for access">
                <p>
                  {queue.inboxWaiting!.length} link{queue.inboxWaiting!.length === 1 ? "" : "s"} queued from the command line
                  {" "}need access to {new Set(queue.inboxWaiting!.map((url) => new URL(url).origin)).size === 1 ? "a site" : "some sites"} first.
                </p>
                <button
                  className="primary"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const origins = [...new Set(queue.inboxWaiting!.map((url) => `${new URL(url).origin}/*`))];
                      if (!(await chrome.permissions.request({ origins })))
                        throw new Error("Site access was not granted, so those links were not tracked.");
                      setQueue(await command<QueueState>({ type: "PICK_UP_INBOX" }));
                    }, "Tracking the queued links.")
                  }
                >
                  Grant access and track
                </button>
              </section>
            )}
            <section className="card add-card">
              <div className="section-title add-title">
                <h2>Track application links</h2>
                <span className="tag">
                  Filling starts only when requested
                </span>
              </div>
              <label className="sr-only" htmlFor="urls">
                Application URLs, one per line
              </label>
              <textarea
                id="urls"
                placeholder={
                  "Paste application links, one per line\nhttps://jobs.company.com/your-next-role"
                }
                value={urls}
                onChange={(e) => setURLs(e.target.value)}
                rows={3}
              />
              <div className="row">
                <button
                  className="secondary"
                  onClick={() =>
                    void action(async () => {
                      const found = await chrome.tabs.query({
                        currentWindow: true,
                      });
                      setTabs(
                        found.filter((t) => /^https?:/.test(t.url || "")),
                      );
                      setShowTabs(!showTabs);
                    })
                  }
                >
                  Choose open tabs
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      add(
                        urls
                          .split("\n")
                          .map((u) => u.trim())
                          .filter(Boolean)
                          .map((url) => ({ url })),
                      ),
                    )
                  }
                >
                  <Icon type="plus" /> Track links
                </button>
              </div>
              {showTabs && (
                <div className="tab-picker">
                  {tabs.length ? (
                    tabs.map((tab) => (
                      <label key={tab.id}>
                        <input
                          type="checkbox"
                          checked={selected.includes(tab.id!)}
                          onChange={(e) =>
                            setSelected((old) =>
                              e.target.checked
                                ? [...old, tab.id!]
                                : old.filter((id) => id !== tab.id),
                            )
                          }
                        />
                        <span>
                          {tab.title}
                          <small>{hostname(tab.url!)}</small>
                        </span>
                      </label>
                    ))
                  ) : (
                    <p>No application tabs in this window.</p>
                  )}
                  <button
                    className="primary"
                    disabled={!selected.length || busy}
                    onClick={() =>
                      void action(() =>
                        add(
                          tabs
                            .filter((t) => selected.includes(t.id!))
                            .map((t) => ({ url: t.url!, tabId: t.id })),
                        ),
                      )
                    }
                  >
                    Track {selected.length || "selected"} tabs
                  </button>
                </div>
              )}
              <p className="micro">
                <Icon type="check" /> You review and submit every application
                yourself.
              </p>
            </section>
            <div className="section-title queue-heading">
              <h2>Your applications</h2>
              <div className="queue-tools">
                <input
                  type="search"
                  placeholder="Search"
                  aria-label="Search applications"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <select
                  aria-label="Filter applications"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="open">Open applications</option>
                  <option value="all">All applications</option>
                  <option value="active">Filling now</option>
                  <option value="attention">Need attention</option>
                  <option value="ready">Ready to review</option>
                  <option value="submitted">Submitted</option>
                  <option value="blocked">Blocked</option>
                  <option value="abandoned">Abandoned</option>
                </select>
                <label className="archive-toggle">
                  <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
                  Archived
                </label>
              </div>
            </div>
            {!queue.applications.length ? (
              <div className="empty">
                <div className="empty-icon">
                  <Icon type="layers" />
                </div>
                <h3>A clear path to your next role.</h3>
                <p>
                  Add a few application links to begin.
                  <br />
                  We’ll keep each application in its own lane.
                </p>
                <div className="mini-flow">
                  <span>Track jobs</span>
                  <span>→</span>
                  <span>Fill when ready</span>
                  <span>→</span>
                  <span>You review</span>
                </div>
              </div>
            ) : (
              <div className="applications">
                {!listed.length && (
                  <p className="help">
                    {filter === "open" && !search && !showArchived
                      ? "No open applications. Submitted ones are under Submitted."
                      : "No applications match."}
                  </p>
                )}
                {listed
                  .map((app) => (
                    <article className={`application card${active.includes(app.status) && app.status !== "queued" ? " is-filling" : ""}`} data-stage={app.workflowStage} key={app.id}>
                      <div className="application-top">
                        <span className="company-mark">
                          {hostname(app.url)
                            .replace(/^www\./, "")
                            .slice(0, 1)
                            .toUpperCase()}
                        </span>
                        <div className="job-name">
                          <h3>{app.title}</h3>
                          <span>
                            {hostname(app.url)}
                            {app.ats ? ` · ${app.ats}` : ""}
                          </span>
                        </div>
                        <span className={`status ${suggesting(app) ? "filling" : app.status}`}>
                          {suggesting(app) ? "Still filling" : labels[app.status]}
                        </span>
                      </div>
                      <div className="workflow-row">
                        <label>
                          Stage
                          <select
                            value={app.workflowStage}
                            onChange={(event) => {
                              const stage = event.target.value as WorkflowStage;
                              if (stage === "submitted" && !window.confirm("Mark this application as submitted? This updates the tracker only.")) return;
                              const reason = stage === "blocked" ? window.prompt("Why is this application blocked? (optional)") || "" : "";
                              void action(async () =>
                                setQueue(await command({ type: "SET_WORKFLOW", id: app.id, stage, reason })),
                              );
                            }}
                          >
                            <option value="applying">Applying</option>
                            <option value="review">Review</option>
                            <option value="submitted">Submitted</option>
                            <option value="blocked">Blocked</option>
                            <option value="abandoned">Abandoned</option>
                          </select>
                        </label>
                        <button
                          className="text-button muted"
                          onClick={() =>
                            void action(async () =>
                              setQueue(await command({ type: "ARCHIVE_APP", id: app.id, archived: !app.archivedAt })),
                            )
                          }
                        >
                          {app.archivedAt ? "Restore" : "Archive"}
                        </button>
                      </div>
                      <details className="application-details">
                        <summary>Edit position details</summary>
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            const values = new FormData(event.currentTarget);
                            void action(async () =>
                              setQueue(
                                await command({
                                  type: "UPDATE_APP",
                                  id: app.id,
                                  company: values.get("company"),
                                  title: values.get("title"),
                                  postingUrl: String(values.get("postingUrl") || ""),
                                  postingText: String(values.get("postingText") || ""),
                                }),
                              ),
                            );
                          }}
                        >
                          <label>
                            Company
                            <input name="company" defaultValue={app.company} />
                          </label>
                          <label>
                            Position
                            <input name="title" defaultValue={app.title} />
                          </label>
                          <label>
                            Job posting link
                            <input name="postingUrl" type="url" placeholder="https://…" defaultValue={app.postingUrl || ""} />
                          </label>
                          <label>
                            Or the posting's text
                            <textarea name="postingText" rows={3} defaultValue={app.postingText || ""} />
                          </label>
                          <button className="secondary" type="submit">Save details</button>
                        </form>
                      </details>
                      {["applying", "review"].includes(app.workflowStage) && <FillProgress app={app} />}
                      <p className="app-note">{app.note}</p>
                      {app.note?.includes("Settings → Drafting") && <DraftingLink />}
                      {app.posting && (
                        <p className="app-posting">Documents tailored from {postingSource(app.posting.source)}.</p>
                      )}
                      {app.blockedReason && (
                        <p className="blocked-reason"><strong>Blocked:</strong> {app.blockedReason}</p>
                      )}
                      {active.includes(app.status) &&
                        (app.status === "queued" ? (
                          <div className="progress">
                            <span />
                          </div>
                        ) : (
                          <FillLane />
                        ))}
                      <AppIssues app={app} />
                      <JobFitAssessment app={app} profileRevision={profile.revision} onCheck={checkFit} disabled={busy} prerequisite={!connected ? "Connect the backend to check fit." : !profile.confirmed ? "Confirm your profile to check fit." : ""} />
                      {postingMissing(app) && <PostingPrompt app={app} onSave={savePosting} />}
                      <div className="related-tabs" aria-label={`Tabs for ${app.title}`}>
                        {app.tabs.map((tab) => (
                          <div className={`related-tab ${app.tabId === tab.tabId ? "target" : ""}`} key={tab.id}>
                            <span className="tab-role">{tab.role}</span>
                            <span className="tab-copy">
                              <strong>{tab.title}</strong>
                              <small>{tab.state === "closed" ? "Closed" : `${app.tabId === tab.tabId ? "Current target · " : ""}${tab.state === "unscanned" ? "Not scanned" : `${tab.fieldCount} fields`} · ${hostname(tab.url)}`}</small>
                            </span>
                            {tab.tabId && (
                              <button className="icon-button compact" aria-label={`Open ${tab.title}`} title="Open tab" onClick={() => void action(() => command({ type: "OPEN_TAB", id: app.id, tabId: tab.tabId }))}>
                                <Icon type="external" />
                              </button>
                            )}
                            {tab.tabId && app.tabId !== tab.tabId && (
                              <button className="text-button" onClick={() => void action(async () => setQueue(await command({ type: "SET_TARGET", id: app.id, tabId: tab.tabId })))}>
                                Use
                              </button>
                            )}
                            {tab.tabId && (
                              <button className="icon-button compact" aria-label={`Detach ${tab.title}`} title="Detach tab" onClick={() => void action(async () => setQueue(await command({ type: "DETACH_TAB", id: app.id, tabId: tab.tabId })))}>
                                ×
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                      {app.attempts.length > 0 && (
                        <details className="attempt-history">
                          <summary>Fill history ({app.attempts.length})</summary>
                          {app.attempts.slice().reverse().map((attempt) => (
                            <div className="attempt-row" key={attempt.id}>
                              <span>{new Date(attempt.startedAt).toLocaleString()}</span>
                              <strong>{attempt.status}</strong>
                              <small>{attempt.filled} fields{attempt.note ? ` · ${attempt.note}` : ""}</small>
                            </div>
                          ))}
                        </details>
                      )}
                      <div className="app-footer">
                        <small>
                          {app.filled} fields filled
                          {app.issueCount ? ` · ${app.issueCount} issue${app.issueCount === 1 ? "" : "s"}` : ""}
                          {app.preparationMs !== undefined
                            ? ` · ${Math.round(app.preparationMs / 1000)}s active`
                            : ""}
                        </small>
                        <div className="actions">
                          {app.tabId && !active.includes(app.status) && app.status !== "cancelled" && (
                            <>
                              <button className="primary small" hidden={draftOnlySite(app.url)} disabled={busy || Boolean(fillPrerequisite)} onClick={() => void action(async () => setQueue(await command({ type: "FILL_STEP", id: app.id })))}>
                                Fill this step
                              </button>
                              {fillPrerequisite && <small className="fill-blocker">{fillPrerequisite}</small>}
                            </>
                          )}
                          {app.workflowStage !== "submitted" && (
                            <button className="text-button" onClick={() => markSubmitted(app.id)}>
                              Mark submitted
                            </button>
                          )}
                          {app.missing.some((item) => /edit lock/.test(item)) && (
                            <button
                              className="text-button"
                              title="Fields you left empty are locked against filling. Unlock them so Fill this step can fill them; fields with a value are never overwritten."
                              onClick={() =>
                                void action(
                                  async () => setQueue(await command({ type: "UNLOCK_APP", id: app.id })),
                                  "Empty fields unlocked. Choose Fill this step to fill them.",
                                )
                              }
                            >
                              Unlock empty fields
                            </button>
                          )}
                          {active.includes(app.status) ? (
                            <button
                              className="text-button"
                              onClick={() =>
                                void action(() =>
                                  command({ type: "PAUSE_APP", id: app.id }),
                                )
                              }
                            >
                              Pause
                            </button>
                          ) : null}
                          {app.missing.some((m) =>
                            /access|inspect frame/i.test(m),
                          ) && (
                            <button
                              className="text-button"
                              onClick={() => void action(() => access(app))}
                            >
                              Grant frame access
                            </button>
                          )}
                          {app.artifacts.length > 0 && (
                            <button
                              className="text-button"
                              onClick={() => void action(() => documents(app))}
                            >
                              Documents
                            </button>
                          )}
                          <button
                            className="text-button"
                            onClick={() =>
                              void action(() =>
                                command({ type: "OPEN_APP", id: app.id }),
                              )
                            }
                          >
                            Open <Icon type="external" />
                          </button>
                          {app.tabId && (
                            <button className="text-button" onClick={() => setIssueTarget({ tabId: app.tabId!, applicationId: app.id })}>
                              Report issue
                            </button>
                          )}
                          {app.status !== "cancelled" && (
                            <button
                              className="text-button muted"
                              onClick={() =>
                                void action(() =>
                                  command({ type: "CANCEL_APP", id: app.id }),
                                )
                              }
                            >
                              Abandon
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
              </div>
            )}
            <div className="quiet-note">
              <Icon type="pause" />
              <p>
                <strong>Your edits come first.</strong> Start editing an
                application and its active fill pauses. Other requested fills
                keep moving.
              </p>
            </div>
          </>
        )}
        {page === "jobs" && <FindJobs onState={setQueue} />}
        {page === "submitted" && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">HISTORY</div>
                <h1>Submitted applications</h1>
              </div>
            </div>
            <p className="help">
              Every application that went in, newest first: the ones the site
              confirmed, and the ones you marked submitted. It stays when an
              application is archived or removed from the list.
            </p>
            {submissions && <ProgressBoard progress={progress} submissions={submissions} />}
            {!submissions?.length ? (
              <div className="empty compact-empty">
                <h3>{submissions ? "Nothing submitted yet" : "History unavailable"}</h3>
                <p>{submissions ? "Applications appear here once they go in." : "Connect to the local backend to see it."}</p>
              </div>
            ) : (
              <div className="issue-list">
                {submissions.map((record) => (
                  <article className="issue-row" key={record.applicationId}>
                    <div>
                      <span className="tag">{record.confirmedBySite ? "confirmed by the site" : "marked by you"}</span>
                      <h3>{record.title}</h3>
                      <small>
                        {record.company} · {new Date(record.submittedAt).toLocaleDateString()} ·{" "}
                        <a href={record.url} target="_blank" rel="noreferrer">{hostname(record.url)}</a>
                        {record.ats ? ` · ${record.ats}` : ""}
                      </small>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
        {page === "fixer" && devToolsBuild && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">REPORT FIXER</div>
                <h1>Fixer</h1>
              </div>
            </div>
            {!fixer ? (
              <div className="empty compact-empty">
                <h3>Fixer status unavailable</h3>
                <p>Connect to the local backend to see it.</p>
              </div>
            ) : (
              <>
                {(() => {
                  // It beats every minute; three missed and it is not running.
                  const running = Boolean(fixer.heartbeatAt && Date.now() - fixer.heartbeatAt < 3 * 60_000);
                  return (
                    <p className={`help fixer-running ${running ? "on" : "off"}`} role="status">
                      {running
                        ? `Running${fixer.branch ? ` on ${fixer.branch}` : ""}.`
                        : `Not running${fixer.heartbeatAt ? ` since ${new Date(fixer.heartbeatAt).toLocaleString()}` : ""}. Start it with npm run fixer.`}
                      {fixer.checkedThrough ? ` Fills saved up to ${new Date(fixer.checkedThrough).toLocaleString()} have been checked for problems.` : ""}
                      {fixer.checkRetryAt ? ` The last check failed; it tries again at ${new Date(fixer.checkRetryAt).toLocaleTimeString()}.` : ""}
                    </p>
                  );
                })()}
                {fixerSettings && (
                  <section className="card fixer-settings" aria-label="Fixer agents and models">
                    <h2>Agents and models</h2>
                    <p className="help">
                      The fixer tries the agents you tick, in this order, and moves to the next only when one
                      produces no fix. Changes apply from its next task.
                      {fixer.inUse
                        ? ` In use now: ${fixer.inUse.agents.map((agent) => `${agentNames[agent]} (${agent === "claude" || agent === "claude2" ? fixer.inUse!.claudeModel : agent === "codex" ? fixer.inUse!.codexModel : fixer.inUse!.endpointModel || "endpoint's model"})`).join(", then ")}.`
                        : ""}
                    </p>
                    <ol className="agent-order">
                      {[...fixerSettings.agents, ...fixerAgents.filter((agent) => !fixerSettings.agents.includes(agent))].map((agent) => {
                        const used = fixerSettings.agents.includes(agent);
                        const at = fixerSettings.agents.indexOf(agent);
                        return (
                          <li key={agent}>
                            <label>
                              <input
                                type="checkbox"
                                checked={used}
                                disabled={used && fixerSettings.agents.length === 1}
                                onChange={() =>
                                  setFixerSettings({
                                    ...fixerSettings,
                                    agents: used ? fixerSettings.agents.filter((other) => other !== agent) : [...fixerSettings.agents, agent],
                                  })
                                }
                              />
                              {agentNames[agent]}
                            </label>
                            {used && at > 0 && (
                              <button
                                className="text-button"
                                aria-label={`Try ${agentNames[agent]} earlier`}
                                onClick={() => {
                                  const agents = [...fixerSettings.agents];
                                  [agents[at - 1], agents[at]] = [agents[at], agents[at - 1]];
                                  setFixerSettings({ ...fixerSettings, agents });
                                }}
                              >
                                Move up
                              </button>
                            )}
                            {fixer.health?.[agent] && (
                              <span className={`agent-health ${fixer.health[agent]!.ok ? "ok" : "broken"}`}>
                                {fixer.health[agent]!.ok ? "Works" : `Does not work: ${fixer.health[agent]!.detail}`}
                                {` (checked ${new Date(fixer.health[agent]!.checkedAt).toLocaleTimeString()}${fixer.health[agent]!.version ? `, ${fixer.health[agent]!.version}` : ""})`}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                    {fixer.health && (
                      <p className="help">
                        Before each task the fixer has every agent run one small command, and passes over one that
                        cannot. It asks a working agent again after an hour and a broken one after 15 minutes.{" "}
                        <button
                          className="text-button"
                          onClick={() =>
                            void action(async () => {
                              await api("/v1/fixer/health", "DELETE");
                              setFixer(await api<FixerOverview>("/v1/fixer"));
                            }, "The fixer will check every agent again before its next task.")
                          }
                        >
                          Check again
                        </button>
                      </p>
                    )}
                    <div className="fixer-models">
                      <label>
                        Claude model
                        <input list="claude-models" value={fixerSettings.claudeModel} onChange={(e) => setFixerSettings({ ...fixerSettings, claudeModel: e.target.value })} />
                      </label>
                      <label>
                        Codex model
                        <input list="codex-models" value={fixerSettings.codexModel} onChange={(e) => setFixerSettings({ ...fixerSettings, codexModel: e.target.value })} />
                      </label>
                      <label>
                        Codex second model (empty for none)
                        <input list="codex-models" value={fixerSettings.codexFallbackModel} onChange={(e) => setFixerSettings({ ...fixerSettings, codexFallbackModel: e.target.value })} />
                      </label>
                      <label>
                        Codex reasoning effort
                        <select value={fixerSettings.codexEffort} onChange={(e) => setFixerSettings({ ...fixerSettings, codexEffort: e.target.value as FixerSettings["codexEffort"] })}>
                          {codexEfforts.map((effort) => (
                            <option key={effort} value={effort}>{effort}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Endpoint model (empty for the backend's)
                        <input list="endpoint-models" value={fixerSettings.endpointModel} onChange={(e) => setFixerSettings({ ...fixerSettings, endpointModel: e.target.value })} />
                      </label>
                      <label>
                        Separate Claude login's settings folder
                        <input
                          placeholder="C:\Users\you\.claude-second"
                          value={fixerSettings.claude2ConfigDir}
                          onChange={(e) => setFixerSettings({ ...fixerSettings, claude2ConfigDir: e.target.value })}
                        />
                      </label>
                      <label>
                        Tasks at once
                        <select value={fixerSettings.parallel} onChange={(e) => setFixerSettings({ ...fixerSettings, parallel: Number(e.target.value) })}>
                          {[1, 2, 3].map((count) => (
                            <option key={count} value={count}>{count}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <p className="help">
                      Each task at once gets a checkout of its own, and their fixes are verified one at a time. The
                      separate Claude login runs from its own settings folder: sign it in once from a terminal with
                      CLAUDE_CONFIG_DIR set to that folder, then run claude and /login.
                    </p>
                    {(["claude", "codex", "endpoint"] as const).map((kind) => (
                      <datalist key={kind} id={`${kind}-models`}>
                        {modelSuggestions[kind].map((model) => (
                          <option key={model} value={model} />
                        ))}
                      </datalist>
                    ))}
                    <button
                      className="primary"
                      onClick={() =>
                        void action(async () => {
                          const saved = await api<{ settings: FixerSettings }>("/v1/fixer/settings", "PUT", fixerSettings);
                          setFixerSettings(saved.settings);
                        }, "Fixer settings saved. They apply from its next task.")
                      }
                    >
                      Save fixer settings
                    </button>
                  </section>
                )}
                {!fixer.items.length ? (
                  <div className="empty compact-empty">
                    <h3>Nothing for the fixer yet</h3>
                    <p>Reports you file, and problems the checks find in your fills, appear here.</p>
                  </div>
                ) : (
                  <div className="issue-list">
                    {fixer.items.map((item) => (
                      <article className="issue-row" key={item.id}>
                        <div>
                          <span className="tag">{item.kind === "task" ? "found by the checks" : "your report"}</span>
                          <h3>{item.title}</h3>
                          <small>
                            {item.site ? `${item.site} · ` : ""}
                            {item.result?.status === "working" && item.result.startedAt
                              ? `working for ${Math.max(1, Math.round((Date.now() - item.result.startedAt) / 60_000))} min`
                              : item.result?.finishedAt
                                ? `finished ${new Date(item.result.finishedAt).toLocaleString()}`
                                : "queued"}
                          </small>
                          {item.problem && <p>{item.problem}</p>}
                          {item.result && item.result.status !== "queued" && (
                            <p className={`fixer-status ${item.result.status}`}>
                              <strong>{fixerLabels[item.result.status]}</strong>
                              {item.result.commit ? ` (${item.result.commit.slice(0, 7)})` : ""}
                              {item.result.summary ? `: ${item.result.summary}` : ""}
                              {item.result.liveCheck && <span className="live-check"> Check on the live site: {item.result.liveCheck}</span>}
                            </p>
                          )}
                          {item.result && <FixerProblems result={item.result} />}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
        {page === "issues" && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">LOCAL DIAGNOSTICS</div>
                <h1>Issue reports</h1>
              </div>
            </div>
            <p className="help">
              Reports stay on this computer until you delete them. Exporting a
              report includes its captured form markup and entered values.
            </p>
            {!issues.length ? (
              <div className="empty compact-empty">
                <h3>No saved reports</h3>
                <p>Use Report issue from the current tab or an application.</p>
              </div>
            ) : (
              <div className="issue-list">
                {issues.map((issue) => (
                  <article className="issue-row" key={issue.id}>
                    <div>
                      <span className="tag">{issue.category.replaceAll("-", " ")}</span>
                      <h3>{issue.application?.title || issue.tab.title}</h3>
                      <small>
                        {new Date(issue.createdAt).toLocaleString()} · {hostname(issue.tab.url)}
                        {issue.recordingId ? " · with recording" : ""}
                        {issue.network ? ` · network ${issue.network.fromLoad ? "from page load" : "(after load)"}` : ""}
                      </small>
                      {issue.note && <p>{issue.note}</p>}
                      {issue.fixer && (
                        <p className={`fixer-status ${issue.fixer.status}`}>
                          <strong>{fixerLabels[issue.fixer.status]}</strong>
                          {issue.fixer.commit ? ` (${issue.fixer.commit.slice(0, 7)})` : ""}
                          {issue.fixer.summary ? `: ${issue.fixer.summary}` : ""}
                          {issue.fixer.liveCheck && <span className="live-check"> Check on the live site: {issue.fixer.liveCheck}</span>}
                        </p>
                      )}
                      {issue.fixer && <FixerProblems result={issue.fixer} />}
                    </div>
                    <div className="actions">
                      <button className="text-button" onClick={() => void action(() => exportIssue(issue.id))}>Export JSON</button>
                      <button className="text-button" onClick={() => void action(() => copyIssue(issue.id), "Markdown summary copied.")}>Copy summary</button>
                      <button
                        className="text-button muted"
                        onClick={() =>
                          void action(async () => {
                            setQueue(await command({ type: "DELETE_ISSUE", reportId: issue.id }));
                            setIssues((current) => current.filter((item) => item.id !== issue.id));
                          })
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            <div className="section-title recordings-heading">
              <h2>Page recordings</h2>
            </div>
            <p className="help">
              Recordings show what happened on a page (clicks, typing, menus
              and options, network requests, and every field before and after)
              while you or another tool filled it. They include entered values
              and stay on this computer until you delete them.
            </p>
            {!recordings.length ? (
              <div className="empty compact-empty">
                <h3>No recordings</h3>
                <p>Use Record page activity from the current tab.</p>
              </div>
            ) : (
              <div className="issue-list">
                {recordings.map((recording) => (
                  <article className="issue-row" key={recording.id}>
                    <div>
                      <span className="tag">recording</span>
                      <h3>{recording.tab.title}</h3>
                      <small>
                        {new Date(recording.createdAt).toLocaleString()} · {hostname(recording.tab.url)} ·{" "}
                        {Math.round(recording.durationMs / 1000)}s · {recording.eventCount} events
                        {recording.pages.length > 1 ? ` · ${recording.pages.length} pages` : ""}
                      </small>
                      {recording.summary && (
                        <small className="recording-summary">
                          {recording.summary.valueChanges} field changes, {recording.summary.directChanges} set directly
                          {Object.entries(recording.summary.callsBySource).map(([source, count]) => (
                            <span key={source}>
                              {" · "}
                              {count} page-function calls by{" "}
                              {source === "injected" ? "injected code" : source.replace(/^extension:/, "extension ")}
                            </span>
                          ))}
                        </small>
                      )}
                    </div>
                    <div className="actions">
                      <button
                        className="text-button"
                        onClick={() =>
                          void action(async () => {
                            const full = await api<Recording>(`/v1/recordings/${recording.id}`);
                            saveBlob(
                              `application-lane-recording-${recording.id}.json`,
                              JSON.stringify(full, null, 2),
                              "application/json",
                            );
                          })
                        }
                      >
                        Export JSON
                      </button>
                      <button
                        className="text-button muted"
                        onClick={() =>
                          void action(async () => {
                            await api(`/v1/recordings/${recording.id}`, "DELETE");
                            setRecordings((current) => current.filter((item) => item.id !== recording.id));
                          })
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
        {page === "profile" && (
          <>
            {connected && <OnboardingChecklist steps={onboardingSteps} />}
            <div className="eyebrow">THE FACTS BEHIND EVERY APPLICATION</div>
            <h1>
              Your experience.
              <br />
              <span>Ready to travel.</span>
            </h1>
            <p className="lede">
              Confirm what’s true once. Tailored documents select and order
              these facts without inventing qualifications.
            </p>
            {conflicts.length > 0 && (
              <div className="notice" role="status" aria-label="Profile disagreements">
                <strong>This profile and your tailoring notes disagree.</strong> Yes/no
                answers use this profile, written answers use the files, so an
                application could contradict itself. Make them match:
                <ul>
                  {conflicts.map((c) => (
                    <li key={c.field}>
                      {c.field}: here “{c.extension}”, {c.file} “{c.markdown}”
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!connected ? (
              <ConnectCard
                onConnected={() => action(loadBackend, "Connected to Application Lane on this computer.")}
                onUseToken={() => setPage("settings")}
              />
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(async () => {
                    const normalized = {
                      ...profile,
                      skills: cleanLines(profile.skills),
                      languages: cleanLines(profile.languages),
                      referralSource: cleanLines(profile.referralSource),
                      // A country row added but never chosen says nothing.
                      workAuthorization: (profile.workAuthorization || []).filter((entry) => entry.country),
                    };
                    setProfile(
                      await api<Profile>("/v1/profile", "PUT", normalized),
                    );
                  }, "Profile saved. Resume paused applications to use these facts.");
                }}
              >
                <section className="card">
                  <div className="section-title">
                    <h2>Start with your resume</h2>
                    <span className="tag">PDF or DOCX · 10 MB max</span>
                  </div>
                  <label className="upload">
                    <Icon type="plus" />
                    <span>
                      {busy ? "Working…" : "Add resumes to your facts"}
                    </span>
                    <input
                      type="file"
                      accept=".pdf,.docx"
                      multiple
                      disabled={busy}
                      aria-label="Add resumes to your facts"
                      onChange={(e) => {
                        const files = Array.from(e.currentTarget.files || []);
                        e.currentTarget.value = "";
                        if (!files.length) return;
                        void action(() => importResumes(files));
                      }}
                    />
                  </label>
                  <p className="micro">
                    Select up to 10 resumes at once. New facts are added to your
                    existing list; exact duplicates are skipped. Original files
                    are not saved.
                  </p>
                  <p className="help">
                    Differing versions stay separate for you to review. Check
                    dates, quantities, and wording, then confirm and save the
                    cumulative list.
                  </p>
                  {imports.length > 0 && (
                    <div role="status" aria-label="Resume import results">
                      {imports.map((report, index) => (
                        <p
                          className={report.error ? "notice error" : "help"}
                          key={index}
                        >
                          <strong>{report.name}</strong>:{" "}
                          {report.error ||
                            `${report.added} facts added, ${report.duplicates} duplicates skipped.`}
                        </p>
                      ))}
                    </div>
                  )}
                </section>
                <section className="card">
                  <h2>Contact details</h2>
                  <div className="form-grid">
                    {(
                      [
                        "firstName",
                        "middleName",
                        "lastName",
                        "preferredName",
                        "namePronunciation",
                        "email",
                        "phoneCountryCode",
                        "phone",
                        "phoneDeviceType",
                        "address",
                        "addressLine2",
                        "city",
                        "state",
                        "county",
                        "postalCode",
                        "country",
                        "linkedin",
                        "website",
                        "github",
                        "currentCompany",
                      ] as const
                    ).map((key) => (
                      <label key={key}>
                        {(
                          {
                            firstName: "First name",
                            lastName: "Last name",
                            middleName: "Middle name (optional)",
                            postalCode: "Postal code",
                            linkedin: "LinkedIn URL",
                            preferredName: "Preferred first name (optional)",
                            namePronunciation: "How your name is said (optional)",
                            github: "GitHub URL (optional)",
                            currentCompany: "Current company (optional)",
                            phoneDeviceType: "Phone device type",
                            phoneCountryCode: "Phone country code (e.g. +44)",
                            phone: "Phone number (without the country code)",
                            addressLine2: "Address line 2 (optional)",
                          } as any
                        )[key] || key[0].toUpperCase() + key.slice(1)}
                        <input
                          type={key === "email" ? "email" : "text"}
                          value={profile[key] || ""}
                          onChange={(e) => edit(key, e.target.value)}
                          required={["firstName", "lastName", "email"].includes(
                            key,
                          )}
                        />
                      </label>
                    ))}
                  </div>
                </section>
                <WorkAuthorizationEditor profile={profile} edit={edit} />
                <section className="card">
                  <h2>Application answer bank</h2>
                  <p className="help">
                    These confirmed choices are reused only for matching standard
                    application questions. Leave any answer blank to handle it
                    yourself.
                  </p>
                  <div className="form-grid">
                    <CareerEditor profile={profile} edit={edit} />
                    {(["dateOfBirth", "age18OrOlder", "willingToRelocate", "internshipCount"] as const).map((key) => (
                      <label key={key}>
                        {({ dateOfBirth: "Date of birth (for age questions)", age18OrOlder: "Age 18 or older", willingToRelocate: "Willing to relocate", internshipCount: "Prior internships / co-ops" } as const)[key]}
                        {key === "dateOfBirth" ? (
                          <input
                            type="date"
                            value={profile.dateOfBirth}
                            onChange={(e) => edit("dateOfBirth", e.target.value)}
                          />
                        ) : key === "internshipCount" ? (
                          <input
                            type="number"
                            min={0}
                            max={99}
                            step={1}
                            placeholder="e.g. 2"
                            value={profile.internshipCount}
                            onChange={(e) => edit("internshipCount", e.target.value.trim())}
                          />
                        ) : (
                          <ChoiceSelect field={key} value={profile[key]} onChange={(value) => edit(key, value)} />
                        )}
                      </label>
                    ))}
                    <SalaryEditor profile={profile} edit={edit} />
                    <LocaleEditor profile={profile} edit={edit} />
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={profile.neverWorkedForApplyingCompanies === true}
                      onChange={(e) => edit("neverWorkedForApplyingCompanies", e.target.checked ? true : undefined)}
                    />{" "}
                    I have never worked for any company I apply to. (Without this, "Have you worked here before?" is
                    answered Yes only when your work history names the employer, and otherwise left for you.)
                  </label>
                  <label>
                    Skills (one per line)
                    <textarea
                      rows={5}
                      value={profile.skills.join("\n")}
                      onChange={(e) =>
                        edit("skills", e.target.value.split("\n"))
                      }
                      onBlur={() => edit("skills", cleanLines(profile.skills))}
                    />
                  </label>
                  <label>
                    Languages, one per line with how well (English: Native,
                    Hindi: Fluent, Spanish: Basic)
                    <textarea
                      rows={3}
                      value={profile.languages.join("\n")}
                      onChange={(e) =>
                        edit("languages", e.target.value.split("\n"))
                      }
                      onBlur={() => edit("languages", cleanLines(profile.languages))}
                    />
                  </label>
                  <label>
                    Where you hear about jobs, in preference order (one per
                    line, such as LinkedIn or Company website; not a
                    person's name)
                    <textarea
                      rows={4}
                      value={profile.referralSource.join("\n")}
                      onChange={(e) =>
                        edit("referralSource", e.target.value.split("\n"))
                      }
                      onBlur={() =>
                        edit(
                          "referralSource",
                          cleanLines(profile.referralSource),
                        )
                      }
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={profile.acknowledgeTerms}
                      onChange={(e) =>
                        edit("acknowledgeTerms", e.target.checked)
                      }
                    />{" "}
                    Allow the extension to tick Terms and Conditions
                    acknowledgements (signatures and final Submit remain manual).
                  </label>
                </section>
                <section className="card">
                  <h2>U.S. equal-opportunity questions (optional)</h2>
                  <p className="help">
                    Voluntary self-identification as U.S. employers ask it. These
                    answer only questions worded the U.S. way; any other
                    country's diversity questions are left for you.
                  </p>
                  <div className="form-grid">
                    {(["disabilityStatus", "veteranStatus", "gender", "pronouns", "sexualOrientation", "transgender", "ethnicity", "hispanic"] as const).map((key) => (
                      <label key={key}>
                        {({ disabilityStatus: "Disability status", veteranStatus: "Veteran status", gender: "Gender", pronouns: "Pronouns", sexualOrientation: "Sexual orientation", transgender: "Identify as transgender", ethnicity: "Ethnicity", hispanic: "Hispanic / Latino" } as const)[key]}
                        <ChoiceSelect field={key} value={profile[key]} onChange={(value) => edit(key, value)} />
                      </label>
                    ))}
                  </div>
                </section>
                <section className="card">
                  <div className="section-title">
                    <h2>Move your profile</h2>
                  </div>
                  <p className="help">
                    Export saves everything on this page, your tailoring files
                    (resumes, profile and preference notes, question guides) and
                    your settings as one file. Import replaces what is here with
                    a file exported elsewhere. Passwords, API keys, applications
                    and generated documents are never included.
                  </p>
                  <div className="context-actions">
                    <button type="button" className="secondary" disabled={busy} onClick={() => void action(exportProfile, "Profile exported. The file holds personal details: keep it somewhere private.")}>
                      Export profile
                    </button>
                    <label className="secondary file-button">
                      Import profile…
                      <input
                        type="file"
                        accept=".json,application/json"
                        disabled={busy}
                        aria-label="Import profile"
                        onChange={(e) => {
                          const file = e.currentTarget.files?.[0];
                          e.currentTarget.value = "";
                          if (!file) return;
                          if (!window.confirm("Replace the profile, tailoring files and settings here with the ones in this file?")) return;
                          void action(async () => {
                            const files = await importProfile(file);
                            setNotice(`Profile imported${files ? `, with ${files} tailoring file${files === 1 ? "" : "s"}` : ""}. Check it, then confirm.`);
                          });
                        }}
                      />
                    </label>
                  </div>
                </section>
                <section className="card">
                  <div className="section-title">
                    <h2>Legal and eligibility details</h2>
                  </div>
                  <p className="help">
                    Choose what is true of you, or write it in your own words.
                    Questions about your record, clearance, agreements and the
                    like are answered only from what you save here, including
                    boxes that ask you to explain. Leave any of them for
                    yourself to answer that kind by hand.
                  </p>
                  <div className="form-grid">
                    {(Object.keys(legalDetailLabels) as LegalDetailKey[]).map((key) => (
                      <LegalDetail
                        key={key}
                        topic={key}
                        value={profile.legal?.[key] || ""}
                        onChange={(value) => edit("legal", { ...profile.legal, [key]: value })}
                      />
                    ))}
                  </div>
                </section>
                <section className="card">
                  <div className="section-title">
                    <h2>Cumulative resume facts</h2>
                    <span className="tag">
                      {profile.facts.length} / 300 facts
                    </span>
                  </div>
                  <p className="help">
                    One complete fact per line. Include skills, achievements,
                    and experience you can support. These lines form the
                    evidence for your documents.
                  </p>
                  <textarea
                    rows={12}
                    aria-label="Resume facts"
                    value={profile.facts.map((f) => f.text).join("\n")}
                    onChange={(e) =>
                      edit(
                        "facts",
                        e.target.value.split("\n").map((text, i) => ({
                          id: profile.facts[i]?.id || crypto.randomUUID(),
                          text,
                        })),
                      )
                    }
                  />
                </section>
                {(["work", "education"] as const).map((kind) => (
                  <section className="card" key={kind}>
                    <div className="section-title">
                      <h2>
                        {kind === "work" ? "Work experience" : "Education"}
                      </h2>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() =>
                          edit(kind, [
                            ...profile[kind],
                            {
                              organization: "",
                              title: "",
                              startDate: "",
                              endDate: "",
                              location: "",
                              details: "",
                            },
                          ])
                        }
                      >
                        + Add entry
                      </button>
                    </div>
                    {profile[kind].map((row, index) => (
                      <div className="history-row" key={index}>
                        <div className="form-grid">
                          {(
                            [
                              "organization",
                              "title",
                              "startDate",
                              "endDate",
                              "location",
                              "details",
                              ...(kind === "education"
                                ? ["fieldOfStudy" as const]
                                : []),
                              "address",
                              "city",
                              "state",
                              "county",
                              "postalCode",
                              "country",
                              ...(kind === "work"
                                ? ["reasonForLeaving" as const]
                                : []),
                            ] as const
                          ).map((key) => (
                            <label key={key}>
                              {
                                {
                                  organization:
                                    kind === "work"
                                      ? "Employer"
                                      : "Institution",
                                  title:
                                    kind === "work" ? "Job title" : "Degree",
                                  startDate: "Start date (YYYY-MM-DD)",
                                  endDate: kind === "education" ? "End or expected graduation date (YYYY-MM-DD)" : "End date (YYYY-MM-DD, blank = present)",
                                  location: "Location",
                                  details: "Details",
                                  fieldOfStudy: "Major / field of study",
                                  address: "Street address (optional)",
                                  city: "City (optional)",
                                  state: "State / province (optional)",
                                  county: "County (optional)",
                                  postalCode: "Zip / postal code (optional)",
                                  country: "Country (optional)",
                                  reasonForLeaving: "Reason for leaving (optional)",
                                }[key]
                              }
                              <input
                                value={row[key] || ""}
                                placeholder={key === "startDate" || key === "endDate" ? "2025-08-19" : undefined}
                                pattern={key === "startDate" || key === "endDate" ? "\\d{4}-\\d{2}(-\\d{2})?" : undefined}
                                // Trimmed when the field is left, not as it
                                // is typed: trimming each keystroke swallowed
                                // every space typed at the end of the text.
                                onChange={(e) =>
                                  edit(
                                    kind,
                                    profile[kind].map((r, i) =>
                                      i === index
                                        ? { ...r, [key]: e.target.value }
                                        : r,
                                    ),
                                  )
                                }
                                onBlur={(e) =>
                                  edit(
                                    kind,
                                    profile[kind].map((r, i) =>
                                      i === index
                                        ? { ...r, [key]: e.target.value.trim() }
                                        : r,
                                    ),
                                  )
                                }
                              />
                              {(key === "startDate" || key === "endDate") &&
                                /^\d{4}-\d{2}$/.test(row[key] || "") && (
                                  <small className="fill-blocker">
                                    Add the day ({row[key]}-DD). Forms that ask for a day use the 1st until you do.
                                  </small>
                                )}
                            </label>
                          ))}
                          {kind === "education" && (
                            <>
                              <label>
                                GPA or grade (optional)
                                <input
                                  value={row.gpa || ""}
                                  placeholder="e.g. 3.62, 8.7, 85"
                                  maxLength={20}
                                  onChange={(e) =>
                                    edit(kind, profile[kind].map((r, i) => (i === index ? { ...r, gpa: e.target.value.trim() || undefined } : r)))
                                  }
                                />
                              </label>
                              <label>
                                GPA scale
                                <select
                                  value={row.gpaScale || ""}
                                  onChange={(e) =>
                                    edit(kind, profile[kind].map((r, i) => (i === index ? { ...r, gpaScale: (e.target.value || undefined) as typeof r.gpaScale } : r)))
                                  }
                                >
                                  <option value="">Not said</option>
                                  <option value="4">Out of 4</option>
                                  <option value="5">Out of 5</option>
                                  <option value="10">Out of 10</option>
                                  <option value="100">Out of 100 (percentage)</option>
                                  <option value="other">Another scale</option>
                                </select>
                              </label>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={row.current === true}
                                  onChange={(e) =>
                                    edit(kind, profile[kind].map((r, i) => (i === index ? { ...r, current: e.target.checked } : r)))
                                  }
                                />{" "}
                                I am still studying here
                              </label>
                              <TranscriptPicker
                                value={row.transcript}
                                onChange={(name) =>
                                  edit(kind, profile[kind].map((r, i) => (i === index ? { ...r, transcript: name } : r)))
                                }
                              />
                            </>
                          )}
                        </div>
                        <button
                          className="text-button muted"
                          type="button"
                          onClick={() =>
                            edit(
                              kind,
                              profile[kind].filter((_, i) => i !== index),
                            )
                          }
                        >
                          Remove entry
                        </button>
                      </div>
                    ))}
                  </section>
                ))}
                <section className="card">
                  <div className="section-title">
                    <h2>Professional references</h2>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() =>
                        edit("references", [
                          // An older backend answers without the field.
                          ...(profile.references || []),
                          { name: "", relationship: "", phone: "", email: "" },
                        ])
                      }
                    >
                      + Add reference
                    </button>
                  </div>
                  <p className="help">
                    People an employer may contact. These fill a form's
                    reference rows, and a single "list your references" box in
                    the order shown here.
                  </p>
                  {(profile.references || []).map((reference, index) => (
                    <div className="history-row" key={index}>
                      <div className="form-grid">
                        {(
                          ["name", "relationship", "phone", "email"] as const
                        ).map((key) => (
                          <label key={key}>
                            {
                              {
                                name: "Name",
                                relationship: "Relationship",
                                phone: "Phone number",
                                email: "Email",
                              }[key]
                            }
                            <input
                              value={reference[key] || ""}
                              onChange={(e) =>
                                edit(
                                  "references",
                                  (profile.references || []).map((r, i) =>
                                    i === index
                                      ? { ...r, [key]: e.target.value }
                                      : r,
                                  ),
                                )
                              }
                            />
                          </label>
                        ))}
                      </div>
                      <button
                        className="text-button muted"
                        type="button"
                        onClick={() =>
                          edit(
                            "references",
                            (profile.references || []).filter(
                              (_, i) => i !== index,
                            ),
                          )
                        }
                      >
                        Remove reference
                      </button>
                    </div>
                  ))}
                </section>
                <RecurringAnswers
                  profileRevision={profile.revision}
                  onSaved={(saved) => {
                    dispatchProfile({ type: "edit", update: saved });
                    setNotice("Saved. Later fills give this answer.");
                  }}
                />
                <section className="card">
                  <div className="section-title">
                    <h2>Reusable answers</h2>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() =>
                        edit("answers", [
                          ...profile.answers,
                          { question: "", answer: "" },
                        ])
                      }
                    >
                      + Add answer
                    </button>
                  </div>
                  <p className="help">
                    Answers match an exact question label. Eligibility and
                    sensitive questions are filled only when you explicitly
                    supply an answer.
                  </p>
                  {profile.answers.map((answer, index) => (
                    <div className="history-row" key={index}>
                      <label>
                        Question
                        <input
                          value={answer.question}
                          onChange={(e) =>
                            edit(
                              "answers",
                              profile.answers.map((a, i) =>
                                i === index
                                  ? { ...a, question: e.target.value }
                                  : a,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        Your answer
                        <input
                          value={answer.answer}
                          onChange={(e) =>
                            edit(
                              "answers",
                              profile.answers.map((a, i) =>
                                i === index
                                  ? { ...a, answer: e.target.value }
                                  : a,
                              ),
                            )
                          }
                        />
                      </label>
                      <button
                        className="text-button muted"
                        type="button"
                        onClick={() =>
                          edit(
                            "answers",
                            profile.answers.filter((_, i) => i !== index),
                          )
                        }
                      >
                        Remove answer
                      </button>
                    </div>
                  ))}
                </section>
                <div className="confirm">
                  <label>
                    <input
                      type="checkbox"
                      checked={profile.confirmed}
                      onChange={(e) => edit("confirmed", e.target.checked)}
                    />{" "}
                    I’ve checked these details and confirm they are accurate.
                  </label>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !profile.confirmed ||
                      !profile.facts.length ||
                      profile.facts.some((f) => !f.text.trim())
                    }
                    type="submit"
                  >
                    Save confirmed profile <Icon type="check" />
                  </button>
                </div>
              </form>
            )}
          </>
        )}
        {page === "settings" && (
          <>
            <div className="eyebrow">LOCAL BY DESIGN</div>
            <h1>
              Your tools.
              <br />
              <span>Your connection.</span>
            </h1>
            <p className="lede">
              The extension prepares forms in your browser. Your local backend
              handles documents and AI requests.
            </p>
            <section className="card">
              <div className="section-title">
                <h2>Backend connection</h2>
                <span className={`status ${connected ? "ready" : "paused"}`}>
                  {connected ? "Connected" : "Not connected"}
                </span>
              </div>
              {!connected && <ConnectCard onConnected={() => action(loadBackend, "Connected to Application Lane on this computer.")} />}
              <p className="help">
                The backend runs on this computer (<code>npm start</code> in the
                Application Lane folder). Connect with the six-digit code it shows,
                or paste the 64-character token from <code>config.json</code> in
                its data folder (not the Chrome extension ID). To move to another
                browser or extension, restart it with <code>npm start -- --pair</code>{" "}
                (or run <code>lane pair</code>) and type the new code.
              </p>
              <p className="help">
                This extension was built {extensionBuild ? describeBuild(extensionBuild) : "without a build stamp"}.
                {waitingBuild ? ` A newer build is ready: ${describeBuild(waitingBuild)}.` : ""}
              </p>
              <label>
                Pairing token
                <input
                  type="password"
                  autoComplete="off"
                  value={pairToken}
                  onChange={(e) => setPairToken(e.target.value)}
                  placeholder="Local pairing token"
                />
              </label>
              <div className="row">
                <button
                  className="secondary"
                  onClick={() =>
                    void action(loadBackend, "Connection refreshed.")
                  }
                >
                  Refresh connection
                </button>
                <button
                  className="primary"
                  disabled={busy || !pairToken}
                  onClick={() =>
                    void action(async () => {
                      await command({ type: "PAIR", token: pairToken });
                      setPairToken("");
                      await loadBackend();
                    }, "Local backend connected.")
                  }
                >
                  Connect <Icon type="arrow" />
                </button>
              </div>
            </section>
            <DraftingSettings connected={connected} />
            <section className="card">
              <h2>Processing</h2>
              <p className="help">
                Fill requests you explicitly start may run together. The extension
                never starts another step or clicks Next on its own. Thorough
                checking adds about half a minute per application.
              </p>
              <div className="form-grid">
                <label>
                  Simultaneous fills
                  <select
                    value={queue.settings.concurrency}
                    onChange={(e) =>
                      setQueue((q) => ({
                        ...q,
                        settings: {
                          ...q.settings,
                          concurrency: Number(e.target.value),
                        },
                      }))
                    }
                  >
                    {[1, 2, 3, 4, 6, 8].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <label>
                  AI requests at once
                  <select
                    value={queue.settings.generationConcurrency}
                    onChange={(e) =>
                      setQueue((q) => ({
                        ...q,
                        settings: {
                          ...q.settings,
                          generationConcurrency: Number(e.target.value),
                        },
                      }))
                    }
                  >
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Document checking
                  <select
                    value={queue.settings.checking || "thorough"}
                    onChange={(e) =>
                      setQueue((q) => ({
                        ...q,
                        settings: {
                          ...q.settings,
                          checking: e.target.value === "fast" ? "fast" : "thorough",
                        },
                      }))
                    }
                  >
                    <option value="thorough">Thorough: another model in your Drafting order checks every claim (slower)</option>
                    <option value="fast">Fast: no second check</option>
                  </select>
                </label>
                <label>
                  AI filling
                  <select
                    value={queue.settings.modelFill === "written" ? "auto" : queue.settings.modelFill || "auto"}
                    onChange={(e) =>
                      setQueue((q) => ({
                        ...q,
                        settings: {
                          ...q.settings,
                          modelFill: e.target.value === "review" ? "review" : e.target.value === "off" ? "off" : "auto",
                        },
                      }))
                    }
                  >
                    <option value="auto">Fill automatically: AI answers go into the form, marked for you to check</option>
                    <option value="review">Review first: AI drafts, you approve before anything is filled</option>
                    <option value="off">Profile only: fill just what matches my saved details</option>
                  </select>
                </label>
                <label>
                  Legal and eligibility questions
                  <select
                    value={queue.settings.legalQuestions || "manual"}
                    onChange={(e) =>
                      setQueue((q) => ({
                        ...q,
                        settings: {
                          ...q.settings,
                          legalQuestions: e.target.value === "model" ? "model" : "manual",
                        },
                      }))
                    }
                  >
                    <option value="manual">Leave for me unless my profile answers them (they are listed)</option>
                    <option value="model">Let AI answer them like any other question</option>
                  </select>
                </label>
                <label>
                  Pre-filled answers
                  <select
                    value={queue.settings.prefilled || "replace"}
                    onChange={(e) =>
                      setQueue((q) => ({
                        ...q,
                        settings: {
                          ...q.settings,
                          prefilled: e.target.value === "keep" ? "keep" : "replace",
                        },
                      }))
                    }
                  >
                    <option value="replace">Replace with my profile (your edits are kept)</option>
                    <option value="keep">Keep what the site filled in</option>
                  </select>
                </label>
                {!storeBuild && typeof chrome.debugger !== "undefined" && (
                <label>
                  Network capture for reports
                  <select
                    value={queue.settings.networkCapture === "on" ? "on" : "off"}
                    onChange={(e) =>
                      setQueue((q) => ({
                        ...q,
                        settings: {
                          ...q.settings,
                          networkCapture: e.target.value === "off" ? "off" : "on",
                        },
                      }))
                    }
                  >
                    <option value="off">Off</option>
                    <option value="on">On: reports can be replayed</option>
                  </select>
                  <small className="help">
                    While on, Chrome shows its "started debugging this browser" bar on application tabs, and
                    the pages' network traffic (addresses, form data, responses) is recorded and saved with
                    issue reports on this computer.
                  </small>
                </label>
                )}
              </div>
              <button
                className="secondary"
                disabled={!connected || busy}
                onClick={() =>
                  void action(
                    async () =>
                      setQueue(
                        await command({
                          type: "SETTINGS",
                          settings: queue.settings,
                        }),
                      ),
                    "Processing settings saved.",
                  )
                }
              >
                Save settings
              </button>
            </section>
            <Appearance />
            <section className="card">
              <h2>Your data</h2>
              <p className="help">
                Profile facts and job content are sent to your configured AI
                endpoint for tailoring. The extension does not collect telemetry
                or share your browser history. API keys stay in the local
                backend. Cancelling an application leaves its existing page
                values in place.
              </p>
              <p className="help">
                Initial adapters: Workday, Greenhouse, Lever, Ashby, and iCIMS.
                Other sites use general form matching. Login, CAPTCHAs,
                inaccessible frames, and unknown controls may require you.
              </p>
              {deleteConfirm ? (
                <div className="notice error">
                  <p>
                    Delete your saved profile, application tracker, generated documents, issue reports
                    and the page traffic saved with them, fill captures, recordings, job searches, the
                    fixer's results and transcripts uploaded here? Your settings and pairing stay.
                    This cannot be undone.
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={deleteDocuments}
                      onChange={(e) => setDeleteDocuments(e.target.checked)}
                    />{" "}
                    Also delete the documents saved to your documents folder
                  </label>
                  <button
                    className="danger"
                    onClick={() =>
                      void action(async () => {
                        await api(deleteDocuments ? "/v1/data?documents=1" : "/v1/data", "DELETE");
                        setProfile(structuredClone(emptyProfile));
                        setIssues([]);
                        setDeleteConfirm(false);
                      }, "Profile, tracker, documents, and issue reports deleted. Existing application pages were not cleared.")
                    }
                  >
                    Delete local application data
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setDeleteConfirm(false)}
                  >
                    Keep data
                  </button>
                </div>
              ) : (
                <button
                  className="text-button danger-text"
                  onClick={() => setDeleteConfirm(true)}
                >
                  Delete local application data…
                </button>
              )}
            </section>
          </>
        )}
      </main>
      <footer>
        <span className={`dot ${connected ? "" : "offline"}`} />
        {connected
          ? "Connected to your local backend"
          : "Local backend not connected"}
        <span>Review before submitting</span>
      </footer>
      {issueTarget && (
        <div className="modal-backdrop" onClick={() => setIssueTarget(undefined)}>
          <section
            className="modal issue-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Report an extension issue"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="section-title">
              <h2>Report an issue</h2>
              <button className="icon-button" aria-label="Close issue report" onClick={() => setIssueTarget(undefined)}>×</button>
            </div>
            <p className="help">
              If this application is filling, it will pause while the report is captured. Other applications continue.
            </p>
            <label>
              What went wrong?
              <select value={issueCategory} onChange={(event) => setIssueCategory(event.target.value as IssueCategory)}>
                <option value="wrong-value">Wrong value</option>
                <option value="field-not-detected">Field not detected</option>
                <option value="fill-failure">Could not fill</option>
                <option value="upload">Document upload</option>
                <option value="tab-matching">Tab matching</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              What were you doing?
              <textarea rows={4} value={issueNote} onChange={(event) => setIssueNote(event.target.value)} placeholder="A short note helps reproduce the problem." />
            </label>
            <label className="snapshot-consent">
              <input type="checkbox" checked={issueConsent} onChange={(event) => setIssueConsent(event.target.checked)} />
              Include this page’s rendered markup and entered form values. Passwords and recognized security tokens are redacted.
            </label>
            <div className="row">
              <button className="secondary" onClick={() => setIssueTarget(undefined)}>Cancel</button>
              <button
                className="primary"
                disabled={!issueConsent || busy}
                onClick={() =>
                  void action(async () => {
                    const result = await command<{ report: IssueReport; saved: boolean; saveError: string }>({
                      type: "REPORT_ISSUE",
                      tabId: issueTarget.tabId,
                      category: issueCategory,
                      note: issueNote,
                    });
                    if (result.saved)
                      setIssues((current) => [{ ...result.report, frames: undefined } as Omit<IssueReport, "frames">, ...current]);
                    else
                      saveBlob(
                        `application-lane-issue-${result.report.id}.json`,
                        JSON.stringify(result.report, null, 2),
                        "application/json",
                      );
                    setIssueTarget(undefined);
                    setIssueNote("");
                    setIssueConsent(false);
                    setQueue(await command({ type: "STATE" }));
                    setNotice(result.saved ? "Issue saved locally." : `Backend unavailable; report downloaded instead. ${result.saveError}`);
                  })
                }
              >
                Capture report
              </button>
            </div>
          </section>
        </div>
      )}
      {answerSuggestions && (
        <div className="modal-backdrop" onClick={() => setAnswerSuggestions(undefined)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Save your answers"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="section-title">
              <h2>Save your answers</h2>
              <button className="icon-button" aria-label="Close saved answers" onClick={() => setAnswerSuggestions(undefined)}>×</button>
            </div>
            <p className="help">
              Saved answers fill the exact same question on future applications.
              You can edit or remove them under Your profile.
            </p>
            <div className="answer-choices">
              {answerSuggestions.map((item, index) => (
                <label key={item.question} className="answer-choice">
                  <input
                    type="checkbox"
                    checked={item.keep}
                    onChange={(event) =>
                      setAnswerSuggestions((current) =>
                        current?.map((choice, i) => (i === index ? { ...choice, keep: event.target.checked } : choice)),
                      )
                    }
                  />
                  <span>
                    <strong>{item.question}</strong>
                    <span className="answer-value">{item.answer}</span>
                    {item.replaces !== undefined && (
                      <small>Replaces your saved answer: {item.replaces}</small>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <div className="row">
              <button className="secondary" onClick={() => setAnswerSuggestions(undefined)}>Cancel</button>
              <button
                className="primary"
                disabled={busy || !answerSuggestions.some((item) => item.keep)}
                onClick={() =>
                  void action(async () => {
                    const chosen = answerSuggestions.filter((item) => item.keep);
                    const saved = await command<Profile>({
                      type: "SAVE_ANSWERS",
                      answers: chosen.map(({ question, answer }) => ({ question, answer })),
                    });
                    dispatchProfile({ type: "edit", update: saved });
                    setAnswerSuggestions(undefined);
                    setNotice(`Saved ${chosen.length} answer${chosen.length === 1 ? "" : "s"}. They fill the same questions next time.`);
                  })
                }
              >
                Save selected
              </button>
            </div>
          </section>
        </div>
      )}
      {review && (
        <div className="modal-backdrop" onClick={() => setReview(undefined)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Application documents"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-title">
              <h2>Documents for this application</h2>
              <button
                className="icon-button"
                aria-label="Close documents"
                onClick={() => setReview(undefined)}
              >
                ×
              </button>
            </div>
            <p>{review.title}</p>
            {review.fit && <JobFitAssessment app={review} profileRevision={profile.revision} />}
            {review.narrative?.warnings?.map((warning, i) => (
              <p role="status" className="notice" key={i}>
                {warning}
              </p>
            ))}
            <div className="downloads">
              {review.artifacts.map((a) => {
                const label = a.kind === "resume" ? "Resume" : a.kind === "transcript" ? "Transcript" : "Cover letter";
                return (
                  <span className="document" key={a.id}>
                    <button
                      className="secondary"
                      onClick={() => void action(() => download(a))}
                    >
                      {label} · {a.format.toUpperCase()}
                    </button>
                    {a.format === "pdf" && (
                      <button
                        className="text-button"
                        aria-label={`Save ${label} ${a.format.toUpperCase()}`}
                        onClick={() => void action(() => download(a, true))}
                      >
                        Save
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
            {uploadFiles(review)}
            {review.narrative?.tailoring && (
              <>
                <h3>Tailored resume</h3>
                <p className="help">
                  Built from your {review.narrative.tailoring.source}.{" "}
                  {review.narrative.tailoring.summaryReplaced
                    ? "Reordered for this posting, with the summary rewritten. No new claim was added."
                    : review.narrative.tailoring.changes.length
                      ? "Reordered for this posting; the summary is your own. No new claim was added."
                      : "Used unchanged."}
                </p>
                <p className="fact-preview">
                  {review.narrative.tailoring.summary}
                  <small>Summary</small>
                </p>
                {review.narrative.tailoring.changes.map((change, i) => (
                  <p className="fact-preview" key={i}>
                    {change}
                  </p>
                ))}
                {review.narrative.tailoring.cautions.map((caution, i) => (
                  <p className="fact-preview" key={i}>
                    {caution}
                    <small>Check before sending</small>
                  </p>
                ))}
              </>
            )}
            <h3>Selected resume facts</h3>
            <p className="help">
              Tailoring selects and orders your confirmed wording. Compare these
              selections with your profile before submitting.
            </p>
            {review.narrative?.resume.map((f, i) => (
              <p className="fact-preview" key={i}>
                {f.text}
                <small>Source: confirmed profile fact</small>
              </p>
            ))}
            <h3>Cover letter</h3>
            {Boolean(review.narrative?.coverLetter.length) && (
              <button
                className="text-button"
                onClick={() =>
                  void action(
                    () =>
                      navigator.clipboard.writeText(
                        review.narrative!.coverLetter.map((p) => p.text.trim()).join("\n\n"),
                      ),
                    "Letter text copied.",
                  )
                }
              >
                Copy letter text
              </button>
            )}
            {review.narrative?.coverLetter.map((p, i) => (
              <p className="letter" key={i}>
                {p.text}
              </p>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
class PanelErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="shell">
        <main>
          <div className="notice error" role="alert">
            Application Lane hit an unexpected error: {this.state.error.message}
          </div>
          <button className="primary" onClick={() => location.reload()}>
            Reload panel
          </button>
        </main>
      </div>
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <PanelErrorBoundary>
    <App />
  </PanelErrorBoundary>,
);
