import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import { cliCommand, cliDefaults } from "./cli-provider";
import { launch } from "./command";
import { newestTranscript, transcriptsFolder } from "./documents";
import { draftProviderChain } from "./generation";
import { atomicJSON, configSchema, draftProviderSchema, type Config } from "./store";

// The part of config.json the dashboard's Settings page reads and edits:
// who drafts (Claude Code, Codex, an API endpoint) in what order, and where
// files live. The API key is write-only: it is never sent back.

const updateSchema = z
  .object({
    providers: z.array(draftProviderSchema).max(8).optional(),
    checkProviders: z.array(draftProviderSchema).max(8).optional(),
    endpoint: z.string().url().max(500).optional(),
    model: z.string().max(100).optional(),
    verifyModel: z.string().max(100).optional(),
    apiKey: z.string().max(500).optional(),
    documentsDir: z.string().max(1000).optional(),
    transcriptsDir: z.string().max(1000).optional(),
  })
  .strict();

type CliStatus = { command: string; found: boolean; version?: string };

// Whether the CLI can be started at all, and which build answers.
function cliStatus(command: string): Promise<CliStatus> {
  const started = launch(command, ["--version"]);
  return new Promise((done) =>
    execFile(started.command, started.args, { timeout: 5000, windowsHide: true, windowsVerbatimArguments: started.windowsVerbatimArguments }, (error, stdout) =>
      done(
        error
          ? { command, found: false }
          : { command, found: true, version: stdout.trim().split("\n")[0].slice(0, 80) },
      ),
    ),
  );
}

// What a LaTeX resume build needs: Python (for the tailoring engine) and
// pdflatex. Found once a minute at most, so the Settings page stays quick.
const TOOLS_TTL = 60_000;
let tools: { at: number; status: Promise<{ python: CliStatus; pdflatex: CliStatus }> } | undefined;
async function firstFound(commands: string[]): Promise<CliStatus> {
  for (const command of commands) {
    const status = await cliStatus(command);
    if (status.found) return status;
  }
  return { command: commands[0], found: false };
}
function tailoringTools() {
  if (!tools || Date.now() - tools.at > TOOLS_TTL) {
    const status = Promise.all([
      firstFound(process.platform === "win32" ? ["python", "py"] : ["python3"]),
      firstFound(["pdflatex"]),
    ]).then(([python, pdflatex]) => ({ python, pdflatex }));
    tools = { at: Date.now(), status };
  }
  return tools.status;
}

const isDirectory = (path: string) =>
  stat(path).then(
    (entry) => entry.isDirectory(),
    () => false,
  );

export async function configView(config: Config, directory: string) {
  const transcript = await newestTranscript(transcriptsFolder(config.transcriptsDir, directory));
  const withStatus = (steps: Config["draftProviders"]) =>
    Promise.all(
      steps.map(async (step) => ({
        ...step,
        ...(step.provider === "http" ? {} : { cli: await cliStatus(cliCommand(step.provider, step.command)) }),
      })),
    );
  const [claude, codex, providers, checkProviders, latexTools] = await Promise.all([
    cliStatus(cliCommand("claude-cli")),
    cliStatus(cliCommand("codex-cli")),
    withStatus(draftProviderChain(config)),
    withStatus(config.checkProviders),
    tailoringTools(),
  ]);
  const tailoringFolder = config.tailorDir || config.resumeLatexDir || "";
  return {
    providers,
    checkProviders,
    installed: { "claude-cli": claude, "codex-cli": codex },
    defaultModels: cliDefaults,
    endpoint: config.endpoint,
    model: config.model,
    verifyModel: config.verifyModel,
    hasApiKey: Boolean(config.apiKey),
    documentsDir: config.documentsDir || "",
    transcriptsDir: config.transcriptsDir || "",
    // The file a form's transcript field would be given, if there is one.
    transcript: transcript ? { name: transcript.name, modifiedAt: Math.round(transcript.mtime) } : null,
    // Whether resumes come from the applicant's own LaTeX or the built-in
    // layout, and whether this computer can build the LaTeX ones.
    tailoring: { ...latexTools, configured: Boolean(tailoringFolder), folder: tailoringFolder },
  };
}

const transcriptSchema = z.object({ name: z.string().min(1).max(200), data: z.string().min(1).max(12 * 1024 * 1024) }).strict();
const TRANSCRIPT_LIMIT = 8 * 1024 * 1024;

