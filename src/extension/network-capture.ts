// The network traffic of an application tab, kept so an issue report can be
// replayed with the site's own scripts and responses (Playwright's
// routeFromHAR, as the eval replays its corpus). A snapshot of the page's
// HTML shows what was there; the site's behaviour (an upload handler that
// empties its input, a list that loads late, a form rebuilt after a save)
// only comes back when its code runs against the same responses.
//
// The capture starts when an application tab begins loading, so a replay has
// the page from its first request, and covers embedded frames (an employer
// page's Greenhouse form) through auto-attached child sessions. Cookie and
// authorization headers are never kept. Everything stays on this machine:
// the report is saved by the local backend.

import { claimDebugger, holdsDebugger, releaseDebugger } from "./debugger-session";

type Target = chrome.debugger.Debuggee & { sessionId?: string };
type Header = { name: string; value: string };
type Entry = {
  startedAt: number;
  type?: string;
  request: { method: string; url: string; headers: Header[]; postData?: string; mimeType?: string };
  response?: { status: number; statusText: string; headers: Header[]; mimeType: string };
  body?: { text: string; base64: boolean };
  failed?: string;
  recovered?: boolean;
};
type Capture = {
  startedAt: number;
  // Whether the capture holds the current page from its first request.
  fromLoad: boolean;
  mainFrame?: string;
  entries: Map<string, Entry>;
  bytes: number;
  pending: Set<Promise<unknown>>;
  targets: Map<string, Target>;
  recovery?: Promise<void>;
  missing: Set<string>;
};

const captures = new Map<number, Capture>();
// Bounded in the worker's memory: the newest bodies win.
const TOTAL_LIMIT = 40_000_000;
const BODY_LIMIT = 4_000_000;
const ENTRY_LIMIT = 4000;
const secret = /^(cookie|set-cookie|authorization|proxy-authorization|.*(?:csrf|xsrf|api-key|auth-token).*)$/i;

const headers = (raw: Record<string, unknown> = {}): Header[] =>
  Object.entries(raw)
    .filter(([name]) => !secret.test(name))
    .map(([name, value]) => ({ name, value: String(value) }));

const send = (target: Target, method: string, params: Record<string, unknown> = {}) =>
  chrome.debugger.sendCommand(target as chrome.debugger.Debuggee, method, params) as Promise<Record<string, unknown> | undefined>;

export function capturing(tabId: number): boolean {
  return captures.has(tabId);
}

export async function startCapture(tabId: number, fromLoad: boolean): Promise<void> {
  if (captures.has(tabId) || !chrome.debugger) return;
  await claimDebugger(tabId, "network");
  const capture: Capture = { startedAt: Date.now(), fromLoad, entries: new Map(), bytes: 0,
    pending: new Set(), targets: new Map([["", { tabId }]]), missing: new Set() };
  captures.set(tabId, capture);
  try {
    await send({ tabId }, "Page.enable");
    const tree = (await send({ tabId }, "Page.getFrameTree").catch(() => undefined)) as
      | { frameTree?: { frame?: { id?: string } } }
      | undefined;
    capture.mainFrame = tree?.frameTree?.frame?.id;
    await send({ tabId }, "Network.enable", { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 10_000_000 });
    // Embedded frames run in their own processes: each is its own session.
    await send({ tabId }, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    // Attaching to an already-open form must not require reloading it.
    if (!fromLoad) void recoverResources(tabId, capture);
  } catch (error) {
    await stopCapture(tabId);
    throw error;
  }
}

function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), milliseconds);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
  });
}

