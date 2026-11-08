// Application Lane from the command line: queue many links, and see how the
// applications stand and which fills failed. It talks to the local backend
// (npm start); the extension tracks queued links and mirrors its queue there.
//
//   npm run lane -- add <link…|file…>   queue links (a file holds one per line)
//   npm run lane -- status [--json]     applications by stage, and what needs you
//   npm run lane -- failures [--json]   fills that failed, with why
//   npm run lane -- watch               print each change as it happens
//   npm run lane -- fill <application>  Fill this step on its tab
//   npm run lane -- switch <application> bring its tab to the front
//   npm run lane -- abandon <application> stop applying, as the panel's Abandon
//   npm run lane -- search [options]    find openings to apply for
//   npm run lane -- ui                  a full-screen view to do all of this
//   npm run lane -- pair                a new pairing code for another browser
// An application is named by the short id status shows, or by part of its
// company or title.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { dataDirectory } from "../src/server/store";
import type { QueueSnapshot, QueueSummaryItem, SubmissionRecord } from "../src/shared/model";
import { themes } from "../src/shared/theme";
import { computeProgress, DEFAULT_DAILY_GOAL } from "../src/shared/progress";
import { colorDepth, createPalette, openingLine, styled, tabStrip, terminalTheme, visible } from "./lane-view";
import { liveLine } from "./lane-live";

const base = process.env.LANE_URL || "http://127.0.0.1:4318";
const [command = "help", ...args] = process.argv.slice(2);
const json = args.includes("--json");
// --theme <name> picks the colours (LANE_THEME too); it is not a word.
const words = args.filter((arg, index) => arg !== "--json" && arg !== "--theme" && args[index - 1] !== "--theme");
const theme = themes[terminalTheme(args, process.env)];
const colors = createPalette(theme, colorDepth(process.env, Boolean(process.stdout.isTTY)));

