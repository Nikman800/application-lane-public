import { themes, type ThemeName, type ThemeTokens } from "../src/shared/theme";

// Pieces of the full-screen view (lane.ts ui) that depend only on the width
// they are drawn in. A line wider than the pane wraps, and the extra lines
// scroll the top of the screen away: in a half-width Zellij pane the title
// and the first tabs were gone, leaving "l (37)  find jobs (100)".

// The tabs that fit in width, always including the selected one; "‹" and
// "›" say more are off to either side. The selected tab is shown inverted.
export function tabStrip(
  labels: string[],
  selected: number,
  width: number,
  paint: { selected?: (label: string, index: number) => string; other?: (label: string, index: number) => string } = {},
): string {
  let first = 0;
  let last = labels.length - 1;
  const length = (from: number, to: number) =>
    labels.slice(from, to + 1).join(" ").length + (from > 0 ? 2 : 0) + (to < labels.length - 1 ? 2 : 0);
  // Drop a tab from whichever side is further from the selected one.
  while (length(first, last) > width && first < last) {
    if (selected - first > last - selected) first++;
    else last--;
  }
  const shown = labels
    .slice(first, last + 1)
    .map((label, index) =>
      first + index === selected
        ? paint.selected
          ? paint.selected(label, first + index)
          : `\x1b[7m${label}\x1b[0m`
        : paint.other
          ? paint.other(label, first + index)
          : label,
    )
    .join(" ");
  // Even the selected tab alone may not fit a very narrow pane.
  if (length(first, last) > width) return `\x1b[7m${labels[selected].slice(0, Math.max(1, width - 1))}…\x1b[0m`;
  return `${first > 0 ? "‹ " : ""}${shown}${last < labels.length - 1 ? " ›" : ""}`;
}

// Plain text cut to the width, with a style around what is kept.
export function styled(text: string, width: number, style: string): string {
  const cut = text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
  return `${style}${cut}\x1b[0m`;
}

// An opening found by a search, its tracked mark first: at the end of the
// line it was cut off in a narrow pane, and nothing showed which openings
// were already applications.
export function openingLine(
  listing: { company: string; title: string; locations: string[]; postedAt?: number; tracked?: boolean; site?: { ats?: string } },
  ago: (at: number) => string,
): string {
  // An opening on a site no rule covers, marked before it is opened
  // (site-check.ts).
  return `${listing.tracked ? "✓ tracked · " : ""}${listing.site && !listing.site.ats ? "⚠ no site rule · " : ""}${listing.company} — ${listing.title} · ${listing.locations.slice(0, 2).join("; ")}${listing.postedAt ? ` · ${ago(listing.postedAt)}` : ""}`;
}

// Colour for the command line, from the same themes as the extension
// (src/shared/theme.ts): 24-bit where the terminal says it has it
// (COLORTERM), else the 256-colour cube, else the 16 standard colours; none
// when NO_COLOR is set or the output is not a terminal (piped, tested).
// FORCE_COLOR=0..3 overrides the guess either way.
export type ColorDepth = "none" | "16" | "256" | "truecolor";

export function colorDepth(env: Record<string, string | undefined>, isTTY: boolean): ColorDepth {
  if (env.NO_COLOR) return "none";
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return "none";
    if (force === "1") return "16";
    if (force === "2") return "256";
    if (force === "3") return "truecolor";
  }
  if (!isTTY && force === undefined) return "none";
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM || "")) return "truecolor";
  if (/256/.test(env.TERM || "")) return "256";
  if (env.TERM === "dumb" && force === undefined) return "none";
  return "16";
}

const standard: [number, number, number][] = [
  [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16], [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67], [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
];
const distance = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 * 0.3 + (a[1] - b[1]) ** 2 * 0.59 + (a[2] - b[2]) ** 2 * 0.11;
const cube = [0, 95, 135, 175, 215, 255];
function to256([r, g, b]: [number, number, number]): number {
  const level = (c: number) => cube.reduce((best, value, index) => (Math.abs(value - c) < Math.abs(cube[best] - c) ? index : best), 0);
  const [ri, gi, bi] = [level(r), level(g), level(b)];
  const colour = 16 + 36 * ri + 6 * gi + bi;
  const gray = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const grayValue = 8 + gray * 10;
  return distance([r, g, b], [grayValue, grayValue, grayValue]) < distance([r, g, b], [cube[ri], cube[gi], cube[bi]]) ? 232 + gray : colour;
}
function to16(rgb: [number, number, number]): number {
  return standard.reduce((best, value, index) => (distance(rgb, value) < distance(rgb, standard[best]) ? index : best), 0);
}
const rgbOf = (hex: string): [number, number, number] => {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16)) as [number, number, number];
};

