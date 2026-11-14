import type { GlobalConfig, JsonValue, SelectorConfig } from "./config/schema";
import { normalize, type Profile } from "../shared/model";
import { canonicalAnswer, rankOption, type ChoiceField } from "../shared/answers";
import { schoolNames } from "../shared/schools";
import { degreeAliases, graduated, highestRow, studying } from "../shared/education";
import { askedCountry, authorizationAnswer, jobCountry } from "../shared/authorization";
import { priorEmploymentAnswer, questionTopic } from "../shared/standing";
import { formatSalary } from "../shared/salary";
import { localDate, formatDate, profileDateFormat } from "../shared/dates";
import { dialCountry, splitPhone } from "../shared/phone";
import globalsData from "./config/globals.json" with { type: "json" };
import { isFluent, levelChoices, profileLanguages } from "../shared/languages";
import { allRegions, countryCode, countryNamesOf, placeCountry, regionsOf, type Region } from "../shared/geography";

export type ValueContext = {
  collection?: "education" | "experience" | "references" | "languages" | "websites";
  index?: number;
  // A website row's link, chosen with the page in view (the interpreter
  // leaves out a link the form asks for elsewhere).
  item?: string;
};

// Keys whose suffix is part of the name, not a repetition index.
const suffixKeys = new Set(["address_line_2", "address_line_3", "address_line_4"]);
const baseKey = (key: string) =>
  suffixKeys.has(key) ? key : key.replace(/_[2-5]$/, "");
const asString = (value: JsonValue | undefined): string[] => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(asString);
  if (typeof value === "object") return [];
  return [String(value)];
};
// Portals validate links strictly (Workday rejects "linkedin.com/in/x"), so a
// stored address is written as a full https URL, with www for linkedin.com.
function webAddress(value: string | undefined): string {
  const address = (value || "").trim();
  if (!address) return "";
  const withScheme = /^https?:\/\//i.test(address) ? address : `https://${address}`;
  try {
    const url = new URL(withScheme);
    if (/^linkedin\.com$/i.test(url.hostname)) url.hostname = `www.${url.hostname}`;
    return url.toString().replace(/\/$/, "");
  } catch {
    return address;
  }
}

const compact = (value: string) => normalize(value).replace(/ /g, "");
const unique = (values: string[]) => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

function savedAnswer(key: string, profile: Profile): string | undefined {
  const wanted = normalize(key.replaceAll("_", " "));
  const exact = profile.answers.find(
    ({ question }) => normalize(question) === wanted,
  )?.answer;
  if (exact !== undefined) return exact;
  const patterns: Record<string, RegExp> = {
    source: /how did you hear|hear about (us|this|the)/i,
    sponsorship: /sponsor|visa sponsorship/i,
    work_auth: /authoriz|eligible to work/i,
  };
  const pattern = patterns[baseKey(key)];
  // A saved authorization or sponsorship answer is about the country its
  // question names: it answers for this job only when that is the job's
  // country, or the job's country is not known and it names none.
  const sameCountry = (question: string) => {
    if (!/^(work_auth|sponsorship)$/.test(baseKey(key))) return true;
    const asked = askedCountry(question);
    const job = jobCountry(profile);
    return asked !== undefined && (job ? !asked || asked === job : !asked);
  };
  return pattern
    ? profile.answers.find(
        ({ question }) =>
          pattern.test(question) &&
          sameCountry(question) &&
          (baseKey(key) !== "work_auth" || !/sponsor/i.test(question)),
      )?.answer
    : undefined;
}

function referenceValue(
  key: string,
  profile: Profile,
  context: ValueContext,
): string | undefined {
  const row = (profile.references || [])[context.index || 0];
  if (!row) return;
  // Inside a reference block the plain labels ("Name", "Phone", "Email") mean
  // the reference's details, never the applicant's.
  if (/^(name|full_name|legal_name|contact_name|reference_name)$/.test(key))
    return row.name;
  if (
    /^(relationship|reference_relationship|reference_type|how_do_you_know)$/.test(
      key,
    )
  )
    return row.relationship;
  if (/^(phone|phone_stripped|phone_number|reference_phone)$/.test(key))
    return key === "phone_stripped"
      ? row.phone.replace(/[^0-9+]/g, "")
      : row.phone;
  if (/^(email|email_confirm|reference_email)$/.test(key)) return row.email;
}

