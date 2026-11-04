// The owner's development tools (the report fixer, scripts/fixer.ts, and its
// dashboard page) are not part of a public build. The extension build sets
// __LANE_DEV_TOOLS__ (scripts/build.mjs); the backend asks devToolsEnabled.
declare const __LANE_DEV_TOOLS__: boolean;
export const devToolsBuild = typeof __LANE_DEV_TOOLS__ !== "undefined" && __LANE_DEV_TOOLS__;

// LANE_DEV_TOOLS=1 or 0 decides; otherwise the tools are on where the fixer's
// own script is in the tree. scripts/build.mjs repeats this rule.
export function devToolsEnabled(env: Record<string, string | undefined>, fixerScriptExists: () => boolean): boolean {
  if (env.LANE_DEV_TOOLS === "1") return true;
  if (env.LANE_DEV_TOOLS === "0") return false;
  return fixerScriptExists();
}