// The SGR sequence that sets a colour as foreground or background.
export function sgr(hex: string, depth: ColorDepth, layer: "fg" | "bg" = "fg"): string {
  if (depth === "none") return "";
  const rgb = rgbOf(hex);
  if (depth === "truecolor") return `\x1b[${layer === "fg" ? 38 : 48};2;${rgb.join(";")}m`;
  if (depth === "256") return `\x1b[${layer === "fg" ? 38 : 48};5;${to256(rgb)}m`;
  const index = to16(rgb);
  return `\x1b[${(layer === "fg" ? 30 : 40) + (index % 8) + (index >= 8 ? 60 : 0)}m`;
}

export type Palette = ReturnType<typeof createPalette>;

// Painting functions for one theme at one colour depth. Every function
// returns its text unchanged at depth "none".
export function createPalette(theme: ThemeTokens, depth: ColorDepth) {
  const on = depth !== "none";
  const paint = (style: string) => (text: string) => (on && style ? `${style}${text}\x1b[0m` : text);
  const fg = (hex: string) => paint(sgr(hex, depth));
  const stageOf: Record<string, string> = {
    "needs you": theme.warning,
    "being fixed": theme.info,
    "in progress": theme.stage.applying,
    failed: theme.danger,
    "ready to review": theme.stage.review,
    submitted: theme.stage.submitted,
    closed: theme.stage.abandoned,
    all: theme.accent,
    "find jobs": theme.info,
  };
  return {
    depth,
    on,
    fg,
    bold: paint("\x1b[1m"),
    dim: paint("\x1b[2m"),
    accent: fg(theme.accent),
    muted: fg(theme.textMuted),
    success: fg(theme.success),
    warning: fg(theme.warning),
    danger: fg(theme.danger),
    info: fg(theme.info),
    // A group of applications (status, the tabs), in its stage's colour.
    group: (name: string) => fg(stageOf[name] || theme.accent),
    groupColor: (name: string) => stageOf[name] || theme.accent,
    // Text with a background: a selected tab or row, the title bar.
    chip: (hex: string, text: string, ink = theme.textInverse) =>
      on ? (depth === "16" ? `\x1b[7m${sgr(hex, depth)}${text}\x1b[0m` : `${sgr(hex, depth, "bg")}${sgr(ink, depth)}\x1b[1m${text}\x1b[0m`) : text,
    selected: (text: string) =>
      on
        ? depth === "16"
          ? `\x1b[7m${text}\x1b[0m`
          : `${sgr(theme.accentSoft, depth, "bg")}${sgr(theme.accentStrong, depth)}\x1b[1m${text}\x1b[0m`
        : `\x1b[7m${text}\x1b[0m`,
    // Text shaded across two colours, a character at a time.
    gradient: (text: string, from = theme.brandA, to = theme.brandB) => {
      if (!on || depth === "16") return on ? `${sgr(from, depth)}\x1b[1m${text}\x1b[0m` : text;
      const [a, b] = [rgbOf(from), rgbOf(to)];
      const chars = [...text];
      return `\x1b[1m${chars
        .map((char, index) => {
          const t = chars.length > 1 ? index / (chars.length - 1) : 0;
          const hex = `#${a.map((c, i) => Math.round(c + (b[i] - c) * t).toString(16).padStart(2, "0")).join("")}`;
          return `${sgr(hex, depth)}${char}`;
        })
        .join("")}\x1b[0m`;
    },
    // The fill animation's chevrons "›››", one bright step moving along,
    // in the theme's two progress colours.
    chevrons: (frame: number) =>
      on
        ? [0, 1, 2]
            .map((index) => `${sgr((index + frame) % 2 ? theme.progressB : theme.progressA, depth)}${index === frame % 3 ? "\x1b[1m" : "\x1b[22m"}›`)
            .join("") + "\x1b[0m"
        : "›››",
    // A small bar of done out of total: ▰▰▱.
    meter: (done: number, total: number) => {
      const filled = Math.min(total, Math.max(0, done));
      const full = "▰".repeat(filled);
      const empty = "▱".repeat(Math.max(0, total - filled));
      return on ? `${sgr(theme.progressA, depth)}${full}${sgr(theme.textMuted, depth)}${empty}\x1b[0m` : `${full}${empty}`;
    },
  };
}

// The theme the command line draws in: --theme, else LANE_THEME, else
// Midnight ("system" too: a terminal is usually dark).
export function terminalTheme(args: string[], env: Record<string, string | undefined>): ThemeName {
  const flag = args.indexOf("--theme");
  const wanted = (flag >= 0 ? args[flag + 1] : env.LANE_THEME)?.toLowerCase();
  if (wanted && wanted in themes) return wanted as ThemeName;
  if (wanted === "high-contrast") return "contrast";
  return "midnight";
}

// Text as the terminal shows it, colour codes taken out.
export const visible = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
