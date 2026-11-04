// Settings → Appearance: the theme, shown as cards drawn in each theme's own
// colours, and the daily goal the momentum card counts toward. Both are this
// browser's (chrome.storage.local); theme-boot.ts applies the theme on every
// page, so the side panel follows a change made here.
import React from "react";
import { isThemeChoice, themeChoices, themes, type ThemeChoice, type ThemeTokens } from "../shared/theme";
import { DEFAULT_DAILY_GOAL } from "../shared/progress";
import { isGoal, useStoredValue } from "./prefs";

function Swatch({ theme }: { theme: ThemeTokens }) {
  return (
    <>
      <span className="swatch-card" style={{ background: theme.surface, border: `1px solid ${theme.border}` }}>
        <b style={{ background: `linear-gradient(135deg, ${theme.brandA}, ${theme.brandB})` }} />
        <b style={{ background: theme.text, opacity: 0.85 }} />
        <b style={{ background: theme.accent, flex: "0 0 18px" }} />
      </span>
      <span className="swatch-lane" style={{ background: `repeating-linear-gradient(90deg, ${theme.progressA} 0 12px, ${theme.progressB} 12px 24px)` }} />
    </>
  );
}

export function Appearance() {
  const [theme, setTheme] = useStoredValue<ThemeChoice>("theme", "system", isThemeChoice);
  const [goal, setGoal] = useStoredValue<number>("dailyGoal", DEFAULT_DAILY_GOAL, isGoal);
  return (
    <section className="card" aria-labelledby="appearance-heading">
      <div className="section-title">
        <h2 id="appearance-heading">Appearance</h2>
      </div>
      <p className="help">The side panel and this dashboard both follow your choice. Velocity has the boldest fill animation.</p>
      <div className="theme-grid" role="radiogroup" aria-label="Theme">
        {themeChoices.map((choice) => {
          const look = themes[choice.id === "system" ? "sage" : choice.id];
          return (
            <label className="theme-option" key={choice.id}>
              <input
                type="radio"
                name="theme"
                value={choice.id}
                checked={theme === choice.id}
                onChange={() => setTheme(choice.id)}
              />
              <span
                className="swatch"
                aria-hidden="true"
                style={{
                  background:
                    choice.id === "system"
                      ? `linear-gradient(135deg, ${themes.sage.bg} 0 50%, ${themes.midnight.bg} 50% 100%)`
                      : look.bg,
                }}
              >
                <Swatch theme={look} />
              </span>
              <span className="theme-name">{choice.name}</span>
              <span className="theme-note">{choice.note}</span>
            </label>
          );
        })}
      </div>
      <label className="goal-setting">
        Daily goal
        <input
          type="number"
          min={1}
          max={50}
          value={goal}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (isGoal(next)) setGoal(next);
          }}
        />
        <small className="theme-note">applications a day, for your streak and progress ring</small>
      </label>
    </section>
  );
}
