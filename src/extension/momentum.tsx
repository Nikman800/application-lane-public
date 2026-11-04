// The side panel's momentum card, above the queue's counts: the daily
// streak, today's submissions against the goal, and the level earned so far.
// A submission, or reaching the goal, sets off a short celebration (a glow
// instead of confetti for those who prefer less motion).
import React, { useEffect, useRef, useState } from "react";
import { formatMinutes, type Progress } from "../shared/progress";

const confettiColors = ["var(--progress-a)", "var(--progress-b)", "var(--accent)", "var(--warning)", "var(--success)"];
const pieces = Array.from({ length: 22 }, (_, index) => {
  const angle = (index / 22) * Math.PI * 2 + (index % 3) * 0.3;
  const distance = 70 + ((index * 37) % 60);
  return {
    "--x": `${Math.round(Math.cos(angle) * distance * 1.6)}px`,
    "--y": `${Math.round(Math.sin(angle) * distance - 20)}px`,
    "--r": `${(index * 97) % 540 - 270}deg`,
    "--c": confettiColors[index % confettiColors.length],
    "--delay": `${(index % 5) * 0.03}s`,
  } as React.CSSProperties;
});

export function Momentum({ progress, ready }: { progress: Progress; ready: boolean }) {
  const [celebration, setCelebration] = useState<{ key: number; note: string }>();
  const seen = useRef<{ total: number; goalMet: boolean } | undefined>(undefined);
  useEffect(() => {
    if (!ready) return;
    const before = seen.current;
    seen.current = { total: progress.total, goalMet: progress.goalMet };
    if (!before) return;
    const note =
      progress.goalMet && !before.goalMet
        ? `Daily goal reached: ${progress.today} today!`
        : progress.total > before.total
          ? `Submitted! +100 XP${progress.streak > 1 ? ` · ${progress.streak}-day streak` : ""}`
          : "";
    if (!note) return;
    setCelebration({ key: Date.now(), note });
    const timer = setTimeout(() => setCelebration(undefined), 3200);
    return () => clearTimeout(timer);
  }, [ready, progress.total, progress.goalMet]);

  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const done = Math.min(1, progress.today / progress.goal);
  const level = progress.level;
  return (
    <section className="momentum" aria-label="Your momentum">
      <div className={`streak${progress.streak ? "" : " cold"}`} title={progress.streakToday || !progress.streak ? `Best streak: ${progress.bestStreak} days` : "Submit one today to keep your streak going"}>
        <span className="flame" aria-hidden="true">🔥</span>
        <strong>{progress.streak}</strong>
        <small>day streak</small>
      </div>
      <div className="momentum-copy">
        <span className="level-name">
          {level.name}
          <small>Level {level.index + 1} · {progress.xp} XP</small>
        </span>
        <div className="xp-bar" role="img" aria-label={level.next ? `${level.next - progress.xp} XP to ${level.nextName}` : "Top level reached"}>
          <span style={{ width: `${Math.round(level.fraction * 100)}%` }} />
        </div>
        <span className="goal-line">
          {progress.goalMet ? "Goal met today" : `${progress.goal - progress.today} more to today’s goal`}
          {progress.timeSavedMinutes > 0 ? ` · ~${formatMinutes(progress.timeSavedMinutes)} saved` : ""}
        </span>
      </div>
      <div className={`goal-ring${progress.goalMet ? " met" : ""}`} role="img" aria-label={`${progress.today} of ${progress.goal} today`}>
        <svg viewBox="0 0 52 52" aria-hidden="true">
          <defs>
            <linearGradient id="goal-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" className="stop-a" />
              <stop offset="1" className="stop-b" />
            </linearGradient>
          </defs>
          <circle className="track" cx="26" cy="26" r={radius} fill="none" strokeWidth="5" />
          <circle
            className="value"
            cx="26"
            cy="26"
            r={radius}
            fill="none"
            stroke="url(#goal-gradient)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - done)}
            opacity={done ? 1 : 0}
          />
        </svg>
        <strong>
          {progress.today}/{progress.goal}
        </strong>
      </div>
      {celebration && (
        <>
          <div className="celebrate" key={celebration.key} aria-hidden="true">
            {pieces.map((style, index) => (
              <i key={index} style={style} />
            ))}
          </div>
          <div className="celebrate glow" key={`glow-${celebration.key}`} aria-hidden="true" />
          <p className="celebrate-note" aria-hidden="true">{celebration.note}</p>
        </>
      )}
    </section>
  );
}
