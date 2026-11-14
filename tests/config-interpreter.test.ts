import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { realSchools } from "./support/schools";
import {
  globalConfigSchema,
  siteConfigSchema,
} from "../src/engine/config/schema";

let browser: Browser;
let page: Page;
let bundle: string;
const globals = globalConfigSchema.parse(
  JSON.parse(await readFile("src/engine/config/globals.json", "utf8")),
);
const workday = siteConfigSchema.parse(
  JSON.parse(
    await readFile("src/engine/config/sites/workday.json", "utf8"),
  ),
);

before(async () => {
  const output = await build({
    bundle: true,
    entryPoints: ["src/engine/config/interpreter.ts"],
    format: "iife",
    globalName: "ConfigEngine",
    platform: "browser",
    write: false,
  });
  bundle = output.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
});

test("interprets ordered XPath actions and bounded waits", async () => {
  await page.setContent(`
    <form id="application">
      <label>First name <input id="first"></label>
      <button id="reveal" type="button">Reveal email</button>
      <button id="submit" type="submit">Submit application</button>
      <div id="shadow"></div>
      <iframe id="frame" srcdoc="<input id='city'>"></iframe>
    </form>
    <script>
      document.querySelector('#reveal').addEventListener('click', () => {
        setTimeout(() => {
          const input = document.createElement('input');
          input.id = 'email';
          document.querySelector('#application').append(input);
        }, 40);
      });
      const root = document.querySelector('#shadow').attachShadow({mode: 'open'});
      root.innerHTML = '<input id="last">';
    </script>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(
    async ({ globals }) => {
      const config = {
        ats: "Fixture",
        urls: ["https://jobs.example.test/*"],
        urlsExcluded: [],
        embeddedPaths: [],
        pathsExcluded: [],
        containerPath: [".//form[@id='application']"],
        containerRequired: true,
        defaultMethod: "default",
        submitButtonPaths: [".//button[@id='submit']"],
        submittedSuccessPaths: [],
        trackedInputSelectors: [],
        inputSelectors: [
          ["first_name", [".//input[@id='missing']", ".//input[@id='first']"]],
          [
            "last_name",
            [".//div[@id='shadow']/shadow-root//input[@id='last']"],
          ],
          ["city", ["//input[@id='city']"]],
          ["preferred_first_name", [".//input[@id='first']"]],
          [
            "email",
            [
              {
                path: ".//button[@id='reveal']",
                actions: [
                  { method: "click" },
                  { time: 500, path: ".//input[@id='email']" },
                  { path: ".//input[@id='email']", method: "default" },
                ],
              },
            ],
          ],
        ],
      };
      const profile = {
        revision: 1,
        confirmed: true,
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
        phone: "",
        city: "Phoenix",
        state: "",
        country: "",
        address: "",
        postalCode: "",
        linkedin: "",
        website: "",
        preferredName: "Al",
        facts: [],
        work: [],
        education: [],
        answers: [],
      };
      const statuses = await (window as any).ConfigEngine.interpretConfig(
        document,
        "https://jobs.example.test/apply",
        config,
        globals,
        profile,
      );
      return {
        statuses,
        iframeMatches: (window as any).ConfigEngine.queryXPathAll(
          document,
          "//input[@id='city']",
        ).length,
        first: document.querySelector<HTMLInputElement>("#first")!.value,
        last: document
          .querySelector<HTMLElement>("#shadow")!
          .shadowRoot!.querySelector<HTMLInputElement>("#last")!.value,
        city: document
          .querySelector<HTMLIFrameElement>("#frame")!
          .contentDocument!.querySelector<HTMLInputElement>("#city")!.value,
        email: document.querySelector<HTMLInputElement>("#email")!.value,
      };
    },
    { globals },
  );
  assert.equal(result.iframeMatches, 1);
  assert.deepEqual(result.statuses, [
    { key: "first_name", status: "filled" },
    { key: "last_name", status: "filled" },
    { key: "city", status: "filled" },
    {
      key: "preferred_first_name",
      status: "failed",
      reason: "No configured selector matched.",
    },
    { key: "email", status: "filled" },
  ]);
  assert.equal(result.first, "Alex");
  assert.equal(result.last, "Rivera");
  assert.equal(result.city, "Phoenix");
  assert.equal(result.email, "alex@example.test");
});

test("DOM probes honor grouped paths and submit controls are never clicked", async () => {
  await page.setContent(`
    <form action="https://boards.greenhouse.io/acme">
      <input id="name">
      <button id="submit" type="button">Finish</button>
    </form>
    <script>window.clicks = 0; submit.onclick = () => window.clicks++;</script>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(
    async ({ globals }) => {
      const config = {
        ats: "Fixture",
        urls: [],
        urlsExcluded: [],
        embeddedPaths: [[".//form", ".//input[@id='name']"]],
        pathsExcluded: [],
        containerPath: [],
        containerRequired: false,
        defaultMethod: "default",
        submitButtonPaths: [".//button[@id='submit']"],
        submittedSuccessPaths: [],
        trackedInputSelectors: [],
        inputSelectors: [
          [
            "first_name",
            [{ path: ".//button[@id='submit']", method: "click" }],
          ],
        ],
      };
      const profile = {
        revision: 1,
        confirmed: true,
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
        phone: "",
        city: "",
        state: "",
        country: "",
        address: "",
        postalCode: "",
        linkedin: "",
        website: "",
        facts: [],
        work: [],
        education: [],
        answers: [],
      };
      return {
        statuses: await (window as any).ConfigEngine.interpretConfig(
          document,
          "https://other.example.test/apply",
          config,
          globals,
          profile,
        ),
        clicks: (window as any).clicks,
      };
    },
    { globals },
  );
  assert.equal(result.clicks, 0);
  assert.equal(result.statuses[0].status, "failed");
  assert.match(result.statuses[0].reason, /Refused/);
});

test("fills one exact accessible combobox when packaged XPath is stale", async () => {
  await page.setContent(`
    <form id="application">
      <label for="country">Country*</label>
      <input id="country" role="combobox" aria-expanded="false">
      <div id="options"></div>
      <fieldset><legend>Education</legend>
      <label for="school">School</label><input id="school">
      <label for="degree">Degree*</label>
      <select id="degree"><option value="">Select</option><option>Bachelor of Science</option></select>
      <label for="end-month">End date month*</label>
      <select id="end-month"><option value="">Month</option><option value="05">May</option></select>
      </fieldset>
    </form>
    <script>
      country.addEventListener('input', function () {
        options.innerHTML = '<div role="option">United States</div>';
        country.setAttribute('aria-expanded', 'true');
      });
      options.addEventListener('click', function (event) {
        country.value = event.target.textContent;
        country.setAttribute('aria-expanded', 'false');
      });
    </script>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(
    async ({ globals }) => {
      const profile = {
        revision: 1,
        confirmed: true,
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
        phone: "",
        city: "",
        state: "",
        country: "United States",
        address: "",
        postalCode: "",
        linkedin: "",
        website: "",
        facts: [],
        work: [],
        education: [
          {
            organization: "State University",
            title: "Bachelor of Science",
            fieldOfStudy: "Computer Science",
            startDate: "2020-08",
            endDate: "2024-05",
            location: "",
            details: "",
          },
        ],
        answers: [],
      };
      const statuses = await (window as any).ConfigEngine.interpretConfig(
        document,
        "https://jobs.example.test/apply",
        {
          ats: "Fixture",
          urls: ["https://jobs.example.test/*"],
          urlsExcluded: [],
          embeddedPaths: [],
          pathsExcluded: [],
          containerPath: [".//form[@id='application']"],
          containerRequired: true,
          defaultMethod: "react",
          submitButtonPaths: [],
          submittedSuccessPaths: [],
          trackedInputSelectors: [],
          inputSelectors: [
            ["country", [".//select[@name='stale-country-selector']"]],
            ["education", [{ array: true, inputSelectors: [] }]],
          ],
        },
        globals,
        profile,
      );
      return {
        statuses,
        value: document.querySelector<HTMLInputElement>("#country")!.value,
        school: document.querySelector<HTMLInputElement>("#school")!.value,
        degree: document.querySelector<HTMLSelectElement>("#degree")!.value,
        endMonth:
          document.querySelector<HTMLSelectElement>("#end-month")!.value,
      };
    },
    { globals },
  );
  assert.deepEqual(result.statuses, [
    { key: "country", status: "filled" },
    { key: "education", status: "filled" },
  ]);
  assert.equal(result.value, "United States");
  assert.equal(result.school, "State University");
  assert.equal(result.degree, "Bachelor of Science");
  assert.equal(result.endMonth, "05");
});

test("runs everyValue actions once per confirmed exact value", async () => {
  await page.setContent(`
    <main data-automation-id="applicationPage">
      <div data-automation-id="formField-skills">
        <div data-automation-id="multiSelectContainer"><input placeholder="Search"></div>
      </div>
    </main>
    <script>
      const input = document.querySelector('[placeholder="Search"]');
      input.addEventListener('input', () => {
        document.querySelector('[data-automation-id="activeListContainer"]')?.remove();
        const popup = document.createElement('div');
        popup.setAttribute('data-automation-id', 'activeListContainer');
        const exact = document.createElement('div');
        exact.setAttribute('data-automation-id', 'promptLeafNode');
        exact.innerHTML = '<div data-automation-id="promptOption"></div>';
        exact.firstElementChild.setAttribute('data-automation-label', input.value);
        exact.firstElementChild.textContent = input.value;
        exact.addEventListener('click', () => {
          document.body.dataset.selected = [document.body.dataset.selected, exact.textContent].filter(Boolean).join(',');
          // Workday shows each pick as a chip in the box.
          const chip = document.createElement('div');
          chip.setAttribute('data-automation-id', 'selectedItem');
          chip.title = exact.textContent;
          input.before(chip);
          input.value = '';
          popup.remove();
        });
        popup.append(exact);
        document.body.append(popup);
      });
    </script>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await (page.evaluate as any)(
    async ({ globals, workday }: any) => {
      const config = {
        ...workday,
        inputSelectors: workday.inputSelectors.filter(
          ([key]: [string, unknown]) => key === "skill",
        ),
      };
      const profile = {
        revision: 1,
        confirmed: true,
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
        phone: "",
        city: "",
        state: "",
        country: "",
        address: "",
        postalCode: "",
        linkedin: "",
        website: "",
        skills: ["TypeScript", "Python"],
        facts: [],
        work: [],
        education: [],
        answers: [],
      };
      const statuses = await (window as any).ConfigEngine.interpretConfig(
        document,
        "https://acme.wd5.myworkdayjobs.com/en-US/acme/job/skills",
        config,
        globals,
        profile,
      );
      return { statuses, selected: document.body.dataset.selected };
    },
    { globals, workday },
  );
  assert.deepEqual(result.statuses, [{ key: "skill", status: "filled" }]);
  assert.equal(result.selected, "TypeScript,Python");
});

// A pass that ran out of time while the site searched a skill left the typed
// text in the box; the site committed it when focus moved on, and the change
// read as the applicant's edit and paused the fill.
test("a pass ending mid skill search leaves the search box empty", async () => {
  await page.setContent(`
    <main data-automation-id="applicationPage">
      <div data-automation-id="formField-skills">
        <div data-automation-id="multiSelectContainer"><input placeholder="Search"></div>
      </div>
    </main>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await (page.evaluate as any)(
    async ({ globals, workday }: any) => {
      const config = {
        ...workday,
        inputSelectors: workday.inputSelectors.filter(([key]: [string, unknown]) => key === "skill"),
      };
      const profile = {
        revision: 1, confirmed: true, firstName: "Alex", lastName: "Rivera", email: "alex@example.test",
        phone: "", city: "", state: "", country: "", address: "", postalCode: "", linkedin: "", website: "",
        skills: ["Hugging Face Transformers"], facts: [], work: [], education: [], answers: [],
      };
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 800);
      let outcome = "completed";
      try {
        await (window as any).ConfigEngine.interpretConfig(
          document,
          "https://acme.wd5.myworkdayjobs.com/en-US/acme/job/skills",
          config,
          globals,
          profile,
          { signal: controller.signal },
        );
      } catch (error) {
        outcome = (error as Error).name;
      }
      return { outcome, value: document.querySelector("input")!.value };
    },
    { globals, workday },
  );
  assert.deepEqual(result, { outcome: "AbortError", value: "" });
});

test("adds exactly one repeated row per profile entry before filling", async () => {
  await page.setContent(`
    <form id="application">
      <section id="experience"><h2>Work Experience</h2><button id="add" type="button">Add</button></section>
    </form>
    <script>
      add.addEventListener('click', () => {
        const index = document.querySelectorAll('[data-row]').length + 1;
        const row = document.createElement('div');
        row.dataset.row = String(index);
        row.id = 'work-' + index;
        row.innerHTML = '<input class="company"><input class="title"><input class="location"><textarea class="details"></textarea><input class="current" type="checkbox"><input class="start-month"><input class="start-year"><input class="end-month"><input class="end-year">';
        experience.insertBefore(row, add);
      });
    </script>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(
    async ({ globals }) => {
      const profile = {
        revision: 1,
        confirmed: true,
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
        phone: "",
        city: "",
        state: "",
        country: "",
        address: "",
        postalCode: "",
        linkedin: "",
        website: "",
        facts: [],
        education: [],
        answers: [],
        work: [
          {
            organization: "First Co",
            title: "Engineer",
            location: "Phoenix",
            details: "Built systems",
            startDate: "2024-01",
            endDate: "2025-02",
          },
          {
            organization: "Second Co",
            title: "Senior Engineer",
            location: "Tucson",
            details: "Led systems",
            startDate: "2025-03",
            endDate: "",
          },
        ],
      };
      const statuses = await (window as any).ConfigEngine.interpretConfig(
        document,
        "https://jobs.example.test/apply",
        {
          ats: "Fixture",
          urls: ["https://jobs.example.test/*"],
          urlsExcluded: [],
          embeddedPaths: [],
          pathsExcluded: [],
          containerPath: [".//form[@id='application']"],
          containerRequired: true,
          defaultMethod: "default",
          submitButtonPaths: [],
          submittedSuccessPaths: [],
          trackedInputSelectors: [],
          inputSelectors: [["experience", [{
            array: true,
            addButtonPath: ".//button[@id='add']",
            confirmAddedPath: [".//div[@id='work-%NUMBER0%']"],
            containerPath: ".//div[@id='work-%NUMBER0%']",
            inputSelectors: [
              ["company", [".//input[@class='company']"]],
              ["title", [".//input[@class='title']"]],
              ["location", [".//input[@class='location']"]],
              ["description_stripped", [".//textarea[@class='details']"]],
              ["currently_working", [".//input[@class='current']"]],
              ["start_month", [".//input[@class='start-month']"]],
              ["start_year", [".//input[@class='start-year']"]],
              ["end_month", [".//input[@class='end-month']"]],
              ["end_year", [".//input[@class='end-year']"]],
            ],
          }]]],
        },
        globals,
        profile,
      );
      return {
        statuses,
        rows: [...document.querySelectorAll<HTMLElement>("[data-row]")].map(
          (row) => ({
            company: row.querySelector<HTMLInputElement>(".company")!.value,
            title: row.querySelector<HTMLInputElement>(".title")!.value,
            details: row.querySelector<HTMLTextAreaElement>(".details")!.value,
            current: row.querySelector<HTMLInputElement>(".current")!.checked,
            startMonth: row.querySelector<HTMLInputElement>(".start-month")!.value,
            startYear: row.querySelector<HTMLInputElement>(".start-year")!.value,
          }),
        ),
      };
    },
    { globals },
  );
  assert.deepEqual(result.statuses, [{ key: "experience", status: "filled" }]);
  assert.deepEqual(result.rows, [
    {
      company: "First Co",
      title: "Engineer",
      details: "Built systems",
      current: false,
      startMonth: "01",
      startYear: "2024",
    },
    {
      company: "Second Co",
      title: "Senior Engineer",
      details: "Led systems",
      current: true,
      startMonth: "03",
      startYear: "2025",
    },
  ]);
});

test("missing repeated-section Add buttons do not stop later fields", async () => {
  await page.setContent(`
    <form id="application">
      <label>LinkedIn <input id="linkedin"></label>
    </form>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(
    async ({ globals }) => {
      const repeated = {
        array: true,
        addButtonPath: ".//button[@data-add-row]",
        containerPath: ".//div[@data-row='%NUMBER0%']",
        inputSelectors: [["name", [".//input"]]],
      };
      const profile = {
        revision: 1,
        confirmed: true,
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
        phone: "",
        city: "",
        state: "",
        country: "",
        address: "",
        postalCode: "",
        linkedin: "https://www.linkedin.com/in/alex-rivera",
        website: "",
        facts: [],
        work: [{ organization: "Acme", title: "Engineer" }],
        education: [{ organization: "State University", title: "BS" }],
        answers: [],
      };
      const statuses = await (window as any).ConfigEngine.interpretConfig(
        document,
        "https://jobs.example.test/apply",
        {
          ats: "Fixture",
          urls: ["https://jobs.example.test/*"],
          urlsExcluded: [],
          embeddedPaths: [],
          pathsExcluded: [],
          containerPath: [".//form[@id='application']"],
          containerRequired: true,
          defaultMethod: "default",
          submitButtonPaths: [],
          submittedSuccessPaths: [],
          trackedInputSelectors: [],
          inputSelectors: [
            ["experience", [repeated]],
            ["education", [repeated]],
            ["linkedin", [".//input[@id='linkedin']"]],
          ],
        },
        globals,
        profile,
      );
      return {
        statuses,
        linkedin: document.querySelector<HTMLInputElement>("#linkedin")!.value,
      };
    },
    { globals },
  );
  assert.deepEqual(result.statuses, [
    {
      key: "experience",
      status: "skipped",
      reason: "No Add button was found for experience.",
    },
    {
      key: "education",
      status: "skipped",
      reason: "No Add button was found for education.",
    },
    { key: "linkedin", status: "filled" },
  ]);
  assert.equal(result.linkedin, "https://www.linkedin.com/in/alex-rivera");
});

test("does not add more repeated rows after an unconfirmed Add click", async () => {
  await page.setContent(`
    <form id="application">
      <button id="add" type="button">Add experience</button>
    </form>
    <script>window.clicks = 0; add.onclick = () => window.clicks++;</script>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(
    async ({ globals }) => {
      const profile = {
        revision: 1,
        confirmed: true,
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
        phone: "",
        city: "",
        state: "",
        country: "",
        address: "",
        postalCode: "",
        linkedin: "",
        website: "",
        facts: [],
        education: [],
        answers: [],
        work: [
          { organization: "First Co", title: "Engineer" },
          { organization: "Second Co", title: "Senior Engineer" },
        ],
      };
      const statuses = await (window as any).ConfigEngine.interpretConfig(
        document,
        "https://jobs.example.test/apply",
        {
          ats: "Fixture",
          urls: ["https://jobs.example.test/*"],
          urlsExcluded: [],
          embeddedPaths: [],
          pathsExcluded: [],
          containerPath: [".//form[@id='application']"],
          containerRequired: true,
          defaultMethod: "default",
          submitButtonPaths: [],
          submittedSuccessPaths: [],
          trackedInputSelectors: [],
          inputSelectors: [
            [
              "experience",
              [
                {
                  array: true,
                  time: 1,
                  addButtonPath: ".//button[@id='add']",
                  confirmAddedPath: [".//div[@id='work-%NUMBER0%']"],
                  containerPath: ".//div[@id='work-%NUMBER0%']",
                  inputSelectors: [["company", [".//input"]]],
                },
              ],
            ],
          ],
        },
        globals,
        profile,
      );
      return { statuses, clicks: (window as any).clicks };
    },
    { globals },
  );
  assert.equal(result.clicks, 1);
  assert.deepEqual(result.statuses, [
    {
      key: "experience",
      status: "failed",
      reason: "The added experience row was not confirmed.",
    },
  ]);
});

test("refuses to use a submit control as a repeated-section Add button", async () => {
  await page.setContent(`
    <form id="application">
      <button id="submit" type="submit">Submit application</button>
      <label>LinkedIn <input id="linkedin"></label>
    </form>
    <script>
      window.clicks = 0;
      document.querySelector('#application').onsubmit = (event) => {
        event.preventDefault();
        window.clicks++;
      };
    </script>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(
    async ({ globals }) => {
      const profile = {
        revision: 1,
        confirmed: true,
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
        phone: "",
        city: "",
        state: "",
        country: "",
        address: "",
        postalCode: "",
        linkedin: "https://www.linkedin.com/in/alex-rivera",
        website: "",
        facts: [],
        education: [],
        answers: [],
        work: [{ organization: "Acme", title: "Engineer" }],
      };
      const statuses = await (window as any).ConfigEngine.interpretConfig(
        document,
        "https://jobs.example.test/apply",
        {
          ats: "Fixture",
          urls: ["https://jobs.example.test/*"],
          urlsExcluded: [],
          embeddedPaths: [],
          pathsExcluded: [],
          containerPath: [".//form[@id='application']"],
          containerRequired: true,
          defaultMethod: "default",
          submitButtonPaths: [".//button[@id='submit']"],
          submittedSuccessPaths: [],
          trackedInputSelectors: [],
          inputSelectors: [
            [
              "experience",
              [
                {
                  array: true,
                  addButtonPath: ".//button[@id='submit']",
                  containerPath: ".//div[@data-row='%NUMBER0%']",
                  inputSelectors: [["company", [".//input"]]],
                },
              ],
            ],
            ["linkedin", [".//input[@id='linkedin']"]],
          ],
        },
        globals,
        profile,
      );
      return {
        statuses,
        clicks: (window as any).clicks,
        linkedin: document.querySelector<HTMLInputElement>("#linkedin")!.value,
      };
    },
    { globals },
  );
  assert.equal(result.clicks, 0);
  assert.equal(result.statuses[0].status, "failed");
  assert.match(result.statuses[0].reason, /Refused/);
  assert.deepEqual(result.statuses[1], { key: "linkedin", status: "filled" });
  assert.equal(result.linkedin, "https://www.linkedin.com/in/alex-rivera");
});

test("a search prompt is typed and its match picked, not typed and left", async () => {
  // The profile holds Virginia Tech by its common name; Workday lists it by
  // its official one, and its search for "Virginia Tech" finds only the
  // Carilion medical school, which is not it.
  await page.setContent(`
    <main data-automation-id="applyFlowMyExpPage">
      <div data-automation-id="education-1" role="group">
        <div data-automation-id="formField-school">
          <label for="school">School or University</label>
          <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
            <input id="school" data-automation-id="school" placeholder="Search" data-uxi-widget-type="selectinput">
            <div data-automation-id="selectedItem"></div>
          </div>
        </div>
      </div>
    </main>
    <script>
      const schools = ${JSON.stringify(realSchools)};
      let typed = '';
      document.getElementById('school').addEventListener('keydown', (event) => {
        if (event.key.length !== 1) return;
        typed += event.key;
        document.querySelector('[data-automation-activepopup="true"]')?.remove();
        const popup = document.createElement('div');
        popup.setAttribute('data-automation-activepopup', 'true');
        for (const name of schools.filter((s) => s.toLowerCase().includes(typed.toLowerCase()))) {
          const leaf = document.createElement('div');
          leaf.setAttribute('data-automation-id', 'promptLeafNode');
          leaf.textContent = name;
          leaf.addEventListener('click', () => {
            document.querySelector('[data-automation-id="selectedItem"]').textContent = name;
            popup.remove();
          });
          popup.append(leaf);
        }
        document.body.append(popup);
      });
    </script>`);
  const result = await page.evaluate(
    async ({ globals, config }) => {
      const profile = {
        revision: 1,
        confirmed: true,
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
        phone: "",
        city: "",
        state: "",
        country: "",
        address: "",
        postalCode: "",
        linkedin: "",
        website: "",
        github: "",
        addressLine2: "",
        county: "",
        currentCompany: "",
        phoneDeviceType: "Mobile",
        skills: [],
        referralSource: [],
        disabilityStatus: "",
        veteranStatus: "",
        gender: "",
        ethnicity: "",
        hispanic: "",
        workAuthorization: "",
        sponsorship: "",
        age18OrOlder: "",
        willingToRelocate: "",
        priorEmployment: "",
        acknowledgeTerms: false,
        facts: [],
        work: [],
        education: [
          {
            organization: "Virginia Tech",
            title: "Master of Science",
            fieldOfStudy: "Data Science",
            startDate: "2024-08",
            endDate: "2026-05",
            location: "",
            details: "",
          },
        ],
        answers: [],
      };
      const statuses = await (window as any).ConfigEngine.interpretConfig(
        document,
        "https://acme.wd5.myworkdayjobs.com/en-US/acme/job/apply",
        config,
        globals,
        profile,
      );
      return {
        statuses: statuses.filter((s: { key: string }) => s.key === "education"),
        selected: document.querySelector('[data-automation-id="selectedItem"]')?.textContent,
        typedValue: (document.getElementById("school") as HTMLInputElement).value,
      };
    },
    { globals, config: workday } as any,
  );
  assert.equal(result.selected, "Virginia Polytechnic Institute and State University", JSON.stringify(result));
});

test("a second education row is added even when Workday numbers rows arbitrarily", async () => {
  await page.setContent(`
    <main data-automation-id="applyFlowMyExpPage">
      <div id="education-section" role="group" aria-labelledby="Education-section">
        <h4 id="Education-section">Education</h4>
        <div data-automation-id="education-184" role="group">
          <div data-automation-id="formField-school"><label for="school-184">School or University</label><input id="school-184"></div>
        </div>
        <button data-automation-id="add-button" aria-label="Add Another Education">Add Another</button>
      </div>
    </main>
    <script>
      let next = 512;
      document.querySelector('[data-automation-id="add-button"]').addEventListener('click', () => {
        const row = document.createElement('div');
        const id = 'education-' + next++;
        row.setAttribute('data-automation-id', id);
        row.setAttribute('role', 'group');
        row.innerHTML = '<div data-automation-id="formField-school"><label for="' + id + '--school">School or University</label><input id="' + id + '--school"></div>';
        document.querySelector('[data-automation-id="add-button"]').before(row);
      });
    </script>`);
  const result = await page.evaluate(
    async ({ globals, config }) => {
      const base = {
        title: "Bachelor of Science",
        fieldOfStudy: "Computer Science",
        startDate: "2020-08",
        endDate: "2024-05",
        location: "",
        details: "",
      };
      const profile = {
        revision: 1, confirmed: true, firstName: "Alex", lastName: "Rivera",
        email: "alex@example.test", phone: "", city: "", state: "", country: "",
        address: "", addressLine2: "", postalCode: "", linkedin: "", website: "",
        github: "", county: "", currentCompany: "", phoneDeviceType: "Mobile",
        skills: [], referralSource: [], disabilityStatus: "", veteranStatus: "",
        gender: "", ethnicity: "", hispanic: "", workAuthorization: "",
        sponsorship: "", age18OrOlder: "", willingToRelocate: "",
        priorEmployment: "", acknowledgeTerms: false, facts: [], work: [],
        education: [
          { ...base, organization: "Michigan State University" },
          { ...base, organization: "Penn State" },
        ],
        answers: [],
      };
      await (window as any).ConfigEngine.interpretConfig(
        document,
        "https://acme.wd5.myworkdayjobs.com/en-US/acme/job/apply",
        config,
        globals,
        profile,
      );
      return {
        rows: document.querySelectorAll('[data-automation-id^="education-"]').length,
        schools: [...document.querySelectorAll('input[id*="school"]')].map((i) => (i as HTMLInputElement).value),
      };
    },
    { globals, config: workday } as any,
  );
  assert.equal(result.rows, 2, JSON.stringify(result));
  assert.deepEqual(result.schools, ["Michigan State University", "Penn State"], JSON.stringify(result));
});

test("Workday date sections are filled with real keystrokes, not assigned values", async () => {
  await page.setContent(`
    <main data-automation-id="applyFlowMyExpPage">
      <div data-automation-id="workExperience-1" id="workExperience-1" role="group">
        <label>Job Title<input data-automation-id="jobTitle"></label>
        <label>Company<input data-automation-id="company"></label>
        <div data-automation-id="formField-startDate" id="workExperience-1--startDate">
          <input role="spinbutton" aria-label="Month" data-automation-id="dateSectionMonth-input" id="start-month">
          <input role="spinbutton" aria-label="Year" data-automation-id="dateSectionYear-input" id="start-year">
        </div>
        <div data-automation-id="formField-endDate" id="workExperience-1--endDate">
          <input role="spinbutton" aria-label="Month" data-automation-id="dateSectionMonth-input" id="end-month">
          <input role="spinbutton" aria-label="Year" data-automation-id="dateSectionYear-input" id="end-year">
        </div>
      </div>
    </main>`);
  // The bundler keeps function names by wrapping them in __name, which the
  // page has no definition for once this callback is serialized into it.
  await page.addScriptTag({ content: "globalThis.__name ??= (f) => f;" });
  await page.addScriptTag({ content: bundle });
  const calls = await page.evaluate(
    async ({ globals, config }) => {
      const profile = {
        revision: 1, confirmed: true, firstName: "Alex", lastName: "Rivera",
        email: "alex@example.test", phone: "", city: "", state: "", country: "",
        address: "", addressLine2: "", postalCode: "", linkedin: "", website: "",
        github: "", county: "", currentCompany: "", phoneDeviceType: "Mobile",
        skills: [], referralSource: [], disabilityStatus: "", veteranStatus: "",
        gender: "", ethnicity: "", hispanic: "", workAuthorization: "",
        sponsorship: "", age18OrOlder: "", willingToRelocate: "",
        priorEmployment: "", acknowledgeTerms: false, facts: [],
        work: [
          {
            organization: "Example Labs",
            title: "Software Engineer",
            location: "Tucson, AZ",
            details: "Built TypeScript services.",
            startDate: "2025-05",
            endDate: "2026-03",
          },
        ],
        education: [],
        answers: [],
      };
      const seen: string[] = [];
      await (window as any).ConfigEngine.interpretConfig(
        document,
        "https://acme.wd5.myworkdayjobs.com/en-US/acme/job/apply",
        config,
        globals,
        profile,
        {
          execute: async (request: any) => {
            const element = request.element as Element;
            if (element.getAttribute("role") === "spinbutton")
              seen.push(`${element.id}:${request.method}:${request.values[0] ?? ""}`);
            return true;
          },
        },
      );
      return seen;
    },
    { globals, config: workday } as any,
  );
  assert.deepEqual(
    [...calls].sort(),
    [
      "end-month:trustedType:03",
      "end-year:trustedType:2026",
      "start-month:trustedType:05",
      "start-year:trustedType:2025",
    ],
    JSON.stringify(calls),
  );
});

// Applications ask for references two ways: a row per reference, or one box
// for all of them. The profile holds them as rows either way.
const referenceProfile = {
  revision: 1, confirmed: true, firstName: "Alex", lastName: "Rivera",
  email: "alex@example.test", phone: "6025550101", city: "", state: "",
  country: "", address: "", addressLine2: "", postalCode: "", linkedin: "",
  website: "", github: "", county: "", currentCompany: "",
  phoneDeviceType: "Mobile", skills: [], referralSource: [],
  disabilityStatus: "", veteranStatus: "", gender: "", ethnicity: "",
  hispanic: "", workAuthorization: "", sponsorship: "", age18OrOlder: "",
  willingToRelocate: "", priorEmployment: "", acknowledgeTerms: false,
  facts: [], work: [], education: [], answers: [],
  references: [
    {
      name: "Jordan Chen",
      relationship: "Director of Engineering, Example Labs",
      phone: "4805550111",
      email: "jordan@example.test",
    },
    {
      name: "Priya Raman",
      relationship: "Mentor, Example AI",
      phone: "4805550122",
      email: "priya@example.test",
    },
  ],
};
const fixtureConfig = {
  ats: "Fixture",
  urls: ["https://jobs.example.test/*"],
  urlsExcluded: [],
  embeddedPaths: [],
  pathsExcluded: [],
  containerPath: [".//form[@id='application']"],
  containerRequired: true,
  defaultMethod: "default",
  submitButtonPaths: [],
  submittedSuccessPaths: [],
  trackedInputSelectors: [],
  inputSelectors: [],
};

test("reference rows are filled from the profile, in order", async () => {
  await page.setContent(`
    <form id="application">
      <fieldset id="reference-1"><legend>Reference 1</legend>
        <label>Name <input id="n1"></label>
        <label>Relationship <input id="r1"></label>
        <label>Phone <input id="p1"></label>
        <label>Email <input id="e1"></label>
      </fieldset>
      <fieldset id="reference-2"><legend>Reference 2</legend>
        <label>Name <input id="n2"></label>
        <label>Relationship <input id="r2"></label>
        <label>Phone <input id="p2"></label>
        <label>Email <input id="e2"></label>
      </fieldset>
      <fieldset id="reference-3"><legend>Reference 3</legend>
        <label>Name <input id="n3"></label>
        <label>Relationship <input id="r3"></label>
        <label>Phone <input id="p3"></label>
        <label>Email <input id="e3"></label>
      </fieldset>
      <label>First name <input id="first"></label>
    </form>`);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(
    async ({ globals, config, profile }) => {
      await (window as any).ConfigEngine.interpretConfig(
        document,
        "https://jobs.example.test/apply",
        config,
        globals,
        profile,
      );
      const value = (id: string) =>
        document.querySelector<HTMLInputElement>(`#${id}`)!.value;
      return {
        first: ["n1", "r1", "p1", "e1"].map(value),
        second: ["n2", "r2", "p2", "e2"].map(value),
        third: ["n3", "r3", "p3", "e3"].map(value),
        // The applicant's own name must not leak into a reference row.
        applicant: value("first"),
      };
    },
    { globals, config: fixtureConfig, profile: referenceProfile } as any,
  );
  assert.deepEqual(result, {
    first: [
      "Jordan Chen",
      "Director of Engineering, Example Labs",
      "4805550111",
      "jordan@example.test",
    ],
    second: [
      "Priya Raman",
      "Mentor, Example AI",
      "4805550122",
      "priya@example.test",
    ],
    // Only two references are on file, so the third row stays for the user.
    third: ["", "", "", ""],
    applicant: "",
  });
});

test("a single references box lists every reference, and a yes/no one is left alone", async () => {
  await page.setContent(`
    <form id="application">
      <label for="refs">PROFESSIONAL REFERENCES: List three professional references (other than those listed as current/former supervisor) that we may contact: Please provide Name, Relationship, Phone Number and email.</label>
      <textarea id="refs"></textarea>
      <label for="available">Are professional references available on request?</label>
      <select id="available"><option value=""></option><option>Yes</option><option>No</option></select>
    </form>`);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(
    async ({ globals, config, profile }) => {
      await (window as any).ConfigEngine.interpretConfig(
        document,
        "https://jobs.example.test/apply",
        config,
        globals,
        profile,
      );
      return {
        text: document.querySelector<HTMLTextAreaElement>("#refs")!.value,
        select: document.querySelector<HTMLSelectElement>("#available")!.value,
      };
    },
    { globals, config: fixtureConfig, profile: referenceProfile } as any,
  );
  assert.equal(
    result.text,
    "Jordan Chen, Director of Engineering, Example Labs, 4805550111, jordan@example.test\nPriya Raman, Mentor, Example AI, 4805550122, priya@example.test",
  );
  assert.equal(result.select, "");
});

test("a search that finds nothing closes its list instead of hiding the page", async () => {
  // Ashby's floating-ui combobox: typing opens a list and aria-hides the rest
  // of the page until Escape (or blur) closes it.
  await page.setContent(`
    <form id="application">
      <label for="school">School</label>
      <input id="school" role="combobox" aria-expanded="false">
      <div id="rest"><label>Phone <input id="phone"></label></div>
    </form>
    <div id="portal"></div>
    <script>
      const school = document.querySelector('#school');
      const close = () => {
        school.setAttribute('aria-expanded', 'false');
        document.querySelector('#rest').removeAttribute('aria-hidden');
        document.querySelector('#portal').innerHTML = '';
      };
      school.addEventListener('input', () => {
        school.setAttribute('aria-expanded', 'true');
        document.querySelector('#rest').setAttribute('aria-hidden', 'true');
        document.querySelector('#portal').innerHTML = '<div role="listbox">No results</div>';
      });
      school.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
      school.addEventListener('blur', close);
    </script>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(
    async ({ globals }) => {
      const config = {
        ats: "Fixture",
        urls: ["https://jobs.example.test/*"],
        urlsExcluded: [],
        embeddedPaths: [],
        pathsExcluded: [],
        containerPath: [".//form[@id='application']"],
        containerRequired: true,
        defaultMethod: "default",
        submitButtonPaths: [],
        submittedSuccessPaths: [],
        trackedInputSelectors: [],
        inputSelectors: [
          [
            "city",
            [
              {
                path: ".//input[@id='school']",
                actions: [
                  { method: "defaultWithoutBlur" },
                  { time: 300, path: "//div[@id='portal']//div[@role='option']", method: "click" },
                ],
              },
            ],
          ],
        ],
      };
      const profile = {
        revision: 1, confirmed: true, firstName: "Alex", lastName: "Rivera", email: "", phone: "",
        city: "Phoenix", state: "", country: "", address: "", postalCode: "", linkedin: "", website: "",
        preferredName: "", facts: [], work: [], education: [], answers: [],
      };
      const statuses = await (window as any).ConfigEngine.interpretConfig(
        document, "https://jobs.example.test/apply", config, globals, profile,
      );
      return {
        status: statuses[0].status,
        expanded: document.querySelector("#school")!.getAttribute("aria-expanded"),
        restHidden: document.querySelector("#rest")!.getAttribute("aria-hidden"),
        focused: document.activeElement?.id || "",
      };
    },
    { globals },
  );
  assert.deepEqual(result, { status: "failed", expanded: "false", restHidden: null, focused: "" });
});

// one employer's Workday form: a second fill of the
// step clicked the Degree list open again over its answer and left it open.
// A list already showing one of its answers is not opened again.
test("a list already showing its answer is not opened again", async () => {
  await page.setContent(`
    <form id="application">
      <button id="degree" type="button" aria-haspopup="listbox">Masters</button>
    </form>
    <script>
      window.opened = 0;
      document.querySelector('#degree').addEventListener('click', () => { window.opened++; });
    </script>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(async ({ globals }) => {
    const config = {
      ats: "Fixture", urls: ["https://jobs.example.test/*"], urlsExcluded: [], embeddedPaths: [], pathsExcluded: [],
      containerPath: [".//form[@id='application']"], containerRequired: true, defaultMethod: "default",
      submitButtonPaths: [], submittedSuccessPaths: [], trackedInputSelectors: [],
      inputSelectors: [["preferred_first_name", [{ path: ".//button[@id='degree']", value: "Masters", actions: [{ method: "click" }, { time: 300, path: "//li[@role='option' and .='%VALUE%']", method: "click" }] }]]],
    };
    const profile = { revision: 1, confirmed: true, firstName: "Alex", lastName: "Rivera", email: "alex@example.test", phone: "", city: "", state: "", country: "", address: "", postalCode: "", linkedin: "", website: "", facts: [], work: [], education: [], answers: [] };
    const statuses = await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.example.test/apply", config, globals, profile);
    return { statuses, opened: (window as any).opened };
  }, { globals });
  assert.equal(result.opened, 0);
  assert.deepEqual(result.statuses.map((status: { key: string; status: string }) => [status.key, status.status]), [["preferred_first_name", "filled"]]);
});

// one employer's SuccessFactors form: a
// rule answering "No" took a list's "No Selection", which begins with "no",
// and kept the race rule from the field. A list's empty choice is no answer.
test("a list's empty choice is never picked for an answer it merely begins like", async () => {
  await page.setContent(`
    <form id="application">
      <button id="race" type="button">Choose</button>
      <button id="other" type="button">Choose</button>
      <ul id="races"><li role="option"><a>No Selection</a></li><li role="option"><a>Asian</a></li></ul>
      <ul id="others"><li role="option"><a>No Selection</a></li><li role="option"><a>No</a></li><li role="option"><a>Yes</a></li></ul>
    </form>
    <script>
      window.picked = [];
      document.querySelectorAll('li a').forEach((a) => a.addEventListener('click', () => window.picked.push(a.closest('ul').id + ':' + a.textContent)));
    </script>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(async ({ globals }) => {
    const option = `//li[@role='option']/a[starts-with(translate(normalize-space(.), "%UPPERVALUE%", "%LOWERVALUE%"), "%LOWERVALUE%")]`;
    const config = {
      ats: "Fixture", urls: ["https://jobs.example.test/*"], urlsExcluded: [], embeddedPaths: [], pathsExcluded: [],
      containerPath: [".//form[@id='application']"], containerRequired: true, defaultMethod: "default",
      submitButtonPaths: [], submittedSuccessPaths: [], trackedInputSelectors: [],
      inputSelectors: [
        ["preferred_first_name", [{ path: ".//button[@id='race']", value: "No", actions: [{ method: "click" }, { time: 300, path: "//ul[@id='races']" + option, method: "click" }] }]],
        ["preferred_last_name", [{ path: ".//button[@id='other']", value: "No", actions: [{ method: "click" }, { time: 300, path: "//ul[@id='others']" + option, method: "click" }] }]],
      ],
    };
    const profile = { revision: 1, confirmed: true, firstName: "Alex", lastName: "Rivera", email: "alex@example.test", phone: "", city: "", state: "", country: "", address: "", postalCode: "", linkedin: "", website: "", facts: [], work: [], education: [], answers: [] };
    await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.example.test/apply", config, globals, profile);
    return (window as any).picked;
  }, { globals });
  // The race list offers no "No": nothing is picked there. The other list's own "No" is.
  assert.deepEqual(result, ["others:No"]);
});

// A site that rebuilds its state list when the country changes clears a state
// chosen before it. Rules listing state first still fill country first; a
// country that appears only later is still filled in its own place.
test("country is filled before the fields it redraws, and in its own place when it appears later", async () => {
  await page.setContent(`
    <form id="application">
      <select id="state"><option value="">Select</option></select>
      <select id="country"><option value="">Select</option><option>Canada</option><option>United States</option></select>
      <button id="more" type="button">More</button>
    </form>
    <script>
      const states = { "United States": ["Arizona", "Texas"], Canada: ["Ontario"] };
      document.querySelector('#country').addEventListener('change', (event) => {
        document.querySelector('#state').innerHTML = '<option value="">Select</option>' +
          (states[event.target.value] || []).map((name) => '<option>' + name + '</option>').join('');
      });
      document.querySelector('#more').addEventListener('click', () => {
        const late = document.createElement('select');
        late.id = 'late-country';
        late.innerHTML = '<option value="">Select</option><option>United States</option>';
        document.querySelector('#application').append(late);
      });
    </script>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(async ({ globals }) => {
    const config = {
      ats: "Fixture", urls: ["https://jobs.example.test/*"], urlsExcluded: [], embeddedPaths: [], pathsExcluded: [],
      containerPath: [".//form[@id='application']"], containerRequired: true, defaultMethod: "default",
      submitButtonPaths: [], submittedSuccessPaths: [], trackedInputSelectors: [],
      inputSelectors: [
        ["state", [".//select[@id='state']"]],
        ["preferred_first_name", [{ path: ".//button[@id='more']", value: "x", actions: [{ method: "click" }] }]],
        ["country", [".//select[@id='late-country']", ".//select[@id='country']"]],
      ],
    };
    const profile = { revision: 1, confirmed: true, firstName: "Alex", lastName: "Rivera", email: "alex@example.test", phone: "", city: "Tucson", state: "Arizona", country: "United States", address: "", postalCode: "", linkedin: "", website: "", facts: [], work: [], education: [], answers: [] };
    const statuses = await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.example.test/apply", config, globals, profile);
    return {
      statuses: statuses.map((status: { key: string; status: string }) => [status.key, status.status]),
      state: document.querySelector<HTMLSelectElement>('#state')!.value,
      country: document.querySelector<HTMLSelectElement>('#country')!.value,
      late: document.querySelector<HTMLSelectElement>('#late-country')?.value,
    };
  }, { globals });
  assert.equal(result.country, "United States");
  assert.equal(result.state, "Arizona");
  // Filled first, country is not filled again in its own place.
  assert.equal(result.late, "");
  assert.deepEqual(result.statuses.filter(([key]: string[]) => key === "country"), [["country", "filled"]]);
});

// one employer's SuccessFactors lists: an option that is one of
// a rule's values is taken over a looser match of a value before it, and the
// values' order still decides among exact ones. "Bachelor" had chosen
// "Bachelor in Business Administration" by its start; taking every exact
// title first instead chose "Intermediate", the last of the proficiency
// rule's values, over "fluent", written in another case.
test("an exact option beats a looser match, and value order decides among exact ones", async () => {
  await page.setContent(`
    <form id="application">
      <input id="degree"><input id="speaking">
    </form>
    <script>
      for (const [id, names] of [["degree", ["Bachelor in Business Administration", "Bachelor of Arts", "Bachelor of Science"]], ["speaking", ["Beginner", "Fluent", "Intermediate"]]]) {
        const input = document.getElementById(id);
        input.addEventListener('click', () => {
          document.querySelector('ul')?.remove();
          const list = document.createElement('ul');
          for (const name of names) {
            const item = document.createElement('li');
            item.innerHTML = '<a title="' + name + '">' + name + '</a>';
            item.querySelector('a').addEventListener('click', () => { input.value = name; list.remove(); });
            list.append(item);
          }
          document.body.append(list);
        });
      }
    </script>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(
    async ({ globals }) => {
      const selectors = [
        ["degree", ["Bachelor", "Bachelor of Science", "Bachelor's Degree"]],
        ["speaking", ["fluent", "Excellent", "Advanced", "Proficient", "Intermediate"]],
      ].map(([id, value]) => [id, [{
        path: `.//input[@id='${id}']`,
        value,
        actions: [
          { method: "click" },
          {
            path: [
              '//ul/li/a[@title="%VALUE%"]',
              '//ul/li/a[starts-with(translate(normalize-space(.), "%UPPERVALUE%", "%LOWERVALUE%"), "%LOWERVALUE%")]',
            ],
            method: "click",
            time: 1000,
          },
        ],
      }]]);
      const config = {
        ats: "Fixture",
        urls: ["https://jobs.example.test/*"],
        urlsExcluded: [],
        embeddedPaths: [],
        pathsExcluded: [],
        containerPath: [".//form[@id='application']"],
        containerRequired: true,
        defaultMethod: "default",
        submitButtonPaths: [],
        submittedSuccessPaths: [],
        trackedInputSelectors: [],
        inputSelectors: selectors,
      };
      const profile = { revision: 1, confirmed: true, firstName: "Alex", lastName: "Rivera", email: "alex@example.test", phone: "", city: "", state: "", country: "", address: "", postalCode: "", linkedin: "", website: "", facts: [], work: [], education: [], answers: [] };
      await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.example.test/apply", config, globals, profile);
      return {
        degree: (document.getElementById("degree") as HTMLInputElement).value,
        speaking: (document.getElementById("speaking") as HTMLInputElement).value,
      };
    },
    { globals },
  );
  assert.deepEqual(result, { degree: "Bachelor of Science", speaking: "Fluent" });
});

test("an option named exactly as the answer is taken over one a shorter wording begins", async () => {
  // SmartRecruiters' phone country: "US" began "US
  // Virgin Islands", listed before "United States".
  await page.setContent(`<form id="application"><div id="list">
    <div role="option" label="US Virgin Islands">US Virgin Islands</div>
    <div role="option" label="United States">United States</div>
  </div></form>`);
  await page.addScriptTag({ content: bundle });
  const clicked = await page.evaluate(async ({ globals }) => {
    const picked: string[] = [];
    const config = {
      ats: "Fixture", urls: ["https://jobs.example.test/*"], urlsExcluded: [], embeddedPaths: [], pathsExcluded: [],
      containerPath: [".//form[@id='application']"], containerRequired: true, defaultMethod: "default",
      submitButtonPaths: [], submittedSuccessPaths: [], trackedInputSelectors: [],
      inputSelectors: [["phone_country", [{
        path: [".//div[@role='option' and starts-with(translate(@label, '%UPPERVALUE%', '%LOWERVALUE%'), '%LOWERVALUE%')]"],
        valueKey: "country", values: "countryAbbreviationsToNames", method: "click",
      }]]],
    };
    const profile = { revision: 1, confirmed: true, firstName: "", lastName: "", email: "", phone: "", city: "", state: "", country: "United States of America", address: "", postalCode: "", linkedin: "", website: "", facts: [], work: [], education: [], answers: [] };
    await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.example.test/apply", config, globals, profile, {
      execute: async ({ element }: { element: HTMLElement }) => (picked.push(element.getAttribute("label") || ""), true),
    });
    return picked;
  }, { globals });
  assert.deepEqual(clicked, ["United States"]);
});

test("SmartRecruiters' saved experience cards are the profile's rows, not ones to add again", async () => {
  // an employer: filled again, the form's saved
  // entries counted as none, and every job and school was added twice.
  const parsed = siteConfigSchema.parse(JSON.parse(await readFile("src/engine/config/sites/smartrecruiters.json", "utf8")));
  // Only the experience rule, as plain data for the page.
  const only: unknown = JSON.parse(JSON.stringify({ ...parsed, inputSelectors: parsed.inputSelectors.filter((selector) => selector[0] === "experience") }));
  const card = (title: string, company: string, years: string) =>
    `<oc-experience-entry data-test="experience-entry"><div data-test="experience-entry"><p data-test="experience-entry-title"> ${title} <span data-test="experience-entry-date">${years}</span></p><p data-test="experience-entry-company"> ${company} </p></div></oc-experience-entry>`;
  await page.setContent(`<div id="form"><oc-experience>${card("Software Engineer Intern", "Brightline.AI", "2023 - 2023")}${card("Founder & Solo Developer", "Pixelforge", "2025 - Present")}
    <button data-test="add-experience" type="button">Add experience</button></oc-experience></div>`);
  await page.addScriptTag({ content: "globalThis.__name ??= (f) => f;" });
  await page.addScriptTag({ content: bundle });
  const clicked = await page.evaluate(async ({ globals, only }) => {
    const touched: string[] = [];
    const profile = { revision: 1, confirmed: true, firstName: "", lastName: "", email: "", phone: "", city: "", state: "", country: "", address: "", postalCode: "", linkedin: "", website: "", facts: [], education: [], answers: [],
      work: [
        { organization: "Pixelforge", title: "Founder & Solo Developer", location: "", startDate: "2025-03", endDate: "", details: "" },
        { organization: "Brightline.AI", title: "Software Engineer Intern", location: "", startDate: "2023-07", endDate: "2023-09", details: "" },
      ] };
    await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.smartrecruiters.com/oneclick-ui/company/Acme/publication/1", only, globals, profile, {
      execute: async ({ element }: { element: HTMLElement }) => (touched.push(element.getAttribute("data-test") || element.tagName), true),
    });
    return touched;
  }, { globals, only });
  assert.deepEqual(clicked, []);
});

