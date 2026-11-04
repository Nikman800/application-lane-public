import { normalize } from "./model";

// Countries (ISO 3166-1 alpha-2 codes, each with its names, the usual one
// first) and the regions of some of them (ISO 3166-2 subdivision codes),
// as globals.json holds them.
type Names = string | string[];
export type Geography = {
  countries: Record<string, Names>;
  regionsByCountry: Record<string, Record<string, Names>>;
};

const list = (names: Names | undefined): string[] =>
  names === undefined ? [] : Array.isArray(names) ? names : [names];

// The code of the country a value names, by its code or any of its names.
export function countryCode(geography: Geography, value: string | undefined, byName = false): string | undefined {
  const wanted = normalize(value || "");
  if (!wanted) return;
  for (const [code, names] of Object.entries(geography.countries || {}))
    if ((!byName && normalize(code) === wanted) || list(names).some((name) => normalize(name) === wanted)) return code;
}

// Every name of the country a value names, the usual one first; [] when the
// value names no country.
export function countryNamesOf(geography: Geography, value: string | undefined): string[] {
  const code = countryCode(geography, value);
  return code ? list(geography.countries[code]) : [];
}

export type Region = { country: string; code: string; names: string[] };

// A country's regions, or none when its regions are not listed.
export function regionsOf(geography: Geography, country: string | undefined): Region[] {
  const code = countryCode(geography, country);
  const table = code ? geography.regionsByCountry?.[code] : undefined;
  return table && code ? Object.entries(table).map(([region, names]) => ({ country: code, code: region, names: list(names) })) : [];
}

// Every listed region, the United States' first.
export function allRegions(geography: Geography): Region[] {
  const countries = Object.keys(geography.regionsByCountry || {}).sort((a, b) => Number(b === "US") - Number(a === "US"));
  return countries.flatMap((country) => regionsOf(geography, country));
}

const sameRegion = (region: Region, wanted: string) =>
  normalize(region.code) === wanted || region.names.some((name) => normalize(name) === wanted);

// The region a place's state or province names ("AZ", "Ontario"), read in
// the place's own country when that is known. Without a known country:
//   - a name that is itself a country's ("UK", "India") is no region;
//   - a code or name the United States uses is the United States' ("GA",
//     "WA"), since a US address is the one most often written without its
//     country;
//   - otherwise a code or name only one country uses is that country's
//     ("ON", "KA", "NSW"), and one several use is nobody's ("NT", "SK").
// A named country's own table alone answers: "WA" with Australia is Western
// Australia, and "AZ" with India (or with a country not listed) is no region.
export function findRegion(geography: Geography, region: string | undefined, country?: string): Region | undefined {
  const wanted = normalize(region || "");
  if (!wanted) return;
  // A country named but not known ("Unknown"): its regions cannot be told.
  if (country?.trim()) return regionsOf(geography, country).find((one) => sameRegion(one, wanted));
  const found = allRegions(geography).filter((one) => sameRegion(one, wanted));
  const us = found.find((one) => one.country === "US");
  if (us) return us;
  if (countryCode(geography, region, true)) return;
  return new Set(found.map((one) => one.country)).size === 1 ? found[0] : undefined;
}

// The country a place is in, from its own country or else from its region:
// "Toronto, ON" is in Canada, "Athens, GA" in the United States, "London,
// UK" in the United Kingdom. The country's usual name, or "" when unknown.
export function placeCountry(geography: Geography, place: { country?: string; region?: string }): string {
  const own = countryNamesOf(geography, place.country)[0];
  if (own) return own;
  if (place.country?.trim()) return place.country.trim();
  const named = countryCode(geography, place.region, true);
  const region = findRegion(geography, place.region);
  const code = region?.country || named;
  return code ? list(geography.countries[code])[0] || "" : "";
}