// The applicant's transcript, uploaded from the Settings page into the
// transcripts folder. It becomes the newest file there, so it is the one
// forms are given. Only a PDF or Word document, under its own plain file
// name: the name never chooses the folder.
export async function saveTranscript(config: Config, directory: string, raw: unknown) {
  const input = transcriptSchema.parse(raw);
  const name = input.name.trim();
  if (name !== basename(name) || /[\\/:*?"<>|\u0000-\u001f]/u.test(name) || name.startsWith("."))
    throw new Error("Give the transcript a plain file name.");
  const kind = /\.pdf$/i.test(name) ? "pdf" : /\.docx$/i.test(name) ? "docx" : undefined;
  if (!kind) throw new Error("A transcript must be a PDF or a Word (.docx) file.");
  const bytes = Buffer.from(input.data, "base64");
  if (!bytes.length) throw new Error("The transcript file is empty.");
  if (bytes.length > TRANSCRIPT_LIMIT) throw new Error("The transcript is larger than 8 MB.");
  const signature = kind === "pdf" ? "%PDF-" : "PK\u0003\u0004";
  if (bytes.subarray(0, signature.length).toString("latin1") !== signature)
    throw new Error(`That file is not a ${kind === "pdf" ? "PDF" : "Word document"}, whatever its name says.`);
  const folder = transcriptsFolder(config.transcriptsDir, directory);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, name), bytes);
  // Kept so "Delete local application data" removes what was uploaded here,
  // and nothing else in a folder the applicant may share.
  const record = join(directory, "transcripts-uploaded.json");
  const uploaded = JSON.parse(await readFile(record, "utf8").catch(() => "[]")) as string[];
  await writeFile(record, JSON.stringify([...new Set([...uploaded, name])]));
  return configView(config, directory);
}

export async function updateConfig(config: Config, directory: string, raw: unknown) {
  const input = updateSchema.parse(raw);
  const next: Record<string, unknown> = { ...config };
  for (const step of [...(input.providers || []), ...(input.checkProviders || [])]) {
    const label = step.name || step.id;
    if (step.provider === "http") {
      if (step.command || step.home) throw new Error(`${label}: an API endpoint has no program or home folder.`);
      continue;
    }
    // The backend starts this program, so it has to be the CLI itself: a
    // full path to a file named after it, not any command at all.
    if (step.command) {
      const name = step.provider === "claude-cli" ? "claude" : "codex";
      if (!isAbsolute(step.command)) throw new Error(`${label}: give the full path to the ${name} program.`);
      if (!new RegExp(`^${name}[\\w.-]*$`, "i").test(basename(step.command)))
        throw new Error(`${label}: the program's file name must start with "${name}".`);
      if (!(await stat(step.command).then((entry) => entry.isFile(), () => false)))
        throw new Error(`${label}: no program at ${step.command}.`);
    }
    if (step.home && !(isAbsolute(step.home) && (await isDirectory(step.home))))
      throw new Error(`${label}: the home folder must be the full path of an existing folder.`);
  }
  for (const list of [input.providers, input.checkProviders])
    if (list && new Set(list.map((step) => step.id)).size !== list.length) throw new Error("Each provider in a list needs its own name.");
  if (input.providers) next.draftProviders = input.providers;
  if (input.checkProviders) next.checkProviders = input.checkProviders;
  if (input.endpoint !== undefined) {
    if (!/^https?:$/.test(new URL(input.endpoint).protocol)) throw new Error("The endpoint must be an http(s) URL.");
    next.endpoint = input.endpoint;
  }
  if (input.model !== undefined) next.model = input.model.trim();
  // Empty means the endpoint's own model does the checking.
  if (input.verifyModel !== undefined) next.verifyModel = input.verifyModel.trim();
  // An empty key leaves the saved one alone; the page never holds it.
  if (input.apiKey) next.apiKey = input.apiKey.trim();
  if (input.documentsDir) {
    if (!isAbsolute(input.documentsDir)) throw new Error("The documents folder must be a full path.");
    next.documentsDir = input.documentsDir;
  }
  if (input.transcriptsDir !== undefined) {
    if (!input.transcriptsDir) delete next.transcriptsDir;
    else if (!(isAbsolute(input.transcriptsDir) && (await isDirectory(input.transcriptsDir))))
      throw new Error("The transcripts folder must be the full path of an existing folder.");
    else next.transcriptsDir = input.transcriptsDir;
  }
  const parsed = configSchema.parse(next);
  // The queue holds this same object: change it in place so the next draft
  // uses the new settings without a restart.
  for (const key of Object.keys(config)) delete (config as Record<string, unknown>)[key];
  Object.assign(config, parsed);
  await atomicJSON(join(directory, "config.json"), config);
  return configView(config, directory);
}
