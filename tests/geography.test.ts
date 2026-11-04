import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  countryCode,
  countryNamesOf,
  findRegion,
  placeCountry,
  type Geography,
} from "../src/shared/geography";
import { globalConfigSchema } from "../src/engine/config/schema";
import { emptyProfile } from "../src/shared/model";
import { profileAnswer } from "../src/shared/matching";
import { selectorValues } from "../src/engine/values";

const globals = globalConfigSchema.parse(
  JSON.parse(await readFile("src/engine/config/globals.json", "utf8")),
);
const geography: Geography = globals;

test("every ISO 3166-1 country is listed once, with its common other names", () => {
  assert.equal(Object.keys(globals.countries).length, 250);
  for (const [name, code] of [
    ["South Korea", "KR"], ["Korea, Republic of", "KR"], ["Türkiye", "TR"], ["Turkey", "TR"],
    ["Czechia", "CZ"], ["Czech Republic", "CZ"], ["Eswatini", "SZ"], ["Swaziland", "SZ"],
    ["North Macedonia", "MK"], ["Macedonia", "MK"], ["Kosovo", "XK"], ["South Sudan", "SS"],
    ["United States of America", "US"], ["USA", "US"], ["UK", "GB"],
  ])
    assert.equal(countryCode(geography, name), code, name);
  assert.deepEqual(countryNamesOf(geography, "USA").slice(0, 2), ["United States", "United States of America"]);
  // Every name belongs to one country only.
  const seen = new Map<string, string>();
  for (const [code, names] of Object.entries(globals.countries))
    for (const name of [names].flat()) {
      assert.equal(seen.get(name.toLowerCase()), undefined, name);
      seen.set(name.toLowerCase(), code);
    }
});

test("a region names its country only where that is certain", () => {
  const country = (region: string, known?: string) => findRegion(geography, region, known)?.country;
  assert.equal(placeCountry(geography, { region: "ON" }), "Canada"); // Toronto, ON
  assert.equal(placeCountry(geography, { region: "GA" }), "United States"); // Athens, GA
  assert.equal(placeCountry(geography, { region: "KA" }), "India"); // Bengaluru, KA
  assert.equal(placeCountry(geography, { region: "OR" }), "United States"); // Portland, OR
  assert.equal(placeCountry(geography, { region: "WA", country: "Australia" }), "Australia"); // Perth, WA
  assert.equal(country("WA", "Australia"), "AU");
  assert.equal(findRegion(geography, "WA", "Australia")?.names[0], "Western Australia");
  assert.equal(country("WA"), "US");
  assert.equal(country("GA", "India"), "IN");
  // Codes no US state uses never mean the United States.
  for (const code of ["ON", "BC", "KA", "MH", "NSW", "QLD", "BY"])
    assert.notEqual(country(code), "US", code);
  // A known country's own regions alone answer.
  assert.equal(country("AZ", "India"), undefined);
  assert.equal(country("ON", "United States"), undefined);
  // Shared by two countries, neither of them the United States: unknown.
  assert.equal(country("NT"), undefined);
  assert.equal(placeCountry(geography, { region: "NT" }), "");
  // A place ending in a country is in that country, not a region of another.
  assert.equal(placeCountry(geography, { region: "UK" }), "United Kingdom");
  assert.equal(placeCountry(geography, { region: "England" }), "United Kingdom");
});

test("a school's country and state come from its own place", () => {
  const profile = {
    ...emptyProfile,
    country: "United States",
    state: "Arizona",
    education: [
      { organization: "University of Toronto", title: "BS", fieldOfStudy: "", location: "Toronto, ON", startDate: "", endDate: "", details: "" },
      { organization: "University of Georgia", title: "MS", fieldOfStudy: "", location: "Athens, GA", startDate: "", endDate: "", details: "" },
      { organization: "IISc", title: "PhD", fieldOfStudy: "", location: "Bengaluru, KA", startDate: "", endDate: "", details: "" },
      { organization: "UWA", title: "BA", fieldOfStudy: "", location: "Perth, WA", country: "Australia", startDate: "", endDate: "", details: "" },
    ],
  } as never;
  const countryOf = (index: number) =>
    selectorValues("country", { path: "." }, profile, globals, { collection: "education", index })[0];
  assert.equal(countryOf(0), "Canada");
  assert.equal(countryOf(1), "United States");
  assert.equal(countryOf(2), "India");
  assert.equal(countryOf(3), "Australia");
  // The state a row's place names, written out in that place's country.
  const stateOf = (index: number) =>
    selectorValues("state", { path: "." }, profile, globals, { collection: "education", index });
  assert.ok(stateOf(0).includes("Ontario"));
  assert.ok(stateOf(3).includes("Western Australia"));
  assert.ok(!stateOf(3).includes("Washington"));
});

test("a state question takes the code of the applicant's own state in their own country", () => {
  const field = (label: string) => ({
    id: label, label, kind: "combobox", value: "", required: true, revision: 1, protected: false,
    options: [], accept: "", siteValue: false, invalid: false, section: "", index: 0,
  });
  const choicesFor = (country: string, state: string) =>
    profileAnswer(field("State") as never, { ...emptyProfile, country, state } as never)?.choices || [];
  assert.ok(choicesFor("United States", "Georgia").includes("GA"));
  assert.ok(choicesFor("Canada", "Ontario").includes("ON"));
  assert.ok(choicesFor("India", "Karnataka").includes("KA"));
  assert.ok(choicesFor("Australia", "Western Australia").includes("WA"));
  assert.ok(!choicesFor("Australia", "Western Australia").includes("Washington"));
});
