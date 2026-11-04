import { test } from "node:test";
import assert from "node:assert/strict";
import { contrast, isThemeChoice, resolveTheme, themeChoices, themeStylesheet, themes, type ThemeName } from "../src/shared/theme";

// Every theme's text reads at WCAG AA on the surfaces it is drawn on: body
// text, muted text, stage pills' text, and a primary button's label.
test("each theme's text colours read at WCAG AA on its surfaces", () => {
  for (const [name, theme] of Object.entries(themes)) {
    for (const surface of [theme.bg, theme.surface, theme.surface2, theme.elevated]) {
      for (const [role, color] of [
        ["text", theme.text],
        ["text-muted", theme.textMuted],
        ["accent", theme.accent],
        ["success", theme.success],
        ["warning", theme.warning],
        ["danger", theme.danger],
        ["info", theme.info],
        ...Object.entries(theme.stage).map(([stage, value]) => [`stage-${stage}`, value]),
      ])
        assert.ok(contrast(color, surface) >= 4.5, `${name}: ${role} ${color} on ${surface} is ${contrast(color, surface).toFixed(2)}:1`);
    }
    assert.ok(contrast(theme.textInverse, theme.accent) >= 4.5, `${name}: a primary button's label is ${contrast(theme.textInverse, theme.accent).toFixed(2)}:1`);
    assert.ok(contrast(theme.textInverse, theme.accentStrong) >= 4.5, `${name}: a hovered primary button's label`);
    assert.ok(contrast(theme.accent, theme.accentSoft) >= 4.5, `${name}: accent text on its soft background is ${contrast(theme.accent, theme.accentSoft).toFixed(2)}:1`);
  }
});

test("the stylesheet sets every theme by name, Sage by default and Midnight on a dark system", () => {
  const css = themeStylesheet();
  for (const name of Object.keys(themes)) assert.match(css, new RegExp(`:root\\[data-theme="${name}"\\] \\{`));
  assert.match(css, /^:root,\n:root\[data-theme="system"\] \{\n  color-scheme: light;\n  --bg: #f5f6f1;/m);
  assert.match(css, /prefers-color-scheme: dark[\s\S]*:root\[data-theme="system"\] \{\n    color-scheme: dark;\n    --bg: #0a1020;/);
  assert.doesNotMatch(css, /undefined/);
  assert.equal(resolveTheme("system", true), "midnight");
  assert.equal(resolveTheme("system", false), "sage");
  assert.equal(resolveTheme("velocity", false), "velocity");
  assert.ok(isThemeChoice("contrast"));
  assert.ok(!isThemeChoice("neon"));
  assert.deepEqual(themeChoices.map((choice) => choice.id).filter((id) => id !== "system").sort(), (Object.keys(themes) as ThemeName[]).sort());
});
