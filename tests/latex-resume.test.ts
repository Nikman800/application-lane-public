import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chooseVariant, latexResume } from "../src/server/latex";

const posting = (title: string, description: string) =>
  ({ title, description }) as never;
// The applicant's own sources: two variants that share most of their text.
const swe = String.raw`\section*{Summary}
Software engineer specializing in scalable backend services and distributed systems.
\section*{Technical Skills}
Python, TypeScript, Node.js, PostgreSQL, Redis, REST API design.`;
const ml = String.raw`\section*{Summary}
AI/ML engineer specializing in computer vision and deep learning.
\section*{Technical Skills}
Python, TypeScript, PyTorch, U-Net, OpenCV, CUDA, model evaluation.`;
const variants = [
  { file: "Ada_Lovelace_Software_Engineer_Resume.tex", tex: swe },
  { file: "Ada_Lovelace_AI_ML_Engineer_Resume.tex", tex: ml },
];

test("the variant named for the role family wins, even on a thin posting", () => {
  assert.equal(
    chooseVariant(
      variants,
      posting("Software Engineer Intern (Summer 2027)", "Backend services."),
    ),
    "Ada_Lovelace_Software_Engineer_Resume.tex",
  );
});

test("vocabulary decides when no variant is named for the role", () => {
  assert.equal(
    chooseVariant(
      variants,
      posting(
        "Perception Research Intern",
        "Train U-Net models on satellite imagery with PyTorch and CUDA.",
      ),
    ),
    "Ada_Lovelace_AI_ML_Engineer_Resume.tex",
  );
  // Shared words — Python, TypeScript — carry no signal either way.
  assert.equal(
    chooseVariant(
      variants,
      posting("Engineer", "Python and TypeScript, REST API design."),
    ),
    "Ada_Lovelace_Software_Engineer_Resume.tex",
  );
});

test("a broken source is reported rather than swallowed", async () => {
  const has = await promisify(execFile)("pdflatex", ["--version"]).then(
    () => true,
    () => false,
  );
  if (!has) return; // LaTeX is optional; the caller falls back without it.
  const directory = await mkdtemp(join(tmpdir(), "lane-tex-"));
  try {
    await writeFile(
      join(directory, "Broken_Resume.tex"),
      "\\documentclass{article}\\begin{document}\\undefinedcommand\\end{document}",
    );
    await assert.rejects(
      latexResume(directory, posting("Engineer", "")),
      /pdflatex failed on Broken_Resume\.tex/,
    );
    await writeFile(
      join(directory, "Broken_Resume.tex"),
      "\\documentclass{article}\\begin{document}Ada Lovelace\\end{document}",
    );
    const built = await latexResume(directory, posting("Engineer", ""));
    assert.equal(built.name, "Broken_Resume.pdf");
    assert.ok(built.data.length > 500);
    assert.equal(
      Buffer.from(built.data.subarray(0, 5)).toString("latin1"),
      "%PDF-",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no sources at all is an actionable error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lane-tex-empty-"));
  try {
    await assert.rejects(
      latexResume(directory, posting("Engineer", "")),
      /No \.tex sources/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unreadable directory never becomes a missing resume", async () => {
  // documents.ts catches this and falls back to its own layout.
  await assert.rejects(latexResume("/does/not/exist", posting("Engineer", "")));
  void readFile;
});

test("a relative resumeLatexDir resolves against the repository", async () => {
  const error = await latexResume("../not-a-checkout", posting("Engineer", ""))
    .then(() => "")
    .catch((e: Error) => e.message);
  // Named twice: what was configured, and where that landed.
  assert.match(error, /resumeLatexDir points at \.\.\/not-a-checkout \(/);
  assert.ok(error.includes(basename(dirname(process.cwd()))));
});
