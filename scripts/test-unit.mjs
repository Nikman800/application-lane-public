// Runs the unit tests (npm test): node --test on every tests/*.test.ts, listed
// here rather than by a quoted glob, which node --test expands only from Node
// 21 on and an unquoted one Windows' shell leaves alone. Extra arguments pass
// through, e.g. npm test -- --test-name-pattern "dates".

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(join(root, "tests")).filter((name) => name.endsWith(".test.ts")).sort().map((name) => join("tests", name));
const run = spawnSync(process.execPath, ["--import", "tsx", "--test", ...process.argv.slice(2), ...files], { cwd: root, stdio: "inherit" });
process.exitCode = run.status ?? 1;