function historyValue(
  key: string,
  profile: Profile,
  context: ValueContext,
): string | undefined {
  if (!context.collection) return;
  if (context.collection === "references")
    return referenceValue(key, profile, context);
  if (context.collection === "websites") return /^(url|website|link)$/.test(key) ? context.item : undefined;
  if (context.collection === "languages") {
    const row = profileLanguages(profile.languages)[context.index || 0];
    if (!row) return;
    if (/^(name|language)$/.test(key)) return row.language;
    if (/fluent/.test(key)) return isFluent(row) ? "Yes" : "No";
    if (/proficiency|level|reading|speaking|writing|comprehension|overall|translation/.test(key)) return levelChoices(row.level)[0];
    return;
  }
  const rows =
    context.collection === "education" ? profile.education : profile.work;
  const row = rows[context.index || 0];
  if (!row) return;
  if (/^(name|school|company|organization|employer)$/.test(key))
    return row.organization;
  // A school group's name, as Avature's rows call it (education > name).
  if (key === "education" && context.collection === "education") return row.organization;
  if (/^(title|degree|position)$/.test(key)) return row.title;
  if (/^(gpa|grade_average|overall_result)$/.test(key))
    return row.gpa?.trim() || row.details.match(/\b(?:gpa|grade)\b[^0-9]{0,10}([0-4](?:\.[0-9]{1,2})?)/i)?.[1];
  if (/^(major|field_of_study|discipline)$/.test(key)) return row.fieldOfStudy;
  // A row's own address parts when saved; otherwise "Tucson, AZ" gives a city
  // field its city and a state field its state rather than the whole text.
  const [place, region] = row.location.split(",").map((part) => part.trim());
  if (key === "location") return row.location;
  if (key === "city") return row.city || (region ? place : row.location);
  if (key === "state") return row.state || region || undefined;
  if (/^(address|address_1|street|street_address)$/.test(key)) return row.address || undefined;
  if (key === "county") return row.county || undefined;
  if (/^(postal_code|zip|zip_code)$/.test(key)) return row.postalCode || undefined;
  if (key === "country") return row.country || undefined;
  if (key === "reason_for_leaving") return row.reasonForLeaving || undefined;
  // Stripped of what a site refuses: SmartRecruiters' experience Description
  // says "This field cannot contain following characters: ;". A comma reads the same in a list of duties.
  if (key === "description_stripped") return row.details.replace(/\s*;\s*/g, ", ");
  if (/^(description|details|responsibilities)$/.test(key))
    return row.details;
  if (key === "currently_working") return row.current !== undefined ? (row.current ? "Yes" : "No") : row.endDate ? "No" : "Yes";
  // Graduated only once the end date has passed; a degree ending in 2027 is
  // still in progress. A school with neither an end date nor "still
  // studying" says nothing.
  if (key === "graduated_flag") {
    const done = graduated(row);
    return done === undefined ? undefined : done ? "Yes" : "No";
  }
  // Its opposite, as Ashby's "Still Student?" box asks it of each school.
  if (key === "currently_studying") {
    const now = studying(row);
    return now === undefined ? undefined : now ? "Yes" : "No";
  }
  if (/^(start|from)(_date)?$/.test(key)) return row.startDate;
  if (/^(end|to)(_date)?$/.test(key)) return row.endDate;
  const date = /^(start|from)/.test(key) ? row.startDate : row.endDate;
  const match = date.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (!match) return;
  // SuccessFactors takes a whole date, "05/01/2027"; a month-only profile
  // date is the 1st.
  if (/_slashes_mmddyyyy$/i.test(key) && match[2])
    return `${match[2]}/${match[3] || "01"}/${match[1]}`;
  if (/_slashes_mmyyyy$/i.test(key) && match[2])
    return `${match[2]}/${match[1]}`;
  // As month and date inputs hold them ("2023-07", ""). Avature's
  // job rows ask for these; with no value they were left to a guess.
  if (/_dashes_yyyymm$/i.test(key) && match[2])
    return `${match[1]}-${match[2]}`;
  if (/_dashes_yyyymmdd$/i.test(key) && match[2])
    return `${match[1]}-${match[2]}-${match[3] || "01"}`;
  if (/_year$/.test(key)) return match[1];
  if (/_month$/.test(key)) return match[2];
  // Oracle lists months by name ("August").
  if (/_month_text$/.test(key) && match[2])
    return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(match[2]) - 1];
  // A day list's own numbering ("5"); a date saved by month alone is the 1st.
  if (/_day$/.test(key) && match[2]) return String(Number(match[3] || "1"));
}

