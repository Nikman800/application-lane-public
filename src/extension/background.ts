import { keptHandAnswer } from "../shared/hand-answers";
import {
  BACKEND,
  CONTENT_VERSION,
  activeStatuses,
  type Application,
  type Artifact,
  type GenerationJob,
  type Field,
  type FieldFallbackProblem,
  type Observation,
  type Profile,
  type Proposal,
  type QueueState,
  type QueueSummaryItem,
  type RecurringAnswer,
  type TabContext,
  type IssueReport,
  type Recording,
  hasLegalDetails,
  normalize,
} from "../shared/model";
import { storeBuild } from "../shared/store-build";
import { rowHolds } from "./row-holds";
import { pickTranscript } from "../shared/transcripts";
import { DRAFT_ONLY_NOTE, accessPattern, canonicalURL, draftOnlySite, sameOpening, historyRowMap, listAnswered, postingGuess, proposals } from "../shared/matching";
import { questionTopic } from "../shared/standing";
import { locationCountry, type Geography } from "../shared/geography";
import globals from "../engine/config/globals.json" with { type: "json" };
import {
  answerLimitError,
  applicationQuestion,
  legalQuestion,
  structuredFallbackField,
} from "../shared/questions";
import { transitionTiming } from "../shared/timing";
import { configEngineEnabled } from "../engine/mode";
import {
  applyMainWorld,
  type MainWorldRequest,
} from "../engine/page/mainWorld";
import { installMonitor, removeMonitor } from "../engine/page/monitor";
import { PAGE_TIMER_EVENT, installPageTimers } from "../engine/page/timers";
import { documentKind } from "./semantics";
import { captureHar, capturing, forgetCapture, startCapture } from "./network-capture";
import {
  forgetTrustedInput,
  releaseTrustedInput,
  trustedInputTabs,
  trustedTypingAvailable,
  typeTrusted,
} from "./trusted-input";
import {
  LOCKS_VERSION,
  companyFor,
  migrateLocks,
  migrateQueue,
  redactURL,
  relatedTab,
  tabRole,
} from "./workspace";

type Frame = { frameId: number; observation: Observation };
let state: QueueState = {
  schemaVersion: 2,
  applications: [],
  settings: { concurrency: 4, generationConcurrency: 2 },
};
let locks: Record<string, string[]> = {};
let token = "";
const runners = new Map<string, number>();
const dirty = new Set<string>();
let saving = Promise.resolve();
let kickTimer: ReturnType<typeof setTimeout> | undefined;
// Documents handed to a page's configured upload dialog, per page and kind,
// so a later fill of the same page does not upload them again.
const configUploads = new Set<string>();
let pumping = false;
const answerRequests = new Map<string, string>();
const answerFills = new Set<string>();
const fieldFallbackRequests = new Map<string, string>();
const fieldFallbackFills = new Set<string>();
const backoff = new Map<string, number>();

// The queue as the command line sees it (scripts/lane.ts): mirrored to the
// backend as it changes, since it lives here. A change after a quiet spell
// goes at once, then at most one every two seconds: never two seconds after
// the last change, since a fill saves its progress more often than that and
// the command line saw "Tracked" until it stopped.
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncAgain = false;
function syncQueueSoon() {
  if (syncTimer) {
    syncAgain = true;
    return;
  }
  // After this turn, so the changes made with this one go with it.
  syncTimer = setTimeout(() => {
    sendQueue();
    const settle = () => {
      if (!syncAgain) return void (syncTimer = undefined);
      syncAgain = false;
      sendQueue();
      syncTimer = setTimeout(settle, 2000);
    };
    syncTimer = setTimeout(settle, 2000);
  }, 0);
}
function sendQueue() {
  if (!token) return;
  const applications: QueueSummaryItem[] = state.applications.map((app) => {
    const last = app.attempts.at(-1);
    return {
      id: app.id,
      url: app.url,
      company: app.company.slice(0, 300),
      title: app.title.slice(0, 500),
      status: app.status,
      stage: app.workflowStage,
      note: (app.note || "").slice(0, 1000),
      needs: app.missing.filter((item) => /^Required:/.test(item)).map((item) => item.replace(/^Required:\s*/, "").slice(0, 300)).slice(0, 10),
      optional: app.missing.filter((item) => /^Optional unanswered:/.test(item)).map((item) => item.replace(/^Optional unanswered:\s*/, "").slice(0, 300)).slice(0, 10),
      updatedAt: app.updatedAt,
      ...(last ? { lastFill: { status: last.status, note: (last.note || "").slice(0, 1000), completedAt: last.completedAt, filled: last.filled } } : {}),
      reports: app.issueCount || 0,
      // AI is still filling what the profile left: not yet the applicant's.
      ...(app.assisting && (app.status === "awaiting-user" || app.status === "ready") ? { assisting: true } : {}),
    };
  });
  const snapshot = { at: Date.now(), applications };
  void api("/v1/queue", "PUT", snapshot).catch(() => {});
  sendLive({ type: "queue", snapshot });
}
// The live line to the backend (src/server/live.ts): the command line's
// "fill this step" and "switch to its tab" arrive at once, and the queue goes
// out as it changes. Held open, it also keeps Chrome from putting this worker
// to sleep, so a command never waits for the 30-second wake-up.
let live: WebSocket | undefined;
let liveRetry = 1000;
let liveBeat: ReturnType<typeof setInterval> | undefined;
function sendLive(message: unknown) {
  if (live?.readyState === WebSocket.OPEN) live.send(JSON.stringify(message));
}
function connectLive() {
  if (!token || (live && live.readyState <= WebSocket.OPEN)) return;
  let socket: WebSocket;
  try {
    socket = new WebSocket(`${BACKEND.replace(/^http/, "ws")}/v1/live`);
  } catch {
    return;
  }
  live = socket;
  socket.onopen = () => {
    liveRetry = 1000;
    socket.send(JSON.stringify({ type: "auth", token }));
    syncQueueSoon();
    clearInterval(liveBeat);
    // Chrome keeps the worker awake while the socket is in use.
    liveBeat = setInterval(() => sendLive({ type: "ping" }), 20_000);
  };
  socket.onmessage = (event) => {
    let message: { type?: string; id?: string; action?: string; applicationId?: string };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.type === "command" && typeof message.id === "string")
      void initial.then(() => liveCommand(message)).then(
        (detail) => sendLive({ type: "result", id: message.id, ok: true, ...(detail ? { detail } : {}) }),
        (error: Error) => sendLive({ type: "result", id: message.id, ok: false, error: error.message }),
      );
  };
  socket.onclose = () => {
    if (live === socket) live = undefined;
    clearInterval(liveBeat);
    setTimeout(connectLive, liveRetry);
    liveRetry = Math.min(liveRetry * 2, 60_000);
  };
  socket.onerror = () => {};
}
// The extension's current build in a page opened before it was reloaded:
// injected again into each of its frames, where it takes over from the old
// copy. Nothing is reloaded, so nothing entered is lost; reloading a page a
// form posted to asked "Confirm Form Resubmission", and opening its address
// again showed one employer's SuccessFactors only an error.
async function refreshPast(tabId: number) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => undefined)) || [{ frameId: 0, url: "" }];
  for (const frame of frames) {
    if (frame.frameId !== 0 && captchaFrame(frame.url)) continue;
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frame.frameId] }, files: ["content.js"], injectImmediately: true }).catch(() => {});
  }
}

// A command from the command line, as the side panel would carry it out:
// fill is Fill this step (it never presses Next or Submit), switch brings the
// application's tab and its window to the front.
async function liveCommand(message: { action?: string; applicationId?: string }): Promise<string | undefined> {
  if (message.action === "pick-up") {
    await pickUpInbox();
    return;
  }
  // The fixer's reload (lane reload): a new build without a trip
  // to chrome://extensions. Never under a fill, which it would cut off.
  if (message.action === "reload") {
    const busy = state.applications.filter((candidate) => ["inspecting", "preparing", "filling"].includes(candidate.status));
    if (busy.length)
      throw new Error(`Not reloaded: ${busy.map((candidate) => candidate.company || candidate.title).slice(0, 3).join(", ")} ${busy.length === 1 ? "is" : "are"} being filled. Try again when ${busy.length === 1 ? "it finishes" : "they finish"}.`);
    setTimeout(() => chrome.runtime.reload(), 300);
    return "Reloading the extension. A page open before it is on the old build until refreshed.";
  }
  const app = state.applications.find((candidate) => candidate.id === message.applicationId);
  if (!app) throw new Error("No such application. It may have been removed.");
  if (message.action === "switch") {
    const tab = app.tabId !== undefined ? await chrome.tabs.get(app.tabId).catch(() => undefined) : undefined;
    if (tab?.id !== undefined) {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return "Switched to its tab.";
    }
    const opened = await chrome.tabs.create({ url: app.url, active: true });
    if (opened.windowId !== undefined) await chrome.windows.update(opened.windowId, { focused: true });
    if (opened.id !== undefined) await attachTab(app, opened.id);
    return "Its tab was closed, so it was opened again.";
  }
  // As the panel's Abandon: any fill stops, and it leaves the open list.
  if (message.action === "abandon") {
    await uiMessage({ type: "CANCEL_APP", id: app.id });
    return "Abandoned. Change its stage in the panel to undo.";
  }
  // Its page loaded again, on the extension's current build (after a
  // reload, a page keeps the old one until refreshed). Never under a fill.
  if (message.action === "refresh") {
    if (["inspecting", "preparing", "filling"].includes(app.status)) throw new Error("It is being filled. Try again when it finishes.");
    if (app.tabId === undefined) throw new Error("Its tab is closed. Switch to it first.");
    await refreshPast(app.tabId);
    return "Its page now runs the current build.";
  }
  if (message.action === "fill") {
    if (app.tabId === undefined) throw new Error("Its tab is closed. Switch to it first, then fill.");
    await uiMessage({ type: "FILL_STEP", id: app.id });
    return "Filling this step.";
  }
  throw new Error("Unknown command.");
}
// Links queued from the command line are tracked as if pasted into Track
// application links, a few at a time (each opens a tab). One for a site the
// extension may not reach waits for the panel to ask for access.
// One pick-up at a time; a request while one runs waits for it, so what it
// tracked is in the state returned (the backend now asks for one as soon as a
// link is queued, and the panel's own request had come back before it).
let pickingUp: Promise<void> | undefined;
function pickUpInbox(): Promise<void> {
  if (!token) return Promise.resolve();
  pickingUp ||= pickUpOnce().finally(() => {
    pickingUp = undefined;
  });
  return pickingUp;
}
async function pickUpOnce() {
  const inbox: { url: string }[] = await api("/v1/inbox").catch(() => []);
  if (!inbox.length) {
    if (state.inboxWaiting?.length) {
      state.inboxWaiting = [];
      await persist();
    }
    return;
  }
  const taken: string[] = [];
  const waiting: string[] = [];
  let opened = 0;
  for (const { url } of inbox) {
    let canonical: string;
    try {
      canonical = canonicalURL(url);
    } catch {
      taken.push(url);
      continue;
    }
    if (state.applications.some((app) => app.status !== "cancelled" && [app.url, app.sourceUrl].some((known) => known && sameOpening(known, canonical)))) {
      taken.push(url);
      continue;
    }
    if (!(await chrome.permissions.contains({ origins: [`${new URL(canonical).origin}/*`] }))) {
      waiting.push(url);
      continue;
    }
    if (opened >= 10) continue;
    await enqueue([{ url }]).then(() => {
      taken.push(url);
      opened++;
    }, () => {});
  }
  if (taken.length) await api("/v1/inbox", "DELETE", { urls: taken }).catch(() => {});
  state.inboxWaiting = waiting.slice(0, 500);
  await persist();
}

function persist() {
  syncQueueSoon();
  const snapshot = structuredClone({ queue: state, locks });
  // Document text lives in the backend; avoid repeatedly copying resumes into
  // Chrome's quota-limited queue storage for every status transition.
  for (const app of snapshot.queue.applications) delete app.narrative;
  saving = saving
    .catch(() => {})
    .then(() => chrome.storage.local.set(snapshot));
  return saving;
}
const initial = (async () => {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const data = await chrome.storage.local.get([
    "queue",
    "locks",
    "token",
    "locksVersion",
  ]);
  if (data.queue) state = migrateQueue(data.queue);
  const migrated = migrateLocks(data.locks, data.locksVersion);
  locks = migrated.locks;
  if (migrated.migrated)
    await chrome.storage.local.set({ locks, locksVersion: LOCKS_VERSION });
  token = data.token || "";
  for (const app of state.applications) {
    // A worker's unobserved downtime cannot be measured as active work.
    app.activeSince = undefined;
    // Nothing survives a restart, so no attempt can still be in progress.
    for (const attempt of app.attempts)
      if (!attempt.completedAt) {
        attempt.completedAt = attempt.startedAt;
        attempt.status = "paused";
        attempt.note ||= "Interrupted.";
      }
    // Nor can the suggestion step that follows a fill.
    app.assisting = false;
    if (
      activeStatuses.includes(app.status) ||
      (app.status === "queued" && app.explicitFill)
    ) {
      if (app.fieldFallbackSession?.jobId)
        void api(`/v1/jobs/${app.fieldFallbackSession.jobId}`, "DELETE").catch(() => {});
      app.fieldFallbackSession = undefined;
      app.operation++;
      app.explicitFill = false;
      app.status = "paused";
      app.note =
        "Background worker restarted. Choose Fill this step to re-inspect safely.";
      if (app.jobId)
        void api(`/v1/jobs/${app.jobId}`, "DELETE").catch(() => {});
      if (app.tabId) void broadcast(app, "PAUSE");
    }
  }
  tidyFinishedNotes();
  await persist();
  void syncSubmissions().catch(() => {});
  await chrome.alarms.create("queue-recovery", { periodInMinutes: 0.5 });
  await chrome.alarms.create("inbox", { periodInMinutes: 1 });
  connectLive();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
})();

// Said wherever the backend cannot be reached.
const BACKEND_DOWN =
  "Application Lane's backend is not running on this computer. Open a terminal in the Application Lane folder, run npm start (or application-lane if you installed it), keep that window open, and try again.";

// Whether a backend answers, and whether a pairing code can be typed now.
// Asked without the token: the handshake is the one unauthenticated route.
async function hello(): Promise<{ running: boolean; paired?: boolean; pairedHere?: boolean; pairing?: string; version?: string }> {
  try {
    const response = await fetch(`${BACKEND}/v1/hello`, { method: "POST", signal: AbortSignal.timeout(4000) });
    if (!response.ok) return { running: true };
    const data = await response.json();
    return { running: true, paired: Boolean(data.paired), pairedHere: Boolean(data.pairedHere), pairing: String(data.pairing || ""), version: String(data.version || "") };
  } catch {
    return { running: false };
  }
}

// The token, once paired: kept, the live line restarted, submissions synced.
async function adoptToken(next: string) {
  token = next;
  await chrome.storage.local.set({ token });
  submissionsSynced = false;
  void syncSubmissions().catch(() => {});
  // Paired again (perhaps with another token): the live line starts over.
  live?.close();
  connectLive();
}

