// Tesla's date boxes (its "tds" design system): a read-only input set only
// by its calendar, which opens from the button beside it, shows one month
// under a "November 2026" label between buttons named for the months before
// and after ("October 2026", "December 2026"), and a grid of day buttons,
// those of the months around it marked "tds-day--not-this-month". Clicking
// the chosen day again clears the date. "If you are a current university
// student, please provide your anticipated graduation date?" was left with
// only its placeholder, today's date.

const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// The calendar beside a Tesla date box, if it is one.
export function tdsDateBox(element: Element): HTMLInputElement | undefined {
  if (!(element instanceof HTMLInputElement) || !element.classList.contains("tds-form-input-date")) return;
  return element.closest(".tds-form-input")?.querySelector(".tds-date-picker") ? element : undefined;
}

// "", "05/10/2027" or "May 10, 2027".
export function parseDay(value: string): { year: number; month: number; day: number } | undefined {
  const text = value.trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return { year: Number(match[3]), month: Number(match[1]), day: Number(match[2]) };
  match = text.match(/^([a-z]+)\.? (\d{1,2}),? (\d{4})$/i);
  const month = match ? monthNames.findIndex((name) => name.startsWith(match![1].toLowerCase().slice(0, 3))) + 1 : 0;
  if (match && month) return { year: Number(match[3]), month, day: Number(match[2]) };
  return;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Picks the date from the calendar. True when the box then holds a date of
// that day; a box already showing it is left alone.
export async function pickTdsDate(input: HTMLInputElement, value: string, signal?: AbortSignal): Promise<boolean> {
  const wanted = parseDay(value);
  const field = input.closest(".tds-form-input");
  const picker = field?.querySelector<HTMLElement>(".tds-date-picker");
  if (!wanted || !field || !picker) return false;
  const shows = () => {
    const held = parseDay(input.value);
    return Boolean(held && held.year === wanted.year && held.month === wanted.month && held.day === wanted.day);
  };
  if (shows()) return true;
  field.querySelector<HTMLButtonElement>(".tds-form-input-trailing button")?.click();
  await pause(150);
  const target = wanted.year * 12 + (wanted.month - 1);
  const shown = () => {
    const [name, year] = (picker.querySelector(".tds-date-picker-month label")?.textContent || "").trim().toLowerCase().split(/\s+/);
    const month = monthNames.indexOf(name);
    return month >= 0 && Number(year) ? Number(year) * 12 + month : undefined;
  };
  // One month a click, at most six years either way.
  for (let step = 0; step < 72 && !signal?.aborted; step++) {
    const at = shown();
    if (at === undefined) return false;
    if (at === target) break;
    const [before, after] = picker.querySelectorAll<HTMLButtonElement>(".tds-date-picker-month button");
    (at < target ? after : before)?.click();
    await pause(60);
  }
  if (shown() !== target) return false;
  const dayButton = [...picker.querySelectorAll<HTMLButtonElement>(".tds-date-picker-days-grid button")].find(
    (button) => !button.classList.contains("tds-day--not-this-month") && (button.textContent || "").trim() === String(wanted.day),
  );
  if (!dayButton) return false;
  dayButton.click();
  for (let waited = 0; !shows() && waited < 1000; waited += 100) await pause(100);
  return shows();
}
