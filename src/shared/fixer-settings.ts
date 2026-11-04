// Which agents the report fixer (scripts/fixer.ts) tries, in what order,
// and with which models. Chosen on the dashboard's Fixer page and saved in
// <data>/fixer/settings.json; the fixer reads it at the start of every task,
// so a change applies from the next one. Saved choices win over the
// LANE_FIXER_* variables the fixer was started with, which win over these
// defaults.

// claude2: Claude under a separate login, kept in a settings folder of its
// own (CLAUDE_CONFIG_DIR), signed in there once; it runs beside the first.
// endpoint: a bounded tool-calling agent on the backend's OpenAI-compatible
// endpoint (its URL and key from the backend's settings). Settings saved
// before it was renamed call it "air"; they still load.
export type FixerAgent = "claude" | "claude2" | "codex" | "endpoint";
export const fixerAgents: FixerAgent[] = ["claude", "claude2", "codex", "endpoint"];
const agentAliases: Record<string, FixerAgent> = { air: "endpoint" };
export const codexEfforts = ["low", "medium", "high", "xhigh"] as const;
export type FixerSettings = {
  // Tried in this order; the next one only when one produces no fix.
  agents: FixerAgent[];
  claudeModel: string;
  codexModel: string;
  // Codex's second try, after its first model; empty for none.
  codexFallbackModel: string;
  codexEffort: (typeof codexEfforts)[number];
  // The endpoint agent's model; empty for the backend's own endpoint model.
  endpointModel: string;
  // The separate Claude login's settings folder; empty while there is none.
  claude2ConfigDir: string;
  // How many tasks it works on at once, each in a checkout of its own. Their
  // fixes are verified one at a time.
  parallel: number;
};

export const builtInFixerSettings: FixerSettings = {
  agents: ["claude", "codex"],
  claudeModel: "opus",
  // "default": the Codex CLI's own configured model (no -m).
  codexModel: "default",
  codexFallbackModel: "",
  codexEffort: "high",
  endpointModel: "",
  claude2ConfigDir: "",
  parallel: 2,
};

// A model name as the CLIs take it ("opus", "claude-opus-5-5", "gpt-5").
const modelName = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,60}$/;

// What is valid in `input`, over `base`; anything else keeps base's value.
export function cleanFixerSettings(input: unknown, base: FixerSettings = builtInFixerSettings): FixerSettings {
  const given = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const model = (value: unknown, fallback: string, allowEmpty = false) =>
    typeof value === "string" && (modelName.test(value.trim()) || (allowEmpty && value.trim() === "")) ? value.trim() : fallback;
  const agents = Array.isArray(given.agents)
    ? [...new Set(given.agents.map((agent) => (typeof agent === "string" && agentAliases[agent]) || agent).filter((agent): agent is FixerAgent => fixerAgents.includes(agent as FixerAgent)))]
    : [];
  return {
    agents: agents.length ? agents : base.agents,
    claudeModel: model(given.claudeModel, base.claudeModel),
    codexModel: model(given.codexModel, base.codexModel),
    codexFallbackModel: model(given.codexFallbackModel, base.codexFallbackModel, true),
    codexEffort: codexEfforts.includes(given.codexEffort as FixerSettings["codexEffort"]) ? (given.codexEffort as FixerSettings["codexEffort"]) : base.codexEffort,
    endpointModel: model(given.endpointModel ?? given.airModel, base.endpointModel, true),
    // A folder path, as typed: no line breaks or quotes to break a command.
    claude2ConfigDir: typeof given.claude2ConfigDir === "string" && given.claude2ConfigDir.length <= 260 && !/["\r\n]/.test(given.claude2ConfigDir)
      ? given.claude2ConfigDir.trim()
      : base.claude2ConfigDir,
    parallel: Number.isInteger(given.parallel) && (given.parallel as number) >= 1 && (given.parallel as number) <= 3 ? (given.parallel as number) : base.parallel,
  };
}

// The LANE_FIXER_* variables a fixer was started with, over the defaults.
export function fixerSettingsFromEnv(env: Record<string, string | undefined>): FixerSettings {
  return cleanFixerSettings(
    {
      ...(env.LANE_FIXER_AGENTS || env.LANE_FIXER_AGENT ? { agents: (env.LANE_FIXER_AGENTS || env.LANE_FIXER_AGENT)!.split(",").map((agent) => agent.trim()) } : {}),
      ...(env.LANE_FIXER_CLAUDE_MODEL ? { claudeModel: env.LANE_FIXER_CLAUDE_MODEL } : {}),
      ...(env.LANE_FIXER_MODEL ? { codexModel: env.LANE_FIXER_MODEL } : {}),
      ...(env.LANE_FIXER_FALLBACK_MODEL !== undefined ? { codexFallbackModel: env.LANE_FIXER_FALLBACK_MODEL } : {}),
      ...(env.LANE_FIXER_EFFORT ? { codexEffort: env.LANE_FIXER_EFFORT } : {}),
      ...(env.LANE_FIXER_ENDPOINT_MODEL || env.LANE_FIXER_AIR_MODEL ? { endpointModel: env.LANE_FIXER_ENDPOINT_MODEL || env.LANE_FIXER_AIR_MODEL } : {}),
      ...(env.LANE_FIXER_CLAUDE2_DIR ? { claude2ConfigDir: env.LANE_FIXER_CLAUDE2_DIR } : {}),
      ...(env.LANE_FIXER_PARALLEL ? { parallel: Number(env.LANE_FIXER_PARALLEL) } : {}),
    },
    builtInFixerSettings,
  );
}
