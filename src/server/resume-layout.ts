// The built-in resume: what an applicant gets when they have no LaTeX resume
// of their own. One column of real text (applicant tracking systems read it
// back), a name header, and the usual sections in the usual order. It tries
// to fit one page by tightening type and spacing a step at a time, and only
// then runs onto a second page; it never leaves anything out.
import { readFile } from "node:fs/promises";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import {
  AlignmentType,
  BorderStyle,
  Document,
  LevelFormat,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
} from "docx";
import { pdfPrintableText } from "./documents";
import type { Narrative, Profile } from "../shared/model";

export type PageSize = [width: number, height: number];
export const US_LETTER: PageSize = [612, 792];

type Entry = {
  title: string;
  // Shown after the title in regular weight: the employer or school.
  organization: string;
  location: string;
  dates: string;
  bullets: string[];
};
type Section =
  | { title: string; kind: "bullets"; bullets: string[] }
  | { title: string; kind: "entries"; entries: Entry[] }
  | { title: string; kind: "text"; text: string };
export type ResumeModel = {
  name: string;
  contact: string[];
  links: string[];
  sections: Section[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2022-01" or "" read "Jan 2022"; a bare year stays a year, and
// anything else is shown as the applicant wrote it.
export function resumeDate(value: string): string {
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})/.exec(text);
  if (iso && Number(iso[2]) >= 1 && Number(iso[2]) <= 12) return `${MONTHS[Number(iso[2]) - 1]} ${iso[1]}`;
  return text;
}

export function dateRange(start: string, end: string): string {
  const from = resumeDate(start);
  const to = resumeDate(end);
  if (!from && !to) return "";
  if (!from) return to;
  return `${from} – ${to || "Present"}`;
}

// A details box written as lines, "- " or "• " items, or one paragraph.
export function detailBullets(details: string): string[] {
  return details
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-•*–·▪◦]\s*)+/u, "").trim())
    .filter(Boolean);
}

const shortLink = (link: string) => link.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");

export function resumeModel(profile: Profile, narrative: Narrative): ResumeModel {
  const sections: Section[] = [];
  const highlights = narrative.resume.flatMap((fact) => detailBullets(fact.text));
  if (highlights.length) sections.push({ title: "Highlights", kind: "bullets", bullets: highlights });
  const work = profile.work.map((row) => ({
    title: row.title.trim(),
    organization: row.organization.trim(),
    location: row.location.trim(),
    dates: dateRange(row.startDate, row.endDate),
    bullets: detailBullets(row.details),
  }));
  if (work.length) sections.push({ title: "Experience", kind: "entries", entries: work });
  const education = profile.education.map((row) => {
    const field = row.fieldOfStudy?.trim() || "";
    const degree = row.title.trim();
    return {
      // "B.S." and "Computer Science" read "B.S., Computer Science", unless
      // the degree already names the field.
      title: field && !degree.toLowerCase().includes(field.toLowerCase()) ? [degree, field].filter(Boolean).join(", ") : degree || field,
      organization: row.organization.trim(),
      location: row.location.trim(),
      dates: dateRange(row.startDate, row.endDate),
      bullets: detailBullets(row.details),
    };
  });
  if (education.length) sections.push({ title: "Education", kind: "entries", entries: education });
  const skills = profile.skills.map((s) => s.trim()).filter(Boolean);
  if (skills.length) sections.push({ title: "Skills", kind: "text", text: skills.join(", ") });
  const languages = (profile.languages || []).map((s) => s.trim()).filter(Boolean);
  if (languages.length) sections.push({ title: "Languages", kind: "text", text: languages.join(" · ") });
  return {
    name: `${profile.firstName} ${profile.lastName}`.trim(),
    contact: [profile.email, profile.phone, [profile.city, profile.state].filter(Boolean).join(", ")]
      .map((s) => s.trim())
      .filter(Boolean),
    links: [profile.linkedin, profile.website, profile.github || ""].map(shortLink).filter(Boolean),
    sections,
  };
}

// ---------------------------------------------------------------- PDF

type Fonts = { regular: PDFFont; bold: PDFFont; printable: (text: string) => string };

