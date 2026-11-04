// The dashboard's Progress board, at the top of the Submitted page: totals,
// the level track, a 12-week heatmap of submissions and milestone badges.
import React from "react";
import { activity, activityLevel, formatMinutes, type Progress, type SubmissionLike } from "../shared/progress";

export function ProgressBoard({ progress, submissions }: { progress: Progress; submissions: SubmissionLike[] }) {
  const days = activity(submissions);
  const active = days.filter((day) => day.count > 0).length;
  const level = progress.level;
  const earned = progress.badges.filter((badge) => badge.earned).length;
  return (
    <section className="progress-board" aria-label="Progress">
      <div className="progress-tiles">
        <div className="progress-tile featured">
          <strong>🔥 {progress.streak}</strong>
          <span>day streak · best {progress.bestStreak}</span>
        </div>
        <div className="progress-tile">
          <strong>
            {progress.today}/{progress.goal}
          </strong>
          <span>today’s goal</span>
        </div>
        <div className="progress-tile">
          <strong>{progress.week}</strong>
          <span>this week</span>
        </div>
        <div className="progress-tile">
          <strong>{progress.fieldsFilled}</strong>
          <span>fields auto-filled</span>
        </div>
        <div className="progress-tile" title={`Estimated at ~10 seconds a field`}>
          <strong>~{formatMinutes(progress.timeSavedMinutes)}</strong>
          <span>saved (estimate)</span>
        </div>
      </div>
      <div className="board-grid">
        <div className="card">
          <div className="section-title">
            <h2>Activity</h2>
            <span className="tag">{active} active day{active === 1 ? "" : "s"} in 12 weeks</span>
          </div>
          <div className="heatmap-wrap">
            <div className="heatmap" role="img" aria-label={`${progress.total} applications submitted; ${active} active days in the last 12 weeks`}>
              {days.map((day) => (
                <span
                  key={day.date}
                  className={day.future ? "future" : undefined}
                  data-level={activityLevel(day.count)}
                  title={`${day.count} submitted · ${new Date(`${day.date}T12:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`}
                />
              ))}
            </div>
          </div>
          <div className="heatmap-legend" aria-hidden="true">
            <em>Less</em>
            {[0, 1, 2, 3, 4].map((shade) => (
              <span key={shade} data-level={shade} />
            ))}
            <em>More</em>
          </div>
          <div className="level-track">
            <div className="section-title">
              <h2>
                Level {level.index + 1}: {level.name}
              </h2>
              <span className="tag">{progress.xp} XP</span>
            </div>
            <div className="xp-bar">
              <span style={{ width: `${Math.round(level.fraction * 100)}%` }} />
            </div>
            <small>{level.next ? `${level.next - progress.xp} XP to ${level.nextName}. Each submission earns 100, each field filled 2.` : "Top level reached."}</small>
          </div>
        </div>
        <div className="card">
          <div className="section-title">
            <h2>Badges</h2>
            <span className="tag">
              {earned} of {progress.badges.length}
            </span>
          </div>
          <ul className="badges">
            {progress.badges.map((badge) => (
              <li key={badge.id} className={`badge${badge.earned ? "" : " locked"}`}>
                <span className="badge-icon" aria-hidden="true">{badge.icon}</span>
                <span>
                  <strong>{badge.name}</strong>
                  <small>
                    {badge.description}
                    {badge.earned ? "" : " (locked)"}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
