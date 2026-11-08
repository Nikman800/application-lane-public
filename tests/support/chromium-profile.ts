import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// On Windows, a new Chromium profile asks whether the account's password is
// blank by signing the account in with an empty password, and Windows counts
// that as a wrong password. Every test and replay starts a fresh profile, so
// a browser suite cost one bad password per test, and the 10-in-10-minutes
// lockout policy locked the applicant out of their own computer.
// Chromium keeps the answer in the profile's Local State and does not ask
// again while it holds one, so the answer is kept here and handed to each
// fresh profile. A changed password costs one check, then the answer updates.
const saved = join(tmpdir(), "lane-chromium", "password-check.json");

type PasswordCheck = { os_password_blank: boolean; os_password_last_changed: string };

// Before launch: the answer, when one is known, in the profile's Local State.
export async function seedChromiumProfile(profileDir: string) {
  const check: PasswordCheck | undefined = await readFile(saved, "utf8").then(JSON.parse, () => undefined);
  if (typeof check?.os_password_blank !== "boolean" || typeof check.os_password_last_changed !== "string") return;
  const path = join(profileDir, "Local State");
  const state = await readFile(path, "utf8").then(JSON.parse, () => ({}));
  state.password_manager = { ...state.password_manager, ...check };
  await mkdir(profileDir, { recursive: true });
  await writeFile(path, JSON.stringify(state));
}

// After the browser closes: the answer it holds, for the next profile.
export async function rememberChromiumProfile(profileDir: string) {
  const state = await readFile(join(profileDir, "Local State"), "utf8").then(JSON.parse, () => undefined);
  const manager = state?.password_manager;
  if (typeof manager?.os_password_blank !== "boolean" || typeof manager.os_password_last_changed !== "string") return;
  const check: PasswordCheck = { os_password_blank: manager.os_password_blank, os_password_last_changed: manager.os_password_last_changed };
  await mkdir(dirname(saved), { recursive: true });
  // Written aside and renamed: parallel workers read it while others write.
  const partial = `${saved}.${process.pid}.${Date.now()}`;
  await writeFile(partial, JSON.stringify(check));
  await rename(partial, saved).catch(() => rm(partial, { force: true }));
}
