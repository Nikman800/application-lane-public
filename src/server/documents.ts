import { copyFile, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import mammoth from "mammoth";
import { latexResume } from "./latex";
import { resumeDocx, resumePdf } from "./resume-layout";
import { letterDateText, paperSize } from "../shared/dates";
import type {
  Artifact,
  GenerationRequest,
  Narrative,
  Profile,
} from "../shared/model";

export async function extractResume(
  buffer: Buffer,
  format: "pdf" | "docx",
): Promise<string> {
  if (buffer.length > 10 * 1024 * 1024)
    throw new Error("Resume must be smaller than 10 MB.");
  if (format === "docx")
    return (await mammoth.extractRawText({ buffer })).value.slice(0, 60000);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise;
  try {
    if (document.numPages > 30) throw new Error("Import up to 30 pages.");
    const pages: string[] = [];
    for (let i = 1; i <= document.numPages; i++) {
      const content = await (await document.getPage(i)).getTextContent();
      pages.push(
        content.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
          )
          .join(""),
      );
    }
    const result = pages.join("\n").slice(0, 60000).trim();
    if (!result)
      throw new Error(
        "This PDF has no extractable text. Paste the resume text or use a DOCX file.",
      );
    return result;
  } finally {
    await document.destroy();
  }
}

// In the applicant's own date style (shared/dates.ts).
export function letterDate(profile?: Pick<Profile, "country" | "locale">): string {
  return letterDateText(profile);
}

// The letter's paragraphs after its date: greeting, body, and the name. The
// job-apply skill's letters close on their last paragraph and the name alone.
// Where the applicant's transcript is kept: the folder they named, or
// transcripts/ in the data folder. A checkout's .local/ that already has
// transcripts/ beside it (the default before) keeps using that one.
export const transcriptsFolder = (configured: string | undefined, directory: string) =>
  configured
    ? resolve(configured)
    : basename(directory) === ".local" && existsSync(join(directory, "..", "transcripts"))
      ? join(directory, "..", "transcripts")
      : join(directory, "transcripts");

// The transcript a form would be given: the newest PDF or DOCX in the folder.
export async function newestTranscript(folder: string): Promise<{ name: string; mtime: number } | undefined> {
  const files = await readdir(folder).catch(() => [] as string[]);
  const candidates = await Promise.all(
    files
      .filter((name) => /\.(pdf|docx)$/i.test(name))
      .map(async (name) => ({ name, mtime: (await stat(join(folder, name))).mtimeMs })),
  );
  return candidates.sort((a, b) => b.mtime - a.mtime)[0];
}

// The applicant's transcript as an artifact of this application: their own
// file, copied as it is, never generated or changed. The newest PDF or DOCX
// in the first transcripts folder that has one.
export async function transcriptArtifact(
  directory: string,
  folders: string[],
  request: Pick<GenerationRequest, "applicationId" | "operation">,
): Promise<Artifact | undefined> {
  for (const folder of folders) {
    const newest = await newestTranscript(folder);
    if (!newest) continue;
    const format = newest.name.toLowerCase().endsWith(".pdf") ? ("pdf" as const) : ("docx" as const);
    const id = randomUUID();
    await copyFile(join(folder, newest.name), join(directory, "artifacts", `${id}.${format}`));
    return {
      id,
      kind: "transcript",
      format,
      name: newest.name,
      applicationId: request.applicationId,
      operation: request.operation,
      mime:
        format === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  }
}

export function letterBody(profile: Profile, narrative: Narrative): string[] {
  return [
    ...narrative.coverLetter.map((p) => p.text),
    // A letter that ended on the bare name read as cut off (2026-10-17).
    "Sincerely,",
    `${profile.firstName} ${profile.lastName}`.trim(),
  ];
}

export function documentLines(
  profile: Profile,
  request: GenerationRequest,
  narrative: Narrative,
  kind: "resume" | "cover",
): string[] {
  const header = [
    `${profile.firstName} ${profile.lastName}`.trim(),
    [profile.email, profile.phone, profile.city, profile.state]
      .filter(Boolean)
      .join(" | "),
    [profile.linkedin, profile.website].filter(Boolean).join(" | "),
    "",
  ];
  if (kind === "cover") {
    return [
      ...header,
      // A letter carries the date it was written, above the salutation.
      letterDate(profile),
      "",
      ...letterBody(profile, narrative).flatMap((line) => [line, ""]),
    ];
  }
  const histories = (rows: Profile["work"], label: string) =>
    rows.length
      ? [
          "",
          label,
          ...rows.flatMap((row) =>
            [
              `${row.title} — ${row.organization}`,
              // Documents show month and year; a day is only for forms.
              [
                row.startDate.slice(0, 7),
                row.endDate.slice(0, 7) || "Present",
                row.location,
              ]
                .filter(Boolean)
                .join(" | "),
              row.details,
            ].filter(Boolean),
          ),
        ]
      : [];
  return [
    ...header,
    `Selected experience for ${request.title || "this opportunity"}`,
    "",
    ...narrative.resume.map((fact) => fact.text),
    ...histories(profile.work, "Experience"),
    ...histories(profile.education, "Education"),
  ];
}

async function pdfBytes(
  lines: string[],
  fontPath?: string,
  paper: "letter" | "a4" = "letter",
): Promise<Uint8Array> {
  // US Letter (612 x 792 points) or A4 (595.28 x 841.89), by the profile.
  const paperPoints: [number, number] = paper === "a4" ? [595.28, 841.89] : [612, 792];
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  let bytes: Buffer | undefined;
  for (const path of [
    fontPath,
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/Library/Fonts/Arial.ttf",
    "C:/Windows/Fonts/arial.ttf",
  ].filter(Boolean) as string[]) {
    try {
      bytes = await readFile(path);
      break;
    } catch {
      /* Try the next installed font. */
    }
  }
  const font = bytes
    ? await pdf.embedFont(bytes, { subset: true })
    : await pdf.embedFont(StandardFonts.Helvetica);
  const glyphs = new Set(bytes ? font.getCharacterSet() : []);
  let page = pdf.addPage(paperPoints);
  let y = paperPoints[1] - 51;
  const line = (text: string, size: number) => {
    if (y < 52) {
      page = pdf.addPage(paperPoints);
      y = paperPoints[1] - 51;
    }
    try {
      page.drawText(text, {
        x: 48,
        y,
        size,
        font,
        color: rgb(0.12, 0.17, 0.22),
      });
    } catch {
      throw new Error(
        "PDF font cannot represent your text. Set fontPath in local config to a suitable TTF font.",
      );
    }
    y -= size * 1.55;
  };
  for (let i = 0; i < lines.length; i++) {
    const size = i === 0 ? 19 : 10;
    // ATS posting text often carries invisible bidi/format controls. These
    // have no printable glyph and crash Helvetica's width calculation on
    // systems without a Unicode font (including some HPC clusters). Keep visible Unicode.
    // When no Unicode font is installed, keep these mathematical facts in
    // their plain-text spelling, as the LaTeX builder already does. A Unicode
    // font still receives the original glyphs; other unsupported text retains
    // the existing font error instead of being silently discarded.
    // An installed font can lack them as well (Arial has no ∼), and would
    // draw an empty box: each is spelled out unless the font has its glyph.
    const printable = pdfPrintableText(lines[i]).replace(/[∼≈≥≤]/gu, (sign) =>
      glyphs.has(sign.codePointAt(0)!) ? sign : sign === "≥" ? ">=" : sign === "≤" ? "<=" : "~");
    for (const paragraph of printable.split("\n")) {
      let current = "";
      for (const word of paragraph.split(/\s+/)) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) > 510 && current) {
          line(current, size);
          current = word;
        } else current = candidate;
      }
      line(current, size);
    }
    y -= 4;
  }
  return pdf.save();
}

