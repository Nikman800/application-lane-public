import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { launch, stopTree } from "./command";
import type { Config } from "./store";

// Drafting through a locally logged-in Claude Code or Codex CLI instead of an
// HTTP endpoint. Each call is one locked-down, single-turn completion: no
// tools, no settings, hooks, MCP servers or project files, run from an empty
// directory, so the posting text (untrusted) can reach nothing but the model.

// "default" for Codex: no -m is passed, and the Codex CLI uses the model it
// is configured with (its own default, or the user's ~/.codex/config.toml).
export const cliDefaults = {
  "claude-cli": "sonnet",
  "codex-cli": "default",
} as const;
// The CLI's own model rather than a named one.
export const cliOwnModel = (model: string | undefined) => !model?.trim() || model.trim() === "default";

export type CliProvider = keyof typeof cliDefaults;
// The program a CLI provider runs: its own setting, else the environment's,
// else whatever PATH finds.
export const cliCommand = (provider: CliProvider, command?: string) =>
  command || (provider === "claude-cli" ? process.env.LANE_CLAUDE_BIN || "claude" : process.env.LANE_CODEX_BIN || "codex");
export class CliFailure extends Error {
  constructor(readonly category: "usage-limit" | "authentication" | "unavailable" | "response", message: string) {
    super(message);
  }
}

// Claude can exit nonzero with its actual error in a JSON result, followed
// by session/usage metadata. Only a stable, readable category leaves here.
export function cliFailure(command: string, stdout: string, stderr = ""): CliFailure {
  const messages: string[] = [];
  for (const output of [stdout, stderr]) {
    for (const text of [output, ...output.split("\n")]) {
      try {
        const value = JSON.parse(text);
        for (const message of [value.result, value.message, value.error?.message, ...(Array.isArray(value.errors) ? value.errors : [])])
          if (typeof message === "string") messages.push(message);
      } catch {
        if (!text.trim().startsWith("{")) messages.push(text);
      }
    }
  }
  // Codex repeats the prompt it was given after a line reading "user", and
  // a prompt holds the posting and the profile: "sign in" or
  // "authentication" there is no error, yet it marked every failure on such
  // a posting as a lapsed login (2026-10-14). Only what Codex said itself is
  // read, and its error lines first.
  const own = messages
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/gu, "")
    .replace(/^user\r?\n[\s\S]*?(?=^(?:codex|thinking|exec|tokens used|error|warning|stream error)\b|(?![\s\S]))/imu, "");
  const lines = [...new Set(own.split("\n").map((line) => line.trim()).filter(Boolean))];
  const errors = lines.filter((line) => /\b(error|failed|denied|expired|unauthori[sz]ed|forbidden|limit)\b|not logged in/iu.test(line) && !/^warning\b/iu.test(line));
  const reason = (errors.length ? errors : lines.slice(-3)).join(" ");
  // What it said, briefly, so the card shows the real cause.
  const said = reason.replace(/\s+/gu, " ").trim().slice(0, 140);
  const quoted = said ? ` ("${said}")` : "";
  // ("You hit your spend cap set by the owner of your workspace", Codex,
  // 2026-10-30: asked again for every draft.)
  if (/usage limit|rate.?limit|quota|weekly limit|hit your limit|spend(ing)? cap|limit (reached|exceeded)|out of.*usage/iu.test(reason))
    return new CliFailure("usage-limit", "usage limit reached");
  if (/not logged in|login|log in|sign.?in|unauthenticated|authentication|invalid.*(token|credential)/iu.test(reason))
    return new CliFailure("authentication", `not logged in or authentication expired${quoted}`);
  return new CliFailure("unavailable", `${basename(command)} exited with an error${quoted}`);
}

function run(
  command: string,
  args: string[],
  input: string,
  cwd: string,
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((done, fail) => {
    // On Windows an npm-installed CLI is a .cmd script run through cmd.exe,
    // and cancelling would stop only that shell: stop what it started first.
    const started = launch(command, args);
    const stop = () => {
      if (process.platform === "win32" && child?.pid) stopTree(child.pid);
    };
    signal.addEventListener("abort", stop, { once: true });
    const child = spawn(started.command, started.args, {
      cwd,
      signal,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: started.windowsVerbatimArguments,
    });
    child.on("close", () => signal.removeEventListener("abort", stop));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) =>
      fail(
        signal.aborted
          ? signal.reason
          : error.code === "ENOENT"
          ? new CliFailure("unavailable", `${basename(command)} is not installed or not on PATH`)
          : error,
      ),
    );
    child.on("close", (code) => {
      if (code === 0) done(stdout);
      // Stopped at its time limit, it said only its opening lines: the
      // limit is the reason, not those (Intuit, 2026-10-17).
      else if (signal.aborted) fail(signal.reason);
      else {
        fail(cliFailure(command, stdout, stderr));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export async function cliComplete(
  config: Pick<Config, "provider" | "cliModel" | "cliEffort"> & {
    cliHome?: string;
    cliCommand?: string;
  },
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<string> {
  const provider = config.provider as CliProvider;
  const model = config.cliModel || cliDefaults[provider];
  const directory = await mkdtemp(join(tmpdir(), "lane-cli-"));
  try {
    if (provider === "claude-cli") {
      const command = cliCommand(provider, config.cliCommand);
      const output = await run(
        command,
        [
          "-p",
          "--model",
          model,
          "--output-format",
          "json",
          "--tools",
          "",
          "--no-session-persistence",
          "--strict-mcp-config",
          "--disable-slash-commands",
          // The empty directory has no project settings; this skips the
          // user's own settings (hooks, plugins) too.
          "--setting-sources",
          "project",
          "--system-prompt",
          system,
        ],
        user,
        directory,
        signal,
        config.cliHome ? { HOME: config.cliHome } : undefined,
      );
      let result: { is_error?: boolean; result?: unknown };
      try {
        result = JSON.parse(output);
      } catch {
        throw new CliFailure("response", "Claude returned an invalid response");
      }
      if (result.is_error || typeof result.result !== "string")
        throw cliFailure("claude", output);
      return result.result;
    }
    const answer = join(directory, "answer.txt");
    const command = cliCommand(provider, config.cliCommand);
    await run(
      command,
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--ignore-user-config",
        "--ignore-rules",
        "-c",
        "features.shell_tool=false",
        "-c",
        'web_search="disabled"',
        // Codex's standard tier: the fast one cost more of the weekly limit
        // for every draft and check (2026-11-02).
        "-C",
        directory,
        ...(cliOwnModel(model) ? [] : ["-m", model]),
        "-c",
        `model_reasoning_effort=${config.cliEffort || "low"}`,
        "-o",
        answer,
        "-",
      ],
      // Codex has no separate system prompt for exec.
      `${system}\n\nINPUT:\n${user}`,
      directory,
      signal,
      config.cliHome ? { CODEX_HOME: config.cliHome } : undefined,
    );
    return await readFile(answer, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
