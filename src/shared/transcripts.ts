import type { Artifact, Profile } from "./model";

// Which transcript a form's field is given (2026-11-08). A transcript is one
// degree's: the applicant attaches each to its education entry, and a field
// that names a level ("…your undergraduate studies") gets that level's or
// none. A field naming no level gets the most recent degree's. The graduate
// transcript was put in a box asking for the undergraduate one.

export type TranscriptLevel = "undergraduate" | "graduate";

// The level of an education entry's degree, from its title.
export function degreeLevel(title: string): TranscriptLevel | undefined {
  const text = title.toLowerCase();
  if (/\b(bachelor|bachelors|bachelor's|b\.?\s?s\.?c?|b\.?\s?a\.?|b\.?\s?eng|b\.?\s?tech|associate|associates|undergraduate|undergrad)\b/.test(text)) return "undergraduate";
  if (/\b(master|masters|master's|m\.?\s?s\.?c?|m\.?\s?a\.?|m\.?\s?eng|mba|doctor|doctorate|doctoral|ph\.?\s?d|graduate|postgraduate)\b/.test(text)) return "graduate";
  return undefined;
}

// The level a form's field asks for, if it names one.
export function askedLevel(label: string): TranscriptLevel | undefined {
  const text = label.toLowerCase();
  if (/\b(undergraduate|undergrad|bachelor'?s?|college degree)\b/.test(text)) return "undergraduate";
  if (/\b(graduate|grad school|master'?s?|doctoral|doctorate|ph\.?\s?d|postgraduate)\b/.test(text)) return "graduate";
  return undefined;
}

// The education entry most recently studied at: one still under way, else
// the latest end date, else the first.
export function latestEducation(profile: Pick<Profile, "education">): number | undefined {
  if (!profile.education.length) return undefined;
  const ongoing = profile.education.findIndex((row) => row.current || !row.endDate || row.endDate.slice(0, 7) > new Date().toISOString().slice(0, 7));
  if (ongoing >= 0) return ongoing;
  return profile.education
    .map((row, index) => ({ end: row.endDate || "", index }))
    .sort((a, b) => b.end.localeCompare(a.end))[0].index;
}

export function pickTranscript(
  label: string,
  artifacts: Artifact[],
  profile: Pick<Profile, "education">,
): { artifact?: Artifact; missing?: TranscriptLevel } {
  const transcripts = artifacts.filter((artifact) => artifact.kind === "transcript");
  const tagged = transcripts.filter((artifact) => artifact.education !== undefined);
  const asked = askedLevel(label);
  // No entry has its own transcript: the one file there is, as before, for
  // a field that names no level, and for one naming the level it is of.
  if (!tagged.length) {
    const only = transcripts[0];
    if (!only) return {};
    if (!asked) return { artifact: only };
    const latest = latestEducation(profile);
    const level = latest === undefined ? undefined : degreeLevel(profile.education[latest].title);
    return level === asked ? { artifact: only } : { missing: asked };
  }
  if (asked) {
    // The most recent of that level, where there are several.
    const matching = tagged.filter((artifact) => artifact.level === asked);
    if (!matching.length) return { missing: asked };
    const latest = latestEducation(profile);
    return { artifact: matching.find((artifact) => artifact.education === latest) || matching[0] };
  }
  const latest = latestEducation(profile);
  return { artifact: tagged.find((artifact) => artifact.education === latest) || tagged[0] };
}
