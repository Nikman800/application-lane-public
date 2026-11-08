import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeEach, test } from "node:test";
import { siteConfigSchema } from "../src/engine/config/schema";
import {
  fetchSiteOptions,
  forgetSiteOptions,
  listedNames,
  readOptions,
  sourceUrl,
  type OptionsSource,
} from "../src/engine/config/options-source";

// Every optionsSource the site rules carry, by the list it reads.
const sources = async (site: string) => {
  const config = siteConfigSchema.parse(JSON.parse(await readFile(`src/engine/config/sites/${site}.json`, "utf8")));
  const found: OptionsSource[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      const source = (node as { optionsSource?: OptionsSource }).optionsSource;
      if (source) found.push(source);
      Object.values(node).forEach(walk);
    }
  };
  walk(config.inputSelectors);
  return found;
};
const workday = async (list: string) => (await sources("workday")).find((source) => source.urlTemplate.endsWith(list))!;

beforeEach(() => forgetSiteOptions());

test("a Workday list's address is read from the page's host and tenant", async () => {
  const studies = await workday("/fieldsOfStudy");
  assert.equal(
    sourceUrl(studies, "https://acme.wd5.myworkdayjobs.com/en-US/Acme_Careers/job/Tampa/AI_J2467953/apply"),
    "https://acme.wd5.myworkdayjobs.com/wday/calypso/cxs/jobapplication/acme/values/educations/fieldsOfStudy",
  );
  // A site under /recruiting/ names its tenant there, not in its host.
  assert.equal(
    sourceUrl(await workday("/degrees"), "https://wd1.myworkdaysite.com/recruiting/acme/External/job/x/apply"),
    "https://wd1.myworkdaysite.com/wday/calypso/cxs/jobapplication/acme/values/educations/degrees",
  );
});

test("a Greenhouse school search takes the board from the path or the embed's for=", async () => {
  const schools = (await sources("greenhouse")).find((source) => source.urlTemplate.includes("/education/schools"))!;
  assert.equal(
    sourceUrl(schools, "https://boards.greenhouse.io/acme/jobs/4567", "Michigan State"),
    "https://boards.greenhouse.io/v1/boards/acme/education/schools?term=Michigan%20State&page=1",
  );
  assert.equal(
    sourceUrl(schools, "https://boards.greenhouse.io/embed/job_app?for=robinhood&token=1", "MIT"),
    "https://boards.greenhouse.io/v1/boards/robinhood/education/schools?term=MIT&page=1",
  );
});

test("names are read from the body or a nested array, and anything else is no list", async () => {
  const studies = await workday("/fieldsOfStudy");
  assert.deepEqual(readOptions([{ id: "1", descriptor: "Data Science" }, { id: "2", descriptor: "" }, { id: "3" }], studies), ["Data Science"]);
  assert.equal(readOptions({ error: "unauthorized" }, studies), undefined);
  assert.deepEqual(
    readOptions({ items: [{ text: "Michigan State University" }] }, { ...studies, responseItemsPath: "items", responseTextPath: "text" }),
    ["Michigan State University"],
  );
});

test("a whole list is fetched once per page, and a failed one is not kept", async () => {
  const studies = await workday("/fieldsOfStudy");
  const page = "https://acme.wd5.myworkdayjobs.com/en-US/Acme_Careers/job/x/apply";
  let calls = 0;
  const answer = (body: unknown, ok = true) => (async () => {
    calls++;
    return { ok, json: async () => body } as Response;
  }) as typeof fetch;
  // An HTML page where the list should be (an offline replay): no list.
  assert.equal(await fetchSiteOptions(studies, page, ["Data Science"], undefined, answer(undefined, false)), undefined);
  const listed = answer([{ descriptor: "Computer Science" }, { descriptor: "Data Science" }]);
  assert.deepEqual(await fetchSiteOptions(studies, page, ["Data Science"], undefined, listed), {
    names: ["Computer Science", "Data Science"],
    complete: true,
  });
  await fetchSiteOptions(studies, page, ["Statistics"], undefined, listed);
  assert.equal(calls, 2);
});

test("only the wordings the site lists are kept, in its spelling, and a shared one is left out", () => {
  const site = { names: ["Master of Science (MS)", "Masters", "MASTERS", "Data Science"], complete: true };
  assert.deepEqual(listedNames(["master of science ms", "Master of Science", "data science"], site), ["Master of Science (MS)", "Data Science"]);
  // "Masters" names two entries the list cannot tell apart.
  assert.deepEqual(listedNames(["Masters"], site), []);
});

test("a Workday list that answers with folders is not taken for the whole list", async () => {
  // one employer's fields of study: two folders, each a link.
  const studies = await workday("/fieldsOfStudy");
  const folders = [
    { id: "a", descriptor: "Partial List (First 500 Entries)", href: "/wday/calypso/cxs/jobapplication/globalhr/values/educations/fieldsOfStudy/a?limit=100&offset=0" },
    { id: "b", descriptor: "All", href: "/wday/calypso/cxs/jobapplication/globalhr/values/educations/fieldsOfStudy/b?limit=100&offset=0" },
  ];
  assert.equal(readOptions(folders, studies), undefined);
  assert.deepEqual(readOptions([{ id: "c", descriptor: "Data Science" }], studies), ["Data Science"]);
});
