// The look of the side panel, the dashboard and the command line's
// full-screen view, as named themes of semantic colours. scripts/build.mjs
// writes them out as CSS custom properties (themes.css), so a page draws in
// its theme from the first frame; scripts/lane-view.ts maps the same colours
// to the terminal. The applicant picks one in Settings → Appearance; "system"
// follows the operating system between Sage (light) and Midnight (dark).
//
// Every text colour is chosen to read at WCAG AA (4.5:1) on the surfaces it
// is drawn on; tests/theme.test.ts holds each theme to it.

export type Stage = "applying" | "review" | "submitted" | "blocked" | "abandoned";

export type ThemeTokens = {
  scheme: "light" | "dark";
  // Surfaces, from the page behind everything to a raised card or menu.
  bg: string;
  surface: string;
  surface2: string;
  elevated: string;
  // Text on those surfaces, and on the accent colour.
  text: string;
  textMuted: string;
  textInverse: string;
  border: string;
  borderStrong: string;
  // The theme's own colour: primary buttons, selected tabs, links.
  accent: string;
  accentStrong: string;
  accentSoft: string;
  // States.
  success: string;
  warning: string;
  danger: string;
  info: string;
  // One colour to an application's workflow stage (pills, row badges).
  stage: Record<Stage, string>;
  // The fill animation's two colours and its glow.
  progressA: string;
  progressB: string;
  glow: string;
  // The brand mark's gradient.
  brandA: string;
  brandB: string;
  radius: { sm: string; md: string; lg: string; xl: string };
  shadow: { sm: string; md: string; lg: string };
  focus: string;
  backdrop: string;
};

export type ThemeName = "sage" | "midnight" | "ember" | "aurora" | "velocity" | "contrast";
export type ThemeChoice = ThemeName | "system";

const radius = { sm: "6px", md: "10px", lg: "14px", xl: "20px" };