// one employer's SmartRecruiters form: each box of
// an experience entry sits inside its component's shadow root, so none was
// found, and the entry was saved empty and refused ("Title" required).
test("SmartRecruiters' experience boxes inside their components' shadow roots are filled before Save", async () => {
  const parsed = siteConfigSchema.parse(JSON.parse(await readFile("src/engine/config/sites/smartrecruiters.json", "utf8")));
  const only: unknown = JSON.parse(JSON.stringify({ ...parsed, inputSelectors: parsed.inputSelectors.filter((selector) => selector[0] === "experience") }));
  await page.setContent(`<div id="form"><oc-experience><oc-button data-test="add-experience"><button type="button">Add</button></oc-button><div id="entries"></div></oc-experience></div>
  <script>{
    const shadowed = (tag, inner) => { const host = document.createElement(tag); host.attachShadow({ mode: "open" }).innerHTML = inner; return host; };
    document.querySelector('[data-test="add-experience"]').addEventListener("click", () => {
      if (document.querySelector('[data-test="experience-edit-form"]')) return;
      const entry = document.createElement("oc-experience-entry");
      const form = document.createElement("div");
      form.setAttribute("data-test", "experience-edit-form");
      for (const [test, label] of [["job-title-autocomplete", "Title"], ["company-autocomplete", "Company"], ["location-autocomplete", "Location"]]) {
        // The box is one shadow root further in, inside the autocomplete's
        // own spl-input.
        const box = shadowed("spl-autocomplete", '<div><label>' + label + '</label><spl-dropdown><div></div></spl-dropdown></div>');
        box.shadowRoot.querySelector("spl-dropdown div").append(shadowed("spl-input", '<div><input type="text" role="combobox"></div>'));
        box.setAttribute("data-test", test);
        form.append(box);
      }
      const description = document.createElement("oc-textarea");
      description.setAttribute("data-test", "experience-description");
      description.append(shadowed("spl-textarea", "<textarea></textarea>"));
      const current = document.createElement("oc-checkbox");
      current.setAttribute("data-test", "experience-current");
      current.append(shadowed("spl-checkbox", '<input type="checkbox">'));
      const save = document.createElement("oc-button");
      save.setAttribute("data-test", "experience-save");
      save.append(shadowed("spl-button", '<button type="button">Save</button>'));
      form.append(description, current, save);
      entry.append(form);
      document.getElementById("entries").append(entry);
    });
  }</script>`);
  await page.addScriptTag({ content: "globalThis.__name ??= (f) => f;" });
  await page.addScriptTag({ content: bundle });
  const touched = await page.evaluate(async ({ globals, only }) => {
    const order: string[] = [];
    const profile = { revision: 1, confirmed: true, firstName: "", lastName: "", email: "", phone: "", city: "", state: "", country: "", address: "", postalCode: "", linkedin: "", website: "", facts: [], education: [], answers: [],
      work: [{ organization: "Pixelforge", title: "Founder & Solo Developer", location: "Remote", startDate: "2025-03", endDate: "", details: "Built the scoring service." }] };
    await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.smartrecruiters.com/oneclick-ui/company/Acme/publication/1", only, globals, profile, {
      execute: async ({ element, values }: { element: Element; values: string[] }) => {
        // The component the box belongs to: the nearest host with a name.
        let host = (element.getRootNode() as ShadowRoot).host as Element | undefined;
        while (host && !host.getAttribute("data-test") && !host.parentElement?.getAttribute("data-test")) host = ((host.getRootNode() as ShadowRoot).host as Element | undefined);
        const name = host ? (host.getAttribute("data-test") || host.parentElement?.getAttribute("data-test") || host.tagName) : element.getAttribute("data-test") || element.tagName;
        order.push(`${name}${values[0] ? `=${values[0]}` : ""}`);
        if (element instanceof HTMLButtonElement || element.matches("oc-button, spl-button")) element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      },
    });
    return order;
  }, { globals, only });
  const save = touched.findIndex((step) => step.startsWith("experience-save"));
  assert.ok(touched.includes("job-title-autocomplete=Founder & Solo Developer"), touched.join(" | "));
  assert.ok(touched.includes("company-autocomplete=Pixelforge"), touched.join(" | "));
  assert.ok(touched.some((step) => step.startsWith("experience-description=Built the scoring service")), touched.join(" | "));
  assert.ok(save > touched.indexOf("job-title-autocomplete=Founder & Solo Developer"), touched.join(" | "));
});

