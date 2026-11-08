import type { Field, Profile, Proposal } from "./model";
import { normalize } from "./model";
import globals from "../engine/config/globals.json" with { type: "json" };
import { countriesNamed, countryCode, type Geography } from "./geography";
import { askedCountry, citizenOf, jobCountry, usCitizen, usPerson, workAuthorizations } from "./authorization";
import { parseSalary, salaryAnswer } from "./salary";
import { localDate, writtenDate } from "./dates";
import { degreeLevel } from "./education";

const geography = globals as Geography;

// Standing questions: the same thing asked in many wordings, which one saved
// answer should cover ("Are you open to relocation?", "Would you relocate for
// this role?"). Each topic is a small set of patterns over the normalized
// label; a question that fits none is not guessed at.
export type Topic =
  | "relocate"
  | "workThere"
  | "onsite"
  | "salary"
  | "start"
  | "clearance"
  | "citizen"
  | "usPerson"
  | "assessment"
  | "adult"
  | "priorEmployment"
  | "referred"
  | "relatedToEmployee"
  | "fullTime"
  | "essentialFunctions"
  | "military"
  | "interviewed"
  | "enrolled";

// A standing answer is about where the applicant lives or the job is; a
// question about another country (or about the EU, abroad) is another
// question. Citizenship and export-control questions are read per country
// (authorization.ts) instead.
const elsewhereRegion = /\b(european union|eu|eea|abroad|overseas|internationally)\b/;
function elsewhere(question: string, profile: Pick<Profile, "country"> & { applyingTo?: Profile["applyingTo"] }): boolean {
  if (elsewhereRegion.test(normalize(question))) return true;
  const home = [countryCode(geography, profile.country) || (profile.country ? "" : "US"), jobCountry(profile)].filter(Boolean);
  return countriesNamed(geography, question).some((country) => !home.includes(country));
}