export const themes: Record<ThemeName, ThemeTokens> = {
  // Today's green and cream, refined: the default light look.
  sage: {
    scheme: "light",
    bg: "#f5f6f1",
    surface: "#ffffff",
    surface2: "#eef2ea",
    elevated: "#ffffff",
    text: "#1b342c",
    textMuted: "#5a6a60",
    textInverse: "#ffffff",
    border: "#e0e6da",
    borderStrong: "#c6d1be",
    accent: "#2d6a50",
    accentStrong: "#1f4f3b",
    accentSoft: "#e3eee2",
    success: "#2b7449",
    warning: "#8c5a0b",
    danger: "#b0372b",
    info: "#2b6391",
    stage: { applying: "#2b6391", review: "#8c5a0b", submitted: "#2b7449", blocked: "#b0372b", abandoned: "#5f6670" },
    progressA: "#2d8a62",
    progressB: "#7cc29a",
    glow: "rgba(45, 138, 98, 0.35)",
    brandA: "#2d6a50",
    brandB: "#5fa47f",
    radius,
    shadow: {
      sm: "0 1px 2px rgba(27, 52, 44, 0.06)",
      md: "0 1px 2px rgba(27, 52, 44, 0.05), 0 6px 18px rgba(27, 52, 44, 0.07)",
      lg: "0 24px 64px rgba(18, 40, 28, 0.2)",
    },
    focus: "#3f8a68",
    backdrop: "rgba(16, 34, 26, 0.45)",
  },
  // Deep navy with cyan and violet: the default dark look.
  midnight: {
    scheme: "dark",
    bg: "#0a1020",
    surface: "#111a2e",
    surface2: "#17223b",
    elevated: "#1a2744",
    text: "#e7edf8",
    textMuted: "#9eacc5",
    textInverse: "#04111f",
    border: "#223152",
    borderStrong: "#33466f",
    accent: "#3cc4f5",
    accentStrong: "#86dcfb",
    accentSoft: "#11304a",
    success: "#4fd690",
    warning: "#f5c04a",
    danger: "#ff7b7b",
    info: "#7fb2ff",
    stage: { applying: "#3cc4f5", review: "#f5c04a", submitted: "#4fd690", blocked: "#ff7b7b", abandoned: "#98a5bb" },
    progressA: "#22d3ee",
    progressB: "#a78bfa",
    glow: "rgba(34, 211, 238, 0.45)",
    brandA: "#22d3ee",
    brandB: "#8b5cf6",
    radius,
    shadow: {
      sm: "0 1px 2px rgba(0, 0, 0, 0.35)",
      md: "0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.35)",
      lg: "0 28px 70px rgba(0, 0, 0, 0.6)",
    },
    focus: "#5fd4fb",
    backdrop: "rgba(2, 6, 16, 0.7)",
  },
  // Warm dark: charcoal and embers.
  ember: {
    scheme: "dark",
    bg: "#16100d",
    surface: "#201814",
    surface2: "#2a201a",
    elevated: "#30241d",
    text: "#f6ebe1",
    textMuted: "#c0aa98",
    textInverse: "#1c0f06",
    border: "#3b2c23",
    borderStrong: "#55402f",
    accent: "#fb923c",
    accentStrong: "#fdba74",
    accentSoft: "#3a2416",
    success: "#a6d97a",
    warning: "#fcd34d",
    danger: "#ff8a7a",
    info: "#86c8ea",
    stage: { applying: "#fb923c", review: "#fcd34d", submitted: "#a6d97a", blocked: "#ff8a7a", abandoned: "#ada39b" },
    progressA: "#f97316",
    progressB: "#facc15",
    glow: "rgba(249, 115, 22, 0.45)",
    brandA: "#f97316",
    brandB: "#e7443b",
    radius,
    shadow: {
      sm: "0 1px 2px rgba(0, 0, 0, 0.4)",
      md: "0 1px 2px rgba(0, 0, 0, 0.35), 0 8px 24px rgba(0, 0, 0, 0.4)",
      lg: "0 28px 70px rgba(0, 0, 0, 0.6)",
    },
    focus: "#fdba74",
    backdrop: "rgba(10, 5, 2, 0.7)",
  },
  // Light with vivid violet-to-pink accents.
  aurora: {
    scheme: "light",
    bg: "#f6f5fc",
    surface: "#ffffff",
    surface2: "#f0eefa",
    elevated: "#ffffff",
    text: "#1d1a38",
    textMuted: "#5c5878",
    textInverse: "#ffffff",
    border: "#e4e1f3",
    borderStrong: "#cdc8e8",
    accent: "#6a2bd6",
    accentStrong: "#5420b0",
    accentSoft: "#efe8fd",
    success: "#047a58",
    warning: "#9a5b06",
    danger: "#c0153f",
    info: "#0a679e",
    stage: { applying: "#6a2bd6", review: "#9a5b06", submitted: "#047a58", blocked: "#c0153f", abandoned: "#5f6779" },
    progressA: "#8b5cf6",
    progressB: "#ec4899",
    glow: "rgba(139, 92, 246, 0.4)",
    brandA: "#7c3aed",
    brandB: "#ec4899",
    radius,
    shadow: {
      sm: "0 1px 2px rgba(40, 24, 90, 0.06)",
      md: "0 1px 2px rgba(40, 24, 90, 0.05), 0 8px 22px rgba(60, 30, 140, 0.09)",
      lg: "0 28px 70px rgba(40, 20, 100, 0.22)",
    },
    focus: "#8b5cf6",
    backdrop: "rgba(24, 14, 60, 0.45)",
  },
  // Electric blue and racing red on near-black: the fill animation's own.
  velocity: {
    scheme: "dark",
    bg: "#06080f",
    surface: "#0d1220",
    surface2: "#131a2d",
    elevated: "#18213a",
    text: "#eef2ff",
    textMuted: "#a0aac8",
    textInverse: "#050914",
    border: "#1f2943",
    borderStrong: "#31406a",
    accent: "#4d94ff",
    accentStrong: "#8cb9ff",
    accentSoft: "#10254a",
    success: "#3ddc97",
    warning: "#ffc23d",
    danger: "#ff4d63",
    info: "#4d94ff",
    stage: { applying: "#4d94ff", review: "#ffc23d", submitted: "#3ddc97", blocked: "#ff5a6e", abandoned: "#9aa3b8" },
    progressA: "#2f7bff",
    progressB: "#ff2e4d",
    glow: "rgba(47, 123, 255, 0.6)",
    brandA: "#2f7bff",
    brandB: "#ff2e4d",
    radius,
    shadow: {
      sm: "0 1px 2px rgba(0, 0, 0, 0.45)",
      md: "0 1px 2px rgba(0, 0, 0, 0.4), 0 10px 28px rgba(0, 0, 0, 0.45)",
      lg: "0 30px 80px rgba(0, 0, 0, 0.7)",
    },
    focus: "#6aa6ff",
    backdrop: "rgba(0, 2, 10, 0.72)",
  },
  // Black and white with yellow: the most legible.
  contrast: {
    scheme: "dark",
    bg: "#000000",
    surface: "#0b0b0b",
    surface2: "#161616",
    elevated: "#1c1c1c",
    text: "#ffffff",
    textMuted: "#e2e2e2",
    textInverse: "#000000",
    border: "#8a8a8a",
    borderStrong: "#ffffff",
    accent: "#ffd60a",
    accentStrong: "#fff06b",
    accentSoft: "#2b2500",
    success: "#4dff88",
    warning: "#ffd60a",
    danger: "#ff7070",
    info: "#70d0ff",
    stage: { applying: "#70d0ff", review: "#ffd60a", submitted: "#4dff88", blocked: "#ff7070", abandoned: "#d0d0d0" },
    progressA: "#ffd60a",
    progressB: "#00e5ff",
    glow: "rgba(255, 214, 10, 0.5)",
    brandA: "#ffd60a",
    brandB: "#00e5ff",
    radius: { sm: "3px", md: "5px", lg: "7px", xl: "10px" },
    shadow: { sm: "none", md: "none", lg: "0 0 0 2px #ffffff" },
    focus: "#ffd60a",
    backdrop: "rgba(0, 0, 0, 0.85)",
  },
};

