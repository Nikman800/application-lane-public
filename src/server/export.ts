// Drafted documents, written where the applicant can pick them in a site's
// own file chooser: one folder per job, moved under Sent once it is submitted.
// Only files recorded here as written are ever replaced or removed.
import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { release } from "node:os";
import type { Artifact, GenerationJob, Profile } from "../shared/model";
import { isWSL, wslPath } from "./paths";

export type Exported = NonNullable<GenerationJob["exported"]>;

// One path segment that every desktop file system accepts.
export function fileNamePart(text: string, limit = 80): string {
  return text
    .normalize("NFC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, limit)
    .trim();
}

// "Precisely – Associate Software Engineer". A tab title carries the site
// and company after the role ("Role | Company | an employer"); the role is first.
export function jobFolderName(company: string | undefined, title: string): string {
  const firm = fileNamePart(company || "", 50);
  const role = fileNamePart(title.split(/\s[|·]\s/)[0] || "", 70);
  const same = firm && role.toLowerCase() === firm.toLowerCase();
  return [firm, same ? "" : role].filter(Boolean).join(" – ") || "Application";
}

// The employer sees this name: the applicant's own, the document, the company.
export function exportedFileName(
  profile: Pick<Profile, "firstName" | "lastName">,
  artifact: Pick<Artifact, "kind" | "format" | "name">,
  company: string | undefined,
): string {
  if (artifact.kind === "transcript") return fileNamePart(artifact.name, 120) || `Transcript.${artifact.format}`;
  const words = (text: string) => fileNamePart(text, 40).replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
  return [
    words(`${profile.firstName} ${profile.lastName}`) || "Applicant",
    artifact.kind === "resume" ? "Resume" : "Cover_Letter",
    words(company || ""),
  ]
    .filter(Boolean)
    .join("_") + `.${artifact.format}`;
}

const folderOf = (root: string, exported: Pick<Exported, "folder" | "sent">) =>
  exported.sent ? join(root, "Sent", exported.folder) : join(root, exported.folder);

export async function removeWritten(root: string, exported: Exported) {
  const folder = folderOf(root, exported);
  for (const file of exported.files) await rm(join(folder, file.name), { force: true });
  // Only when nothing of the applicant's own is left in it.
  await rmdir(folder).catch(() => {});
}

export async function exportDocuments(
  root: string,
  dataDirectory: string,
  job: GenerationJob,
  profile: Pick<Profile, "firstName" | "lastName">,
  request: { company?: string; title: string },
  // Earlier exports for this application, replaced by this one.
  earlier: GenerationJob[],
): Promise<Exported> {
  const sent = earlier.some((other) => other.exported?.sent);
  for (const other of earlier)
    if (other.exported) {
      await removeWritten(root, other.exported);
      delete other.exported;
    }
  const exported: Exported = {
    folder: jobFolderName(request.company, job.posting?.title || request.title),
    sent,
    files: [],
  };
  const folder = folderOf(root, exported);
  await mkdir(folder, { recursive: true });
  for (const artifact of job.artifacts) {
    let name = exportedFileName(profile, artifact, request.company);
    // Two documents of one kind and format keep both.
    for (let n = 2; exported.files.some((file) => file.name === name); n++)
      name = name.replace(/(?: \(\d+\))?(\.[^.]+)$/, ` (${n})$1`);
    await copyFile(join(dataDirectory, "artifacts", `${artifact.id}.${artifact.format}`), join(folder, name));
    exported.files.push({ artifactId: artifact.id, kind: artifact.kind, name });
  }
  job.exported = exported;
  return exported;
}

// Where each exported document is now, for the panel to hand to a file chooser.
export function exportedPaths(root: string, exported: Exported) {
  const folder = folderOf(root, exported);
  return { folder, sent: exported.sent, files: exported.files.map((file) => ({ ...file, path: join(folder, file.name) })) };
}

// A submitted application's folder moves under Sent, and back if it is reopened.
export async function markSent(root: string, exported: Exported, sent: boolean) {
  if (exported.sent === sent) return;
  const from = folderOf(root, exported);
  const to = folderOf(root, { ...exported, sent });
  await mkdir(join(to, ".."), { recursive: true });
  const taken = await readdir(to).then(() => true, () => false);
  if (taken) {
    // Another export already uses the name there: move the files in beside it.
    for (const file of exported.files) await rename(join(from, file.name), join(to, file.name)).catch(() => {});
    await rmdir(from).catch(() => {});
  } else await rename(from, to);
  exported.sent = sent;
}

// A path as the applicant's desktop names it. The backend in WSL saves to
// /mnt/c/…, which Chrome's file chooser on Windows does not take, and Open
// folder found no desktop behind xdg-open.
const wsl = process.platform === "linux" && (Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(release()));
export function desktopPath(path: string, inWsl = wsl): string {
  const drive = inWsl ? path.match(/^\/mnt\/([a-z])(\/.*)?$/i) : null;
  return drive ? `${drive[1].toUpperCase()}:${(drive[2] || "/").replace(/\//g, "\\")}` : path;
}

export function openFolder(folder: string) {
  // Under WSL the folder opens in Windows Explorer, by its Windows name.
  const windowsName = isWSL() ? wslPath(folder, "-w") || desktopPath(folder) : undefined;
  const command = windowsName ? "explorer.exe" : process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(command, [windowsName || folder], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
