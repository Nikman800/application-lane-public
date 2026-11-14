// Whether the applicant has a report open (the side panel says so every few
// seconds while its dialog is up): a reload then closes it, and what they were
// writing is gone (several times).
export const REPORT_OPEN_MS = 20_000;
export function reportOpen(lastBeat: number | undefined, now: number): boolean {
  return Boolean(lastBeat) && now - (lastBeat as number) < REPORT_OPEN_MS;
}
