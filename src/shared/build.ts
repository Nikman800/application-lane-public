// When and from which commit this extension was built (scripts/build.mjs).
// The panel shows it, and says so when the backend's dist/ holds a newer
// build than the one loaded: a forgotten reload of the extension was taken
// for a fix that did not work ("I definitely reloaded it").

export type BuildStamp = { builtAt: number; commit: string };
declare const __BUILD__: BuildStamp | undefined;
export const extensionBuild: BuildStamp | undefined = typeof __BUILD__ !== "undefined" ? __BUILD__ : undefined;

// A newer build waiting: one built more than a minute after the loaded one
// (both builds of one run share a stamp).
export function newerBuild(loaded: BuildStamp | undefined, available: BuildStamp | undefined): BuildStamp | undefined {
  return loaded && available && available.builtAt > loaded.builtAt + 60_000 ? available : undefined;
}

export const describeBuild = (stamp: BuildStamp) => `${new Date(stamp.builtAt).toLocaleString()} (${stamp.commit})`;
