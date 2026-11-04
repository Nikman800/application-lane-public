import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "./app";
import { atomicJSON, configSchema, dataDirectory, withTailoring, type Config } from "./store";
import { defaultDocumentsDirectory, packageVersion } from "./paths";

// The extension talks to port 4318 only (its manifest allows nothing else);
// LANE_PORT is for tests that must not meet a backend already running.
const PORT = Number(process.env.LANE_PORT) || 4318;
const args = process.argv.slice(2);
// application-lane setup: the optional drafting setup (setup.ts), bundled
// beside this file or run from the sources.
if (args[0] === "setup") {
  const bundled = fileURLToPath(new URL("./setup.mjs", import.meta.url));
  const run = existsSync(bundled)
    ? [bundled]
    : ["--import", "tsx", fileURLToPath(new URL("./setup.ts", import.meta.url))];
  process.exit(spawnSync(process.execPath, run, { stdio: "inherit" }).status ?? 1);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Application Lane backend ${packageVersion()}

Usage: application-lane [--pair]   (in a checkout: npm start [-- --pair])
       application-lane setup     (in a checkout: npm run setup)

  --pair   show a new pairing code, to connect another browser or extension
           (valid for 10 minutes)

Data folder: ${dataDirectory} (set LANE_DATA_DIR to use another)
Optional drafting setup: npm run setup, or Settings → Drafting on the dashboard.`);
  process.exit(0);
}

// Node 22 is what the project is built and tested on. Older versions mostly
// work, so this is a warning, not a refusal.
if (Number(process.versions.node.split(".")[0]) < 22)
  console.warn(
    `Note: Application Lane is tested on Node.js 22 or newer; this is ${process.version}. If something fails, install Node 22 from https://nodejs.org.`,
  );

// The configuration, made on first start: a fresh pairing token and nothing
// else. Drafting providers are chosen later, on the dashboard or with
// npm run setup.
async function loadConfig(): Promise<{ config: Config; created: boolean }> {
  const path = join(dataDirectory, "config.json");
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text !== undefined) return { config: configSchema.parse(JSON.parse(text)), created: false };
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const config = configSchema.parse({ token: randomBytes(32).toString("hex") });
  await atomicJSON(path, config);
  return { config, created: true };
}

try {
  const { config, created } = await loadConfig();
  config.documentsDir ??= defaultDocumentsDirectory();
  withTailoring(config);
  const { server, queue, pairing } = await createApp(config, dataDirectory);
  server.listen(PORT, "127.0.0.1", () => {
    console.log(
      [
        "",
        `  Application Lane ${packageVersion()} is running at http://127.0.0.1:${PORT} (this computer only).`,
        `  ${created ? "Created your data folder" : "Data folder"}: ${dataDirectory}`,
        config.extensionId
          ? "  Paired with your browser. Keep this window open while you apply; press Ctrl+C to stop."
          : "  Keep this window open while you apply; press Ctrl+C to stop.",
      ].join("\n"),
    );
    if (!config.extensionId) pairing.open("unpaired");
    else if (args.includes("--pair")) pairing.open("requested");
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${PORT} is already in use: Application Lane may already be running in another window. Close that one, or stop whatever else uses the port.`
        : error.message,
    );
    process.exitCode = 1;
  });
  // Watch mode restarts the backend by sending SIGTERM on every source change,
  // so shutting down has to be quick: cancel generation and close the port,
  // but never wait longer than this for a request that will not settle.
  const shutdown = () => {
    const done = () => process.exit(0);
    setTimeout(done, 2000).unref();
    void queue.cancelAll().finally(() => server.close(done));
    server.closeIdleConnections();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  // Watch mode reruns this on every edit, so the real cause has to be visible:
  // a syntax error in src reads nothing like a missing configuration.
  console.error(
    `Backend did not start: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error(
    `If ${join(dataDirectory, "config.json")} is invalid, fix or remove it (a new one is made on the next start), or run npm run setup.`,
  );
  process.exitCode = 1;
}
