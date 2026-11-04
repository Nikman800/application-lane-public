import { authorizationLines } from "../shared/authorization";
import { formatSalary } from "../shared/salary";
import type {
  DraftProvider,
  Field,
  FieldFallbackDraft,
  GenerationRequest,
  Profile,
} from "../shared/model";
import { legalDetailLabels, normalize, type LegalDetailKey } from "../shared/model";
import { legalQuestion, structuredFallbackField } from "../shared/questions";
import type { Config } from "./store";
import {
  cliNotice,
  completeJSON,
  defaultBudget,
  type Exchange,
} from "./generation";

const FIELD_FALLBACK_PROMPT = `You map empty structured job-application fields to facts the applicant has already saved.
Return JSON only: {"suggestions":[{"fieldId":"q1","value":"exact value","sourceIds":["source-id"]},{"fieldId":"q2","skip":"short reason"}]}.

Rules:
- Suggest only values explicitly supported by the supplied saved sources. Never guess missing schools, dates, addresses, counts, credentials, choices, or personal details.
- Each suggestion must cite at least one supplied sourceIds entry that supports it.
- For a field with options, copy one option exactly into value.
- Keep values short and suitable for the field. Do not add explanations to value.
- Use skip when the saved sources do not answer the field or the mapping is uncertain.
- A legal or eligibility question (criminal record, clearance, agreements, dismissals, relatives, screening) is answered only from a "Legal and eligibility" source that covers it. For a box that asks for an explanation only if something applies, and the source says nothing applies, answer "N/A".
- A field with "question" is one box of that question, and its label is one of the choices. Suggest "Yes" for it only when a source says this choice is the applicant's answer to that question as asked; a choice that is true of them in some other sense is skipped. Never tick a box to say none apply.
- A field with "row" belongs to one entry of a repeated section, a school or a job, and "row" lists what that entry already shows. Answer it only from the saved education or work entry that is the same one (by its name, dates or title), as true of that entry alone: whether one school is still attended says nothing about another. Skip it when no saved entry matches the row.
- Answer every supplied field exactly once.`;

type Source = { id: string; text: string };