async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  if (!token) throw new Error("Pair with the local backend first.");
  let response: Response;
  try {
    response = await fetch(`${BACKEND}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(BACKEND_DOWN);
  }
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `Backend HTTP ${response.status}`);
  return data;
}
const alive = (app: Application, operation: number) =>
  app.operation === operation &&
  !["paused", "cancelled", "failed"].includes(app.status);
async function frameCall(
  app: Application,
  frameId: number,
  message: Record<string, unknown>,
) {
  if (!app.tabId) throw new Error("Application tab is closed.");
  const operation = app.operation;
  const payload = { applicationId: app.id, operation, ...message };
  let result;
  try {
    result = await chrome.tabs.sendMessage(app.tabId, payload, { frameId });
  } catch (error) {
    const original = new Error(
      `${(error as Error).message} [command ${String(message.type)}, tab ${app.tabId}, frame ${frameId}, document ${String(message.documentId || "unspecified")}, operation ${operation}${message.documentURL ? `, url ${String(message.documentURL).split(/[?#]/)[0]}` : ""}]`,
      { cause: error },
    );
    // Chrome can lose a read receiver when the page replaces its document.
    // Reinstall and retry one read only. Mutations keep their existing
    // navigation handling and are never replayed after an uncertain result.
    if (!["ENGINE_INFO", "BIND", "INSPECT"].includes(String(message.type)) ||
      !/receiving end does not exist/i.test(original.message) || !alive(app, operation)) throw original;
    try {
      await chrome.scripting.executeScript({ target: { tabId: app.tabId, frameIds: [frameId] }, files: ["content.js"], injectImmediately: true });
      if (!alive(app, operation)) throw new Error("Application operation is stale or paused.");
      result = await chrome.tabs.sendMessage(app.tabId, payload, { frameId });
    } catch (recoveryError) {
      // Re-injection can itself fail because Chrome has removed the frame.
      // Keep the original transport error so the caller can re-observe the
      // navigation, rather than replacing it with an unrelated new error.
      original.message += `; read recovery failed: ${(recoveryError as Error).message}`;
      throw original;
    }
  }
  if (!result?.ok)
    throw new Error(
      result?.error || "Application content script did not respond.",
    );
  return result.data;
}
// Applications whose dropdown option lists are being read for a review
// (draftFieldFallback). Outside a fill, the page-world bridge serves only
// those reads: listing a dropdown's options, and closing it choosing nothing.
const optionReads = new Set<string>();
const readingOptions = (app: Application, request: MainWorldRequest | undefined) =>
  optionReads.has(app.id) &&
  Boolean(request) &&
  !request!.file &&
  !request!.event &&
  !request!.values?.some(Boolean) &&
  (request!.method === "reactSelectOptions" || request!.method === "reactSelectChoose");
// When each application was first seen waiting on a tab that is still loading.
const loadingSince = new Map<string, number>();
function frameDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Frame did not respond in time.")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
// A fill goes on in a minimized window or a background tab: while it runs,
// the page's own timers keep their delays (engine/page/timers.ts).
async function pageTimers(tabId: number, on: boolean) {
  await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      injectImmediately: true,
      func: installPageTimers,
      args: [PAGE_TIMER_EVENT, on],
    })
    .catch(() => {});
  for (const frame of await allFrames(tabId).catch(() => []))
    await chrome.tabs
      .sendMessage(tabId, { type: "PAGE_TIMERS", on }, { frameId: frame.frameId })
      .catch(() => {});
}

// The passes that fill answers after the main fill (the model's, the
// reviewed ones) also run in a hidden tab: a list one of them opened on
// one employer's form came 8.5 seconds late.
async function withPageTimers<T>(app: Application, tabId: number | undefined, work: () => Promise<T>): Promise<T> {
  if (tabId !== undefined) await pageTimers(tabId, true);
  try {
    return await work();
  } finally {
    if (tabId !== undefined && !runners.has(app.id) && !activeStatuses.includes(app.status))
      await pageTimers(tabId, false);
  }
}

async function allFrames(tabId: number) {
  return (await chrome.webNavigation.getAllFrames({ tabId })) || [];
}
async function reinspectNavigation(app: Application, frameId: number, before: string, operation: number, error: Error, beforeURL?: string): Promise<Frame | undefined> {
  if (!/message (channel|port).*closed|receiving end does not exist|no frame with id \d+/i.test(error.message)) throw error;
  const deadline = Date.now() + 5_000;
  while (alive(app, operation) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const tab = app.tabId && await chrome.tabs.get(app.tabId).catch(() => undefined);
    if (!tab || canonicalURL(tab.url || "") !== canonicalURL(app.url)) throw error;
    if (tab.status !== "complete") continue;
    const read = (await observations(app, operation)).frames;
    const sameFrame = read.find((candidate) => candidate.frameId === frameId);
    // An iframe can be replaced entirely, giving the same application document
    // a new frame ID. Only one exact old-URL match is eligible; ambiguity stays
    // a failure, and the original write is never resent.
    const relocated = !sameFrame && beforeURL
      ? read.filter((candidate) => candidate.observation.url === beforeURL && candidate.observation.documentId !== before) : [];
    const fresh = sameFrame || (relocated.length === 1 ? relocated[0] : undefined);
    if (!alive(app, operation)) return;
    if (!fresh || (beforeURL && fresh.observation.url !== beforeURL) || fresh.observation.documentId === before || fresh.observation.paused || fresh.observation.fields.length < 3) continue;
    dirty.delete(app.id);
    return fresh;
  }
  if (!alive(app, operation)) return;
  throw error;
}
// A document can disappear after a scalar write starts. Re-observe a fresh
// document on the same application URL, and leave the interrupted writes for
// review. Never replay the original APPLY or change missing-field scoring.
async function applyFrame(app: Application, frame: Frame, proposed: Proposal[], operation: number) {
  return frameCall(app, frame.frameId, {
    type: "APPLY", documentId: frame.observation.documentId, proposals: proposed,
  }).catch(async (error: Error) => {
    const fresh = await reinspectNavigation(app, frame.frameId, frame.observation.documentId, operation, error, frame.observation.url);
    if (fresh) frame.frameId = fresh.frameId;
    return { results: [], observation: fresh?.observation || frame.observation, navigationInterrupted: Boolean(fresh) };
  });
}
// The fields left empty, each checkbox question once: its boxes are one
// answer, given when any is ticked, and named by the question, not by a box
// ("New York, NY"). one employer's required "locations you would relocate to" was
// listed as two optional boxes.
function emptyFields(fields: Field[]): Field[] {
  const questionOf = (field: Field) => (field.kind === "checkbox" && field.question ? `${field.section || ""}|${field.index ?? 0}|${field.question}` : "");
  const answered = new Set(fields.filter((field) => field.value && questionOf(field)).map(questionOf));
  const listed = new Set<string>();
  return fields.flatMap((field) => {
    if (field.value) return [];
    const question = questionOf(field);
    if (!question) return [field];
    if (answered.has(question) || listed.has(question)) return [];
    listed.add(question);
    return [{ ...field, label: field.question! }];
  });
}
async function reviewInterruptedWrite(app: Application, observation: Observation) {
  app.missing = [
    "The site reloaded during a field write. The interrupted write was not retried; review the remaining fields manually.",
    ...emptyFields(observation.fields).filter((field) => field.required).map((field) => `Required: ${field.label}`),
  ].slice(0, 60);
  touch(app, "awaiting-user", "The application changed during a write. Review the remaining fields before filling again.");
  app.completedAt = Date.now();
  app.explicitFill = false;
  await persist();
}
async function broadcast(app: Application, type: string) {
  if (!app.tabId) return;
  await Promise.allSettled(
    (await allFrames(app.tabId)).map((frame) =>
      frameCall(app, frame.frameId, { type }),
    ),
  );
}
// A document's SHA-256, as hex.
async function digest(data: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
// Frames that verify the visitor or report to the site's own analytics. None
// holds a form, and a bot check is not the extension's to read: access to
// them is never asked for (one employer's li.protechts.net).
function captchaFrame(url: string) {
  const { hostname, pathname } = new URL(url);
  return (
    pathname.startsWith("/recaptcha/") ||
    /(^|\.)hcaptcha\.com$|^challenges\.cloudflare\.com$/.test(hostname) ||
    /(^|\.)(protechts\.net|perimeterx\.net|px-cdn\.net|px-cloud\.net|datadome\.co|arkoselabs\.com|funcaptcha\.com)$/.test(hostname) ||
    // A tag manager's service-worker frame (sgtm.indeed.com).
    /\/service_worker\/[^/]+\/sw_iframe\.html$/.test(pathname) ||
    // A draft-only site's widget inside another site's form ("Apply with
    // an employer" on Lever): never a fill target, and it must not stop the
    // fill of the page around it.
    draftOnlySite(url)
  );
}
// Whether every embedded frame of this origin is hidden or zero-size (a
// cookie manager): it holds no application, so it is no reason to ask for
// access. Unknown when the top page cannot be read: then nothing is skipped.
async function hiddenFrames(tabId: number): Promise<(origin: string) => boolean> {
  const shown = await chrome.scripting
    .executeScript({
      target: { tabId, frameIds: [0] },
      func: () =>
        [...document.querySelectorAll("iframe")].map((frame) => {
          const box = frame.getBoundingClientRect();
          const style = getComputedStyle(frame);
          let origin = "";
          try {
            origin = new URL(frame.src, location.href).origin;
          } catch {
            /* No address. */
          }
          return { origin, shown: box.width > 1 && box.height > 1 && style.visibility !== "hidden" && style.display !== "none" };
        }),
    })
    .then(([result]) => result?.result as { origin: string; shown: boolean }[] | undefined)
    .catch(() => undefined);
  return (origin) =>
    Boolean(shown?.some((frame) => frame.origin === origin)) &&
    !shown?.some((frame) => frame.origin === origin && frame.shown);
}
async function observations(
  app: Application,
  operation: number,
): Promise<{
  frames: Frame[];
  inaccessible: string[];
  accessOrigins: string[];
  frameUrls: string[];
}> {
  const frames: Frame[] = [];
  const inaccessible: string[] = [];
  const accessOrigins: string[] = [];
  if (!app.tabId) throw new Error("Application tab is closed.");
  const descriptions = await allFrames(app.tabId);
  const hiddenOnly = await hiddenFrames(app.tabId);
  for (const frame of descriptions) {
    if (!alive(app, operation)) break;
    if (!/^https?:/.test(frame.url)) {
      if (frame.frameId === 0)
        inaccessible.push("Open a regular HTTP(S) application page.");
      continue;
    }
    // Captcha challenges remain manual even when broad host access has
    // already been granted. Their transient frames are never fill targets.
    if (frame.frameId !== 0 && captchaFrame(frame.url)) continue;
    const origin = new URL(frame.url).origin;
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
      if (frame.frameId !== 0 && hiddenOnly(origin)) continue;
      inaccessible.push(
        frame.frameId === 0 ? `Grant access to this site: ${origin}` : `Grant access to embedded site: ${origin}`,
      );
      accessOrigins.push(accessPattern(origin));
      continue;
    }
    try {
      // See inspectTab: a stalled embedded frame must not hold the whole read.
      await frameDeadline(
        chrome.scripting.executeScript({
          target: { tabId: app.tabId, frameIds: [frame.frameId] },
          files: ["content.js"],
          injectImmediately: true,
        }),
        frame.frameId === 0 ? 20_000 : 6_000,
      );
      if (!alive(app, operation)) break;
      const engine = await frameCall(app, frame.frameId, {
        type: "ENGINE_INFO",
      }).catch(() => undefined);
      if (engine?.version !== CONTENT_VERSION)
        throw new Error(
          // Chrome keeps this worker until the extension is reloaded but reads
          // content.js from disk for every page, so after a rebuild a freshly
          // loaded page can be the newer one; refreshing alone never fixes that.
          "This page and the extension are on different builds. Save any unsaved edits, reload Application Lane in chrome://extensions, refresh the application page, then choose Fill this step.",
        );
      const observation: Observation = await frameCall(app, frame.frameId, {
        type: "BIND",
        locks: locks[app.id] || [],
        replaceSiteValues: Boolean(app.siteFillPending) || state.settings.prefilled !== "keep",
      });
      if (!alive(app, operation)) break;
      frames.push({ frameId: frame.frameId, observation });
    } catch (error) {
      inaccessible.push(
        `Cannot inspect frame at ${origin}: ${(error as Error).message.slice(0, 180)}`,
      );
    }
  }
  return {
    frames,
    inaccessible: [...new Set(inaccessible)],
    accessOrigins: [...new Set(accessOrigins)],
    // Every embedded page's address, read or not: an embedded job board's
    // names its posting (job-boards.eu.greenhouse.io/embed/job_app?for=asm…).
    frameUrls: descriptions.map((frame) => frame.url).filter((url) => /^https:/.test(url) && !captchaFrame(url)),
  };
}

async function inspectTab(
  tabId: number,
  snapshot = false,
): Promise<{ tab: chrome.tabs.Tab; frames: Frame[]; inaccessible: string[]; frameOrigins: string[] }> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url))
    return { tab, frames: [], inaccessible: ["Open an HTTP(S) page."], frameOrigins: [] };
  const frames: Frame[] = [];
  const inaccessible: string[] = [];
  // Embedded frames that may hold the form and are not readable yet (a
  // Greenhouse form inside an employer's careers page).
  const frameOrigins = new Set<string>();
  let hiddenOnly: ((origin: string) => boolean) | undefined;
  for (const frame of await allFrames(tabId)) {
    if (!/^https?:/.test(frame.url)) continue;
    if (frame.frameId !== 0 && captchaFrame(frame.url)) continue;
    const origin = new URL(frame.url).origin;
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
      inaccessible.push(origin);
      if (frame.frameId !== 0 && !captchaFrame(frame.url)) {
        hiddenOnly ??= await hiddenFrames(tabId);
        if (!hiddenOnly(origin)) frameOrigins.add(accessPattern(origin));
      }
      continue;
    }
    try {
      // A frame that never finishes loading (a stalled third-party embed)
      // keeps executeScript pending for good; reading the form must not wait
      // on it. An embedded frame gets less time than the page itself.
      const result = await frameDeadline(
        chrome.scripting
          .executeScript({
            target: { tabId, frameIds: [frame.frameId] },
            files: ["content.js"],
          })
          .then(() =>
            chrome.tabs.sendMessage(
              tabId,
              { type: snapshot ? "SNAPSHOT" : "INSPECT" },
              { frameId: frame.frameId },
            ),
          ),
        frame.frameId === 0 ? 20_000 : 6_000,
      );
      if (!result?.ok) throw new Error(result?.error || "Inspection failed.");
      frames.push({
        frameId: frame.frameId,
        observation: snapshot ? result.data.observation : result.data,
        ...(snapshot ? { html: result.data.html } : {}),
      } as Frame & { html?: string });
    } catch (error) {
      inaccessible.push(`${origin}: ${(error as Error).message.slice(0, 180)}`);
    }
  }
  return { tab, frames, inaccessible: [...new Set(inaccessible)], frameOrigins: [...frameOrigins] };
}

function applicationForTab(tabId: number) {
  return state.applications.find(
    (app) =>
      app.tabs.some((tab) => tab.tabId === tabId && !tab.closedAt) ||
      app.tabId === tabId,
  );
}

function updateRelatedTab(
  app: Application,
  tab: chrome.tabs.Tab,
  fieldCount: number | undefined,
) {
  let related = app.tabs.find((candidate) => candidate.tabId === tab.id);
  if (!related) {
    related = relatedTab(tab, fieldCount);
    app.tabs.push(related);
  }
  related.url = tab.url || tab.pendingUrl || related.url;
  related.title = tab.title || related.title;
  related.fieldCount = fieldCount ?? 0;
  if (fieldCount !== undefined)
    related.role = tabRole(related.url, related.title, fieldCount);
  related.state =
    fieldCount === undefined ? "unscanned" : fieldCount ? "form" : "no-form";
  related.lastSeenAt = Date.now();
  related.closedAt = undefined;
}

async function tabContext(tabId: number): Promise<TabContext> {
  const result = await inspectTab(tabId);
  const url = result.tab.url || "";
  const title = result.tab.title || (url ? new URL(url).hostname : "Tab");
  const primary =
    result.frames.find((frame) => frame.observation.fields.length) ||
    result.frames[0];
  const fieldCount = result.frames.reduce(
    (total, frame) => total + fillable(frame.observation),
    0,
  );
  const linked = applicationForTab(tabId);
  if (linked) {
    updateRelatedTab(linked, result.tab, fieldCount);
    await persist();
  }
  const suggestions: TabContext["suggestions"] = [];
  const seen = new Set<string>();
  const addSuggestion = (
    app: Application | undefined,
    confidence: "strong" | "possible",
    reason: string,
  ) => {
    if (!app || app.id === linked?.id || app.archivedAt || seen.has(app.id))
      return;
    seen.add(app.id);
    suggestions.push({ applicationId: app.id, confidence, reason });
  };
  if (result.tab.openerTabId)
    addSuggestion(
      applicationForTab(result.tab.openerTabId),
      "strong",
      "Opened from a tab in this application",
    );
  if (url) {
    for (const app of state.applications) {
      if (
        [app.sourceUrl, app.url, ...app.tabs.map((tab) => tab.url)].some(
          (candidate) => candidate && canonicalURL(candidate) === canonicalURL(url),
        )
      )
        addSuggestion(app, "strong", "This URL was seen in the application");
      else if (
        new URL(app.sourceUrl).hostname === new URL(url).hostname &&
        normalize(app.title) &&
        normalize(title).includes(normalize(app.title).slice(0, 40))
      )
        addSuggestion(app, "possible", "Same site and a similar position title");
    }
  }
  // The page itself unread for want of access, though a frame inside it was
  // read: Amazon's apply page, where only an empty ad frame could be read, so
  // the panel offered no grant and Fill had no fields to start from.
  const pageDenied =
    /^https?:/.test(url) &&
    !result.frames.some((frame) => frame.frameId === 0) &&
    result.inaccessible.includes(new URL(url).origin);
  const readable = Boolean(result.frames.length) && !pageDenied;
  return {
    tabId,
    url,
    title,
    fieldCount,
    accessible: readable,
    permissionOrigin:
      !readable && /^https?:/.test(url)
        ? accessPattern(new URL(url).origin)
        : undefined,
    // A readable page whose form sits in a frame it may not read yet.
    ...(readable && result.frameOrigins.length ? { frameOrigins: result.frameOrigins } : {}),
    observation: primary?.observation,
    applicationId: linked?.id,
    suggestions,
    ...(draftOnlySite(url) ? { draftOnly: true } : {}),
  };
}
function schedule(delay = 100) {
  clearTimeout(kickTimer);
  kickTimer = setTimeout(() => {
    void pump();
  }, delay);
}
function touch(app: Application, status: Application["status"], note: string) {
  transitionTiming(app, status, Date.now());
  // Nothing is being written once a fill settles: what was current is history.
  if (!["inspecting", "preparing", "filling"].includes(status) && app.progress?.current) {
    if (app.progress.answered.at(-1) !== app.progress.current)
      app.progress.answered = [...app.progress.answered, app.progress.current].slice(-300);
    app.progress.current = undefined;
  }
  app.status = status;
  app.note = note;
  app.updatedAt = Date.now();
  const attempt = app.attempts.at(-1);
  if (attempt && !attempt.completedAt) {
    if (["inspecting", "preparing", "filling"].includes(status))
      attempt.status = "filling";
    else if (status === "queued") attempt.status = "queued";
    attempt.note = note;
    if (["awaiting-user", "ready", "failed", "paused", "cancelled"].includes(status)) {
      attempt.completedAt = Date.now();
      attempt.status =
        status === "ready"
          ? "filled"
          : status === "failed"
            ? "error"
            : status === "paused" || status === "cancelled"
              ? "paused"
              : "needs-review";
      attempt.filled = app.filled;
      app.explicitFill = false;
    }
  }
}
// Fields to fill, plus sections the site config can add rows to: a step
// holding only Add buttons (Oracle's Education) is still fillable.
function fillable(observation: Observation) {
  return observation.fields.length + (observation.addable?.length || 0);
}
function operationKey(frames: Frame[], profileRevision: number) {
  return JSON.stringify([
    profileRevision,
    ...frames.map((f) => [
      f.frameId,
      f.observation.documentId,
      f.observation.atReview,
      f.observation.fields.map((field) => [field.id, field.label]),
    ]),
  ]);
}
async function pump() {
  await initial;
  // A history the backend missed (it was down when an application went in).
  if (!submissionsSynced) void syncSubmissions().catch(() => {});
  if (pumping) return;
  pumping = true;
  try {
    await pollFitChecks();
    await pollDocumentDrafts();
    for (const app of [...state.applications].sort(
      (a, b) => a.updatedAt - b.updatedAt,
    )) {
      if (runners.has(app.id)) continue;
      if (app.status !== "queued" && !activeStatuses.includes(app.status))
        continue;
      if (!app.explicitFill) continue;
      if (runners.size >= state.settings.concurrency) break;
      if (
        app.status === "queued" &&
        state.applications.filter((a) => activeStatuses.includes(a.status))
          .length >= state.settings.concurrency
      )
        continue;
      const origin = new URL(app.url).origin;
      if ((backoff.get(origin) || 0) > Date.now()) continue;
      // At most two application mutations on a single site at once.
      if (
        app.status === "queued" &&
        state.applications.filter(
          (a) =>
            activeStatuses.includes(a.status) &&
            new URL(a.url).origin === origin,
        ).length >= 2
      )
        continue;
      const operation = app.operation;
      runners.set(app.id, operation);
      void run(app, operation)
        .catch(async (error) => {
          if (alive(app, operation)) {
            touch(app, "failed", (error as Error).message);
            app.explicitFill = false;
            app.continueAfterSiteFill = false;
            const attempt = app.attempts.at(-1);
            if (attempt && !attempt.completedAt) {
              attempt.completedAt = Date.now();
              attempt.status = "error";
              attempt.note = (error as Error).message.slice(0, 350);
              attempt.filled = app.filled;
            }
            backoff.set(origin, Date.now() + 3000);
            await persist();
          }
        })
        .finally(async () => {
          runners.delete(app.id);
          if (app.tabId !== undefined && !activeStatuses.includes(app.status))
            await pageTimers(app.tabId, false);
          // Save the fill, and keep observing the applicant's next interaction.
          const recording = app.tabId !== undefined ? recordings.get(app.tabId) : undefined;
          if (recording?.auto && !activeStatuses.includes(app.status) && app.status !== "queued")
            await saveRecording(recording.tabId)
              .then(async (result) => {
                if (result.saved) {
                  app.lastRecordingId = result.recording.id;
                  await persist();
                }
              })
              .catch(() => {});
          if (app.tabId !== undefined && !activeStatuses.includes(app.status) && app.status !== "queued")
            scheduleFillCapture(app);
          // Release the input claim; passive report capture keeps its own.
          if (app.tabId !== undefined) await releaseTrustedInput(app.tabId);
          schedule(500);
        });
    }
  } finally {
    pumping = false;
  }
}
async function pollFitChecks() {
  const checking = state.applications.filter((app) => app.fitJobId);
  await Promise.allSettled(checking.map(async (app) => {
    const id = app.fitJobId!;
    try {
      const job: GenerationJob = await api(`/v1/jobs/${id}`);
      if (app.fitJobId !== id) return;
      if (["queued", "running"].includes(job.status)) return;
      app.fitJobId = undefined;
      if (job.status === "complete" && job.fit) {
        app.fit = job.fit;
        app.fitError = undefined;
      } else {
        app.fitError = job.error || "The fit check was interrupted. Check fit again.";
      }
      await persist();
    } catch (error) {
      // Keep the queued check so a short backend outage can recover.
      if ((error as Error).message === "Job not found." && app.fitJobId === id) {
        app.fitJobId = undefined;
        app.fitError = "This fit check is no longer available. Check fit again.";
        await persist();
      }
    }
  }));
  if (state.applications.some((app) => app.fitJobId)) schedule(1500);
}
async function clearFit(app: Application) {
  const id = app.fitJobId;
  app.fitJobId = undefined;
  app.fit = undefined;
  app.fitError = undefined;
  if (id) await api(`/v1/jobs/${id}`, "DELETE").catch(() => {});
}
// The profile as one application should be answered from: with the job's
// country (from the posting's location) and employer, so authorization,
// sponsorship and "worked here before" questions are asked of this job.
function forApplication(profile: Profile, app: Application): Profile {
  const country = locationCountry(globals as Geography, app.posting?.location);
  return { ...profile, applyingTo: { ...(country ? { country } : {}), ...(app.company ? { company: app.company } : {}) } };
}
async function checkFit(app: Application) {
  if (app.fitJobId) return state;
  const details = () => JSON.stringify([app.title, app.company, app.sourceUrl, app.postingUrl, app.postingText]);
  const original = details();
  const profile: Profile = await api("/v1/profile");
  const captured = app.tabId !== undefined ? await inspectTab(app.tabId).catch(() => undefined) : undefined;
  const frames = captured?.frames || [];
  // A posting the backend is refused (Tesla's), open in a tab: its words
  // from there (: the fit had nothing to go on, link or not).
  // Also whenever the backend has read no posting for it, whatever the page
  // gave: Tesla's apply page read as enough for a "partial" fit, and its
  // posting was never looked for.
  if ((wordCount(app.sourceDescription) < 80 || !app.posting) && !app.postingText) {
    const reread = await postingFromOwnTab(app, frames[0]?.observation, true).catch(() => undefined);
    // Its words only: a changed link would make this check stale (below).
    if (reread) app.sourceDescription = reread.description.slice(0, 12500);
  }
  const job: GenerationJob = await api("/v1/jobs", "POST", {
    purpose: "fit", applicationId: app.id, operation: Date.now(),
    profileRevision: profile.revision, url: app.sourceUrl || app.url,
    title: app.title, company: app.company,
    description: [app.sourceDescription || "", ...frames.map((frame) => frame.observation.description)].join("\n").slice(0, 25000),
    fields: frames.flatMap((frame) => frame.observation.fields).slice(0, 250),
    postingUrl: app.postingUrl, postingText: app.postingText,
    pageUrls: [...new Set([app.url, ...app.tabs.map((tab) => tab.url)])].slice(0, 10),
  });
  if (details() !== original) {
    await api(`/v1/jobs/${job.id}`, "DELETE").catch(() => {});
    return state;
  }
  app.fit = undefined;
  app.fitError = undefined;
  app.fitJobId = job.id;
  await persist();
  schedule();
  return state;
}
// The resume and cover letter for this application, drafted and saved as
// files without anything being written to the page: for a site whose form the
// applicant fills and uploads to by hand.
async function draftDocuments(app: Application) {
  if (app.draftJobId) return state;
  if (app.explicitFill || activeStatuses.includes(app.status))
    throw new Error("Wait for the current fill to finish; it drafts the documents too.");
  const profile: Profile = await api("/v1/profile");
  const captured = app.tabId !== undefined ? await inspectTab(app.tabId).catch(() => undefined) : undefined;
  const frames = captured?.frames || [];
  if (frames[0]) namedByPage(app, (frames.find((frame) => frame.observation.fields.length) || frames[0]).observation);
  // Redrafted for want of the posting: its own tab may show it by now.
  if ((wordCount(app.sourceDescription) < 80 || !app.posting) && !app.postingText) {
    const reread = await postingFromOwnTab(app, frames[0]?.observation, true).catch(() => undefined);
    if (reread) {
      app.sourceDescription = reread.description.slice(0, 12500);
      app.postingUrl ||= reread.url;
    }
  }
  const job: GenerationJob = await api("/v1/jobs", "POST", {
    purpose: "application", applicationId: app.id, operation: Date.now(),
    profileRevision: profile.revision, url: app.sourceUrl || app.url,
    title: app.title, company: app.company || undefined,
    description: [app.sourceDescription || "", ...frames.map((frame) => frame.observation.description)].join("\n").slice(0, 25000),
    // No question of the page's is answered; the letter is asked for by name.
    fields: [{ id: "documents|cover", label: "Cover letter", kind: "file", required: false, value: "", options: [], revision: 0, protected: false, documentKind: "cover" }],
    postingUrl: app.postingUrl, postingText: app.postingText,
    pageUrls: [...new Set([app.url, ...app.tabs.map((tab) => tab.url)])].filter((url) => /^https:/.test(url) && url.length <= 3000).slice(0, 10),
    redraft: true,
  });
  app.draftJobId = job.id;
  app.draftError = undefined;
  await persist();
  schedule();
  return state;
}
async function pollDocumentDrafts() {
  const drafting = state.applications.filter((app) => app.draftJobId);
  await Promise.allSettled(drafting.map(async (app) => {
    const id = app.draftJobId!;
    try {
      const job: GenerationJob = await api(`/v1/jobs/${id}`);
      if (app.draftJobId !== id) return;
      if (["queued", "running"].includes(job.status)) return;
      app.draftJobId = undefined;
      if (job.status === "complete" && job.artifacts.length) {
        app.artifacts = job.artifacts;
        app.documentJobId = job.id;
        app.posting = job.posting;
        if (job.posting) app.title = job.posting.title;
      } else app.draftError = job.error || "The documents were not drafted. Draft them again.";
      await persist();
    } catch (error) {
      if ((error as Error).message === "Job not found." && app.draftJobId === id) {
        app.draftJobId = undefined;
        app.draftError = "This draft is no longer available. Draft the documents again.";
        await persist();
      }
    }
  }));
  if (state.applications.some((app) => app.draftJobId)) schedule(1500);
}
async function questionFields(tabId: number) {
  const captured = await inspectTab(tabId);
  return {
    fields: captured.frames.flatMap((frame) => frame.observation.fields.filter(applicationQuestion).map((field) => ({ ...field, id: `${frame.frameId}|${field.id}` }))),
    inaccessible: captured.inaccessible,
  };
}
async function clearAnswerDrafts(app: Application) {
  answerRequests.delete(app.id);
  const id = app.answerSession?.jobId;
  app.answerSession = undefined;
  if (id) await api(`/v1/jobs/${id}`, "DELETE").catch(() => {});
}
async function draftAnswers(app: Application, tabId: number, ids?: string[]) {
  if (applicationForTab(tabId)?.id !== app.id) throw new Error("This tab belongs to a different application.");
  if (app.explicitFill || activeStatuses.includes(app.status) || answerFills.has(app.id) || fieldFallbackFills.has(app.id)) throw new Error("Wait for the current fill to finish before drafting questions.");
  if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > 250 || ids.some((id) => typeof id !== "string"))) throw new Error("Choose valid questions to draft.");
  if (app.tabId !== tabId) await attachTab(app, tabId);
  await clearAnswerDrafts(app);
  const stamp = crypto.randomUUID();
  answerRequests.set(app.id, stamp);
  const operation = app.operation;
  const profile: Profile = forApplication(await api("/v1/profile"), app);
  const captured = await inspectTab(tabId);
  const fields = captured.frames.flatMap((frame) => frame.observation.fields.map((field) => ({ ...field, id: `${frame.frameId}|${field.id}` }))).slice(0, 250);
  const selected = fields.filter(applicationQuestion).filter((field) => !ids || ids.includes(field.id));
  if (!selected.length) throw new Error("No eligible empty questions were found. Existing answers and protected fields are left for you.");
  if (ids && selected.length !== new Set(ids).size) throw new Error("A question changed or was answered. Scan the page again.");
  if (app.operation !== operation || answerRequests.get(app.id) !== stamp) throw new Error("The page changed. Scan and draft again.");
  const job: GenerationJob = await api("/v1/jobs", "POST", {
    purpose: "answers", applicationId: app.id, operation: Date.now(),
    profileRevision: profile.revision, url: app.sourceUrl || app.url,
    title: app.title, company: app.company,
    description: [app.sourceDescription || "", ...captured.frames.map((frame) => frame.observation.description)].join("\n").slice(0, 25000),
    fields, questionIds: selected.map((field) => field.id),
    postingUrl: app.postingUrl, postingText: app.postingText,
    pageUrls: [...new Set([captured.tab.url || app.url, ...app.tabs.map((tab) => tab.url)])].slice(0, 10),
  });
  if (app.operation !== operation || answerRequests.get(app.id) !== stamp) {
    await api(`/v1/jobs/${job.id}`, "DELETE").catch(() => {});
    throw new Error("The page changed while drafting. Scan and draft again.");
  }
  app.answerSession = {
    jobId: job.id, tabId, operation, profileRevision: profile.revision,
    frames: captured.frames.map((frame) => ({ frameId: frame.frameId, documentId: frame.observation.documentId,
      fields: frame.observation.fields.filter((field) => selected.some((selectedField) => selectedField.id === `${frame.frameId}|${field.id}`)),
    })).filter((frame) => frame.fields.length),
  };
  await persist();
  return state;
}
async function fillReviewedAnswers(app: Application, message: any) {
  if (await draftOnlyTab(message.tabId, app.url)) throw new Error(DRAFT_ONLY_NOTE);
  const session = app.answerSession;
  if (!session || session.jobId !== message.jobId || session.tabId !== message.tabId || app.operation !== session.operation) throw new Error("These drafts are stale. Scan and draft the current page again.");
  if (app.explicitFill || activeStatuses.includes(app.status) || answerFills.has(app.id) || fieldFallbackFills.has(app.id)) throw new Error("Wait for the current fill to finish.");
  const selected = message.answers as { fieldId: string; value: string }[];
  if (!Array.isArray(selected) || !selected.length || selected.length > 250 || selected.some((answer) => !answer || typeof answer.fieldId !== "string" || typeof answer.value !== "string" || !answer.value.trim() || answer.value.length > 4000) || new Set(selected.map((answer) => answer.fieldId)).size !== selected.length) throw new Error("Choose valid reviewed answers to fill.");
  answerFills.add(app.id);
  let fillOperation: number | undefined;
  const results: { fieldId: string; ok: boolean; reason?: string }[] = [];
  try {
    const [profile, job, captured]: [Profile, GenerationJob, Awaited<ReturnType<typeof inspectTab>>] = await Promise.all([
      api("/v1/profile"), api(`/v1/jobs/${session.jobId}`), inspectTab(session.tabId),
    ]);
    if (profile.revision !== session.profileRevision || app.operation !== session.operation || app.answerSession !== session || job.status !== "complete") throw new Error("The profile or page changed. Draft these questions again.");
    for (const answer of selected) {
      const frame = session.frames.find((frame) => frame.fields.some((field) => `${frame.frameId}|${field.id}` === answer.fieldId));
      const field = frame?.fields.find((field) => `${frame.frameId}|${field.id}` === answer.fieldId);
      if (!frame || !field || !job.answerDrafts?.some((draft) => draft.fieldId === answer.fieldId)) throw new Error("This answer is not part of the current review.");
      const limit = answerLimitError(answer.value, field);
      if (limit) throw new Error(`${field.label.slice(0, 80)}: ${limit}`);
    }
    if (session.tabId !== app.tabId) throw new Error("Make this tab the application's fill target, then draft again.");
    app.operation++;
    fillOperation = app.operation;
    touch(app, "filling", "Filling reviewed answers…");
    await persist();
    for (const snapshot of session.frames) {
      const answers = selected.filter((answer) => snapshot.fields.some((field) => `${snapshot.frameId}|${field.id}` === answer.fieldId));
      if (!answers.length) continue;
      const frame = captured.frames.find((frame) => frame.frameId === snapshot.frameId);
      if (!alive(app, fillOperation)) throw new Error("The reviewed fill was paused or superseded.");
      if (!frame || frame.observation.documentId !== snapshot.documentId) {
        results.push(...answers.map((answer) => ({ fieldId: answer.fieldId, ok: false, reason: "The page navigated or reloaded. Draft again." })));
        continue;
      }
      const proposals: Proposal[] = [];
      for (const answer of answers) {
        const original = snapshot.fields.find((field) => `${snapshot.frameId}|${field.id}` === answer.fieldId)!;
        const current = frame.observation.fields.find((field) => field.id === original.id);
        if (!current || !applicationQuestion(current) || current.revision !== original.revision || current.label !== original.label || current.value !== original.value) {
          results.push({ fieldId: answer.fieldId, ok: false, reason: "This field changed, was answered, or is protected. Your edits were kept." });
          continue;
        }
        const limit = answerLimitError(answer.value, current);
        if (limit) { results.push({ fieldId: answer.fieldId, ok: false, reason: limit }); continue; }
        proposals.push({ fieldId: original.id, value: answer.value, expectedValue: original.value, revision: original.revision, source: "reviewed-answer" });
      }
      if (!proposals.length) continue;
      try {
        await frameCall(app, frame.frameId, { type: "BIND", documentId: snapshot.documentId, locks: locks[app.id] || [], replaceSiteValues: false });
        if (!alive(app, fillOperation)) throw new Error("Fill was paused or superseded.");
        await frameCall(app, frame.frameId, { type: "RESUME", documentId: snapshot.documentId });
        if (!alive(app, fillOperation)) throw new Error("Fill was paused or superseded.");
        const result = await frameCall(app, frame.frameId, { type: "APPLY", documentId: snapshot.documentId, proposals });
        results.push(...result.results.map((result: { id: string; ok: boolean; reason?: string }) => ({ fieldId: `${frame.frameId}|${result.id}`, ok: result.ok, reason: result.reason })));
      } catch (error) {
        results.push(...proposals.map((proposal) => ({ fieldId: `${snapshot.frameId}|${proposal.fieldId}`, ok: false, reason: (error as Error).message })));
      }
    }
    if (alive(app, fillOperation)) {
      session.operation = fillOperation;
      const count = results.filter((result) => result.ok).length;
      app.filled += count;
      touch(app, "awaiting-user", `${count} reviewed answer${count === 1 ? "" : "s"} filled. Review the form before continuing.`);
      await persist();
    }
    return { state, results };
  } finally {
    if (fillOperation !== undefined && app.operation === fillOperation) {
      if (app.status === "filling") touch(app, "awaiting-user", "Reviewed fill stopped. Review the form and draft again if needed.");
      await broadcast(app, "PAUSE");
      await releaseTrustedInput(session.tabId);
      await persist();
    }
    answerFills.delete(app.id);
  }
}
// Why the fill stopped for the applicant, naming the event that did it: a
// pause nobody remembers causing could not be traced afterwards.
const interactedNote = (cause: unknown) =>
  `You interacted with this application${typeof cause === "string" && cause ? ` (${cause.replace(/\s+/g, " ").slice(0, 100)})` : ""}. Choose Fill this step when ready.`;

// An application moves to a stage: by the applicant's choice, or because
// the site showed its confirmation (siteSubmitted).
const submittedNote = "The site confirmed this application was submitted. Change its stage if that is wrong.";
// A form framed in an employer's page (Greenhouse on one employer's and
// Roblox's careers sites) shows its confirmation as a new document in that
// frame, with no page script in it: one is put there, in an application's
// tab still being applied to, so it can say whether that is what it is.
// Frames without access are passed over.
chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) return;
  void initial.then(() => {
    const app = state.applications.find((a) => a.tabId === tabId && a.status !== "cancelled");
    if (!app || app.confirmedBySite || !["applying", "review"].includes(app.workflowStage)) return;
    void chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] }).catch(() => {});
  });
});

// A wait in a page's fill, ended from here: a hidden tab's own timers run
// about once a minute (content.ts, pause). At most a minute each.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "lane-wake") return;
  port.onMessage.addListener((message: { id?: unknown; ms?: unknown }) => {
    if (typeof message?.id !== "number") return;
    const ms = Math.min(Math.max(0, Number(message.ms) || 0), 60_000);
    setTimeout(() => {
      try {
        port.postMessage({ id: message.id });
      } catch {
        // The page went away.
      }
    }, ms);
  });
});

// The backend's history of applications that went in (SubmissionRecord).
const submissionRecord = (app: Application) => ({
  applicationId: app.id,
  company: app.company.slice(0, 300),
  title: app.title.slice(0, 500),
  url: app.url.slice(0, 3000),
  ...(app.ats ? { ats: app.ats.slice(0, 200) } : {}),
  submittedAt: app.submittedAt || app.stageUpdatedAt || app.updatedAt,
  confirmedBySite: Boolean(app.confirmedBySite),
});
// Applications submitted before the history existed, or while the backend
// was unreachable, are added to it once it answers.
let submissionsSynced = false;
async function syncSubmissions() {
  if (submissionsSynced || !token) return;
  const submitted = state.applications.filter((app) => app.workflowStage === "submitted");
  if (submitted.length) await api("/v1/submissions", "POST", { entries: submitted.map(submissionRecord) });
  submissionsSynced = true;
}
// A finished application has nothing left to fill: the note asking for
// Fill this step (left by a profile change) is replaced.
const finishedStages: Application["workflowStage"][] = ["submitted", "blocked", "abandoned"];
const finishedNote = (app: Application) =>
  app.workflowStage === "submitted"
    ? app.confirmedBySite ? submittedNote : "Marked submitted."
    : app.workflowStage === "blocked" ? `Blocked${app.blockedReason ? `: ${app.blockedReason}` : "."}` : "Abandoned.";

function tidyFinishedNotes() {
  for (const app of state.applications)
    if (finishedStages.includes(app.workflowStage) && /Choose Fill this step|Choose another related tab|Scan it, then choose/.test(app.note || ""))
      app.note = finishedNote(app);
}

async function setStage(app: Application, stage: Application["workflowStage"], reason?: unknown, bySite = false) {
  const was = app.workflowStage;
  if (bySite) app.confirmedBySite = true;
  if (
    ["submitted", "blocked", "abandoned"].includes(stage) &&
    (app.explicitFill || activeStatuses.includes(app.status))
  )
    await invalidate(app, "paused", `Fill paused because this application is now ${stage}.`);
  app.workflowStage = stage;
  app.stageUpdatedAt = Date.now();
  app.blockedReason = stage === "blocked" ? String(reason || "").slice(0, 350) : undefined;
  app.submittedAt = stage === "submitted" ? Date.now() : undefined;
  // Said with the stage, so the card never shows one without the other.
  if (bySite) {
    app.note = submittedNote;
    app.updatedAt = Date.now();
  }
  // The history: added when it goes in, removed when it is moved back out
  // (it was marked by mistake). Kept for a later sync if the backend is away.
  if (stage === "submitted")
    await api("/v1/submissions", "POST", { entries: [submissionRecord(app)] }).catch(() => { submissionsSynced = false; });
  else if (was === "submitted")
    await api(`/v1/submissions/${app.id}`, "DELETE").catch(() => {});
  // The documents' folder moves under Sent, and back if this is reopened.
  const documentJob = app.documentJobId || app.jobId;
  if (documentJob && app.artifacts.length)
    await api(`/v1/jobs/${documentJob}/files`, "POST", {
      sent: stage === "submitted",
      company: app.company,
      title: app.title,
    }).catch(() => {});
  await persist();
}
// The site drew its own "application submitted" page or banner in this
// application's tab (content.ts). The applicant pressed Submit; this only
// saves them marking it. A stage they set themselves afterwards stands.
async function siteSubmitted(app: Application) {
  if (app.confirmedBySite || !["applying", "review"].includes(app.workflowStage) || app.status === "cancelled") return;
  await setStage(app, "submitted", undefined, true);
}
// Progress is written to storage a few times a second at most.
let progressTimer: ReturnType<typeof setTimeout> | undefined;
function noteProgress(app: Application, label: string) {
  const progress = app.progress || { answered: [] };
  if (progress.current && progress.current !== label && progress.answered.at(-1) !== progress.current)
    progress.answered = [...progress.answered, progress.current].slice(-300);
  progress.current = label;
  app.progress = progress;
  progressTimer ||= setTimeout(() => {
    progressTimer = undefined;
    void persist();
  }, 300);
}

async function clearFieldFallback(app: Application) {
  fieldFallbackRequests.delete(app.id);
  const id = app.fieldFallbackSession?.jobId;
  app.fieldFallbackSession = undefined;
  if (id) await api(`/v1/jobs/${id}`, "DELETE").catch(() => {});
}
// A field of one row of a repeated section (a school, a job) carries what
// the rest of its row holds, for the model to tell which entry it is.
function withRows(fields: Field[]): Field[] {
  return fields.map((field) => {
    if (!field.section || field.index === undefined) return field;
    const row = fields
      .filter((other) => other !== field && other.section === field.section && other.index === field.index && other.value && !/^(file|password|hidden)$/.test(other.kind))
      .map((other) => `${other.label.replace(/^\W+/, "").slice(0, 60)}: ${other.value.slice(0, 80)}`)
      .join("; ");
    return row ? { ...field, row: `Entry ${field.index + 1} of "${field.section.slice(0, 80)}": ${row}`.slice(0, 1000) } : field;
  });
}
function fallbackProblems(
  captured: Awaited<ReturnType<typeof inspectTab>>,
  profile: Profile,
) {
  const problems: FieldFallbackProblem[] = [];
  const frames: { frameId: number; documentId: string; fields: Field[] }[] = [];
  // Open legal or eligibility questions the model is not to answer.
  const legalLeft: string[] = [];
  const legalToo = legalAsked(profile);
  for (const frame of captured.frames) {
    const planned = new Set(
      proposals(frame.observation.fields, profile).map(
        (proposal) => proposal.fieldId,
      ),
    );
    // A list the fill answered (one box of it ticked) is not left: the
    // sanctions list given "None of the above" was still listed.
    const answeredLists = new Set(
      frame.observation.fields
        .filter((field) => field.question && (planned.has(field.id) || listAnswered(field, profile)))
        .map((field) => field.question),
    );
    if (!legalToo)
      legalLeft.push(
        ...frame.observation.fields
          .filter((field) => !planned.has(field.id) && !(field.question && answeredLists.has(field.question)) &&
            structuredFallbackField(field, true) && !structuredFallbackField(field))
          .map((field) => field.label),
      );
    const fields = withRows(frame.observation.fields)
      .filter((field) => structuredFallbackField(field, legalToo) && !(field.question && answeredLists.has(field.question)))
      .slice(0, Math.max(0, 100 - problems.length));
    if (!fields.length) continue;
    frames.push({
      frameId: frame.frameId,
      documentId: frame.observation.documentId,
      fields,
    });
    problems.push(
      ...fields.map((field) => ({
        fieldId: `${frame.frameId}|${field.id}`,
        label: field.label,
        question: field.question,
        section: field.section,
        kind: field.kind,
        required: field.required,
        options: field.options,
        reason: planned.has(field.id)
          ? "Normal fill found a saved value, but the field remained empty."
          : "Normal fill could not match this field to saved profile information or its available choices.",
      })),
    );
    if (problems.length >= 100) break;
  }
  return { problems, frames, legalLeft: [...new Set(legalLeft)] };
}
async function unresolvedFields(
  app: Application,
  tabId: number,
  captured?: Awaited<ReturnType<typeof inspectTab>>,
  profile?: Profile,
) {
  // A draft-only site never has a fill behind it: every open field is one
  // to suggest a value for.
  const attempted =
    (await draftOnlyTab(tabId)) ||
    app.attempts.some((attempt) => attempt.tabId === tabId && Boolean(attempt.completedAt));
  if (
    applicationForTab(tabId)?.id !== app.id ||
    app.tabId !== tabId ||
    !attempted ||
    // Paused by the applicant's own click (Amazon): the fill is
    // over, and what it left is still theirs to review.
    !["awaiting-user", "ready", "paused"].includes(app.status)
  )
    return {
      available: false,
      problems: [] as FieldFallbackProblem[],
      frames: [] as {
        frameId: number;
        documentId: string;
        fields: Field[];
      }[],
      inaccessible: [] as string[],
      legalLeft: [] as string[],
    };
  const currentProfile: Profile = profile || (await api("/v1/profile"));
  const current = captured || (await inspectTab(tabId));
  return {
    available: true,
    ...fallbackProblems(current, currentProfile),
    inaccessible: current.inaccessible,
  };
}
async function draftFieldFallback(
  app: Application,
  tabId: number,
  ids?: string[],
) {
  if (app.explicitFill || activeStatuses.includes(app.status))
    throw new Error("Wait for the current fill to finish.");
  if (answerFills.has(app.id) || fieldFallbackFills.has(app.id))
    throw new Error("Wait for the current reviewed fill to finish.");
  if (
    ids !== undefined &&
    (!Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== "string"))
  )
    throw new Error("Choose valid unresolved fields to review.");
  // As Fill read it, so both agree on what is left (graduation by role).
  const profile: Profile = forApplication(await api(`/v1/profile/application?title=${encodeURIComponent(app.title)}`).catch(() => api("/v1/profile")), app);
  const captured = await inspectTab(tabId);
  const scanned = await unresolvedFields(app, tabId, captured, profile);
  if (!scanned.available)
    throw new Error("Choose Fill this step before asking AI to review what remains.");
  const selected = scanned.problems.filter(
    (problem) => !ids || ids.includes(problem.fieldId),
  );
  if (!selected.length)
    throw new Error("No empty structured fields are eligible for AI review.");
  if (ids && selected.length !== new Set(ids).size)
    throw new Error("A field changed or was filled. Scan the remaining fields again.");
  await clearFieldFallback(app);
  const stamp = crypto.randomUUID();
  fieldFallbackRequests.set(app.id, stamp);
  const operation = app.operation;
  const selectedIds = new Set(selected.map((problem) => problem.fieldId));
  // Dropdowns that list their options only once opened have none yet. Read
  // them now (nothing is chosen): a suggestion must be one of them.
  for (const frame of captured.frames) {
    const unread = frame.observation.fields.filter(
      (field) => selectedIds.has(`${frame.frameId}|${field.id}`) && !field.options.length && /combobox|listbox|select/.test(field.kind),
    );
    // Reading them means opening the dropdown, which a draft-only site is spared.
    if (!unread.length || draftOnlySite(frame.observation.url)) continue;
    optionReads.add(app.id);
    const read: { id: string; options: string[] }[] = await frameCall(app, frame.frameId, {
      type: "BIND",
      documentId: frame.observation.documentId,
      locks: locks[app.id] || [],
      replaceSiteValues: false,
    })
      .then(() => frameCall(app, frame.frameId, { type: "OPTIONS", documentId: frame.observation.documentId, fieldIds: unread.map((field) => field.id) }))
      .catch(() => [])
      .finally(() => optionReads.delete(app.id));
    for (const { id, options } of read) {
      const field = frame.observation.fields.find((candidate) => candidate.id === id);
      if (field) field.options = options;
      for (const listed of [...selected, ...scanned.frames.flatMap((snapshot) => (snapshot.frameId === frame.frameId ? snapshot.fields : []))])
        if (("fieldId" in listed ? listed.fieldId : `${frame.frameId}|${listed.id}`) === `${frame.frameId}|${id}`) listed.options = options;
    }
  }
  if (app.operation !== operation || fieldFallbackRequests.get(app.id) !== stamp)
    throw new Error("The page changed while preparing the review. Scan again.");
  const fields = captured.frames
    .flatMap((frame) =>
      withRows(frame.observation.fields).map((field) => ({
        ...field,
        id: `${frame.frameId}|${field.id}`,
      })),
    )
    .filter((field) => selectedIds.has(field.id));
  const job: GenerationJob = await api("/v1/jobs", "POST", {
    purpose: "field-fallback",
    applicationId: app.id,
    operation: Date.now(),
    profileRevision: profile.revision,
    url: captured.tab.url || app.url,
    title: app.title,
    company: app.company,
    description: "",
    fields,
    questionIds: selected.map((problem) => problem.fieldId),
    fallbackReasons: selected.map((problem) => ({
      fieldId: problem.fieldId,
      reason: problem.reason,
    })),
    legalAnswers: state.settings.legalQuestions === "model" ? "any" : "details",
  });
  if (
    app.operation !== operation ||
    fieldFallbackRequests.get(app.id) !== stamp
  ) {
    await api(`/v1/jobs/${job.id}`, "DELETE").catch(() => {});
    throw new Error("The page changed while preparing the review. Scan again.");
  }
  app.fieldFallbackSession = {
    jobId: job.id,
    tabId,
    operation,
    profileRevision: profile.revision,
    problems: selected,
    frames: scanned.frames
      .map((frame) => ({
        ...frame,
        fields: frame.fields.filter((field) =>
          selectedIds.has(`${frame.frameId}|${field.id}`),
        ),
      }))
      .filter((frame) => frame.fields.length),
  };
  await persist();
  return state;
}
async function fillFieldFallback(app: Application, message: any) {
  if (await draftOnlyTab(message.tabId, app.url)) throw new Error(DRAFT_ONLY_NOTE);
  const session = app.fieldFallbackSession;
  if (
    !session ||
    !session.jobId ||
    session.jobId !== message.jobId ||
    session.tabId !== message.tabId ||
    app.operation !== session.operation
  )
    throw new Error("These suggestions are stale. Review the current fields again.");
  if (
    app.explicitFill ||
    activeStatuses.includes(app.status) ||
    answerFills.has(app.id) ||
    fieldFallbackFills.has(app.id)
  )
    throw new Error("Wait for the current fill to finish.");
  const selected = message.answers as { fieldId: string; value: string }[];
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    selected.length > 100 ||
    selected.some(
      (answer) =>
        !answer ||
        typeof answer.fieldId !== "string" ||
        typeof answer.value !== "string" ||
        !answer.value.trim() ||
        answer.value.length > 4000,
    ) ||
    new Set(selected.map((answer) => answer.fieldId)).size !== selected.length
  )
    throw new Error("Choose valid reviewed suggestions to fill.");
  fieldFallbackFills.add(app.id);
  let fillOperation: number | undefined;
  const results: { fieldId: string; ok: boolean; reason?: string }[] = [];
  try {
    const [profile, job, captured]: [
      Profile,
      GenerationJob,
      Awaited<ReturnType<typeof inspectTab>>,
    ] = await Promise.all([
      api("/v1/profile"),
      api(`/v1/jobs/${session.jobId}`),
      inspectTab(session.tabId),
    ]);
    if (
      profile.revision !== session.profileRevision ||
      app.operation !== session.operation ||
      app.fieldFallbackSession !== session ||
      job.status !== "complete"
    )
      throw new Error("The profile or page changed. Ask AI to review the fields again.");
    for (const answer of selected) {
      const frame = session.frames.find((candidate) =>
        candidate.fields.some(
          (field) => `${candidate.frameId}|${field.id}` === answer.fieldId,
        ),
      );
      const field = frame?.fields.find(
        (candidate) => `${frame.frameId}|${candidate.id}` === answer.fieldId,
      );
      const draft = job.fieldDrafts?.find(
        (candidate) => candidate.fieldId === answer.fieldId,
      );
      if (!frame || !field || !draft)
        throw new Error("This suggestion is not part of the current review.");
      if (
        field.options.length &&
        !field.options.some(
          (option) => normalize(option) === normalize(answer.value),
        )
      )
        throw new Error(`${field.label.slice(0, 80)}: choose an available option.`);
      if (field.maxLength && answer.value.length > field.maxLength)
        throw new Error(
          `${field.label.slice(0, 80)}: use at most ${field.maxLength} characters.`,
        );
    }
    if (session.tabId !== app.tabId)
      throw new Error("Make this tab the application's fill target, then review again.");
    app.operation++;
    fillOperation = app.operation;
    touch(app, "filling", "Filling reviewed AI suggestions…");
    await persist();
    for (const snapshot of session.frames) {
      const answers = selected.filter((answer) =>
        snapshot.fields.some(
          (field) => `${snapshot.frameId}|${field.id}` === answer.fieldId,
        ),
      );
      if (!answers.length) continue;
      const frame = captured.frames.find(
        (candidate) => candidate.frameId === snapshot.frameId,
      );
      if (!alive(app, fillOperation))
        throw new Error("The reviewed fill was paused or superseded.");
      if (!frame || frame.observation.documentId !== snapshot.documentId) {
        results.push(
          ...answers.map((answer) => ({
            fieldId: answer.fieldId,
            ok: false,
            reason: "The page navigated or reloaded. Review the current fields again.",
          })),
        );
        continue;
      }
      const pending: Proposal[] = [];
      for (const answer of answers) {
        const original = snapshot.fields.find(
          (field) => `${snapshot.frameId}|${field.id}` === answer.fieldId,
        )!;
        const current = frame.observation.fields.find(
          (field) => field.id === original.id,
        );
        if (
          !current ||
          !structuredFallbackField(current, legalAsked(profile)) ||
          current.revision !== original.revision ||
          current.label !== original.label ||
          current.value !== original.value
        ) {
          results.push({
            fieldId: answer.fieldId,
            ok: false,
            reason: "This field changed, was filled, or is protected. Its current value was kept.",
          });
          continue;
        }
        pending.push({
          fieldId: original.id,
          value: answer.value,
          expectedValue: original.value,
          revision: original.revision,
          source: "reviewed-field-fallback",
        });
      }
      if (!pending.length) continue;
      try {
        await frameCall(app, frame.frameId, {
          type: "BIND",
          documentId: snapshot.documentId,
          locks: locks[app.id] || [],
          replaceSiteValues: false,
        });
        if (!alive(app, fillOperation))
          throw new Error("Fill was paused or superseded.");
        await frameCall(app, frame.frameId, {
          type: "RESUME",
          documentId: snapshot.documentId,
        });
        const applied = await frameCall(app, frame.frameId, {
          type: "APPLY",
          documentId: snapshot.documentId,
          proposals: pending,
        });
        frame.observation = applied.observation;
        results.push(
          ...applied.results.map(
            (result: { id: string; ok: boolean; reason?: string }) => ({
              fieldId: `${frame.frameId}|${result.id}`,
              ok: result.ok,
              reason: result.reason,
            }),
          ),
        );
      } catch (error) {
        results.push(
          ...pending.map((proposal) => ({
            fieldId: `${snapshot.frameId}|${proposal.fieldId}`,
            ok: false,
            reason: (error as Error).message,
          })),
        );
      }
    }
    if (alive(app, fillOperation)) {
      session.operation = fillOperation;
      const filled = new Set(
        results.filter((result) => result.ok).map((result) => result.fieldId),
      );
      session.problems = session.problems.filter(
        (problem) => !filled.has(problem.fieldId),
      );
      for (const frame of session.frames)
        frame.fields = frame.fields.filter(
          (field) => !filled.has(`${frame.frameId}|${field.id}`),
        );
      const count = filled.size;
      app.filled += count;
      touch(
        app,
        "awaiting-user",
        `${count} reviewed AI suggestion${count === 1 ? "" : "s"} filled. Review the form before continuing.`,
      );
      await persist();
    }
    return { state, results };
  } finally {
    if (fillOperation !== undefined && app.operation === fillOperation) {
      if (app.status === "filling")
        touch(app, "awaiting-user", "Reviewed fill stopped. Review the form before continuing.");
      await broadcast(app, "PAUSE");
      await releaseTrustedInput(session.tabId);
      await persist();
    }
    fieldFallbackFills.delete(app.id);
  }
}
// The options of a step's empty dropdowns that show none until opened (see
// OPTIONS in content.ts: Workday's from its questionnaire where it lists
// them, else opened and closed with nothing chosen). A draft-only site is
// spared the opening.
async function readListOptions(app: Application, frame: { frameId: number; observation: Observation }) {
  if (draftOnlySite(frame.observation.url)) return;
  const unread = frame.observation.fields.filter(
    (field) => !field.value && !field.protected && !field.options.length && /combobox|listbox/.test(field.kind),
  );
  if (!unread.length) return;
  const read: { id: string; options: string[] }[] = await frameCall(app, frame.frameId, {
    type: "OPTIONS",
    documentId: frame.observation.documentId,
    fieldIds: unread.map((field) => field.id),
    // Only list buttons (Workday's) during a fill: opening a SuccessFactors
    // or react-select list then got in the way of its own fill, which picks
    // from the open list anyway (suite).
    listButtonsOnly: true,
  }).catch(() => []);
  for (const { id, options } of Array.isArray(read) ? read : []) {
    const field = frame.observation.fields.find((candidate) => candidate.id === id);
    if (field && Array.isArray(options)) field.options = options.filter((option) => typeof option === "string").slice(0, 300);
  }
}

async function run(app: Application, operation: number) {
  if (!app.startedAt) app.startedAt = Date.now();
  // Each look at whether its documents are ready runs this again: one still
  // tailoring stays "Tailoring" rather than flicking to "Reading form" and
  // back every few seconds.
  if (app.status !== "preparing") {
    touch(app, "inspecting", "Reading application fields…");
    await persist();
  }
  const tab =
    app.tabId && (await chrome.tabs.get(app.tabId).catch(() => undefined));
  if (!tab)
    throw new Error(
      "Application tab is closed. Reopen or queue its URL again.",
    );
  await pageTimers(tab.id!, true);
  if (tab.status === "loading") {
    // A stalled third-party resource (an ad pixel, an embed) can keep a tab
    // loading for good after its own document is ready. Give the page time,
    // then go on once the document itself has been parsed.
    const since = loadingSince.get(app.id) ?? Date.now();
    loadingSince.set(app.id, since);
    const parsed =
      Date.now() - since >= 10_000 &&
      (await frameDeadline(
        chrome.scripting.executeScript({
          target: { tabId: tab.id!, frameIds: [0] },
          injectImmediately: true,
          func: () => document.readyState !== "loading",
        }),
        3_000,
      ).then(
        (results) => results[0]?.result === true,
        () => false,
      ));
    if (!alive(app, operation)) return;
    if (!parsed) {
      touch(app, "queued", "Waiting for the application page to load…");
      await persist();
      schedule(2_000);
      return;
    }
  }
  // Server-rendered select inputs can precede React's handlers. Do not write
  // the other fields during that gap: mounting can discard those writes.
  // Share the existing page-readiness budget and inspect without opening or
  // mutating a control. A component that never attaches remains manual.
  const componentsReady = await frameDeadline(
    chrome.scripting.executeScript({
      target: { tabId: tab.id!, frameIds: [0] },
      world: "MAIN",
      injectImmediately: true,
      func: () => {
        const inputs = document.querySelectorAll<HTMLInputElement>(
          '.select__container input[role="combobox"][aria-autocomplete="list"], ' +
          '.select-shell input[role="combobox"][aria-autocomplete="list"], ' +
          '.select__control input[role="combobox"][aria-autocomplete="list"]',
        );
        return Array.from(inputs).every(input => {
          const key = Object.getOwnPropertyNames(input).find(key =>
            key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"),
          );
          let fiber = key ? (input as any)[key] : undefined;
          let instance: any;
          let committedRoot: any;
          // A host fiber alone does not establish the select's readiness.
          // Require the same API and option storage that the writer uses.
          for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
            if (typeof fiber.stateNode?.selectOption === "function" &&
                Array.isArray(fiber.stateNode.props?.options)) instance ??= fiber.stateNode;
            if (fiber.tag === 3) committedRoot = fiber.stateNode?.current;
          }
          if (!instance) return false;
          if (!committedRoot) return true;
          // Hydration can attach a host fiber and construct the select before
          // committing it. Calling that instance can discard the SSR form.
          const stack = [committedRoot];
          for (let visited = 0; stack.length && visited < 10_000; visited++) {
            const current = stack.pop()!;
            if (current.stateNode === instance) return true;
            if (current.child) stack.push(current.child);
            if (current.sibling) stack.push(current.sibling);
          }
          return false;
        });
      },
    }),
    3_000,
  ).then(results => results[0]?.result === true, () => true);
  if (!alive(app, operation)) return;
  if (!componentsReady) {
    const since = loadingSince.get(app.id) ?? Date.now();
    loadingSince.set(app.id, since);
    if (Date.now() - since < 10_000) {
      touch(app, "queued", "Waiting for the application controls to load…");
      await persist();
      schedule(2_000);
      return;
    }
  }
  // Keep an exhausted budget through generation/polling of this same fill.
  // Otherwise a permanently absent handler would start a new wait each pass.
  // A parsed form may still be loading an unrelated resource. Its next pass
  // after document generation must reuse that wait, rather than start another
  // ten-second loading budget. A new fill/navigation resets it separately.
  if (componentsReady && tab.status !== "loading") loadingSince.delete(app.id);
  // As this application should state it: an internship and a full-time role
  // can name different graduation dates (preferences.md, graduation by role).
  const profile: Profile = forApplication(
    await api(`/v1/profile/application?title=${encodeURIComponent(app.title)}`).catch(() => api("/v1/profile")),
    app,
  );
  if (!alive(app, operation)) return;
  if (!profile.confirmed || !profile.facts.length)
    throw new Error(
      "Save and confirm your profile before preparing applications.",
    );
  if (app.profileRevision && app.profileRevision !== profile.revision)
    throw new Error("Profile changed. Choose Fill this step with the updated profile.");
  app.profileRevision = profile.revision;
  const { frames, inaccessible, accessOrigins, frameUrls } = await observations(
    app,
    operation,
  );
  if (!alive(app, operation)) return;
  app.accessOrigins = accessOrigins;
  if (frames.some((f) => f.observation.paused)) {
    touch(
      app,
      "paused",
      interactedNote(frames.find((f) => f.observation.paused)?.observation.pausedBy),
    );
    await persist();
    return;
  }
  if (!frames.length) {
    app.missing = inaccessible;
    touch(
      app,
      "awaiting-user",
      inaccessible.join(" ") || "No accessible form found.",
    );
    await persist();
    return;
  }
  const primary =
    frames.find((f) => f.observation.fields.length > 0) || frames[0];
  // The posting's own title, once found, outranks the page's heading.
  app.title = app.posting?.title || primary.observation.title || app.title;
  namedByPage(app, primary.observation);
  app.ats = primary.observation.ats;
  const totalFields = frames.reduce(
    (n, f) => n + fillable(f.observation),
    0,
  );
  if (!totalFields) {
    // A posting with no form: its Apply leads to the form, and this request
    // carries on there (Amazon's posting). Used once per
    // posting, so a page that leads back here is never pressed again.
    if (!accessOrigins.length && (primary.observation.description.match(/\S+/g)?.length || 0) >= 40 &&
        app.tabId !== undefined && !app.applyUsed?.from.includes(canonicalURL(app.url)) && (app.applyUsed?.from.length || 0) < 3) {
      const from = app.url;
      const used = await useApply(app, app.tabId, operation).catch(() => undefined);
      if (used) {
        // The page it was pressed on is the posting, for tailoring.
        if (!app.postingUrl && !app.postingText) {
          app.postingUrl = from;
          app.postingSought = true;
          app.sourceDescription ||= primary.observation.description.slice(0, 12500);
        }
        touch(app, "awaiting-user", `Pressed "${used}" on the posting. Filling the form it opens…`);
        await persist();
        return;
      }
    }
    // The page itself can be the unreadable one while frames inside it are
    // read (Amazon's apply page on account.amazon.jobs, access given on
    // amazon.jobs, with only ad frames readable): ask for that access.
    if (accessOrigins.length) app.missing = inaccessible;
    touch(
      app,
      "awaiting-user",
      accessOrigins.length
        ? inaccessible.join(" ")
        : "Open the application form or sign in, then choose Fill this step.",
    );
    await persist();
    return;
  }
  dirty.delete(app.id);

  // Some uploaders parse the resume and rewrite the whole form with it (iCIMS
  // reloads the page). Anything filled before that upload is lost, so the
  // resume goes first and alone; the next request fills what is left.
  const resumeFirst = !app.siteFillTried && frames.some((frame) =>
    frame.observation.fields.some(
      (field) =>
        field.kind === "file" &&
        field.replacesForm &&
        !field.value &&
        !field.protected,
    ),
  );
  // Fill deterministic fields while document generation runs independently.
  touch(
    app,
    "filling",
    resumeFirst
      ? "Uploading your resume first; this site fills the form from it…"
      : "Filling confirmed profile fields…",
  );
  await persist();
  const writeFailures: string[] = [];
  for (const frame of resumeFirst ? [] : frames) {
    if (!alive(app, operation)) return;
    if (configEngineEnabled) {
      const result = await frameCall(app, frame.frameId, {
        type: "CONFIG_FILL",
        documentId: frame.observation.documentId,
        documentURL: frame.observation.url,
        profile,
      }).catch(async (error: Error) => {
        // A navigation can destroy a config response after its click already
        // happened. Rebind a fresh document on the same application URL, never
        // resend that config command (it might contain a click or upload).
        const fresh = await reinspectNavigation(app, frame.frameId, frame.observation.documentId, operation, error, frame.observation.url);
        if (!fresh) return { statuses: [], observation: frame.observation };
        frame.frameId = fresh.frameId;
        writeFailures.push("The site reloaded during a configured step. Remaining fields were re-inspected; review the interrupted step manually.");
        return { statuses: [{ key: "navigation", status: "skipped", reason: "Document changed; the interrupted command was not retried." }], observation: fresh.observation, ats: fresh.observation.ats };
      });
      if (!alive(app, operation)) return;
      app.filled += result.statuses.filter(
        (status: { status: string }) => status.status === "filled",
      ).length;
      // A search that was typed but never picked looks filled on the page.
      for (const status of result.statuses as { caution?: string }[])
        if (status.caution) writeFailures.push(status.caution);
      // The config steps that failed, kept with the application so an issue
      // report says which step stopped and why. Not shown on the card.
      app.configNotes = (result.statuses as { key: string; status: string; reason?: string }[])
        .filter((status) => status.status === "failed")
        .map((status) => `${status.key}: ${status.reason || "failed"}`.slice(0, 200))
        .slice(0, 60);
      frame.observation = result.observation;
      if (result.ats) app.ats = result.ats;
    }
    // Dropdowns that list their answers only once opened are read first, so
    // an answer is chosen from the site's own list rather than guessed:
    // one employer's "…in that country?" was held back for want of one, and its
    // phone type was guessed as "Mobile" against "Home Cellular".
    await readListOptions(app, frame);
    if (!alive(app, operation)) return;
    const plan = proposals(frame.observation.fields, profile);
    if (plan.length) {
      const result = await applyFrame(app, frame, plan, operation);
      if (result.navigationInterrupted) {
        await reviewInterruptedWrite(app, result.observation);
        return;
      }
      if (!alive(app, operation)) return;
      app.filled += result.results.filter((r: { ok: boolean }) => r.ok).length;
      // A refused write is otherwise invisible: say which field and why.
      for (const refused of result.results as {
        id: string;
        ok: boolean;
        reason?: string;
      }[])
        if (!refused.ok) {
          const field = (result.observation as Observation).fields.find(
            (f) => f.id === refused.id,
          );
          if (field && !field.value)
            writeFailures.push(
              `${field.label}: not filled (${refused.reason || "refused"}).`,
            );
        }
      frame.observation = result.observation;
    }
  }
  if (!alive(app, operation)) return;
  const key = operationKey(frames, profile.revision);
  // The form changing (a site filling it from the resume, a row added) is no
  // reason to tailor the documents again: they are written for the posting,
  // once. Finished documents are kept; only unfinished work starts over.
  if (app.generationKey && app.generationKey !== key && app.jobId) {
    const finished: GenerationJob | undefined = await api(`/v1/jobs/${app.jobId}`).catch(() => undefined);
    if (finished?.status === "complete" && finished.artifacts.length > 0 && finished.profileRevision === profile.revision)
      app.generationKey = key;
  }
  if (app.generationKey && app.generationKey !== key && app.jobId) {
    await api(`/v1/jobs/${app.jobId}`, "DELETE").catch(() => {});
    app.operation++;
    app.jobId = undefined;
    app.artifacts = [];
    app.narrative = undefined;
    app.generationKey = undefined;
    touch(
      app,
      "queued",
      "The form changed. Re-inspecting before generating new answers.",
    );
    await persist();
    return;
  }
  // Tracked before the page that led here was looked for (an application
  // from before this was added): it is looked for once, before drafting.
  if (!app.jobId && !app.postingUrl && !app.postingText && !app.postingSought && app.tabId !== undefined) {
    app.postingSought = true;
    const tab = await chrome.tabs.get(app.tabId).catch(() => undefined);
    const led = tab && (await leadingPage(tab, frames[0]?.observation, app).catch(() => undefined));
    if (!alive(app, operation)) return;
    if (led) {
      app.postingUrl = led.url;
      if (led.description) app.sourceDescription = `${led.description.slice(0, 12500)}\n${app.sourceDescription || ""}`;
      await persist();
    } else if (!app.postingText && guessedAgain(app)) {
      app.postingUrl = postingGuess(app.url);
      if (app.postingUrl) await persist();
    }
  }
  // Tracked from a posting its site draws by script, read before it was
  // drawn, and filled in the tab its Apply opened: the posting's own tab,
  // still open, is read again for its words (Tesla: the backend
  // is refused the page, and the letter said nothing about the job).
  if (!app.jobId && wordCount(app.sourceDescription) < 80) {
    const reread = await postingFromOwnTab(app, frames[0]?.observation).catch(() => undefined);
    if (!alive(app, operation)) return;
    if (reread) {
      app.sourceDescription = reread.description.slice(0, 12500);
      app.postingUrl ||= reread.url;
      await persist();
    }
  }
  if (!app.jobId) {
    const job: GenerationJob = await api("/v1/jobs", "POST", {
      applicationId: app.id,
      operation,
      profileRevision: profile.revision,
      url: app.url,
      title: app.title,
      company: app.company || undefined,
      description: [
        app.sourceDescription || "",
        ...frames.map((f) => f.observation.description),
      ]
        .join("\n")
        .slice(0, 25000),
      fields: [
        ...frames.flatMap((f) =>
          f.observation.fields.map((field) => ({
            ...field,
            id: `${f.frameId}|${field.id}`,
          })),
        ),
        // A cover letter slot drawn without a file box (SuccessFactors'
        // attachment widget) still takes a letter: asked for by name, as
        // draftDocuments does.
        ...(frames.some((f) => f.observation.documentSlots?.includes("cover")) &&
          !frames.some((f) => f.observation.fields.some((field) => field.documentKind === "cover"))
          ? [{ id: "documents|cover", label: "Cover letter", kind: "file", required: false, value: "", options: [], revision: 0, protected: false, documentKind: "cover" as const }]
          : []),
      ].slice(0, 250),
      // The pages being filled: one may lead to the posting when the
      // tracked URL does not (Intel's was its account page).
      ...(app.postingUrl ? { postingUrl: app.postingUrl } : {}),
      ...(app.postingText ? { postingText: app.postingText } : {}),
      pageUrls: [
        ...new Set([
          ...frames.map((f) => f.observation.url),
          ...frameUrls,
          ...app.tabs.map((tab) => tab.url),
        ]),
      ]
        .filter((url) => /^https:/.test(url) && url !== app.url && url.length <= 3000)
        .slice(0, 10),
    });
    if (!alive(app, operation)) {
      await api(`/v1/jobs/${job.id}`, "DELETE").catch(() => {});
      return;
    }
    app.jobId = job.id;
    app.generationKey = key;
    await persist();
  }
  const job: GenerationJob = await api(`/v1/jobs/${app.jobId}`);
  if (!alive(app, operation)) return;
  if (
    job.operation !== operation ||
    job.applicationId !== app.id ||
    job.profileRevision !== profile.revision
  )
    throw new Error("Generation belongs to a superseded application revision.");
  // A backend restart (npm run dev reloads on every source edit) fails jobs
  // it was still running; nothing was wrong with them, so ask again.
  if (job.status === "failed" && /^Backend restarted/.test(job.error || "")) {
    app.operation++;
    app.jobId = undefined;
    app.artifacts = [];
    app.narrative = undefined;
    app.generationKey = undefined;
    touch(app, "queued", "The backend restarted while tailoring. Starting the documents again…");
    await persist();
    return;
  }
  if (["failed", "cancelled"].includes(job.status))
    throw new Error(
      job.error || "Generation was cancelled. Retry this application.",
    );
  if (job.status !== "complete") {
    touch(
      app,
      "preparing",
      "Tailoring documents while other applications continue…",
    );
    await persist();
    return;
  }
  app.artifacts = job.artifacts;
  app.documentJobId = job.id;
  app.posting = job.posting;
  // A fit check is independent of a fill; its verdict remains on the tracker.
  if (!app.fitJobId) app.fit = job.fit;
  // The posting's own title replaces a page's guess ("Work Summary").
  if (job.posting) app.title = job.posting.title;

  touch(app, "filling", "Applying supported answers and attaching documents…");
  await persist();
  const generationWarnings = job.narrative?.warnings || [];
  const issues = [...generationWarnings, ...inaccessible, ...writeFailures];
  if (!resumeFirst) {
    // Rows the site added from the resume that match no profile school.
    const allFields = frames.flatMap((frame) => frame.observation.fields);
    const educationRows = new Map<number, Observation["fields"]>();
    for (const field of allFields)
      if (/education/.test(normalize(field.section || "")))
        educationRows.set(field.index || 0, [
          ...(educationRows.get(field.index || 0) || []),
          field,
        ]);
    if (educationRows.size > profile.education.length) {
      const paired = historyRowMap(allFields, profile);
      // Highest first, so removing one row does not renumber the next.
      for (const [page, rowFields] of [...educationRows].sort((a, b) => b[0] - a[0])) {
        const kept = paired.size
          ? paired.has(`education:${page}`)
          : page < profile.education.length;
        if (kept || !rowFields.some((field) => field.value)) continue;
        const school = rowFields.find((field) => /school|university|institution/i.test(field.label) && field.value);
        const described = `Education row ${page + 1}${school ? ` ("${school.value.slice(0, 60)}")` : ""}`;
        // Only a row that holds nothing but the site's own guesses, made
        // from a resume this extension uploaded, is removed.
        const siteMade =
          app.siteFillPending &&
          rowFields.every((field) => !field.value || field.siteValue);
        const section = rowFields.find((field) => field.section)?.section || "Education";
        const frame = frames.find((candidate) =>
          candidate.observation.fields.some((field) => rowFields.includes(field)),
        );
        const removed =
          siteMade && frame
            ? await frameCall(app, frame.frameId, { type: "REMOVE_ROW", section, index: page })
                .then((result: { removed?: boolean }) => Boolean(result?.removed))
                .catch(() => false)
            : false;
        issues.push(
          removed
            ? `${described} was added by the site from your resume and is not in your profile, so it was removed.`
            : `${described} is not in your profile; the site probably added it from your resume. Remove it if it is a duplicate.`,
        );
      }
    }
  }
  for (const frame of frames) {
    if (!alive(app, operation)) return;
    const pending: Proposal[] = [];
    // Written answers are the model's: filled only where the applicant's
    // setting lets the model fill, and never for a legal question it is not
    // to answer.
    for (const answer of modelFills().written ? job.narrative?.answers || [] : []) {
      const prefix = `${frame.frameId}|`;
      if (!answer.fieldId.startsWith(prefix)) continue;
      const field = frame.observation.fields.find(
        (f) => f.id === answer.fieldId.slice(prefix.length),
      );
      if (field && !field.protected && !field.value && leftAsLegal(field.label)) {
        issues.push(`Legal or eligibility question left for you: ${field.label}`);
        continue;
      }
      if (field && !field.protected && !field.value) noteAiFilled(app, field.label, answer.value);
      if (field && !field.protected && !field.value)
        pending.push({
          fieldId: field.id,
          value: answer.value,
          expectedValue: field.value,
          revision: field.revision,
          source: "confirmed-facts",
        });
    }
    // Cover-letter text boxes use the same reviewed, fact-grounded document text.
    for (const field of frame.observation.fields)
      if (
        /cover.?letter/i.test(field.label) &&
        field.kind === "textarea" &&
        !field.value &&
        !field.protected
      )
        pending.push({
          fieldId: field.id,
          value: [...job.narrative!.coverLetter.map((p) => p.text), `Sincerely,\n${`${profile.firstName} ${profile.lastName}`.trim()}`].join("\n\n"),
          expectedValue: "",
          revision: field.revision,
          source: "cover-letter",
        });
    // The resume goes alone; the site is about to rewrite these fields.
    if (resumeFirst) pending.length = 0;
    if (pending.length) {
      const result = await applyFrame(app, frame, pending, operation);
      if (result.navigationInterrupted) {
        await reviewInterruptedWrite(app, result.observation);
        return;
      }
      if (!alive(app, operation)) return;
      frame.observation = result.observation;
      app.filled += result.results.filter((r: { ok: boolean }) => r.ok).length;
      for (const refused of result.results.filter((r: { ok: boolean }) => !r.ok))
        issues.push(`Answer not filled: ${frame.observation.fields.find((field) => field.id === refused.id)?.label.slice(0, 80) || "a question"}. ${refused.reason || "The field changed."}`);
    }
    // The document kinds this page has a file field for, as the step began:
    // a site that swaps an uploaded file's input for its name (Greenhouse's
    // job boards) has none afterwards, and the dialog upload below must not
    // then remove that upload to make its own (issue report).
    const fileKind = (f: Field) => f.documentKind || documentKind(f.label);
    const fieldKinds = new Set(frame.observation.fields.filter((f) => f.kind === "file").map(fileKind));
    // A resume the site held before this extension (Amazon keeps the
    // account's) gives way to this application's own, as answers
    // the site filled in do, or when the applicant asks for it. Never one
    // this application uploaded: a site that rewrites the form from it
    // (iCIMS) reloads before the upload is confirmed, and shows it as its own.
    const heldBySite = (f: Field) => fileKind(f) === "resume" && Boolean(f.value) && !f.attachmentId &&
      !app.uploadedDocuments?.resume && !app.siteFillTried && !app.siteFillPending &&
      (f.siteValue || (Boolean(app.replaceDocuments) && f.protectedReason === "existing value"));
    for (const field of frame.observation.fields.filter(
      (f) =>
        f.kind === "file" &&
        (!f.value || f.attachmentId || heldBySite(f)) &&
        (!f.protected || heldBySite(f)) &&
        (!resumeFirst || f.replacesForm),
    )) {
      if (!alive(app, operation)) return;
      const kind = fileKind(field);
      const held = heldBySite(field);
      if (!kind) {
        issues.push(`Choose a file manually: ${field.label}`);
        continue;
      }
      const accepts = (artifact: Artifact) =>
        !field.accept ||
        field.accept
          .split(",")
          .some((a) =>
            [
              `.${artifact.format}`,
              artifact.mime,
              "*/*",
              "application/*",
            ].includes(a.trim().toLowerCase()),
          );
      // A transcript is one degree's: a field naming a level gets that
      // level's or none (see shared/transcripts.ts).
      const picked = kind === "transcript" ? pickTranscript(field.label, job.artifacts.filter(accepts), profile) : undefined;
      if (picked?.missing) {
        issues.push(`Upload your ${picked.missing} transcript yourself for "${field.label}", or attach it to its school under Education in the dashboard. Another degree's was not used.`.slice(0, 350));
        continue;
      }
      const artifact = picked ? picked.artifact : job.artifacts.find((a) => a.kind === kind && accepts(a));
      if (!artifact && kind === "transcript" && !job.artifacts.some((a) => a.kind === "transcript")) {
        issues.push(`No transcript to upload for ${field.label}: add yours under Settings, in the dashboard.`);
        continue;
      }
      if (!artifact) {
        issues.push(`No supported document format: ${field.label}`);
        continue;
      }
      if (field.attachmentId === artifact.id) continue;
      const bytes = await api(`/v1/artifacts/${artifact.id}`);
      if (!alive(app, operation)) return;
      // A continuation reuses the document under a fresh operation's ID.
      // An upload already confirmed by this extension, still retained under
      // the exact filename and containing identical bytes, is not sent again.
      const fingerprint = await digest(bytes.data);
      const memo = artifact.education !== undefined ? `${kind}:${artifact.education}` : kind;
      if ((field.attachmentId || held) && field.value === artifact.name &&
        app.uploadedDocuments?.[memo] === fingerprint) continue;
      // Workday empties its file input once the upload is done and lists the
      // file beside it: the same document already shown there is not sent
      // again on a second fill.
      if (app.uploadedDocuments?.[memo] === fingerprint &&
        (await frameCall(app, frame.frameId, { type: "ATTACHED", name: artifact.name }).catch(() => undefined))?.attached) continue;
      if (!alive(app, operation)) return;
      // The site rewrites the form from this upload, often reloading before
      // the upload can be confirmed; what it parses may be replaced later.
      if (resumeFirst && field.replacesForm) {
        app.siteFillPending = true;
        app.continueAfterSiteFill = true;
        app.siteFillTried = true;
        await persist();
      }
      // The field as the page now reads, not as the step began: an upload
      // before it redraws its group (Workday's shared uploader, where the
      // resume goes first), and the cover letter sent with the revision read
      // before that was refused as stale and never uploaded.
      const now = frame.observation.fields.find((f) => f.id === field.id) ||
        frame.observation.fields.find((f) => f.kind === "file" && fileKind(f) === kind && f.label === field.label);
      if (!now) {
        issues.push(`Verify upload: ${field.label}`);
        continue;
      }
      try {
        const result = await frameCall(app, frame.frameId, {
          type: "ATTACH",
          documentId: frame.observation.documentId,
          fieldId: now.id,
          expectedValue: now.value,
          revision: now.revision,
          artifact: bytes,
          profile,
          replaceExisting: held,
        });
        if (!alive(app, operation)) return;
        frame.observation = result.observation;
        // Workday empties the input once the upload is done and lists the
        // file elsewhere on the page: the name shown there confirms it.
        const shown = !result.siteError && !result.attached &&
          (await frameCall(app, frame.frameId, { type: "ATTACHED", name: artifact.name }).catch(() => undefined))?.attached;
        if (!alive(app, operation)) return;
        if (result.siteError)
          issues.push(
            `${field.label} upload failed on the site: "${result.siteError}". Reload the page, then choose Fill this step.`,
          );
        else if (!result.attached && !shown) issues.push(`Verify upload: ${field.label}`);
        else {
          app.uploadedDocuments = { ...app.uploadedDocuments, [memo]: fingerprint };
          if (held) {
            const note = `Replaced the ${field.label} the site already had with this application's tailored one.`;
            if (!app.configNotes?.includes(note)) app.configNotes = [...(app.configNotes || []), note];
          }
          await persist();
        }
      } catch (error) {
        if (!alive(app, operation)) return;
        issues.push((error as Error).message);
      }
    }
    if (!alive(app, operation)) return;
    // Sites that upload through a dialog (SuccessFactors' "Upload a Resume")
    // show no file field until it opens. A document with no file field of its
    // kind on the page goes through the site config's upload steps instead.
    // Not in an embedded frame with nothing in it: Microsoft's near-empty
    // profile export frame, gone by then, turned the rule's uploads into a
    // résumé and cover letter reported as failed while the résumé was in.
    if (configEngineEnabled && !resumeFirst && (frame.frameId === 0 || frame.observation.fields.length)) {
      for (const field of frame.observation.fields.filter((f) => f.kind === "file")) fieldKinds.add(fileKind(field));
      // One document at a time: SuccessFactors saves an upload and then
      // reloads the whole form from its server (recording),
      // dropping whatever was filled and not yet saved, and an upload still
      // under way when that happens is lost.
      let uploaded = false;
      for (const kind of ["resume", "cover"] as const) {
        const artifact =
          job.artifacts.find((a) => a.kind === kind && a.format === "pdf") ||
          job.artifacts.find((a) => a.kind === kind);
        const key = `${frame.observation.documentId}|${kind}`;
        if (!artifact || fieldKinds.has(kind) || configUploads.has(key)) continue;
        const bytes = await api(`/v1/artifacts/${artifact.id}`);
        if (!alive(app, operation)) return;
        // Already attached by this application: its config steps would
        // remove it to upload it again. A file of the same name is not
        // enough (an earlier application's "Alex_Rivera_Cover_Letter.pdf"),
        // so it must be the very document this application uploaded.
        const fingerprint = await digest(bytes.data);
        const attached = await frameCall(app, frame.frameId, { type: "ATTACHED", name: artifact.name }).catch(() => undefined);
        if (attached?.attached && app.uploadedDocuments?.[kind] === fingerprint) continue;
        const before = frame.observation.fields.length;
        const result = await frameCall(app, frame.frameId, {
          type: "CONFIG_FILL",
          documentId: frame.observation.documentId,
          documentURL: frame.observation.url,
          profile,
          onlyKeys: [kind === "cover" ? "coverLetter" : "resume"],
          uploads: { [kind]: bytes },
        }).catch((error: Error) => ({ statuses: [{ key: kind, status: "failed", reason: error.message }] }));
        if (!alive(app, operation)) return;
        const statuses = (result.statuses || []) as { key: string; status: string; reason?: string }[];
        app.configNotes = [
          ...(app.configNotes || []),
          ...statuses
            .filter((status) => status.status !== "filled")
            .map((status) => `upload ${status.key}: ${status.reason || status.status}`.slice(0, 200)),
        ].slice(0, 80);
        if (statuses.some((status) => status.status === "filled")) {
          configUploads.add(key);
          app.uploadedDocuments = { ...app.uploadedDocuments, [kind]: fingerprint };
          await persist();
          uploaded = true;
          // Until the site has reloaded the form (it loses fields), or for
          // ten seconds when it does not.
          for (let waited = 0; waited < 10; waited++) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (!alive(app, operation)) return;
            const now: Observation | undefined = await frameCall(app, frame.frameId, { type: "INSPECT", documentId: frame.observation.documentId }).catch(() => undefined);
            if (now && now.fields.length < before) {
              await new Promise((resolve) => setTimeout(resolve, 2000));
              break;
            }
          }
        } else
          for (const status of statuses)
            // A page with no upload of this kind is not a failed upload.
            if (status.status === "failed" && !/No configured selector matched/i.test(status.reason || ""))
              issues.push(
                `${kind === "cover" ? "Cover letter" : "Resume"} upload did not finish${status.reason ? ` (${status.reason})` : ""}. Upload it yourself.`.slice(0, 350),
              );
      }
      if (!alive(app, operation)) return;
      // The form may have been reset by the uploads: fill it again from the
      // start. The documents are not uploaded twice.
      if (uploaded) {
        // A new generation request follows (its answers are for the form as
        // it now is); the backend hands back this application's finished
        // documents instead of tailoring them again.
        app.operation++;
        app.jobId = undefined;
        app.artifacts = [];
        app.narrative = undefined;
        app.generationKey = undefined;
        touch(app, "queued", "Documents uploaded; the site reloaded the form. Filling it again…");
        await persist();
        return;
      }
    }
    // The site is now parsing the resume and may reload; nothing else here
    // is worth reading until it settles.
    if (resumeFirst) continue;
    // Allow reactive validators and upload parsers to settle before inspecting.
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (!alive(app, operation)) return;
    const beforeUploadInspection = frame.observation.documentId;
    let resetAfterUpload = false;
    frame.observation = await frameCall(app, frame.frameId, {
      type: "INSPECT",
      documentId: frame.observation.documentId,
    }).catch(async (error: Error) => {
      // An embedded frame with nothing to fill that the page has since
      // removed (Microsoft's sign-in helpers come and go) is no part of the
      // form: it ended the whole fill with "Receiving end does not exist".
      if (frame.frameId !== 0 && !frame.observation.fields.length && /receiving end does not exist|no frame with id \d+/i.test(error.message))
        return frame.observation;
      const fresh = await reinspectNavigation(app, frame.frameId, frame.observation.documentId, operation, error, frame.observation.url);
      if (!fresh) return frame.observation;
      frame.frameId = fresh.frameId;
      resetAfterUpload = true;
      return fresh.observation;
    });
    if (!alive(app, operation)) return;
    if (!resetAfterUpload && frame.observation.documentId !== beforeUploadInspection) {
      // A fresh content script can answer INSPECT successfully after a fast
      // reload. Detect the changed document even when no port error occurred.
      const tab = app.tabId && await chrome.tabs.get(app.tabId).catch(() => undefined);
      if (!tab || canonicalURL(tab.url || "") !== canonicalURL(app.url) || frame.observation.paused) return;
      const fresh = (await observations(app, operation)).frames.find((candidate) => candidate.frameId === frame.frameId);
      if (!alive(app, operation) || !fresh || fresh.observation.paused) return;
      frame.observation = fresh.observation;
      dirty.delete(app.id);
      resetAfterUpload = true;
    }
    if (resetAfterUpload) {
      // An upload may already have reached the site. Refill only confirmed
      // scalar answers in the fresh document; never repeat uploads or config
      // actions, and require the applicant to review the interrupted upload.
      issues.push("The site reloaded during upload. Confirm the uploaded documents manually; the upload was not repeated.");
      const plan = proposals(frame.observation.fields, profile);
      if (plan.length) {
        const applied = await applyFrame(app, frame, plan, operation);
        if (applied.navigationInterrupted) {
          await reviewInterruptedWrite(app, applied.observation);
          return;
        }
        if (!alive(app, operation)) return;
        app.filled += applied.results.filter((result: { ok: boolean }) => result.ok).length;
        frame.observation = applied.observation;
      }
    }
    issues.push(...frame.observation.blockers);
    issues.push(
      ...emptyFields(frame.observation.fields)
        .filter((f) => f.required)
        .map((f) =>
          f.protected
            ? `Required: ${f.label} (left alone: ${f.protectedReason || "protected"})${
                // A lock from an earlier edit on a field that is empty again
                // (the page was reloaded) keeps the field empty until released.
                /edit lock/.test(f.protectedReason || "")
                  ? " Choose Unlock empty fields to have it filled."
                  : ""
              }`
            : `Required: ${f.label}`,
        ),
    );
    issues.push(
      ...frame.observation.fields
        .filter((f) => f.invalid)
        .map((f) => `Site validation failed: ${f.label}`),
    );
    issues.push(
      ...frame.observation.fields
        .filter((f) => f.validationWarning)
        .map((f) => `${f.label}: ${f.validationWarning}`),
    );
    issues.push(
      ...frame.observation.fields
        .filter((f) => f.fillWarning && !f.value)
        .map((f) => `${f.label}: ${f.fillWarning}`),
    );
    issues.push(
      ...frame.observation.fields
        .filter((f) => f.conflict)
        .map(
          (f) =>
            `Site changed an autofilled value: ${f.label}. Please verify it.`,
        ),
    );
    issues.push(
      ...frame.observation.fields
        .filter(
          (f) =>
            f.kind === "file" &&
            f.value &&
            (!f.attachmentId ||
              !job.artifacts.some((a) => a.id === f.attachmentId)) &&
            // What this application uploaded, shown again on a later page
            // (Amazon's next step), is its own document.
            !(Object.keys(app.uploadedDocuments || {}).some((key) => key.split(":")[0] === (f.documentKind || documentKind(f.label) || "resume")) &&
              job.artifacts.some((a) => a.kind === (f.documentKind || documentKind(f.label)) && a.name === f.value)),
        )
        .map(
          (f) =>
            `Review existing document: ${f.label}. It was preserved and may differ from the newly generated version.`,
        ),
    );
    issues.push(
      ...emptyFields(frame.observation.fields)
        .filter((f) => f.protected && !f.required)
        .map((f) => `Protected: ${f.label} (${f.protectedReason || "left alone"})`),
    );
    issues.push(
      ...emptyFields(frame.observation.fields)
        .filter((f) => !f.protected && !f.required)
        .map((f) => `Optional unanswered: ${f.label}`),
    );
  }
  if (!alive(app, operation)) return;
  const unresolved = resumeFirst
    ? [
        "Resume uploaded first: this site fills the form from it and may reload the page. When it settles, choose Fill this step to fill what it left empty.",
        ...issues.filter((issue) => /upload|document|file|access/i.test(issue)),
      ]
    : [...new Set(issues)];
  // Whole questions: a long one's ask comes last ("If you qualify, please
  // select yes."), and cut at 350 it was gone, as was
  // the match that clears it once answered. Labels are already clipped at
  // 1000 where they are read.
  app.missing = unresolved.slice(0, 60).map((issue) => issue.slice(0, 1100));
  app.replaceDocuments = false;
  if (unresolved.length > 60)
    app.missing.push(
      "Additional unresolved fields remain. Review the full application.",
    );
  // Without the debugger permission (the Chrome Web Store build) Workday's
  // date boxes, which take only real keystrokes, may not keep what was set.
  if (storeBuild && !trustedTypingAvailable() && /workday/i.test(app.url || ""))
    app.missing.push(
      "Check each date on this page (Month, Day, Year): this version of the extension cannot type into Workday's date boxes, so type any date that is empty or wrong yourself.",
    );
  if (!resumeFirst) {
    // A value in a job's or school's row that the profile's own row holds,
    // though no rule answers it: a Workday job's Month and Year, its
    // description, whether it is current. The site's
    // reading of the resume got it right.
    // Pre-filled education or work details the profile could not correct.
    for (const frame of frames)
      for (const field of frame.observation.fields)
        if (
          field.siteValue &&
          /education|experience|employment|work/.test(normalize(field.section || "")) &&
          // A list showing its prompt holds nothing the site parsed (Avature's
          // University/School, "Select an option").
          !/^(?:please )?(?:select|choose)(?: an?| one)?(?: option)?\.{0,3}$/i.test(field.value.trim()) &&
          !rowHolds(field, frame.observation.fields, profile) &&
          // What the site parsed is already the profile's answer (a GPA of
          // 3.84 with the profile's 3.84, an employer): confirmed, so
          // nothing was written and nothing needs checking.
          !proposals([{ ...field, value: "", siteValue: false, protected: false }], profile).some(
            (answer) => normalize(answer.value) === normalize(field.value) ||
              (answer.choices || []).some((choice) => normalize(choice) === normalize(field.value)),
          )
        )
          app.missing.push(
            `${field.label}: "${(field.valueText || field.value).slice(0, 80)}" was filled in by the site from your resume and not corrected. Check it.`,
          );
    app.siteFillPending = false;
  }
  if (!resumeFirst && !frames.some((f) => f.observation.atReview))
    app.missing.push(
      "Verify any remaining steps; no recognized final review screen was detected.",
    );
  if (app.steps >= 12)
    app.missing.push("Step limit reached. Continue manually.");
  // The model's part comes next: marked as running before the status reads
  // as finished, so nothing shows "needs you" in between.
  const assisted = !resumeFirst && app.tabId !== undefined && modelFills().assist;
  if (assisted) app.assisting = true;
  touch(
    app,
    app.missing.length ? "awaiting-user" : "ready",
    generationWarnings.length
      ? "Drafts prepared with recovery warnings. Review documents before continuing."
      : app.missing.length
        ? "Your attention is needed. Review the items below."
        : "Prepared. Review your documents and answers, then submit manually.",
  );
  app.completedAt = Date.now();
  app.explicitFill = false;
  const attempt = app.attempts.at(-1);
  if (attempt && !attempt.completedAt) {
    attempt.completedAt = Date.now();
    attempt.status = app.missing.length ? "needs-review" : "filled";
    attempt.note = app.note;
    attempt.filled = app.filled;
  }
  if (app.tabId !== undefined) await releaseTrustedInput(app.tabId);
  // The model's part, once the profile's is done: suggestions for fields
  // the rules did not recognise, filled or drafted as the setting says. It
  // is marked as running before the fill reads as finished.
  await persist();
  if (assisted) void assist(app, app.tabId!);
  // A site that reloads after the resume upload carries the fill on from the
  // tab's "complete" event (below). One that rewrites the form in place
  // (Paylocity closes its dialog and fills the page) fires no such event, so
  // the same requested fill carries on here once the form stops changing.
  if (resumeFirst && app.continueAfterSiteFill && app.tabId !== undefined) {
    const tabId = app.tabId;
    const request = app.operation;
    void (async () => {
      let previous = -1;
      let steady = 0;
      for (let waited = 0; waited < 20 && steady < 2; waited++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!app.continueAfterSiteFill || app.operation !== request || app.tabId !== tabId) return;
        const count = (await inspectTab(tabId).catch(() => undefined))?.frames.reduce((total, frame) => total + frame.observation.fields.length, 0) ?? -1;
        steady = count >= 0 && count === previous && waited >= 3 ? steady + 1 : 0;
        previous = count;
      }
      if (!app.continueAfterSiteFill || app.operation !== request || app.tabId !== tabId || app.status !== "awaiting-user") return;
      app.note = "The site filled the form from your resume. Correcting and completing it…";
      await persist();
      await resume(app, { operation: request, tabId }).catch(() => {});
    })();
  }
}

