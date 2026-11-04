// One file that carries the applicant to another installation: the profile
// and the tailoring folder's own files. Nothing that belongs to a machine
// travels with it (pairing token, API keys, model settings), nor generated
// documents or application history.
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { profileSchema, type Profile } from "../shared/model";
import { tailoringHome } from "./job-apply";

// The only places a bundle may write, all inside <data directory>/tailoring.
const tailoringPath = /^(profile\.md|preferences\.md|cover-letter-example\.md|resumes\/[\w .()+-]+\.(tex|cls|sty|bib)|references\/[\w .()+-]+\.md)$/i;

export const bundleSchema = z.object({
  format: z.literal("application-lane-profile"),
  version: z.literal(1),
  exportedAt: z.string().max(40),
  profile: profileSchema,
  tailoring: z
    .array(
      z.object({
        path: z.string().max(200).regex(tailoringPath, "Not a tailoring file this installation accepts."),
        text: z.string().max(2_000_000),
      }),
    )
    .max(60)
    .default([]),
  // The extension's own choices (AI filling, legal questions and the like).
  // The backend carries them untouched; the panel applies them.
  settings: z.record(z.unknown()).optional(),
});
export type ProfileBundle = z.infer<typeof bundleSchema>;

async function listed(folder: string, pattern: RegExp): Promise<string[]> {
  return (await readdir(folder).catch(() => [] as string[])).filter((name) => pattern.test(name)).sort();
}

export async function exportBundle(profile: Profile, tailorDir: string | undefined): Promise<ProfileBundle> {
  const tailoring: ProfileBundle["tailoring"] = [];
  if (tailorDir) {
    const home = tailoringHome(tailorDir);
    const add = async (path: string, file: string) => {
      const text = await readFile(file, "utf8").catch(() => undefined);
      if (text !== undefined && tailoringPath.test(path)) tailoring.push({ path, text });
    };
    for (const name of ["profile.md", "preferences.md", "cover-letter-example.md"]) await add(name, join(home.notes, name));
    for (const name of await listed(home.sources, /\.(tex|cls|sty|bib)$/i)) await add(`resumes/${name}`, join(home.sources, name));
    // The first folder that has a guide wins, as it does when they are read.
    const seen = new Set<string>();
    for (const root of home.references)
      for (const name of await listed(root, /\.md$/i))
        if (!seen.has(name)) {
          seen.add(name);
          await add(`references/${name}`, join(root, name));
        }
  }
  return { format: "application-lane-profile", version: 1, exportedAt: new Date().toISOString(), profile, tailoring };
}

// Writes the bundle's files into <directory>/tailoring. A file already there
// under the same name is replaced; anything else in the folder is left.
export async function importTailoringFiles(files: ProfileBundle["tailoring"], directory: string): Promise<string[]> {
  const target = join(directory, "tailoring");
  const written: string[] = [];
  for (const file of files) {
    if (!tailoringPath.test(file.path) || file.path.includes("..")) continue;
    const destination = join(target, ...file.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.text, { mode: 0o600 });
    written.push(file.path);
  }
  return written;
}

export const importedTailoring = (directory: string) => existsSync(join(directory, "tailoring", "resumes"));