const topics: [Topic, RegExp][] = [
  // (The "Arms Export Control Act Debarred List" is a denied-parties list.)
  ["usPerson", /\bu s person\b|\bus person\b|\bexport control(?!s? act\b)|\bitar\b|\bear regulations\b/],
  // ("What's your citizenship / employment eligibility?", one employer's JazzHR
  // form.)
  ["citizen", /\b(u s|us|united states|american) citizen(ship)?\b|\bare you an? [a-z]+( [a-z]+)? citizen\b|\bare you a (citizen|national) of\b|^citizenship( status)?$|^(what is |what s )?(your )?citizenship( status)? (and |or )?(employment|work) (eligibility|authori[sz]ation)$|\bare you a citizen of the (u s|us|united states)\b/],
  ["clearance", /\bsecurity clearance/],
  ["relocate", /\brelocat/],
  // Working in the job's area ("Are you available to work in the Greater
  // Boston area for the duration of this internship?", an employer):
  // one willing to relocate is; for anyone else it depends on where they live.
  ["workThere", /\b(available|able|willing|open)\b.*\bto (work|be based|live) (in|near) (the )?(greater )?[a-z]+( [a-z]+)?( metro(politan)?)? (area|region)\b/],
  // ("Are you able to commit to working from one of our offices on Anchor
  // Days each week?", an employer. Commuting to a named office is
  // another question: it depends on where that office is.)
  [
    "onsite",
    /\b(willing|able|comfortable|open|okay|ok|can you|commit|available)\b.*\b(on ?site|in (the |our )?office|in person|hybrid|work(ing)? (from|at|in) (one of )?(our|the) offices?)\b|\b(on ?site|in (the |our )?office|in person|hybrid)\b.*\b(willing|able|comfortable|open|okay|ok|can you|commit|meet this requirement)\b/,
  ],
  // ("Wage Or Salary Required", an employer.)
  ["salary", /\b(salary|compensation|pay|wage)\b.*\b(expect\w*|desired|requirements?|required|requested|target)\b|\b(desired|expected|target) (annual |base )?(salary|compensation|pay)\b/],
  // "What date are you available to start work?" asks it too.
  ["start", /\b(earliest|soonest)\b.*\bstart\b|\bwhen (can|could|would) you (be able to )?start\b|\b(what|which) date (are|would|will) you (be )?available to (start|begin)\b|\bwhen (are|will|would) you (be )?available to (start|begin)\b|^(desired |available |earliest |preferred )?start date$|^date available$|^available start date$/],
  ["fullTime", /\b(available|able|willing|commit)\b.*\b(full time|monday( through| to| thru)? friday|40 hours)\b/],
  ["assessment", /\b(take home|coding (assessment|challenge|test)|technical assessment|online assessment)\b/],
  ["adult", /\b(at least|over|older than) (the age of )?18\b|\b18 years( of age)? (or older|and older|old or older)\b/],
  // ("Have you worked for an employer in the past 12 months?": the time comes after the employer.)
  ["priorEmployment", /\b(previously|ever|formerly|in the past)\b.*\b(worked|employed|been employed|an employee|a contractor)\b|\bformer employee\b|\bworked (for|at|with) us before\b|\b(worked|been employed) (for|at|by) .+ (in|within|during) the (past|last)\b/],
  // Asked on most SuccessFactors forms, and left to the applicant each time
  //: "Are you able to perform the essential job
  // functions … with or without reasonable accommodation?", "Military
  // Status", "Have you ever interviewed with … before?".
  ["essentialFunctions", /\bessential (job )?(functions|duties)\b/],
  ["military", /^(military|armed forces) (status|service)$|\b(are|have) you (ever )?(currently )?(serv(ed|ing)|been) in the (u s |us |united states )?(military|armed forces)\b|\bare you serving or have you ever served in the (u s |us )?(military|armed forces)\b/],
  ["interviewed", /\b(have you|did you)\b.*\b(ever |previously )?interviewed (with|at|for)\b/],
  // ("To qualify for our program, interns must be actively enrolled in a
  // bachelor's, master's, or other degree-seeking program … If you qualify,
  // please select yes.", an employer.) Which
  // school one attends is another question, asked by name.
  ["enrolled", /^(?!(what|which|where|name|please (include|list|enter|provide))\b).*\b(are you|must be|be|currently|actively)\b( currently| actively)? enrolled\b.*\b(degree|program|college|university|school|student)\b/],
  // ("Are you related or have close personal friendships with any current
  // an employer employees with whom you will be directly working…".)
  ["relatedToEmployee", /\b(are you|do you have)\b.*\b(related|relatives?|family members?|close (personal )?friendships?|personal relationships?)\b.*\bemployees?\b/],
  ["referred", /\b(were|was) you referred\b|\breferred (to this (position|job|role) )?by (someone|anyone|an? (current )?(employee|associate|team member))\b/],
];