// The same fonts the plain documents use, each with its bold face beside it.
// A Unicode font without a bold file is used for both weights: Helvetica-Bold
// next to it would fail on any letter Helvetica lacks.
async function loadFonts(pdf: PDFDocument, fontPath?: string): Promise<Fonts> {
  pdf.registerFontkit(fontkit);
  const boldBeside = (path: string) => [
    path.replace(/\.ttf$/i, "-Bold.ttf"),
    path.replace(/\.ttf$/i, " Bold.ttf"),
    path.replace(/\.ttf$/i, "bd.ttf"),
  ];
  const candidates: [string, string[]][] = [
    ...(fontPath ? [[fontPath, boldBeside(fontPath)] as [string, string[]]] : []),
    ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]],
    ["/Library/Fonts/Arial.ttf", ["/Library/Fonts/Arial Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"]],
    ["/System/Library/Fonts/Supplemental/Arial.ttf", ["/System/Library/Fonts/Supplemental/Arial Bold.ttf"]],
    ["C:/Windows/Fonts/arial.ttf", ["C:/Windows/Fonts/arialbd.ttf"]],
  ];
  const tryRead = async (path: string) => readFile(path).catch(() => undefined);
  for (const [regularPath, boldPaths] of candidates) {
    const regularBytes = await tryRead(regularPath);
    if (!regularBytes) continue;
    let boldBytes: Buffer | undefined;
    for (const path of boldPaths) if ((boldBytes = await tryRead(path))) break;
    const regular = await pdf.embedFont(regularBytes, { subset: true });
    const bold = boldBytes ? await pdf.embedFont(boldBytes, { subset: true }) : regular;
    const glyphs = new Set([...regular.getCharacterSet()].filter((c) => bold.getCharacterSet().includes(c)));
    return { regular, bold, printable: printableFor(glyphs) };
  }
  return {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    printable: printableFor(new Set()),
  };
}

// Invisible bidi controls go; ∼ ≈ ≥ ≤ are spelled out where the font has no
// glyph for them, as the plain documents and the LaTeX builder do.
const printableFor = (glyphs: Set<number>) => (text: string) =>
  pdfPrintableText(text).replace(/[∼≈≥≤]/gu, (sign) =>
    glyphs.has(sign.codePointAt(0)!) ? sign : sign === "≥" ? ">=" : sign === "≤" ? "<=" : "~",
  );

const FONT_ERROR = "PDF font cannot represent your text. Set fontPath in local config to a suitable TTF font.";

// Each step is a little tighter than the one before. The first that fits one
// page is used; when none does, the last runs onto more pages.
const STEPS = [
  { body: 10.5, lead: 1.34, gap: 1, margin: 50 },
  { body: 10, lead: 1.3, gap: 0.85, margin: 47 },
  { body: 9.5, lead: 1.26, gap: 0.7, margin: 43 },
];

const INK = rgb(0.11, 0.12, 0.14);
const ACCENT = rgb(0.13, 0.23, 0.37);
const MUTED = rgb(0.36, 0.38, 0.42);
const RULE = rgb(0.62, 0.66, 0.72);

type Op =
  | { kind: "text"; page: number; x: number; y: number; text: string; font: PDFFont; size: number; color: RGB }
  | { kind: "rule"; page: number; x: number; y: number; width: number };