// one employer's SmartRecruiters form: the title was typed, its
// suggestion list opened, and the Escape that closed the list discarded the
// typed text, as the component takes Escape in a box that keeps what is typed.
test("a SmartRecruiters box that keeps typed text keeps it when its list is closed", async () => {
  const parsed = siteConfigSchema.parse(JSON.parse(await readFile("src/engine/config/sites/smartrecruiters.json", "utf8")));
  const only: unknown = JSON.parse(JSON.stringify({ ...parsed, inputSelectors: parsed.inputSelectors.filter((selector) => selector[0] === "experience") }));
  await page.setContent(`<div id="form"><oc-experience><oc-button data-test="add-experience"><button type="button">Add</button></oc-button><div id="entries"></div></oc-experience></div>
  <script>{
    const shadowed = (tag, inner) => { const host = document.createElement(tag); host.attachShadow({ mode: "open" }).innerHTML = inner; return host; };
    document.querySelector('[data-test="add-experience"]').addEventListener("click", () => {
      if (document.querySelector('[data-test="experience-edit-form"]')) return;
      const entry = document.createElement("oc-experience-entry");
      const form = document.createElement("div");
      form.setAttribute("data-test", "experience-edit-form");
      const box = shadowed("spl-autocomplete", "<div><spl-dropdown><div></div></spl-dropdown></div>");
      box.setAttribute("data-test", "job-title-autocomplete");
      box.setAttribute("allowcustomvalues", "");
      const input = shadowed("spl-input", '<input type="text" role="combobox" aria-expanded="false">').shadowRoot;
      box.shadowRoot.querySelector("spl-dropdown div").append(input.host);
      const field = input.querySelector("input");
      field.id = "title-box";
      // As the component does: the typed text is offered in its menu a
      // moment later, and only an entry clicked there becomes its value.
      field.addEventListener("input", () => {
        field.setAttribute("aria-expanded", "true");
        clearTimeout(field.offer);
        field.offer = setTimeout(() => {
          box.shadowRoot.querySelector('[role="listbox"]')?.remove();
          const menu = document.createElement("div");
          menu.setAttribute("role", "listbox");
          menu.innerHTML = '<div role="option">' + field.value + '</div><div role="option">' + field.value + ' (Senior)</div>';
          menu.firstElementChild.addEventListener("click", () => { box.setAttribute("value", field.value); menu.remove(); });
          box.shadowRoot.append(menu);
        }, 300);
      });
      // Down highlights the menu's first entry and Enter picks it; Enter
      // alone picks nothing (the applicant's account).
      let highlighted = null;
      field.addEventListener("keydown", (event) => {
        const first = box.shadowRoot.querySelector('[role="listbox"] [role="option"]');
        if (event.key === "ArrowDown" && first) highlighted = first;
        if (event.key === "Enter" && highlighted) highlighted.click();
      });
      field.addEventListener("keydown", (event) => { if (event.key === "Escape") { field.value = ""; field.setAttribute("aria-expanded", "false"); } });
      field.addEventListener("blur", () => field.setAttribute("aria-expanded", "false"));
      form.append(box);
      entry.append(form);
      document.getElementById("entries").append(entry);
    });
    window.titleBox = () => document.querySelector('[data-test="job-title-autocomplete"]').shadowRoot.querySelector("spl-input").shadowRoot.querySelector("input");
  }</script>`);
  await page.addScriptTag({ content: "globalThis.__name ??= (f) => f;" });
  await page.addScriptTag({ content: bundle });
  const kept = await page.evaluate(async ({ globals, only }) => {
    const profile = { revision: 1, confirmed: true, firstName: "", lastName: "", email: "", phone: "", city: "", state: "", country: "", address: "", postalCode: "", linkedin: "", website: "", facts: [], education: [], answers: [],
      work: [{ organization: "Pixelforge", title: "Founder & Solo Developer", location: "", startDate: "2025-03", endDate: "", details: "" }] };
    await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.smartrecruiters.com/oneclick-ui/company/Acme/publication/1", only, globals, profile);
    return [(window as any).titleBox()?.value, document.querySelector('[data-test="job-title-autocomplete"]')!.getAttribute("value")];
  }, { globals, only });
  assert.deepEqual(kept, ["Founder & Solo Developer", "Founder & Solo Developer"]);
});

