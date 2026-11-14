import { z } from "zod";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const pathSchema = z.union([z.string(), z.array(z.string())]);

export const eventOptionsSchema = z
  .object({
    bubbles: z.boolean().optional(),
    cancelable: z.boolean().optional(),
    clickOnly: z.boolean().optional(),
    code: z.string().optional(),
    inputType: z.string().optional(),
    key: z.string().optional(),
    keyCode: z.number().optional(),
    keyIdentifier: z.string().optional(),
    noBlur: z.boolean().optional(),
    skipBlur: z.boolean().optional(),
    which: z.number().optional(),
  })
  .strict();

export const actionSchema = z
  .object({
    allowFailure: z.boolean().optional(),
    condition: pathSchema.optional(),
    delay: z.number().nonnegative().optional(),
    event: z.string().optional(),
    eventOptions: eventOptionsSchema.optional(),
    method: z.string().optional(),
    path: pathSchema.optional(),
    // On a click or mousedown that picks from a list the site offers for
    // typed text: the site holds no answer until it is pressed. With
    // allowFailure the form still goes on when the list offers nothing, and
    // the applicant is told the question is theirs to pick.
    pickRequired: z.boolean().optional(),
    // On a click that picks from a list the site offers for typed text: the
    // option is the one the answer's ranked matching chooses among the entries
    // the path reaches (a listed name with a note after it, the entry naming
    // the school's state), not the one whose text is exactly the answer.
    rankedPick: z.boolean().optional(),
    removed: z.boolean().optional(),
    removedTime: z.number().nonnegative().optional(),
    skipOnEmptyValue: z.boolean().optional(),
    time: z.number().nonnegative().optional(),
    value: jsonValueSchema.optional(),
    valueKey: z.string().optional(),
    valuePath: pathSchema.optional(),
    valueRequired: z.boolean().optional(),
    values: z.union([z.string(), z.record(jsonValueSchema)]).optional(),
  })
  .strict();
export type FillAction = z.infer<typeof actionSchema>;

const extractorSchema = z
  .object({
    template: z.string(),
    urlPattern: z.string().optional(),
  })
  .strict();

export const optionsSourceSchema = z
  .object({
    allowContainsMatch: z.boolean().optional(),
    extractors: z
      .record(z.union([extractorSchema, z.array(extractorSchema)]))
      .optional(),
    maxRequests: z.number().int().positive().optional(),
    minTermLength: z.number().int().nonnegative().optional(),
    responseItemsPath: z.string(),
    responseTextPath: z.string(),
    urlTemplate: z.string(),
  })
  .strict();

export type InputSelector = [string, Selector[]];
export type Selector = string | SelectorConfig;
export type SelectorConfig = {
  actions?: FillAction[];
  addButtonPath?: string | string[];
  allowReuse?: boolean;
  array?: boolean;
  confirmAddedPath?: string[];
  containerPath?: string | string[];
  everyValue?: boolean;
  hidden?: boolean;
  inputSelectors?: InputSelector[];
  limit?: number;
  manual?: boolean;
  method?: string;
  name?: string;
  optionsSource?: z.infer<typeof optionsSourceSchema>;
  path?: string | string[];
  refindPerEntry?: boolean;
  removeExtraButtonPath?: string[];
  reverse?: boolean;
  savedRowPath?: string | string[];
  time?: number;
  value?: JsonValue;
  valueElementTime?: number;
  valueKey?: string;
  valuePath?: string | string[];
  valuePathMap?: Record<string, string | string[]>;
  valueRequired?: boolean;
  values?: string | Record<string, JsonValue>;
  visible?: boolean;
};

export const selectorSchema: z.ZodType<Selector> = z.lazy(() =>
  z.union([z.string(), selectorObjectSchema]),
);

export const inputSelectorSchema: z.ZodType<InputSelector> = z.tuple([
  z.string().min(1),
  z.array(selectorSchema),
]);

