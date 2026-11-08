// A hidden page's own timers keep their delays while a fill runs.
//
// Chrome runs a hidden tab's chained timers about once a minute (a minimized
// window counts as hidden). The extension's waits do not depend on that
// (content.ts, pause), but a site's do: SuccessFactors asks for a dropdown's
// choices from a timer, so in a minimized window each list came a minute or
// more after its click, the fill gave up on it, and it opened over the form
// later.
//
// installPageTimers runs in the page's own world. Each timer the page sets
// while it is on is also kept here with the time it is due; the content
// script, whose clock is not throttled, sends PAGE_TIMER_EVENT a few times a
// second while the page is hidden, and every timer then due runs. A timer
// runs once, whichever comes first, at the delay the page asked for.
// Turned off, new timers are the browser's own again.

export const PAGE_TIMER_EVENT = "application-lane:page-timers";

export function installPageTimers(eventName: string, on: boolean) {
  type Entry = { at: number; run: () => void };
  const page = window as typeof window & {
    __applicationLaneTimers?: { on: boolean };
  };
  if (page.__applicationLaneTimers) {
    page.__applicationLaneTimers.on = on;
    return;
  }
  if (!on) return;
  const control = { on: true };
  page.__applicationLaneTimers = control;
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  const due = new Map<number, Entry>();
  const report = (error: unknown) => {
    // As the browser would: the page's error is the page's, and the
    // other timers due still run.
    if (typeof reportError === "function") reportError(error);
    else nativeSetTimeout(() => { throw error; }, 0);
  };
  const delay = (ms: unknown) => Math.max(0, Number(ms) || 0);
  window.setTimeout = function (handler: TimerHandler, ms?: number, ...args: unknown[]) {
    if (!control.on || typeof handler !== "function")
      return nativeSetTimeout(handler, ms, ...args);
    let id = 0;
    const run = () => {
      if (!due.delete(id)) return;
      nativeClearTimeout(id);
      handler.apply(window, args);
    };
    id = nativeSetTimeout(run, ms);
    due.set(id, { at: performance.now() + delay(ms), run });
    return id;
  } as typeof window.setTimeout;
  window.setInterval = function (handler: TimerHandler, ms?: number, ...args: unknown[]) {
    if (!control.on || typeof handler !== "function")
      return nativeSetInterval(handler, ms, ...args);
    const every = delay(ms);
    let id = 0;
    // The browser's tick and this one never both run for the same period.
    const tick = () => {
      const entry = due.get(id);
      if (!entry || performance.now() < entry.at - 4) return;
      entry.at = performance.now() + every;
      handler.apply(window, args);
    };
    id = nativeSetInterval(tick, ms);
    due.set(id, { at: performance.now() + every, run: tick });
    return id;
  } as typeof window.setInterval;
  // The two share one set of ids, as in the browser.
  window.clearTimeout = function (id?: number) {
    if (id !== undefined) due.delete(id);
    nativeClearTimeout(id);
  } as typeof window.clearTimeout;
  window.clearInterval = function (id?: number) {
    if (id !== undefined) due.delete(id);
    nativeClearInterval(id);
  } as typeof window.clearInterval;
  document.addEventListener(eventName, () => {
    const now = performance.now();
    for (const entry of [...due.values()].sort((a, b) => a.at - b.at)) {
      if (entry.at > now) break;
      try {
        entry.run();
      } catch (error) {
        report(error);
      }
    }
  });
}