export function fieldFallbackSources(
  profile: Profile,
  fields?: Field[],
): Source[] {
  const sources: Source[] = [];
  const add = (id: string, label: string, value: unknown) => {
    const text = Array.isArray(value)
      ? value.filter(Boolean).join(", ")
      : String(value ?? "").trim();
    if (text) sources.push({ id, text: `${label}: ${text}`.slice(0, 3000) });
  };
  const scalarLabels: Partial<Record<keyof Profile, string>> = {
    firstName: "First name",
    lastName: "Last name",
    middleName: "Middle name",
    preferredName: "Preferred name",
    email: "Email",
    phone: "Phone",
    phoneDeviceType: "Phone device type",
    city: "City",
    state: "State or province",
    county: "County",
    country: "Country",
    address: "Street address",
    addressLine2: "Address line 2",
    postalCode: "Postal code",
    linkedin: "LinkedIn",
    website: "Website",
    github: "GitHub",
    currentCompany: "Current company",
    skills: "Skills",
    referralSource: "Referral sources",
    disabilityStatus: "Disability status",
    veteranStatus: "Veteran status",
    gender: "Gender",
    ethnicity: "Ethnicity",
    pronouns: "Pronouns",
    sexualOrientation: "Sexual orientation",
    internshipCount: "Number of internships",
    hispanic: "Hispanic or Latino status",
    age18OrOlder: "Age 18 or older",
    willingToRelocate: "Willing to relocate",
  };
  for (const [key, label] of Object.entries(scalarLabels) as [
    keyof Profile,
    string,
  ][])
    add(`profile.${key}`, label, profile[key]);
  add("profile.workAuthorization", "Work authorization and sponsorship, by country", authorizationLines(profile).join(". "));
  add("profile.salary", "Expected pay", profile.salary ? formatSalary(profile.salary, true) : "");
  for (const key of Object.keys(legalDetailLabels) as LegalDetailKey[])
    add(`legal.${key}`, `Legal and eligibility: ${legalDetailLabels[key]}`, profile.legal?.[key]);
  profile.education.forEach((row, index) =>
    add(`education.${index + 1}`, `Education ${index + 1}`, [
      row.organization,
      row.title,
      row.fieldOfStudy,
      row.startDate && `start ${row.startDate}`,
      row.endDate && `end ${row.endDate}`,
      row.current && "still studying here",
      row.gpa && `GPA ${row.gpa}${row.gpaScale && row.gpaScale !== "other" ? ` out of ${row.gpaScale}` : ""}`,
      row.location,
      row.details,
    ]),
  );
  profile.work.forEach((row, index) =>
    add(`work.${index + 1}`, `Work ${index + 1}`, [
      row.organization,
      row.title,
      row.startDate && `start ${row.startDate}`,
      row.endDate && `end ${row.endDate}`,
      row.location,
      row.details,
    ]),
  );
  profile.references.forEach((reference, index) =>
    add(`reference.${index + 1}`, `Professional reference ${index + 1}`, [
      reference.name,
      reference.relationship,
      reference.phone,
      reference.email,
    ]),
  );
  profile.answers.forEach((answer, index) =>
    add(
      `answer.${index + 1}`,
      `Saved answer to ${answer.question}`,
      answer.answer,
    ),
  );
  profile.facts.forEach((fact) =>
    add(`fact.${fact.id}`, "Confirmed fact", fact.text),
  );
  const limited = sources.slice(0, 500);
  if (!fields?.length) return limited;
  const context = normalize(
    fields.map((field) => `${field.section || ""} ${field.label}`).join(" "),
  );
  const relevantScalar: [RegExp, RegExp][] = [
    [/profile\.(firstName|middleName|lastName|preferredName)/, /\bname\b/],
    [/profile\.email/, /e ?mail/],
    [/profile\.(phone|phoneDeviceType)/, /phone|mobile|telephone|device type/],
    [
      /profile\.(city|state|county|country|address|addressLine2|postalCode)/,
      /address|city|state|province|county|country|zip|postal|location|residen/,
    ],
    [
      /profile\.(linkedin|website|github)/,
      /linkedin|website|portfolio|github|url|link/,
    ],
    [/profile\.currentCompany/, /current company|current employer/],
    [/profile\.skills/, /skill|technolog|language|framework|tool/],
    [/profile\.referralSource/, /hear about|referral|source/],
    [/profile\.internshipCount/, /internship|co op/],
    [/profile\.salary/, /salary|compensation|pay|wage|rate/],
    [
      /profile\.workAuthorization/,
      /authori[sz]|sponsor|visa|eligible to work|citizen/,
    ],
    [/profile\.age18OrOlder/, /18|age|adult/],
    [/profile\.willingToRelocate/, /relocat/],
    [/profile\.(gender|pronouns)/, /gender|pronoun|\bsex\b/],
    [/profile\.(ethnicity|hispanic)/, /race|ethnic|hispanic|latin/],
    [/profile\.veteranStatus/, /veteran|military/],
    [/profile\.disabilityStatus/, /disabilit/],
    [/profile\.sexualOrientation/, /sexual orientation|orientation/],
  ];
  return limited.filter((source) => {
    if (/^(fact|answer)\./.test(source.id)) return true;
    if (/^legal\./.test(source.id)) return fields.some((field) => legalQuestion(`${field.question || ""} ${field.label}`));
    if (/^education\./.test(source.id))
      return /educat|school|college|university|degree|major|study|graduat|academic|gpa/.test(
        context,
      );
    if (/^work\./.test(source.id))
      return /work|employ|company|organization|job|position|title|experience|responsibilit/.test(
        context,
      );
    if (/^reference\./.test(source.id)) return /reference/.test(context);
    return relevantScalar.some(
      ([sourcePattern, fieldPattern]) =>
        sourcePattern.test(source.id) && fieldPattern.test(context),
    );
  });
}

export type FieldFallbackResult = {
  drafts: FieldFallbackDraft[];
  warnings: string[];
};

export type FieldFallbackWriter = (
  request: GenerationRequest,
  profile: Profile,
  signal: AbortSignal,
) => Promise<FieldFallbackResult>;

