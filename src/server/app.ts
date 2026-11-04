import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, join, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { generationSchema, profileSchema, type FixerItem, type FixerOverview, type FixerResult } from "../shared/model";
import { cleanFixerSettings } from "../shared/fixer-settings";
import { devToolsEnabled } from "../shared/dev-tools";
import { Store, atomicJSON, type Config } from "./store";
import { attachLive } from "./live";
import { profileTargets, searchJobs, searchSettingsSchema, stageDefaults, openingKey } from "./job-search";
import { GenerationQueue, draftProviderChain, type Generate } from "./generation";
import { extractResume, transcriptsFolder } from "./documents";
import { desktopPath, exportDocuments, exportedPaths, markSent, openFolder, removeWritten } from "./export";
import { bundleSchema, exportBundle, importTailoringFiles, importedTailoring } from "./profile-bundle";
import { skillContext } from "./answers";
import { applicationProfile, profileConflicts } from "./profile-sync";
import { configView, saveTranscript, updateConfig } from "./settings";
import { packageRoot, packageVersion } from "./paths";
import { Pairing, pairingBanner, type PairingAnnouncement } from "./pairing";

const recordingSchema = z
.object({
  id: z.string().uuid(),
  auto: z.boolean().optional(),
  createdAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  tab: z.object({
    url: z.string().url().max(3000),
    title: z.string().max(1000),
  }),
  pages: z.array(z.string().max(3000)).max(200),
  eventCount: z.number().int().nonnegative(),
  summary: z
    .object({
      valueChanges: z.number().int().nonnegative(),
      directChanges: z.number().int().nonnegative(),
      callsBySource: z.record(z.number().int().nonnegative()),
      pageCalls: z.number().int().nonnegative(),
    })
    .optional(),
  events: z
    .array(
      z.object({
        t: z.number(),
        kind: z.string().max(40),
        frameId: z.number().int().optional(),
        data: z.record(z.unknown()),
      }),
    )
    .max(30_000),
});
const queueSnapshotSchema = z.object({
  at: z.number(),
  applications: z.array(z.object({
    id: z.string().max(100),
    url: z.string().max(2000),
    company: z.string().max(300),
    title: z.string().max(500),
    status: z.string().max(40),
    stage: z.string().max(40),
    note: z.string().max(1000),
    needs: z.array(z.string().max(300)).max(10),
    optional: z.array(z.string().max(300)).max(10).optional(),
    updatedAt: z.number(),
    lastFill: z.object({ status: z.string().max(40), note: z.string().max(1000), completedAt: z.number().optional(), filled: z.number() }).optional(),
    reports: z.number(),
    assisting: z.boolean().optional(),
  })).max(2000),
});
const submissionSchema = z.object({
  applicationId: z.string().uuid(),
  company: z.string().max(300),
  title: z.string().max(500),
  url: z.string().max(3000),
  ats: z.string().max(200).optional(),
  submittedAt: z.number().int().nonnegative(),
  confirmedBySite: z.boolean(),
});
const harSchema = z.object({ log: z.object({ version: z.string(), entries: z.array(z.record(z.unknown())).max(5000) }).passthrough() }).passthrough();