async function invalidate(
  app: Application,
  status: "paused" | "cancelled",
  note: string,
) {
  answerRequests.delete(app.id);
  if (app.answerSession) void api(`/v1/jobs/${app.answerSession.jobId}`, "DELETE").catch(() => {});
  fieldFallbackRequests.delete(app.id);
  if (app.fieldFallbackSession?.jobId)
    void api(`/v1/jobs/${app.fieldFallbackSession.jobId}`, "DELETE").catch(() => {});
  app.fieldFallbackSession = undefined;
  app.operation++;
  app.explicitFill = false;
  app.continueAfterSiteFill = false;
  app.replaceDocuments = false;
  touch(app, status, note);
  const attempt = app.attempts.at(-1);
  if (attempt && !attempt.completedAt) {
    attempt.completedAt = Date.now();
    attempt.status = "paused";
    attempt.note = note;
    attempt.filled = app.filled;
  }
  if (app.tabId !== undefined) await releaseTrustedInput(app.tabId);
  await persist();
  await broadcast(app, "PAUSE");
  if (app.jobId) await api(`/v1/jobs/${app.jobId}`, "DELETE").catch(() => {});
  app.jobId = undefined;
  app.generationKey = undefined;
  await persist();
  schedule();
}
// What the applicant's setting lets the model do in a fill (model.ts).
function modelFills() {
  const mode = state.settings.modelFill || "auto";
  return {
    mode,
    // Its written answers go into the page as part of the fill.
    written: mode === "auto" || mode === "written",
    // After the fill it suggests values for what the rules left open.
    assist: mode === "auto" || mode === "review",
  };
}
const leftAsLegal = (label: string) => state.settings.legalQuestions !== "model" && legalQuestion(label);
// Whether legal and eligibility questions go to the model at all: when the
// applicant lets it answer them, or has saved legal details to answer from.
const legalAsked = (profile: Profile) => state.settings.legalQuestions === "model" || hasLegalDetails(profile);
function noteAiFilled(app: Application, label: string, value: string) {
  const entry = { label: label.slice(0, 200), value: value.replace(/\s+/g, " ").slice(0, 120) };
  app.aiFilled = [...(app.aiFilled || []).filter((other) => other.label !== entry.label), entry].slice(-60);
}
// After a fill: the fields the profile rules left open are suggested values
// from the applicant's saved facts. "auto" fills what is suggested and lists
// it for checking; "review" leaves the drafts in the panel for approval,
// with the written answers drafted beside them.
const assisting = new Set<string>();
async function assist(app: Application, tabId: number) {
  if (assisting.has(app.id)) return;
  assisting.add(app.id);
  if (await draftOnlyTab(tabId)) {
    assisting.delete(app.id);
    app.assisting = false;
    await persist();
    return;
  }
  const { mode } = modelFills();
  const tried = new Set<string>();
  let filled = 0;
  let finished = false;
  const idle = () => !app.explicitFill && !activeStatuses.includes(app.status) && app.tabId === tabId;
  const profileRevision: number | undefined = (await api("/v1/profile").catch(() => undefined))?.revision;
  try {
    for (let round = 0; round < (mode === "auto" ? 2 : 1) && idle(); round++) {
      const scanned = await unresolvedFields(app, tabId);
      if (!scanned.available) break;
      for (const label of scanned.legalLeft) {
        const note = `Legal or eligibility question left for you: ${label}`.slice(0, 350);
        if (!app.missing.includes(note)) app.missing.push(note);
      }
      const ids = scanned.problems
        .filter((problem) => !tried.has(problem.fieldId))
        .map((problem) => problem.fieldId)
        .slice(0, 100);
      if (!ids.length) break;
      for (const id of ids) tried.add(id);
      await draftFieldFallback(app, tabId, ids);
      if (mode !== "auto") break;
      const session = app.fieldFallbackSession;
      if (!session?.jobId) break;
      let job: GenerationJob = await api(`/v1/jobs/${session.jobId}`);
      for (let waited = 0; waited < 120 && ["queued", "running"].includes(job.status); waited++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (app.fieldFallbackSession !== session || !idle()) return;
        job = await api(`/v1/jobs/${session.jobId}`);
      }
      if (job.status !== "complete" || app.fieldFallbackSession !== session || !idle()) break;
      const listed = session.frames.flatMap((frame) => frame.fields.map((field) => ({ ...field, id: `${frame.frameId}|${field.id}` })));
      for (const draft of (job.fieldDrafts || []).filter((candidate) => !candidate.value?.trim() && legalQuestion(`${candidate.question || ""} ${candidate.label}`))) {
        const note = `Legal or eligibility question left for you: ${draft.label}`.slice(0, 350);
        if (!app.missing.includes(note)) app.missing.push(note);
      }
      const answers = (job.fieldDrafts || [])
        .filter((draft) => draft.value?.trim())
        .filter((draft) => {
          const field = listed.find((candidate) => candidate.id === draft.fieldId);
          return (
            field &&
            (!field.options.length || field.options.some((option) => normalize(option) === normalize(draft.value))) &&
            (!field.maxLength || draft.value.length <= field.maxLength)
          );
        })
        .map((draft) => ({ fieldId: draft.fieldId, value: draft.value }));
      if (!answers.length) break;
      const { results } = await withPageTimers(app, tabId, () => fillFieldFallback(app, { jobId: session.jobId, tabId, answers }));
      for (const result of results.filter((candidate) => candidate.ok)) {
        const field = listed.find((candidate) => candidate.id === result.fieldId);
        const answer = answers.find((candidate) => candidate.fieldId === result.fieldId);
        if (!field || !answer) continue;
        filled++;
        noteAiFilled(app, field.label, answer.value);
        app.missing = app.missing.filter((item) => item !== `Required: ${field.label}` && !item.startsWith(`Required: ${field.label}:`) && item !== `Optional unanswered: ${field.label}`);
      }
    }
    if (mode === "auto") {
      // Nothing is left to approve: what was filled is listed for checking.
      if (idle()) await clearFieldFallback(app);
      if (filled && idle())
        app.note = `${filled} more field${filled === 1 ? "" : "s"} filled by AI from your saved details. Check the ones listed.`;
    } else if (idle()) {
      const questions = (await questionFields(tabId)).fields.filter((field) => !field.value && !field.protected && !leftAsLegal(field.label));
      if (questions.length) await draftAnswers(app, tabId, questions.map((field) => field.id).slice(0, 250)).catch(() => {});
    }
    finished = idle();
  } catch {
    // A suggestion step that cannot run leaves the fill as it finished.
  } finally {
    app.aiPass = { tabId, profileRevision, fieldIds: [...tried], finished };
    assisting.delete(app.id);
    app.assisting = false;
    await persist();
  }
}
// A posting's own Apply link or button: "Apply", "Apply now", "Apply for
// this job", "Start application". One that applies through another site or
// a stored profile (an employer, Indeed, "Apply with…", Easy Apply) is not it.
// A link goes in this tab, never a new one, so the application keeps its
// tab; a button is clicked, and a form it shows in place is filled after.
async function useApply(app: Application, tabId: number, operation: number): Promise<string | undefined> {
  const [found] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => {
      const own = /^(apply|apply now|apply online|apply here|apply today|apply for (this |the )?(job|position|role|opportunity)|apply to (this |the )?(job|position|role)|start (your |an |my )?application|begin (your |an )?application)$/i;
      const other = /linkedin|indeed|glassdoor|seek|\bwith\b|easy apply|quick apply|refer|save|share/i;
      const shown = (element: Element) => (element as HTMLElement).getClientRects().length > 0 && !element.closest("[hidden],[aria-hidden='true']");
      const candidates = [...document.querySelectorAll<HTMLElement>('a[href],button,[role="button"],input[type="submit"],input[type="button"]')]
        .filter((element) => !(element as HTMLButtonElement).disabled && shown(element))
        .map((element) => ({ element, label: (element instanceof HTMLInputElement ? element.value : element.innerText || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim() }))
        .filter(({ label }) => own.test(label.replace(/[!.:›»→]+$/, "").trim()) && !other.test(label));
      const chosen = candidates[0];
      if (!chosen) return undefined;
      if (chosen.element instanceof HTMLAnchorElement && /^https?:/i.test(chosen.element.href))
        return { label: chosen.label, href: chosen.element.href };
      chosen.element.click();
      return { label: chosen.label };
    },
  });
  const result = found?.result as { label: string; href?: string } | undefined;
  if (!result || !alive(app, operation)) return undefined;
  app.applyUsed = { from: [...(app.applyUsed?.from || []), canonicalURL(app.url)], operation, tabId, at: Date.now() };
  if (result.href) await chrome.tabs.update(tabId, { url: result.href });
  // A form shown in place is read again in a moment; a new page carries on
  // when it loads instead (chrome.tabs.onUpdated), which cancels this.
  setTimeout(() => {
    if (app.applyUsed?.operation === operation && app.operation === operation && app.tabId === tabId && app.status === "awaiting-user") {
      app.applyUsed.operation = -1;
      void resume(app).catch(() => {});
    }
  }, 2500);
  return result.label;
}
// Whether the page a fill would write to is on a draft-only site.
async function draftOnlyTab(tabId: number | undefined, fallback?: string) {
  const tab = tabId === undefined ? undefined : await chrome.tabs.get(tabId).catch(() => undefined);
  return draftOnlySite(tab?.url || fallback);
}
async function resume(app: Application, continuation?: { operation: number; tabId: number }) {
  if (await draftOnlyTab(app.tabId, app.url)) throw new Error(DRAFT_ONLY_NOTE);
  await clearFieldFallback(app);
  // A delayed resume-upload continuation belongs to one request and one
  // tab. A pause, new request or changed target cancels it, including while
  // the asynchronous cleanup above was running.
  if (continuation && (
    !app.continueAfterSiteFill || app.operation !== continuation.operation ||
    app.tabId !== continuation.tabId || app.status !== "awaiting-user"
  )) return;
  loadingSince.delete(app.id);
  app.aiFilled = undefined;
  app.preparationMs = 0;
  app.activeSince = undefined;
  app.startedAt = undefined;
  app.completedAt = undefined;
  app.operation++;
  const operation = app.operation;
  app.profileRevision = 0;
  app.jobId = undefined;
  app.artifacts = [];
  app.narrative = undefined;
  app.generationKey = undefined;
  app.missing = [];
  // A new request supersedes the previous attempt; close it in the history.
  const previous = app.attempts.at(-1);
  if (previous && !previous.completedAt) {
    previous.completedAt = Date.now();
    previous.status = "paused";
    previous.note = "Superseded by a new Fill this step request.";
    previous.filled = app.filled;
  }
  if (
    !app.tabId ||
    !(await chrome.tabs.get(app.tabId).catch(() => undefined))
  ) {
    const tab = await chrome.tabs.create({ url: app.url, active: false });
    app.tabId = tab.id;
    updateRelatedTab(app, tab, undefined);
  }
  if (!app.tabId) throw new Error("Choose a current fill tab first.");
  if (continuation && (!alive(app, operation) || app.tabId !== continuation.tabId)) return;
  app.explicitFill = true;
  app.attempts.push({
    id: crypto.randomUUID(),
    tabId: app.tabId,
    startedAt: Date.now(),
    status: "queued",
    filled: 0,
    note: "Waiting for an available fill slot.",
  });
  app.attempts = app.attempts.slice(-20);
  await broadcast(app, "RESUME");
  if (continuation && (!alive(app, operation) || app.tabId !== continuation.tabId)) return;
  touch(
    app,
    "queued",
    "Queued for a fresh inspection; protected edits will be preserved.",
  );
  // Keep the continuation pending through every await. Clearing it before
  // the next fill was queued exposed an interim awaiting-user state as a
  // finished fill to the panel and eval adapter.
  app.continueAfterSiteFill = false;
  await persist();
  schedule();
}
async function enqueue(
  items: { url: string; tabId?: number }[],
  allowDuplicate = false,
) {
  if (items.length > 100)
    throw new Error("Queue up to 100 applications at a time.");
  for (const item of items) {
    const url = canonicalURL(item.url);
    if (
      !(await chrome.permissions.contains({
        origins: [`${new URL(url).origin}/*`],
      }))
    )
      throw new Error(`Grant site access for ${new URL(url).origin}.`);
    if (
      !allowDuplicate &&
      state.applications.some(
        (a) => a.status !== "cancelled" && [a.url, a.sourceUrl].some((known) => known && sameOpening(known, url)),
      )
    )
      continue;
    const tab = item.tabId
      ? await chrome.tabs.get(item.tabId)
      : await chrome.tabs.create({ url, active: false });
    if (item.tabId && canonicalURL(tab.url || "") !== url)
      throw new Error("Tab changed before it was queued. Select it again.");
    const app: Application = {
      id: crypto.randomUUID(),
      tabId: tab.id,
      url,
      sourceUrl: url,
      title: tab.title || new URL(url).hostname,
      company: companyFor(url, tab.title),
      status: "awaiting-user",
      workflowStage: "applying",
      stageUpdatedAt: Date.now(),
      tabs: [relatedTab(tab, 0)],
      attempts: [],
      issueCount: 0,
      explicitFill: false,
      operation: 0,
      profileRevision: 0,
      artifacts: [],
      missing: [],
      note: "Tracked. Open a form and choose Fill this step.",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      filled: 0,
      steps: 0,
    };
    state.applications.push(app);
    await persist();
    if (tab.id !== undefined) await startEvidence(tab.id);
  }
  schedule();
  return state;
}

