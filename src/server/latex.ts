import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GenerationRequest } from "../shared/model";
import { packageRoot } from "./paths";

// The applicant maintains their own resume as LaTeX sources, one per role
// family. Rendering our own layout produced something they would never send,
// so the resume PDF comes from their pipeline: we choose the variant that fits
// the posting and compile it unchanged. Nothing here writes to their sources.

const run = promisify(execFile);
const engine = process.platform === "win32" ? "pdflatex.exe" : "pdflatex";

export type LatexResume = { name: string; data: Uint8Array; source: string };

// LaTeX markup is not content: strip commands and braces before comparing a
// variant against a job description.
const prose = (tex: string) =>
  tex
    .replace(/%.*$/gmu, " ")
    .replace(/\\[a-zA-Z@]+\s*(\[[^\]]*\])?/gu, " ")
    .replace(/[{}$&~^_\\]/gu, " ");

// Internal dots matter ("node.js", "0.85"); a trailing one is just the end of
// a sentence, and leaving it on makes "systems." a different word from
// "systems".
const words = (text: string) =>
  new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}+#.]{3,}/gu) || [])
      .map((word) => word.replace(/^\.+|\.+$/gu, ""))
      .filter((word) => word.length >= 3),
  );

export function chooseVariant(
  variants: { file: string; tex: string }[],
  request: Pick<GenerationRequest, "title" | "description">,
): string | undefined {
  if (!variants.length) return;
  if (variants.length === 1) return variants[0].file;
  const title = words(request.title);
  const description = words(request.description);
  const vocabularies = variants.map(({ file, tex }) => ({
    file,
    vocabulary: words(prose(tex)),
  }));
  // Every variant carries the same name, school and half the same skills, and
  // that shared vocabulary decides nothing: a longer resume would simply
  // intersect the posting more often. Only the words that tell the variants
  // apart are evidence of fit.
  const shared = [...vocabularies[0].vocabulary].filter((word) =>
    vocabularies.every(({ vocabulary }) => vocabulary.has(word)),
  );
  const common = new Set(shared);
  const scored = vocabularies
    .map(({ file, vocabulary }) => ({
      file,
      // The applicant names each variant after the role family it is for
      // ("..._Software_Engineer_Resume.tex"), which says more about fit than
      // any single word inside it. Vocabulary then settles the rest.
      score:
        [...words(file.replace(/[._-]+/gu, " "))].filter((word) =>
          title.has(word),
        ).length *
          10 +
        [...vocabulary].reduce(
          (total, word) =>
            common.has(word)
              ? total
              : total +
                (title.has(word) ? 3 : 0) +
                (description.has(word) ? 1 : 0),
          0,
        ),
    }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored[0].file;
}

export async function latexResume(
  configured: string,
  request: Pick<GenerationRequest, "title" | "description">,
): Promise<LatexResume> {
  // A relative path is resolved against the checkout (the package root),
  // so one setting works on every machine the checkout lives on.
  const directory = isAbsolute(configured)
    ? configured
    : resolve(packageRoot, configured);
  const entries = await readdir(directory).catch(
    (error: NodeJS.ErrnoException) => {
      throw new Error(
        error.code === "ENOENT"
          ? `resumeLatexDir points at ${configured} (${directory}), which does not exist.`
          : `Could not read ${directory}: ${error.message}`,
      );
    },
  );
  const files = entries.filter((file) => extname(file) === ".tex");
  if (!files.length)
    throw new Error(`No .tex sources in ${directory}. Check resumeLatexDir.`);
  const variants = await Promise.all(
    files.map(async (file) => ({
      file,
      tex: await readFile(join(directory, file), "utf8"),
    })),
  );
  const chosen = chooseVariant(variants, request)!;
  const out = await mkdtemp(join(tmpdir(), "lane-latex-"));
  try {
    // Twice, because hyperref and the layout settle on the second pass. Shell
    // escape stays off: compiling a document must not run programs.
    for (const pass of [1, 2]) {
      void pass;
      await run(
        engine,
        [
          "-interaction=nonstopmode",
          "-halt-on-error",
          "-no-shell-escape",
          `-output-directory=${out}`,
          chosen,
        ],
        { cwd: directory, timeout: 120_000, maxBuffer: 1 << 24 },
      ).catch((error: { stdout?: string; message: string }) => {
        const log = (error.stdout || error.message)
          .split("\n")
          .filter((line) => line.startsWith("!") || line.startsWith("l."))
          .slice(0, 6)
          .join(" ");
        throw new Error(
          `pdflatex failed on ${chosen}${log ? `: ${log}` : "."}`,
        );
      });
    }
    const pdf = join(out, `${basename(chosen, ".tex")}.pdf`);
    return {
      name: basename(pdf),
      data: await readFile(pdf),
      source: chosen,
    };
  } finally {
    await rm(out, { recursive: true, force: true }).catch(() => {});
  }
}