export async function writeFieldFallback(
  config: Config,
  request: GenerationRequest,
  profile: Profile,
  signal: AbortSignal,
): Promise<FieldFallbackResult> {
  const fields = request.fields
    // Which legal questions may be asked is the extension's setting; the
    // fields it sends are the ones to answer.
    .filter((field) => structuredFallbackField(field, true))
    .filter(
      (field) => !request.questionIds || request.questionIds.includes(field.id),
    );
  if (!fields.length) return { drafts: [], warnings: [] };
  if (fields.length > 8) {
    const drafts: FieldFallbackDraft[] = [];
    const warnings: string[] = [];
    for (let offset = 0; offset < fields.length; offset += 8) {
      signal.throwIfAborted();
      const batch = await writeFieldFallback(
        config,
        {
          ...request,
          questionIds: fields
            .slice(offset, offset + 8)
            .map((field) => field.id),
        },
        profile,
        signal,
      );
      drafts.push(...batch.drafts);
      warnings.push(...batch.warnings);
    }
    return { drafts, warnings: [...new Set(warnings)] };
  }
  const sources = fieldFallbackSources(profile, fields);
  const sourceMap = new Map(sources.map((source) => [source.id, source.text]));
  const refs = new Map(fields.map((field, index) => [`q${index + 1}`, field]));
  const exchange: Exchange = { attempts: 0 };
  const parsed = await completeJSON(
    config,
    {
      model: config.model,
      temperature: 0,
      max_tokens: 3000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: FIELD_FALLBACK_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            sources,
            fields: [...refs].map(([id, field]) => ({
              id,
              label: field.label,
              ...(field.question ? { question: field.question } : {}),
              section: field.section,
              ...(field.row ? { row: field.row } : {}),
              kind: field.kind,
              required: field.required,
              ...(field.options.length
                ? { options: field.options.slice(0, 100) }
                : {}),
              ...(field.maxLength ? { maxLength: field.maxLength } : {}),
            })),
          }),
        },
      ],
    },
    AbortSignal.any([signal, AbortSignal.timeout(defaultBudget(config))]),
    exchange,
  );
  const output =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const suggestions = Array.isArray(output.suggestions)
    ? output.suggestions
    : [];
  const byField = new Map<string, Record<string, unknown>>();
  for (const suggestion of suggestions) {
    if (!suggestion || typeof suggestion !== "object") continue;
    const item = suggestion as Record<string, unknown>;
    const field =
      typeof item.fieldId === "string" ? refs.get(item.fieldId) : undefined;
    if (field && !byField.has(field.id)) byField.set(field.id, item);
  }
  const provider: DraftProvider | undefined =
    exchange.via && exchange.model
      ? { provider: exchange.via, model: exchange.model, ...(exchange.viaName ? { name: exchange.viaName } : {}) }
      : undefined;
  const reasons = new Map(
    (request.fallbackReasons || []).map((entry) => [
      entry.fieldId,
      entry.reason,
    ]),
  );
  const drafts = fields.map((field): FieldFallbackDraft => {
    const item = byField.get(field.id) || {};
    const citedIds = Array.isArray(item.sourceIds)
      ? item.sourceIds.filter(
          (id): id is string => typeof id === "string" && sourceMap.has(id),
        )
      : [];
    let value = typeof item.value === "string" ? item.value.trim() : "";
    let skipReason =
      typeof item.skip === "string"
        ? item.skip.replace(/\s+/gu, " ").trim().slice(0, 200)
        : "";
    if (field.options.length && value) {
      const option = field.options.find(
        (candidate) => normalize(candidate) === normalize(value),
      );
      if (option) value = option;
      else {
        value = "";
        skipReason ||= "The suggestion did not match an available choice.";
      }
    }
    if (field.kind === "checkbox" && value && !["Yes", "No"].includes(value)) {
      value = "";
      skipReason ||= "The suggestion was not a valid checkbox value.";
    }
    // A date box takes a date. "N/A" for "Date Of Clearance" (no clearance)
    // was rejected by the site as invalid (L3Harris, 2026-10-15); left
    // empty, it reads as not applicable.
    if (
      value &&
      (field.kind === "date" || /^(date\b|.*\bdate$)/i.test(field.label.trim())) &&
      !/\d{1,4}[/.-]\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.? \d{1,2},? \d{4}|^\d{4}$/i.test(value)
    ) {
      value = "";
      skipReason ||= "The suggestion was not a date.";
    }
    if (field.maxLength && value.length > field.maxLength) {
      value = "";
      skipReason ||= `The suggestion exceeded the ${field.maxLength}-character limit.`;
    }
    if (value && !citedIds.length) {
      value = "";
      skipReason ||= "The suggestion did not cite saved profile information.";
    }
    // A legal or eligibility answer stands on the applicant's own saved
    // legal details, unless they let the model use everything.
    if (
      value &&
      request.legalAnswers !== "any" &&
      legalQuestion(`${field.question || ""} ${field.label}`) &&
      !citedIds.some((id) => id.startsWith("legal."))
    ) {
      value = "";
      skipReason ||= "Your saved legal and eligibility details do not answer this.";
    }
    if (!value)
      skipReason ||=
        "No saved profile information clearly answered this field.";
    return {
      fieldId: field.id,
      label: field.label,
      ...(field.question ? { question: field.question } : {}),
      section: field.section,
      kind: field.kind,
      required: field.required,
      options: field.options,
      reason:
        reasons.get(field.id) ||
        "Normal fill left this structured field empty.",
      value,
      ...(value
        ? {
            source: citedIds
              .map((id) => sourceMap.get(id))
              .filter(Boolean)
              .join("; ")
              .slice(0, 1000),
            ...(provider ? { draftedWith: provider } : {}),
          }
        : { skipReason }),
    };
  });
  return {
    drafts,
    warnings: [
      ...cliNotice(config, exchange),
      "AI suggestions were not filled automatically. Verify every value and its cited source before filling.",
    ],
  };
}