function layout(model: ResumeModel, fonts: Fonts, size: PageSize, step: (typeof STEPS)[number]): { ops: Op[]; pages: number } {
  const [pageWidth, pageHeight] = size;
  const { body, lead, gap, margin } = step;
  const left = margin;
  const right = pageWidth - margin;
  const width = right - left;
  const top = pageHeight - margin;
  const bottom = margin;
  const ops: Op[] = [];
  let page = 0;
  let y = top;
  const measure = (text: string, font: PDFFont, at: number) => {
    try {
      return font.widthOfTextAtSize(text, at);
    } catch {
      throw new Error(FONT_ERROR);
    }
  };
  const wrap = (text: string, font: PDFFont, at: number, room: number) => {
    const lines: string[] = [];
    let current = "";
    for (let word of text.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate, font, at) <= room) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      // A word wider than the line (a long link) is broken, never cut.
      while (measure(word, font, at) > room && [...word].length > 1) {
        const chars = [...word];
        let n = chars.length - 1;
        while (n > 1 && measure(chars.slice(0, n).join(""), font, at) > room) n--;
        lines.push(chars.slice(0, n).join(""));
        word = chars.slice(n).join("");
      }
      current = word;
    }
    if (current) lines.push(current);
    return lines;
  };
  const room = (height: number) => {
    if (y - height < bottom && y < top) {
      page++;
      y = top;
    }
  };
  const text = (value: string, x: number, font: PDFFont, at: number, color: RGB) =>
    ops.push({ kind: "text", page, x, y, text: value, font, size: at, color });
  const lineHeight = body * lead;

  // Header: name, contact line, links line, centred.
  const centred = (value: string, font: PDFFont, at: number, color: RGB) =>
    wrap(value, font, at, width).forEach((line, index) => {
      if (index) y -= at * 1.3;
      text(line, left + (width - measure(line, font, at)) / 2, font, at, color);
    });
  const printable = fonts.printable;
  if (model.name) {
    const nameSize = body * 2.15;
    y -= nameSize * 0.8;
    centred(printable(model.name), fonts.bold, nameSize, INK);
    y -= nameSize * 0.55;
  }
  for (const line of [model.contact, model.links]) {
    if (!line.length) continue;
    const at = body * 0.95;
    y -= at * 1.25;
    centred(printable(line.join("  |  ")), fonts.regular, at, MUTED);
  }

  const bullets = (items: string[], indent = 0) => {
    const at = body;
    const textX = left + indent + 13;
    for (const item of items) {
      const lines = wrap(printable(item), fonts.regular, at, right - textX);
      lines.forEach((line, index) => {
        room(lineHeight);
        y -= lineHeight;
        if (!index) text("•", left + indent + 3, fonts.regular, at, INK);
        text(line, textX, fonts.regular, at, INK);
      });
    }
  };

  for (const section of model.sections) {
    const headingSize = body * 1.02;
    // A heading is kept with the first line under it.
    room(headingSize + 9 * gap + 8 + lineHeight * 2);
    y -= (y === top ? 0 : 11 * gap) + headingSize;
    // Letter-spaced headings read back "H I G H L I G H T S" in applicant
    // tracking systems, so the heading is plain uppercase.
    text(printable(section.title.toUpperCase()), left, fonts.bold, headingSize, ACCENT);
    y -= 3.5;
    ops.push({ kind: "rule", page, x: left, y, width });
    y -= 2.5 * gap;

    if (section.kind === "bullets") bullets(section.bullets);
    else if (section.kind === "text") {
      for (const line of wrap(printable(section.text), fonts.regular, body, width)) {
        room(lineHeight);
        y -= lineHeight;
        text(line, left, fonts.regular, body, INK);
      }
    } else
      section.entries.forEach((entry, index) => {
        const dates = printable(entry.dates);
        const datesWidth = dates ? measure(dates, fonts.regular, body) + 12 : 0;
        // Title in bold, then employer and place, wrapped clear of the dates.
        const words: { text: string; font: PDFFont; color: RGB }[] = [];
        // A "·" separator stays with the word after it, never ending a line.
        const push = (value: string, font: PDFFont, color: RGB, separated = false) =>
          printable(value)
            .split(/\s+/)
            .filter(Boolean)
            .forEach((word, i) => words.push({ text: separated && !i ? `· ${word}` : word, font, color }));
        push(entry.title, fonts.bold, INK);
        if (entry.organization) push(entry.organization, fonts.regular, INK, Boolean(entry.title));
        if (entry.location) push(entry.location, fonts.regular, MUTED, Boolean(entry.title || entry.organization));
        const rows: (typeof words)[] = [[]];
        let used = 0;
        for (const word of words) {
          const spaceWidth = rows[rows.length - 1].length ? measure(" ", word.font, body) : 0;
          const w = measure(word.text, word.font, body);
          const limit = rows.length === 1 ? width - datesWidth : width;
          if (rows[rows.length - 1].length && used + spaceWidth + w > limit) {
            rows.push([word]);
            used = w;
          } else {
            rows[rows.length - 1].push(word);
            used += spaceWidth + w;
          }
        }
        room(lineHeight * (rows.length + Math.min(1, entry.bullets.length)) + 4 * gap);
        if (index) y -= 5 * gap;
        rows.forEach((row, rowIndex) => {
          room(lineHeight);
          y -= lineHeight;
          let x = left;
          row.forEach((word, i) => {
            if (i) x += measure(" ", word.font, body);
            text(word.text, x, word.font, body, word.color);
            x += measure(word.text, word.font, body);
          });
          if (!rowIndex && dates) text(dates, right - measure(dates, fonts.regular, body), fonts.regular, body, INK);
        });
        bullets(entry.bullets, 2);
      });
  }
  return { ops, pages: page + 1 };
}