// SmartRecruiters' dates: a flatpickr month picker inside two
// shadow roots, its year between two arrows and its months as cells named by
// their first day. "From" was required and left empty, so no entry saved.
test("a SmartRecruiters experience date is picked from its month calendar", async () => {
  const parsed = siteConfigSchema.parse(JSON.parse(await readFile("src/engine/config/sites/smartrecruiters.json", "utf8")));
  const only: unknown = JSON.parse(JSON.stringify({ ...parsed, inputSelectors: parsed.inputSelectors.filter((selector) => selector[0] === "experience") }));
  await page.setContent(`<div id="form"><oc-experience><oc-button data-test="add-experience"><button type="button">Add</button></oc-button><div id="entries"></div></oc-experience></div>
  <script>{
    const names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const datePicker = (test) => {
      const holder = document.createElement("oc-datepicker");
      holder.setAttribute("data-test", test);
      const field = document.createElement("spl-date-field");
      const picker = document.createElement("spl-date-picker");
      const root = picker.attachShadow({ mode: "open" });
      root.innerHTML = '<input class="c-spl-input flatpickr-input" type="text" placeholder="Pick a date">' +
        '<div class="flatpickr-calendar"><span class="flatpickr-prev-month" role="button"></span><input class="numInput cur-year" type="number" value="2026"><span class="flatpickr-next-month" role="button"></span><div class="flatpickr-monthSelect-months"></div></div>';
      const year = root.querySelector(".cur-year");
      const draw = () => {
        root.querySelector(".flatpickr-monthSelect-months").innerHTML = names.map((name) => '<span class="flatpickr-monthSelect-month" aria-label="' + name + ' 1, ' + year.value + '">' + name.slice(0, 3) + '</span>').join("");
        for (const cell of root.querySelectorAll(".flatpickr-monthSelect-month"))
          cell.addEventListener("click", () => { root.querySelector(".flatpickr-input").value = cell.textContent + " " + year.value; });
      };
      root.querySelector(".flatpickr-prev-month").addEventListener("click", () => { year.value = String(Number(year.value) - 1); draw(); });
      root.querySelector(".flatpickr-next-month").addEventListener("click", () => { year.value = String(Number(year.value) + 1); draw(); });
      draw();
      field.attachShadow({ mode: "open" }).append(picker);
      holder.append(field);
      return holder;
    };
    document.querySelector('[data-test="add-experience"]').addEventListener("click", () => {
      if (document.querySelector('[data-test="experience-edit-form"]')) return;
      const entry = document.createElement("oc-experience-entry");
      const form = document.createElement("div");
      form.setAttribute("data-test", "experience-edit-form");
      form.append(datePicker("experience-date-from"), datePicker("experience-date-to"));
      entry.append(form);
      document.getElementById("entries").append(entry);
    });
    window.dateOf = (test) => document.querySelector('[data-test="' + test + '"] spl-date-field').shadowRoot.querySelector("spl-date-picker").shadowRoot.querySelector(".flatpickr-input").value;
  }</script>`);
  await page.addScriptTag({ content: "globalThis.__name ??= (f) => f;" });
  await page.addScriptTag({ content: bundle });
  const dates = await page.evaluate(async ({ globals, only }) => {
    const profile = { revision: 1, confirmed: true, firstName: "", lastName: "", email: "", phone: "", city: "", state: "", country: "", address: "", postalCode: "", linkedin: "", website: "", facts: [], education: [], answers: [],
      work: [{ organization: "Pixelforge", title: "Founder & Solo Developer", location: "", startDate: "2023-07", endDate: "2024-09", details: "" }] };
    await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.smartrecruiters.com/oneclick-ui/company/Acme/publication/1", only, globals, profile);
    return [(window as any).dateOf("experience-date-from"), (window as any).dateOf("experience-date-to")];
  }, { globals, only });
  assert.deepEqual(dates, ["Jul 2023", "Sep 2024"]);
});