async function pruneAutoRecordings(directory: string) {
  const names = (await readdir(join(directory, "recordings"))).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
  const named = new Set<string>();
  for (const name of (await readdir(join(directory, "issues"))).filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))) {
    const report = JSON.parse(await readFile(join(directory, "issues", name), "utf8").catch(() => "{}"));
    if (report.recordingId) named.add(`${report.recordingId}.json`);
  }
  const auto: { name: string; createdAt: number }[] = [];
  for (const name of names) {
    const text = await readFile(join(directory, "recordings", name), "utf8").catch(() => "");
    // Only the head is needed: auto and createdAt come first.
    const head = text.slice(0, 300);
    if (/"auto":\s*true/.test(head) && !named.has(name))
      auto.push({ name, createdAt: Number(head.match(/"createdAt":\s*(\d+)/)?.[1] || 0) });
  }
  for (const old of auto.sort((a, b) => b.createdAt - a.createdAt).slice(40))
    await unlink(join(directory, "recordings", old.name)).catch(() => {});
}
// Fill captures (one per finished fill, see captureFill in background.ts)
// are evidence for the eval's checks, not reports: only the newest are kept,
// and at most a few of any one page, so one form filled again and again
// does not push every other site out.
export const captureLimits = { total: Number(process.env.LANE_CAPTURE_LIMIT) || 80, perPage: 3 };
export async function pruneCaptures(directory: string, limits = captureLimits) {
  const folder = join(directory, "captures");
  const kept: { id: string; createdAt: number; page: string }[] = [];
  for (const name of (await readdir(folder).catch(() => [] as string[])).filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))) {
    const capture = JSON.parse(await readFile(join(folder, name), "utf8").catch(() => "{}"));
    let page = String(capture.tab?.url || "");
    try { const url = new URL(page); page = url.origin + url.pathname; } catch { /* keep as is */ }
    kept.push({ id: name.slice(0, 36), createdAt: Number(capture.createdAt) || 0, page });
  }
  kept.sort((a, b) => b.createdAt - a.createdAt);
  const perPage = new Map<string, number>();
  let total = 0;
  for (const capture of kept) {
    const seen = (perPage.get(capture.page) || 0) + 1;
    perPage.set(capture.page, seen);
    if (seen <= limits.perPage && ++total <= limits.total) continue;
    await unlink(join(folder, `${capture.id}.json`)).catch(() => {});
    await unlink(join(folder, `${capture.id}.har.json`)).catch(() => {});
  }
}
// What the report fixer (scripts/fixer.ts) is doing, read from the files it
// writes: its heartbeat and state, each report's or task's result, and the
// tasks the form checks queued. Work in progress first, then the queue, then
// what finished, newest first.
export async function fixerOverview(directory: string): Promise<FixerOverview> {
  const folder = join(directory, "fixer");
  const json = async (path: string) => JSON.parse(await readFile(path, "utf8").catch(() => "null"));
  const heartbeat = await json(join(folder, "heartbeat.json"));
  const state = (await json(join(folder, "state.json"))) || {};
  const items: FixerItem[] = [];
  const results = new Map<string, FixerResult>();
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    const match = name.match(/^([a-f0-9-]{36})\.json$/);
    if (match) results.set(match[1], await json(join(folder, name)));
  }
  for (const name of await readdir(join(folder, "tasks")).catch(() => [] as string[])) {
    const task = /^[a-f0-9-]{36}\.json$/.test(name) ? await json(join(folder, "tasks", name)) : null;
    if (!task?.id) continue;
    const example = task.examples?.[0];
    // A field's question names it; a section's rows, or a field known only
    // by its id ("mullsb"), are named by what went wrong.
    const label = String(example?.label || "");
    const what = task.rule === "rows-short"
      ? `${label === "education" ? "Education" : "Work history"} rows`
      : /\s/.test(label.trim()) || /^[A-Z]/.test(label) ? label : "Fields the extension could not write";
    items.push({
      id: task.id,
      kind: "task",
      title: `${what} on ${task.site}`,
      site: task.site,
      problem: example ? `${example.detail}${task.examples.length > 1 ? ` (and ${task.examples.length - 1} more like it)` : ""}` : String(task.signature || ""),
      createdAt: Number(task.createdAt) || 0,
      ...(results.get(task.id) ? { result: results.get(task.id) } : {}),
    });
  }
  // Reports the fixer has taken up (it writes a result once it queues one).
  for (const [id, result] of results) {
    if (items.some((item) => item.id === id)) continue;
    const report = await json(join(directory, "issues", `${id}.json`));
    items.push({
      id,
      kind: "report",
      title: String(report?.application?.title || report?.tab?.title || "A report"),
      ...(report?.tab?.url ? { site: (() => { try { return new URL(report.tab.url).hostname; } catch { return undefined; } })() } : {}),
      problem: report?.note ? String(report.note).slice(0, 300) : undefined,
      createdAt: Number(report?.createdAt) || 0,
      result,
    });
  }
  const rank = (item: FixerItem) => (item.result?.status === "working" ? 0 : !item.result || item.result.status === "queued" ? 1 : 2);
  items.sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? (b.result?.finishedAt || 0) - (a.result?.finishedAt || 0) : a.createdAt - b.createdAt));
  return {
    ...(heartbeat?.at ? { heartbeatAt: heartbeat.at, branch: heartbeat.branch, ...(heartbeat.settings ? { inUse: cleanFixerSettings(heartbeat.settings) } : {}) } : {}),
    ...(state.checkedThrough ? { checkedThrough: state.checkedThrough } : {}),
    ...(state.checkRetryAt ? { checkRetryAt: state.checkRetryAt } : {}),
    ...((await json(join(folder, "health.json"))) ? { health: await json(join(folder, "health.json")) } : {}),
    items,
  };
}
async function jsonBody(req: IncomingMessage, limit = 14 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
const safeToken = (actual: string, expected: string) =>
  actual.length === expected.length &&
  timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
const send = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
};