// Read Chrome's existing resource cache. No navigation, request replay, or
// interaction with the employer's page is involved.
async function recoverResources(tabId: number, capture: Capture): Promise<void> {
  if (capture.recovery) return capture.recovery;
  const entries = capture.entries;
  capture.recovery = (async () => {
    const resources: { target: Target; frameId: string; url: string; type: string; mimeType: string }[] = [];
    const visit = (tree: any, target: Target) => {
      if (!tree?.frame?.id) return;
      resources.push({ target, frameId: tree.frame.id, url: tree.frame.url, type: "Document", mimeType: tree.frame.mimeType || "text/html" });
      for (const resource of tree.resources || [])
        if (!resource.failed && !resource.canceled) resources.push({ target, frameId: tree.frame.id, ...resource });
      for (const child of tree.childFrames || []) visit(child, target);
    };
    for (const target of capture.targets.values()) {
      const result = await bounded(send(target, "Page.getResourceTree"), 1500);
      visit(result?.frameTree, target);
    }
    const candidates = resources.filter((resource) => /^https?:/.test(resource.url)).slice(0, 400);
    const deadline = Date.now() + 5000;
    for (const resource of candidates)
      if (![...entries.values()].some((entry) => entry.request.url === resource.url && entry.body)) capture.missing.add(resource.url);
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < candidates.length) {
        if (Date.now() >= deadline) return;
        const resource = candidates[next++];
        if (captures.get(tabId) !== capture || capture.entries !== entries) return;
        if ([...entries.values()].some((entry) => entry.request.url === resource.url && entry.body)) continue;
        // Signed/authentication resources are deliberately not retained.
        if (/[?&](?:access_token|refresh_token|id_token|token|password|code|key|signature)=/i.test(resource.url)) {
          capture.missing.add(resource.url); continue;
        }
        const result = await bounded(send(resource.target, "Page.getResourceContent", { frameId: resource.frameId, url: resource.url }), 1500);
        if (captures.get(tabId) !== capture || capture.entries !== entries) return;
        const text = result?.content;
        if (typeof text !== "string" || text.length > BODY_LIMIT) { capture.missing.add(resource.url); continue; }
        if (captures.get(tabId) !== capture || capture.entries !== entries) return;
        // Do not replace a response whose actual headers/status were captured.
        let entry = [...entries.values()].find((entry) => entry.request.url === resource.url && entry.request.method === "GET");
        if (entry?.body) continue;
        if (!entry) {
          entry = { startedAt: capture.startedAt, type: resource.type, recovered: true,
            request: { method: "GET", url: resource.url, headers: [] },
            response: { status: 200, statusText: "OK", headers: [], mimeType: resource.mimeType || "" } };
          entries.set(`cache:${resource.target.sessionId || ""}:${resource.url}`, entry);
        }
        entry.recovered = true;
        entry.body = { text, base64: Boolean(result?.base64Encoded) };
        capture.bytes += text.length;
        capture.missing.delete(resource.url);
        trim(capture);
      }
    }));
  })().finally(() => { capture.recovery = undefined; });
  return capture.recovery;
}

export async function stopCapture(tabId: number): Promise<void> {
  captures.delete(tabId);
  if (holdsDebugger(tabId, "network")) await releaseDebugger(tabId, "network");
}

// Chrome ended the session (tab closed, DevTools opened).
export function forgetCapture(tabId: number): void {
  captures.delete(tabId);
}

const key = (source: Target, requestId: unknown) => `${source.sessionId || ""}:${String(requestId)}`;

function trim(capture: Capture) {
  if (capture.entries.size > ENTRY_LIMIT) {
    const oldest = capture.entries.keys().next().value;
    if (oldest !== undefined) {
      capture.bytes -= capture.entries.get(oldest)?.body?.text.length || 0;
      capture.entries.delete(oldest);
    }
  }
  for (const entry of capture.entries.values()) {
    if (capture.bytes <= TOTAL_LIMIT) break;
    if (!entry.body) continue;
    capture.bytes -= entry.body.text.length;
    entry.body = undefined;
  }
}

