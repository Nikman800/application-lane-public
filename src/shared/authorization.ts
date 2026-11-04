// Work authorization, sponsorship, citizenship and U.S.-person answers,
// country by country. A question is answered from the applicant's entry for
// the country it names, else for the job's country; with neither known,
// only a question that names no place is answered, and only from an
// applicant's single entry. Anything else is left to the applicant: the
// worst outcome is a false statement about their right to work.
import globals from "../engine/config/globals.json" with { type: "json" };
import { countriesNamed, countryCode, type Geography } from "./geography";
import { legacyWorkAuthorization, normalize, type Profile, type WorkAuthorization } from "./model";

const geography = globals as Geography;

// A profile as stored now, or as an older one (a single Yes/No string each
// for authorization and sponsorship) still read.
type Readable = Pick<Profile, "country"> & {
  workAuthorization?: unknown;
  sponsorship?: unknown;
  citizenships?: unknown;
  applyingTo?: Profile["applyingTo"];
  legal?: Profile["legal"];
};

const iso = (country: string) => countryCode(geography, country) || country.trim().toUpperCase();

export function workAuthorizations(profile: Readable): WorkAuthorization[] {
  const own = profile.workAuthorization;
  if (Array.isArray(own) && own.length)
    return (own as WorkAuthorization[]).filter((entry) => entry?.country).map((entry) => ({ ...entry, country: iso(entry.country) }));
  return legacyWorkAuthorization(
    typeof own === "string" ? own : "",
    typeof profile.sponsorship === "string" ? profile.sponsorship : "",
    profile.country,
  ).entries;
}

export function citizenshipsOf(profile: Readable): string[] {
  const own = Array.isArray(profile.citizenships) ? (profile.citizenships as string[]).filter(Boolean).map(iso) : [];
  const legacy = Array.isArray(profile.workAuthorization) && profile.workAuthorization.length
    ? []
    : legacyWorkAuthorization(
        typeof profile.workAuthorization === "string" ? profile.workAuthorization : "",
        typeof profile.sponsorship === "string" ? profile.sponsorship : "",
        profile.country,
      ).citizenships;
  return [...new Set([...own, ...legacy])];
}

// The job's country (ISO), when the fill was told it.
export function jobCountry(profile: Readable): string | undefined {
  const country = profile.applyingTo?.country;
  return country ? countryCode(geography, country) : undefined;
}

// Questions that ask about a country without naming it, or about many.
const unnamedPlace = /\b(which|what|any|other|another|each|all|following|multiple) (countr\w*|jurisdictions?|locations?)\b|\b(european union|eu|eea|schengen|abroad|overseas|internationally|outside (of )?(your|the) (home )?country)\b/;

// The country a question asks about: one it names, or "" for one that names
// none. Undefined when it names several, or a place that is no country.
export function askedCountry(label: string): string | undefined {
  const named = countriesNamed(geography, label);
  if (named.length > 1) return;
  if (named.length === 1) return named[0];
  if (unnamedPlace.test(normalize(label))) return;
  return "";
}

// The entry that answers a question, or undefined when none does.
export function authorizationEntry(profile: Readable, label: string): WorkAuthorization | undefined {
  const asked = askedCountry(label);
  if (asked === undefined) return;
  const entries = workAuthorizations(profile);
  const country = asked || jobCountry(profile);
  if (country) return entries.find((entry) => entry.country === country);
  return entries.length === 1 ? entries[0] : undefined;
}

// Yes or No for "Are you authorized to work…" or "Will you require
// sponsorship…", or undefined when it is not known for the country asked.
export function authorizationAnswer(
  profile: Readable,
  label: string,
  field: "workAuthorization" | "sponsorship",
): "Yes" | "No" | undefined {
  const entry = authorizationEntry(profile, label);
  if (!entry) return;
  if (field === "workAuthorization") return entry.status ? (entry.status === "none" ? "No" : "Yes") : undefined;
  if (entry.needsSponsorship !== undefined) return entry.needsSponsorship ? "Yes" : "No";
  // A citizen or permanent resident never needs sponsorship there.
  return entry.status === "citizen" || entry.status === "permanent-resident" ? "No" : undefined;
}

// Whether the applicant is a citizen of a country: Yes when they say so, No
// when they list their citizenships without it or hold another status
// there, else unknown.
export function citizenOf(profile: Readable, country: string): boolean | undefined {
  const code = iso(country);
  const citizenships = citizenshipsOf(profile);
  const entry = workAuthorizations(profile).find((one) => one.country === code);
  if (citizenships.includes(code) || entry?.status === "citizen") return true;
  if (citizenships.length) return false;
  if (entry?.status && entry.status !== "authorized") return false;
  return undefined;
}

// What the export-control statement says: a U.S. person (citizen or other),
// not one, or nothing.
function statedUSPerson(profile: Readable): { person?: boolean; citizen?: boolean } {
  const statement = normalize(profile.legal?.exportControl || "");
  if (!statement) return {};
  if (/\bnot (a )?(u s|us) person\b/.test(statement)) return { person: false };
  const citizen = /\b(u s|us|united states) citizen\b/.test(statement) && !/\bnot\b/.test(statement);
  const person = citizen || (/\b(u s|us) person\b/.test(statement) && !/\bnot\b/.test(statement));
  return person ? { person: true, citizen } : {};
}

// A U.S. citizen, by the applicant's citizenships and entries, and by their
// export-control statement; unknown when the two disagree.
export function usCitizen(profile: Readable): boolean | undefined {
  const derived = citizenOf(profile, "US");
  const stated = statedUSPerson(profile);
  if (stated.citizen && derived === false) return;
  if (stated.person === false && derived) return;
  return stated.citizen || derived;
}

// A "U.S. person" under export-control rules (ITAR, EAR): a citizen or
// lawful permanent resident (refugees and asylees too, which only the
// applicant's own statement says). Unknown when sources disagree.
export function usPerson(profile: Readable): boolean | undefined {
  const stated = statedUSPerson(profile).person;
  const citizen = citizenOf(profile, "US");
  const us = workAuthorizations(profile).find((entry) => entry.country === "US");
  const derived =
    citizen || us?.status === "permanent-resident"
      ? true
      : citizen === false && (us?.status === "visa" || us?.status === "none")
        ? false
        : undefined;
  if (stated !== undefined && derived !== undefined && stated !== derived) return;
  return stated ?? derived;
}

const statusWords: Record<NonNullable<WorkAuthorization["status"]>, string> = {
  citizen: "citizen",
  "permanent-resident": "permanent resident",
  visa: "on a visa",
  authorized: "authorized to work",
  none: "not authorized to work",
};

// Each entry as a sentence, for a model's evidence and a reader: "United
// States: citizen; needs sponsorship: no".
export function authorizationLines(profile: Readable): string[] {
  const name = (code: string) => (Array.isArray(geography.countries[code]) ? geography.countries[code][0] : geography.countries[code]) || code;
  const lines = workAuthorizations(profile).map((entry) =>
    [
      `${name(entry.country)}: ${entry.status ? statusWords[entry.status] : "status not said"}${entry.visaType ? ` (${entry.visaType})` : ""}`,
      entry.needsSponsorship === undefined ? "" : `needs sponsorship: ${entry.needsSponsorship ? "yes" : "no"}`,
    ].filter(Boolean).join("; "),
  );
  const citizenships = citizenshipsOf(profile);
  return [...lines, ...(citizenships.length ? [`Citizen of: ${citizenships.map(name).join(", ")}`] : [])];
}