export const selectorObjectSchema: z.ZodType<SelectorConfig> = z.lazy(() =>
  z
    .object({
      actions: z.array(actionSchema).optional(),
      addButtonPath: pathSchema.optional(),
      allowReuse: z.boolean().optional(),
      array: z.boolean().optional(),
      confirmAddedPath: z.array(z.string()).optional(),
      containerPath: pathSchema.optional(),
      everyValue: z.boolean().optional(),
      hidden: z.boolean().optional(),
      inputSelectors: z.array(inputSelectorSchema).optional(),
      limit: z.number().int().positive().optional(),
      manual: z.boolean().optional(),
      method: z.string().optional(),
      name: z.string().optional(),
      optionsSource: optionsSourceSchema.optional(),
      path: pathSchema.optional(),
      refindPerEntry: z.boolean().optional(),
      removeExtraButtonPath: z.array(z.string()).optional(),
      reverse: z.boolean().optional(),
      savedRowPath: pathSchema.optional(),
      time: z.number().nonnegative().optional(),
      value: jsonValueSchema.optional(),
      valueElementTime: z.number().nonnegative().optional(),
      valueKey: z.string().optional(),
      valuePath: pathSchema.optional(),
      valuePathMap: z.record(pathSchema).optional(),
      valueRequired: z.boolean().optional(),
      values: z.union([z.string(), z.record(jsonValueSchema)]).optional(),
      visible: z.boolean().optional(),
    })
    .strict(),
);

export const trackedInputSelectorSchema = z
  .object({
    fieldPath: pathSchema,
    kind: z.literal("file").optional(),
    requiredPath: pathSchema.optional(),
    fillActions: z.array(actionSchema).optional(),
    inputPath: z.array(z.string()).optional(),
    inputTextPath: z.array(z.string()).optional(),
    labelPath: pathSchema,
    // One shared uploader's instructions can ask for multiple document kinds.
    label: z.string().optional(),
    optionsPath: z.array(z.string()).optional(),
    optionsSelectedPath: z.array(z.string()).optional(),
    optionsSource: optionsSourceSchema.optional(),
    optionsTextPath: z.array(z.string()).optional(),
    sectionPath: z.array(z.string()).optional(),
    valueRequired: z.boolean().optional(),
  })
  .strict();

export const siteConfigSchema = z
  .object({
    ats: z.string().min(1),
    containerPath: z.array(z.string()),
    containerRequired: z.boolean(),
    defaultMethod: z.string(),
    embeddedPaths: z.array(z.array(z.string())),
    inputSelectors: z.array(inputSelectorSchema),
    pathsExcluded: z.array(z.array(z.string())),
    // An empty resume slot on a site that parses an uploaded resume and
    // writes what it read over the form (PACCAR's SuccessFactors wrote
    // "UNSPECIFIED" as a company). Where one matches, the resume
    // is uploaded first and alone, and the form is filled once the site has
    // settled, so the profile's values are written last.
    resumeFirstPaths: z.array(z.string()).optional(),
    submitButtonPaths: z.array(z.string()),
    submittedSuccessPaths: z.array(z.string()),
    trackedInputSelectors: z.array(trackedInputSelectorSchema),
    urls: z.array(z.string()),
    urlsExcluded: z.array(z.string()),
  })
  .strict();
export type SiteConfig = z.infer<typeof siteConfigSchema>;

const namesSchema = z.union([z.string(), z.array(z.string())]);
// Tables shared by every site's rules (globals.json): countries by ISO
// 3166-1 alpha-2 code, regions by country and ISO 3166-2 code (each with its
// names, the usual one first), and answer wordings that mean the same.
export const globalConfigSchema = z
  .object({
    countries: z.record(namesSchema),
    regionsByCountry: z.record(z.record(namesSchema)),
    fieldNameAliases: z.record(z.string()),
  })
  .strict();
export type GlobalConfig = z.infer<typeof globalConfigSchema>;