chrome.debugger?.onEvent.addListener((rawSource, method, rawParams) => {
  const source = rawSource as Target;
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const capture = captures.get(tabId);
  if (!capture) return;
  const params = (rawParams || {}) as Record<string, any>;
  if (method === "Target.attachedToTarget" && params.sessionId) {
    const child: Target = { tabId, sessionId: params.sessionId };
    capture.targets.set(params.sessionId, child);
    void send(child, "Network.enable", { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 10_000_000 })
      .then(() => send(child, "Page.enable"))
      .then(() => send(child, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }))
      .catch(() => {});
    return;
  }
  if (method === "Network.requestWillBeSent") {
    // The page itself loading again starts a new capture: a replay needs
    // this page's requests, not the last one's.
    if (!source.sessionId && params.type === "Document" && params.frameId && params.frameId === capture.mainFrame && !params.redirectResponse) {
      capture.entries = new Map();
      capture.bytes = 0;
      capture.missing.clear();
      capture.fromLoad = true;
      capture.startedAt = Date.now();
    }
    const id = key(source, params.requestId);
    // A redirect keeps the earlier hop under its own key.
    if (params.redirectResponse && capture.entries.has(id)) {
      const earlier = capture.entries.get(id)!;
      earlier.response = {
        status: params.redirectResponse.status,
        statusText: params.redirectResponse.statusText || "",
        headers: headers(params.redirectResponse.headers),
        mimeType: params.redirectResponse.mimeType || "",
      };
      capture.entries.set(`${id}:${capture.entries.size}`, earlier);
      capture.entries.delete(id);
    }
    const request = params.request || {};
    capture.entries.set(id, {
      startedAt: Date.now(),
      type: params.type,
      request: {
        method: request.method || "GET",
        url: request.url || "",
        headers: headers(request.headers),
        ...(typeof request.postData === "string" ? { postData: request.postData.slice(0, BODY_LIMIT) } : {}),
        mimeType: request.headers?.["Content-Type"] || request.headers?.["content-type"],
      },
    });
    trim(capture);
    return;
  }
  const entry = capture.entries.get(key(source, params.requestId));
  if (!entry) return;
  if (method === "Network.responseReceived") {
    const response = params.response || {};
    entry.response = {
      status: response.status,
      statusText: response.statusText || "",
      headers: headers(response.headers),
      mimeType: response.mimeType || "",
    };
  } else if (method === "Network.loadingFinished") {
    if (params.encodedDataLength > BODY_LIMIT) return;
    const pending = send(source, "Network.getResponseBody", { requestId: params.requestId })
      .then((result) => {
        const text = String(result?.body ?? "");
        if (captures.get(tabId) !== capture || capture.entries.get(key(source, params.requestId)) !== entry || text.length > BODY_LIMIT) return;
        capture.bytes -= entry.body?.text.length || 0;
        entry.body = { text, base64: Boolean(result?.base64Encoded) };
        capture.bytes += text.length;
        trim(capture);
      })
      .catch(() => { capture.missing.add(entry.request.url); })
      .finally(() => capture.pending.delete(pending));
    capture.pending.add(pending);
  } else if (method === "Network.loadingFailed") {
    entry.failed = String(params.errorText || "failed");
  }
});

// The capture as a HAR 1.2 log, the format Playwright replays.
export async function captureHar(tabId: number): Promise<{ har: unknown; entries: number; fromLoad: boolean; recovered: number; missing: number } | undefined> {
  const capture = captures.get(tabId);
  if (!capture) return;
  // Include bodies still in flight and assets loaded before attachment.
  await bounded(Promise.allSettled([...capture.pending]), 2000);
  await bounded(recoverResources(tabId, capture), 6000);
  const entries = [...capture.entries.values()]
    .filter((entry) => entry.response && /^https?:/.test(entry.request.url))
    .map((entry) => ({
      startedDateTime: new Date(entry.startedAt).toISOString(),
      time: 0,
      _resourceType: entry.type,
      ...(entry.recovered ? { _fromCacheRecovery: true } : {}),
      request: {
        method: entry.request.method,
        url: entry.request.url,
        httpVersion: "HTTP/1.1",
        headers: entry.request.headers,
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: entry.request.postData?.length || 0,
        ...(entry.request.postData !== undefined
          ? { postData: { mimeType: entry.request.mimeType || "application/octet-stream", text: entry.request.postData } }
          : {}),
      },
      response: {
        status: entry.response!.status,
        statusText: entry.response!.statusText,
        httpVersion: "HTTP/1.1",
        headers: entry.response!.headers,
        cookies: [],
        content: {
          size: entry.body?.text.length || 0,
          mimeType: entry.response!.mimeType,
          ...(entry.body ? { text: entry.body.text, ...(entry.body.base64 ? { encoding: "base64" } : {}) } : {}),
        },
        redirectURL: entry.response!.headers.find((header) => /^location$/i.test(header.name))?.value || "",
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
    }));
  return {
    har: {
      log: {
        version: "1.2",
        creator: { name: "Application Lane", version: chrome.runtime.getManifest().version },
        pages: [],
        entries,
      },
    },
    entries: entries.length,
    fromLoad: capture.fromLoad,
    recovered: [...capture.entries.values()].filter((entry) => entry.recovered).length,
    missing: new Set([...capture.missing, ...[...capture.entries.values()].filter((entry) => entry.response && !entry.body).map((entry) => entry.request.url)]).size,
  };
}