export async function resumePdf(
  profile: Profile,
  narrative: Narrative,
  options: { fontPath?: string; pageSize?: PageSize } = {},
): Promise<Uint8Array> {
  const size = options.pageSize || US_LETTER;
  const pdf = await PDFDocument.create();
  const fonts = await loadFonts(pdf, options.fontPath);
  const model = resumeModel(profile, narrative);
  let result = layout(model, fonts, size, STEPS[0]);
  for (const step of STEPS.slice(1)) {
    if (result.pages === 1) break;
    result = layout(model, fonts, size, step);
  }
  const pages: PDFPage[] = Array.from({ length: result.pages }, () => pdf.addPage(size));
  for (const op of result.ops) {
    const page = pages[op.page];
    if (op.kind === "rule") {
      page.drawLine({ start: { x: op.x, y: op.y }, end: { x: op.x + op.width, y: op.y }, thickness: 0.6, color: RULE });
      continue;
    }
    try {
      page.drawText(op.text, { x: op.x, y: op.y, size: op.size, font: op.font, color: op.color });
    } catch {
      throw new Error(FONT_ERROR);
    }
  }
  pdf.setTitle(model.name ? `${model.name} — Resume` : "Resume");
  if (model.name) pdf.setAuthor(model.name);
  return pdf.save();
}

// ---------------------------------------------------------------- DOCX

const twips = (points: number) => Math.round(points * 20);

export async function resumeDocx(
  profile: Profile,
  narrative: Narrative,
  options: { pageSize?: PageSize } = {},
): Promise<Buffer> {
  const [pageWidth, pageHeight] = options.pageSize || US_LETTER;
  const margin = 50;
  const contentWidth = twips(pageWidth - 2 * margin);
  const model = resumeModel(profile, narrative);
  const font = "Arial";
  const run = (text: string, extra: { bold?: boolean; size?: number; color?: string } = {}) =>
    new TextRun({ text, font, size: extra.size ?? 21, bold: extra.bold, color: extra.color });
  const bullet = (text: string) =>
    new Paragraph({ numbering: { reference: "resume-bullets", level: 0 }, spacing: { after: 30 }, children: [run(text)] });
  const children: Paragraph[] = [];
  if (model.name)
    children.push(
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [run(model.name, { bold: true, size: 44 })] }),
    );
  for (const line of [model.contact, model.links])
    if (line.length)
      children.push(
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 20 }, children: [run(line.join("  |  "), { size: 20, color: "5C6169" })] }),
      );
  for (const section of model.sections) {
    children.push(
      new Paragraph({
        spacing: { before: 220, after: 80 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "9EA8B8", space: 2 } },
        children: [new TextRun({ text: section.title.toUpperCase(), font, size: 21, bold: true, color: "213B5E" })],
      }),
    );
    if (section.kind === "bullets") section.bullets.forEach((b) => children.push(bullet(b)));
    else if (section.kind === "text") children.push(new Paragraph({ children: [run(section.text)] }));
    else
      section.entries.forEach((entry, index) => {
        const parts = [run(entry.title, { bold: true })];
        if (entry.organization) parts.push(run(entry.title ? ` · ${entry.organization}` : entry.organization));
        if (entry.location) parts.push(run(`${entry.title || entry.organization ? " · " : ""}${entry.location}`, { color: "5C6169" }));
        if (entry.dates) parts.push(new TextRun({ text: `\t${entry.dates}`, font, size: 21 }));
        children.push(
          new Paragraph({
            spacing: { before: index ? 120 : 0, after: 30 },
            tabStops: [{ type: TabStopType.RIGHT, position: contentWidth }],
            keepNext: true,
            children: parts,
          }),
        );
        entry.bullets.forEach((b) => children.push(bullet(b)));
      });
  }
  const document = new Document({
    creator: model.name || "Applicant",
    title: model.name ? `${model.name} — Resume` : "Resume",
    numbering: {
      config: [
        {
          reference: "resume-bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 300, hanging: 220 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: twips(pageWidth), height: twips(pageHeight) },
            margin: { top: twips(margin), bottom: twips(margin), left: twips(margin), right: twips(margin) },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}
