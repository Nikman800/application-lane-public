import { askedPart, citizenWordings, questionTopic, standingAnswer } from "./standing";
import {
  canonicalAnswer,
  choiceSynonyms,
  pickOption,
  readOption,
  qualifiedBinarySentences,
} from "./answers";
import {
  normalize,
  usOrUnset,
  sensitiveQuestion,
  type Field,
  type Profile,
  type Proposal,
} from "./model";
import { legalQuestion } from "./questions";
import { degreeAliases, degreeLevel, graduated, highestRow, latestRow, levelRank, studying, thisMonth as currentMonth } from "./education";
import { localDate, writtenDate } from "./dates";
import { schoolNames } from "./schools";
import { salaryAnswer } from "./salary";
import { dialCodes, dialCountry, splitPhone } from "./phone";
import { isFluent, levelChoices, profileLanguages } from "./languages";
import globals from "../engine/config/globals.json" with { type: "json" };
import { countriesNamed, countryCode, countryNamesOf, findRegion, placeCountry, type Geography } from "./geography";
import { askedCountry, authorizationAnswer, authorizationEntry, citizenOf, citizenshipsOf, jobCountry, usCitizen, workAuthorizations } from "./authorization";

const geography = globals as Geography;

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
// The listed span holding a month: "October - December 2027" for December
// 2027 (one employer's Oracle form lists graduation by quarter).
function monthSpan(options: string[], year: string, month: number): string | undefined {
  const index = (name: string) => months.findIndex((full) => full.toLowerCase().startsWith(name.toLowerCase().slice(0, 3))) + 1;
  return options.find((option) => {
    const span = option.trim().match(/^([a-z]{3,})\.?(?:\s+(\d{4}))?\s*(?:[-–—]|to)\s*([a-z]{3,})\.?\s+(\d{4})$/i);
    if (!span) return false;
    const from = index(span[1]);
    const to = index(span[3]);
    const fromYear = span[2] || (from <= to ? span[4] : String(Number(span[4]) - 1));
    if (!from || !to) return false;
    const wanted = Number(year) * 12 + month;
    return wanted >= Number(fromYear) * 12 + from && wanted <= Number(span[4]) * 12 + to;
  });
}
function dateAnswer(
  date: string,
  label: string,
  field: Field,
  profile: Profile,
): string | undefined {
  const match = date.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (!match) return;
  if (/\byear\b/.test(label) && !/\bmonth\b/.test(label)) return match[1];
  if (/\bmonth\b/.test(label) && !/\byear\b/.test(label)) {
    const n = Number(match[2]);
    if (!n || n > 12) return;
    const candidates = [
      months[n - 1],
      months[n - 1].slice(0, 3),
      String(n),
      match[2],
    ];
    if (field.options.length)
      return field.options.find((o) =>
        candidates.some((c) => normalize(c) === normalize(o)),
      );
    return field.kind === "combobox" ? months[n - 1] : match[2];
  }
  if (/\bday\b/.test(label)) {
    if (!match[3]) return;
    // Day lists are usually "1".."31"; match either spelling.
    return (
      field.options.find((o) => /^\d{1,2}$/.test(o.trim()) && Number(o) === Number(match[3])) ||
      match[3]
    );
  }
  if (field.kind === "date" && !match[3]) return;
  if (field.kind === "date") return date;
  // A date typed into a text box is written as the field shows, else in the
  // applicant's format: SuccessFactors' rows got "" where they
  // wanted MM/DD/YYYY. A year alone
  // is the year.
  if (!match[2]) return date;
  return writtenDate(date, field, profile);
}

// "Address line 2", "Home address line two", "Street address 2".
const secondAddressLine = /^(street |mailing |home )?address( line)? (2|two)$/;
// "Country", or asked as a question: Amazon's "What country/region are you
// currently located?".
const countryLabel = /^country( of residence)?$|^(what|which) country( region)? (are|do) you( currently)? (located|based|live|reside)( in)?$/;


// Exact school-name prompts observed in real forms. Dates, GPA, status,
// family education and university email ask for different facts.
const schoolNamePrompts = new Set([
  "college university", "current university",
  "please select your current or most recent university",
  "which university will you graduate from",
  "please include the university you are currently enrolled in",
  "which institution do you currently attend have most recently attended",
  "which institution do you currently or most recently attend",
  "which university are you currently attending",
  "please re confirm the university you currently attend",
  "which school are you currently attending",
  "what college university are currently enrolled",
  "which college or university do you currently attend",
  "what is the name of your university",
  "which university do did you attend",
  "what university do you currently attend",
  "what college university did you attend",
  "what school do you currently attend",
]);
const schoolNameQuestion = (label: string) => {
  const question = normalize(label.split("?")[0]);
  // "College or University" (one employer's JazzHR form).
  return /^(school|university|college|institution)( or (school|university|college|institution))?( name)?$/.test(question) || schoolNamePrompts.has(question);
};

const citizenAuthorizationQuestion = /^are you currently authorized to work for any employer in the (united states|us|u s)$/;
const [citizenAuthorizationOption, visaAuthorizationOption] = qualifiedBinarySentences.workAuthorization;
const futureSponsorshipQuestion = /^(do|will) you now or in the future require sponsorship(?: for employment visa status)?(?: to work in the (?:united states|us|u s))?$/;
const [completeFutureNo, partialFutureNo, visaTransferYes, newSponsorshipYes] = qualifiedBinarySentences.sponsorship;

// A saved binary answer confirms the question, not every assertion in a
// longer option. These observed sentence families need the fact checks below.
function qualifiedBinaryField(field: Field): "workAuthorization" | "sponsorship" | undefined {
  const has = (choices: readonly string[]) => field.options.some(option => choices.some(choice => normalize(choice) === normalize(option)));
  if (has([citizenAuthorizationOption, visaAuthorizationOption])) return "workAuthorization";
  if (has([completeFutureNo, partialFutureNo, visaTransferYes, newSponsorshipYes])) return "sponsorship";
}

