import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { cliCommand, cliDefaults } from "./cli-provider";
import { launch } from "./command";
import { draftProviderChain } from "./generation";
import {
  atomicJSON,
  configSchema,
  dataDirectory,
  readJSON,
  type Config,
  type DraftProviderConfig,
} from "./store";

// Optional: the backend makes its own configuration on first start, and
// drafting can be set up on the dashboard (Settings → Drafting). This asks
// the same thing in the terminal: who writes drafts.

const installed = (command: string) =>
  new Promise<string | undefined>((done) => {
    const started = launch(command, ["--version"]);
    execFile(started.command, started.args, { timeout: 5000, windowsHide: true, windowsVerbatimArguments: started.windowsVerbatimArguments }, (error, out) =>
      done(error ? undefined : out.trim().split("\n")[0].slice(0, 80) || "installed"),
    );
  });

// A prompt that does not echo what is typed (for the API key).
async function hidden(question: string): Promise<string> {
  if (!stdin.isTTY) return "";
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  let typed = "";
  return new Promise((resolve, reject) => {
    const onData = (data: Buffer) => {
      for (const char of data.toString("utf8")) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          finish();
          return resolve(typed);
        }
        if (char === "\u0003") {
          finish();
          return reject(new Error("Setup cancelled."));
        }
        if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1);
        else if (char >= " ") typed += char;
      }
    };
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    stdin.on("data", onData);
  });
}

await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
const path = join(dataDirectory, "config.json");
const previous = await readJSON<Partial<Config>>(path, {});
let rl: ReturnType<typeof createInterface> | undefined;
// Lines are buffered, so answers piped in all at once are each used.
let lines: AsyncIterator<string> | undefined;
const ask = async (question: string) => {
  rl ??= createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
  lines ??= rl[Symbol.asyncIterator]();
  stdout.write(question);
  const line = await lines.next();
  return line.done ? "" : String(line.value);
};
try {
  console.log(`Application Lane setup. Settings are saved in ${path} (readable only by you).`);
  console.log("You can change all of this later on the dashboard: Settings → Drafting.\n");
  const [claude, codex] = await Promise.all([installed(cliCommand("claude-cli")), installed(cliCommand("codex-cli"))]);
  const choices = [
    { key: "1", label: "Claude Code CLI", provider: "claude-cli" as const, found: claude },
    { key: "2", label: "Codex CLI", provider: "codex-cli" as const, found: codex },
    { key: "3", label: "An OpenAI-compatible API (endpoint, model and API key)", provider: "http" as const, found: "" },
    { key: "4", label: "None for now (filling works; drafting waits until you choose)", provider: undefined, found: "" },
  ];
  console.log("How should résumés, cover letters and answers be drafted?");
  for (const choice of choices)
    console.log(
      `  ${choice.key}. ${choice.label}${choice.provider && choice.provider !== "http" ? (choice.found ? ` (found: ${choice.found})` : " (not found on PATH)") : ""}`,
    );
  const suggested = claude ? "1" : codex ? "2" : "4";
  const answer = (await ask(`Choose 1-4 [${suggested}]: `)).trim() || suggested;
  const choice = choices.find((item) => item.key === answer) || choices.find((item) => item.key === suggested)!;
  const next: Record<string, unknown> = { ...previous, token: previous.token || randomBytes(32).toString("hex") };
  // What drafts now (older settings included), with the chosen kind first.
  const current = previous.token ? draftProviderChain(configSchema.parse(previous)) : [];
  const kept = current.filter((step) => step.provider !== choice.provider);
  if (choice.provider === "claude-cli" || choice.provider === "codex-cli") {
    if (!choice.found)
      console.log(
        `${choice.label} was not found. Install it and sign in (${choice.provider === "claude-cli" ? "claude" : "codex login"}), or set ${choice.provider === "claude-cli" ? "LANE_CLAUDE_BIN" : "LANE_CODEX_BIN"} to its full path.`,
      );
    const step: DraftProviderConfig = {
      id: choice.provider.replace("-cli", ""),
      provider: choice.provider,
      model: cliDefaults[choice.provider],
      ...(choice.provider === "codex-cli" ? { effort: "low" as const } : {}),
    };
    next.draftProviders = [step, ...kept];
  } else if (choice.provider === "http") {
    const endpoint =
      (await ask(`OpenAI-compatible base URL [${previous.endpoint || "https://api.openai.com/v1"}]: `)).trim() ||
      previous.endpoint ||
      "https://api.openai.com/v1";
    let model = "";
    while (!model) {
      model = (await ask(`Model${previous.model ? ` [${previous.model}]` : " (for example gpt-4.1-mini)"}: `)).trim() || previous.model || "";
      if (!model) console.log("A model name is needed for an API endpoint.");
    }
    let apiKey = process.env.LANE_API_KEY || "";
    if (apiKey) console.log("Using the API key from LANE_API_KEY.");
    else {
      // The line reader echoes; the key is read without it.
      rl?.close();
      apiKey = (await hidden(`API key${previous.apiKey ? " [keep the saved one]" : " (leave empty if the endpoint needs none)"}: `)).trim();
      if (!stdin.isTTY) console.log("Not a terminal, so no key was asked for: set LANE_API_KEY and run setup again.");
    }
    next.endpoint = endpoint;
    next.model = model;
    next.apiKey = apiKey || previous.apiKey || "";
    next.draftProviders = [{ id: "api", provider: "http", model }, ...kept.filter((step) => step.id !== "api")];
  }
  const config = configSchema.parse(next);
  await atomicJSON(path, config);
  console.log(
    `\nSaved.${choice.provider ? "" : " Drafting stays off until you choose a provider in Settings → Drafting."}\nStart the backend with npm start (or application-lane), then open the extension and type the pairing code it shows.`,
  );
} finally {
  rl?.close();
}
