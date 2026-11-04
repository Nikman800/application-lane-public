// One browser-suite run at a time on this machine. Each test starts its own
// browser and backend, three at once; two runs side by side (two sessions, or
// a session and the report fixer) more than doubled the time and failed
// timing tests that pass alone. A second run waits here for the first.
//
// The lock is a file naming the run that holds it. A holder that is no
// longer running is ignored. LANE_BROWSER_LOCK=off skips it.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type Holder = { pid: number; cwd: string; since: string };

// The same path for every user and session, whatever their own TMPDIR.
export const lockPath = () =>
  process.env.LANE_BROWSER_LOCK_FILE ||
  join(process.platform === "win32" ? tmpdir() : "/tmp", "application-lane-browser-suite.lock");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Another account's process (the report fixer's) cannot be signalled, and is running.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export function holder(path = lockPath()): Holder | undefined {
  try {
    const found = JSON.parse(readFileSync(path, "utf8")) as Holder;
    return Number.isInteger(found.pid) && alive(found.pid) ? found : undefined;
  } catch {
    return undefined;
  }
}

// Takes the lock if nobody running holds it. Creating the file is the claim:
// only one of two runs arriving together can create it.
export function tryLock(path = lockPath(), pid = process.pid): boolean {
  if (holder(path)) return false;
  // Left by a run that has ended: clear it, then claim.
  rmSync(path, { force: true });
  try {
    mkdirSync(dirname(path), { recursive: true });
    const file = openSync(path, "wx", 0o666);
    writeSync(file, JSON.stringify({ pid, cwd: process.cwd(), since: new Date().toISOString() } satisfies Holder));
    closeSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function unlock(path = lockPath(), pid = process.pid): void {
  try {
    if ((JSON.parse(readFileSync(path, "utf8")) as Holder).pid === pid) rmSync(path, { force: true });
  } catch {
    /* Already gone. */
  }
}

// Returns whether the lock is held. The lock exists to save time, never to
// stop a run: where the file cannot be written or cleared (another account's
// stale file in a sticky /tmp, a sandbox without /tmp), the run goes ahead
// without it.
export async function waitForLock(options: { path?: string; timeoutMs?: number; pollMs?: number; log?: (line: string) => void } = {}): Promise<boolean> {
  const { path = lockPath(), timeoutMs = 90 * 60_000, pollMs = 5_000, log = console.log } = options;
  const deadline = Date.now() + timeoutMs;
  let announced = 0;
  const attempt = () => {
    try {
      return tryLock(path);
    } catch (error) {
      log(`Running without the browser-suite lock: ${(error as Error).message}`);
      return undefined;
    }
  };
  for (let taken = attempt(); !taken; taken = attempt()) {
    if (taken === undefined) return false;
    const other = holder(path);
    if (other && other.pid !== announced) {
      announced = other.pid;
      log(`Waiting for another browser-suite run to finish (pid ${other.pid}, in ${other.cwd}, since ${other.since}).`);
    }
    if (Date.now() > deadline) throw new Error(`Another browser-suite run still holds ${path} after ${Math.round(timeoutMs / 60_000)} minutes.`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}