async function trackTab(tabId: number) {
  const existing = applicationForTab(tabId);
  if (existing) return state;
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url))
    throw new Error("Open an HTTP(S) job or application page first.");
  // The same opening reached by another address (a Workday requisition on
  // another career site) whose own tab is gone takes this tab instead of
  // becoming a second application.
  const twin = state.applications.find(
    (app) =>
      app.status !== "cancelled" &&
      !app.submittedAt &&
      [app.url, app.sourceUrl].some((known) => known && sameOpening(known, tab.url!)),
  );
  if (twin && (twin.tabId === undefined || !(await chrome.tabs.get(twin.tabId).catch(() => undefined)))) {
    await attachTab(twin, tabId);
    return state;
  }
  await enqueue([{ url: tab.url, tabId }], true);
  const app = applicationForTab(tabId)!;
  const context = await tabContext(tabId);
  if (context.observation) {
    app.title = context.observation.title || app.title;
    namedByPage(app, context.observation);
    app.sourceDescription = context.observation.description.slice(0, 12500);
    app.ats = context.observation.ats;
    updateRelatedTab(app, tab, context.observation.fields.length);
    app.note = context.observation.fields.length
      ? `${context.observation.fields.length} fields detected. Ready when you are.`
      : "Tracked. Open the application form when you are ready.";
  }
  // A page with a job's description and no form is the posting itself: what
  // opened it is a list of jobs (Simplify's on GitHub opened Amazon's posting,
  // tracked there, and the list was read as the posting).
  if (!app.postingUrl && !app.postingText && !app.postingSought && context.observation &&
      !context.observation.fields.length && (context.observation.description.match(/\S+/g)?.length || 0) >= 40) {
    app.postingSought = true;
    app.postingUrl = tab.url;
  }
  if (!app.postingUrl && !app.postingText && !app.postingSought) {
    app.postingSought = true;
    const led = await leadingPage(tab, context.observation, app).catch(() => undefined);
    if (led) {
      app.postingUrl = led.url;
      if (led.description) app.sourceDescription = `${led.description.slice(0, 12500)}\n${app.sourceDescription || ""}`;
    } else if (!app.postingText && guessedAgain(app)) app.postingUrl = postingGuess(app.url);
  }
  await persist();
  return state;
}