// Ways a text names a country besides its names: a people's word ("a
// Canadian citizen") and short forms the names lists leave out.
const demonyms: Record<string, string> = {
  american: "US", canadian: "CA", mexican: "MX", british: "GB", english: "GB", scottish: "GB", welsh: "GB", irish: "IE",
  indian: "IN", german: "DE", french: "FR", spanish: "ES", italian: "IT", dutch: "NL", australian: "AU", japanese: "JP",
  chinese: "CN", korean: "KR", singaporean: "SG", israeli: "IL", brazilian: "BR", swiss: "CH", swedish: "SE",
  polish: "PL", portuguese: "PT", filipino: "PH", pakistani: "PK", nigerian: "NG", "new zealand": "NZ", "south african": "ZA",
};
// A word only some texts mean as a country: "us" ("in the US", "US
// citizen") and not "contact us".
const usWords = /\b(the|in) (us|u s(?: a)?)\b|\b(us|u s(?: a)?) (citizen\w*|person|persons|national|nationals|work|employment|employer|company|based|permanent|green|government|military|armed|security)\b|\bu s a\b|\bremote (us|u s(?: a)?)\b|\b(us|u s(?: a)?) remote\b|^(us|u s(?: a)?)$/;

// The countries a text names (ISO codes, each once): "authorized to work
// in the United Kingdom", "a Canadian citizen", "the U.S.". Short names and
// codes are read only where they cannot be ordinary words.
export function countriesNamed(geography: Geography, text: string): string[] {
  const plain = ` ${normalize(text)} `;
  const found = new Set<string>();
  for (const [code, names] of Object.entries(geography.countries || {}))
    for (const name of list(names)) {
      const wanted = normalize(name);
      // "US", "U.S." and the like are read by usWords alone.
      if (!wanted || (code === "US" && wanted.replace(/ /g, "").length <= 3 && wanted !== "usa" && wanted !== "u s a")) continue;
      if (wanted.length < 4 && !/^(uk|u k|uae|usa|u s a)$/.test(wanted)) continue;
      if (plain.includes(` ${wanted} `)) found.add(code);
    }
  for (const [word, code] of Object.entries(demonyms)) if (plain.includes(` ${word} `)) found.add(code);
  if (usWords.test(plain.trim())) found.add("US");
  // "New Mexico" and "New Jersey" are states; "Georgia" may be either.
  if (/ new mexico /.test(plain) && !/ mexico (?!new )/.test(plain.replace(/ new mexico /g, " "))) found.delete("MX");
  if (/ new jersey /.test(plain)) found.delete("JE");
  return [...found];
}

// The country of a job's place as postings write it ("Toronto, ON, Canada",
// "London, UK", "Austin, TX", "Remote - US"): its ISO code, or undefined
// when it cannot be told ("Remote", "Georgia", or places in two countries).
export function locationCountry(geography: Geography, location: string | undefined): string | undefined {
  const places = (location || "").split(/\s*(?:;|\||\n| or |\/(?=\s*[A-Z]))\s*/).map((place) => place.trim()).filter(Boolean);
  const found = new Set<string>();
  for (const place of places) {
    const named = countriesNamed(geography, place);
    if (named.length > 1) return;
    if (named.length === 1) {
      found.add(named[0]);
      continue;
    }
    const parts = place.split(",").map((part) => part.trim()).filter(Boolean);
    // Only a region written after a city ("Austin, TX", "Pune, MH"): a name
    // alone may be a city, a region or a country of the same name. A
    // two-letter code is a region first ("CA" after a city is California).
    // After a city and a region, a two-letter code is a country ("Toronto,
    // ON, CA").
    const third = parts.length > 2 ? countryCode(geography, parts.at(-1)) : undefined;
    if (third) {
      found.add(third);
      continue;
    }
    const region = parts.length > 1 ? findRegion(geography, parts.at(-1)) : undefined;
    const code = region ? undefined : countryCode(geography, parts.at(-1), !/^[A-Z]{2}$/.test(parts.at(-1) || "") || parts.length < 2);
    if (code) {
      found.add(code);
      continue;
    }
    if (region) found.add(region.country);
    else if (!/^remote$/i.test(place)) return;
  }
  return found.size === 1 ? [...found][0] : undefined;
}