export async function createApp(
  config: Config,
  directory: string,
  generate?: Generate,
  options: { announcePairing?: (announcement: PairingAnnouncement) => void } = {},
) {
  // The six-digit pairing code (pairing.ts), shown where the backend runs.
  const pairing = new Pairing(options.announcePairing || ((announcement) => console.log(pairingBanner(announcement))));
  const store = new Store(directory);
  await store.init();
  // The report fixer's routes, only where its script is in the tree.
  const devTools = devToolsEnabled(process.env, () => existsSync(fileURLToPath(new URL("../../scripts/fixer.ts", import.meta.url))));
  // The live line to the extension, attached with the server below.
  let live: ReturnType<typeof attachLive> | undefined;
  const queue = new GenerationQueue(store, config, generate);
  let profileWrite = Promise.resolve();
  const server = createServer(async (req, res) => {
    try {
      // Host checks also reject DNS rebinding. Page origins can never call this API.
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || ""))
        return send(res, 403, { error: "Loopback host required." });
      const origin = req.headers.origin;
      const extensionOrigin =
        origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      // The pairing handshake is the one way in without the token, and only
      // for an extension: before pairing, or while a code is open to move
      // to another one, the bound extension ID cannot be required yet.
      const handshake = path === "/v1/hello" || path === "/v1/pair/request";
      if (
        origin &&
        (!extensionOrigin ||
          (!handshake &&
            config.extensionId &&
            origin !== `chrome-extension://${config.extensionId}`))
      )
        return send(res, 403, { error: "Origin denied." });
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "600",
        });
        return res.end();
      }
      if (handshake) {
        if (!extensionOrigin)
          return send(res, 403, { error: "Pairing is only for the Application Lane extension." });
        // Whether a backend is here and whether a code can be typed now.
        // Asked with POST: Chrome sends an extension's Origin on a POST,
        // not on a GET to a host the extension has permission for.
        if (path === "/v1/hello" && req.method === "POST")
          return send(res, 200, {
            app: "application-lane",
            version: packageVersion(),
            paired: Boolean(config.extensionId),
            pairedHere: origin === `chrome-extension://${config.extensionId}`,
            pairing: pairing.state,
          });
        if (path === "/v1/pair/request" && req.method === "POST") {
          const { extensionId, code } = z
            .object({ extensionId: z.string().regex(/^[a-p]{32}$/), code: z.string().max(20) })
            .parse(await jsonBody(req, 4096));
          if (origin !== `chrome-extension://${extensionId}`)
            return send(res, 403, { error: "Extension identity mismatch." });
          const result = pairing.attempt(code, Boolean(config.extensionId));
          if (!result.ok) return send(res, result.status, { error: result.error });
          config.extensionId = extensionId;
          await atomicJSON(join(directory, "config.json"), config);
          console.log(`  Paired with the extension ${extensionId}.`);
          return send(res, 200, { paired: true, token: config.token });
        }
        return send(res, 405, { error: "Unsupported pairing request." });
      }
      const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
      if (!safeToken(token, config.token))
        return send(res, 401, {
          error: "Pair the extension with the local backend token.",
        });
      // A new code for another browser, asked for by the command line
      // (lane pair), which already holds the token.
      if (path === "/v1/pair/open" && req.method === "POST") {
        if (origin) return send(res, 403, { error: "Ask for a pairing code from the terminal." });
        const { code, expiresAt } = pairing.open(config.extensionId ? "requested" : "unpaired", Boolean(config.extensionId));
        return send(res, 200, { code, ...(expiresAt ? { expiresAt } : {}) });
      }
      if (path === "/v1/pair" && req.method === "POST") {
        const { extensionId } = z
          .object({ extensionId: z.string().regex(/^[a-p]{32}$/) })
          .parse(await jsonBody(req));
        if (origin && origin !== `chrome-extension://${extensionId}`)
          return send(res, 403, { error: "Extension identity mismatch." });
        if (config.extensionId && extensionId !== config.extensionId)
          return send(res, 403, {
            error:
              "Backend is paired to another extension. Restart it with npm start -- --pair (or run lane pair) and connect with the new code.",
          });
        config.extensionId = extensionId;
        await atomicJSON(join(directory, "config.json"), config);
        // Paired with the token instead: the code shown is no longer needed.
        pairing.close();
        return send(res, 200, { paired: true });
      }
      if (!config.extensionId && origin)
        return send(res, 403, { error: "Pair the extension first." });
      if (path === "/v1/status" && req.method === "GET")
        return send(res, 200, {
          configured: draftProviderChain(config).length > 0,
          model: config.model,
          endpoint: new URL(config.endpoint).origin,
          generationConcurrency: config.generationConcurrency,
          checking: config.checking,
          privacy:
            "Relevant profile facts and job text are sent to your configured AI endpoint.",
          // The newest build in dist/, for the panel to tell whether the
          // extension loaded is older (src/shared/build.ts).
          extensionBuild: await readFile(join(packageRoot, "dist", "extension", "build.json"), "utf8").then((text) => JSON.parse(text), () => undefined),
        });
      if (path === "/v1/profile" && req.method === "GET")
        return send(res, 200, store.data.profile);
      // The profile as one application states it (graduation by role).
      if (path === "/v1/profile/application" && req.method === "GET") {
        const title = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("title") || "";
        return send(res, 200, await applicationProfile(store.data.profile, config, title.slice(0, 300)));
      }
      // Where the extension profile and the job-applier files disagree.
      if (path === "/v1/profile/conflicts" && req.method === "GET") {
        if (!config.tailorDir) return send(res, 200, []);
        const context = await skillContext(config.tailorDir).catch(() => undefined);
        return send(res, 200, context ? profileConflicts(store.data.profile, context) : []);
      }
      // The applicant as one file, to carry to another installation.
      if (path === "/v1/profile/bundle" && req.method === "GET")
        return send(res, 200, await exportBundle(store.data.profile, config.tailorDir));
      if (path === "/v1/profile/bundle" && req.method === "PUT") {
        const bundle = bundleSchema.parse(await jsonBody(req));
        if (new Set(bundle.profile.facts.map((f) => f.id)).size !== bundle.profile.facts.length)
          throw new Error("Profile fact IDs must be unique.");
        let tailoring: string[] = [];
        profileWrite = profileWrite
          .catch(() => {})
          .then(async () => {
            await queue.cancelAll();
            tailoring = await importTailoringFiles(bundle.tailoring, directory);
            if (tailoring.length && importedTailoring(directory)) {
              // The imported folder is this installation's tailoring from
              // now on, found without a setting.
              const { tailorDir: _replaced, ...saved } = config;
              await atomicJSON(join(directory, "config.json"), saved);
              config.tailorDir = join(directory, "tailoring");
            }
            // It replaces what is here whatever revision either side had.
            store.data.profile = { ...bundle.profile, revision: store.data.profile.revision + 1 };
            await store.save();
          });
        await profileWrite;
        return send(res, 200, { profile: store.data.profile, tailoring, settings: bundle.settings });
      }
      if (path === "/v1/profile" && req.method === "PUT") {
        const profile = profileSchema.parse(await jsonBody(req));
        if (
          new Set(profile.facts.map((f) => f.id)).size !== profile.facts.length
        )
          throw new Error("Profile fact IDs must be unique.");
        profileWrite = profileWrite
          .catch(() => {})
          .then(async () => {
            if (profile.revision !== store.data.profile.revision)
              throw new Error(
                "Profile changed in another window. Reload before saving.",
              );
            await queue.cancelAll();
            profile.revision++;
            store.data.profile = profile;
            await store.save();
          });
        await profileWrite;
        return send(res, 200, store.data.profile);
      }
      if (path === "/v1/import" && req.method === "POST") {
        const input = z
          .object({
            format: z.enum(["pdf", "docx"]),
            data: z.string().max(14000000),
          })
          .parse(await jsonBody(req));
        return send(res, 200, {
          text: await extractResume(
            Buffer.from(input.data, "base64"),
            input.format,
          ),
          confirmed: false,
        });
      }
      if (path === "/v1/settings" && req.method === "PUT") {
        const { generationConcurrency, checking } = z
          .object({
            generationConcurrency: z.number().int().min(1).max(4),
            checking: z.enum(["thorough", "fast"]).optional(),
          })
          .parse(await jsonBody(req));
        queue.configure(generationConcurrency);
        if (checking) config.checking = checking;
        await atomicJSON(join(directory, "config.json"), config);
        return send(res, 200, { generationConcurrency, checking: config.checking });
      }
      // Drafting providers and folders, edited on the dashboard (settings.ts).
      if (path === "/v1/config" && req.method === "GET")
        return send(res, 200, await configView(config, directory));
      if (path === "/v1/config" && req.method === "PUT")
        return send(res, 200, await updateConfig(config, directory, await jsonBody(req)));
      // The applicant's transcript, uploaded on the dashboard.
      if (path === "/v1/transcript" && req.method === "PUT")
        return send(res, 200, await saveTranscript(config, directory, await jsonBody(req)));
      if (path === "/v1/jobs" && req.method === "POST")
        return send(
          res,
          202,
          await queue.enqueue(generationSchema.parse(await jsonBody(req))),
        );
      const jobMatch = path.match(/^\/v1\/jobs\/([a-f0-9-]{36})$/);
      if (jobMatch) {
        const job = store.data.jobs.find((j) => j.id === jobMatch[1]);
        if (!job) return send(res, 404, { error: "Job not found." });
        if (req.method === "DELETE") {
          await queue.cancel(job.id);
          return send(res, 200, { cancelled: true });
        }
        if (req.method === "GET") return send(res, 200, job);
      }
      // The job's documents as files on this machine, for a site's own file
      // chooser: where they are, moving them under Sent, opening the folder.
      const filesMatch = path.match(/^\/v1\/jobs\/([a-f0-9-]{36})\/files(\/open)?$/);
      if (filesMatch) {
        const job = store.data.jobs.find((j) => j.id === filesMatch[1]);
        if (!job) return send(res, 404, { error: "Job not found." });
        if (!config.documentsDir)
          return send(res, 404, { error: "The backend has no documents folder configured." });
        const root = resolve(config.documentsDir);
        if (!filesMatch[2] && req.method === "POST") {
          const body = z
            .object({ sent: z.boolean(), company: z.string().max(300).optional(), title: z.string().max(1000).optional() })
            .parse(await jsonBody(req));
          // Documents drafted before files were written get theirs now.
          if (!job.exported && job.status === "complete" && job.artifacts.length && body.title !== undefined)
            await exportDocuments(root, directory, job, store.data.profile, { company: body.company, title: body.title }, []);
          if (job.exported) await markSent(root, job.exported, body.sent);
          await store.save();
        }
        if (!job.exported)
          return send(res, 404, { error: "These documents were not saved as files. Draft them again." });
        if (filesMatch[2] && req.method === "POST") {
          openFolder(exportedPaths(root, job.exported).folder);
          return send(res, 200, { opened: true });
        }
        if (!filesMatch[2] && (req.method === "GET" || req.method === "POST")) {
          // Paths as the desktop's file chooser takes them.
          const paths = exportedPaths(root, job.exported);
          return send(res, 200, { ...paths, folder: desktopPath(paths.folder), files: paths.files.map((file) => ({ ...file, path: desktopPath(file.path) })) });
        }
      }
      const artifactMatch = path.match(/^\/v1\/artifacts\/([a-f0-9-]{36})$/);
      if (artifactMatch && req.method === "GET") {
        const owner = store.data.jobs.find(
          (j) =>
            j.status === "complete" &&
            j.profileRevision === store.data.profile.revision &&
            j.artifacts.some((a) => a.id === artifactMatch[1]),
        );
        const artifact = owner?.artifacts.find(
          (a) => a.id === artifactMatch[1],
        );
        if (!artifact)
          return send(res, 404, {
            error:
              "Document is unavailable or belongs to an old profile revision.",
          });
        const bytes = await readFile(
          join(directory, "artifacts", `${artifact.id}.${artifact.format}`),
        );
        return send(res, 200, { ...artifact, data: bytes.toString("base64") });
      }
      if (path === "/v1/issues" && req.method === "POST") {
        const bundle = z
          .object({
            id: z.string().uuid(),
            createdAt: z.number().int().nonnegative(),
            category: z.enum([
              "wrong-value",
              "field-not-detected",
              "fill-failure",
              "upload",
              "tab-matching",
              "other",
            ]),
            note: z.string().max(4000),
            applicationId: z.string().uuid().optional(),
            application: z.record(z.unknown()).optional(),
            tab: z.object({
              tabId: z.number().int().nonnegative(),
              url: z.string().url().max(3000),
              title: z.string().max(1000),
              ats: z.string().max(200).optional(),
            }),
            extension: z.object({
              version: z.string().max(100),
              contentVersion: z.string().max(100),
            }),
            recordingId: z.string().uuid().optional(),
            network: z.object({ entries: z.number().int().nonnegative(), fromLoad: z.boolean(), recovered: z.number().int().nonnegative().optional(), missing: z.number().int().nonnegative().optional() }).optional(),
            har: harSchema.optional(),
            recording: recordingSchema.optional(),
            frames: z.array(z.record(z.unknown())).max(100),
          })
          .parse(await jsonBody(req, 100 * 1024 * 1024));
        const { har, recording, ...report } = bundle;
        if (recording && report.recordingId !== recording.id) throw new Error("Recording does not match report.");
        if (har && report.network?.entries !== har.log.entries.length) throw new Error("Network capture does not match report.");
        // The report JSON is the fixer's commit marker: publish it last.
        if (recording) await atomicJSON(join(directory, "recordings", `${recording.id}.json`), recording);
        if (har) await atomicJSON(join(directory, "issues", `${report.id}.har.json`), har);
        await atomicJSON(
          join(directory, "issues", `${report.id}.json`),
          report,
        );
        return send(res, 201, report);
      }
      if (path === "/v1/captures" && req.method === "POST") {
        const bundle = z
          .object({
            id: z.string().uuid(),
            createdAt: z.number().int().nonnegative(),
            trigger: z.literal("fill"),
            applicationId: z.string().uuid().optional(),
            application: z.record(z.unknown()).optional(),
            tab: z.object({
              tabId: z.number().int().nonnegative(),
              url: z.string().url().max(3000),
              title: z.string().max(1000),
              ats: z.string().max(200).optional(),
            }),
            extension: z.object({ version: z.string().max(100), contentVersion: z.string().max(100) }),
            recordingId: z.string().uuid().optional(),
            network: z.object({ entries: z.number().int().nonnegative(), fromLoad: z.boolean(), recovered: z.number().int().nonnegative().optional(), missing: z.number().int().nonnegative().optional() }).optional(),
            har: harSchema.optional(),
            frames: z.array(z.record(z.unknown())).max(100),
          })
          .parse(await jsonBody(req, 100 * 1024 * 1024));
        const { har, ...capture } = bundle;
        if (har && capture.network?.entries !== har.log.entries.length) throw new Error("Network capture does not match capture.");
        await mkdir(join(directory, "captures"), { recursive: true });
        // The capture JSON is what readers list: written after its HAR.
        if (har) await atomicJSON(join(directory, "captures", `${capture.id}.har.json`), har);
        await atomicJSON(join(directory, "captures", `${capture.id}.json`), capture);
        await pruneCaptures(directory).catch(() => {});
        return send(res, 201, { id: capture.id, saved: true });
      }
      if (devTools && path === "/v1/fixer" && req.method === "GET") return send(res, 200, await fixerOverview(directory));
      // The agents and models the fixer uses, chosen on the dashboard; the
      // fixer reads them at the start of each task (fixer-settings.ts).
      const fixerSettingsPath = join(directory, "fixer", "settings.json");
      if (devTools && path === "/v1/fixer/settings" && req.method === "GET") {
        const saved = JSON.parse(await readFile(fixerSettingsPath, "utf8").catch(() => "null"));
        return send(res, 200, { settings: cleanFixerSettings(saved), saved: Boolean(saved) });
      }
      // Check again: the fixer asks every agent anew before its next task.
      if (devTools && path === "/v1/fixer/health" && req.method === "DELETE") {
        await unlink(join(directory, "fixer", "health.json")).catch(() => {});
        return send(res, 200, { cleared: true });
      }
      if (devTools && path === "/v1/fixer/settings" && req.method === "PUT") {
        const settings = cleanFixerSettings(await jsonBody(req));
        await mkdir(join(directory, "fixer"), { recursive: true });
        await atomicJSON(fixerSettingsPath, settings);
        return send(res, 200, { settings, saved: true });
      }
      // Applications that went in (SubmissionRecord): a history that outlives
      // the list of applications being worked on.
      const submissionsPath = join(directory, "submissions.json");
      const readSubmissions = async () =>
        JSON.parse(await readFile(submissionsPath, "utf8").catch(() => "[]")) as z.infer<typeof submissionSchema>[];
      // Finding jobs to apply for (job-search.ts): its settings, a search, and
      // the latest results.
      const searchDir = join(directory, "search");
      const searchSettingsPath = join(searchDir, "settings.json");
      const searchResultsPath = join(searchDir, "latest.json");
      const preferences = () => readFile(join(config.tailorDir || join(directory, "tailoring"), "preferences.md"), "utf8").catch(() => "");
      const readSearchSettings = async () =>
        searchSettingsSchema.parse({
          // Defaults for the applicant's career stage, under what they saved.
          ...stageDefaults(store.data.profile),
          ...JSON.parse(await readFile(searchSettingsPath, "utf8").catch(() => "{}")),
        });
      if (path === "/v1/search/settings" && req.method === "GET")
        return send(res, 200, { settings: await readSearchSettings(), suggested: profileTargets(store.data.profile, await preferences()) });
      if (path === "/v1/search/settings" && req.method === "PUT") {
        const settings = searchSettingsSchema.parse(await jsonBody(req));
        await mkdir(searchDir, { recursive: true });
        await atomicJSON(searchSettingsPath, settings);
        return send(res, 200, { settings, suggested: profileTargets(store.data.profile, await preferences()) });
      }
      // Which openings are already applications, as they are now: marked
      // only when the search ran, one saved three days before marked none of
      // the applications tracked since (2026-11-02).
      const knownOpenings = async () => {
        const queued = JSON.parse(await readFile(join(directory, "queue.json"), "utf8").catch(() => "null")) as { applications?: { url: string }[] } | null;
        const submitted = JSON.parse(await readFile(join(directory, "submissions.json"), "utf8").catch(() => "[]")) as { url: string }[];
        return new Set([...(queued?.applications || []).map((app) => app.url), ...submitted.map((record) => record.url)].map(openingKey));
      };
      if (path === "/v1/search" && req.method === "GET") {
        const saved = JSON.parse(await readFile(searchResultsPath, "utf8").catch(() => "null")) as { listings?: { url: string; tracked?: boolean }[] } | null;
        if (saved?.listings) {
          const known = await knownOpenings();
          saved.listings = saved.listings.map(({ tracked: _, ...listing }) => (known.has(openingKey(listing.url)) ? { ...listing, tracked: true } : listing));
        }
        return send(res, 200, saved);
      }
      if (path === "/v1/search" && req.method === "POST") {
        // The saved settings, with any given for this search only.
        const overrides = z.record(z.unknown()).parse(await jsonBody(req).catch(() => ({})));
        const settings = searchSettingsSchema.parse({ ...(await readSearchSettings()), ...overrides });
        const known = await knownOpenings();
        const result = await searchJobs(settings, store.data.profile, { cacheDir: join(searchDir, "cache"), preferences: await preferences(), known });
        await mkdir(searchDir, { recursive: true });
        await atomicJSON(searchResultsPath, result);
        return send(res, 200, result);
      }
      // The extension's queue as it last sent it, and links waiting for it
      // to track, both for the command line (scripts/lane.ts).
      const queuePath = join(directory, "queue.json");
      const inboxPath = join(directory, "inbox.json");
      const readInbox = async () =>
        JSON.parse(await readFile(inboxPath, "utf8").catch(() => "[]")) as { url: string; addedAt: number }[];
      if (path === "/v1/queue" && req.method === "PUT") {
        const snapshot = queueSnapshotSchema.parse(await jsonBody(req, 5 * 1024 * 1024));
        await atomicJSON(queuePath, snapshot);
        return send(res, 200, { saved: snapshot.applications.length });
      }
      if (path === "/v1/queue" && req.method === "GET")
        return send(res, 200, JSON.parse(await readFile(queuePath, "utf8").catch(() => "null")));
      if (path === "/v1/inbox" && req.method === "GET") return send(res, 200, await readInbox());
      if (path === "/v1/inbox" && req.method === "POST") {
        const { urls } = z.object({ urls: z.array(z.string().url().max(2000)).min(1).max(1000) }).parse(await jsonBody(req));
        const inbox = await readInbox();
        const waiting = new Set(inbox.map((item) => item.url));
        let added = 0;
        for (const url of urls) {
          if (!/^https?:/i.test(url) || waiting.has(url)) continue;
          inbox.push({ url, addedAt: Date.now() });
          waiting.add(url);
          added++;
        }
        await atomicJSON(inboxPath, inbox.slice(-2000));
        // The extension picks them up now when it is listening (the
        // applicant, 2026-10-31: "Why not instantly?"), else at its next
        // minute's check.
        const now = added > 0 && Boolean(live?.tell("pick-up"));
        return send(res, 201, { added, waiting: inbox.length, now });
      }
      if (path === "/v1/inbox" && req.method === "DELETE") {
        const { urls } = z.object({ urls: z.array(z.string().max(2000)).max(1000) }).parse(await jsonBody(req));
        const taken = new Set(urls);
        const inbox = (await readInbox()).filter((item) => !taken.has(item.url));
        await atomicJSON(inboxPath, inbox);
        return send(res, 200, { waiting: inbox.length });
      }
      if (path === "/v1/submissions" && req.method === "GET") {
        const records = await readSubmissions();
        return send(res, 200, records.sort((a, b) => b.submittedAt - a.submittedAt));
      }
      if (path === "/v1/submissions" && req.method === "POST") {
        const { entries } = z.object({ entries: z.array(submissionSchema).max(1000) }).parse(await jsonBody(req));
        const records = await readSubmissions();
        for (const entry of entries) {
          const at = records.findIndex((record) => record.applicationId === entry.applicationId);
          // Recorded again (a backfill, a second confirmation): the first
          // date it went in stands.
          if (at >= 0) records[at] = { ...entry, submittedAt: Math.min(records[at].submittedAt, entry.submittedAt), confirmedBySite: records[at].confirmedBySite || entry.confirmedBySite };
          else records.push(entry);
        }
        await atomicJSON(submissionsPath, records);
        return send(res, 201, { count: records.length });
      }
      const submissionMatch = path.match(/^\/v1\/submissions\/([a-f0-9-]{36})$/);
      if (submissionMatch && req.method === "DELETE") {
        // Moved back out of Submitted: it was marked by mistake.
        const records = await readSubmissions();
        await atomicJSON(submissionsPath, records.filter((record) => record.applicationId !== submissionMatch[1]));
        return send(res, 200, { deleted: true });
      }
      // The page's network traffic for a report, as a HAR (network-capture.ts).
      const networkMatch = path.match(/^\/v1\/issues\/([a-f0-9-]{36})\/network$/);
      if (networkMatch && req.method === "PUT") {
        const har = harSchema.parse(await jsonBody(req, 80 * 1024 * 1024));
        await readFile(join(directory, "issues", `${networkMatch[1]}.json`)).catch(() => {
          throw new Error("No such issue report.");
        });
        await atomicJSON(join(directory, "issues", `${networkMatch[1]}.har.json`), har);
        return send(res, 201, { saved: true, entries: har.log.entries.length });
      }
      if (path === "/v1/recordings" && req.method === "POST") {
        const recording = recordingSchema.parse(await jsonBody(req));
        await atomicJSON(
          join(directory, "recordings", `${recording.id}.json`),
          recording,
        );
        // Every fill records itself; the newest 40 of those are kept, and
        // any a report names.
        if (recording.auto) await pruneAutoRecordings(directory).catch(() => {});
        return send(res, 201, { ...recording, events: undefined });
      }
      if (path === "/v1/recordings" && req.method === "GET") {
        const recordings = await Promise.all(
          (await readdir(join(directory, "recordings")))
            .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
            .map(async (name) => {
              const recording = JSON.parse(
                await readFile(join(directory, "recordings", name), "utf8"),
              );
              return { ...recording, events: undefined };
            }),
        );
        return send(
          res,
          200,
          recordings.sort((a, b) => b.createdAt - a.createdAt),
        );
      }
      const recordingMatch = path.match(/^\/v1\/recordings\/([a-f0-9-]{36})$/);
      if (recordingMatch) {
        const recordingPath = join(
          directory,
          "recordings",
          `${recordingMatch[1]}.json`,
        );
        if (req.method === "DELETE") {
          await unlink(recordingPath).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
          return send(res, 200, { deleted: true });
        }
        if (req.method === "GET") {
          const recording = await readFile(recordingPath, "utf8").catch(() => "");
          if (!recording) return send(res, 404, { error: "Recording not found." });
          return send(res, 200, JSON.parse(recording));
        }
      }
      if (path === "/v1/issues" && req.method === "GET") {
        const reports = await Promise.all(
          (await readdir(join(directory, "issues")))
            .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
            .map(async (name) => {
              const report = JSON.parse(
                await readFile(join(directory, "issues", name), "utf8"),
              );
              const fixer = await readFile(join(directory, "fixer", name), "utf8")
                .then((text) => JSON.parse(text))
                .catch(() => undefined);
              return { ...report, frames: undefined, ...(fixer ? { fixer } : {}) };
            }),
        );
        return send(
          res,
          200,
          reports.sort((a, b) => b.createdAt - a.createdAt),
        );
      }
      const issueMatch = path.match(/^\/v1\/issues\/([a-f0-9-]{36})$/);
      if (issueMatch) {
        const issuePath = join(directory, "issues", `${issueMatch[1]}.json`);
        if (req.method === "DELETE") {
          await unlink(issuePath).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
          await unlink(join(directory, "issues", `${issueMatch[1]}.har.json`)).catch(() => {});
          return send(res, 200, { deleted: true });
        }
        if (req.method === "GET") {
          const report = await readFile(issuePath, "utf8").catch(() => "");
          if (!report) return send(res, 404, { error: "Issue not found." });
          return send(res, 200, JSON.parse(report));
        }
      }
      // Everything the backend keeps about the applicant and their
      // applications, but not its own config or pairing: profile, documents,
      // reports and their page traffic, fill captures, recordings, the queue
      // mirror and inbox, searches, the fixer's results and transcripts
      // uploaded here. ?documents=1 also removes the documents exported to
      // the documents folder.
      if (path === "/v1/data" && req.method === "DELETE") {
        const withDocuments = /^(1|true|yes)$/.test(new URL(req.url || "/", "http://127.0.0.1").searchParams.get("documents") || "");
        await queue.cancelAll();
        if (withDocuments && config.documentsDir)
          for (const job of store.data.jobs)
            if (job.exported) await removeWritten(resolve(config.documentsDir), job.exported).catch(() => {});
        // Include orphaned partial documents from interrupted rendering, after
        // generators have settled. The directory and filename shape are bounded.
        for (const name of await readdir(join(directory, "artifacts")))
          if (/^[a-f0-9-]{36}\.(pdf|docx)$/.test(name))
            await unlink(join(directory, "artifacts", name));
        for (const folder of ["issues", "recordings", "captures"])
          for (const name of await readdir(join(directory, folder)).catch(() => [] as string[]))
            if (/^[a-f0-9-]{36}(\.har)?\.json$/.test(name))
              await unlink(join(directory, folder, name)).catch(() => {});
        for (const file of ["submissions.json", "queue.json", "inbox.json"])
          await unlink(join(directory, file)).catch(() => {});
        // Searches (their settings, results and cached listings) and the
        // fixer's results and tasks; its own settings stay.
        await rm(join(directory, "search"), { recursive: true, force: true });
        for (const name of await readdir(join(directory, "fixer")).catch(() => [] as string[]))
          if (/^[a-f0-9-]{36}\.json$/.test(name) || /^(state|heartbeat|health)\.json$/.test(name))
            await unlink(join(directory, "fixer", name)).catch(() => {});
        await rm(join(directory, "fixer", "tasks"), { recursive: true, force: true });
        // Transcripts uploaded through the app, by the names it saved them
        // under; other files in that folder are the applicant's own.
        const uploaded = JSON.parse(await readFile(join(directory, "transcripts-uploaded.json"), "utf8").catch(() => "[]")) as unknown;
        const transcripts = transcriptsFolder(config.transcriptsDir, directory);
        for (const name of Array.isArray(uploaded) ? uploaded : [])
          if (typeof name === "string" && name === basename(name) && !name.startsWith("."))
            await unlink(join(transcripts, name)).catch(() => {});
        await unlink(join(directory, "transcripts-uploaded.json")).catch(() => {});
        store.data.jobs = [];
        store.data.profile = profileSchema.parse({
          firstName: "",
          lastName: "",
          email: "",
          confirmed: false,
          facts: [],
          revision: store.data.profile.revision + 1,
        });
        await store.save();
        return send(res, 200, { deleted: true });
      }
      return send(res, 404, { error: "Route not found." });
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? "Invalid request fields."
          : error instanceof Error
            ? error.message
            : "Request failed.";
      // Diagnostics deliberately exclude bodies, URLs, applicant facts and credentials.
      console.error(
        `[backend] ${req.method} failed: ${error instanceof z.ZodError ? "validation" : "request"}`,
        // Which keys failed and why (paths and zod codes only, no values).
        ...(error instanceof z.ZodError
          ? [error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")} (${issue.code})`).join(", ")]
          : []),
      );
      send(res, 400, { error: message.slice(0, 400) });
    }
  });
  server.requestTimeout = 30000;
  live = attachLive(server, config);
  return { server, store, queue, pairing };
}