// The page an application form was reached from, when it is tracked without
// a posting of its own: the tab that opened it (a careers site's form opened
// from its posting), else the page the browser says led to it (Paylocity's
// Apply after its Details). Its address becomes the application's posting
// link, which the card shows and the applicant can change, and its words
// are read when that tab is still open.
async function leadingPage(tab: chrome.tabs.Tab, observation?: Observation, app?: Application): Promise<{ url: string; description?: string } | undefined> {
  // A page of the application itself (step 1 is the referrer of step 2) is
  // not where it was reached from.
  const own = new Set([tab.url, app?.url, app?.sourceUrl, ...(app?.tabs || []).map((related) => related.url)].filter(Boolean).map((url) => canonicalURL(url!)));
  const usable = (url?: string) => {
    if (!url || !/^https:/.test(url) || own.has(canonicalURL(url))) return false;
    const { hostname, pathname } = new URL(url);
    return pathname.length > 1 &&
      !/(^|\.)(google|bing|duckduckgo|yahoo)\.[a-z.]+$|^(login|accounts|auth|sso|signin)\.|(^|\.)(okta|auth0|microsoftonline)\.com$/.test(hostname) &&
      !/\b(log-?in|sign-?in|sso|oauth|authorize)\b/i.test(pathname);
  };
  // The tab that opened this one led to the tab's first page, not to a page
  // reached in it since: Simplify's list on GitHub opened Oracle's posting,
  // which led to its form, and the list was read as the posting.
  const before = tab.id !== undefined && tab.url ? (await visitedPages(tab.id)).filter((url) => canonicalURL(url) !== canonicalURL(tab.url!)) : [];
  if (tab.openerTabId !== undefined && !before.length) {
    const opener = await chrome.tabs.get(tab.openerTabId).catch(() => undefined);
    if (opener?.id !== undefined && usable(opener.url) && !applicationForTab(opener.id)) {
      const read = await inspectTab(opener.id).catch(() => undefined);
      return { url: opener.url!, description: read?.frames[0]?.observation.description || undefined };
    }
  }
  // The same tab, before it reached this site: a cross-site referrer names
  // only the other site (one employer's posting on jobs.l3harris.com, its form
  // on ns2cloud.com), but the tab's own pages say which.
  if (tab.id !== undefined && tab.url) {
    const host = new URL(tab.url).hostname;
    const earlier = (await visitedPages(tab.id)).filter((url) => usable(url) && new URL(url).hostname !== host).at(-1);
    if (earlier) return { url: earlier };
  }
  if (usable(observation?.referrer)) return { url: observation!.referrer! };
}

