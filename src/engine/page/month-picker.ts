// A flatpickr month picker (its monthSelect plugin): the year shown between
// two arrows, the twelve months as cells named by their first day ("March 1,
// 2025"). SmartRecruiters' experience and education dates are drawn this way
// (2026-11-04); what is typed there is read in a format the page never shows,
// so the month is picked from the calendar as the applicant would.
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// Its waits through the content script's own (setMonthPickerWait): a plain
// timer in a tab out of view runs at most once a minute after a while, and
// stepping one year back took a minute (Intuitive, 2026-11-07).
let pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export function setMonthPickerWait(next: (ms: number) => Promise<void>) {
  pause = next;
}

export function isMonthPicker(element: Element): boolean {
  return element instanceof HTMLInputElement && element.classList.contains("flatpickr-input") &&
    Boolean(calendarOf(element)?.querySelector(".flatpickr-monthSelect-month, .flatpickr-monthSelect-months"));
}

function calendarOf(element: Element): Element | null {
  const root = element.getRootNode() as Document | ShadowRoot;
  const id = element.getAttribute("aria-controls");
  return (id && root.querySelector(`#${CSS.escape(id)}`)) || root.querySelector(".flatpickr-calendar");
}

// "2025-03", "2025-03-01" or "03/2025": the month and year to pick.
export function monthOf(value: string): { year: number; month: number } | undefined {
  const iso = /^(\d{4})-(\d{1,2})/.exec(value.trim());
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]) };
  const us = /^(\d{1,2})\/(?:\d{1,2}\/)?(\d{4})$/.exec(value.trim());
  if (us) return { year: Number(us[2]), month: Number(us[1]) };
  return undefined;
}

export async function pickMonth(element: HTMLInputElement, value: string): Promise<boolean> {
  const wanted = monthOf(value);
  if (!wanted || wanted.month < 1 || wanted.month > 12) return false;
  element.focus();
  element.click();
  await pause(150);
  const calendar = calendarOf(element);
  if (!calendar) return false;
  const year = () => Number((calendar.querySelector<HTMLInputElement>(".cur-year")?.value || "").trim());
  for (let step = 0; step < 80 && year() && year() !== wanted.year; step++) {
    const arrow = calendar.querySelector<HTMLElement>(year() > wanted.year ? ".flatpickr-prev-month" : ".flatpickr-next-month");
    if (!arrow || arrow.classList.contains("flatpickr-disabled") || arrow.getAttribute("aria-disabled") === "true") break;
    arrow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    arrow.click();
    await pause(30);
  }
  if (year() && year() !== wanted.year) return false;
  const label = `${months[wanted.month - 1]} 1, ${wanted.year}`;
  const cells = [...calendar.querySelectorAll<HTMLElement>(".flatpickr-monthSelect-month")];
  const cell = cells.find((candidate) => candidate.getAttribute("aria-label") === label) || (cells.length === 12 ? cells[wanted.month - 1] : undefined);
  if (!cell || cell.classList.contains("flatpickr-disabled")) return false;
  cell.click();
  await pause(150);
  return Boolean(element.value.trim());
}
