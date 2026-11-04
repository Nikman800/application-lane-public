import { z } from "zod";

// Expected pay as a figure or a range, per year, month or hour. The
// currency is the applicant's own: an ISO code or the sign they wrote ("$"
// is several countries' dollar), "" when they gave none. A currency is
// never added to what they gave.
export const salarySchema = z.object({
  min: z.number().nonnegative().optional(),
  max: z.number().nonnegative().optional(),
  currency: z.string().max(10).default(""),
  period: z.enum(["year", "month", "hour"]),
});
export type Salary = z.infer<typeof salarySchema>;

const signs: Record<string, string> = { "€": "EUR", "£": "GBP", "₹": "INR", "₩": "KRW", "₪": "ILS", "₱": "PHP", "₺": "TRY", "₦": "NGN", "₫": "VND", "zł": "PLN" };
const codes = /\b(USD|CAD|AUD|NZD|EUR|GBP|INR|JPY|CNY|RMB|CHF|SEK|NOK|DKK|PLN|SGD|HKD|MXN|BRL|ZAR|KRW|ILS|AED|SAR|TRY|PHP|NGN|VND|CZK|HUF|RON|TWD|THB|MYR|IDR|PKR|BDT|EGP|KES|ARS|CLP|COP|PEN)\b/i;

// One written amount: "55k", "55.000" (thousands with a full stop),
// "40,000", "1.234,50", "35.50".
function amount(text: string, unit: string | undefined): number | undefined {
  let digits = text;
  const comma = digits.lastIndexOf(",");
  const dot = digits.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    digits = digits.split(decimal === "," ? "." : ",").join("").replace(decimal, ".");
  } else if (comma >= 0 || dot >= 0) {
    const mark = comma >= 0 ? "," : ".";
    const groups = digits.split(mark);
    // Groups of three after the first are thousands: "55.000", "1,250,000".
    const thousands = groups.length > 1 && groups.slice(1).every((group) => group.length === 3) && !(mark === "." && unit);
    digits = thousands ? groups.join("") : groups.length === 2 ? `${groups[0]}.${groups[1]}` : "";
  }
  const value = Number(digits);
  if (!digits || !Number.isFinite(value)) return;
  const scale = /^k$/i.test(unit || "") ? 1_000 : /^(m|mm)$/i.test(unit || "") ? 1_000_000 : 1;
  return Math.round(value * scale * 100) / 100;
}

// Pay written as text ("$95,000", "35-40/hr", "55k", "€55.000",
// "£40,000-50,000 per year") as a Salary, its period from the text or
// else the one given. Undefined when no amount can be read.
export function parseSalary(text: string | undefined, period?: Salary["period"]): Salary | undefined {
  const written = (text || "").trim();
  if (!written) return;
  const numbers = [...written.matchAll(/(\d[\d.,]*)\s*(k|mm|m)?\b/gi)]
    .map((match) => amount(match[1].replace(/[.,]$/, ""), match[2]))
    .filter((value): value is number => value !== undefined);
  if (!numbers.length || numbers.length > 2) return;
  let [min, max] = numbers;
  // "40-50k": the k is the range's.
  if (max !== undefined && /\d\s*k\b/i.test(written) && min < 1000 && max >= 1000) min *= 1000;
  if (max !== undefined && max < min) return;
  const said: Salary["period"] | undefined = /\b(hour|hourly|hr|ph)\b|\/\s*h\b/i.test(written)
    ? "hour"
    : /\b(month|monthly|mo|pm)\b/i.test(written)
      ? "month"
      : /\b(year|yearly|yr|annual\w*|annum|pa)\b/i.test(written)
        ? "year"
        : undefined;
  const code = written.match(codes)?.[1].toUpperCase();
  const sign = Object.keys(signs).find((one) => written.includes(one));
  const currency = code === "RMB" ? "CNY" : code || (sign ? signs[sign] : /\$/.test(written) ? "$" : /¥/.test(written) ? "¥" : "");
  const chosen = said || period || (min >= 1000 ? "year" : undefined);
  if (!chosen) return;
  return { min, ...(max !== undefined && max !== min ? { max } : {}), currency, period: chosen };
}

const grouped = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 2 });

// As text: "$95,000", "EUR 55,000-65,000", "35-40". The period is added only
// when asked (a question that names none, given an hourly figure).
export function formatSalary(salary: Salary, withPeriod = false): string {
  const range = [salary.min, salary.max].filter((value): value is number => value !== undefined).map(grouped).join("-");
  if (!range) return "";
  const money = !salary.currency ? range : /^[A-Z]{3}$/.test(salary.currency) ? `${salary.currency} ${range}` : `${salary.currency}${range}`;
  return withPeriod && salary.period !== "year" ? `${money} per ${salary.period}` : money;
}

// The pay to give a question: the figure alone for a box that takes only a
// number, else the text. Undefined when the question asks for another
// period than the applicant gave (pay is never converted) or nothing is
// saved.
export function salaryAnswer(
  salary: Salary | undefined,
  question: { label: string; numeric: boolean },
): { value: string; numeric?: number } | undefined {
  if (!salary || salary.min === undefined) return;
  const label = question.label.toLowerCase();
  const asked = /\b(hour|hourly|hr)\b|per hour/.test(label)
    ? "hour"
    : /\b(month|monthly)\b/.test(label)
      ? "month"
      : /\b(annual\w*|year\w*|yearly|per annum)\b/.test(label)
        ? "year"
        : undefined;
  if (asked && asked !== salary.period) return;
  if (question.numeric) return { value: String(salary.min), numeric: salary.min };
  return { value: formatSalary(salary, !asked), numeric: salary.min };
}