// Each tab's recent pages, oldest first, for the browser session only
// (session storage): where an application form was reached from.
const visitedKey = "visitedPages";
let visiting = Promise.resolve();
async function visitedPages(tabId: number): Promise<string[]> {
  const stored = await chrome.storage.session.get(visitedKey).catch(() => ({}) as Record<string, unknown>);
  return ((stored[visitedKey] || {}) as Record<string, string[]>)[tabId] || [];
}
function rememberVisit(tabId: number, url?: string) {
  visiting = visiting.then(async () => {
    const stored = await chrome.storage.session.get(visitedKey);
    const all = (stored[visitedKey] || {}) as Record<string, string[]>;
    if (url) all[tabId] = [...(all[tabId] || []).filter((seen) => seen !== url), url].slice(-8);
    else delete all[tabId];
    await chrome.storage.session.set({ [visitedKey]: all });
  }).catch(() => {});
}
// Before the page's first request: a capture started here holds the page
// itself, which a replay of it needs (eval/check.ts).
chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0 || !/^https?:/.test(url)) return;
  void initial.then(() => {
    if (state.settings.networkCapture === "on" && !capturing(tabId) && applicationForTab(tabId))
      return startCapture(tabId, false);
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && /^https:/.test(change.url) && change.url.length <= 3000) rememberVisit(tabId, change.url);
});
chrome.tabs.onRemoved.addListener((tabId) => rememberVisit(tabId));

// The employer as the page names it replaces a name guessed from the
// address ("smartapply"), never one the applicant typed.
const wordCount = (text?: string) => text?.match(/\S+/g)?.length || 0;

// The application's own posting page, open in another tab and now showing
// more of the posting than was read from it: its words and address.
// Whether the posting's address is to be guessed from the form's: none yet,
// or one an earlier guess made that the guess now makes better (Microsoft's
// form at /careers/apply?pid= was taken to post at /careers).
function guessedAgain(app: Application): boolean {
  if (!app.postingUrl) return true;
  const guess = postingGuess(app.url);
  if (!guess || guess === app.postingUrl) return false;
  try {
    const url = new URL(app.url);
    url.pathname = url.pathname.replace(/\/(apply|application)\/?$/i, "");
    url.search = "";
    url.hash = "";
    return url.href === app.postingUrl;
  } catch {
    return false;
  }
}

async function postingFromOwnTab(app: Application, filling?: Observation, open = false): Promise<{ url: string; description: string } | undefined> {
  const own = new Set([app.sourceUrl, app.postingUrl, ...app.tabs.map((related) => related.url)].filter(Boolean).map((url) => canonicalURL(url!)));
  const filled = new Set([app.url, filling?.url].filter(Boolean).map((url) => canonicalURL(url!)));
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id === undefined || tab.id === app.tabId || !tab.url || !/^https?:/.test(tab.url)) continue;
    if (!own.has(canonicalURL(tab.url)) || filled.has(canonicalURL(tab.url))) continue;
    const page = (await inspectTab(tab.id).catch(() => undefined))?.frames.find((frame) => frame.frameId === 0)?.observation;
    if (page && wordCount(page.description) >= 80 && wordCount(page.description) > wordCount(app.sourceDescription))
      return { url: tab.url, description: page.description };
  }
  // The posting's link, given but not open: read in a tab of its own, out of
  // view, once its script has drawn it, then closed. Tesla refuses the
  // backend its pages, so a pasted link alone gave the fit nothing to go on.
  // Or the page it was tracked from, when the form is elsewhere.
  const link = app.postingUrl || (app.sourceUrl && canonicalURL(app.sourceUrl) !== canonicalURL(app.url) ? app.sourceUrl : undefined);
  if (!open || !link || !/^https?:/.test(link)) return;
  const reader = await chrome.tabs.create({ url: link, active: false }).catch(() => undefined);
  if (reader?.id === undefined) return;
  try {
    for (let waited = 0; waited < 20_000; waited += 1000) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const page = (await inspectTab(reader.id).catch(() => undefined))?.frames.find((frame) => frame.frameId === 0)?.observation;
      if (page && wordCount(page.description) >= 80 && wordCount(page.description) > wordCount(app.sourceDescription))
        return { url: link, description: page.description };
    }
  } finally {
    await chrome.tabs.remove(reader.id).catch(() => {});
  }
}

function namedByPage(app: Application, observation: Observation) {
  if (observation.company && app.company === companyFor(app.sourceUrl || app.url, ""))
    app.company = observation.company.slice(0, 300);
}

async function attachTab(app: Application, tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url))
    throw new Error("Only HTTP(S) tabs can be attached.");
  const owner = applicationForTab(tabId);
  if (owner && owner.id !== app.id) {
    if (owner.status !== "cancelled")
      await invalidate(owner, "paused", "The fill tab was moved to another application.");
    owner.tabs = owner.tabs.filter((related) => related.tabId !== tabId);
    if (owner.tabId === tabId) owner.tabId = undefined;
  }
  if (activeStatuses.includes(app.status))
    await invalidate(app, "paused", "The current fill tab changed.");
  if (app.tabId !== tabId) await clearFieldFallback(app);
  const context = await tabContext(tabId);
  const fieldCount = context.observation ? fillable(context.observation) : 0;
  updateRelatedTab(app, tab, fieldCount);
  app.tabId = tabId;
  app.url = tab.url;
  app.status = "awaiting-user";
  app.explicitFill = false;
  app.note = fieldCount
    ? `${fieldCount} fields detected. Choose Fill this step when ready.`
    : "Attached. Open a fillable application step in this tab.";
  app.updatedAt = Date.now();
  await persist();
  await startEvidence(tabId);
  return state;
}

async function detachTab(app: Application, tabId: number) {
  if (app.tabId === tabId && app.status !== "cancelled")
    await invalidate(app, "paused", "The current fill tab was detached.");
  app.tabs = app.tabs.filter((tab) => tab.tabId !== tabId);
  if (app.tabId === tabId) {
    app.tabId = undefined;
    app.status = "awaiting-user";
    app.note = "Choose a related tab as the current fill target.";
  }
  await persist();
  return state;
}

// What the page holds now: every readable frame's fields and HTML, with
// unreadable frames noted. Shared by issue reports and fill captures.
async function pageEvidence(tabId: number): Promise<{ tab: chrome.tabs.Tab & { url: string }; frames: IssueReport["frames"] }> {
  if (state.settings.networkCapture === "on" && !capturing(tabId))
    await startCapture(tabId, false).catch(() => {});
  const captured = await inspectTab(tabId, true);
  const tab = captured.tab;
  if (!tab.url || !/^https?:/.test(tab.url))
    throw new Error("This tab cannot be included in an issue report.");
  let remaining = 10_000_000;
  const frames: IssueReport["frames"] = captured.frames.map((frame) => {
    const html = String((frame as Frame & { html?: string }).html || "");
    const kept = html.slice(0, Math.max(0, remaining));
    remaining -= kept.length;
    return {
      url: redactURL(frame.observation.url),
      observation: frame.observation,
      html: kept,
    };
  });
  frames.push(
    ...captured.inaccessible.map((error) => ({ url: redactURL(tab.url!), error })),
  );
  return { tab: tab as chrome.tabs.Tab & { url: string }, frames };
}
const networkSummary = (network: NonNullable<Awaited<ReturnType<typeof captureHar>>>) =>
  ({ entries: network.entries, fromLoad: network.fromLoad, recovered: network.recovered, missing: network.missing });

