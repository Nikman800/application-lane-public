// How the applicant is getting on, for the side panel's momentum card, the
// dashboard's Progress board and the command line: a daily streak, today's
// goal, levels earned by applying, and milestone badges. All of it comes
// from the submissions history and the applications already kept; nothing
// new is stored but the daily goal (chrome.storage.local "dailyGoal").

export type SubmissionLike = { submittedAt: number; confirmedBySite?: boolean; ats?: string; company?: string };
export type ApplicationLike = { submittedAt?: number; filled?: number; ats?: string; workflowStage?: string };

export const DEFAULT_DAILY_GOAL = 3;
// A rough figure for the time a person takes over one form field by hand.
export const SECONDS_PER_FIELD = 10;

export const levels = [
  { xp: 0, name: "Rookie" },
  { xp: 200, name: "Scout" },
  { xp: 500, name: "Pathfinder" },
  { xp: 1000, name: "Lane Runner" },
  { xp: 2000, name: "Pacesetter" },
  { xp: 3500, name: "Sprinter" },
  { xp: 5500, name: "Trailblazer" },
  { xp: 8000, name: "Overdrive" },
  { xp: 12000, name: "Momentum Master" },
  { xp: 17000, name: "Legend" },
] as const;

export type Badge = { id: string; icon: string; name: string; description: string; earned: boolean };
export type ActivityDay = { date: string; count: number; future: boolean };

export type Progress = {
  total: number;
  today: number;
  week: number;
  goal: number;
  goalMet: boolean;
  streak: number;
  bestStreak: number;
  // Whether today already counts toward the streak, or it still waits on one.
  streakToday: boolean;
  fieldsFilled: number;
  timeSavedMinutes: number;
  xp: number;
  level: { index: number; name: string; floor: number; next?: number; nextName?: string; fraction: number };
  badges: Badge[];
  platforms: number;
};

// A local calendar date as YYYY-MM-DD: streaks follow the applicant's days.
export function dayKey(at: number | Date): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const startOfDay = (at: number) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
};

// The submissions to count: the backend's history when there is one (it
// keeps removed applications too), else the applications marked submitted.
export function submissionTimes(submissions: SubmissionLike[] | undefined, applications: ApplicationLike[]): SubmissionLike[] {
  if (submissions) return submissions;
  return applications
    .filter((app) => app.submittedAt && (app.workflowStage === undefined || app.workflowStage === "submitted"))
    .map((app) => ({ submittedAt: app.submittedAt!, ats: app.ats }));
}

// Days in a row with at least one submission, ending today, or yesterday
// while today has none yet; and the longest such run ever.
export function streaks(times: number[], now: number): { current: number; best: number; today: boolean } {
  const days = new Set(times.map(dayKey));
  const today = startOfDay(now);
  const counted = days.has(dayKey(today));
  let current = 0;
  for (let day = counted ? today : addDays(today, -1); days.has(dayKey(day)); day = addDays(day, -1)) current++;
  let best = 0;
  for (const key of days) {
    const [y, m, d] = key.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    if (days.has(dayKey(addDays(date, -1)))) continue;
    let run = 1;
    while (days.has(dayKey(addDays(date, run)))) run++;
    best = Math.max(best, run);
  }
  return { current, best: Math.max(best, current), today: counted };
}

export function xpFor(submissions: SubmissionLike[], fieldsFilled: number, bestStreak: number): number {
  return (
    submissions.length * 100 +
    submissions.filter((record) => record.confirmedBySite).length * 25 +
    fieldsFilled * 2 +
    bestStreak * 50
  );
}

export function levelFor(xp: number): Progress["level"] {
  let index = 0;
  while (index + 1 < levels.length && xp >= levels[index + 1].xp) index++;
  const floor = levels[index].xp;
  const next = levels[index + 1];
  return {
    index,
    name: levels[index].name,
    floor,
    next: next?.xp,
    nextName: next?.name,
    fraction: next ? Math.min(1, (xp - floor) / (next.xp - floor)) : 1,
  };
}

export function computeProgress({
  submissions,
  applications,
  goal = DEFAULT_DAILY_GOAL,
  now = Date.now(),
}: {
  submissions?: SubmissionLike[];
  applications: ApplicationLike[];
  goal?: number;
  now?: number;
}): Progress {
  const records = submissionTimes(submissions, applications);
  const times = records.map((record) => record.submittedAt);
  const todayKey = dayKey(now);
  const today = times.filter((at) => dayKey(at) === todayKey).length;
  // The week starts on Monday.
  const start = startOfDay(now);
  const monday = addDays(start, -((start.getDay() + 6) % 7)).getTime();
  const week = times.filter((at) => at >= monday && at <= now + 60_000).length;
  const { current, best, today: streakToday } = streaks(times, now);
  const fieldsFilled = applications.reduce((sum, app) => sum + Math.max(0, app.filled || 0), 0);
  const xp = xpFor(records, fieldsFilled, best);
  const platforms = new Set(records.map((record) => record.ats?.trim().toLowerCase()).filter(Boolean)).size;
  const safeGoal = Math.max(1, Math.round(goal) || DEFAULT_DAILY_GOAL);
  const total = records.length;
  const badges: Badge[] = [
    { id: "first", icon: "🚀", name: "Liftoff", description: "First application submitted", earned: total >= 1 },
    ...[5, 10, 25, 50, 100].map((count) => ({
      id: `submitted-${count}`,
      icon: count >= 50 ? "🏆" : count >= 25 ? "🥇" : count >= 10 ? "🎯" : "✋",
      name: count >= 100 ? "Centurion" : count >= 50 ? "Half-century" : count >= 25 ? "Quarter-century" : count >= 10 ? "Double digits" : "High five",
      description: `${count} applications submitted`,
      earned: total >= count,
    })),
    ...[3, 7, 14].map((days) => ({
      id: `streak-${days}`,
      icon: days >= 14 ? "☄️" : days >= 7 ? "🔥" : "✨",
      name: days >= 14 ? "Unstoppable" : days >= 7 ? "On fire" : "Warming up",
      description: `A ${days}-day streak`,
      earned: best >= days,
    })),
    { id: "platforms-5", icon: "🧭", name: "Explorer", description: "Applied on 5 different platforms", earned: platforms >= 5 },
  ];
  return {
    total,
    today,
    week,
    goal: safeGoal,
    goalMet: today >= safeGoal,
    streak: current,
    bestStreak: best,
    streakToday,
    fieldsFilled,
    timeSavedMinutes: Math.round((fieldsFilled * SECONDS_PER_FIELD) / 60),
    xp,
    level: levelFor(xp),
    badges,
    platforms,
  };
}

// Submissions a day for the last `weeks` weeks, a column to a week from
// Sunday to Saturday, ending with this week (later days are marked future).
export function activity(submissions: SubmissionLike[], now = Date.now(), weeks = 12): ActivityDay[] {
  const counts = new Map<string, number>();
  for (const record of submissions) counts.set(dayKey(record.submittedAt), (counts.get(dayKey(record.submittedAt)) || 0) + 1);
  const today = startOfDay(now);
  const first = addDays(today, -today.getDay() - (weeks - 1) * 7);
  const days: ActivityDay[] = [];
  for (let index = 0; index < weeks * 7; index++) {
    const date = addDays(first, index);
    const key = dayKey(date);
    days.push({ date: key, count: counts.get(key) || 0, future: date.getTime() > today.getTime() });
  }
  return days;
}

// The heatmap's shade for a day's count: 0 to 4.
export const activityLevel = (count: number) => (count <= 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 5 ? 3 : 4);

// "1 h 20 min", "45 min".
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
