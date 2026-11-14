import type { BadgeInfo } from "./badge-info";

// A small badge in the corner of an application's page: how its fill is
// going, without the side panel open. It lives in a closed
// shadow root, so the page's styles do not reach it and the form reader,
// which walks only open roots, never sees it. Clicking it opens the side
// panel; its × hides it on this page until the page loads again.

let host: HTMLElement | undefined;
let root: ShadowRoot | undefined;
let dismissed = false;
// What the backend last said, and a word from the page itself about the
// site's session (content.ts), which the backend's next word does not undo.
let lastInfo: BadgeInfo | null = null;
let session: "extended" | "expired" | undefined;
let sessionTimer: ReturnType<typeof setTimeout> | undefined;

const styles = `
  :host { all: initial; }
  .badge {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    display: flex; align-items: center; gap: 10px; max-width: 320px;
    padding: 8px 10px 8px 12px; border-radius: 999px;
    background: #16181d; color: #f3f4f6; box-shadow: 0 6px 20px rgba(0,0,0,.28);
    font: 500 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer;
    border: 1px solid rgba(255,255,255,.12);
  }
  .badge:focus-visible { outline: 2px solid #8b9cff; outline-offset: 2px; }
  .mark { flex: none; width: 10px; height: 10px; border-radius: 50%; background: #9ca3af; }
  .working .mark { background: transparent; border: 2px solid #8b9cff; border-top-color: transparent; width: 8px; height: 8px; animation: spin .8s linear infinite; }
  .done .mark, .submitted .mark { background: #34d399; }
  .attention .mark { background: #fbbf24; }
  .paused .mark { background: #9ca3af; }
  .warn { border-color: rgba(248,113,113,.6); }
  .warn .mark { background: #f87171; }
  .text { display: flex; flex-direction: column; min-width: 0; }
  .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .detail { color: #a1a7b3; font-size: 11px; font-weight: 400; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .detail:empty { display: none; }
  .close { flex: none; border: 0; background: none; color: #a1a7b3; font: 16px/1 system-ui, sans-serif; cursor: pointer; padding: 2px 4px; border-radius: 6px; }
  .close:hover { color: #f3f4f6; background: rgba(255,255,255,.08); }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .working .mark { animation: none; border-top-color: #8b9cff; } }
`;

// The site's session, as the page saw it: kept open by pressing its own
// keep-working button (said for 20 seconds), or expired (said until the page
// loads again, the applicant having to sign in).
export function noteSession(state: "extended" | "expired") {
  if (window.top !== window) return;
  session = state;
  clearTimeout(sessionTimer);
  if (state === "extended")
    sessionTimer = setTimeout(() => {
      session = undefined;
      showBadge(lastInfo);
    }, 20_000);
  showBadge(lastInfo);
}

function withSession(info: BadgeInfo | null): BadgeInfo | null {
  if (session === "expired") {
    const shortcut = info?.detail.match(/^(.+) fills this step$/)?.[1];
    return {
      tone: "attention",
      title: "Session expired",
      detail: shortcut ? `Sign in again, then press ${shortcut}` : "Sign in again, then fill this step from the side panel",
    };
  }
  if (session === "extended")
    return info
      ? { ...info, detail: "Kept the site's session open" }
      : { tone: "idle", title: "Session kept open", detail: "The site was about to time out" };
  return info;
}

export function showBadge(given: BadgeInfo | null) {
  if (window.top !== window) return;
  lastInfo = given;
  if (dismissed) return;
  const info = withSession(given);
  if (!info) {
    host?.remove();
    host = undefined;
    return;
  }
  // A badge an earlier copy of this script drew stays when the extension is
  // reloaded and the page refreshed into the new build: its script can no
  // longer remove it, and the page showed three (a stale "Fill failed" beside
  // the current one). Each update leaves only this copy's.
  document.querySelectorAll("application-lane-badge").forEach((other) => { if (other !== host) other.remove(); });
  if (!host || !host.isConnected) {
    host = document.createElement("application-lane-badge");
    host.setAttribute("data-application-lane", "badge");
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${styles}</style><div class="badge" role="button" tabindex="0" aria-label="Application Lane: open the side panel"><span class="mark" aria-hidden="true"></span><span class="text"><span class="title"></span><span class="detail"></span></span><button class="close" type="button" aria-label="Hide on this page">×</button></div>`;
    const badge = root.querySelector<HTMLElement>(".badge")!;
    const open = () => void chrome.runtime.sendMessage({ type: "OPEN_PANEL" }).catch(() => {});
    badge.addEventListener("click", (event) => {
      if ((event.target as Element).closest(".close")) return;
      open();
    });
    badge.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") (event.preventDefault(), open());
    });
    root.querySelector(".close")!.addEventListener("click", (event) => {
      event.stopPropagation();
      dismissed = true;
      host?.remove();
      host = undefined;
    });
    (document.body || document.documentElement).append(host);
  }
  const badge = root!.querySelector<HTMLElement>(".badge")!;
  badge.className = `badge ${info.tone}`;
  root!.querySelector(".title")!.textContent = info.title;
  root!.querySelector(".detail")!.textContent = info.detail;
  badge.title = [info.title, info.detail].filter(Boolean).join(" · ");
  // What it says, on the host too (tests read it there).
  host.dataset.tone = info.tone;
  host.title = badge.title;
}