// one employer's SuccessFactors application lives on ns2cloud.com: the rule did not cover that host, so the page was
// filled as a generic form, its sections, resume and cover letter untouched.
test("SuccessFactors' rule covers an application on ns2cloud.com", async () => {
  const parsed = siteConfigSchema.parse(JSON.parse(await readFile("src/engine/config/sites/successfactors.json", "utf8")));
  await page.setContent("<main></main>");
  await page.addScriptTag({ content: "globalThis.__name ??= (f) => f;" });
  await page.addScriptTag({ content: bundle });
  const matched = await page.evaluate((config) => [
    "https://career-hcm20.ns2cloud.com/portalcareer?_s.crb=fixture",
    "https://career5.successfactors.eu/careers?company=acme",
    "https://jobs.example.test/apply",
  ].map((url) => (window as any).ConfigEngine.matchesSiteConfig(config, url, document)), JSON.parse(JSON.stringify(parsed)));
  assert.deepEqual(matched, [true, true, false]);
});

// one employer's SuccessFactors Veteran Status:
// its list words the answer "Not Protected Veteran (OFCCP)", and the rule
// took "No Selection", which begins with the last wording tried, "No".
test("SuccessFactors' veteran list takes its Not Protected Veteran entry, never No Selection", async () => {
  const parsed = siteConfigSchema.parse(JSON.parse(await readFile("src/engine/config/sites/successfactors.json", "utf8")));
  const config = { ...parsed, urls: ["https://jobs.example.test/*"], inputSelectors: parsed.inputSelectors.filter(([key]) => key === "veteran") };
  // As an employer draws it: the label inside <font> tags, so the rule's
  // label path misses and the accessible fallback picks; the list checks
  // itself only as focus leaves it.
  await page.setContent(`<div class="RCMFormField rcmFormElement "><font face="Arial"><font face="Arial"><font face="Arial"><label id="574:" for="570:_input" class="rcmFormFieldLabel"><span class="requiredField" aria-hidden="true" role="presentation">*</span>&nbsp;Veteran Status</label><div class="fieldComponentInput"><input aria-label="Veteran Status" type="text" role="combobox" placeholder="No Selection" aria-owns="571:_listSelect" aria-required="true" aria-invalid="true" id="570:_input" class="rcmpaginatedselectinput rcmpaginatedselectitem rcmpaginatedselect_accessible"><div role="alert" class="rcmValidationMsgArea">Veteran Status is required</div></div></font></font></font></div>
  <script>{
    const input = document.getElementById("570:_input");
    // As its RCMPaginatedPicklistSingleSelect does: the list stays open
    // after a pick, Escape (keyCode 27) closes it, and leaving the box checks
    // it only with the list closed.
    input.addEventListener("blur", () => {
      if (input.getAttribute("aria-expanded") === "true") return;
      if (input.value && input.value !== "No Selection") input.setAttribute("aria-invalid", "false");
    });
    input.addEventListener("keydown", (event) => {
      if (event.keyCode !== 27) return;
      document.querySelector(".sf-combo-listselect")?.remove();
      input.setAttribute("aria-expanded", "false");
    });
    window.picked = [];
    input.addEventListener("click", () => {
      if (document.getElementById("571:_listSelect")) return;
      const menu = document.createElement("div");
      menu.className = "globalMenu sf-combo-listselect";
      menu.innerHTML = '<ul id="571:_listSelect" role="listbox" class="sf-list-select fd-list fd-list--compact">' +
        ["No Selection", "Not Protected Veteran (OFCCP)", "Prefer Not To Answer (OFCCP)", "Protected Veteran (OFCCP)"].map((name, n) =>
          '<li id="571:item' + n + '" role="option" class="globalMenuItem fd-list__item fd-list__item--compact"><a title="' + name + '">' + name + '</a></li>').join("") + "</ul>";
      menu.addEventListener("click", (event) => {
        const a = event.target.closest("li").querySelector("a");
        window.picked.push(a.title);
        input.value = a.title;
        input.focus();
      });
      input.setAttribute("aria-expanded", "true");
      document.body.append(menu);
    });
  }</script>`);
  await page.addScriptTag({ content: "globalThis.__name ??= (f) => f;" });
  await page.addScriptTag({ content: bundle });
  const picked = await page.evaluate(async ({ globals, config }) => {
    const profile = { revision: 1, confirmed: true, firstName: "", lastName: "", email: "", phone: "", city: "", state: "", country: "", address: "", postalCode: "", linkedin: "", website: "", veteranStatus: "I am not a veteran", facts: [], work: [], education: [], answers: [] };
    await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.example.test/apply", config, globals, profile);
    return [(window as any).picked, document.getElementById("570:_input")!.getAttribute("aria-invalid")];
  }, { globals, config: JSON.parse(JSON.stringify(config)) });
  assert.deepEqual(picked, [["Not Protected Veteran (OFCCP)"], "false"]);
});

