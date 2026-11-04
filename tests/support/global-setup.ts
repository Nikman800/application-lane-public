import { unlock, waitForLock } from "./suite-lock";

// Runs once before the browser suite, in the process that runs it.
export default async function globalSetup() {
  if (process.env.LANE_BROWSER_LOCK === "off") return;
  await waitForLock();
  // Released however the run ends: finished, failed, or interrupted.
  const release = () => unlock();
  process.once("exit", release);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => {
      release();
      process.exit(1);
    });
  return release;
}