export function deterministicAnswer(
  field: Field,
  profile: Profile,
): string | undefined {
  const label = normalize(field.label);
  if (
    // (A "Middle initial" is part of the name, not an initialled consent.)
    /password|captcha|one time|verification code|\bsign(?:ature|ing)?\b|(?<!\bmiddle (name )?)\binitial(?:s| each)?\b|\bconsent\b|\bagree\b|\bcertif\w*|\bi (?:understand|authorize|hereby)\b/.test(
      label,
    )
  )
    return;
  const saved = profile.answers.filter((a) => normalize(a.question) === label);
  if (saved.length) {
    if (!saved.every((a) => normalize(a.answer) === normalize(saved[0].answer))) return;
    if (/^(yes|no)$/.test(normalize(saved[0].answer)) && qualifiedBinaryField(field)) return;
    return saved[0].answer;
  }
  // One saved education row says nothing about earlier study. Multiple rows
  // establish a previous education without inventing a negative answer.
  if (/^do you have any previous university education$/.test(label))
    return profile.education.length > 1 ? "Yes" : undefined;
  if (
    sensitiveQuestion.test(label) ||
    /password|captcha|one time|verification code|signature/.test(label)
  )
    return;
  const section = normalize(field.section || "");
  if (!/work|employment|experience/.test(section)) {
    const row = profile.education[field.index || 0];
    if (schoolNameQuestion(field.label)) return row?.organization;
    if (/^degree$/.test(label)) return row?.title;
    if (/^(major|discipline|field of study)$/.test(label)) return row?.fieldOfStudy;
  }
  if (/work|employment|experience|education/.test(section)) {
    const rows = /education/.test(section) ? profile.education : profile.work;
    const row = rows[field.index || 0];
    if (!row) return;
    if (
      /^(company|employer|organization|school|university|institution)( name| dropdown)?$/.test(
        label,
      )
    )
      return row.organization;
    if (/^(job )?title$|^position$|^degree( dropdown)?$/.test(label))
      return row.title;
    if (/^(major|discipline|field of study)( dropdown)?$/.test(label))
      return row.fieldOfStudy;
    if (/^(start|from)( date)?( month| day| year)?$/.test(label))
      return dateAnswer(row.startDate, label, field, profile);
    if (/^(end|to)( date)?( month| day| year)?$/.test(label))
      return dateAnswer(row.endDate, label, field, profile);
    // A job without an end date is the one held now: Greenhouse's "Current
    // role" box.
    if (!/education/.test(section) &&
        /^(current (role|job|position|employer)|i currently work here|currently (work|working) here|i am currently working (here|in this role))$/.test(label))
      return row.current !== undefined ? (row.current ? "Yes" : "No") : row.endDate ? "No" : "Yes";
    // Graduated only when the end date has passed; an ongoing or future end
    // date is an expected graduation, not a completed one.
    // A row with neither an end date nor "still studying" says nothing.
    if (/^(did you graduate|graduated|have you graduated|completed)$/.test(label)) {
      if (row.current) return "No";
      if (!/^\d{4}-\d{2}/.test(row.endDate)) return;
      return row.endDate.slice(0, 7) <= currentMonth() ? "Yes" : "No";
    }
    if (/^location$/.test(label)) return row.location;
    // The row's own address, where one is saved. A row without it says
    // nothing: the applicant's home address is never an employer's.
    if (/^(street |company |employer )?address( line)?( 1| one)?$/.test(label)) return row.address || undefined;
    if (/^city$/.test(label)) return row.city || (row.location.includes(",") ? row.location.split(",")[0].trim() : undefined);
    if (/^(state|province)$/.test(label)) return row.state || row.location.split(",")[1]?.trim() || undefined;
    if (/^county$/.test(label)) return row.county || undefined;
    if (/^(zip|postal)( code)?$/.test(label)) return row.postalCode || undefined;
    if (/^country$/.test(label)) return row.country || undefined;
    if (/^reason for leaving$/.test(label)) return row.reasonForLeaving || undefined;
    // "Degree Conferred" / "Degree Received" is a date (an employer:
    // the model put "Bachelors of Science" there): when a finished degree was
    // awarded. One still in progress has not been received, but it will be
    // conferred on its expected date: a form asking both wants that there
    // (the applicant's reading).
    if (/^(degree|diploma) (conferred|received|awarded)( date)?$|^date (of )?(degree )?(conferred|received|awarded)$/.test(label)) {
      const end = row.endDate.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
      if (!end) return;
      if (row.endDate.slice(0, 7) > currentMonth() && /\breceived\b/.test(label)) return;
      return writtenDate(row.endDate, field, profile);
    }
    if (/^(description|responsibilities|details)$/.test(label))
      return row.details;
    return;
  }
  const keys: [RegExp, keyof Profile][] = [
    [/^(first|given) name$|^legal first name$/, "firstName"],
    [/^(last|family|sur) ?name$|^legal last name$/, "lastName"],
    [/^preferred( first)? name$/, "preferredName"],
    [/^(legal )?middle name$/, "middleName"],
    // The profile keeps one last name: the one the applicant goes by too.
    [/^preferred (last|family|sur) ?name$/, "lastName"],
    [/^e ?mail( address)?$/, "email"],
    // (The national number: the country code is asked apart, or is the
    // profile's phoneCountryCode.)
    [/^((home|cell|cellular|mobile|primary) )?(phone|mobile|telephone)( number)?$/, "phone"],
    [/^(city|current city|location city|current location)$/, "city"],
    [/^where (do you( currently)? live|are you( currently)? (located|based))$/, "city"],
    // "State / District", "State / Province / Region".
    [/^(state|province)( (province|district|territory|region))*$/, "state"],
    [countryLabel, "country"],
    [/^county( of residence)?$/, "county"],
    [/^(street |mailing |home )?address( line 1)?$/, "address"],
    [secondAddressLine, "addressLine2"],
    // One name or two: "Zip", "Postal code", "Postcode/ZIP".
    [/^((zip|postal|post ?code)( code)? ?){1,2}$|^please enter the zip code of your primary residence in the united states$|^please provide your post code zip code$/, "postalCode"],
    // Also asked as a request, instructions after it: "Please provide your
    // LinkedIn Profile url. Instruction: Navigate to…" (one employer's Workday).
    [/^linkedin( profile| url| profile url)?$|^(please )?((provide|enter|share|add|paste|include) )?(your )?linkedin( profile)?( page)?( url| link| address)\b/, "linkedin"],
    [/^(website|portfolio|personal website|other website)( url)?$/, "website"],
    [/^github( profile| url| profile url)?$|^(please )?((provide|enter|share|add|paste|include) )?(your )?github( profile)?( page)?( url| link| address)\b/, "github"],
    [/^current (company|employer)$/, "currentCompany"],
  ];
  // A legal name is the whole one, middle name included: "Full legal name",
  // "Legal name", also as a sentence ("Please state your full legal name:",
  // Lever). Without a saved middle name it is the first and last name.
  const legal = [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(" ").trim();
  if (
    /^(full legal|legal full|legal) name$/.test(label) ||
    /^(please )?((state|enter|provide|type|write|print|confirm|list) )?(your )?(full legal|legal full|legal) name$/.test(label) ||
    // As a question: "What is your Legal Name?".
    /^what is your (full legal|legal full|legal) name$/.test(label)
  )
    return legal;
  if (/^middle (initial|name initial)$/.test(label))
    return profile.middleName?.trim().charAt(0).toUpperCase() || undefined;
  // "First & Last Name" (SuccessFactors' e-signature) reads "first last name".
  if (
    /^(full|legal|your) name$|^name$|^legal full name$|^first (and )?last name$/.test(label) ||
    /^(please )?((state|enter|provide|type|write|print|confirm|list) )?(your )?(full legal|legal full|full|legal) name$/.test(label)
  )
    return `${profile.firstName} ${profile.lastName}`.trim();
  // Oracle asks for a "Preferred Full Name": the name the applicant goes by,
  // with their last name.
  if (/^preferred full name$/.test(label))
    return `${profile.preferredName || profile.firstName} ${profile.lastName}`.trim();
  if (
    /^(home|mailing) address$/.test(label) &&
    field.kind === "textarea" &&
    profile.address
  )
    return [
      profile.address,
      [profile.city, profile.state, profile.postalCode]
        .filter(Boolean)
        .join(", "),
      profile.country,
    ]
      .filter(Boolean)
      .join("\n");
  if (/^preferred( first)? name$/.test(label))
    return profile.preferredName || profile.firstName || undefined;
  // An area code asked apart from the number (SuccessFactors' "Home/Area
  // Code"): a North American number's first three digits. Others have none
  // to tell apart.
  const phone = phoneParts(profile);
  if (/^((home|cell|mobile|phone) )?area code$/.test(label)) {
    const digits = phone.national.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    const northAmerican = phone.code ? phone.code === "+1" : usOrUnset(profile.country) || /^(ca|canada)$/.test(normalize(profile.country));
    return /^[2-9]\d{9}$/.test(digits) && northAmerican ? digits.slice(0, 3) : undefined;
  }
  // The phone number's country, apart from the number: a code ("+44") or a
  // country list ("United Kingdom (+44)"). The code's country when one is
  // saved, else where the applicant lives.
  if (/^(phone |mobile |telephone )?(country|dial(l?ing)?|calling) code$|^(phone|mobile|telephone) (country|prefix)( code)?$|^country( phone)? code$/.test(label)) {
    const residence = countryCode(geography, profile.country);
    const country = dialCountry(phone.code, residence) || residence;
    const code = phone.code || (country ? dialCodes[country] : undefined);
    if (!code) return;
    const name = country ? countryNamesOf(geography, country)[0] : undefined;
    if (field.options.length || /combobox|listbox|select/.test(field.kind))
      return name || undefined;
    return code;
  }
  for (const [pattern, key] of keys)
    if (pattern.test(label)) {
      const value = key === "phone" ? phone.national : String(profile[key] || "");
      if (!value) return undefined;
      return ["linkedin", "website", "github"].includes(key) ? fullURL(value) : value;
    }
}

type Answer = Pick<Proposal, "value" | "choices" | "decline" | "numeric">;

// The phone's country code and national number; an older profile kept the
// code in the number.
function phoneParts(profile: Profile): { code?: string; national: string } {
  if (profile.phoneCountryCode) return { code: profile.phoneCountryCode, national: profile.phone };
  return splitPhone(profile.phone || "");
}

// A box that takes only a number: a number input, or one whose label says
// so ("numbers only", "no commas or currency symbols").
export const numberOnly = (field: Pick<Field, "kind" | "label">) =>
  field.kind === "number" || /\b(numbers? only|numeric( only| value)?|digits only|whole numbers?|no (commas|symbols|currency)|without (commas|symbols|currency))\b/.test(normalize(field.label));

// Profile links are often saved without a scheme ("github.com/name"); URL
// fields commonly reject that.
const fullURL = (value: string) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || !/^[\w-]+(\.[\w-]+)+(\/|$)/.test(value)
    ? value
    : `https://${value}`;

// Shorter forms of a long school or program name, most specific first:
// "M.S. Data Science, Statistics & Engineering (Applied Systems)"
// gives "Data Science", "Statistics", "Engineering"; "Pennsylvania
// State University, University Park" gives "Pennsylvania State
// University". Pickers list short canonical names and search poorly on long
// ones.
// Every name the site rules know for a country, the given one first.
export function countryNames(country: string): string[] {
  return [...new Set([country, ...countryNamesOf(geography, country)])];
}

export function nameVariants(value: string): string[] {
  const plain = value.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const subject = plain
    .replace(
      /^(?:(?:m|b|a)\.?\s?(?:s|a|sc|eng|fa|ba)\.?|ph\.?\s?d\.?|mba|(?:master|bachelor|associate)'?s?(?:\s+of\s+(?:science|arts|engineering|fine arts|business administration))?)\s+(?:(?:in|of)\s+)?/i,
      "",
    )
    .trim();
  const parts = subject
    .split(/\s*(?:,|&|;|\/|\s-\s|\s–\s|\band\b)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 2);
  return [
    ...new Set([plain, subject, plain.split(",")[0].trim(), ...parts]),
  ].filter((variant) => variant && variant !== value);
}

// Ways a list may name the applicant's school: its shorter forms, and, for a
// list that names each campus ("University of Michigan - Dearborn"), the one
// in the city the profile gives for it; and its other names ("Virginia Tech"
// for Virginia Polytechnic Institute and State University, "The Ohio State
// University", "Purdue University-Main Campus"). Another campus is another
// option and is never chosen in its place.
function schoolChoices(row: { organization: string; location?: string }): string[] {
  const city = (row.location || "").split(",")[0].trim();
  return [...new Set([...nameVariants(row.organization), ...schoolNames(row.organization), ...(city ? [`${row.organization} ${city}`, `${row.organization} ${city} Campus`] : [])])];
}

// Profile answers whose portal wording varies: range dropdowns ("3.5 - 3.74"),
// "None" for zero, and demographic options with site-specific phrasing.
// A yes/no work-authorization or sponsorship question the profile answers,
// asked of a normalized label. "Do you require work authorization?" asks
// about sponsorship, and "able to work without sponsorship" asks the
// opposite of "will you require sponsorship". Which country it is about is
// authorization.ts's to tell; two questions in one are left to the applicant.
function screeningQuestion(
  label: string,
): { field: "workAuthorization" | "sponsorship"; invert: boolean } | undefined {
  const sponsorship =
    /\bsponsor/.test(label) || (/\b(require|requires|need|needs|obtain)\b/.test(label) && /\b(authoriz|authoris|visa)/.test(label)) ||
    // "…ask an employer to commence an immigration case in order to
    // employ you? (e.g. H-1B…)" (SuccessFactors).
    /\b(commence|file|start|begin|open)\b( \w+){0,2} immigration (case|petition)/.test(label);
  const authorized =
    /\b(authorized|authorised|eligible|permitted|entitled|legally able|legally allowed)\b( \w+){0,2} to work\b|\bright to work\b|\bwork authori[sz]ation\b|\b(legal )?authori[sz]ation to work\b/.test(label);
  if (sponsorship) {
    const without = /\bwithout\b/.test(label);
    // "Are you authorized to work here, and will you need sponsorship?" asks
    // two things; "sponsorship for work authorization" (the noun) asks one.
    const asksBoth =
      /\b(authorized|authorised|eligible|permitted|entitled)\b( \w+){0,2} to work\b/.test(label) &&
      /\b(and|or)\b.*\bsponsor|\bsponsor.*\b(and|or)\b.*\bto work\b/.test(label);
    if (asksBoth && !without) return;
    return { field: "sponsorship", invert: without };
  }
  if (authorized) return { field: "workAuthorization", invert: false };
}


// The education row a question names by its level: "Name of the School:
// Undergraduate Degree", "Field of Study: Graduate/MBA/PhD Degree"
// (JazzHR), or the highest degree, held or still in progress. Undefined
// when no row, or more than one, is at that level.
function rowAtLevel(profile: Profile, asked: "undergraduate" | "graduate" | "highest", pursuing = true) {
  const thisMonth = currentMonth();
  const rows = profile.education.filter((row) => degreeLevel(row.title) && (pursuing || (/^\d{4}-\d{2}/.test(row.endDate) && row.endDate.slice(0, 7) <= thisMonth)));
  const top = Math.max(0, ...rows.map((row) => levelRank[degreeLevel(row.title)]));
  const matching = rows.filter((row) => {
    const rank = levelRank[degreeLevel(row.title)];
    return asked === "highest" ? rank === top : asked === "graduate" ? rank >= 3 : rank === 2;
  });
  return matching.length === 1 ? matching[0] : undefined;
}

const plainAnswer = (text: string | undefined): "Yes" | "No" | undefined =>
  /^\s*yes\b/i.test(text || "") ? "Yes" : /^\s*no\b/i.test(text || "") ? "No" : undefined;

export function profileAnswer(
  field: Field,
  profile: Profile,
): Answer | undefined {
  const label = normalize(field.label);
  const qualified = qualifiedBinaryField(field);
  if (qualified && !(qualified === "workAuthorization" ? citizenAuthorizationQuestion : futureSponsorshipQuestion)
      .test(normalize(askedPart(field.label)))) return;
  const saved = profile.answers.filter((a) => normalize(a.question) === label);
  if (saved.length) {
    const answer = normalize(saved[0].answer);
    if (!qualified || !/^(yes|no)$/.test(answer) ||
        !saved.every((a) => normalize(a.answer) === answer) ||
        normalize(authorizationAnswer(profile, field.label, qualified) || "") !== answer) return;
  }
  // A citizen or permanent resident of the job's country holds no temporary
  // authorization there: "Do you have temporary authorization (e.g., OPT,
  // CPT…)?" is No, and "If you are currently in OPT, are you eligible for a
  // STEM extension?" is not theirs to answer, so N/A where the list has it
  // (one employer's Workday). Anyone else is left to answer them.
  const temporaryAsked = normalize(askedPart(field.label));
  if (/\b(opt|cpt|optional practical training|curricular practical training|temporary (work )?authori[sz]ation)\b/.test(temporaryAsked)) {
    const entry = authorizationEntry(profile, askedPart(field.label));
    if (entry && (entry.status === "citizen" || entry.status === "permanent-resident")) {
      if (/^if you are\b|\b(extension|stem)\b/.test(temporaryAsked)) {
        const notApplicable = field.options.find((option) => /^\s*(n\/?a|not applicable)\b/i.test(option));
        return notApplicable ? { value: notApplicable } : undefined;
      }
      if (/^(do|are|have|will|is)\b/.test(temporaryAsked)) return { value: "No" };
    }
  }
  // Generic authorization does not establish use of CPT or OPT.
  if (/^does your work authorization\b.*\binvolve (cpt|opt)\b/.test(normalize(askedPart(field.label)))) return;
  // A confirmed positive authorization answers this explicit OR question
  // without making any assertion about documentary proof. Negative
  // authorization cannot answer it because proof remains unknown.
  if (/^are you lawfully authorized to work in the (us|u s|united states) or can you provide proof of employment eligibility upon hire$/.test(normalize(askedPart(field.label))) &&
      authorizationAnswer(profile, askedPart(field.label), "workAuthorization") === "Yes")
    return { value: "Yes" };
  // Authorization is not evidence that the applicant can provide documents,
  // or that their immigration permission is temporary. Exact saved answers
  // remain available through deterministicAnswer.
  // "…submit verification of both your identity and authorization to work"
  // asks for documents too.
  if (/\b(proof|document\w*|verification|temporary|permit type)\b/.test(normalize(askedPart(field.label))) &&
      /authori[sz]|right to work|visa/.test(label)) return;
  // "Do you currently have an active immigration case (ex H-1B extension,
  // green card)?" (Ashby, an employer): a U.S. citizen has none in the
  // United States. A permanent resident or a visa holder might, and a
  // citizen may have one in another country, so only a U.S. citizen asked
  // about the United States (by name, by its visas, or by the job's
  // country) is answered.
  const immigration = normalize(askedPart(field.label));
  if (/\b(have|has)\b( \w+){0,3} (active|pending|open|ongoing)( \w+){0,1} immigration (case|petition|application)/.test(immigration)) {
    const entries = workAuthorizations(profile);
    const country = askedCountry(field.label) ||
      (/\bh ?1 ?b\b|\bgreen card\b|\buscis\b/.test(immigration) ? "US" : jobCountry(profile) || (entries.length === 1 ? entries[0].country : undefined));
    if (country === "US" && citizenOf(profile, "US")) return { value: "No" };
    return;
  }
  // One box of a checkbox question (its question travels with it): the box
  // is ticked when its own label is the profile's answer to that question,
  // and left alone otherwise.
  const asked = field.kind === "checkbox" && field.question ? normalize(field.question) : "";
  if (asked) {
    // "Degree Type" beside a school and its graduation date is the degree
    // being finished there, the program ending last, and not every degree
    // the applicant holds.
    if (/^(type of degree|degree( type| level)?|level of (degree|education|study))$/.test(asked)) {
      const current = profile.education.filter((row) => row.endDate && row.title).sort((a, b) => a.endDate.localeCompare(b.endDate)).at(-1);
      const held = current ? degreeLevel(current.title) : "";
      if (!held) return;
      return { value: degreeLevel(field.label) === held ? "Yes" : "No" };
    }
    // Yes and No as boxes of their own (JazzHR's sponsorship question): the question is answered as a Yes/No choice, and the box
    // naming that answer is ticked, the other left clear.
    if (/^(yes|no)$/.test(label)) {
      const answer = profileAnswer({ ...field, kind: "radio", label: field.question!, question: undefined, options: ["Yes", "No"] }, profile);
      return answer && /^(yes|no)$/i.test(answer.value) ? { value: normalize(answer.value) === label ? "Yes" : "No" } : undefined;
    }
    // "Please indicate all of the locations that you would be interested in
    // relocating to": an applicant who will relocate
    // anywhere is interested in every one listed. One who will not, or
    // has not said, is left to choose.
    if (/\brelocat/.test(asked) && /\b(locations?|cities|city|offices?|places?|where)\b/.test(asked)) {
      const willing = standingAnswer({ ...field, kind: "radio", label: "Are you willing to relocate?", question: undefined, options: ["Yes", "No"] }, profile);
      return willing && normalize(willing.value) === "yes" ? { value: "Yes" } : undefined;
    }
    for (const [pattern, key] of [
      [/\bsexual orientation\b/, "sexualOrientation"],
      [/\bpronouns?\b/, "pronouns"],
    ] as const)
      if (pattern.test(asked)) {
        const answer = canonicalAnswer(key, profile[key]);
        if (!answer || answer === "Decline") return;
        const own = readOption(key, field.label);
        return { value: own === answer || (choiceSynonyms[answer] || []).some((synonym) => normalize(synonym) === label) ? "Yes" : "No" };
      }
  }
  // Acknowledgement boxes ("I agree to the privacy policy", "I certify the
  // above is true") are ticked only when the applicant has allowed it in
  // their profile. Signatures and initials stay theirs, a box that states a
  // refusal is not an acknowledgement, and opting in to messages or marketing
  // is a preference, not one either.
  if (
    field.kind === "checkbox" &&
    profile.acknowledgeTerms &&
    /\b(agree\w*|acknowledg\w*|consent\w*|certif\w*|accept\w*|i (understand|confirm|attest|have read|authorize|hereby)|privacy (policy|notice|statement)|terms (and|of) )/.test(label) &&
    !/\bsign(ature|ing|ed)?\b|\binitials?\b|\b(do not|don t|not|decline to) (agree|consent|accept|authorize|wish)\b|\b(sms|text messages?|texts?|whatsapp|marketing|newsletter|promotional|job alerts?|talent (community|network|pool)|future (job |career |employment )?(opportunit\w*|openings?|roles?|positions?)|contact me about|keep me (informed|updated|posted))\b/.test(label)
  )
    return { value: "Yes" };
  // The same standing question in other words (standing.ts).
  // An address requested to assess relocation assistance is not a willingness
  // question. A current address does not confirm a separate permanent one.
  if (/^(please )?(provide|enter)\b.*\bpermanent address\b/.test(label)) return;
  if (/\bable to commute\b|\bwilling and able\b.*\bon site\b/.test(label)) return;
  const standing = standingAnswer(field, profile);
  if (standing) return standing;
  // Inside one row of an education section, a question is about that row's
  // school: its own graduation date, and the profile's GPA only when that row
  // is the program the GPA belongs to (the one ending last).
  const educationRow = /education/.test(normalize(field.section || "")) ? profile.education[field.index || 0] : undefined;
  // A school's kind, from its degree: one employer's SuccessFactors lists
  // College, GED, High School, Junior College and Trade School under
  // "Education Type", and left it to the applicant.
  if (educationRow && /^(education|school|institution) type$|^type of (education|school|institution)$/.test(label)) {
    const level = degreeLevel(educationRow.title);
    if (/^(bachelor|master|mba|doctorate)$/.test(level)) return { value: "College", choices: ["College", "University", "College/University", "4 Year College"] };
    if (level === "associate") return { value: "Junior College", choices: ["Junior College", "Community College", "2 Year College"] };
  }
  // "Anticipated graduation season": the term the coming end date falls in.
  // December ends the Fall term and is winter by the calendar, so it answers
  // only a list that offers one of the two.
  if (/\bgraduat\w* (season|term|semester|quarter)\b/.test(label)) {
    const thisMonth = currentMonth();
    const coming = profile.education
      .map((row) => row.endDate)
      .filter((date) => /^\d{4}-\d{2}/.test(date) && date.slice(0, 7) >= thisMonth)
      .sort()
      .at(-1);
    if (!coming) return;
    const [year, month] = coming.split("-").map(Number);
    const seasons = month >= 3 && month <= 6 ? ["Spring"] : month <= 2 ? ["Winter"] : month <= 8 ? ["Summer"] : month <= 11 ? ["Fall", "Autumn"] : ["Fall", "Autumn", "Winter"];
    const named = seasons.map((season) => `${season} ${year}`);
    if (!field.options.length) return month === 12 ? undefined : { value: named[0] };
    const offered = field.options.filter((option) => named.some((name) => normalize(name) === normalize(option)));
    return offered.length === 1 ? { value: offered[0] } : undefined;
  }
  // "Please indicate your current year of study in college": counted from
  // the start of the program still under way (an employer: an M.S.
  // begun August 2025 is in its second year). A graduate student is no
  // undergraduate class; one that is gets its class's name in a list.
  if (/\b(current )?year (of|in) (study|school|college|university|the program)\b|\bclass standing\b|\bacademic standing\b|\bwhat year are you in\b/.test(label)) {
    const today = localDate();
    // Only a program the profile says is under way: an empty end date alone
    // does not.
    const current = profile.education.find((row) => /^\d{4}-\d{2}/.test(row.startDate) && row.startDate.slice(0, 7) <= today.slice(0, 7) && (row.current === true || (row.current !== false && Boolean(row.endDate) && row.endDate.slice(0, 10) >= today)));
    if (!current) return;
    const [startYear, startMonth] = current.startDate.split("-").map(Number);
    const [nowYear, nowMonth] = today.split("-").map(Number);
    const year = Math.floor(((nowYear - startYear) * 12 + nowMonth - startMonth) / 12) + 1;
    if (year < 1 || year > 6) return;
    const ordinal = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"][year - 1];
    const graduate = /\b(master|masters|m ?s|msc|mba|meng|ph ?d|doctor\w*|graduate)\b/.test(normalize(`${current.title} ${current.fieldOfStudy || ""}`));
    if (graduate)
      return field.options.length || field.kind === "combobox" || field.kind === "select"
        ? { value: "Graduate Student", choices: ["Graduate", "Graduate Student", "Grad Student", "Master's", "Masters", "Master's Student", "Graduate School", `${ordinal} Year Graduate`] }
        : { value: `${ordinal} year of graduate study` };
    const standing = ["Freshman", "Sophomore", "Junior", "Senior"][year - 1];
    return field.options.length || field.kind === "combobox" || field.kind === "select"
      ? { value: standing || `${ordinal} Year`, choices: [`${ordinal} Year`, `${year}${["st", "nd", "rd"][year - 1] || "th"} Year`] }
      : { value: standing ? `${ordinal} year (${standing})` : `${ordinal} year` };
  }
  // "Anticipated graduation month/year" comes from the latest education end
  // date; an ongoing program without an end date leaves it to the user.
  // "What year did you or, if you have not graduated, will you receive your
  // degree?" asks the same.
  // Amazon's: "In what month and year did you (or do you expect to) graduate
  // from your highest degree?"
  // an employer asks it as "Expected degree completion date" (Month, Day, Year),
  // and also names "your most recent graduation date" in the preamble of a
  // question that asks the highest degree received, which is not this
  // (report).
  if ((/\b(anticipated|expected|projected)\b.*\bgraduat|\bgraduation (date|month|year)\b|\bwill you (receive|earn|complete|be awarded) (your|the|a) degree\b|\bexpect to graduate\b|\b(anticipated|expected|projected) (degree )?completion date\b/.test(label)) &&
      !/\bwhat is (the |your )?highest (level of )?(education|degree|diploma)\b/.test(label)) {
    // Only a date still ahead is an anticipated graduation; a finished
    // degree's end date is not.
    const thisMonth = currentMonth();
    const latest = educationRow
      ? /^\d{4}-\d{2}/.test(educationRow.endDate) ? educationRow.endDate : undefined
      : profile.education
      .map((row) => row.endDate)
      .filter((date) => /^\d{4}-\d{2}/.test(date) && date.slice(0, 7) >= thisMonth)
      .sort()
      .at(-1);
    if (!latest) return;
    const [year, monthNumber] = latest.split("-");
    const month = months[Number(monthNumber) - 1];
    if (!month) return;
    const day = latest.match(/^\d{4}-\d{2}-(\d{2})$/)?.[1];
    // One part of a date split in three after its question: Oracle's "What is
    // your expected year of graduation? Month", "? Day" and "? Year" each got
    // the whole date, or the year.
    // (Workday's carry it as "<question>: Month".)
    // Or after a sentence: one employer's "…input the first of the month.: Month".
    const part = field.label.match(/(?:\?\s*:?|[.:]\s*:)\s*(month|day|year)\s*$/i)?.[1].toLowerCase();
    if (part === "year") return { value: year };
    if (part === "month") return { value: month, choices: [month.slice(0, 3), monthNumber, String(Number(monthNumber))] };
    // A day the profile does not hold is the 1st where the question says so.
    if (part === "day") return day ? { value: String(Number(day)), choices: [day] } : /\bfirst of the month\b/i.test(field.label) ? { value: "1", choices: ["01"] } : undefined;
    // A question for the month alone ("Please select your Graduation
    // Month", its year asked apart), or a list of only months, takes the
    // month: "December 2027" matched none of one employer's twelve.
    const monthsOnly = field.options.length >= 12 && field.options.every((option) => months.some((name) => normalize(option) === normalize(name) || normalize(option) === normalize(name.slice(0, 3))));
    if (monthsOnly || (field.options.length > 0 && /\bmonth\b/.test(label) && !/\byear\b/.test(label) && !/\bdate\b/.test(label)))
      return { value: month, choices: [month.slice(0, 3), monthNumber, String(Number(monthNumber))] };
    const span = monthSpan(field.options, year, Number(monthNumber));
    if (span) return { value: span };
    // A date picker takes a whole date, whatever its label asks: "2027" in
    // SuccessFactors' was invalid. Amazon's names its
    // format: "Date: Year-Month-Day".
    if (day && /\b(year month day|yyyy mm dd)\b/.test(label)) return { value: `${year}-${monthNumber}-${day}` };
    if (field.kind === "datepicker" && day) {
      const written = writtenDate(latest, { ...field, kind: "text" }, profile);
      return written ? { value: written } : undefined;
    }
    if (/\byear\b/.test(label) && !/\bmonth\b/.test(label))
      return { value: year };
    // A box that asks for a date takes the whole date when the profile has
    // the day: typed "May 2027", a date picker makes it the 1st (an Ashby
    // form showed 05/01/2027 for a profile date of the 10th).
    if (day && /\bdate\b/.test(label) && !/\bmonth\b/.test(label) && !field.options.length && /^(text|textbox|date)$/.test(field.kind))
    {
      const written = writtenDate(latest, field, profile);
      return written ? { value: written } : undefined;
    }
    // A list read only once opened (Oracle's) may hold quarters.
    const quarter = Math.floor((Number(monthNumber) - 1) / 3) * 3;
    return {
      value: `${month} ${year}`,
      choices: [
        `${month.slice(0, 3)} ${year}`,
        `${monthNumber}/${year}`,
        `${Number(monthNumber)}/${year}`,
        `${year}-${monthNumber}`,
        `${months[quarter]} - ${months[quarter + 2]} ${year}`,
      ],
    };
  }
  // "Education status" lists "Completed", "In progress" and the like: the
  // row's end date says which, and a row without one says nothing.
  if (
    /education/.test(normalize(field.section || "")) &&
    /^(education|degree|completion) status$/.test(label)
  ) {
    const end = profile.education[field.index || 0]?.endDate || "";
    if (!/^\d{4}-\d{2}/.test(end)) return;
    return end.slice(0, 7) <= currentMonth() && !profile.education[field.index || 0]?.current
      ? { value: "Completed", choices: ["Complete", "Graduated"] }
      : {
          value: "In progress",
          choices: ["Currently attending", "Currently enrolled", "Ongoing"],
        };
  }
  // "Share a link that showcases something you've built": a project or
  // portfolio link question answered with the profile's GitHub or website.
  if (
    /\b(link|url|website)\b/.test(label) &&
    /\b(built|shipped|projects?|portfolio|work samples?|showcases?|github)\b/.test(label) &&
    // Not one project told about ("a link to a recent project… include a
    // brief description… the challenges"): a profile link is no such answer.
    !/\b(a|one|your) (recent |favorite |favourite |single |specific |particular )?project\b|\bdescri(be|ption)\b|\bchallenges?\b|\btell us\b/.test(label) &&
    (profile.github || profile.website)
  )
    return {
      value: fullURL(
        /\b(portfolio|website)\b/.test(label)
          ? profile.website || profile.github || ""
          : profile.github || profile.website,
      ),
    };
  // A plain "Location" box outside any job or school row (Rippling) asks
  // where the applicant is: "City, State" as text.
  if (
    label === "location" &&
    !/work|employment|experience|education/.test(normalize(field.section || "")) &&
    /^(text|textbox)$/.test(field.kind) &&
    !field.options.length &&
    profile.city
  )
    return { value: [profile.city, profile.state].filter(Boolean).join(", ") };
  // Countries of citizenship listed one by one ("Country 1 Name",
  // one employer's SuccessFactors): the applicant's
  // citizenships in the order they listed them. "Country of citizenship"
  // asks for one, so it is answered only for a single citizenship.
  // The status held in it, "Type of Status 1", is a citizen's; left empty, the
  // site would not take the page.
  const citizenships = citizenshipsOf(profile).length
    ? citizenshipsOf(profile)
    : usCitizen(profile) ? ["US"] : [];
  const nth = label.match(/^country (1|one|2|two|3|three) name$/)?.[1];
  const listed = nth ? citizenships[{ 1: 0, one: 0, 2: 1, two: 1, 3: 2, three: 2 }[nth]!] : /^(country of citizenship|citizenship country)$/.test(label) && citizenships.length === 1 ? citizenships[0] : undefined;
  if (listed) {
    const name = countryNamesOf(geography, listed)[0];
    if (name) return { value: name === "United States" ? "United States" : name, choices: countryNames(name) };
  }
  if (/^type of status (1|one)$/.test(label) && citizenships.length)
    return { value: "Citizen", choices: [...citizenWordings, "Citizenship"] };
  // A school's or job's own City, State and Country are where it is, from its
  // row, never the applicant's home: Penn State's row got "Arizona", and the
  // school list it governs then held only Arizona's. Without a place for the row, nothing is said.
  const history = normalize(field.section || "");
  if (
    /work|employment|experience|education/.test(history) &&
    (countryLabel.test(label) || /^city$/.test(label) || /^(state|province)( (province|district|territory|region))*$/.test(label))
  ) {
    const row = (/education/.test(history) ? profile.education : profile.work)[field.index || 0];
    if (!row) return;
    const parts = (row.location || "").split(",").map((part) => part.trim()).filter(Boolean);
    const city = row.city || (parts.length > 1 ? parts[0] : "");
    const region = row.state || (parts.length > 1 ? parts[1] : "");
    const country = row.country || (parts.length > 2 ? parts[2] : placeCountry(geography, { region }));
    const found = findRegion(geography, region, country);
    if (/^city$/.test(label)) return city ? { value: city } : undefined;
    if (countryLabel.test(label))
      return country ? { value: country, choices: countryNames(country) } : undefined;
    if (!region) return;
    const name = found ? found.names[0] : region;
    return { value: name, choices: found ? [name, found.code] : [name] };
  }
  // A country chosen from a list may be listed under another of its names
  // ("United States" for the profile's "United States of America"; Greenhouse's
  // phone country list).
  if (countryLabel.test(label) && profile.country && (field.options.length || /combobox|listbox|select/.test(field.kind)))
    return { value: profile.country, choices: countryNames(profile.country) };
  // Location pickers search by city but list "City, State, Country".
  if (label === "address city region country" && profile.city && profile.country)
    return { value: [profile.city, profile.state, profile.country].filter(Boolean).join(", ") };
  if (
    /^(city|current city|location|location city|current location|where (do you( currently)? live|are you( currently)? (located|based)))( city( state)?( country)?)?$/.test(label) &&
    (label !== "location" || !/work|employment|experience|education/.test(normalize(field.section || ""))) &&
    profile.city
  ) {
    // A plain text box is written as asked: "Where are you currently
    // located? (City, State)" got the country too, from the list's wording.
    // A box that asks only for the city gets only the city: "Tucson" became
    // "Tucson, Arizona".
    if (/^(text|textbox)$/.test(field.kind) && !field.options.length && /^(current )?city$/.test(label))
      return { value: profile.city };
    if (/^(text|textbox)$/.test(field.kind) && !field.options.length)
      return {
        value: [profile.city, profile.state, /\bcountry\b/i.test(field.label) ? profile.country : ""].filter(Boolean).join(", "),
      };
    const countries = [
      profile.country,
      /united states|^usa?$/i.test(profile.country) ? "United States" : "",
    ].filter(Boolean);
    return {
      value: profile.city,
      choices: [
        ...countries.map((country) =>
          [profile.city, profile.state, country].filter(Boolean).join(", "),
        ),
        [profile.city, profile.state].filter(Boolean).join(", "),
      ],
    };
  }
  if (/^(state|province)( (province|district|territory|region))*$/.test(label) && profile.state) {
    const found = findRegion(geography, profile.state, profile.country || undefined);
    const code = found && normalize(found.code) !== normalize(profile.state) ? found.code : undefined;
    if (code) return { value: profile.state, choices: [code] };
  }
  // A school, major or degree asked of one level of study (JazzHR): "Highest Degree Earned/Pursuing", "Completion
  // date of your highest degree (mm/yyyy)", "Name of the School:
  // Undergraduate Degree", "Field of Study / Major: Graduate/MBA/PhD Degree".
  // "Earned" alone counts only a degree already finished.
  // Also as a sentence: "What is the highest level of education you have
  // completed?" (SuccessFactors).
  // Or as the last question after a preamble: "If hired by an employer, we will
  // verify your most recent graduation date and the highest degree or
  // diploma received. What is the highest level of education you've
  // received?".
  const lastAsk = normalize(field.label.match(/([^.?!]*\?)\s*$/)?.[1] || "");
  const highestPattern = /^(?:what is )?(?:the |your )?highest (?:level of )?(?:degree|education)(?: (?:that )?you (?:have|ve))?((?: (?:earned|obtained|completed|attained|received|pursuing|in progress))*)$/;
  const highest = label.match(highestPattern) || (lastAsk ? lastAsk.match(highestPattern) : null);
  if (highest) {
    const row = rowAtLevel(profile, "highest", !highest[1] || /pursuing|in progress/.test(highest[1]));
    return row ? { value: row.title, choices: degreeAliases(row.title) } : undefined;
  }
  // "Please select your degree type" (BA/BS, Masters, PhD, N/A) beside a
  // graduation month and year is the degree being finished, the highest
  // held or under way (one employer's SmartRecruiters screening).
  if (/^(?:please )?(?:select |choose |enter )?(?:your )?(?:degree type|type of degree|degree level|level of degree)$/.test(label)) {
    const row = rowAtLevel(profile, "highest");
    if (!row) return;
    if (!field.options.length) return { value: row.title, choices: degreeAliases(row.title) };
    const level = degreeLevel(row.title);
    const listed = field.options.filter((option) => degreeLevel(option) === level);
    return listed.length === 1 ? { value: listed[0] } : undefined;
  }
  // "Today's Date" beside the applicant's typed name: the day it is filled.
  if (/^(?:today s date|todays date|current date|today)$/.test(label) && !field.options.length) {
    const written = writtenDate(localDate(), field, profile);
    return written ? { value: written } : undefined;
  }
  const completion = label.match(/^(?:completion|graduation) date (?:of|for) (?:your )?highest degree( mm yyyy)?$/);
  if (completion && !field.options.length) {
    const end = rowAtLevel(profile, "highest")?.endDate.match(/^(\d{4})-(\d{2})/);
    if (!end) return;
    const month = months[Number(end[2]) - 1];
    return completion[1] || !month ? { value: `${end[2]}/${end[1]}` } : { value: `${month} ${end[1]}` };
  }
  // Inside a row of a Languages section (Workday's): that language's skills
  // take its level, and "I am fluent in this language" says whether it is
  // fluent. an employer names the overall
  // level "All".
  if (/^languages?$/.test(normalize(field.section || "")) && profile.languages?.length) {
    const row = profileLanguages(profile.languages)[field.index || 0];
    if (row && /\bfluent\b/.test(label) && field.kind === "checkbox") return { value: isFluent(row) ? "Yes" : "No" };
    if (row?.level && /^(all|comprehension|overall|reading|speaking|writing|listening|level|proficiency)$/.test(label)) {
      const choices = levelChoices(row.level);
      return { value: choices[0], choices };
    }
  }
  // "Languages" or "What languages do you speak?" as one text box: each
  // language with how well, from the profile's list.
  if (/^(languages?( spoken)?|(what|which) languages? (do|can) you (speak|read|write)\b.*)$/.test(label) && profile.languages?.length && /^(text|textbox|textarea)$/.test(field.kind) && !field.options.length) {
    const spoken = profileLanguages(profile.languages).map((row) => (row.level ? `${row.language} (${row.level[0].toUpperCase()}${row.level.slice(1)})` : row.language));
    return spoken.length ? { value: spoken.join(", ") } : undefined;
  }
  // "What area was your major in?": the program being studied now,
  // the one ending last. The model answered with the finished degree's.
  if (/^what (area|field|subject) (was|is) your major( in)?$|^what (was|is) your major$/.test(label)) {
    const current = profile.education.filter((row) => row.fieldOfStudy && /^\d{4}-\d{2}/.test(row.endDate)).sort((a, b) => a.endDate.localeCompare(b.endDate)).at(-1);
    return current?.fieldOfStudy ? { value: current.fieldOfStudy, choices: nameVariants(current.fieldOfStudy).slice(0, 1) } : undefined;
  }
  const leveled = label.match(/^(?:name of (?:the |your )?)?(school|university|college|institution|field of study(?: major)?|major)(?: name)? (?:for )?(?:your )?(undergraduate|bachelor s?|graduate(?: mba)?(?: phd)?|master s?) degree$/);
  if (leveled) {
    const row = rowAtLevel(profile, /^(undergraduate|bachelor)/.test(leveled[2]) ? "undergraduate" : "graduate");
    if (!row) return;
    if (/field of study|major/.test(leveled[1])) return row.fieldOfStudy ? { value: row.fieldOfStudy } : undefined;
    return { value: row.organization, choices: schoolChoices(row) };
  }
  // Expected pay: hourly when the question asks per hour, yearly when it
  // asks per year; a plain salary question gets the yearly figure, or the
  // hourly one said as hourly. A list of ranges is left to the applicant.
  if (/\b(salary|compensation|pay|wage|rate)\b/.test(label) &&
      /\b(expect\w*|desired|requirements?|range|target|looking for)\b/.test(label) &&
      !field.options.length && !/^(checkbox|radio|select)$/.test(field.kind)) {
    // A box that takes only a number gets the figure alone.
    return salaryAnswer(profile.salary, { label, numeric: numberOnly(field) });
  }
  // A GPA is its own row's, on that row's scale: the row asked about, or
  // the program held now or ended last.
  const gpaRow = educationRow ?? latestRow(profile.education.filter((row) => row.gpa?.trim()));
  const gpa = gpaRow?.gpa?.trim() || "";
  // The scale a question states ("out of 4.0", "on a 10-point scale",
  // "percentage"), when it states one.
  const statedScale = (text: string) =>
    /\bpercent\w*\b|\bout of 100\b|\b100 ?point\b/.test(text) ? "100"
      : /\bout of 10(\.0)?\b|\b10(\.0)? ?point\b|\bcgpa\b/.test(text) ? "10"
        : /\bout of 5(\.0)?\b|\b5(\.0)? ?point\b/.test(text) ? "5"
          : /\bout of 4(\.0)?\b|\b4(\.0)? ?point\b|\b4 0 scale\b/.test(text) ? "4" : undefined;
  // "Do you meet the minimum GPA requirement of 3.0?" (one employer's Oracle form): a yes/no threshold, answered by comparing only when
  // the applicant's GPA is on the scale the question uses (four points
  // unless it says otherwise). Higher is better on these scales; a scale
  // the applicant called "other" (where 1.0 may be the best) never is.
  const floor = field.label.match(/\b(?:c?gpa|grade point average)\b[^?]*?\b(\d{1,2}(?:\.\d{1,2})?)\b|\b(\d{1,2}(?:\.\d{1,2})?)\b[^?]*?\b(?:c?gpa|grade point average)\b/i);
  // Also when the options are not read yet (a Workday list shows them only
  // once opened): "Do you have a 3.0 gpa or higher?" got the profile's
  // "3.84", which no Yes/No list holds (Morningstar).
  if (floor && /\b(minimum|at least|or (higher|above|better|greater)|meet|above|exceed)/i.test(field.label) &&
      (!field.options.length ||
        (field.options.some((option) => normalize(option) === "yes") && field.options.some((option) => normalize(option) === "no")))) {
    const threshold = Number(floor[1] || floor[2]);
    const scale = statedScale(label) || (threshold <= 4 ? "4" : undefined);
    const value = Number(gpa);
    if (!gpa || !Number.isFinite(value) || !scale || gpaRow?.gpaScale !== scale) return;
    return { value: value >= threshold ? "Yes" : "No" };
  }
  if (
    /\b(c?gpa|grade point average)\b/.test(label) &&
    !/\b(scale|maximum|max|weighted)\b/.test(label) &&
    gpa &&
    (!educationRow || educationRow.gpa?.trim())
  ) {
    // A question on another scale than the row's is left: a GPA is never
    // converted. A range list ("3.5 - 3.74") is a four-point one.
    const asked = statedScale(label);
    if (asked && asked !== gpaRow?.gpaScale) return;
    if (!asked && field.options.length && gpaRow?.gpaScale !== "4") return;
    return { value: gpa, ...(gpaRow?.gpaScale === "4" || asked ? { numeric: Number(gpa) } : {}) };
  }
  // The scale itself, when asked: "GPA scale", "out of".
  if (/\b(c?gpa|grade point average)\b/.test(label) && /\b(scale|out of|maximum|max)\b/.test(label) && gpaRow?.gpaScale && gpaRow.gpaScale !== "other" && gpa)
    return { value: gpaRow.gpaScale, choices: [`${gpaRow.gpaScale}.0`], numeric: Number(gpaRow.gpaScale) };
  if (
    (/\bhow many\b.*\b(internships?|co ?ops?)\b/.test(label) ||
      /^(number of )?(prior |previous )?(internships?|co ?ops?)( completed)?$/.test(label)) &&
    profile.internshipCount
  ) {
    const count = Number(profile.internshipCount);
    return {
      value: String(count),
      numeric: count,
      choices: count === 0 ? ["None", "Zero", "0"] : undefined,
    };
  }
  // "How many years of work experience do you have?":
  // the months the profile's jobs cover, each month once however many jobs
  // share it, up to this month. A question about one role or skill ("as a
  // Data Analyst", "with Python") is another question.
  // "Did you obtain this degree in the last 24 months?" after a question for
  // the highest degree received: that degree, finished,
  // and when.
  const recent = label.match(/\b(?:did you )?(?:obtain|receive|earn|complete|get)\w* (?:this|that|the|your) degree (?:in|within) the (?:last|past) (\d+) (month|year)s?\b/);
  if (recent) {
    const thisMonth = currentMonth();
    const finished = profile.education
      .filter((row) => /^\d{4}-\d{2}/.test(row.endDate) && row.endDate.slice(0, 7) <= thisMonth && !row.current)
      .sort((a, b) => levelRank[degreeLevel(b.title)] - levelRank[degreeLevel(a.title)] || b.endDate.localeCompare(a.endDate))[0];
    if (finished) {
      const [year, month] = finished.endDate.split("-").map(Number);
      const [nowYear, nowMonth] = thisMonth.split("-").map(Number);
      const since = (nowYear - year) * 12 + (nowMonth - month);
      const limit = Number(recent[1]) * (recent[2] === "year" ? 12 : 1);
      return { value: since <= limit ? "Yes" : "No" };
    }
  }
  // Where the applicant would move from, asked as a place: "…please tell us
  // the city, state, and zip code you'd be moving from" was answered "Yes", as relocation is.
  if ((field.kind === "text" || field.kind === "textarea") && profile.city &&
      (/\bcity\b.*\bstate\b.*\b(zip|postal)\b/.test(label) || /\b(moving|relocating) from\b/.test(label))) {
    const place = [profile.city, [profile.state, profile.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    return { value: place };
  }
  // Years with one skill or in one kind of work ("…professional work
  // experience with the following: C/C++", "…designing HPC…", one employer's iCIMS) are never more than the applicant's years of work in all:
  // a list's "less than N years" is true when all of it is under N. Any
  // other choice needs the applicant.
  if (field.options.length && !/^how many years of (total |overall |professional |work |paid )*(work )?experience do you have$/.test(label) &&
      /\byears of (professional |work |relevant |hands on )*(work )?experience\b|\bprofessional (work )?experience\b.*\b(following|with|in)\b|\byears (of experience )?(with|in|using|designing|building|working)\b/.test(label)) {
    const total = totalWorkYears(profile);
    if (total !== undefined) {
      const under = field.options.filter((option) => {
        const bound = option.match(/\b(?:less than|under|fewer than|below)\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\b/i);
        return bound && total < Number(bound[1]);
      });
      if (under.length === 1) return { value: under[0] };
    }
  }
  if (/^how many years of (total |overall |professional |work |paid )*(work )?experience do you have$/.test(label)) {
    const years = totalWorkYears(profile);
    if (years !== undefined) return { value: String(years), numeric: years };
  }

  // Demographic answers the profile holds. Each option is read the same way
  // as the profile's answer and chosen only when it states the same thing;
  // "(Not Hispanic or Latino)" is dropped first so "White (Not Hispanic or
  // Latino)" reads as White. An answer no option states is left alone.
  // The disability form (CC-305) can ask only "Please check one of the boxes
  // below:"; then its options ask it, one having a disability and one not.
  const disabilityOptions = field.options.filter((option) => /\bdisabilit/i.test(option));
  const demographic =
    (
      [
        [/\bhispanic\b|\blatin[oa]x?\b/, "hispanic"],
        [/\brace\b|\bethnicit/, "ethnicity"],
        [/\bgender\b|^sex$/, "gender"],
        [/\bveterans?\b/, "veteranStatus"],
        [/\bdisabilit/, "disabilityStatus"],
      ] as const
    )
      // The topic named first: one employer's "Race/Ethnicity" defines its race
      // categories after its name, "Hispanic or Latino" first among them,
      // and was read as the Hispanic question and left.
      .map(([pattern, topic]) => ({ topic, at: label.search(pattern) }))
      .filter((found) => found.at >= 0)
      .sort((a, b) => a.at - b.at)[0]?.topic ||
    (["Yes", "No"].every((answer) =>
      disabilityOptions.some((option) => readOption("disabilityStatus", option) === answer),
    )
      ? "disabilityStatus"
      : undefined);
  // A definition after a group's name ("Asian … A person having origins in …
  // the Indian Subcontinent") names other groups' places: only the name is
  // read.
  const groupName = (option: string) =>
    option
      .replace(/\(\s*not hispanic[^)]*\)/i, "")
      .replace(/(?<=\S\s*)\b(a person|all persons|persons) (of|having|who)\b.*$/is, "");
  // The profile's demographic answers are for U.S. equal-opportunity
  // questions. Another country's (the UK's Equality Act, Canada's
  // employment equity, a caste or an Indigenous identity) defines its groups
  // and terms differently, and is left to the applicant.
  // The U.S. form's own race definitions ("A person having origins in any
  // of the original peoples of the Far East … China, India, Japan") name
  // places that are no other country's question: one employer's Race/Ethnicity
  // label carried them and was left.
  const definedAway = `${field.question || ""} ${field.label}`.replace(/\b(a person|all persons) (of|having origins in|who identify)\b[^.]*?(?=\b(hispanic|white|black|native hawaiian|asian|american indian|two or more)\b|$)/gis, " ")
    // Nor do its own category names ("American Indian" is not India's).
    .replace(/\b(american indian|alaska(n)? native|native hawaiian|pacific islander)\b/gi, " ");
  if (demographic && (
    countriesNamed(geography, definedAway).some((country) => country !== "US") ||
    /\b(equality act|employment equity|visible minorit\w*|aboriginal|torres strait|first nations|indigenous|metis|inuit|caste|scheduled (caste|tribe)|socio ?economic|religio\w*)\b/.test(normalize(`${field.question || ""} ${field.label}`))
  )) return;
  // Workday lists each answer as its own checkbox ("No, I do not have a
  // disability…"): the box is ticked when its own label states the answer.
  if (demographic && field.kind === "checkbox") {
    const answer = canonicalAnswer(demographic, profile[demographic]);
    if (!answer) return;
    const stated = readOption(demographic, groupName(label));
    return { value: stated === answer ? "Yes" : "No" };
  }
  // A race list whose options load only when it opens (Greenhouse's
  // "Please identify your race", a report): the answer and the
  // ways US lists word it, matched when the list opens. A plain "Asian"
  // answers for East, South and Southeast Asian, as above; an exact option
  // still wins over it.
  if (demographic === "ethnicity" && !field.options.length && /combobox|listbox/.test(field.kind)) {
    const answer = canonicalAnswer("ethnicity", profile.ethnicity);
    const wordings: Record<string, string[]> = {
      "African American": ["Black or African American"],
      "Hispanic/Latinx": ["Hispanic or Latino"],
      "Native American": ["American Indian or Alaska Native", "American Indian or Alaskan Native"],
      "Pacific Islander": ["Native Hawaiian or Other Pacific Islander"],
      White: ["White"],
      "Two or More": ["Two or More Races"],
      "East Asian": ["Asian"],
      "South Asian": ["Asian"],
      "Southeast Asian": ["Asian"],
    };
    const names = wordings[answer];
    if (!names) return;
    // Workday adds the country: "Asian (Not Hispanic or Latino) (United
    // States of America)".
    return { value: answer, choices: names.flatMap((name) => [name, `${name} (Not Hispanic or Latino)`,
      `${name} (United States of America)`, `${name} (Not Hispanic or Latino) (United States of America)`]) };
  }
  if (demographic && field.options.length) {
    const answer = canonicalAnswer(demographic, profile[demographic]);
    if (!answer) return;
    const read = (option: string) => readOption(demographic, groupName(option));
    let choices = field.options.filter((option) => read(option) === answer);
    // US lists have one "Asian" for the profile's East, South and Southeast
    // Asian; it answers for each when the list names none of them.
    if (!choices.length && / Asian$/.test(answer))
      choices = field.options.filter(
        (option) =>
          read(option) === "East Asian" &&
          /\basian\b/i.test(groupName(option)) &&
          !/\b(east|south|southeast|central|west)\b/i.test(groupName(option)),
      );
    // "Not a protected veteran" is true of someone who never served and of
    // a veteran outside the protected groups, and a list may word the two
    // apart: one employer's offered "I am a veteran but do not fall under the
    // protected classifications" and "I have no military experience", and
    // the first was chosen for someone who never served. The saved military answer decides; without it, only a
    // wording that says neither is taken.
    if (demographic === "veteranStatus" && answer === "No") {
      const neverServed = (option: string) => /\b(no (prior )?military|never served|not a veteran|have not served|no service)\b/i.test(option);
      const served = (option: string) => /\bi (am|identify as) an? (\w+ )?veteran\b/i.test(option);
      const military = plainAnswer(profile.answers.find((saved) => questionTopic(saved.question) === "military")?.answer);
      if (military === "No") {
        const never = choices.filter(neverServed);
        choices = never.length ? never : choices.filter((option) => !served(option));
      } else if (military === "Yes") choices = choices.filter((option) => !neverServed(option));
      else choices = choices.filter((option) => !served(option) && !neverServed(option));
    }
    // Only options that read as a plain decline; the generic decline match
    // would also take one that states a group.
    if (answer === "Decline")
      return choices.length ? { value: "Decline to answer", choices } : undefined;
    return choices.length ? { value: answer, choices } : undefined;
  }
  // "Which university are you currently attending or did you last attend?":
  // the school question as a sentence. Only the listed school is chosen; one
  // the list lacks is left for the applicant to put under "Other".
  // The school attended now, else the one attended last.
  const lastSchool = latestRow(profile.education.filter((row) => row.organization));
  const school = lastSchool?.organization;
  if (
    lastSchool && school &&
    /^(which|what) (university|college|school)( or (university|college))? (are you|do you|did you)\b.*\b(attend\w*|enrolled|graduat\w*)\b/.test(normalize(askedPart(field.label))) &&
    !/\bhigh school\b/.test(label)
  )
    return { value: school, choices: schoolChoices(lastSchool) };
  // Asked of the question itself: the notes after it ("Please select Yes if
  // you will require the company to… in order to work") read like a second
  // question and are not one.
  // A saved "Never a government employee or public official" answers whether
  // the applicant has worked for a government entity: No. The model, held to
  // the saved words, found no source for "government entity". Military service, relatives and clearances
  // are other questions, left to it.
  const governmentAsked = normalize(askedPart(field.label));
  if (
    /^never\b/i.test((profile.legal?.government || "").trim()) &&
    /^(have|are|were|did) you\b/.test(governmentAsked) &&
    /\b(work\w*|employ\w*|serv\w*)\b/.test(governmentAsked) &&
    /\bgovernment (entity|entities|agency|agencies|employee|employer|organization|body|bodies|office)|\bpublic (official|office)\b/.test(governmentAsked) &&
    // (Of the whole question: "(This includes military service)" is a note.)
    !/\b(military|armed forces|veteran|relative|family|spouse|friend|clearance)\b/.test(label)
  )
    return { value: "No" };
  // "Are you eligible to obtain a U.S. security clearance? This is typically
  // based on having U.S. citizenship and … a background investigation": a
  // citizen with no convictions is, by the applicant's own saved details. It
  // left alone, the site's stored "No" stood. Holding one, and what could prevent one, are other questions.
  const clearanceAsked = normalize(askedPart(field.label));
  if (
    /^(are|would) you\b.*\b(eligible|able|qualified) to (obtain|get|receive|be granted|acquire)\b.*\bclearance\b/.test(clearanceAsked) &&
    usCitizen(profile) &&
    /^no\b/i.test((profile.legal?.criminal || "").trim())
  )
    return { value: "Yes" };
  // And by the same details nothing known stands in the way of one: "Are you
  // aware of anything that may prevent you from obtaining a government
  // security clearance?".
  if (
    /^(are you aware|do you know|is there)\b.*\b(prevent|disqualify|keep|stop)\w*\b.*\bclearance\b/.test(clearanceAsked) &&
    usCitizen(profile) &&
    /^no\b/i.test((profile.legal?.criminal || "").trim())
  )
    return { value: "No" };
  const screening = screeningQuestion(normalize(askedPart(field.label)));
  // Remote menus have no options until opened. The confirmed binary answer
  // can reach that menu; the page still requires one exact matching option.
  const remoteBinary = ["combobox", "listbox"].includes(field.kind) &&
    /^(are|do|will|would|can)\b/.test(normalize(askedPart(field.label))) &&
    // "…to work in the country in which you are applying" names no country
    // (one employer's Greenhouse form); "which country" asks one.
    !/\b(temporary|present employer|current employer|country|location|netherlands|portugal|proof|document|permit type)\b/.test(
      normalize(askedPart(field.label))
        .replace(/\b(in )?the country (in which|where|to which|for which) you (are|will be|would be) (applying|working|located)( for (a|the|this) (position|role|job))?\b/, "")
        // "…in the country or jurisdiction where the position to which you
        // are applying is located" (one employer's Workday).
        .replace(/\b(in )?the country or jurisdiction (where|in which) the (position|role|job) (to which|for which) you are applying is located\b/, "")
        // "…to legally work in the location associated with this job posting"
        // (one employer's form) names none either.
        .replace(/\b(in )?the (location|region|geographic region|country)( associated with| of| specified for| for) (this|the) (job|role|position|posting|job posting|internship)\b/, "")
        // "…in the country/region you are applying for?" (Microsoft's
        // careers site).
        .replace(/\b(in )?the country (or )?region (you are|you re|that you are) applying (for|to)\b/, "")
        // "…to work in that country? e.g. (work permit)" follows "…in the
        // country where this position is located?" (one employer's Workday): the job's country again.
        .replace(/\b(in )?that country\b/, ""),
    );
  if (screening && (field.options.length || remoteBinary)) {
    const answer = authorizationAnswer(profile, askedPart(field.label), screening.field);
    if (answer !== "Yes" && answer !== "No") return;
    // These sentence choices state additional facts. Match their complete
    // wording only when the answer bank explicitly confirms those facts;
    // a generic binary answer never chooses an immigration status.
    const question = normalize(askedPart(field.label));
    const confirmedSaved = (pattern: RegExp, wanted: string) => {
      const answers = profile.answers.filter(saved => pattern.test(normalize(saved.question)));
      return answers.length > 0 && answers.every(saved => normalize(saved.answer) === wanted);
    };
    const citizenOption = citizenAuthorizationOption;
    const visaOption = visaAuthorizationOption;
    // The applicant's U.S. status, which these U.S. sentences state.
    const usStatus = workAuthorizations(profile).find((entry) => entry.country === "US")?.status;
    const permanent = usStatus === "citizen" || usStatus === "permanent-resident";
    const entries = workAuthorizations(profile);
    const aboutUS = (askedCountry(askedPart(field.label)) || jobCountry(profile) || (entries.length === 1 ? entries[0].country : "")) === "US";
    if (screening.field === "workAuthorization" && answer === "Yes" &&
      citizenAuthorizationQuestion.test(question) &&
      field.options.some(option => [citizenOption, visaOption].some(value => normalize(option) === normalize(value)))) {
      const wanted = confirmedSaved(/^are you a (us|u s|united states) citizen$/, "yes") || permanent
        ? citizenOption
        : usStatus === "visa" ? visaOption : undefined;
      const exact = wanted && field.options.find(option => normalize(option) === normalize(wanted));
      return exact ? { value: exact } : undefined;
    }
    if (screening.field === "sponsorship" && !screening.invert && qualifiedBinaryField(field) === "sponsorship") {
      if (answer === "Yes") {
        // Generic sponsorship Yes does not establish an existing transferable
        // visa or a need for new sponsorship. A literal plain Yes is sufficient.
        if (!field.options.some(option => normalize(option) === "yes")) return;
      } else {
        // A U.S. citizen or permanent resident will never need it there.
        if (!confirmedSaved(futureSponsorshipQuestion, "no") && !(permanent && aboutUS)) return;
        const exact = field.options.find(option => normalize(option) === normalize(completeFutureNo));
        if (exact) return { value: exact };
        // A single No-prefixed alternative that leaves future sponsorship
        // possible does not answer the confirmed now-or-future question.
        const supported = field.options.some(option => ["No", "I do not and will not require sponsorship at any point in the future in order to work in the US"].some(value => normalize(option) === normalize(value)));
        if (!supported) return;
      }
    }
    // A list that words it "Authorized" / "Not Authorized" (one employer's
    // Workday) is the same Yes and No.
    const said = screening.invert ? (answer === "Yes" ? "No" : "Yes") : answer;
    if (screening.field === "workAuthorization" && !screening.invert) {
      const worded = field.options.find((option) => said === "Yes" ? /^\s*authori[sz]ed\s*$/i.test(option) : /^\s*not authori[sz]ed\s*$/i.test(option));
      if (worded) return { value: worded };
    }
    return {
      value: said,
      choices: screening.field === "sponsorship" && !screening.invert && answer === "No" && aboutUS
        ? ["I do not and will not require sponsorship at any point in the future in order to work in the US"] : undefined,
    };
  }
  // How the applicant says their name, in their own spelling of it.
  if (/\b(pronunciation|pronounciation|phonetic)\b/.test(label) && profile.namePronunciation && !field.options.length)
    return { value: profile.namePronunciation };
  // Their age today, from the date of birth: a number, or the range a list offers.
  if (/^(what is )?(your )?(current )?age( range| group| bracket)?$|^how old are you$/.test(label) && /^\d{4}-\d{2}-\d{2}$/.test(profile.dateOfBirth)) {
    const [year, month, day] = profile.dateOfBirth.split("-").map(Number);
    const now = new Date();
    const age = now.getFullYear() - year - (now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day) ? 1 : 0);
    if (age >= 14 && age < 120) return { value: String(age), numeric: age };
    return;
  }
  for (const [pattern, key] of [
    [/\bpronouns?\b/, "pronouns"],
    [/\bsexual orientation\b|^orientation$/, "sexualOrientation"],
    [/\btransgender\b/, "transgender"],
  ] as const)
    if (pattern.test(label)) {
      const answer = canonicalAnswer(key, profile[key]);
      if (!answer) return;
      if (answer === "Decline") return { value: "Decline to answer", decline: true };
      return { value: answer, choices: choiceSynonyms[answer] };
    }
}

// Page rows of a repeated section paired with profile rows by what the page
// rows already say (a school, a major), as sites can pre-fill rows from a
// parsed resume in their own order. Rows with no evidence keep position.
export function historyRowMap(fields: Field[], profile: Profile) {
  const map = new Map<string, number>();
  for (const [collection, rows] of [
    ["education", profile.education],
    ["work", profile.work],
  ] as const) {
    const pageRows = new Map<number, Field[]>();
    for (const field of fields)
      if (
        (collection === "education"
          ? /education/
          : /work|experience|employment/
        ).test(normalize(field.section || ""))
      )
        pageRows.set(field.index || 0, [
          ...(pageRows.get(field.index || 0) || []),
          field,
        ]);
    if (pageRows.size < 2 || rows.length < 2) continue;
    const matches = (value: string, wanted: string) =>
      Boolean(value && wanted) &&
      (value === wanted || value.includes(wanted) || wanted.includes(value));
    const pairs: { page: number; row: number; score: number }[] = [];
    for (const [page, pageFields] of pageRows) {
      // A site's guesses from a parsed resume are no evidence of which
      // profile row a page row holds; only the applicant's entries are.
      const said = (pattern: RegExp) =>
        pageFields
          .filter(
            (field) =>
              pattern.test(normalize(field.label)) && field.value && !field.siteValue,
          )
          .map((field) => normalize(field.value));
      const names = said(
        collection === "education"
          ? /school|university|institution|college/
          : /company|employer|organization/,
      );
      const details = said(
        collection === "education" ? /major|discipline|field of study/ : /title|position/,
      );
      rows.forEach((row, index) => {
        const score =
          (names.some((value) => matches(value, normalize(row.organization))) ? 2 : 0) +
          (details.some((value) =>
            matches(value, normalize(row.fieldOfStudy || row.title)),
          )
            ? 1
            : 0);
        if (score) pairs.push({ page, row: index, score });
      });
    }
    if (!pairs.length) continue;
    const usedRows = new Set<number>();
    const usedPages = new Set<number>();
    for (const pair of pairs.sort((a, b) => b.score - a.score || a.page - b.page))
      if (!usedRows.has(pair.row) && !usedPages.has(pair.page)) {
        map.set(`${collection}:${pair.page}`, pair.row);
        usedRows.add(pair.row);
        usedPages.add(pair.page);
      }
    const freeRows = rows.map((_, index) => index).filter((index) => !usedRows.has(index));
    for (const page of [...pageRows.keys()].sort((a, b) => a - b))
      if (!usedPages.has(page) && freeRows.length)
        map.set(`${collection}:${page}`, freeRows.shift()!);
  }
  return map;
}

// A US school by its saved place: a row's country, or a state ending its
// location ("Tucson, AZ", "University Park, Pennsylvania").
function usSchool(row: Profile["education"][number]): boolean | undefined {
  if (row.country) return countryCode(geography, row.country) === "US";
  const region = row.state || row.location.split(",").at(-1)?.trim() || "";
  if (!region) return;
  const country = placeCountry(geography, { region });
  return country ? countryCode(geography, country) === "US" : undefined;
}

// A school list without the applicant's school, followed by a box for the
// name of one chosen as "Other" (JazzHR, one employer's form: the
// applicant asked for Other and the name): the list's Other, and the name.
// Of several Others ("US Based", "International"), the one for where the
// school is; when that cannot be told, both are left.
function otherSchool(fields: Field[], profile: Profile, answered: Set<string>): Proposal[] {
  const open = (field: Field) => !field.protected && (!field.value || field.siteValue);
  return fields.flatMap((field, index) => {
    if (!field.options.length || answered.has(field.id) || !open(field)) return [];
    const label = normalize(field.label);
    const leveled = label.match(/^(?:name of (?:the |your )?)?(?:school|university|college|institution)(?: name)? (?:for )?(?:your )?(undergraduate|bachelor s?|graduate(?: mba)?(?: phd)?|master s?) degree$/);
    const row = leveled
      ? rowAtLevel(profile, /^(undergraduate|bachelor)/.test(leveled[1]) ? "undergraduate" : "graduate")
      : schoolNameQuestion(field.label) && !field.section ? profile.education[field.index || 0] : undefined;
    if (!row?.organization) return [];
    const named = fields.slice(index + 1, index + 3).find((next) =>
      /^(text|textbox)$/.test(next.kind) && !next.options.length &&
      /^if you (selected|chose|picked) other\b.*\b(name|school|university|college|institution)\b/.test(normalize(next.label)));
    if (!named || !open(named)) return [];
    const others = field.options.filter((option) => /^other\b/.test(normalize(option)));
    const us = usSchool(row);
    const other = others.length === 1
      ? others[0]
      : us === undefined
        ? undefined
        : others.find((option) => (us ? /\b(us|u s|usa|united states|domestic)\b/ : /\b(international|outside|non us|foreign)\b/).test(normalize(option)));
    if (!other) return [];
    return [
      { fieldId: field.id, value: other, expectedValue: field.value, revision: field.revision, source: "confirmed-profile" as const },
      { fieldId: named.id, value: row.organization, expectedValue: named.value, revision: named.revision, source: "confirmed-profile" as const },
    ];
  });
}

export function proposals(fields: Field[], profile: Profile): Proposal[] {
  const found = ownProposals(fields, profile);
  const answered = new Set(found.map((proposal) => proposal.fieldId));
  return [...found, ...otherSchool(fields, profile, answered).filter((proposal) => !answered.has(proposal.fieldId))];
}

function ownProposals(fields: Field[], profile: Profile): Proposal[] {
  const rowMap = historyRowMap(fields, profile);
  return fields.flatMap((original) => {
    const section = normalize(original.section || "");
    const collection = /education/.test(section)
      ? "education"
      : /work|experience|employment/.test(section)
        ? "work"
        : "";
    const mapped = rowMap.get(`${collection}:${original.index || 0}`);
    // Answers come from the profile row paired with this page row.
    const field = mapped === undefined ? original : { ...original, index: mapped };
    // "If other, enter School Name" counts only beside a list set to Other,
    // which the site's rules choose when the list lacks the answer; written
    // beside a list holding the school, it reads as two answers (Expand
    // Energy).
    if (/^if other\b/.test(normalize(field.label))) return [];
    // One box of a "select all that apply" list is a choice, not a
    // question of its own: one employer's sanctions list had "Ordinarily a
    // resident of Russia or Belarus and not willing to relocate…" ticked as a
    // relocation question, and its follow-up's "U.S. citizen" as one of
    // citizenship. Such lists are read as what they are (see
    // listChoice); other legal lists, and those depending on an earlier
    // answer, are the applicant's.
    const choice = listChoice(field, profile);
    if (choice === "leave") return [];
    if (
      field.protected ||
      (field.value && !field.siteValue) ||
      /file|password|hidden/.test(field.kind)
    )
      return [];
    const special = choice || profileAnswer(field, profile);
    let answer: Answer | undefined =
      special ||
      (() => {
        const value = deterministicAnswer(field, profile);
        return value ? { value } : undefined;
      })();
    if (!answer?.value) {
      // A second line the site kept belongs to the address it kept, not to
      // the profile's, which has none: under the profile's street it is
      // wrong, so it is emptied.
      const keptSecondLine = Boolean(profile.address) && secondAddressLine.test(normalize(field.label));
      // A job the profile says was remote has no place: a city the site's
      // parser gave it is another job's ("Hyderabad" under a remote job,
      // one employer's iCIMS), so it is emptied.
      const section = normalize(field.section || "");
      const remotePlace = !/education/.test(section) && /experience|employment|work|job/.test(section) &&
        /^\s*remote\s*$/i.test(profile.work[field.index || 0]?.location || "") &&
        /^(city|(street )?address( line)?( 1| one)?|state|province|county|(zip|postal)( code)?( zip)?)$/.test(normalize(field.label)) &&
        field.kind !== "select" && field.kind !== "combobox";
      if (!field.siteValue || !(keptSecondLine || remotePlace)) return [];
      answer = { value: "" };
    }
    if (
      !special &&
      (field.kind === "combobox" || field.options.length > 0) &&
      (/education/.test(normalize(field.section || "")) || schoolNameQuestion(field.label) || /^(degree|major|discipline|field of study)$/.test(normalize(field.label)))
    )
      answer = {
        ...answer,
        choices: /^degree$/.test(normalize(field.label))
          ? degreeAliases(answer.value)
          : schoolNameQuestion(field.label)
            ? schoolChoices(profile.education[field.index || 0] || { organization: answer.value, location: "" })
            : nameVariants(answer.value),
      };
    // A list that shows its options only once opened is given the standing
    // question's wordings too, to pick by there.
    if (!field.options.length && !special && /combobox|listbox|select/.test(field.kind)) {
      const standing = standingAnswer(field, profile);
      if (standing?.choices?.length) answer = { ...answer, choices: [...new Set([...(answer.choices || []), ...standing.choices])] };
    }
    if (field.options.length) {
      let option: string | undefined;
      let refused = false;
      try {
        option = pickOption(answer, field.options, (o) => o);
      } catch {
        refused = true;
      }
      // A saved answer worded as this very question ("Military status": No)
      // that no option says outright is read as its standing question,
      // which knows how lists word it ("No Military", an employer).
      const standing = !option && !special ? standingAnswer(field, profile) : undefined;
      if (standing)
        try {
          option = pickOption(standing, field.options, (o) => o);
        } catch {
          /* still none */
        }
      if (refused && !option) return [];
      // A list too long to be sent whole is matched on the page instead,
      // against every option, with the same rules.
      if (!option && !((field.optionCount || 0) > field.options.length)) return [];
      if (option) answer = { value: option };
    }
    // An unchecked box already says No; writing it again changes nothing.
    if (field.kind === "checkbox" && answer.value === "No" && !field.value) return [];
    // A value the site pre-filled is replaced only when it differs, from the
    // answer and from every wording of it ("Masters" for "Masters of
    // Science", an employer).
    if (field.siteValue && [answer.value, ...(answer.choices || [])].some((wording) => normalize(wording) === normalize(field.value)))
      return [];
    return [
      {
        fieldId: field.id,
        ...answer,
        expectedValue: field.value,
        revision: field.revision,
        source: "confirmed-profile",
      },
    ];
  });
}
// The access to ask Chrome for when a page at this origin is to be read: its
// whole site. One application crosses hosts of one site (a posting on www,
// the apply steps on another host, a frame on a third), and each asked for
// separately is a prompt per page. Hosts that many unrelated sites share, and
// addresses with no site to speak of, are asked for alone.
const sharedHosts = /(^|\.)(github\.io|herokuapp\.com|vercel\.app|netlify\.app|web\.app|pages\.dev|azurewebsites\.net|appspot\.com|amazonaws\.com|cloudfront\.net)$/;
export function accessPattern(origin: string): string {
  const url = new URL(origin);
  const labels = url.hostname.split(".");
  const own = `${url.origin}/*`;
  if (url.port || labels.length < 2 || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":") || sharedHosts.test(url.hostname))
    return own;
  // "example.co.uk" is a site; "co.uk" is not.
  const compound = labels.at(-1)!.length === 2 && /^(co|com|org|net|ac|gov|edu)$/.test(labels.at(-2)!);
  const keep = compound ? 3 : 2;
  if (labels.length < keep) return own;
  return `${url.protocol}//*.${labels.slice(-keep).join(".")}/*`;
}
// Sites whose terms forbid tools that automate activity on them (an employer,
// Indeed). Their pages are read and answers drafted for the applicant to
// copy; nothing is ever written, chosen, uploaded or clicked there.
export const DRAFT_ONLY_NOTE =
  "This site does not allow tools to fill its forms. Application Lane drafts here and you enter the answers yourself.";
export function draftOnlySite(url: string | undefined): boolean {
  try {
    return /(^|\.)(linkedin|indeed)\.com$/.test(new URL(url || "").hostname);
  } catch {
    return false;
  }
}
// Where an application page's posting probably is: the same address without
// the trailing /apply or /application (Workable's /j/ID/apply, Lever's
// /company/ID/apply, Ashby's /jobs/ID/application). A link queued from the
// command line is the application page, and nothing on it names the posting
// (one employer's: "The job posting could not be read").
export function postingGuess(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return;
    // A careers site that applies at /careers/apply?pid=<id> shows the job
    // at /careers/job/<id> (Microsoft's).
    const pid = url.searchParams.get("pid");
    if (/\/careers\/apply\/?$/i.test(url.pathname) && pid && /^\d{6,}$/.test(pid))
      return `${url.origin}${url.pathname.replace(/\/apply\/?$/i, "")}/job/${pid}`;
    const path = url.pathname.replace(/\/(apply|application)\/?$/i, "");
    if (path === url.pathname || path.replace(/\//g, "").length < 2) return;
    url.pathname = path;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return;
  }
}
// One Workday opening has several addresses: each career site of the tenant
// (/en-US/UR/job/… and /search/job/…), with "/apply" or without, and the
// requisition with a posting suffix ("_2642721-1") or none. one employer's internship
// was queued twice from two of them. The tenant's host and the
// requisition name the opening.
export function workdayOpening(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!/\.(myworkdayjobs|myworkdaysite)\.com$/i.test(url.hostname)) return;
    const match = /\/(?:job|details)\/(?:[^/]+\/)*[^/]*_([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*?)(?:-\d{1,2})?(?:\/(?:apply|application)(?:\/[^/]*)?)?\/?$/i.exec(url.pathname);
    return match ? `${url.hostname.toLowerCase()}#${match[1].toLowerCase()}` : undefined;
  } catch {
    return;
  }
}
// Whether two addresses are one opening: the same page, or one Workday
// requisition (workdayOpening).
export function sameOpening(a: string, b: string): boolean {
  try {
    if (canonicalURL(a) === canonicalURL(b)) return true;
  } catch {
    return false;
  }
  const opening = workdayOpening(a);
  return opening !== undefined && opening === workdayOpening(b);
}
export function canonicalURL(raw: string): string {
  const url = new URL(raw);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP(S) application URL without credentials.");
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|ref$|source$|gh_src$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

// The applicant's years of work: the months the profile's jobs cover, each
// month once however many jobs share it, up to this month.
function totalWorkYears(profile: Profile): number | undefined {
  const now = currentMonth();
  const months = new Set<string>();
  for (const row of profile.work) {
    const start = /^\d{4}-\d{2}/.test(row.startDate || "") ? row.startDate.slice(0, 7) : "";
    const end = /^\d{4}-\d{2}/.test(row.endDate || "") ? row.endDate.slice(0, 7) : row.current || !row.endDate ? now : "";
    if (!start || !end) continue;
    let [year, month] = start.split("-").map(Number);
    for (let guard = 0; guard < 720; guard++) {
      const key = `${year}-${String(month).padStart(2, "0")}`;
      if (key > end || key > now) break;
      months.add(key);
      month++;
      if (month > 12) (month = 1), year++;
    }
  }
  return months.size ? Math.round((months.size / 12) * 10) / 10 : undefined;
}

// Places under U.S. sanctions that such lists name.
const sanctionedPlaces = /\b(cuba|iran|north korea|syria|russia|belarus|crimea|donetsk|luhansk|zaporizhzhia|kherson|venezuela)\b/;
const sanctionedCodes = new Set(["CU", "IR", "KP", "SY", "RU", "BY", "VE"]);
// Whether the applicant is tied to a sanctioned place by citizenship or
// residence; undefined when the profile does not say where they live and
// what they are a citizen of.
function sanctionedTie(profile: Profile): boolean | undefined {
  const citizenships = (profile.citizenships || []).map((code) => String(code).toUpperCase());
  const places = [profile.country || "", ...(profile.workAuthorization || []).map((entry) => (typeof entry === "string" ? entry : entry.country || ""))];
  if (!profile.country || !citizenships.length) return undefined;
  if (citizenships.some((code) => sanctionedCodes.has(code) || sanctionedPlaces.test(normalize(code)))) return true;
  return places.some((place) => sanctionedCodes.has(place.toUpperCase()) || sanctionedPlaces.test(normalize(place)));
}

// One box of a "select all that apply" list about sanctions or export
// control: for an applicant with no tie to a sanctioned place, only "None
// of the above" is theirs, and in the follow-up asked only of those who
// chose something else, only its "Not applicable". "leave" for a box that
// is not the fill's to tick or clear; undefined for a box of any other list.
// Whether the fill answers this box's list itself (see listChoice).
export function listAnswered(field: Field, profile: Profile): boolean {
  const choice = listChoice(field, profile);
  return Boolean(choice && choice !== "leave");
}
function listChoice(field: Field, profile: Profile): Answer | "leave" | undefined {
  if (field.kind !== "checkbox" || !field.question) return undefined;
  const asked = normalize(field.question);
  const option = normalize(field.label.startsWith(field.question) ? field.label.slice(field.question.length) : field.label);
  const sanctions = /\b(sanction\w*|export control\w*|embargo\w*)\b/.test(asked);
  const afterNone = /\bother than\b.{0,12}\bnone of the above\b/.test(asked);
  if (sanctions || afterNone) {
    if (sanctionedTie(profile) !== false) return "leave";
    const none = afterNone
      ? /\bnot applicable\b|\bselected none of the above\b/.test(option)
      : /^none of (the above|these)\b/.test(option);
    // Every other box unticked: one an earlier fill ticked by mistake, or
    // the site parsed, is cleared (an applicant's own tick is locked).
    return { value: none ? "Yes" : "No" };
  }
  if (legalQuestion(field.question) || /\b(prior|previous|above) question\b|\bif you (selected|answered|chose|checked)\b/.test(asked)) return "leave";
  return undefined;
}