test("a Workday list opened and left without a pick is closed by a press beside it", async () => {
  // one employer's Veteran Status: a second press
  // on its button leaves Workday's list open over the form.
  await page.setContent(`<div data-automation-id="mainContent"><form id="application">
    <label for="vet">Veteran Status</label><button id="vet" type="button" aria-haspopup="listbox" aria-expanded="false">Select One</button>
  </form></div><script>
    const button = document.getElementById("vet");
    button.addEventListener("click", () => {
      if (document.getElementById("popup")) return;
      button.setAttribute("aria-expanded", "true");
      const popup = document.createElement("div");
      popup.id = "popup";
      popup.setAttribute("data-automation-activepopup", "true");
      popup.innerHTML = '<ul role="listbox"><li role="option">Select One</li><li role="option">I am an Active Duty Wartime Veteran</li></ul>';
      document.body.append(popup);
    });
    document.querySelector('[data-automation-id="mainContent"]').addEventListener("click", (event) => {
      if (event.target === button) return;
      document.getElementById("popup")?.remove();
      button.setAttribute("aria-expanded", "false");
    });
  </script>`);
  await page.addScriptTag({ content: bundle });
  const open = await page.evaluate(async ({ globals }) => {
    const config = {
      ats: "Fixture", urls: ["https://jobs.example.test/*"], urlsExcluded: [], embeddedPaths: [], pathsExcluded: [],
      containerPath: [".//form[@id='application']"], containerRequired: true, defaultMethod: "default",
      submitButtonPaths: [], submittedSuccessPaths: [], trackedInputSelectors: [],
      inputSelectors: [["veteran_v2", [".//button[@id='missing']"]]],
    };
    const profile = { revision: 1, confirmed: true, firstName: "", lastName: "", email: "", phone: "", city: "", state: "", country: "", address: "", postalCode: "", linkedin: "", website: "", veteranStatus: "I am not a veteran", facts: [], work: [], education: [], answers: [] };
    await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.example.test/apply", config, globals, profile);
    return Boolean(document.getElementById("popup"));
  }, { globals });
  assert.equal(open, false);
});

