import { activeStatuses, type Application, type AppStatus } from "./model";

// Count observed active preparation time, not overnight pauses or queue waits.
export function transitionTiming(
  app: Application,
  next: AppStatus,
  now: number,
) {
  if (app.activeSince !== undefined)
    app.preparationMs =
      (app.preparationMs || 0) + Math.max(0, now - app.activeSince);
  app.activeSince = activeStatuses.includes(next) ? now : undefined;
}

// How long a site rule's pass may run. Workday searches each skill in turn
// and SuccessFactors waits out each wording its lists lack;
// SmartRecruiters' titles, companies, schools and places are typed with real
// keys and picked from their menus, about 3.5 s each: with three jobs and two
// schools its pass was cut off a minute in, the second school's end date,
// description and Save never reached. Others: 60 s.
export function configPassTimeout(hostname: string): number {
  return /(^|\.)(myworkday(jobs)?\.com|successfactors\.(com|eu)|sapsf\.(com|eu)|ns2cloud\.com|smartrecruiters\.com)$/.test(hostname) ? 150_000 : 60_000;
}