export function canonicalValues(
  rawKey: string,
  profile: Profile,
  context: ValueContext = {},
): string[] {
  const saved = savedAnswer(rawKey, profile);
  if (saved !== undefined)
    return unique([
      choiceKeys[rawKey] ? canonicalAnswer(choiceKeys[rawKey].field, saved) : saved,
    ]);
  if (rawKey === "address_2") return unique([profile.addressLine2]);
  if (rawKey === "address_3") return [];
  const key = baseKey(rawKey);
  // An upload step needs no answer, only a document; it runs only in the
  // pass that is handed one (content.ts), so a placeholder lets it start.
  if (key === "resume") return ["Resume"];
  if (key === "coverLetter") return ["Cover letter"];
  if (key === "skill" || key === "skills") return unique(profile.skills);
  // Where the applicant hears of jobs. A person saved as a reference vouches
  // for them; that name is not how they found a posting.
  if (key === "source") {
    const people = new Set((profile.references || []).map((reference) => normalize(reference.name || "")).filter(Boolean));
    const own = unique(profile.referralSource.filter((source) => source.trim() && !people.has(normalize(source))));
    // None saved: Application Lane, which a list names under its Other
    // (shared/matching.ts, hearAbout).
    return own.length ? own : ["Application Lane", "Other", "Other (please specify)"];
  }
  const now = new Date();
  const currentDate = {
    current_date_yyyy: String(now.getFullYear()),
    current_date_mm: String(now.getMonth() + 1).padStart(2, "0"),
    current_date_dd: String(now.getDate()).padStart(2, "0"),
    // As a calendar numbers its days ("3").
    current_date_d: String(now.getDate()),
    // In the applicant's format; unknown, none (a site rule that knows its
    // format names it, as below).
    current_date: profileDateFormat(profile) ? formatDate(localDate(now), profileDateFormat(profile)!) : undefined,
    // As Lever's self-identification form names it.
    current_date_slashes_mmddyyyy: `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear()}`,
  }[key.toLowerCase()];
  if (currentDate) return [currentDate];
  // A language's skills (Workday's Comprehension, Overall, Reading…) take its
  // one level, in each of the ways a list may word it.
  if (context.collection === "languages" && !/fluen/.test(key) && /proficiency|level|reading|speaking|writing|comprehension|overall|listen|teach|translat/.test(key)) {
    const row = profileLanguages(profile.languages)[context.index || 0];
    return row ? levelChoices(row.level) : [];
  }
  const history = historyValue(key, profile, context);
  if (history) return [history];
  // A row that does not say where the employer or school is says nothing:
  // the applicant's home address is never theirs. (Country alone still
  // defaults to the applicant's, as sites that ask it of every row expect.)
  if (
    (context.collection === "experience" || context.collection === "education") &&
    /^(city|state|county|address|address_1|street|street_address|postal_code|zip|zip_code|reason_for_leaving)$/.test(key)
  )
    return [];
  const fullName = `${profile.firstName} ${profile.lastName}`.trim();
  // An older profile kept the country code in the number.
  const split = splitPhone(profile.phone || "");
  const phoneCode = profile.phoneCountryCode || split.code || "";
  const national = profile.phoneCountryCode ? profile.phone : split.national;
  // A phone-country list takes the code's country, else where they live.
  const phoneCountry = (() => {
    const residence = countryCode(globalsData as GlobalConfig, profile.country) || undefined;
    const code = dialCountry(phoneCode, residence) || residence;
    return code ? countryNamesOf(globalsData as GlobalConfig, code)[0] : undefined;
  })();
  // Expected pay: the figure alone where a key asks for a number.
  const salaryText = profile.salary ? formatSalary(profile.salary) : "";
  if (/(^|_)(salary|compensation|pay|wage)(_|$)/.test(key)) {
    if (/(^|_)(number|numeric|amount|figure)(_|$)/.test(key)) return profile.salary?.min !== undefined ? [String(profile.salary.min)] : [];
    return salaryText ? [salaryText] : [];
  }
  const cityState = [profile.city, profile.state].filter(Boolean).join(", ");
  const location = [cityState, profile.country].filter(Boolean).join(", ");
  if (key === "location")
    return unique([location, cityState, profile.city, profile.postalCode]);
  const values: Record<string, string | undefined> = {
    first_name: profile.firstName,
    // Most people's preferred name is their first name; forms often require it.
    first_name_preferred: profile.preferredName || profile.firstName,
    preferred_first_name: profile.preferredName || profile.firstName,
    preferred_name: profile.preferredName || profile.firstName,
    last_name: profile.lastName,
    preferred_last_name: profile.lastName,
    full_name: fullName,
    // A legal name is the whole one, middle name included.
    legal_name: [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(" "),
    middle_name: profile.middleName,
    middle_initial: profile.middleName?.trim().charAt(0).toUpperCase() || undefined,
    email: profile.email,
    email_confirm: profile.email,
    // The national number: its country code is a field of its own.
    phone: national,
    phone_stripped: national.replace(/\D/g, ""),
    phone_country_code: phoneCode,
    phone_international: phoneCode ? `${phoneCode} ${national}` : undefined,
    phone_type: profile.phoneDeviceType,
    phone_device_type: profile.phoneDeviceType,
    city: profile.city,
    city_state: cityState,
    city_state_full: cityState,
    location,
    country_location: profile.country,
    country: profile.country,
    state: profile.state,
    county: profile.county,
    address: profile.address,
    address_line_2: profile.addressLine2,
    postal_code: profile.postalCode,
    linkedin: webAddress(profile.linkedin),
    github: webAddress(profile.github),
    portfolio: webAddress(profile.website),
    website: webAddress(profile.website),
    additional_url: webAddress(profile.website),
    current_company_name: profile.currentCompany,
    // One line per reference, for the forms that ask for all of them in a
    // single box instead of a row per reference.
    references: (profile.references || [])
      .filter((reference) => reference.name.trim())
      .map((reference) =>
        [
          reference.name,
          reference.relationship,
          reference.phone,
          reference.email,
        ]
          .map((part) => part.trim())
          .filter(Boolean)
          .join(", "),
      )
      .join("\n"),
    // By degree level, not by the order the rows were entered in.
    highestDegree: highestRow(profile.education)?.title,
    phone_country: phoneCountry,

    // Worked for the employer applied to before: from the work history and
    // the applicant's "never worked for a company I apply to".
    prior_employment: priorEmploymentAnswer(profile, ""),
    // Whether there is a school beyond the first ("Do you have any previous
    // university education?").
    more_education: profile.education.length ? (profile.education.length > 1 ? "Yes" : "No") : undefined,
    acknowledge_terms: profile.acknowledgeTerms ? "Yes" : undefined,
  };
  const choice = choiceKeys[key];
  if (choice) return unique([profileChoice(choice.field, profile)]);
  // A phone's type in the wordings lists use, the applicant's own first:
  // one employer's Workday lists "Business Mobile" and "Personal Mobile", and a
  // plain "Mobile" picked neither. one employer's
  // lists "Home" and "Home Cellular", its word for a mobile.
  if (/^phone_(device_)?type$/.test(key) && values[key]) {
    const type = values[key]!.trim();
    const wordings: Record<string, string[]> = {
      mobile: ["Personal Mobile", "Mobile Phone", "Cell", "Cell Phone", "Cellular", "Home Cellular", "Personal Cellular", "Cellular Phone", "Personal Cell"],
      home: ["Personal Phone", "Home Phone", "Landline"],
      work: ["Business Phone", "Work Phone", "Office"],
    };
    return unique([type, ...(wordings[type.toLowerCase()] || [])]);
  }
  return unique(values[key] ? [values[key]!] : []);
}

// Answer-bank keys. A rule may map an answer ("Yes", "No", "Decline",
// "Male", "Female", "Non-binary", an ethnicity group) to the site's own
// wordings of it; "true" and "false" stand for Yes and No too.
// The profile's answer for an answer-bank field. Authorization and
// sponsorship are per country: a site rule's key names none, so the job's
// country (or the applicant's single entry) decides.
function profileChoice(field: ChoiceField, profile: Profile): string {
  if (field === "workAuthorization" || field === "sponsorship") return authorizationAnswer(profile, "", field) || "";
  if (field === "priorEmployment") return priorEmploymentAnswer(profile, "") || "";
  return canonicalAnswer(field, profile[field]);
}

const choiceKeys: Record<string, { field: ChoiceField }> = {
  work_auth: { field: "workAuthorization" },
  work_authorization: { field: "workAuthorization" },
  sponsorship: { field: "sponsorship" },
  over18: { field: "age18OrOlder" },
  relocation: { field: "willingToRelocate" },
  hispanic: { field: "hispanic" },
  disability: { field: "disabilityStatus" },
  veteran: { field: "veteranStatus" },
  veteran_status: { field: "veteranStatus" },
  gender: { field: "gender" },
  ethnicity: { field: "ethnicity" },
};

const declinePhrase = /decline|prefer not|don.?t wish|do not wish|choose not|not to (say|answer|disclose|identify)|self.?identify/i;

const degreeKeys = new Set(["degree", "highestDegree", "highest_degree"]);
// A degree title and the ways a site may list it: a rule's own wordings for
// any compatible degree it names ("Bachelor of Science": ["BS - Bachelor of
// Science"]), then the title and its common aliases.
function degreeValues(
  title: string,
  mapping: Record<string, JsonValue>,
): string[] {
  const aliases = degreeAliases(title).map(normalize);
  const precise = aliases.filter((value) => /\bof\b/i.test(value));
  const compatible = (candidate: string) => {
    const candidateAliases = degreeAliases(candidate).map(normalize);
    if (aliases.length && candidateAliases.length && !candidateAliases.some((value) => aliases.includes(value))) return false;
    if (!candidateAliases.length && normalize(candidate) !== normalize(title)) return false;
    const candidatePrecise = candidateAliases.filter((value) => /\bof\b/i.test(value));
    return !candidatePrecise.length || candidatePrecise.some((value) => precise.includes(value));
  };
  const values = unique([
    ...Object.entries(mapping).flatMap(([degree, wordings]) => (compatible(degree) ? asString(wordings) : [])),
    title,
    ...degreeAliases(title),
  ]);
  // Type-to-search pickers (iCIMS) search with the first candidate, and
  // their lists spell degrees out: "MS" finds nothing, "Master's degree"
  // does. Written-out names go first; exact matching still sees them all.
  const abbreviation = (value: string) => !/[a-z]{3}/.test(value);
  return [
    ...values.filter((value) => !abbreviation(value)),
    ...values.filter(abbreviation),
  ];
}

function neverServed(profile: Profile): boolean {
  return profile.answers.some((answer) => questionTopic(answer.question) === "military" && /^\s*no\b/i.test(answer.answer));
}

// Candidates for an answer-bank key: the site's own phrases for the answer
// first, then common wordings and the plain answer. Country/state aliases
// are never applied ("No" is also Norway's country code).
function choiceValues(
  key: string,
  raw: string | undefined,
  mapping: Record<string, JsonValue> | undefined,
): string[] {
  const { field } = choiceKeys[key];
  const answer = canonicalAnswer(field, raw);
  if (!answer) return [];
  const keys = answer === "Yes" ? ["Yes", "true"] : answer === "No" ? ["No", "false"] : [answer];
  let phrases = mapping
    ? keys.flatMap((code) => (code in mapping ? asString(mapping[code]) : []))
    : [];
  if ((field === "gender" || field === "ethnicity") && answer === "Decline")
    phrases = phrases.filter((phrase) => declinePhrase.test(phrase));
  return unique([
    ...phrases,
    ...(standardPhrases[field]?.[answer] || []),
    answer === "Decline" ? "" : answer,
  ]);
}

// Common US EEO wording.
const declineWording = [
  "do not wish to self-identify",
  "do not wish to answer",
  "do not want to answer",
  "prefer not to say",
  "prefer not to answer",
  "choose not to",
  "decline to",
  "decline to answer",
  "decline to self-identify",
  "decline to state",
];
const standardPhrases: Partial<Record<ChoiceField, Record<string, string[]>>> = {
  // "Authorized" / "Not Authorized" for Yes and No.
  workAuthorization: { Yes: ["authorized"], No: ["not authorized"] },
  veteranStatus: {
    Yes: ["i identify as one or more of the classifications of protected veteran", "identify as one or more of the classifications of protected veteran", "i am a protected veteran"],
    // "Not Protected Veteran (OFCCP)".
    No: ["i am not a protected veteran", "not a protected veteran", "not protected veteran"],
    Decline: [...declineWording, ...declineWording.map((phrase) => `i ${phrase}`)],
  },
  disabilityStatus: {
    Yes: ["yes, i have a disability"],
    No: ["no, i do not have a disability", "i don't have a disability"],
    Decline: [...declineWording, ...declineWording.map((phrase) => `i ${phrase}`)],
  },
  gender: { Decline: [...declineWording, ...declineWording.map((phrase) => `i ${phrase}`)] },
  // Portals word the groups differently ("Asian (Not Hispanic or Latino)").
  ethnicity: {
    "African American": ["black or african american", "black"],
    "East Asian": ["asian", "Asian (Not Hispanic or Latino)"],
    "South Asian": ["asian", "Asian (Not Hispanic or Latino)"],
    "Southeast Asian": ["asian", "Asian (Not Hispanic or Latino)"],
    "Hispanic/Latinx": ["hispanic or latino", "hispanic", "Hispanic/Latino"],
    "Native American": ["american indian or alaska native", "american indian"],
    "Pacific Islander": ["native hawaiian or other pacific islander", "pacific islander"],
    White: ["white"],
    "Two or More": ["two or more races", "multiple"],
    Decline: [...declineWording, ...declineWording.map((phrase) => `i ${phrase}`)],
  },
  hispanic: { Decline: [...declineWording, ...declineWording.map((phrase) => `i ${phrase}`)] },
};

// Tables a rule names by its "values" (see globals.json):
//   countryCodes: a country's names to its ISO code ("United States": "US")
//   countryNames: an ISO code to the country's usual name
//   regionCodes:  a region's names to its code, in the applicant's country
//   regionNames:  a region's code to its names ("AZ": "Arizona")
function namedMap(
  name: string,
  globals: GlobalConfig,
  country: string,
): Record<string, string | string[]> | undefined {
  const countries = Object.entries(globals.countries || {});
  if (name === "countryCodes")
    return Object.fromEntries(countries.flatMap(([code, names]) => [names].flat().map((one) => [one, code])));
  if (name === "countryNames")
    return Object.fromEntries(countries.map(([code, names]) => [code, [names].flat()[0]]));
  const regions = regionsFor(globals, country);
  if (name === "regionNames")
    return Object.fromEntries([...regions].reverse().map((region) => [region.code, region.names]));
  if (name === "regionCodes")
    return Object.fromEntries([...regions].reverse().flatMap((region) => region.names.map((one) => [one, region.code])));
  return;
}

// The regions an answer may name: those of the country given, or with no
// country (or none listed for it) every listed region, the United States'
// first.
function regionsFor(globals: GlobalConfig, country: string | undefined): Region[] {
  const own = regionsOf(globals, country);
  return own.length ? own : countryCode(globals, country) ? [] : allRegions(globals);
}

// Source, referral and pay questions always take the applicant's own answer,
// never a rule's fixed one.
function ownSource(key: string, fixed: string[], profile: Profile): string[] {
  const source = baseKey(key);
  if (/^source(?:_description)?$/i.test(source)) return canonicalValues("source", profile);
  if (/^referr(ed|al)_by/i.test(source)) return canonicalValues(key, profile);
  // Any pay key, whatever the rule calls it: a site's fixed figure is never
  // the applicant's.
  if (/(^|_)(salary|compensation|pay|wage)(_|$)|salary|compensation/i.test(source)) return canonicalValues(key, profile);
  return fixed;
}

// A field of study, then shorter forms of it a site's list may hold: without
// its degree ("M.S."), its note in brackets, with "and" for "&", and its
// first part ("Data Science" of "Data Science, Statistics & Engineering").
export function fieldOfStudyWordings(field: string): string[] {
  const bare = field
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/^\s*(?:(?:m|b)\.?\s?(?:s|a|sc|eng)\.?|ph\.?\s?d\.?|mba|(?:master|bachelor)'?s?(?: of [a-z]+)?(?: (?:in|of))?)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const first = bare.split(/\s*[,;/]\s*|\s+(?:&|and)\s+/)[0].trim();
  return [...new Set([field, bare, bare.replace(/\s*&\s*/g, " and "), first].filter((value) => value && value.length >= 3))];
}

// Standard fields a site's fixed list may hold in place of the applicant's
// own, closest first, for when none of its wordings is listed: one employer's
// Workday has no "Data Science" among its 325 fields, and the applicant asked
// for the nearest computing field instead.
// Only names that common Workday and college lists use. A pick from here is
// the closest, not the applicant's own, and the fill says so.
const relatedFields: [RegExp, string[]][] = [
  [/\b(data science|data analytics|analytics|machine learning|artificial intelligence|data engineering)\b/i,
    ["Computer and Information Science", "Computer Science", "Statistics", "Data Analytics", "Applied Mathematics"]],
  [/\b(computer science|computing|computer and information)\b/i,
    ["Computer Science", "Computer and Information Science", "Computer Science and Engineering", "Computer Engineering", "Software Engineering"]],
  [/\b(software engineering|software development)\b/i,
    ["Software Engineering", "Computer Science", "Computer and Information Science", "Computer Engineering"]],
  [/\b(information (technology|systems|science))\b/i,
    ["Information Technology", "Management Information Systems", "Computer and Information Science"]],
  [/\b(electrical|electronics?) engineering\b/i, ["Electrical Engineering", "Electrical and Computer Engineering", "Computer Engineering"]],
  [/\bcomputer engineering\b/i, ["Computer Engineering", "Electrical and Computer Engineering", "Computer Science"]],
];
export function relatedFieldsOfStudy(field: string): string[] {
  const own = new Set(fieldOfStudyWordings(field).map(normalize));
  return [...new Set(relatedFields.flatMap(([asks, names]) => (asks.test(field) ? names : [])))]
    .filter((name) => !own.has(normalize(name)));
}

export function selectorValues(
  key: string,
  selector: SelectorConfig,
  profile: Profile,
  globals: GlobalConfig,
  context: ValueContext = {},
): string[] {
  const choiceKey = selector.valueKey || key;
  if (
    selector.value === undefined &&
    degreeKeys.has(choiceKey.replace(/_[234]$/, "")) &&
    (!selector.values || typeof selector.values === "object")
  ) {
    const title = canonicalValues(choiceKey, profile, context)[0];
    return title
      ? degreeValues(title, (selector.values || {}) as Record<string, JsonValue>)
      : [];
  }
  if (selector.value === undefined && choiceKeys[choiceKey]) {
    // canonicalValues applies saved per-question answers first, then the
    // answer bank, and normalizes either to a choice.
    const raw = canonicalValues(choiceKey, profile, context)[0];
    const mapping =
      selector.values && typeof selector.values !== "string"
        ? (selector.values as Record<string, JsonValue>)
        : undefined;
    const choices = choiceValues(choiceKey, raw, mapping);
    // "I am not a veteran" (one employer's list, with no "protected" option) is true only of someone who never served: one who did may
    // still not be a protected veteran. The saved military answer says.
    if (choiceKeys[choiceKey].field === "veteranStatus" && canonicalAnswer("veteranStatus", raw) === "No" && neverServed(profile))
      return unique([...choices.filter((choice) => choice !== "No"), "i am not a veteran", "not a veteran", "No"]);
    return choices;
  }
  let values =
    selector.value === undefined
      ? canonicalValues(selector.valueKey || key, profile, context)
      : ownSource(key, asString(selector.value), profile);
  // A school or job saved as "Tucson, AZ" names no country, but its state
  // does: one employer's school rows ask for one.
  const row = context.collection === "education" || context.collection === "experience"
    ? (context.collection === "education" ? profile.education : profile.work)[context.index || 0]
    : undefined;
  // Its place's country is the row's, ahead of the applicant's own.
  if (selector.value === undefined && (selector.valueKey || key) === "country" && row && !row.country) {
    const country = placeCountry(globals, { region: row.state || row.location.split(",")[1]?.trim() || "" });
    if (country) values = [country];
  }
  // A field of study as the profile words it ("M.S. Data Science, Analytics
  // & Engineering (Applied Systems)") is found in no site's list;
  // searched, its core is ("Data Science"). one employer's Workday.
  // Only where the rule checks them against the site's own list of options
  // (Workday's): a rule that clicks through a list waits on each one, and
  // SuccessFactors' Major took long enough to delay the resume upload.
  if (selector.value === undefined && selector.optionsSource && /^(major|field_of_study|discipline)(_[234])?$/.test(selector.valueKey || key))
    values = unique(values.flatMap(fieldOfStudyWordings));
  // A school saved with its campus ("Pennsylvania State University,
  // University Park") may be listed without it: Ashby's search offered
  // "Pennsylvania State University" first, and no spelling tried
  // matched it. The full name stays first, so
  // a list naming the campus gets that campus.
  if (selector.value === undefined && context.collection === "education" && /^(name|school)$/.test(selector.valueKey || key))
    values = unique([...values, ...values.map((value) => value.split(",")[0].trim()).filter((name) => name.split(/\s+/).length >= 2)]);
  // Its other names, as lists may give it ("Virginia Polytechnic Institute
  // and State University" for "Virginia Tech", "The Ohio State University",
  // "Purdue University-Main Campus"), and the campus in its own city
  // ("Michigan State University - East Lansing"). Only whole names: a
  // list's other schools that share its words are not among them.
  if (selector.value === undefined && context.collection === "education" && /^(name|school)$/.test(selector.valueKey || key) && values.length) {
    const city = (row?.location || "").split(",")[0].trim();
    values = unique([...values, ...values.flatMap(schoolNames), ...(city ? [`${values[0]} ${city}`, `${values[0]} ${city} Campus`] : [])]);
  }
  // The country a region answer is read in: the row's own place for a
  // school or job, else the applicant's.
  const country = row
    ? placeCountry(globals, { country: row.country, region: row.state || row.location.split(",")[1]?.trim() || "" })
    : placeCountry(globals, { country: profile.country, region: profile.state });
  if (!selector.values) return expandAliases(values, globals, country);
  const mapping =
    typeof selector.values === "string"
      ? namedMap(selector.values, globals, country)
      : selector.values;
  if (!mapping) return expandAliases(values, globals, country);
  const expanded = expandAliases(values, globals, country);
  // Maps keyed "true", "false" or "" answer a Yes or No, as selectPath reads
  // them: SuccessFactors' "Present Employer" lists Current and Prior.
  const keys = (value: string) =>
    /^yes$/i.test(value) ? [value, "true"] : /^no$/i.test(value) ? [value, "false", ""] : [value];
  const mapped = expanded.flatMap((value) => {
    for (const key of keys(value)) {
      const direct = mapping[key];
      if (direct !== undefined) return asString(direct);
    }
    const entry = Object.entries(mapping).find(
      ([candidate]) => normalize(candidate) === normalize(value),
    );
    return entry ? asString(entry[1]) : [];
  });
  return unique(mapped.length ? [...mapped, ...expanded] : expanded);
}

// A value with the other names of what it names: a country's other names
// and code ("United States", "USA", "US"), a region's code or names ("AZ",
// "Arizona"), read in the given country when it has listed regions.
export function expandAliases(
  values: string[],
  globals: GlobalConfig,
  country?: string,
): string[] {
  const expanded = [...values];
  const regions = regionsFor(globals, country);
  // Only the country's own region names are written as codes inside a
  // longer place ("Tucson, Arizona" as "Tucson, AZ"); with no country, the
  // United States'.
  const inPlaces = regionsOf(globals, country).length ? regionsOf(globals, country) : countryCode(globals, country) ? [] : regionsOf(globals, "US");
  for (const value of values) {
    const normalized = normalize(value);
    for (const [alias, canonical] of Object.entries(globals.fieldNameAliases || {})) {
      if (normalize(alias) === normalized) expanded.push(canonical);
      if (normalize(canonical) === normalized) expanded.push(alias);
    }
    const code = countryCode(globals, value);
    if (code) expanded.push(...countryNamesOf(globals, code), code);
    // A place that ends in the country ("Tucson, Arizona, United States of
    // America") is listed under the country's other names too: Ashby's
    // location search offers "Tucson, Arizona, United States".
    const place = value.match(/^(.+,\s*)([^,]+)$/);
    const placeCode = place ? countryCode(globals, place[2], true) : undefined;
    if (place && placeCode)
      for (const other of countryNamesOf(globals, placeCode))
        if (normalize(other) !== normalize(place[2])) expanded.push(`${place[1]}${other}`);
    for (const region of regions) {
      if (normalize(region.code) === normalized) expanded.push(...region.names);
      if (region.names.some((name) => normalize(name) === normalized))
        expanded.push(region.code, ...region.names);
    }
    for (const region of inPlaces)
      for (const name of region.names) {
        const index = value.toLowerCase().indexOf(name.toLowerCase());
        if (index >= 0 && normalize(name) !== normalized)
          expanded.push(`${value.slice(0, index)}${region.code}${value.slice(index + name.length)}`);
      }
  }
  return unique(expanded);
}

export type OptionValue = { label: string; value: string };

export function matchOption(
  requested: string[],
  options: OptionValue[],
  globals: GlobalConfig,
): OptionValue | undefined {
  const values = unique(requested);
  const aliases = expandAliases(values.filter((value) => !/^(yes|no|true|false)$/i.test(value.trim())), globals).filter(
    (value) => !values.includes(value),
  );
  // Candidates are ordered by preference (mapped value first, then the raw
  // answer and aliases). Ambiguity between two options for the SAME candidate
  // is never guessed; ambiguity across candidates is resolved by preference.
  const stages: ((option: OptionValue, value: string) => boolean)[] = [
    (option, value) => option.label === value || option.value === value,
    // (Text that is all punctuation reads as nothing, and nothing matches
    // nothing: "—" is no answer to a "–" option.)
    (option, value) =>
      Boolean(normalize(value)) &&
      (normalize(option.label) === normalize(value) ||
        normalize(option.value) === normalize(value)),
    // Abbreviations differ only in punctuation between portals: "Ph.D." and
    // "PhD", "B.S." and "BS".
    (option, value) =>
      Boolean(compact(value)) &&
      (compact(option.label) === compact(value) ||
        compact(option.value) === compact(value)),
    (option, value) => {
      const coded = option.label.match(/^\s*([A-Z][A-Z.&/]{1,8})\s*[-–—:]\s+(.+)$/);
      if (!coded || normalize(coded[2]) !== normalize(value)) return false;
      const code = compact(coded[1]);
      const degreeCode = /^(bs|bsc|ba|ms|msc|ma|phd|mba|as|aa|meng|beng|mfa|bfa|bba)$/.test(code);
      return !degreeCode || values.some((candidate) => compact(candidate) === code);
    },
    // A list's own wording with a note after it: "Not Protected Veteran
    // (OFCCP)" is "not protected veteran".
    (option, value) => {
      const bare = option.label.replace(/\s*\([^()]*\)\s*$/, "");
      return bare !== option.label && Boolean(normalize(value)) && normalize(bare) === normalize(value);
    },
    // A degree listed by its level with examples after it: Oracle's "Graduate
    // Master's Degrees (e.g., Master of Arts, …)" for a Master of Science
    // (the answer ranking's own reading of such a list, answers.ts).
    (option, value) => {
      if (!/\(\s*e\.?\s*g\.?/i.test(option.label)) return false;
      const rank = rankOption({ value, choices: [] }, option.label);
      return rank !== undefined && rank >= 44.7 && rank < 44.71;
    },
    // A binary answer may be worded as one sentence. Generic word
    // containment cannot establish a school, degree, country or status.
    // A list's empty choice is no sentence: "No Selection" begins with "No"
    // and was taken for it (one employer's Veteran Status).
    (option, value) => /^(yes|no)$/i.test(value.trim()) &&
      !/^(no selection|none selected|no answer)$/i.test(normalize(option.label)) &&
      new RegExp(`^${value.trim()}\\b`, "i").test(option.label.trim()),
  ];
  const ordered = [...values, ...aliases];
  for (const [index, stage] of stages.entries()) {
    for (const value of ordered) {
      // Aliases only participate once exact matching has failed.
      if (index === 0 && !values.includes(value)) continue;
      const matches = options.filter((option) =>
        (!/^(yes|no)$/i.test(value.trim()) || normalize(option.label).split(" ")[0] === normalize(value)) && stage(option, value));
      if (matches.length === 1) return matches[0];
      // A candidate that fits several options is too vague: skip it and let a
      // more specific candidate decide. Nothing is ever chosen between ties.
      if (matches.length > 1) continue;
    }
  }
}

// Candidates for a key without a site selector (accessible fallback): the
// answer-bank phrasings plus the plain answer, so a fallback match reaches the
// portal's own option wording.
export function fallbackValues(
  key: string,
  profile: Profile,
  globals: GlobalConfig,
  context: ValueContext = {},
): string[] {
  return selectorValues(key, { path: "." } as SelectorConfig, profile, globals, context);
}