test("SmartRecruiters' City box is found by its component's label", async () => {
  // As one employer's form draws it (capture): the box sits inside
  // the location autocomplete, named only by the components' label.
  const parsed = siteConfigSchema.parse(JSON.parse(await readFile("src/engine/config/sites/smartrecruiters.json", "utf8")));
  const only: unknown = JSON.parse(JSON.stringify({ ...parsed, inputSelectors: parsed.inputSelectors.filter((selector) => selector[0] === "city") }));
  await page.setContent(`<oc-location-autocomplete><spl-autocomplete label="City" data-test="location-autocomplete"><div class="c-spl-autocomplete-trigger"><spl-input type="text" label="City"><input class="c-spl-input" type="text"></spl-input></div></spl-autocomplete></oc-location-autocomplete>`);
  await page.addScriptTag({ content: "globalThis.__name ??= (f) => f;" });
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(async ({ globals, only }) => {
    const profile = { revision: 1, confirmed: true, firstName: "", lastName: "", email: "", phone: "", city: "Lansing", state: "", country: "", address: "", postalCode: "", linkedin: "", website: "", facts: [], work: [], education: [], answers: [] };
    const statuses = await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.smartrecruiters.com/oneclick-ui/company/Acme/publication/1", only, globals, profile);
    return { statuses, value: (document.querySelector("input") as HTMLInputElement).value };
  }, { globals, only });
  assert.deepEqual(result.statuses, [{ key: "city", status: "filled" }]);
  assert.equal(result.value, "Lansing");
});

