import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Where the backend keeps things, independent of the folder it was started
// from. This module sits two levels below the package root both as source
// (src/server/paths.ts) and bundled (dist/server/index.mjs), so the root is
// found the same way in a checkout and in an installed package.
export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

export function packageVersion(root = packageRoot): string {
  try {
    return String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

type Environment = Record<string, string | undefined>;

// The per-user application-data folder of each platform.
export function appDataDirectory(
  platform: NodeJS.Platform = process.platform,
  env: Environment = process.env,
  home = homedir(),
): string {
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "Application Lane");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Application Lane");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "application-lane");
}

// LANE_DATA_DIR first. Then an existing installation's .local/ (one with a
// config.json) in the folder the backend was started from or in the
// checkout itself: installations from before the app-data default keep
// their data where it is. Otherwise the platform's app-data folder.
export function resolveDataDirectory(
  options: { env?: Environment; cwd?: string; root?: string; platform?: NodeJS.Platform; home?: string } = {},
): string {
  const env = options.env || process.env;
  if (env.LANE_DATA_DIR) return resolve(options.cwd || process.cwd(), env.LANE_DATA_DIR);
  for (const base of [options.cwd || process.cwd(), options.root || packageRoot]) {
    const legacy = resolve(base, ".local");
    if (existsSync(join(legacy, "config.json"))) return legacy;
  }
  return appDataDirectory(options.platform, env, options.home);
}

let wsl: boolean | undefined;
export function isWSL(): boolean {
  if (wsl === undefined) {
    try {
      wsl = process.platform === "linux" && /microsoft/i.test(readFileSync("/proc/version", "utf8"));
    } catch {
      wsl = false;
    }
  }
  return wsl;
}

// A Linux path as Windows names it (for explorer.exe), or a Windows path as
// this Linux names it. Undefined when wslpath is unavailable.
export function wslPath(path: string, direction: "-w" | "-u"): string | undefined {
  try {
    return execFileSync("wslpath", [direction, path], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

// The Windows user's Documents folder as seen from WSL, or undefined.
function windowsDocuments(): string | undefined {
  const ask = (command: string, args: string[]) => {
    try {
      return execFileSync(command, args, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"], cwd: "/" }).trim();
    } catch {
      return "";
    }
  };
  // The shell's own answer follows a Documents folder moved to OneDrive.
  const candidates = [
    ask("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('MyDocuments')"]),
    (() => {
      const profile = ask("cmd.exe", ["/d", "/c", "echo %USERPROFILE%"]);
      return profile && !profile.includes("%") ? `${profile}\\Documents` : "";
    })(),
  ];
  for (const candidate of candidates.filter(Boolean)) {
    const local = wslPath(candidate.replace(/\r/g, ""), "-u");
    if (local && existsSync(local)) return local;
  }
  return undefined;
}

// Where drafted documents are written by default: ~/Documents/Application
// Lane, or under WSL the Windows Documents folder (where a browser's file
// chooser looks), unless the Linux one is already in use.
export function defaultDocumentsDirectory(home = homedir()): string {
  const linux = join(home, "Documents", "Application Lane");
  if (!isWSL() || existsSync(linux)) return linux;
  const windows = windowsDocuments();
  return windows ? join(windows, "Application Lane") : linux;
}