export const themeChoices: { id: ThemeChoice; name: string; note: string }[] = [
  { id: "system", name: "System", note: "Sage or Midnight, as your computer is set" },
  { id: "sage", name: "Sage", note: "Calm green on cream" },
  { id: "midnight", name: "Midnight", note: "Deep navy, cyan and violet" },
  { id: "ember", name: "Ember", note: "Warm charcoal and orange" },
  { id: "aurora", name: "Aurora", note: "Bright, violet to pink" },
  { id: "velocity", name: "Velocity", note: "Electric blue and racing red" },
  { id: "contrast", name: "High contrast", note: "Black, white and yellow" },
];

export const isThemeChoice = (value: unknown): value is ThemeChoice =>
  typeof value === "string" && themeChoices.some((choice) => choice.id === value);

// The theme a choice draws in, given whether the system is dark.
export const resolveTheme = (choice: ThemeChoice, dark: boolean): ThemeName =>
  choice === "system" ? (dark ? "midnight" : "sage") : choice;

// The custom properties a theme sets, as CSS declarations.
export function themeDeclarations(theme: ThemeTokens): string {
  const values: Record<string, string> = {
    "color-scheme": theme.scheme,
    "--bg": theme.bg,
    "--surface": theme.surface,
    "--surface-2": theme.surface2,
    "--elevated": theme.elevated,
    "--text": theme.text,
    "--text-muted": theme.textMuted,
    "--text-inverse": theme.textInverse,
    "--border": theme.border,
    "--border-strong": theme.borderStrong,
    "--accent": theme.accent,
    "--accent-strong": theme.accentStrong,
    "--accent-soft": theme.accentSoft,
    "--success": theme.success,
    "--warning": theme.warning,
    "--danger": theme.danger,
    "--info": theme.info,
    ...Object.fromEntries(Object.entries(theme.stage).map(([stage, color]) => [`--stage-${stage}`, color])),
    "--progress-a": theme.progressA,
    "--progress-b": theme.progressB,
    "--progress-glow": theme.glow,
    "--brand-a": theme.brandA,
    "--brand-b": theme.brandB,
    "--radius-sm": theme.radius.sm,
    "--radius-md": theme.radius.md,
    "--radius-lg": theme.radius.lg,
    "--radius-xl": theme.radius.xl,
    "--shadow-sm": theme.shadow.sm,
    "--shadow-md": theme.shadow.md,
    "--shadow-lg": theme.shadow.lg,
    "--focus-ring": theme.focus,
    "--backdrop": theme.backdrop,
  };
  return Object.entries(values)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
}

// themes.css: each theme by name, Sage when none is set, and Midnight for
// "system" (or none) on a dark system.
export function themeStylesheet(): string {
  const blocks = [
    "/* Generated by scripts/build.mjs from src/shared/theme.ts. */",
    `:root,\n:root[data-theme="system"] {\n${themeDeclarations(themes.sage)}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme]),\n  :root[data-theme="system"] {\n${themeDeclarations(themes.midnight).replace(/^/gm, "  ")}\n  }\n}`,
    ...(Object.keys(themes) as ThemeName[]).map((name) => `:root[data-theme="${name}"] {\n${themeDeclarations(themes[name])}\n}`),
  ];
  return `${blocks.join("\n")}\n`;
}

// WCAG relative luminance and contrast, for the tests and the terminal.
export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as [number, number, number];
}
const luminance = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}