// SmartRecruiters: a pass cut off midway left
// the second school's editor open, its fields in shadow roots no match can
// read. The next pass saw the first school saved, paired the open editor
// with it by page order, added the second school again, and never saved the
// open one. An open editor belongs to the profile's unsaved rows.
test("an entry editor left open is finished for the unsaved row, not added again", async () => {
  await page.setContent(`
    <form id="application">
      <div class="saved">Michigan State University · Computer Science · 2018 - 2022</div>
      <div class="editor"><span class="school"></span><span class="major"></span><button type="button" class="save">Save</button></div>
      <button type="button" id="add">Add education</button>
    </form>
    <script>
      window.added = 0;
      window.saved = 0;
      const field = (host, value) => { const input = document.createElement('input'); input.value = value; host.attachShadow({ mode: 'open' }).append(input); };
      field(document.querySelector('.school'), 'Penn State');
      field(document.querySelector('.major'), '');
      document.querySelector('.save').addEventListener('click', () => window.saved++);
      document.getElementById('add').addEventListener('click', () => {
        window.added++;
        const editor = document.createElement('div');
        editor.className = 'editor';
        editor.innerHTML = '<span class="school"></span><span class="major"></span><button type="button" class="save">Save</button>';
        document.getElementById('add').before(editor);
        field(editor.querySelector('.school'), '');
        field(editor.querySelector('.major'), '');
      });
    </script>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(
    async ({ globals }) => {
      const profile = {
        revision: 1, confirmed: true, firstName: "Alex", lastName: "Rivera", email: "alex@example.test", phone: "",
        city: "", state: "", country: "", address: "", postalCode: "", linkedin: "", website: "", facts: [], answers: [], work: [],
        education: [
          { organization: "Michigan State University", title: "Bachelor of Science", fieldOfStudy: "Computer Science", location: "East Lansing", details: "", startDate: "2018-08", endDate: "2022-05" },
          { organization: "Penn State", title: "Master of Science", fieldOfStudy: "Data Science", location: "State College", details: "", startDate: "2022-08", endDate: "2024-05" },
        ],
      };
      await (window as any).ConfigEngine.interpretConfig(
        document,
        "https://jobs.example.test/apply",
        {
          ats: "Fixture", urls: ["https://jobs.example.test/*"], urlsExcluded: [], embeddedPaths: [], pathsExcluded: [],
          containerPath: [".//form[@id='application']"], containerRequired: true, defaultMethod: "default",
          submitButtonPaths: [], submittedSuccessPaths: [], trackedInputSelectors: [],
          inputSelectors: [["education", [{
            array: true,
            addButtonPath: [".//button[@id='add']"],
            containerPath: [".//div[@class='editor']"],
            savedRowPath: [".//div[@class='saved']"],
            inputSelectors: [
              ["school", [".//span[@class='school']/shadow-root/input"]],
              ["major", [".//span[@class='major']/shadow-root/input"]],
              ["save", [{ path: [".//button[@class='save']"], method: "click", valueRequired: false }]],
            ],
          }]]],
        },
        globals,
        profile,
      );
      const editors = [...document.querySelectorAll(".editor")];
      return {
        added: (window as any).added,
        saved: (window as any).saved,
        editors: editors.map((editor) => [editor.querySelector(".school")!.shadowRoot!.querySelector("input")!.value, editor.querySelector(".major")!.shadowRoot!.querySelector("input")!.value]),
      };
    },
    { globals },
  );
  assert.equal(result.added, 0);
  assert.deepEqual(result.editors, [["Penn State", "Data Science"]]);
  assert.equal(result.saved, 1);
});

// one employer's SmartRecruiters form: the
// first school's Save was refused and its editor stayed open. The editor
// path names any open editor, so the second school's row was that one
// again, and the second school was never added. It is added as its own.
test("an entry whose Save was refused is not taken for the next entry's row", async () => {
  await page.setContent(`
    <form id="application">
      <button type="button" id="add">Add education</button>
    </form>
    <script>{
      window.added = 0;
      const field = (host) => { const input = document.createElement('input'); host.attachShadow({ mode: 'open' }).append(input); };
      document.getElementById('add').addEventListener('click', () => {
        window.added++;
        const editor = document.createElement('div');
        editor.className = 'editor';
        // Its Save is refused: the editor stays open.
        editor.innerHTML = '<span class="school"></span><span class="major"></span><button type="button" class="save">Save</button>';
        document.getElementById('add').before(editor);
        field(editor.querySelector('.school'));
        field(editor.querySelector('.major'));
      });
    }</script>
  `);
  await page.addScriptTag({ content: "globalThis.__name ??= (f) => f;" });
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(
    async ({ globals }) => {
      const profile = {
        revision: 1, confirmed: true, firstName: "Alex", lastName: "Rivera", email: "alex@example.test", phone: "",
        city: "", state: "", country: "", address: "", postalCode: "", linkedin: "", website: "", facts: [], answers: [], work: [],
        education: [
          { organization: "Penn State", title: "Bachelor of Science", fieldOfStudy: "Data Science", location: "", details: "", startDate: "2018-08", endDate: "2022-05" },
          { organization: "Virginia Tech", title: "Master of Science", fieldOfStudy: "Computer Science", location: "", details: "", startDate: "2022-08", endDate: "2024-05" },
        ],
      };
      await (window as any).ConfigEngine.interpretConfig(
        document,
        "https://jobs.example.test/apply",
        {
          ats: "Fixture", urls: ["https://jobs.example.test/*"], urlsExcluded: [], embeddedPaths: [], pathsExcluded: [],
          containerPath: [".//form[@id='application']"], containerRequired: true, defaultMethod: "default",
          submitButtonPaths: [], submittedSuccessPaths: [], trackedInputSelectors: [],
          inputSelectors: [["education", [{
            array: true,
            addButtonPath: [".//button[@id='add']"],
            containerPath: [".//div[@class='editor']"],
            inputSelectors: [
              ["school", [".//span[@class='school']/shadow-root/input"]],
              ["major", [".//span[@class='major']/shadow-root/input"]],
              ["save", [{ path: [".//button[@class='save']"], method: "click", valueRequired: false }]],
            ],
          }]]],
        },
        globals,
        profile,
      );
      return {
        added: (window as any).added,
        editors: [...document.querySelectorAll(".editor")].map((editor) => [editor.querySelector(".school")!.shadowRoot!.querySelector("input")!.value, editor.querySelector(".major")!.shadowRoot!.querySelector("input")!.value]),
      };
    },
    { globals },
  );
  assert.equal(result.added, 2);
  assert.deepEqual(result.editors, [["Penn State", "Data Science"], ["Virginia Tech", "Computer Science"]]);
});

// Microsoft's careers form: the box showed the profile's address
// while the site's own state held none ("Address cannot be left blank").
// Skipped as already right, it was never typed again.
test("a value that looks right but the site calls invalid is written again", async () => {
  await page.setContent(`<form id="application">
    <label for="address">Address</label><input id="address" aria-required="true" aria-invalid="true" value="100 Test Way">
    <label for="city">City</label><input id="city" value="Phoenix">
  </form><script>{
    window.writes = [];
    for (const id of ["address", "city"]) document.getElementById(id).addEventListener("input", () => window.writes.push(id));
  }</script>`);
  await page.addScriptTag({ content: "globalThis.__name ??= (f) => f;" });
  await page.addScriptTag({ content: bundle });
  const writes = await page.evaluate(async ({ globals }) => {
    const config = {
      ats: "Fixture", urls: ["https://jobs.example.test/*"], urlsExcluded: [], embeddedPaths: [], pathsExcluded: [],
      containerPath: [".//form[@id='application']"], containerRequired: true, defaultMethod: "default",
      submitButtonPaths: [], submittedSuccessPaths: [], trackedInputSelectors: [],
      inputSelectors: [["address", [".//input[@id='address']"]], ["city", [".//input[@id='city']"]]],
    };
    const profile = { revision: 1, confirmed: true, firstName: "Alex", lastName: "Rivera", email: "alex@example.test", phone: "", city: "Phoenix", state: "", country: "", address: "100 Test Way", postalCode: "", linkedin: "", website: "", facts: [], work: [], education: [], answers: [] };
    await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.example.test/apply", config, globals, profile, { isReplaceable: () => true });
    return (window as any).writes;
  }, { globals });
  // The flagged one is typed again; the one the site took is left alone.
  assert.deepEqual(writes, ["address"]);
});