async function token(): Promise<string> {
  const config = JSON.parse(await readFile(join(dataDirectory, "config.json"), "utf8").catch(() => {
    throw new Error(`No configuration in ${dataDirectory}. Start the backend once (npm start or application-lane) to create it.`);
  }));
  return config.token;
}
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {
    throw new Error(`The backend is not running at ${base}. Start it with npm start in the project folder (or application-lane if installed), and keep that window open.`);
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The backend answered ${response.status}.`);
  return data as T;
}

const ago = (at: number) => {
  const minutes = Math.round((Date.now() - at) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
};
const name = (app: QueueSummaryItem) => `${app.company || new URL(app.url).hostname} — ${app.title}`.slice(0, 90);
const short = (app: QueueSummaryItem) => app.id.slice(0, 6);
// The questions a fill left for the applicant, one to a line under whether
// the form needs them: required ones block the application, optional ones
// only wait on a choice.
const questions = (app: QueueSummaryItem, most = 10) =>
  ([[app.needs, "Required"], [app.optional || [], "Optional"]] as const).flatMap(([items, heading]) =>
    items.length
      ? [`${heading} (${items.length}):`, ...items.slice(0, most).map((item) => `  • ${item}`), ...(items.length > most ? [`  …and ${items.length - most} more`] : [])]
      : [],
  );
// A fill that failed: the application failed, or its last fill ended in error.
const failed = (app: QueueSummaryItem) => app.status === "failed" || app.lastFill?.status === "error";
// Applications the fixer is correcting: shown apart, so they are left alone
// until it is done (lane fixing / lane fixed).
let fixing: Record<string, { since: number; note: string }> = {};
const group = (app: QueueSummaryItem) =>
  app.stage === "submitted" ? "submitted"
    : app.status === "cancelled" || app.stage === "abandoned" ? "closed"
    : fixing[app.id] ? "being fixed"
    : failed(app) ? "failed"
    : ["queued", "inspecting", "preparing", "filling"].includes(app.status) || app.assisting ? "in progress"
    : app.status === "ready" ? "ready to review"
    : "needs you";

const readFixing = async () => {
  fixing = await api<typeof fixing>("/v1/fixing").catch(() => fixing);
};
async function snapshot(): Promise<QueueSnapshot> {
  await readFixing();
  const queue = await api<QueueSnapshot | null>("/v1/queue");
  if (!queue) throw new Error("The extension has not sent its queue yet. Open Chrome with the extension paired.");
  return queue;
}

async function add() {
  const urls: string[] = [];
  for (const word of words) {
    if (/^https?:\/\//i.test(word)) urls.push(word);
    else if (existsSync(word))
      urls.push(...(await readFile(word, "utf8")).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^https?:\/\//i.test(line)));
    else throw new Error(`Not a link or a file: ${word}`);
  }
  if (!urls.length) throw new Error("Give links, or files with one link per line.");
  const result = await api<{ added: number; waiting: number; now?: boolean }>("/v1/inbox", "POST", { urls: [...new Set(urls)] });
  console.log(`Queued ${result.added} link${result.added === 1 ? "" : "s"} (${result.waiting} waiting). The extension tracks them ${result.now ? "now" : "within a minute"}, ten at a time; a site it has no access to yet is offered in the panel.`);
}

async function status() {
  const queue = await snapshot();
  const inbox = await api<{ url: string }[]>("/v1/inbox");
  if (json) return console.log(JSON.stringify({ ...queue, inbox: inbox.map((item) => item.url) }, null, 2));
  const counts = new Map<string, number>();
  for (const app of queue.applications) counts.set(group(app), (counts.get(group(app)) || 0) + 1);
  console.log(colors.bold(`As of ${ago(queue.at)}: ${queue.applications.length} applications.`));
  for (const key of ["being fixed", "in progress", "needs you", "ready to review", "failed", "submitted", "closed"])
    if (counts.get(key)) console.log(`  ${colors.group(key)(key.padEnd(16))} ${colors.bold(String(counts.get(key)))}`);
  if (inbox.length) console.log(`  ${colors.info("queued links".padEnd(16))} ${inbox.length} not tracked yet`);
  const beingFixed = queue.applications.filter((app) => group(app) === "being fixed");
  if (beingFixed.length) {
    console.log(`\n${colors.group("being fixed")(colors.bold("Being fixed (leave these alone for now):"))}`);
    for (const app of beingFixed)
      console.log(`  ${colors.muted(`[${short(app)}]`)} ${colors.bold(name(app))}${fixing[app.id].note ? `\n    ${fixing[app.id].note}` : ""}`);
  }
  const waiting = queue.applications.filter((app) => group(app) === "needs you").sort((a, b) => b.updatedAt - a.updatedAt);
  if (waiting.length) {
    console.log(`\n${colors.group("needs you")(colors.bold("Needs you:"))}`);
    for (const app of waiting.slice(0, 15))
      console.log(`  ${colors.muted(`[${short(app)}]`)} ${colors.bold(name(app))}\n    ${(questions(app, 3).length ? questions(app, 3) : [app.note.slice(0, 120)]).join("\n    ")}`);
    if (waiting.length > 15) console.log(`  …and ${waiting.length - 15} more`);
  }
  const failures = queue.applications.filter(failed).length;
  if (failures) console.log(`\n${colors.danger(`${failures} failed fill${failures === 1 ? "" : "s"}`)}: npm run lane -- failures`);
}

async function failures() {
  const queue = await snapshot();
  const list = queue.applications.filter(failed).sort((a, b) => b.updatedAt - a.updatedAt);
  if (json) return console.log(JSON.stringify(list, null, 2));
  if (!list.length) return console.log(`No failed fills (as of ${ago(queue.at)}).`);
  for (const app of list) {
    console.log(`${colors.muted(`[${short(app)}]`)} ${colors.bold(name(app))}  ${colors.muted(`(${ago(app.updatedAt)})`)}\n  ${colors.info(app.url)}`);
    console.log(`  ${colors.danger((app.lastFill?.note || app.note).slice(0, 200))}`);
    for (const line of questions(app)) console.log(`  ${line.slice(0, 200)}`);
    if (app.reports) console.log(`  ${app.reports} issue report${app.reports === 1 ? "" : "s"} filed`);
  }
}

async function watch() {
  const seen = new Map<string, string>();
  let first = true;
  for (;;) {
    const queue = await snapshot().catch((error) => {
      console.error(error.message);
      return undefined;
    });
    for (const app of queue?.applications || []) {
      const now = `${group(app)}: ${app.note}`;
      if (!first && seen.get(app.id) !== now) console.log(`${new Date().toLocaleTimeString()}  ${name(app)}\n  ${group(app)} — ${app.note.slice(0, 140)}`);
      seen.set(app.id, now);
    }
    if (first) console.log(`Watching ${queue?.applications.length ?? 0} applications. Ctrl+C to stop.`);
    first = false;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

// The live line to the extension, through the backend (lane-live.ts).
const connect = async (onQueue?: (queue: QueueSnapshot) => void, keep?: { onDown: () => void; onUp: () => void }) =>
  liveLine(`${base.replace(/^http/, "ws")}/v1/live`, token, base, onQueue, keep);
// One application from the queue, by its short id or by part of its name.
function find(queue: QueueSnapshot, wanted: string): QueueSummaryItem {
  if (!wanted) throw new Error("Name an application: its short id from status, or part of its company or title.");
  const text = wanted.toLowerCase();
  const byId = queue.applications.filter((app) => app.id.startsWith(text));
  const matches = byId.length ? byId : queue.applications.filter((app) => app.stage !== "submitted" && name(app).toLowerCase().includes(text));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`No application matches "${wanted}".`);
  throw new Error(`"${wanted}" matches ${matches.length}: ${matches.slice(0, 5).map((app) => `[${short(app)}] ${name(app)}`).join(", ")}`);
}
// lane fixing <application> [note]: mark it as being corrected by the
// fixer; lane fixed <application>: done, back with the rest.
async function markFixing(done: boolean) {
  const [target, ...note] = words;
  if (!target) {
    await readFixing();
    const queue = await snapshot();
    const list = queue.applications.filter((app) => fixing[app.id]);
    return console.log(list.length ? list.map((app) => `[${short(app)}] ${name(app)}${fixing[app.id].note ? ` — ${fixing[app.id].note}` : ""}`).join("\n") : "Nothing is being fixed.");
  }
  const app = find(await snapshot(), target);
  await api("/v1/fixing", "POST", done ? { id: app.id, done: true } : { id: app.id, note: note.join(" ") });
  console.log(`${name(app)}: ${done ? "no longer marked as being fixed." : "marked as being fixed."}`);
}

// lane reload: the extension takes its newest build (refused while anything
// fills); lane refresh <application>: its page then loads that build.
async function reload() {
  const line = await connect();
  const result = await line.send("reload");
  line.socket.close();
  if (!result.ok) throw new Error(result.error || "It did not reload.");
  console.log(result.detail || "Reloading.");
}

async function act(action: "fill" | "switch" | "abandon" | "refresh") {
  const app = find(await snapshot(), words.join(" "));
  const line = await connect();
  const result = await line.send(action, app.id);
  line.socket.close();
  if (!result.ok) throw new Error(result.error || "It did not work.");
  console.log(`${name(app)}: ${result.detail || "done."}`);
}

// Finding jobs (src/server/job-search.ts): the saved settings, with these
// for one search; the openings, numbered for lane search add.
type Listing = { id: string; title: string; company: string; locations: string[]; url: string; postedAt?: number; source: string; matched: string[]; tracked?: boolean };
type SearchResult = { at: number; roles: string[]; locations: string[]; country: string; listings: Listing[]; sources: { id: string; count: number; error?: string }[] };
const listingLine = (listing: Listing) => openingLine(listing, ago);
async function search() {
  // lane search add 1 4 7: queue openings from the latest search.
  if (words[0] === "add") {
    const latest = await api<SearchResult | null>("/v1/search");
    if (!latest) throw new Error("Search first: npm run lane -- search");
    const picked = words.slice(1).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= latest.listings.length);
    if (!picked.length) throw new Error(`Give the numbers of openings to queue, 1 to ${latest.listings.length}.`);
    const urls = picked.map((n) => latest.listings[n - 1].url);
    const result = await api<{ added: number; waiting: number; now?: boolean }>("/v1/inbox", "POST", { urls });
    return console.log(`Queued ${result.added} opening${result.added === 1 ? "" : "s"}. ${result.now ? "The extension is tracking them now." : "The extension tracks them within a minute."}`);
  }
  const values = (flag: string) => words.flatMap((word, index) => (words[index - 1] === flag ? word.split(",").map((item) => item.trim()).filter(Boolean) : []));
  const overrides: Record<string, unknown> = {};
  if (values("--role").length) overrides.roles = values("--role");
  if (values("--place").length) overrides.locations = values("--place");
  if (values("--company").length) overrides.companies = values("--company");
  if (values("--country").length) overrides.country = values("--country")[0];
  if (values("--days").length) overrides.postedWithinDays = Number(values("--days")[0]);
  if (words.includes("--no-profile")) overrides.fromProfile = false;
  if (words.includes("--profile")) overrides.fromProfile = true;
  if (words.includes("--internships")) overrides.sources = { newGrad: !words.includes("--no-new-grad"), internships: true, boards: true };
  // --save keeps these for later searches, here and on the dashboard.
  if (words.includes("--save")) {
    const { settings } = await api<{ settings: Record<string, unknown> }>("/v1/search/settings");
    await api("/v1/search/settings", "PUT", { ...settings, ...overrides });
  }
  const result = await api<SearchResult>("/v1/search", "POST", overrides);
  if (json) return console.log(JSON.stringify(result, null, 2));
  console.log(`Looked for ${result.roles.join(", ") || "any role"}${result.locations.length ? ` in ${result.locations.join(", ")}` : ""}${result.country ? ` (${result.country})` : ""}.`);
  for (const source of result.sources) console.log(`  ${source.id}: ${source.error || `${source.count} open`}`);
  if (!result.listings.length) return console.log("No openings matched.");
  console.log("");
  for (const [index, listing] of result.listings.entries()) console.log(`${String(index + 1).padStart(3)}. ${listingLine(listing)}\n     ${listing.url}`);
  console.log(`\nQueue some with: npm run lane -- search add 1 2 3`);
}

// A full-screen view: applications by stage, one selected, its details, and
// the side panel's actions on a key; and the latest job search, to queue
// openings from.
async function ui() {
  if (!process.stdin.isTTY) throw new Error("ui needs a terminal.");
  const tabs = ["needs you", "being fixed", "in progress", "failed", "ready to review", "submitted", "all", "find jobs"] as const;
  let queue = await snapshot();
  let found = await api<SearchResult | null>("/v1/search").catch(() => null);
  // The submissions history, for the streak and today's goal in the header.
  let submissions = await api<SubmissionRecord[]>("/v1/submissions").catch(() => undefined);
  const goal = Number(process.env.LANE_GOAL) || DEFAULT_DAILY_GOAL;
  const submittedNow = () => queue.applications.filter((app) => app.stage === "submitted").length;
  let submittedSeen = submittedNow();
  const readSubmissions = () =>
    void api<SubmissionRecord[]>("/v1/submissions").then((next) => ((submissions = next), draw()), () => {});
  // The chevrons beside an application being filled move on a timer that
  // runs only while one is.
  const filling = (app: QueueSummaryItem) => ["inspecting", "preparing", "filling"].includes(app.status);
  let frame = 0;
  let spinner: NodeJS.Timeout | undefined;
  const animate = () => {
    const needed = queue.applications.some(filling);
    if (needed && !spinner) spinner = setInterval(() => ((frame = (frame + 1) % 6), draw()), 180);
    if (!needed && spinner) (clearInterval(spinner), (spinner = undefined));
  };
  // What the fixer marks shows without waiting for the queue to change.
  setInterval(() => void readFixing().then(draw), 10_000).unref();
  let tab = 0;
  let row = 0;
  let message = "";
  // Links being typed or pasted to queue (a), shown on the last line.
  let typing: string | undefined;
  // An application waiting on y to be abandoned.
  let abandoning: QueueSummaryItem | undefined;
  const line = await connect(
    (next) => {
      queue = next;
      void readFixing().then(draw);
      if (submittedNow() !== submittedSeen) (submittedSeen = submittedNow()), readSubmissions();
      animate();
      draw();
    },
    {
      onDown: () => {
        message = "Reconnecting to the backend…";
        draw();
      },
      onUp: async () => {
        queue = await snapshot().catch(() => queue);
        message = "Reconnected.";
        draw();
      },
    },
  );
  const searching = () => tabs[tab] === "find jobs";
  const shown = () =>
    queue.applications
      .filter((app) => tabs[tab] === "all" || group(app) === tabs[tab])
      .sort((a, b) => b.updatedAt - a.updatedAt);
  const rows = () => (searching() ? found?.listings || [] : shown());
  const out = process.stdout;
  const fit = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width));
  function draw() {
    const width = Math.max(40, out.columns || 100);
    const height = Math.max(12, out.rows || 30);
    const list = rows();
    row = Math.min(row, Math.max(0, list.length - 1));
    const lines: string[] = [];
    // The title bar: the brand shaded across the theme's two colours.
    const asOf = `  as of ${ago(queue.at)}`;
    lines.push(
      colors.on
        ? `${colors.gradient(" ▸▸ Application Lane".slice(0, width))}${colors.muted(fit(asOf, Math.max(0, width - 20)).trimEnd())}`
        : styled(`Application Lane${asOf}`, width, "\x1b[1m"),
    );
    // Streak, today against the goal, and the total, in one line.
    const progress = computeProgress({ submissions, applications: queue.applications.map((app) => ({ filled: app.lastFill?.filled })), goal });
    const header = [
      `🔥 ${progress.streak}-day streak`,
      `today ${"▰".repeat(Math.min(progress.goal, progress.today))}${"▱".repeat(Math.max(0, progress.goal - progress.today))} ${progress.today}/${progress.goal}`,
      `${progress.total} submitted`,
      progress.level.name,
    ];
    let stats = "";
    for (const part of header) if (visible(`${stats} · ${part}`).length <= width - 1) stats = stats ? `${stats} · ${part}` : ` ${part}`;
    lines.push(
      colors.on
        ? stats
            .replace(/🔥 (\d+)-day streak/, (_, days) => `${colors.warning("🔥")} ${colors.bold(days)}${colors.muted("-day streak")}`)
            .replace(/today ([▰▱]+) (\d+\/\d+)/, (_, bar, count) => `${colors.muted("today")} ${colors.meter(progress.today, progress.goal)} ${progress.goalMet ? colors.success(count) : colors.bold(count)}`)
            .replace(/(\d+) submitted/, (_, n) => `${colors.group("submitted")(n)}${colors.muted(" submitted")}`)
            .replace(progress.level.name, colors.accent(progress.level.name))
            .replaceAll(" · ", colors.muted(" · "))
        : stats,
    );
    lines.push(tabStrip(tabs.map((name) => {
      const count = name === "find jobs" ? found?.listings.length ?? 0 : name === "all" ? queue.applications.length : queue.applications.filter((app) => group(app) === name).length;
      return ` ${name} (${count}) `;
    }), tab, width, colors.on ? {
      selected: (label, index) => colors.chip(colors.groupColor(tabs[index]), label),
      other: (label, index) => colors.group(tabs[index])(label),
    } : {}));
    // The selected item's details first: they decide how much room the list
    // keeps (the header, the rule and the two lines at the foot take six).
    const detail: string[] = [];
    if (searching() && list[row]) {
      const listing = list[row] as Listing;
      detail.push(fit(listing.url, width));
      detail.push(fit(`${listing.source} · for ${listing.matched.join(" in ")}${listing.postedAt ? ` · posted ${ago(listing.postedAt)}` : ""}`, width));
      detail.push(fit(listing.locations.join("; "), width));
      if (found) detail.push(fit(`searched ${ago(found.at)} for ${found.roles.join(", ")}`, width));
    } else if (list[row]) {
      const app = list[row] as QueueSummaryItem;
      detail.push(colors.info(fit(app.url, width)));
      const facts = fit(`${app.status} · ${app.stage} · updated ${ago(app.updatedAt)}${app.reports ? ` · ${app.reports} report${app.reports === 1 ? "" : "s"}` : ""}`, width);
      detail.push(colors.on ? facts.replace(app.status, colors.group(group(app))(colors.bold(app.status))).replace(` ${app.stage} `, ` ${colors.accent(app.stage)} `) : facts);
      detail.push(fit(app.note, width));
      if (app.lastFill) {
        const last = fit(`last fill: ${app.lastFill.status}, ${app.lastFill.filled} filled. ${app.lastFill.note}`, width);
        detail.push(colors.on ? last.replace("last fill:", colors.muted("last fill:")) : last);
      }
      // Each question left on a line of its own, under whether the form
      // needs it (the questions run together on one cut-off line, 2026-10-30).
      for (const [items, heading, color] of [
        [app.needs, "Required — the form needs these", colors.on ? `\x1b[1m${sgrOf(theme.danger)}` : "\x1b[1;31m"],
        [app.optional || [], "Optional", colors.on ? sgrOf(theme.warning) : "\x1b[33m"],
      ] as const)
        if (items.length) {
          detail.push(`${color}${fit(`${heading} (${items.length}):`, width)}\x1b[0m`);
          for (const item of items) detail.push(fit(`  • ${item}`, width));
        }
    }
    const room = height - 6;
    detail.splice(Math.max(4, room - 3));
    const listHeight = Math.max(3, room - detail.length);
    const start = Math.max(0, Math.min(row - Math.floor(listHeight / 2), list.length - listHeight));
    for (const [index, item] of list.slice(start, start + listHeight).entries()) {
      const app = searching() ? undefined : (item as QueueSummaryItem);
      // An application being filled has the moving chevrons before it.
      const lead = app && filling(app) ? 4 : 0;
      const text = fit(searching() ? `${start + index + 1}. ${listingLine(item as Listing)}` : `[${short(app!)}] ${name(app!)} · ${app!.status}`, width - 2 - lead);
      const chevrons = lead ? `${colors.chevrons(frame)} ` : "";
      if (start + index === row) lines.push(`${colors.selected(" ")}${chevrons}${colors.selected(text)}`);
      else if (!app || !colors.on) lines.push(` ${chevrons}${text}`);
      else {
        // The id muted, the status in its stage's colour.
        const suffix = ` · ${app.status}`;
        const at = text.lastIndexOf(suffix);
        const body = at >= 0 && text.trimEnd().endsWith(app.status) ? text.slice(0, at) : text;
        const rest = at >= 0 && body !== text ? text.slice(at) : "";
        lines.push(` ${chevrons}${body.replace(/^\[[0-9a-z-]+\]/, (id) => colors.muted(id))}${rest ? rest.replace(app.status, colors.group(group(app))(app.status)) : ""}`);
      }
    }
    if (!list.length) lines.push(searching() ? " No search yet: press / to search with your saved settings." : " Nothing here.");
    while (lines.length < listHeight + 3) lines.push("");
    lines.push(colors.muted("─".repeat(width)));
    lines.push(...detail);
    while (lines.length < height - 2) lines.push("");
    lines.push(typing !== undefined ? colors.accent(fit(`Links to queue: ${typing}▏`, width)) : colors.info(fit(message, width)));
    lines.push(styled(
      typing !== undefined
        ? "paste or type links, Enter to queue, Esc to cancel"
        : searching()
          ? "←/→ tabs · ↑/↓ select · a queue this opening · / search again · q quit"
          : "←/→ tabs · ↑/↓ select · f fill this step · s switch to its tab · x abandon · a add links · r refresh · q quit",
      width,
      "\x1b[2m",
    ));
    // Each line over the last, erasing what is left of it, so a redraw (the
    // chevrons' every few hundred milliseconds) does not flicker.
    out.write(`\x1b[H${lines.slice(0, height).map((text) => `${text}\x1b[K`).join("\n")}\x1b[J`);
  }
  const quit = () => {
    if (spinner) clearInterval(spinner);
    out.write("\x1b[?25h\x1b[2J\x1b[H");
    process.stdin.setRawMode(false);
    line.close();
    process.exit(0);
  };
  const queueLinks = async (urls: string[]) => {
    const result = await api<{ added: number; waiting: number; now?: boolean }>("/v1/inbox", "POST", { urls });
    return `Queued ${result.added} link${result.added === 1 ? "" : "s"}. ${result.now ? "The extension is tracking it now." : "The extension tracks them within a minute."}`;
  };
  out.write("\x1b[?25l");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", async (key: Buffer) => {
    const k = key.toString();
    // Typing links: everything goes into the line, pastes too, until Enter.
    if (typing !== undefined) {
      if (k === "\u0003") return quit();
      if (k === "\x1b") typing = undefined;
      else if (k === "\r" || k === "\n") {
        const urls = typing.split(/\s+/).filter((word) => /^https?:\/\//i.test(word));
        typing = undefined;
        message = urls.length ? await queueLinks(urls).catch((error) => error.message) : "No links given.";
      } else if (k === "\x7f" || k === "\b") typing = typing.slice(0, -1);
      else if (!k.startsWith("\x1b")) typing += k.replace(/[\r\n]+/g, " ");
      return draw();
    }
    // Abandoning asks first, as the panel's Abandon does.
    if (abandoning) {
      const app = abandoning;
      abandoning = undefined;
      if (k === "\u0003") return quit();
      if (k === "y" || k === "Y") {
        message = `Abandoning ${name(app)}…`;
        draw();
        const result = await line.send("abandon", app.id);
        message = result.ok ? `${name(app)}: ${result.detail || "abandoned."}` : `${name(app)}: ${result.error}`;
        queue = await snapshot().catch(() => queue);
      } else message = "Not abandoned.";
      return draw();
    }
    const list = rows();
    if (k === "q" || k === "\u0003") return quit();
    if (k === "\x1b[C" || k === "\t") (tab = (tab + 1) % tabs.length), (row = 0);
    else if (k === "\x1b[D" || k === "\x1b[Z") (tab = (tab + tabs.length - 1) % tabs.length), (row = 0);
    else if (k === "\x1b[B" || k === "j") row = Math.min(row + 1, list.length - 1);
    else if (k === "\x1b[A" || k === "k") row = Math.max(row - 1, 0);
    else if (k === "r") {
      queue = await snapshot().catch(() => queue);
      readSubmissions();
      animate();
      message = "Refreshed.";
    } else if (k === "/" && searching()) {
      message = "Searching…";
      draw();
      found = await api<SearchResult>("/v1/search", "POST", {}).catch((error) => ((message = error.message), found));
      if (message === "Searching…") message = `${found?.listings.length ?? 0} openings.`;
      row = 0;
    } else if (k === "a" && searching() && list[row]) {
      const listing = list[row] as Listing;
      message = await queueLinks([listing.url]).catch((error) => error.message);
      if (found) found = { ...found, listings: found.listings.map((item) => (item.id === listing.id ? { ...item, tracked: true } : item)) };
    } else if (k === "a") typing = "";
    else if (k === "x" && !searching() && list[row]) {
      abandoning = list[row] as QueueSummaryItem;
      message = `Abandon ${name(abandoning)}? Any fill stops; what is on the page stays. y to abandon, any other key to keep it.`;
    } else if ((k === "f" || k === "s") && !searching() && list[row]) {
      const app = list[row] as QueueSummaryItem;
      message = `${k === "f" ? "Filling" : "Switching to"} ${name(app)}…`;
      draw();
      const result = await line.send(k === "f" ? "fill" : "switch", app.id);
      message = result.ok ? `${name(app)}: ${result.detail || "done."}` : `${name(app)}: ${result.error}`;
    }
    draw();
  });
  out.on("resize", draw);
  out.write("\x1b[2J");
  animate();
  draw();
}

const sgrOf = (hex: string) => colors.fg(hex)("").replace("\x1b[0m", "");

// A new pairing code, to connect another browser or extension: the backend
// shows it in its own window too, and it works for ten minutes.
async function pair() {
  const { code, expiresAt } = await api<{ code: string; expiresAt?: number }>("/v1/pair/open", "POST");
  console.log(`Pairing code: ${code.slice(0, 3)} ${code.slice(3)}${expiresAt ? ` (valid until ${new Date(expiresAt).toLocaleTimeString()})` : ""}`);
  console.log("Type it on the extension's dashboard: Connect to Application Lane on this computer.");
}

const commands: Record<string, () => Promise<unknown>> = {
  add,
  pair,
  status,
  failures,
  watch,
  fill: () => act("fill"),
  switch: () => act("switch"),
  abandon: () => act("abandon"),
  refresh: () => act("refresh"),
  reload,
  fixing: () => markFixing(false),
  fixed: () => markFixing(true),
  search,
  ui,
};
const run = commands[command];
if (!run) {
  console.log(`Usage: lane <command>   (in a checkout: npm run lane -- <command>)
  add <link…|file…>   queue links (a file holds one per line)
  status [--json]     applications by stage, and what needs you
  failures [--json]   fills that failed, with why
  watch               print each change as it happens
  fill <application>  Fill this step on its tab
  switch <application> bring its tab to the front in Chrome
  abandon <application> stop applying: any fill stops, and it moves to Abandoned
  reload              the extension takes its newest build (not while anything is being filled)
  refresh <application> reload its page, as after a reload (not while it is being filled)
  fixing [<application> [note]]  mark it as being fixed (shown apart; leave it alone); alone, list them
  fixed <application> it is done being fixed
  search [options]    find openings to apply for (see below); search add 1 2 queues them
  ui                  a full-screen view: tabs by stage, f fill, s switch, x abandon, a add links, a find-jobs tab
  pair                show a new pairing code to connect another browser or extension
  --theme <name>      colours: midnight (default), velocity, ember, aurora, sage, contrast (or LANE_THEME);
                      NO_COLOR turns them off, FORCE_COLOR=0..3 forces a depth
An application is named by the short id status shows, or by part of its company or title.
search uses the settings saved on the dashboard's Find jobs page; for this search only:
  --role "software engineer,machine learning"  --place "Toronto,Remote"  --country Canada
  --company https://jobs.ashbyhq.com/notion  --days 14  --internships  --profile | --no-profile
  --save keeps them for later searches.`);
} else {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
