// Bring the applicant's tailoring files into this installation, so the lane
// needs no job-applier checkout:
//   npm run tailoring:import -- ../job-applier
// Copies the .tex resumes, profile.md, preferences.md and the question guides
// into <data directory>/tailoring (never committed), and stops pointing the
// configuration at the checkout. The checkout itself is left untouched; after
// this, edit the copies.
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tailoringHome } from "../src/server/job-apply";
import { dataDirectory } from "../src/server/store";

export async function importTailoring(source: string, data = dataDirectory): Promise<string[]> {
  const home = tailoringHome(resolve(source));
  if (!existsSync(home.sources)) throw new Error(`${source} has no resumes to import (looked in ${home.sources}).`);
  const target = join(data, "tailoring");
  const done: string[] = [];
  await mkdir(join(target, "resumes"), { recursive: true });
  // Sources only: build products (.aux, .log, .pdf) stay behind.
  for (const name of await readdir(home.sources))
    if (/\.(tex|cls|sty|bib)$/i.test(name)) {
      await cp(join(home.sources, name), join(target, "resumes", name));
      done.push(`resumes/${name}`);
    }
  for (const name of ["profile.md", "preferences.md"])
    if (existsSync(join(home.notes, name))) {
      await cp(join(home.notes, name), join(target, name));
      done.push(name);
    }
  await mkdir(join(target, "references"), { recursive: true });
  for (const name of ["common-questions.md", "anti-fabrication.md"]) {
    const found = home.references.map((root) => join(root, name)).find(existsSync);
    if (found) {
      await cp(found, join(target, "references", name));
      done.push(`references/${name}`);
    }
  }
  // The imported folder is found on its own; a setting naming the checkout
  // would keep the lane reading the checkout instead.
  const configPath = join(data, "config.json");
  if (existsSync(configPath)) {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (config.jobApplierDir !== undefined || config.tailorDir !== undefined) {
      delete config.jobApplierDir;
      delete config.tailorDir;
      await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      done.push("config.json: no longer points at a checkout");
    }
  }
  return done;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.argv[2];
  if (!source) {
    console.error("Usage: npm run tailoring:import -- <folder holding your resumes, or a job-applier checkout>");
    process.exit(1);
  }
  const done = await importTailoring(source);
  console.log(`Imported into ${join(dataDirectory, "tailoring")}:`);
  for (const item of done) console.log(`  ${item}`);
  console.log("Restart the backend to use it.");
}
