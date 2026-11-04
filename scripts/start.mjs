#!/usr/bin/env node
// npm start: the bundled backend (dist/server/index.mjs, made by npm run
// build) when it is there and at least as new as the sources, otherwise the
// TypeScript sources through tsx. Arguments pass through (npm start -- --pair).
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "dist", "server", "index.mjs");
const sources = ["src/server", "src/shared", "src/engine"].map((folder) => join(root, folder)).filter((folder) => existsSync(folder));

function newest(folder) {
  let latest = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return latest;
}

const hasTsx = existsSync(join(root, "node_modules", "tsx"));
const fresh = existsSync(bundle) && (!sources.length || statSync(bundle).mtimeMs >= Math.max(...sources.map(newest)));
const useBundle = fresh || !hasTsx;
if (!useBundle && existsSync(bundle)) console.log("Sources changed since the last npm run build: running them directly.");
if (useBundle && !existsSync(bundle)) {
  console.error("The backend is not built yet. Run npm ci and npm run build first.");
  process.exit(1);
}
const args = useBundle
  ? [bundle, ...process.argv.slice(2)]
  : ["--import", "tsx", join(root, "src", "server", "index.ts"), ...process.argv.slice(2)];
const child = spawn(process.execPath, args, { stdio: "inherit" });
// Ctrl+C reaches the child through the terminal by itself; SIGTERM sent to
// this process alone is passed on.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