// The sentences of a label that ask something, without the instructions and
// notes around them ('Please select "Yes" if…'). The whole label when it is
// one sentence or asks nothing explicitly.
// A label's sentences. No break after an initial ("U.S. citizen") or after an
// abbreviation inside a sentence: "(e.g. H-1B visa status)?" was once cut at
// "e.g.", leaving "H-1B visa status)?" as the question asked.
function sentences(text: string): string[] {
  const parts = text.split(/(?<=[?!]|(?<![A-Z])\.)\s+(?=[A-Z("“])/);
  const joined: string[] = [];
  for (const part of parts) {
    const last = joined.at(-1);
    if (last !== undefined && /(^|[\s(])(e\.g|i\.e|etc|vs|approx|incl|no|est|dept|inc|ltd|co)\.$/i.test(last)) joined[joined.length - 1] = `${last} ${part}`;
    else joined.push(part);
  }
  return joined;
}

export function askedPart(question: string): string {
  const all = sentences(question);
  const sentencesOf = all;
  const asking = sentencesOf.filter((sentence) => sentence.includes("?"));
  return sentencesOf.length > 1 && asking.length ? asking.join(" ") : question;
}

export function questionTopic(question: string): Topic | undefined {
  // A long preamble ("The team meets on site twice a year…") mentions many
  // things; what is asked is its last question. One that only points back
  // ("Are you able to meet this requirement?") asks about the preamble.
  // (No break after an initial's full stop: "U.S. citizen".)
  // A notice of why something is collected ("Amazon collects this information
  // solely for the purpose of complying with … export control laws") is not
  // what is asked: before "What is your full legal name:" it made the name a
  // U.S. person question, answered Yes (Amazon.jobs). A
  // label that is only the notice asks about it.
  const notice = /\b(collect\w*|use[sd]?|request\w*|ask\w*) (this|the following|the) information solely\b|\bsolely for the purpose of\b/;
  const asking = sentences(question).filter((sentence) => !notice.test(normalize(sentence)));
  if (asking.length && asking.length < sentences(question).length) question = asking.join(" ");
  const parts = sentences(question);
  const asked = parts.length > 1 ? parts.filter((sentence) => sentence.includes("?")).at(-1) : undefined;
  const of = (text: string) => {
    const label = normalize(text);
    // Citizenship of an embargoed country is not what a U.S. person
    // answer says: a U.S. citizen may hold another. "Are you a citizen of, or
    // do you hold dual citizenship with any of these countries?" after
    // one employer's export-control notice got Yes.
    if (/\b(cuba|iran|north korea|syria|crimea|embargoed|sanctioned)\b/.test(normalize(question))) return;
    const topic = topics.find(([, pattern]) => pattern.test(label))?.[0];
    // A saved figure is a yearly one; an hourly rate is another question.
    if (topic === "salary" && /\b(hour|hourly|hr|per hour|rate)\b/.test(label)) return;
    // Holding a clearance is one question; whether one could be obtained,
    // or what might prevent it, are others. "Do you hold an active security
    // clearance? No" answered "Are you eligible to obtain a U.S. security
    // clearance?" No.
    if (topic === "clearance" && /\b(obtain\w*|get|getting|receiv\w*|acquir\w*|be granted|prevent\w*)\b/.test(label)) return;
    // Where one would move from is a place, not whether one would move:
    // "…please tell us the city, state, and zip code you'd be moving from"
    // was answered "Yes".
    if (topic === "relocate" && (/\bcity\b.*\bstate\b.*\b(zip|postal)\b/.test(normalize(question)) || /\b(moving|relocating) from\b/.test(normalize(question)))) return;
    return topic;
  };
  if (!asked) return of(question);
  // "Are you one of the following?" asks about the list after it, as "these"
  // does about the text before (one employer's citizenship list, cc40f1fb).
  return of(asked) ?? (/\b(this|these|that|those|the above|the following|such)\b/.test(normalize(asked)) ? of(question) : undefined);
}

type Answer = Pick<Proposal, "value" | "choices" | "numeric">;

// "Yes" also answers a list that words it as a sentence ("Yes, I am willing
// to relocate"), as long as exactly the options beginning with it are meant.
function yesNo(answer: "Yes" | "No", field: Field): Answer {
  // A list's placeholder ("No Selection") is no way of saying No.
  const worded = field.options.filter((option) => new RegExp(`^${answer}\\b`, "i").test(option.trim()) && normalize(option) !== normalize(answer) && !/^no selection$/.test(normalize(option)));
  // A list with no No says it as not applying: one employer's "Do you currently
  // or have you previously worked at an employer or Microsoft? (Select all that
  // apply)" offers "Not Applicable" beside each way one has.
  const inapplicable = answer === "No" && !worded.length && !field.options.some((option) => normalize(option) === "no")
    ? field.options.filter((option) => /^(not applicable|n a|does not apply)$/.test(normalize(option)))
    : [];
  if (inapplicable.length) return { value: inapplicable[0], choices: inapplicable.slice(1) };
  // Or as the sentence a No makes: one employer's "I have never been employed by
  // an employer or contracted to provide services to an employer". One
  // such option only; two would need telling apart.
  const never = answer === "No" && !worded.length && !field.options.some((option) => normalize(option) === "no")
    ? field.options.filter((option) => /^(i have never|i ve never|never|i have not|i haven t|i am not and have never)\b/.test(normalize(option)))
    : [];
  if (never.length === 1) return { value: never[0] };
  return { value: answer, ...(worded.length ? { choices: worded } : {}) };
}

// The ways a list of statuses words a citizen. (JazzHR's own list puts
// citizens and permanent residents together, an employer.)
export const citizenWordings = ["U.S. Citizen", "US Citizen", "United States Citizen", "Citizen", "A citizen of the U.S.", "A citizen of the United States", "Citizen of the U.S.", "Citizen of the United States", "A U.S. citizen", "U.S. Citizen or National", "A United States citizen or national", "A U.S. citizen or national", "I am a U.S. Citizen/Permanent Resident", "U.S. Citizen/Permanent Resident", "U.S. Citizen or Permanent Resident"];

const plainYesNo = (value: string): "Yes" | "No" | undefined =>
  /^\s*yes\b/i.test(value) ? "Yes" : /^\s*no(ne)?\b/i.test(value) ? "No" : undefined;

// An employer's name without its legal form: "an employer Electric
// Company, LLC" reads "westinghouse electric".
const legalForm = /\b(inc|incorporated|llc|l l c|llp|ltd|limited|corp|corporation|company|co|group|plc|gmbh|ag|sa|s a|bv|nv|pty|holdings?|the)\b/g;
const employerWords = (name: string) => normalize(name).replace(legalForm, " ").replace(/\s+/g, " ").trim();

// Whether two names are the same employer: "same" for one name, or one the
// start of the other ("Amazon" and "Amazon Web Services"); "maybe" when they
// share a distinctive word; else "different".
export function sameEmployer(a: string, b: string): "same" | "maybe" | "different" {
  const x = employerWords(a);
  const y = employerWords(b);
  if (!x || !y) return "different";
  if (x === y) return "same";
  const [short, long] = x.split(" ").length <= y.split(" ").length ? [x.split(" "), y.split(" ")] : [y.split(" "), x.split(" ")];
  if (short.join("").length >= 4 && short.every((word, index) => long[index] === word)) return "same";
  return short.some((word) => word.length >= 4 && long.includes(word)) ? "maybe" : "different";
}

const counted: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, twelve: 12, eighteen: 18, twenty: 20 };

// "Have you worked for <employer> before?": Yes when a job in the
// applicant's history is with that employer (within the time asked about,
// if any); No when none is and they have said they never worked for a
// company they apply to; else unknown. The employer is the one the
// question names, or the one being applied to.
export function priorEmploymentAnswer(profile: Profile, question: string): "Yes" | "No" | undefined {
  const asked = normalize(askedPart(question));
  const named = asked
    .match(/\b(?:for|at|by|with) (.+?)(?: (?:before|previously|formerly|ever|in the (?:past|last)|within|during|as an?|or (?:any|one) of)\b.*)?$/)?.[1]
    ?.trim();
  const own = named && !/^(us|our|this|the|your|it|any|an?)( (company|organization|employer|firm|team|business))?$|^(our|this|the) (company|organization|employer|firm|team|business)\b/.test(named) ? named : undefined;
  const company = own || profile.applyingTo?.company || "";
  const never = profile.neverWorkedForApplyingCompanies === true;
  if (!company) return never ? "No" : undefined;
  // "In the past 12 months": a job ended earlier is not within it.
  const window = asked.match(/\b(?:past|last|within(?: the)?(?: past| last)?) (\d+|[a-z]+) (month|year)s?\b/);
  const span = window ? Number(window[1]) || counted[window[1]] : undefined;
  const since = (() => {
    if (!window || !span) return undefined;
    const date = new Date();
    if (window[2] === "month") date.setMonth(date.getMonth() - span);
    else date.setFullYear(date.getFullYear() - span);
    return localDate(date).slice(0, 7);
  })();
  let unsure = false;
  for (const row of profile.work) {
    const match = sameEmployer(row.organization, company);
    if (match === "maybe") unsure = true;
    if (match !== "same") continue;
    if (!since || row.current || !row.endDate) {
      if (since && !row.current && !row.endDate) unsure = true;
      else return "Yes";
      continue;
    }
    if (row.endDate.slice(0, 7) >= since) return "Yes";
    // Worked there, but before the time asked about.
    if (!/^\d{4}-\d{2}/.test(row.endDate)) unsure = true;
  }
  if (unsure) return;
  // Worked there only before the window: that is No, whatever the toggle.
  if (since && profile.work.some((row) => sameEmployer(row.organization, company) === "same")) return "No";
  return never ? "No" : undefined;
}

// A saved or profile answer for a standing question, when the field asks the
// same thing in other words. Exactly worded saved answers are matched before
// this (matching.ts) and are not second-guessed here.
export function enrolledNow(profile: Pick<Profile, "education">, now = new Date()): boolean {
  const month = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  const today = month(now);
  const termAgo = month(new Date(now.getFullYear(), now.getMonth() - 4, 1));
  return (profile.education || []).some((row) => {
    const start = /^\d{4}-\d{2}/.test(row.startDate || "") ? row.startDate.slice(0, 7) : "";
    const end = /^\d{4}-\d{2}/.test(row.endDate || "") ? row.endDate.slice(0, 7) : "";
    return Boolean(start) && start <= termAgo && (!end || end >= today);
  });
}

export function standingAnswer(field: Field, profile: Profile): Answer | undefined {
  const label = normalize(field.label);
  const topic = questionTopic(field.label);
  if (!topic) return;
  // Enrolled now: a degree under way, begun at least a term ago (such
  // questions ask for a semester done). Yes only; anyone else is left to
  // answer it, since the conditions around it vary.
  if (topic === "enrolled") {
    if (/^(text|textarea|email|tel|number|url|date)$/.test(field.kind)) return;
    // A question naming one level of degree asks about that level: "Are you
    // currently enrolled in a Doctorate Degree program…?" was answered Yes
    // for a master's student (Microsoft). A program under way at
    // another level, No; at that level, as any enrollment. One naming several
    // ("a bachelor's, master's, or other degree-seeking program") asks any.
    const named = ([
      ["doctorate", /\b(doctora\w*|ph ?d|doctor of)\b/],
      ["master", /\b(master\w*|m s|m a|mba)\b/],
      ["bachelor", /\b(bachelor\w*|undergrad\w*|b s|b a)\b/],
      ["associate", /\bassociate\w*\b/],
    ] as const).filter(([, pattern]) => pattern.test(label)).map(([level]) => level);
    if (named.length === 1 && !/\bor other\b/.test(label)) {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const underWay = (profile.education || []).filter((row) => {
        const end = /^\d{4}-\d{2}/.test(row.endDate || "") ? row.endDate.slice(0, 7) : "";
        return row.current === true || (row.current !== false && Boolean(end) && end >= today);
      });
      const levels = underWay.map((row) => (degreeLevel(row.title) === "mba" ? "master" : degreeLevel(row.title)));
      if (underWay.length && levels.every(Boolean) && !levels.includes(named[0])) return yesNo("No", field);
    }
    return enrolledNow(profile) ? yesNo("Yes", field) : undefined;
  }
  // A box that asks for the details behind the question ("If you have
  // previously worked at an employer, please provide your approximate last date
  // of employment (MM/DD/YYYY)") is not answered Yes or No: it got "No".
  if ((topic === "priorEmployment" || topic === "referred" || topic === "interviewed") &&
    /^(text|email|tel|number|url|date|datepicker)$/.test(field.kind) &&
    (field.format || /\b(provide|enter|list|give|specify|include|share)\b.*\b(date|dates|email|name|names|address|id|number|title|details?|when|where|who)\b|\b(mm dd yyyy|mm yyyy|dd mm yyyy)\b/.test(label)))
    return;
  if (topic === "priorEmployment") {
    const answer = priorEmploymentAnswer(profile, field.label);
    return answer ? yesNo(answer, field) : undefined;
  }
  // Another country's version of a question is another question.
  if (topic !== "citizen" && topic !== "usPerson" && topic !== "referred" && elsewhere(field.label, profile)) return;
  // Referred by someone at the company the question names: the people who
  // vouch for the applicant are saved as references, each with where they
  // work. None of them there, nobody there referred them. One who might be, or a question naming no company,
  // is left for the applicant.
  if (topic === "referred" && !profile.answers.some((answer) => questionTopic(answer.question) === "referred")) {
    // "…by someone at an employer?": its first word, without "Electric
    // Company, LLC" after it.
    const company = label.match(/\b(?:at|from|of) ([a-z0-9&]+)(?: [a-z0-9&]+)*$/)?.[1];
    if (!company || /^(us|our|this|the|your|a|an)$/.test(company)) return;
    const theirs = (text: string) => normalize(text).includes(company);
    if ((profile.references || []).some((reference) => theirs(`${reference.relationship || ""} ${reference.email || ""}`))) return;
    if (profile.work.some((row) => row.organization && theirs(row.organization))) return;
    return yesNo("No", field);
  }
  if (topic === "referred" && elsewhere(field.label, profile)) return;
  // Related to, or close friends with, someone at the company: as with a
  // referral, the people the applicant knows there are their references.
  // None of them there and no job of their own there, No; else theirs to say.
  if (topic === "relatedToEmployee" && !profile.answers.some((answer) => questionTopic(answer.question) === "relatedToEmployee")) {
    const company = label.match(/\b(?:current|any|of|at) (?:current )?([a-z0-9&]+) (?:employees?|team members?|staff)\b/)?.[1] ||
      normalize(profile.applyingTo?.company || "").split(" ")[0];
    if (!company || /^(us|our|this|the|your|a|an|any|current)$/.test(company)) return;
    const theirs = (text: string) => normalize(text).includes(company);
    if ((profile.references || []).some((reference) => theirs(`${reference.relationship || ""} ${reference.email || ""}`))) return;
    if (profile.work.some((row) => row.organization && theirs(row.organization))) return;
    return yesNo("No", field);
  }
  // Citizenship is asked of one country: the one the question names, else
  // the job's. A status list naming neither ("Citizenship status") is a
  // U.S. one when it words U.S. statuses, or offers nothing yet.
  let citizenCountry = "";
  if (topic === "citizen") {
    const asked = askedCountry(field.label);
    if (asked === undefined) return;
    const usList = !field.options.length || field.options.some((option) => /\b(u s|us|united states)\b/.test(normalize(option)));
    citizenCountry = asked || jobCountry(profile) || (usList ? "US" : "");
    if (!citizenCountry) return;
  }
  const citizen = topic === "citizen" ? (citizenCountry === "US" ? usCitizen(profile) : citizenOf(profile, citizenCountry)) : undefined;
  // A saved answer of the same topic; for citizenship, only one about the
  // same country ("Are you a U.S. citizen?" says nothing of Canada).
  const savedFor = (wanted: Topic) =>
    profile.answers.find((answer) => {
      if (questionTopic(answer.question) !== wanted) return false;
      if (wanted !== "citizen") return true;
      const country = askedCountry(answer.question);
      return country !== undefined && (country || "US") === citizenCountry;
    })?.answer;
  const person = topic === "usPerson" ? usPerson(profile) : undefined;
  const saved =
    savedFor(topic) ||
    (topic === "workThere"
      ? savedFor("relocate") || profile.willingToRelocate
      : topic === "relocate"
      ? profile.willingToRelocate
      : topic === "adult"
        ? profile.age18OrOlder
        : topic === "usPerson" && person !== undefined
          ? (person ? "Yes" : "No")
          : // The applicant's citizenships, work authorization entries or
            // export-control statement saying so answer a citizenship
            // question no saved answer words.
            topic === "citizen" && citizen !== undefined
            ? (citizen ? "Yes" : "No")
            : "");
  if (!saved?.trim()) return;
  const yes = plainYesNo(saved);
  // A Yes worded as living there already ("Yes, I am currently based in
  // Atlanta, GA") is the applicant's only where they live; willing to
  // relocate is the other Yes. Both read as Yes, and the first was taken for
  // an applicant in their own city.
  if ((topic === "relocate" || topic === "workThere") && yes === "Yes") {
    const answer = yesNo("Yes", field);
    const located = /\b(currently|already|presently)\b.*\b(based|located|living|live|reside|residing)\b|\b(i am|i m) local\b/;
    const home = normalize(profile.city || "");
    const fitting = (answer.choices || []).filter((option) => !located.test(normalize(option)) || (Boolean(home) && normalize(option).includes(home)));
    if (answer.choices?.length && fitting.length && fitting.length < answer.choices.length)
      return fitting.length === 1 ? { value: fitting[0] } : { value: "Yes", choices: fitting };
    if (topic === "workThere") return answer;
  }
  if (topic === "workThere") return yes === "Yes" ? yesNo("Yes", field) : undefined;
  // "US citizenship or permanent residence: do you meet either?" A citizen
  // does; someone who is not a citizen may still, which this cannot say.
  if (topic === "citizen" && /\bpermanent resid|\bgreen card\b|\bor\b.*\b(authoriz|visa)/.test(label) && yes !== "Yes") return;
  if (topic === "salary") {
    // A figure saved as a standing answer is read like the profile's own.
    const own = profile.salary && profile.answers.every((answer) => questionTopic(answer.question) !== "salary")
      ? profile.salary
      : parseSalary(saved, "year");
    const numeric = field.kind === "number" || Boolean(field.options.length) || /\b(numbers? only|numeric|digits only)\b/.test(label);
    // Words saved in place of a figure ("Negotiable") answer a text box.
    if (!own) return numeric ? undefined : { value: saved.trim() };
    const answer = salaryAnswer(own, { label, numeric });
    if (!answer) return;
    // A list of ranges is matched by the figure; a text box takes a saved
    // answer as the applicant wrote it.
    if (field.options.length) return { value: String(answer.numeric), numeric: answer.numeric };
    return own === profile.salary || numeric ? answer : { value: saved.trim(), numeric: answer.numeric };
  }
  if (topic === "start") {
    // "Immediately" answers a text box or a list that offers it. A box that
    // takes only a date gets today's: the date the applicant could start.
    // Another saved answer ("Two weeks' notice") is no date, and is left.
    // A date picker can read as a text box: "Date Available" on SuccessFactors
    // got "Immediately" typed into it.
    // A question asked in words ("What is your earliest start date?") still
    // takes "Immediately".
    if (/date/.test(field.kind) || (!field.options.length && /^(date available|available (start )?date|availability date|(earliest )?start date|date of availability)$/.test(label))) {
      if (!/^\s*(immediately|immediate|asap|right away|now)\b/i.test(saved)) return;
      // Amazon's picker names its format, "Date: Year-Month-Day", and calls
      // "10/25/2026" the wrong one. Without a format
      // shown or known, the date is left.
      const value = writtenDate(localDate(), field, profile);
      return value ? { value } : undefined;
    }
    return { value: saved.trim(), choices: /immediate|asap|right away/i.test(saved) ? ["Immediately", "Immediate", "ASAP", "Available immediately"] : undefined };
  }
  if (topic === "citizen" && !/\b(are|am) (you|i)\b|^(u s|us|united states) citizen$/.test(label)) {
    // A status list: the saved wording, and the ways lists word a citizen
    // (of the United States, or plainly "Citizen"). A No names no status.
    if (yes === "No") return;
    return {
      value: saved.trim(),
      choices: yes === "Yes" || /citizen/i.test(saved) ? (citizenCountry === "US" ? citizenWordings : ["Citizen"]) : undefined,
    };
  }
  if (topic === "clearance" && !yes && !field.options.length) return { value: saved.trim() };
  if (!yes) return field.options.length ? undefined : { value: saved.trim() };
  // An export-control list may name the kinds of U.S. person instead of Yes
  // and No ("A United States citizen or national", "Green Card" holder,
  // refugee, asylee, none). A citizen is the first; another U.S. person could
  // be any of the rest, which "Yes" does not say.
  const savedCitizen = plainYesNo(profile.answers.find((answer) => questionTopic(answer.question) === "citizen" && (askedCountry(answer.question) || "US") === "US")?.answer || "");
  if (topic === "usPerson" && yes === "Yes" && (usCitizen(profile) || savedCitizen === "Yes")) {
    const answer = yesNo("Yes", field);
    return { ...answer, choices: [...(answer.choices || []), ...citizenWordings] };
  }
  // Military status in a list of statuses: No is "No Military" (Expand
  // Energy), "None" or "Not applicable" elsewhere.
  if (topic === "military" && yes === "No")
    return { value: "No", choices: ["No Military", "No military service", "None", "Not applicable", "N/A", ...(yesNo("No", field).choices || []), "No"] };
  // "Do you have a clearance?" with a list of levels: No is "None".
  if (topic === "clearance" && yes === "No")
    return { ...yesNo("No", field), choices: [...(yesNo("No", field).choices || []), "None", "No clearance", "No Clearance", "N/A", "Not applicable"] };
  return yesNo(yes, field);
}