export const pdfPrintableText = (text: string) => text.replace(/[\u200B\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");

export async function renderArtifacts(
  directory: string,
  profile: Profile,
  request: GenerationRequest,
  narrative: Narrative,
  options: {
    fontPath?: string;
    resumeLatexDir?: string;
    // PDFs built by the job-applier checkout (job-apply.ts), which take the
    // place of both the laid-out ones and resumeLatexDir.
    tailored?: {
      resume?: { name: string; data: Uint8Array };
      cover?: { name: string; data: Uint8Array };
    };
  } = {},
): Promise<{ artifacts: Artifact[]; warnings: string[] }> {
  const { fontPath, resumeLatexDir, tailored } = options;
  const artifacts: Artifact[] = [];
  const warnings: string[] = [];
  // The applicant's own LaTeX resume, when they have one. A failure here is
  // reported and falls back to the laid-out version rather than failing the
  // application: a plain resume beats no resume.
  const latex = tailored?.resume
    ? { ...tailored.resume, source: tailored.resume.name }
    : resumeLatexDir
      ? await latexResume(resumeLatexDir, request).catch((error: Error) => {
          warnings.push(
            `Your LaTeX resume could not be built, so a plain one was used instead. ${error.message}`.slice(
              0,
              350,
            ),
          );
          return undefined;
        })
      : undefined;
  // A form with no cover letter field gets no letter (wantsLetter).
  for (const kind of narrative.coverLetter.length ? (["resume", "cover"] as const) : (["resume"] as const)) {
    const lines = documentLines(profile, request, narrative, kind);
    for (const format of ["pdf", "docx"] as const) {
      const id = randomUUID();
      const document = new Document({
        sections: [
          {
            children: lines.map(
              (line, index) =>
                new Paragraph({
                  heading: index === 0 ? HeadingLevel.TITLE : undefined,
                  spacing: { after: 140 },
                  children: [
                    new TextRun({
                      text: line,
                      font: "Arial",
                      size: index === 0 ? 36 : 22,
                    }),
                  ],
                }),
            ),
          },
        ],
      });
      const fromLatex =
        format !== "pdf"
          ? undefined
          : kind === "resume"
            ? latex
            : tailored?.cover;
      const data = fromLatex
        ? fromLatex.data
        : kind === "resume"
          ? // The built-in resume layout, when no LaTeX resume took its place.
            format === "pdf"
            ? await resumePdf(profile, narrative, { fontPath, pageSize: paperSize(profile) === "a4" ? [595.28, 841.89] : [612, 792] })
            : await resumeDocx(profile, narrative)
          : format === "pdf"
            ? await pdfBytes(lines, fontPath, paperSize(profile))
            : await Packer.toBuffer(document);
      const name =
        fromLatex?.name ||
        `${profile.lastName || "Applicant"}-${kind}-${request.title || "application"}`
          .replace(/[^a-zA-Z0-9_-]/g, "-")
          .slice(0, 100) + `.${format}`;
      await writeFile(join(directory, "artifacts", `${id}.${format}`), data, {
        mode: 0o600,
      });
      artifacts.push({
        id,
        kind,
        format,
        name,
        applicationId: request.applicationId,
        operation: request.operation,
        mime:
          format === "pdf"
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
    }
  }
  return { artifacts, warnings };
}
