import { test } from "node:test";
import assert from "node:assert/strict";
import { activity, activityLevel, computeProgress, dayKey, formatMinutes, levelFor, streaks } from "../src/shared/progress";

// Local noon on a day, so time zones do not move it across midnight.
const day = (y: number, m: number, d: number, hour = 12) => new Date(y, m - 1, d, hour).getTime();
const now = day(2026, 11, 4, 18); // a Wednesday evening

test("a streak counts days in a row ending today, or yesterday while today has none yet", () => {
  assert.deepEqual(streaks([day(2026, 11, 2), day(2026, 11, 3), day(2026, 11, 4), day(2026, 11, 4, 9)], now), { current: 3, best: 3, today: true });
  // Nothing today yet: the run up to yesterday still stands.
  assert.deepEqual(streaks([day(2026, 11, 2), day(2026, 11, 3)], now), { current: 2, best: 2, today: false });
  // A missed day breaks it; the best run is remembered.
  assert.deepEqual(streaks([day(2026, 10, 1), day(2026, 10, 2), day(2026, 10, 3), day(2026, 10, 4), day(2026, 11, 2)], now), { current: 0, best: 4, today: false });
  assert.deepEqual(streaks([], now), { current: 0, best: 0, today: false });
  // Local dates: late evening and early morning are different days.
  assert.equal(dayKey(new Date(2026, 10, 4, 23, 59)), "2026-11-04");
  assert.equal(dayKey(new Date(2026, 10, 5, 0, 1)), "2026-11-05");
});

test("progress counts today against the goal, this week, fields filled, time saved, level and badges", () => {
  const submissions = [
    { submittedAt: day(2026, 11, 4, 9), confirmedBySite: true, ats: "Greenhouse" },
    { submittedAt: day(2026, 11, 4, 10), confirmedBySite: false, ats: "Lever" },
    { submittedAt: day(2026, 11, 3), confirmedBySite: false, ats: "Workday" },
    { submittedAt: day(2026, 11, 2), confirmedBySite: false, ats: "Ashby" },
    { submittedAt: day(2026, 11, 1), confirmedBySite: false, ats: "greenhouse" }, // Sunday: last week
    { submittedAt: day(2026, 10, 20), confirmedBySite: false, ats: "iCIMS" },
  ];
  const progress = computeProgress({ submissions, applications: [{ filled: 30 }, { filled: 12 }, {}], goal: 2, now });
  assert.equal(progress.total, 6);
  assert.equal(progress.today, 2);
  assert.equal(progress.goal, 2);
  assert.ok(progress.goalMet);
  assert.equal(progress.week, 4);
  assert.equal(progress.streak, 4);
  assert.equal(progress.bestStreak, 4);
  assert.equal(progress.fieldsFilled, 42);
  assert.equal(progress.timeSavedMinutes, 7);
  assert.equal(progress.platforms, 5);
  // 6 × 100 + 1 confirmed × 25 + 42 fields × 2 + best streak 4 × 50.
  assert.equal(progress.xp, 909);
  assert.equal(progress.level.name, "Pathfinder");
  assert.equal(progress.level.nextName, "Lane Runner");
  const earned = progress.badges.filter((badge) => badge.earned).map((badge) => badge.id);
  assert.deepEqual(earned, ["first", "submitted-5", "streak-3", "platforms-5"]);
});

test("without a submissions history the applications marked submitted count, and the goal defaults to 3", () => {
  const progress = computeProgress({
    applications: [
      { submittedAt: day(2026, 11, 4), workflowStage: "submitted", filled: 5 },
      { submittedAt: day(2026, 11, 4), workflowStage: "applying" },
      { workflowStage: "applying" },
    ],
    now,
  });
  assert.equal(progress.total, 1);
  assert.equal(progress.goal, 3);
  assert.ok(!progress.goalMet);
  assert.equal(progress.level.name, "Rookie");
  assert.equal(computeProgress({ applications: [], goal: 0, now }).goal, 3);
});

test("levels climb with XP and the last one has no next", () => {
  assert.equal(levelFor(0).name, "Rookie");
  assert.equal(levelFor(199).name, "Rookie");
  assert.equal(levelFor(200).name, "Scout");
  assert.equal(levelFor(350).fraction, 0.5);
  const top = levelFor(1_000_000);
  assert.equal(top.name, "Legend");
  assert.equal(top.next, undefined);
  assert.equal(top.fraction, 1);
});

test("activity lays out 12 weeks from Sunday, this week last, with later days marked future", () => {
  const days = activity([{ submittedAt: day(2026, 11, 4) }, { submittedAt: day(2026, 11, 4, 8) }, { submittedAt: day(2026, 9, 1) }], now);
  assert.equal(days.length, 84);
  assert.equal(new Date(`${days[0].date}T12:00`).getDay(), 0);
  const today = days.find((entry) => entry.date === "2026-11-04")!;
  assert.equal(today.count, 2);
  assert.ok(!today.future);
  assert.ok(days.find((entry) => entry.date === "2026-11-07")!.future);
  assert.equal(days.at(-1)!.date, "2026-11-07");
  assert.deepEqual([0, 1, 2, 3, 4, 6, 9].map(activityLevel), [0, 1, 2, 2, 3, 4, 4]);
  assert.equal(formatMinutes(45), "45 min");
  assert.equal(formatMinutes(80), "1 h 20 min");
  assert.equal(formatMinutes(120), "2 h");
});
