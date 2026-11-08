import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { desktopPath, exportDocuments, exportedFileName, exportedPaths, jobFolderName, markSent } from "../src/server/export";
import type { Artifact, GenerationJob } from "../src/shared/model";

const applicant = { firstName: "Jamie", lastName: "Rivera" };

test("a job's folder is named by company and role, and its files by applicant, document and company", () => {
  assert.equal(
    jobFolderName("Precisely", "Associate software Engineer (Python AI) | Precisely | LinkedIn"),
    "Precisely – Associate software Engineer (Python AI)",
  );
  // Nothing a file system refuses, and no way out of the documents folder.
  assert.equal(jobFolderName("A/B: Co.", '../../etc "x"?'), "A B Co – etc x");
  assert.equal(jobFolderName(undefined, ""), "Application");
  assert.equal(jobFolderName("Acme", "Acme"), "Acme");
  const artifact = (kind: Artifact["kind"], format: Artifact["format"], name = "x") => ({ kind, format, name });
  assert.equal(exportedFileName(applicant, artifact("resume", "pdf"), "Precisely"), "Jamie_Rivera_Resume_Precisely.pdf");
  assert.equal(exportedFileName(applicant, artifact("cover", "docx"), "O'Neil & Sons"), "Jamie_Rivera_Cover_Letter_O_Neil_Sons.docx");
  assert.equal(exportedFileName({ firstName: "", lastName: "" }, artifact("resume", "pdf"), undefined), "Applicant_Resume.pdf");
  // A transcript is the applicant's own file and keeps its name.
  assert.equal(exportedFileName(applicant, artifact("transcript", "pdf", "MSU transcript.pdf"), "Precisely"), "MSU transcript.pdf");
});

test("documents are written per job, replaced by a redraft, and moved under Sent without touching other files", async () => {
  const data = await mkdtemp(join(tmpdir(), "lane-export-data-"));
  const root = join(await mkdtemp(join(tmpdir(), "lane-export-")), "Application Lane");
  await mkdir(join(data, "artifacts"));
  const job = async (id: string, formats: Artifact["format"][]): Promise<GenerationJob> => {
    const artifacts = formats.map((format, i): Artifact => ({
      id: `${id}-${i}`, kind: i ? "cover" : "resume", format, name: "n", mime: "m", applicationId: "app", operation: 1,
    }));
    for (const artifact of artifacts) await writeFile(join(data, "artifacts", `${artifact.id}.${artifact.format}`), id);
    return { id, applicationId: "app", operation: 1, profileRevision: 1, status: "complete", artifacts, createdAt: 1 };
  };
  const request = { company: "Precisely", title: "Engineer | Precisely | LinkedIn" };
  const first = await job("first", ["pdf", "docx"]);
  await exportDocuments(root, data, first, applicant, request, []);
  const folder = join(root, "Precisely – Engineer");
  assert.deepEqual((await readdir(folder)).sort(), ["Jamie_Rivera_Cover_Letter_Precisely.docx", "Jamie_Rivera_Resume_Precisely.pdf"]);
  assert.equal(exportedPaths(root, first.exported!).files[0].path, join(folder, "Jamie_Rivera_Resume_Precisely.pdf"));

  // The applicant's own file in the folder survives a redraft; the old drafts do not.
  await writeFile(join(folder, "notes.txt"), "mine");
  const second = await job("second", ["pdf"]);
  await exportDocuments(root, data, second, applicant, request, [first]);
  assert.equal(first.exported, undefined);
  assert.deepEqual((await readdir(folder)).sort(), ["Jamie_Rivera_Resume_Precisely.pdf", "notes.txt"]);
  assert.equal(await readFile(join(folder, "Jamie_Rivera_Resume_Precisely.pdf"), "utf8"), "second");

  await markSent(root, second.exported!, true);
  assert.deepEqual(await readdir(root), ["Sent"]);
  assert.deepEqual((await readdir(join(root, "Sent", "Precisely – Engineer"))).sort(), ["Jamie_Rivera_Resume_Precisely.pdf", "notes.txt"]);
  assert.equal(exportedPaths(root, second.exported!).folder, join(root, "Sent", "Precisely – Engineer"));
  // A redraft of a submitted application stays under Sent.
  const third = await job("third", ["pdf"]);
  await exportDocuments(root, data, third, applicant, request, [second]);
  assert.equal(third.exported!.sent, true);
  await markSent(root, third.exported!, false);
  assert.deepEqual((await readdir(join(root, "Precisely – Engineer"))).sort(), ["Jamie_Rivera_Resume_Precisely.pdf", "notes.txt"]);
});

test("a file under WSL is given by its Windows path, for the desktop's file chooser", () => {
  //: Copy resume path gave /mnt/c/…, which Chrome's chooser on
  // Windows does not take.
  assert.equal(
    desktopPath("/mnt/c/Users/User1/Documents/Application Lane/Acme – GIS Developer/Resume.pdf", true),
    "C:\\Users\\User1\\Documents\\Application Lane\\Acme – GIS Developer\\Resume.pdf",
  );
  assert.equal(desktopPath("/mnt/d", true), "D:\\");
  // Outside WSL, or a Linux path, it is left as it is.
  assert.equal(desktopPath("/mnt/c/Users/x.pdf", false), "/mnt/c/Users/x.pdf");
  assert.equal(desktopPath("/home/me/Documents/x.pdf", true), "/home/me/Documents/x.pdf");
});
