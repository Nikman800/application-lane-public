// The profile keeps each language as one line with how well it is known:
// "English: Native", "Hindi - Fluent", "Spanish (basic)". One level stands
// for every skill a form asks about (reading, speaking, writing).

export type Language = { language: string; level: "native" | "fluent" | "intermediate" | "basic" | "" };

const levels: [Language["level"], RegExp][] = [
  ["native", /\b(native|mother tongue|first language|bilingual)\b/i],
  ["fluent", /\b(fluent|fluency|full professional|advanced|proficient|expert)\b/i],
  ["intermediate", /\b(intermediate|professional working|working|conversational|good)\b/i],
  ["basic", /\b(basic|elementary|beginner|limited|some)\b/i],
];

export function parseLanguage(line: string): Language | undefined {
  // A hyphen separates only with spaces round it ("Haitian-Creole" is one name).
  const match = line.trim().match(/^(.+?)(?:\s*[:–—]\s*|\s+-\s+|\s*\(\s*)(.+?)\)?\s*$/);
  const language = (match ? match[1] : line).trim();
  if (!language || language.length > 60) return;
  const said = match ? match[2] : "";
  return { language, level: levels.find(([, pattern]) => pattern.test(said))?.[0] || "" };
}

// A profile saved before languages existed has none.
export function profileLanguages(lines: string[] = []): Language[] {
  return lines.map(parseLanguage).filter((language): language is Language => Boolean(language));
}

// The ways a form's list may word a level, nearest first. Workday numbers
// its scale ("1 - Beginner" to "5 - Fluent", an employer).
// one employer's Workday rates each skill Average, Excellent or Not Qualified
//: a native or fluent speaker is Excellent.
export function levelChoices(level: Language["level"]): string[] {
  return {
    native: ["Native", "5 - Fluent", "4 - Fluent", "Native or bilingual", "Native speaker", "Bilingual", "Fluent", "Expert", "Advanced", "Proficient", "3 - High", "High", "5 - Complete Mastery", "Complete Mastery", "Excellent"],
    fluent: ["Fluent", "5 - Fluent", "4 - Fluent", "Full professional", "Advanced", "Proficient", "Expert", "3 - High", "High", "4 - Advanced Professional Competency", "Advanced Professional Competency", "Excellent"],
    intermediate: ["Intermediate", "3 - Intermediate", "2 - Intermediate", "Professional working", "Working", "Conversational", "2 - Medium", "Medium", "3 - Professional Competency", "Professional Competency", "Average"],
    basic: ["Basic", "1 - Beginner", "Elementary", "Beginner", "Limited", "1 - Low", "Low", "2 - Limited Competency", "Limited Competency", "1 - Minimal Competency"],
    "": [],
  }[level];
}

// "I am fluent in this language": a native or fluent speaker is.
export const isFluent = (language: Language) => language.level === "native" || language.level === "fluent";