// Every fill leaves a capture of the page as the fill left it, with its
// network traffic, like an issue report the applicant did not have to file.
// The eval replays them offline and checks them for problems on every form
// (eval/check.ts), so a bug shows up from the fills already made instead of
// waiting for a report. Kept locally; the backend keeps only the newest.
const captureTimers = new Map<number, ReturnType<typeof setTimeout>>();
const capturesInFlight = new Set<number>();
function scheduleFillCapture(app: Application, delayMs = 4000, tries = 0) {
  const tabId = app.tabId;
  if (tabId === undefined || state.settings.networkCapture !== "on") return;
  clearTimeout(captureTimers.get(tabId));
  captureTimers.set(tabId, setTimeout(() => {
    captureTimers.delete(tabId);
    // Wait out the rest of the fill: a continuation after the site rewrote
    // the form, and the model's suggestions, both still write to the page.
    if (app.tabId !== tabId) return;
    if (activeStatuses.includes(app.status) || app.status === "queued" || app.explicitFill || app.continueAfterSiteFill || app.assisting) {
      if (tries < 30) scheduleFillCapture(app, 4000, tries + 1);
      return;
    }
    if (capturesInFlight.has(tabId)) return;
    capturesInFlight.add(tabId);
    void captureFill(app, tabId).catch(() => {}).finally(() => capturesInFlight.delete(tabId));
  }, delayMs));
}
async function captureFill(app: Application, tabId: number) {
  const { tab, frames } = await pageEvidence(tabId);
  if (!frames.some((frame) => frame.observation?.fields.length)) return;
  const network = await captureHar(tabId);
  const capture = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    trigger: "fill" as const,
    applicationId: app.id,
    application: {
      title: app.title,
      company: app.company,
      workflowStage: app.workflowStage,
      status: app.status,
      operation: app.operation,
      missing: app.missing,
      attempts: app.attempts.slice(-5),
      configNotes: app.configNotes || [],
    },
    tab: {
      tabId,
      url: redactURL(tab.url),
      title: tab.title || new URL(tab.url).hostname,
      ats: frames.find((frame) => frame.observation)?.observation?.ats,
    },
    extension: { version: chrome.runtime.getManifest().version, contentVersion: CONTENT_VERSION },
    ...(app.lastRecordingId ? { recordingId: app.lastRecordingId } : {}),
    ...(network ? { network: networkSummary(network) } : {}),
    frames,
  };
  await api("/v1/captures", "POST", { ...capture, ...(network ? { har: network.har } : {}) });
}

async function reportIssue(
  tabId: number,
  category: IssueReport["category"],
  note: string,
) {
  const app = applicationForTab(tabId);
  if (app && (app.explicitFill || activeStatuses.includes(app.status)))
    await invalidate(
      app,
      "paused",
      "Paused to capture a consistent issue report.",
    );
  // Keep recording if saving fails or the applicant continues on this page.
  const recorded = recordings.has(tabId) ? await saveRecording(tabId).catch(() => undefined) : undefined;
  // Reports name an immutable snapshot, never the ongoing recording file.
  if (recorded) recorded.recording = { ...recorded.recording, id: crypto.randomUUID(), auto: false };
  if (recorded && app) app.lastRecordingId = recorded.recording.id;
  const { tab, frames } = await pageEvidence(tabId);
  const report: IssueReport = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    category,
    note: note.slice(0, 4000),
    applicationId: app?.id,
    application: app
      ? {
          title: app.title,
          company: app.company,
          workflowStage: app.workflowStage,
          status: app.status,
          operation: app.operation,
          missing: app.missing,
          attempts: app.attempts,
          // Which site-config steps failed and why: what a fix needs.
          configNotes: app.configNotes || [],
        }
      : undefined,
    tab: {
      tabId,
      url: redactURL(tab.url),
      title: tab.title || new URL(tab.url).hostname,
      ats: frames.find((frame) => frame.observation)?.observation?.ats,
    },
    extension: {
      version: chrome.runtime.getManifest().version,
      contentVersion: CONTENT_VERSION,
    },
    // What happened: the applicant's own recording if one is running, else
    // the last fill's, which every fill makes.
    ...((recorded?.recording.id || app?.lastRecordingId)
      ? { recordingId: recorded?.recording.id || app?.lastRecordingId }
      : {}),
    frames,
  };
  const network = state.settings.networkCapture === "on" ? await captureHar(tabId) : undefined;
  if (network) report.network = networkSummary(network);
  const bundle = { ...report, ...(network ? { har: network.har } : {}),
    ...(recorded ? { recording: recorded.recording } : {}) };
  let saved = true;
  let saveError = "";
  try {
    // The backend publishes the report only after all evidence is on disk.
    await api("/v1/issues", "POST", bundle);
  } catch (error) {
    saved = false;
    saveError = (error as Error).message;
  }
  if (app && saved) {
    app.issueCount++;
    await persist();
  }
  // A download after a backend failure must keep the evidence too.
  return { report: saved ? report : bundle, saved, saveError };
}

type ActiveRecording = {
  id: string;
  // Started by a fill rather than by the applicant.
  auto?: boolean;
  tabId: number;
  startedAt: number;
  url: string;
  title: string;
  pages: string[];
  events: NonNullable<Recording["events"]>;
  saving?: Promise<unknown>;
};
const recordings = new Map<number, ActiveRecording>();
const maxRecordedEvents = 30_000;

async function startEvidence(tabId: number) {
  if (state.settings.networkCapture === "on" && !capturing(tabId))
    await startCapture(tabId, false).catch(() => {});
  if (!recordings.has(tabId)) await startRecording(tabId, true).catch(() => {});
}

// Starts (or re-starts after a reload) the recorder in every frame we may
// read. Frames without site access are noted rather than skipped silently.
async function attachRecorder(recording: ActiveRecording) {
  // Frames attach independently, so stalled ones cost one wait, not one each.
  await Promise.all((await allFrames(recording.tabId)).map(async (frame) => {
    if (!/^https?:/.test(frame.url)) return;
    const origin = new URL(frame.url).origin;
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
      recording.events.push({
        t: Date.now() - recording.startedAt,
        kind: "navigation",
        frameId: frame.frameId,
        data: { note: `No site access; frame not recorded: ${origin}` },
      });
      return;
    }
    // A frame that never finishes loading (a stalled third-party embed) keeps
    // executeScript pending for good. Tracking a tab must not wait on it.
    let slow: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<void>((resolve) => {
      slow = setTimeout(() => {
        recording.events.push({
          t: Date.now() - recording.startedAt,
          kind: "navigation",
          frameId: frame.frameId,
          data: { note: `Frame did not load in time; not recorded: ${origin}` },
        });
        resolve();
      }, 8000);
    });
    const attached = chrome.scripting
      .executeScript({
        target: { tabId: recording.tabId, frameIds: [frame.frameId] },
        files: ["content.js"],
      })
      .then(() =>
        chrome.tabs.sendMessage(
          recording.tabId,
          {
            type: "RECORD_START",
            session: recording.id,
            startedAt: recording.startedAt,
          },
          { frameId: frame.frameId },
        ),
      )
      // The page-world monitor reports calls into the page's own functions.
      .then(() =>
        chrome.scripting.executeScript({
          target: { tabId: recording.tabId, frameIds: [frame.frameId] },
          world: "MAIN",
          func: installMonitor,
          args: [recording.id, chrome.runtime.id],
        }),
      )
      .catch(() => {});
    await Promise.race([attached, stalled]);
    clearTimeout(slow);
  }));
}

async function startRecording(tabId: number, auto = false) {
  const existing = recordings.get(tabId);
  if (existing?.auto) {
    if (!auto) existing.auto = false;
    return recordingState();
  }
  if (existing) throw new Error("This tab is already recording.");
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url))
    throw new Error("Open the application page you want to record.");
  const recording: ActiveRecording = {
    id: crypto.randomUUID(),
    ...(auto ? { auto } : {}),
    tabId,
    startedAt: Date.now(),
    url: redactURL(tab.url),
    title: tab.title || new URL(tab.url).hostname,
    pages: [redactURL(tab.url)],
    events: [],
  };
  recordings.set(tabId, recording);
  await attachRecorder(recording);
  return recordingState();
}

async function stopRecording(tabId: number) {
  return saveRecording(tabId, true);
}

function saveRecording(tabId: number, stop = false) {
  const recording = recordings.get(tabId);
  if (!recording) throw new Error("This tab is not recording.");
  // A fill checkpoint and a report may arrive together. Never let an older
  // save finish after the newer snapshot and erase its events.
  const task = (recording.saving || Promise.resolve()).catch(() => {}).then(() => writeRecording(recording, stop));
  recording.saving = task;
  return task;
}

async function writeRecording(recording: ActiveRecording, stop: boolean) {
  const tabId = recording.tabId;
  if (stop) await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: removeMonitor,
    })
    .catch(() => {});
  for (const frame of await allFrames(tabId).catch(() => [])) {
    const result = await chrome.tabs
      .sendMessage(tabId, { type: stop ? "RECORD_STOP" : "RECORD_CHECKPOINT" }, { frameId: frame.frameId })
      .catch(() => undefined);
    for (const event of result?.data?.events || [])
      if (recording.events.length < maxRecordedEvents) recording.events.push({ ...event, frameId: frame.frameId });
  }
  if (stop) recordings.delete(tabId);
  const events = recording.events
    .slice(0, maxRecordedEvents)
    .sort((a, b) => a.t - b.t);
  const callsBySource: Record<string, number> = {};
  let pageCalls = 0;
  for (const event of events) {
    if (event.kind === "call") {
      const source = String(event.data.source || "unknown");
      callsBySource[source] = (callsBySource[source] || 0) + 1;
    }
    if (event.kind === "page-calls")
      for (const count of Object.values(event.data.counts || {}))
        pageCalls += Number(count) || 0;
  }
  const changes = events.filter((event) => event.kind === "value");
  const report: Recording = {
    id: recording.id,
    ...(recording.auto ? { auto: true } : {}),
    createdAt: recording.startedAt,
    durationMs: Date.now() - recording.startedAt,
    tab: { url: recording.url, title: recording.title },
    pages: recording.pages.slice(-200),
    eventCount: events.length,
    summary: {
      valueChanges: changes.length,
      directChanges: changes.filter((event) => event.data.direct).length,
      callsBySource,
      pageCalls,
    },
    events,
  };
  let saved = true;
  let saveError = "";
  try {
    await api("/v1/recordings", "POST", report);
  } catch (error) {
    saved = false;
    saveError = (error as Error).message;
  }
  return { recording: report, saved, saveError };
}

function recordingState() {
  return [...recordings.values()].map((recording) => ({
    id: recording.id,
    tabId: recording.tabId,
    startedAt: recording.startedAt,
    eventCount: recording.events.length,
  }));
}

// Answers the applicant entered on this page that the profile cannot give
// yet: candidates for the saved-answer bank, reused for identical questions.
// The fields the applicant answered by hand on a tab, with what they hold.
async function editedAnswers(tabId: number): Promise<Observation["fields"]> {
  const fields: Observation["fields"] = [];
  for (const frame of await allFrames(tabId)) {
    if (!/^https?:/.test(frame.url)) continue;
    const result = await chrome.tabs
      .sendMessage(tabId, { type: "EDITED_ANSWERS" }, { frameId: frame.frameId })
      .catch(() => undefined);
    if (result?.ok) fields.push(...result.data);
  }
  return fields;
}
async function suggestAnswers(tabId: number) {
  const profile: Profile = await api("/v1/profile");
  const fields = await editedAnswers(tabId);
  const saved = new Map(
    profile.answers.map((answer) => [normalize(answer.question), answer.answer]),
  );
  const seen = new Set<string>();
  return fields
    .filter((field) => {
      const question = normalize(field.label);
      if (!question || seen.has(question)) return false;
      seen.add(question);
      // Row fields (a school, an employer) belong to the profile's history.
      if (/education|experience|employment|work/.test(normalize(field.section || "")))
        return false;
      if (saved.get(question) === field.value) return false;
      // Anything the profile already answers needs no saved answer.
      return !proposals([{ ...field, value: "", protected: false }], profile).length;
    })
    .map((field) => ({
      question: field.label.slice(0, 1000),
      answer: field.value.slice(0, 4000),
      replaces: saved.get(normalize(field.label)),
    }));
}

// The answers the applicant gives by hand, kept with each application a
// moment after they edit: one given the same way on several applications is
// offered to save (recurringAnswers), so they need not add it themselves.
// Not a school's or job's row (the profile's history), a written answer, or
// a signature.
const handAnswerTimers = new Map<string, ReturnType<typeof setTimeout>>();
function recordHandAnswersSoon(app: Application) {
  clearTimeout(handAnswerTimers.get(app.id));
  handAnswerTimers.set(app.id, setTimeout(() => {
    handAnswerTimers.delete(app.id);
    void recordHandAnswers(app).catch(() => {});
  }, 4000));
}
async function recordHandAnswers(app: Application) {
  if (app.tabId === undefined) return;
  const fields = await editedAnswers(app.tabId);
  // (Entries kept before keptHandAnswer's later checks are dropped here.)
  const kept = new Map((app.handAnswers || [])
    .filter((entry) => keptHandAnswer({ label: entry.question, value: entry.answer }))
    .map((entry) => [normalize(entry.question), entry]));
  for (const field of fields) {
    if (!keptHandAnswer(field)) continue;
    // Their own edit, not a value the site put there (a parsed resume).
    if (!/^a real|from (a real|an edit saved)/.test(field.protectedReason || "")) continue;
    kept.set(normalize(field.label),{ question: field.label.slice(0, 300), answer: field.value.slice(0, 200), at: Date.now() });
  }
  if (!kept.size) return;
  app.handAnswers = [...kept.values()].sort((a, b) => a.at - b.at).slice(-80);
  await persist();
}
// Answers given by hand the same way on at least two applications, grouped
// by the question as the fill reads it (its standing topic, else its exact
// wording), that the profile does not already give and were not dismissed.
async function recurringAnswers(): Promise<RecurringAnswer[]> {
  const profile: Profile = await api("/v1/profile");
  const groups = new Map<string, RecurringAnswer & { seen: Set<string> }>();
  for (const app of state.applications)
    for (const entry of app.handAnswers || []) {
      // One kept before keptHandAnswer's later checks (a list's hidden value).
      if (!keptHandAnswer({ label: entry.question, value: entry.answer })) continue;
      const asked =questionTopic(entry.question) || normalize(entry.question);
      const key = `${asked}=${normalize(entry.answer)}`;
      const group = groups.get(key) || { key, question: entry.question, answer: entry.answer, applications: 0, seen: new Set<string>() };
      group.seen.add(app.id);
      group.applications = group.seen.size;
      groups.set(key, group);
    }
  const saved = new Set(profile.answers.flatMap((answer) => [normalize(answer.question), questionTopic(answer.question) || ""]).filter(Boolean));
  const dismissed = new Set(state.settings.dismissedAnswers || []);
  const field = (label: string): Field => ({ id: "recurring", label, kind: "text", required: false, value: "", options: [], revision: 1, protected: false });
  return [...groups.values()]
    .filter((group) => group.applications >= 2 && !dismissed.has(group.key))
    .filter((group) => !saved.has(questionTopic(group.question) || normalize(group.question)))
    .filter((group) => !proposals([field(group.question)], profile).length)
    .sort((a, b) => b.applications - a.applications)
    .slice(0, 20)
    .map(({ seen: _seen, ...group }) => group);
}
async function dismissRecurringAnswer(key: unknown) {
  if (typeof key !== "string" || !key || key.length > 600) throw new Error("Choose an answer to dismiss.");
  state.settings.dismissedAnswers = [...new Set([...(state.settings.dismissedAnswers || []), key])].slice(-300);
  await persist();
  return recurringAnswers();
}

async function saveAnswers(
  answers: { question: string; answer: string }[],
): Promise<Profile> {
  if (!Array.isArray(answers) || !answers.length)
    throw new Error("Choose at least one answer to save.");
  const profile: Profile = await api("/v1/profile");
  const merged = [...profile.answers];
  for (const { question, answer } of answers) {
    const key = normalize(String(question));
    if (!key || typeof answer !== "string") continue;
    const existing = merged.findIndex((item) => normalize(item.question) === key);
    const entry = { question: String(question).slice(0, 1000), answer: answer.slice(0, 4000) };
    if (existing >= 0) merged[existing] = entry;
    else merged.push(entry);
  }
  // Through the ordinary profile save, which also pauses active fills.
  return uiMessage({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, answers: merged.slice(0, 300) },
  });
}

