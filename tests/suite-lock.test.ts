import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { holder, tryLock, unlock, waitForLock } from "./support/suite-lock";

test("only one browser-suite run holds the machine, and a run that has ended is ignored", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "lane-suite-lock-")), "suite.lock");
  assert.equal(holder(path), undefined);
  assert.equal(tryLock(path), true);
  assert.equal(holder(path)?.pid, process.pid);
  // A second run, another process still running, does not get it.
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    assert.equal(tryLock(path, other.pid!), false);
    // Nor can it release what it does not hold.
    unlock(path, other.pid!);
    assert.equal(holder(path)?.pid, process.pid);
    unlock(path);
    assert.equal(existsSync(path), false);

    // Held by the other run: this one waits, and gets it when that run ends.
    assert.equal(tryLock(path, other.pid!), true);
    const lines: string[] = [];
    const waiting = waitForLock({ path, pollMs: 50, log: (line) => lines.push(line) });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(holder(path)?.pid, other.pid);
    other.kill();
    await waiting;
    assert.equal(holder(path)?.pid, process.pid);
    assert.match(lines.join("\n"), new RegExp(`Waiting for another browser-suite run to finish \\(pid ${other.pid},`));
    assert.equal(lines.length, 1);
  } finally {
    other.kill();
    unlock(path);
  }
  // A file left by a crashed run, or one that is not a lock at all, is no holder.
  await writeFile(path, JSON.stringify({ pid: 2 ** 22 + 12345, cwd: "/gone", since: "then" }));
  assert.equal(holder(path), undefined);
  assert.equal(tryLock(path), true);
  assert.match(await readFile(path, "utf8"), new RegExp(`"pid":${process.pid}`));
  unlock(path);
  await writeFile(path, "not json");
  assert.equal(tryLock(path), true);
  unlock(path);
  // A lock file that cannot be created does not stop the run.
  const lines: string[] = [];
  await writeFile(path, "a file, where a folder would have to be");
  assert.equal(await waitForLock({ path: join(path, "inside-a-file", "suite.lock"), log: (line) => lines.push(line) }), false);
  assert.match(lines.join(""), /Running without the browser-suite lock/);
  await rm(path);
  await assert.rejects(async () => {
    assert.equal(tryLock(path, process.ppid), true);
    await waitForLock({ path, pollMs: 20, timeoutMs: 100, log: () => {} });
  }, /still holds/);
});
