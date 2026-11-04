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