async function uiMessage(message: any) {
  if (message.type === "STATE") return state;
  if (message.type === "HELLO") return { ...(await hello()), hasToken: Boolean(token) };
  // One-click pairing: the six-digit code the backend shows in its terminal.
  if (message.type === "PAIR_CODE") {
    const code = String(message.code || "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) throw new Error("Type the six digits shown where Application Lane is running.");
    let response: Response;
    try {
      response = await fetch(`${BACKEND}/v1/pair/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extensionId: chrome.runtime.id, code }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(BACKEND_DOWN);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.token !== "string")
      throw new Error(data.error || `Pairing failed (HTTP ${response.status}).`);
    await adoptToken(data.token);
    return { paired: true };
  }
  if (message.type === "PAIR") {
    const pairingToken = String(message.token || "").trim();
    if (/^[a-p]{32}$/.test(pairingToken))
      throw new Error(
        "That is a Chrome extension ID, not the pairing token. Paste the 64-character token from config.json in the backend's data folder.",
      );
    if (
      pairingToken.length < 32 ||
      pairingToken.length > 256
    )
      throw new Error("Paste the 64-character pairing token from config.json in the backend's data folder.");
    const old = token;
    token = pairingToken;
    try {
      await api("/v1/pair", "POST", { extensionId: chrome.runtime.id });
      await adoptToken(pairingToken);
    } catch (error) {
      token = old;
      throw error;
    }
    return { paired: true };
  }
  if (message.type === "API") {
    const allowed =
      /^(\/v1\/(status|profile|profile\/conflicts|profile\/bundle|import|settings|config|transcript|data|issues|recordings|submissions|fixer|fixer\/settings|fixer\/health|search|search\/settings)|\/v1\/(artifacts|jobs|issues|recordings)\/[a-f0-9-]{36})$/;
    // The panel reads the history of submissions and the fixer's work;
    // the background and the fixer write them.
    if (["/v1/submissions", "/v1/fixer"].includes(message.path) && (message.method || "GET") !== "GET")
      throw new Error("This is read-only here.");
    // Where a job's documents are as files, and showing their folder.
    const files = /^\/v1\/jobs\/[a-f0-9-]{36}\/files(\/open)?$/.exec(message.path);
    if (files) {
      if ((message.method || "GET") !== (files[1] ? "POST" : "GET"))
        throw new Error("Unsupported backend operation.");
      // Asked with the application's names, so documents drafted before
      // files were written are saved on first use.
      const job = message.path.split("/")[3];
      const owner = state.applications.find((app) => (app.documentJobId || app.jobId) === job);
      const saved = await api(`/v1/jobs/${job}/files`, "POST", {
        sent: owner?.workflowStage === "submitted",
        ...(owner ? { company: owner.company, title: owner.title } : {}),
      });
      return files[1] ? api(message.path, "POST") : saved;
    }
    if (!allowed.test(message.path))
      throw new Error("Unsupported backend operation.");
    // The transcript is only ever uploaded: nothing reads it back.
    if (message.path === "/v1/transcript" && message.method !== "PUT")
      throw new Error("Unsupported backend operation.");
    if (message.path === "/v1/profile/conflicts" && message.method && message.method !== "GET")
      throw new Error("Profile disagreements are read-only.");
    if (
      /^\/v1\/(jobs|artifacts)\//.test(message.path) &&
      message.method &&
      message.method !== "GET"
    )
      throw new Error("Document inspection is read-only.");
    if (
      (/^\/v1\/profile(\/bundle)?$/.test(message.path) && message.method === "PUT") ||
      (message.path === "/v1/data" && message.method === "DELETE")
    ) {
      for (const app of state.applications) {
        await clearFit(app);
        await clearAnswerDrafts(app);
        await clearFieldFallback(app);
        // A finished application is not asked to be filled again.
        if (!["cancelled"].includes(app.status) && !finishedStages.includes(app.workflowStage))
          await invalidate(
            app,
            "paused",
            "Profile data changed. Choose Fill this step to use the current profile.",
          );
      }
      await persist();
    }
    const result = await api(message.path, message.method, message.body);
    if (message.path === "/v1/data" && message.method === "DELETE") {
      state.applications = [];
      locks = {};
      await persist();
    }
    return result;
  }
  if (message.type === "ENQUEUE" || message.type === "TRACK_ITEMS")
    return enqueue(message.items);
  if (message.type === "ACTIVE_TAB") {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url))
      throw new Error("Open a job or application tab to inspect it.");
    return tabContext(tab.id);
  }
  if (message.type === "SCAN_TAB") return tabContext(message.tabId);
  if (message.type === "QUESTION_FIELDS") return questionFields(message.tabId);
  if (message.type === "START_RECORDING") return startRecording(message.tabId);
  if (message.type === "SUGGEST_ANSWERS") return suggestAnswers(message.tabId);
  if (message.type === "RECURRING_ANSWERS") return recurringAnswers();
  if (message.type === "PICK_UP_INBOX") return pickUpInbox().then(() => state);
  if (message.type === "DISMISS_RECURRING_ANSWER") return dismissRecurringAnswer(message.key);
  if (message.type === "SAVE_ANSWERS") return saveAnswers(message.answers);
  if (message.type === "STOP_RECORDING") return stopRecording(message.tabId);
  if (message.type === "RECORDING_STATE") return recordingState();
  if (message.type === "TRACK_TAB") return trackTab(message.tabId);
  if (message.type === "REPORT_ISSUE")
    return reportIssue(message.tabId, message.category, message.note || "");
  if (message.type === "DELETE_ISSUE") {
    if (typeof message.reportId !== "string" || !/^[a-f0-9-]{36}$/.test(message.reportId))
      throw new Error("Invalid issue report ID.");
    const report = await api(`/v1/issues/${message.reportId}`);
    await api(`/v1/issues/${message.reportId}`, "DELETE");
    const linked = state.applications.find((app) => app.id === report.applicationId);
    if (linked) {
      linked.issueCount = Math.max(0, linked.issueCount - 1);
      await persist();
    }
    return state;
  }
  if (message.type === "SETTINGS") {
    const { concurrency, generationConcurrency } = message.settings;
    const checking = message.settings.checking === "fast" ? "fast" : "thorough";
    const prefilled = message.settings.prefilled === "keep" ? "keep" : "replace";
    const networkCapture = message.settings.networkCapture === "on" ? "on" : "off";
    // A caller that says nothing about these (an older panel, a test's own
    // setting) leaves them as they are.
    const modelFill = ["auto", "review", "off", "written"].includes(message.settings.modelFill)
      ? (message.settings.modelFill as NonNullable<QueueState["settings"]["modelFill"]>)
      : state.settings.modelFill;
    const legalQuestions = ["manual", "model"].includes(message.settings.legalQuestions)
      ? (message.settings.legalQuestions as "manual" | "model")
      : state.settings.legalQuestions;
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 8 ||
      !Number.isInteger(generationConcurrency) ||
      generationConcurrency < 1 ||
      generationConcurrency > 4
    )
      throw new Error("Invalid concurrency settings.");
    await api("/v1/settings", "PUT", { generationConcurrency, checking });
    state.settings = {
      concurrency, generationConcurrency, checking, prefilled, networkCapture,
      ...(modelFill ? { modelFill } : {}),
      ...(legalQuestions ? { legalQuestions } : {}),
    };
    await persist();
    schedule();
    return state;
  }
  const app = state.applications.find((a) => a.id === message.id);
  if (!app) throw new Error("Application not found.");
  if (message.type === "CHECK_FIT") return checkFit(app);
  if (message.type === "DRAFT_DOCUMENTS") return draftDocuments(app);
  if (message.type === "UNRESOLVED_FIELDS") {
    const profile: Profile = forApplication(await api("/v1/profile"), app);
    const scanned = await unresolvedFields(app, message.tabId, undefined, profile);
    // With suggestions filled automatically, asking again only helps when
    // that step was cut short, ran on another page or profile, or new
    // fields have appeared since. In review mode asking is the way in.
    const pass = app.aiPass;
    const askAgain = modelFills().mode !== "auto" || !pass || !pass.finished || pass.tabId !== message.tabId ||
      pass.profileRevision !== profile.revision ||
      scanned.problems.some((problem) => !pass.fieldIds.includes(problem.fieldId));
    return { ...scanned, autoFill: modelFills().mode === "auto", askAgain: askAgain && !app.assisting };
  }
  if (message.type === "DRAFT_FIELD_FALLBACK")
    return draftFieldFallback(app, message.tabId, message.fieldIds);
  if (message.type === "FILL_FIELD_FALLBACK")
    return withPageTimers(app, message.tabId ?? app.tabId, () => fillFieldFallback(app, message));
  if (message.type === "CANCEL_FIELD_FALLBACK") {
    await clearFieldFallback(app);
    await persist();
    return state;
  }
  if (message.type === "DRAFT_ANSWERS") return draftAnswers(app, message.tabId, message.questionIds);
  if (message.type === "FILL_ANSWERS") return withPageTimers(app, message.tabId ?? app.tabId, () => fillReviewedAnswers(app, message));
  if (message.type === "CANCEL_ANSWERS") { await clearAnswerDrafts(app); await persist(); return state; }
  if (message.type === "ATTACH_TAB") return attachTab(app, message.tabId);
  if (message.type === "SET_TARGET") return attachTab(app, message.tabId);
  if (message.type === "DETACH_TAB") return detachTab(app, message.tabId);
  if (message.type === "OPEN_TAB") {
    const related = app.tabs.find((tab) => tab.tabId === message.tabId);
    if (!related?.tabId) throw new Error("Related tab not found.");
    const tab = await chrome.tabs.update(related.tabId, { active: true });
    if (tab) await chrome.windows.update(tab.windowId, { focused: true });
    return state;
  }
  if (message.type === "REPLACE_DOCUMENTS") {
    if (answerFills.has(app.id) || fieldFallbackFills.has(app.id) || activeStatuses.includes(app.status))
      throw new Error("Wait for the current fill to finish.");
    app.replaceDocuments = true;
    await resume(app);
    return state;
  }
  if (message.type === "UNLOCK_APP") {
    await clearFieldFallback(app);
    delete locks[app.id];
    await persist();
    if (app.tabId) {
      await Promise.allSettled(
        (await allFrames(app.tabId)).map((frame) =>
          chrome.tabs.sendMessage(
            app.tabId!,
            { type: "UNLOCK", applicationId: app.id, operation: app.operation },
            { frameId: frame.frameId },
          ),
        ),
      );
    }
    app.missing = app.missing.filter((item) => !/edit lock/.test(item));
    app.note = "Empty fields are unlocked. Choose Fill this step to fill them.";
    await persist();
    return state;
  }
  // Start this application over on a fresh copy of its page: every lock and
  // note from earlier attempts is dropped and the tab is reloaded, so the
  // next Fill this step behaves as it would the first time. The tailored
  // documents are kept (the backend hands them back; nothing is written again).
  if (message.type === "RESTART_APP") {
    if (answerFills.has(app.id) || fieldFallbackFills.has(app.id))
      throw new Error("Wait for the reviewed values to finish filling.");
    await invalidate(app, "paused", "Starting over…");
    delete locks[app.id];
    app.progress = undefined;
    app.formFrames = undefined;
    app.confirmedBySite = undefined;
    app.uploadedDocuments = undefined;
    app.siteFillPending = false;
    app.continueAfterSiteFill = false;
    app.siteFillTried = false;
    app.configNotes = [];
    app.missing = [];
    app.filled = 0;
    app.steps = 0;
    app.explicitFill = false;
    app.completedAt = undefined;
    app.workflowStage = "applying";
    app.stageUpdatedAt = Date.now();
    touch(app, "awaiting-user", "Started over. When the page has loaded, choose Fill this step.");
    await persist();
    if (app.tabId) await chrome.tabs.reload(app.tabId).catch(() => {});
    return state;
  }
  if (message.type === "FILL_STEP") {
    if (answerFills.has(app.id) || fieldFallbackFills.has(app.id))
      throw new Error("Wait for the reviewed values to finish filling.");
    // The side panel fills the tab you are looking at. If that is a related
    // tab other than the current target, it becomes the target first.
    if (typeof message.tabId === "number" && message.tabId !== app.tabId) {
      if (applicationForTab(message.tabId)?.id !== app.id)
        throw new Error("This tab belongs to a different application.");
      await attachTab(app, message.tabId);
    }
    // A second click while this step is still filling must not restart it.
    if (
      app.explicitFill &&
      (app.status === "queued" || activeStatuses.includes(app.status))
    )
      return state;
    if (app.tabId !== undefined) {
      // The page was loaded before its tab joined an application: the
      // capture starts now, and the report says it missed the load.
      if (state.settings.networkCapture === "on" && !capturing(app.tabId))
        await startCapture(app.tabId, false).catch(() => {});
      // Every fill records itself, so a report has what happened.
      if (!recordings.has(app.tabId)) await startRecording(app.tabId, true).catch(() => {});
    }
    answerRequests.delete(app.id);
    if (app.answerSession)
      await api(`/v1/jobs/${app.answerSession.jobId}`, "DELETE").catch(() => {});
    await resume(app);
    return state;
  }
  if (message.type === "SET_WORKFLOW") {
    if (
      !["applying", "review", "submitted", "blocked", "abandoned"].includes(
        message.stage,
      )
    )
      throw new Error("Unknown application stage.");
    await setStage(app, message.stage, message.reason);
    return state;
  }
  if (message.type === "ARCHIVE_APP") {
    if (
      message.archived &&
      (app.explicitFill || activeStatuses.includes(app.status))
    )
      await invalidate(
        app,
        "paused",
        "Fill paused because this application was archived.",
      );
    app.archivedAt = message.archived ? Date.now() : undefined;
    await persist();
    return state;
  }
  if (message.type === "UPDATE_APP") {
    const previous = JSON.stringify([app.title, app.company, app.postingUrl, app.postingText]);
    app.title = String(message.title || app.title).trim().slice(0, 1000) || app.title;
    app.company = String(message.company || app.company).trim().slice(0, 300) || app.company;
    // The posting as the applicant gives it; an empty value clears it.
    if (typeof message.postingUrl === "string") {
      const link = message.postingUrl.trim();
      if (link && !/^https:\/\/[^\s]+$/i.test(link)) throw new Error("A posting link starts with https://.");
      app.postingUrl = link.slice(0, 3000) || undefined;
    }
    if (typeof message.postingText === "string") app.postingText = message.postingText.trim().slice(0, 25000) || undefined;
    if (previous !== JSON.stringify([app.title, app.company, app.postingUrl, app.postingText])) {
      await clearFit(app);
      await clearAnswerDrafts(app);
      await clearFieldFallback(app);
      if (app.explicitFill || activeStatuses.includes(app.status))
        await invalidate(app, "paused", "The job details changed. Check fit or fill again using the updated posting.");
    }
    await persist();
    return state;
  }
  if (message.type === "PAUSE_APP")
    await invalidate(
      app,
      "paused",
      "Paused by you. Other applications continue.",
    );
  else if (message.type === "CANCEL_APP") {
    app.workflowStage = "abandoned";
    app.stageUpdatedAt = Date.now();
    await invalidate(
      app,
      "cancelled",
      "Cancelled. Existing values remain on the page.",
    );
  }
  else if (message.type === "RESUME_APP") await resume(app);
  else if (message.type === "OPEN_APP") {
    if (
      app.tabId &&
      (await chrome.tabs.get(app.tabId).catch(() => undefined))
    ) {
      const tab = await chrome.tabs.update(app.tabId, { active: true });
      if (tab) await chrome.windows.update(tab.windowId, { focused: true });
    } else await chrome.tabs.create({ url: app.sourceUrl });
  } else throw new Error("Unknown operation.");
  return state;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  // A full dashboard is an extension page inside a tab; sender.tab is valid
  // there too. Trust the packaged page URL, not the absence of a tab.
  // The dashboard's address carries the page it shows after a "#".
  const isPanel = ["panel.html", "dashboard.html"].some(
    (page) => sender.url?.split("#")[0] === chrome.runtime.getURL(page),
  );
  if (isPanel) {
    void initial
      .then(() => uiMessage(message))
      .then(
        (data) => respond({ ok: true, data }),
        (error) => respond({ ok: false, error: error.message }),
      );
    return true;
  }
  if (sender.tab && message.type === "MAIN_WORLD_APPLY") {
    void initial
      .then(async () => {
        const app = state.applications.find(
          (candidate) =>
            candidate.id === message.applicationId &&
            candidate.tabId === sender.tab!.id &&
            candidate.operation === message.operation &&
            (activeStatuses.includes(candidate.status) || readingOptions(candidate, message.request)),
        );
        if (!app) throw new Error("Application operation is stale or paused.");
        const operation = app.operation;
        const request = message.request as MainWorldRequest;
        if (
          !request ||
          !/^[a-f0-9-]{36}$/i.test(request.token) ||
          (request.file &&
            (request.file.applicationId !== app.id ||
              request.file.operation !== app.operation ||
              !app.artifacts.some(
                (artifact) =>
                  artifact.id === request.file?.id &&
                  artifact.name === request.file.name &&
                  artifact.mime === request.file.mime,
              )))
        )
          throw new Error(
            "MAIN-world request is not bound to this application.",
          );
        if (!sender.documentId)
          throw new Error("Missing sender document identity.");
        const authorized = await chrome.tabs.sendMessage(
          sender.tab!.id!,
          {
            type: "AUTHORIZE_MAIN",
            applicationId: app.id,
            operation,
            documentId: message.documentId,
            token: request.token,
          },
          { documentId: sender.documentId },
        );
        if (
          !authorized?.ok ||
          !authorized.data?.authorized ||
          !alive(app, operation) ||
          !(activeStatuses.includes(app.status) || readingOptions(app, request))
        )
          throw new Error("Field write was cancelled, locked, or superseded.");
        const [injection] = await chrome.scripting.executeScript({
          target: {
            tabId: sender.tab!.id!,
            documentIds: [sender.documentId],
          },
          world: "MAIN",
          func: applyMainWorld,
          args: [request],
          // The document/operation/field claim was just authorized. Waiting
          // for unrelated resources here can stall a usable form indefinitely.
          injectImmediately: true,
        });
        return injection.result;
      })
      .then(
        (data) => respond({ ok: true, data }),
        (error) => respond({ ok: false, error: error.message }),
      );
    return true;
  }
  if (sender.tab && message.type === "TRUSTED_TYPE") {
    void initial
      .then(async () => {
        const app = state.applications.find(
          (candidate) =>
            candidate.id === message.applicationId &&
            candidate.tabId === sender.tab!.id &&
            candidate.operation === message.operation &&
            activeStatuses.includes(candidate.status),
        );
        if (!app) throw new Error("Application operation is stale or paused.");
        // Captured before the authorization round trip: a pause or cancel in
        // between bumps the operation, and then no key is sent.
        const operation = app.operation;
        const request = message.request as {
          clear?: unknown;
          enter?: unknown;
          choose?: unknown;
          hold?: unknown;
          click?: unknown;
          text?: unknown;
          token?: unknown;
        };
        if (
          !request ||
          typeof request.token !== "string" ||
          !/^[a-f0-9-]{36}$/i.test(request.token) ||
          typeof request.text !== "string" ||
          typeof request.clear !== "number"
        )
          throw new Error(
            "Trusted typing request is not bound to this application.",
          );
        if (!sender.documentId)
          throw new Error("Missing sender document identity.");
        if (!trustedTypingAvailable())
          throw new Error("Real keystrokes need the debugger permission.");
        // The content script re-checks the token, the element, its focus and
        // the edit locks. Keys are dispatched only while it still agrees.
        const authorized = await chrome.tabs.sendMessage(
          sender.tab!.id!,
          {
            type: "AUTHORIZE_MAIN",
            applicationId: app.id,
            operation,
            documentId: message.documentId,
            token: request.token,
          },
          { documentId: sender.documentId },
        );
        if (
          !authorized?.ok ||
          !authorized.data?.authorized ||
          !alive(app, operation) ||
          !activeStatuses.includes(app.status)
        )
          throw new Error("Field write was cancelled, locked, or superseded.");
        await typeTrusted(sender.tab!.id!, request.text, request.clear, request.enter === true, request.choose === true || (typeof request.choose === "number" ? request.choose : false), request.hold === true,
          request.click && typeof request.click === "object" ? { x: Number((request.click as { x?: unknown }).x), y: Number((request.click as { y?: unknown }).y) } : undefined);
        return { ok: true };
      })
      .then(
        (data) => respond({ ok: true, data }),
        (error) => respond({ ok: false, error: error.message }),
      );
    return true;
  }
  if (sender.tab && message.type === "RECORD_EVENTS") {
    const recording = recordings.get(sender.tab.id!);
    if (
      recording &&
      message.session === recording.id &&
      Array.isArray(message.events)
    )
      for (const event of message.events.slice(0, 2000))
        if (recording.events.length < maxRecordedEvents)
          recording.events.push({ ...event, frameId: sender.frameId });
    return;
  }
  if (!sender.tab || !["HUMAN_PAUSE", "FORM_CHANGED", "FILL_PROGRESS", "SUBMITTED_PAGE"].includes(message.type))
    return;
  void initial.then(async () => {
    if (message.type === "SUBMITTED_PAGE") {
      // From a page of the application's own tab, its top page or the frame
      // its form is in; the page script may not be bound to an application
      // yet (the site's page after Submit is a new document).
      const shown = state.applications.find((a) => a.tabId === sender.tab!.id && a.status !== "cancelled");
      if (shown && message.generic === true && !(shown.formFrames || []).includes(sender.frameId ?? -1)) return;
      if (shown) await siteSubmitted(shown);
      return;
    }
    const app = state.applications.find(
      (a) => a.id === message.applicationId && a.tabId === sender.tab!.id,
    );
    if (!app) return;
    if (message.type === "FILL_PROGRESS") {
      if (typeof sender.frameId === "number" && !(app.formFrames || []).includes(sender.frameId))
        app.formFrames = [...(app.formFrames || []), sender.frameId].slice(-10);
      const label = typeof message.label === "string" ? message.label.replace(/\s+/g, " ").trim().slice(0, 160) : "";
      if (label && message.operation === app.operation) noteProgress(app, label);
      return;
    }
    if (message.type === "HUMAN_PAUSE") {
      recordHandAnswersSoon(app);
      locks[app.id] = [
        ...new Set([
          ...(locks[app.id] || []),
          ...(Array.isArray(message.locks)
            ? message.locks
                .filter((v: unknown) => typeof v === "string")
                .slice(0, 1000)
            : []),
        ]),
      ];
      // A fill that reads as finished may still have the model suggesting
      // values for what the rules left open, and the applicant, seeing a
      // filled form, starts on the rest. That edit used to discard the
      // suggestions. They are kept: each is written only where its field is
      // as it was and unprotected (fillFieldFallback), so the applicant's own
      // answers stand, and an edit while they are being written still stops it.
      const suggesting = assisting.has(app.id) && !app.explicitFill && !activeStatuses.includes(app.status);
      if (!suggesting && app.status !== "cancelled" && app.status !== "paused")
        await invalidate(app, "paused", interactedNote(message.cause));
      else await persist();
    } else if (activeStatuses.includes(app.status)) {
      dirty.add(app.id);
      schedule(500);
    } else if (app.status === "ready" && message.operation === app.operation)
      await invalidate(
        app,
        "paused",
        "The site changed after preparation. Review it, then choose Fill this step.",
      );
  });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "queue-recovery")
    void pump().then(() => initial.then(sweepTrustedInput));
  if (alarm.name === "inbox") void initial.then(() => {
    connectLive();
    return pickUpInbox();
  });
});
// Chrome can end a debugger session on its own (DevTools opened on the tab,
// the tab navigated away, a crash). Forget it so the next write re-attaches.
chrome.debugger?.onDetach.addListener(({ tabId }) => {
  if (tabId === undefined) return;
  forgetTrustedInput(tabId);
  forgetCapture(tabId);
});
// Nothing stays attached to a tab with no running lane.
async function sweepTrustedInput() {
  for (const tabId of trustedInputTabs())
    if (
      !state.applications.some(
        (app) =>
          app.tabId === tabId &&
          runners.has(app.id) &&
          activeStatuses.includes(app.status),
      )
    )
      await releaseTrustedInput(tabId);
}
chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTrustedInput(tabId);
  forgetCapture(tabId);
  // A closed tab ends its recording; keep what was captured.
  if (recordings.has(tabId)) void stopRecording(tabId).catch(() => {});
  void initial.then(async () => {
    for (const app of state.applications)
      if (app.tabs.some((tab) => tab.tabId === tabId)) {
        const related = app.tabs.find((tab) => tab.tabId === tabId)!;
        related.state = "closed";
        related.closedAt = Date.now();
        related.tabId = undefined;
        if (app.tabId === tabId && app.status !== "cancelled") {
          await invalidate(
            app,
            "paused",
            "Current fill tab closed. Choose another related tab.",
          );
          app.tabId = undefined;
        }
      }
    await persist();
  });
});
// A link tracked before its tab had loaded is named by its address
// ("jobs.ashbyhq.com"), from the command line most of all. The
// page's own title replaces that stand-in as soon as the tab has one, and
// names the employer when only the address did; a title the applicant or a
// fill gave is kept.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const title = change.title?.replace(/\s+/g, " ").trim();
  if (!title || /^https?:\/\//i.test(title)) return;
  void initial.then(async () => {
    const app = applicationForTab(tabId);
    if (!app) return;
    const host = (() => { try { return new URL(app.url).hostname; } catch { return ""; } })();
    if (title === host || !(app.title === host || /^https?:\/\//i.test(app.title) || !app.title)) return;
    app.title = title.slice(0, 300);
    if (app.company === companyFor(app.sourceUrl || app.url, "")) app.company = companyFor(app.sourceUrl || app.url, title);
    app.updatedAt = Date.now();
    await persist();
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  // A same-URL reload has no change.url, so the URL-change path below cannot
  // invalidate drafts. A navigation with change.url is handled there once.
  if (change.status === "loading" && !change.url)
    void initial.then(async () => {
      const app = state.applications.find(
        (app) =>
          app.answerSession?.tabId === tabId ||
          app.fieldFallbackSession?.tabId === tabId,
      );
      if (app)
        await invalidate(
          app,
          "paused",
          "The page reloaded. Review its current fields again before filling.",
        );
    }).catch(() => {});
  // An application tab's traffic, for reports and fill captures. "loading"
  // comes after the page's own request has gone out, so the capture only
  // counts as holding the page once it sees that request (network-capture.ts);
  // onBeforeNavigate below usually starts it in time.
  if (change.status === "loading")
    void initial.then(() => {
      if (state.settings.networkCapture === "on" && !capturing(tabId) && applicationForTab(tabId))
        return startCapture(tabId, false);
    }).catch(() => {});
  const recording = recordings.get(tabId);
  if (recording && change.status === "complete")
    void chrome.tabs.get(tabId).then(async (tab) => {
      const url = redactURL(tab.url || "");
      recording.events.push({
        t: Date.now() - recording.startedAt,
        kind: "navigation",
        data: { url, title: tab.title || "" },
      });
      if (recording.pages.at(-1) !== url) recording.pages.push(url);
      await attachRecorder(recording);
    }).catch(() => {});
  if (!change.url && change.status !== "complete") return;
  void initial
    .then(async () => {
      const app = state.applications.find(
        (a) =>
          (a.tabId === tabId || a.tabs.some((tab) => tab.tabId === tabId)) &&
          a.status !== "cancelled",
      );
      if (!app) return;
      const browserTab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (browserTab) updateRelatedTab(app, browserTab, undefined);
      if (app.tabId !== tabId) {
        await persist();
        return;
      }
      // The page a site shows after Submit is a new document with no page
      // script in it. Put one there so it can say whether that is what this is.
      if (change.status === "complete" && !app.confirmedBySite && ["applying", "review"].includes(app.workflowStage))
        void chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] }).catch(() => {});
      // A form in a frame of the page goes to its confirmation in that frame
      // alone: the frame listener above (webNavigation) puts a page script there.
      // The posting's Apply led here: the same request goes on with the form.
      const applied = app.applyUsed && app.applyUsed.tabId === tabId && app.applyUsed.operation === app.operation &&
        Date.now() - app.applyUsed.at < 60_000 ? app.applyUsed : undefined;
      if (applied) {
        if (change.url && canonicalURL(change.url) !== canonicalURL(app.url)) {
          app.url = canonicalURL(change.url);
          await persist();
        }
        if (change.status === "complete") {
          applied.operation = -1;
          setTimeout(() => {
            if (app.tabId === tabId && app.status === "awaiting-user") void resume(app).catch(() => {});
          }, 1500);
        }
      } else if (change.url && canonicalURL(change.url) !== canonicalURL(app.url)) {
        // A new document invalidates outstanding generation; never reuse its answers.
        app.url = canonicalURL(change.url);
        await invalidate(
          app,
          "paused",
          "The page changed. Scan it, then choose Fill this step when ready.",
        );
        // The page it changed to was the site's confirmation, which may have
        // been reported while that pause was being written.
        if (app.confirmedBySite && app.workflowStage === "submitted") {
          app.note = submittedNote;
          await persist();
        }
      }
      if (change.status === "complete") await tabContext(tabId).catch(() => {});
      // The site finished rewriting the form from the uploaded resume: this
      // is still the same requested fill, so it carries on by itself.
      if (
        change.status === "complete" &&
        app.continueAfterSiteFill &&
        app.tabId === tabId
      ) {
        const request = app.operation;
        app.note = "The site filled the form from your resume. Correcting and completing it…";
        await persist();
        setTimeout(() => {
          if (app.tabId === tabId && app.operation === request && app.continueAfterSiteFill && app.status === "awaiting-user")
            void resume(app, { operation: request, tabId }).catch(() => {});
        }, 2000);
      }
    })
    .catch(() => {});
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void initial.then(() => tabContext(tabId)).catch(() => {});
});
void initial.then(() => schedule());
