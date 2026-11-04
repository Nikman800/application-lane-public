import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { emptyProfile } from "../src/shared/model";
import type { InputSelector } from "../src/engine/config/schema";

let browser: Browser;
let page: Page;
let bundle: string;

test("configured authorization cannot answer a documentary-proof question", async () => {
  await fixture('<label for="proof">Can you provide proof that you are authorized to work in the United States?</label><select id="proof"><option value=""></option><option>Yes</option><option>No</option></select>', [[
    "work_auth", [{ path: "//*[@id='proof']" }],
  ]]);
  await page.evaluate(() => (window as any).run());
  assert.equal(await page.locator("#proof").inputValue(), "");
});

test("a React-select wrapper reads its own proof question and unrelated assistance stays manual", async () => {
  await fixture('<label id="proof-label" for="proof">Can you provide proof that you are authorized to work in the United States?</label><div id="proof-wrap"><input id="proof" aria-labelledby="proof-label"></div><label for="ai">Have you implemented AI-assisted software development practices?</label><input id="ai">', [
    ["work_auth", [{ path: "//*[@id='proof-wrap']" }]],
    ["sponsorship", [{ path: "//*[@id='ai']" }]],
  ]);
  await page.evaluate(() => (window as any).run());
  assert.equal(await page.locator("#proof").inputValue(), "");
  assert.equal(await page.locator("#ai").inputValue(), "");
});
before(async () => {
  bundle = (
    await build({
      entryPoints: ["src/engine/config/interpreter.ts"],
      bundle: true,
      format: "iife",
      globalName: "Engine",
      write: false,
    })
  ).outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
});

async function fixture(html: string, selectors: InputSelector[]) {
  await page.setContent(html);
  await page.addScriptTag({
    content: `window.__name = (fn) => fn;\n${bundle}`,
  });
  await page.evaluate(
    (serialized) => {
      const { selectors, profile } = JSON.parse(serialized);
      (window as any).fixture = {
        config: {
          ats: "Fixture",
          urls: ["https://fixture.test/*"],
          urlsExcluded: [],
          embeddedPaths: [],
          pathsExcluded: [],
          containerPath: [],
          containerRequired: false,
          defaultMethod: "default",
          submitButtonPaths: [],
          submittedSuccessPaths: [],
          trackedInputSelectors: [],
          inputSelectors: selectors,
        },
        globals: {
          fieldNameAliases: {},
          countries: {},
          regionsByCountry: {},
        },
        profile: {
          ...profile,
          firstName: "Alex",
          lastName: "Rivera",
          answers: [
            { question: "sponsorship", answer: "No" },
            { question: "work auth", answer: "Yes" },
          ],
        },
      };
      (window as any).run = (options = {}) => {
        const f = (window as any).fixture;
        return (window as any).Engine.interpretConfig(
          document,
          "https://fixture.test/apply",
          f.config,
          f.globals,
          f.profile,
          options,
        );
      };
    },
    JSON.stringify({ selectors, profile: emptyProfile }),
  );
}

test("hard-coded Other choice targets require an explicitly confirmed Other answer", async () => {
  await fixture('<label>Other<input id="other" type="radio" name="source" value="Other"></label>', [["source", [{ path: "//input", method: "click" }]]]);
  await page.evaluate(() => { (window as any).fixture.profile.referralSource = ["Online job board"]; });
  const blocked = await page.evaluate(() => (window as any).run());
  assert.equal(await page.locator("#other").isChecked(), false);
  assert.match(blocked[0].reason, /Other is not a fallback/);
  await page.evaluate(() => { (window as any).fixture.profile.referralSource = ["Other"]; });
  const confirmed = await page.evaluate(() => (window as any).run());
  assert.equal(confirmed[0].status, "filled");
  assert.equal(await page.locator("#other").isChecked(), true);
});

test("configured XPath containment cannot choose a differently named option", async () => {
  await fixture('<div role="option" id="wrong" onclick="window.picked=true">Alexander</div>', [["first_name", [{ path: "//div", actions: [{ method: "click" }] }]]]);
  const results = await page.evaluate(() => (window as any).run());
  assert.equal(results[0].status, "failed");
  assert.equal(await page.evaluate(() => (window as any).picked), undefined);
  assert.match(results[0].reason, /exactly match/);
});

test("an employment agreement is never filled with the company name", async () => {
  await fixture('<label>Do you have a non-compete or other post-employment agreement?<input id="agreement"></label>', [["current_company_name", [{ path: "//input" }]]]);
  await page.evaluate(() => { (window as any).fixture.profile.currentCompany = "Confirmed Company"; });
  const results = await page.evaluate(() => (window as any).run());
  assert.equal(results[0].status, "skipped");
  assert.equal(await page.locator("#agreement").inputValue(), "");
});

test("a referrer's name is never filled with the applicant's", async () => {
  // Built's Greenhouse form, report 9b657c26 (2026-10-31).
  await fixture('<div><label>If you were referred by a current Built employee, please list their first and last name.</label><input type="text" id="referrer"></div>', [["last_name_2", [{ path: ".//label[contains(., \"last name\")]/parent::*//input", valueKey: "last_name" }]]]);
  const results = await page.evaluate(() => (window as any).run());
  assert.equal(results[0].status, "skipped");
  assert.equal(await page.locator("#referrer").inputValue(), "");
  await fixture('<div><label>Last Name</label><input type="text" id="own"></div>', [["last_name_2", [{ path: ".//label[contains(., \"Last Name\")]/parent::*//input", valueKey: "last_name" }]]]);
  await page.evaluate(() => (window as any).run());
  assert.notEqual(await page.locator("#own").inputValue(), "");
});

test("Oracle's experience Employer Country is picked without waiting for a State box", async () => {
  // Nokia, report e86eb443: the rule then waited 10 s for a State box that an
  // experience row never shows, judged the pick failed, and tried each
  // spelling in turn; a row left half filled was saved as "Unnamed Job Title".
  const oracle = JSON.parse(await readFile("src/engine/config/sites/oracle.json", "utf8"));
  const experience = oracle.inputSelectors.find(([key]: [string]) => key === "experience")[1][0];
  const country = experience.inputSelectors.find(([key]: [string]) => key === "country")[1];
  await fixture(`<div class="input-field-container"><label for="countryCode-43">Employer Country</label>
    <input id="countryCode-43" name="countryCode" role="combobox" class="cx-select-input" onclick="document.getElementById('list').hidden = false"></div>
    <div id="list" class="cx-select__list" hidden><div role="row" onclick="document.getElementById('countryCode-43').value = 'United States'; window.picks = (window.picks || 0) + 1">United States</div></div>`,
    [["country", country.map((selector: Record<string, unknown>) => ({ ...selector, values: undefined }))]]);
  await page.evaluate(() => { (window as any).fixture.profile.country = "United States"; });
  const started = Date.now();
  const results = await page.evaluate(() => (window as any).run());
  assert.equal(results[0].status, "filled", JSON.stringify(results[0]));
  assert.equal(await page.evaluate(() => (window as any).picks), 1);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
});

test("a successful final wait cannot hide an earlier rejected action", async () => {
  await fixture('<input id="target"><div id="ready"></div>', [
    [
      "first_name",
      [
        {
          path: "//input",
          actions: [{ method: "default" }, { path: "//div" }],
        },
      ],
    ],
  ]);
  const statuses = await page.evaluate(() =>
    (window as any).run({ execute: async () => false }),
  );
  assert.equal(statuses[0].status, "failed");
});

test("No radio is selected, not cleared", async () => {
  await fixture(
    '<input type="radio" name="sponsor" value="yes"><input id="no" type="radio" name="sponsor" value="no">',
    [
      [
        "sponsorship",
        [{ path: "//input[@id='no']", method: "selectCheckboxOrRadio" }],
      ],
    ],
  );
  await page.evaluate(() => (window as any).run());
  assert.equal(await page.locator("#no").isChecked(), true);
});

test("implicit submit buttons, descendant clicks and event-only submits are refused", async () => {
  await fixture(
    '<form><button id="implicit"><span>Go</span></button><button type="button" id="phrase">Submit application</button><button type="button" id="configured">Continue</button></form>',
    [],
  );
  const result = await page.evaluate(async () => {
    const f = (window as any).fixture;
    f.config.submitButtonPaths = ["//button[@id='configured']"];
    let writes = 0;
    const statuses = [];
    for (const [path, action] of [
      ["//button[@id='implicit']", { method: "click" }],
      ["//span", { method: "reactClick" }],
      ["//button[@id='phrase']", { event: "click" }],
      [
        "//button[@id='configured']",
        { event: "keydown", eventOptions: { key: "Enter" } },
      ],
    ]) {
      f.config.inputSelectors = [["first_name", [{ path, actions: [action] }]]];
      statuses.push(
        ...(await (window as any).run({
          execute: async () => {
            writes++;
            return true;
          },
        })),
      );
    }
    return { statuses, writes };
  });
  assert.equal(result.writes, 0);
  assert.ok(result.statuses.every((s: any) => s.status === "failed"));
});

test("certification-labelled inputs still accept value writes", async () => {
  await fixture(
    '<label for="answer">I certify this answer is accurate</label><input id="answer">',
    [["first_name", ["//input[@id='answer']"]]],
  );
  const statuses = await page.evaluate(() => (window as any).run());
  assert.equal(statuses[0].status, "filled");
  assert.equal(await page.locator("#answer").inputValue(), "Alex");
});

test("abort escapes optional actions and prevents fallback and later keys", async () => {
  await fixture('<input id="one"><input id="two">', [
    [
      "first_name",
      [
        {
          path: "//input[@id='one']",
          actions: [{ delay: 100, method: "default", allowFailure: true }],
        },
      ],
    ],
    ["last_name", ["//input[@id='two']"]],
  ]);
  const result = await page.evaluate(async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    let writes = 0;
    try {
      await (window as any).run({
        signal: controller.signal,
        execute: async () => {
          writes++;
          return true;
        },
      });
    } catch (error) {
      return { name: (error as Error).name, writes };
    }
    return { name: "completed", writes };
  });
  assert.deepEqual(result, { name: "AbortError", writes: 0 });
});

test("event-only key actions deliver KeyboardEvent fields and bubble exactly once", async () => {
  await fixture("<div><input></div>", [
    [
      "first_name",
      [
        {
          path: "//input",
          actions: [
            {
              event: "keydown",
              eventOptions: { key: "a", code: "KeyA", keyCode: 65 },
            },
          ],
        },
      ],
    ],
  ]);
  const result = await page.evaluate(async () => {
    const seen: unknown[] = [];
    document.querySelector("div")!.addEventListener("keydown", (event) => {
      const e = event as KeyboardEvent;
      seen.push([e.constructor.name, e.key, e.code, e.keyCode]);
    });
    await (window as any).run();
    return seen;
  });
  assert.deepEqual(result, [["KeyboardEvent", "a", "KeyA", 65]]);
});

test("a nonempty placeholder does not prevent filling a select", async () => {
  await fixture(
    '<select><option value="placeholder">Please select</option><option value="alex">Alex</option></select>',
    [["first_name", ["//select"]]],
  );
  const statuses = await page.evaluate(() => (window as any).run());
  assert.equal(statuses[0].status, "filled");
  assert.equal(await page.locator("select").inputValue(), "alex");
});

test("a date placeholder with a nonempty value is filled", async () => {
  await fixture(
    '<select><option value="-1">Month</option><option value="05">May</option></select>',
    [["first_name", [{ path: "//select", value: "05" }]]],
  );
  await page.evaluate(() => (window as any).run());
  assert.equal(await page.locator("select").inputValue(), "05");
});

test("submit selectors are checked again after a control is inserted", async () => {
  await fixture('<button type="button" id="open">Open</button>', [
    [
      "first_name",
      [
        {
          path: "//button[@id='open']",
          actions: [
            { method: "click" },
            { path: "//button[@id='final']", method: "click" },
          ],
        },
      ],
    ],
  ]);
  const result = await page.evaluate(async () => {
    (window as any).fixture.config.submitButtonPaths = [
      "//button[@id='final']",
    ];
    let submissions = 0;
    document.querySelector("#open")!.addEventListener("click", () => {
      const button = document.createElement("button");
      button.type = "button";
      button.id = "final";
      button.textContent = "Continue";
      button.onclick = () => {
        submissions++;
      };
      document.body.append(button);
    });
    const statuses = await (window as any).run();
    return { statuses, submissions };
  });
  assert.equal(result.submissions, 0);
  assert.equal(result.statuses[0].status, "failed");
});

test("every action write rechecks the base and target edit lock", async () => {
  for (const method of [
    "default",
    "react",
    "jQuery",
    "dijit",
    "setValue",
    "setValueOnly",
    "clearValue",
    "click",
    "reactClick",
    "uploadResume",
    "uploadCoverLetter",
    "selectOption",
    "selectCheckboxOrRadio",
    "event",
  ]) {
    await fixture('<input id="base"><input id="other">', [
      [
        "first_name",
        [
          {
            path: "//input[@id='base']",
            actions: [
              { method: "default" },
              { path: "//input[@id='other']", method },
            ],
          },
        ],
      ],
    ]);
    const writes = await page.evaluate(async () => {
      let locked = false;
      let writes = 0;
      await (window as any).run({
        isLocked: (element: Element) => locked && element.id === "base",
        execute: async () => {
          writes++;
          locked = true;
          return true;
        },
      });
      return writes;
    });
    assert.equal(writes, 1, method);
  }
});

test("removed waits succeed only after disappearance, including removedTime and zero time", async () => {
  for (const [delay, timeout, expected] of [
    [10, 100, "filled"],
    [0, 0, "failed"],
    [0, 10, "failed"],
  ] as const) {
    await fixture('<input><div id="spinner"></div>', [
      [
        "first_name",
        [
          {
            path: "//input",
            actions: [
              {
                path: "//div[@id='spinner']",
                removed: true,
                removedTime: timeout,
              },
            ],
          },
        ],
      ],
    ]);
    const statuses = await page.evaluate(async (delay) => {
      if (delay)
        setTimeout(() => document.querySelector("#spinner")!.remove(), delay);
      return (window as any).run();
    }, delay);
    assert.equal(statuses[0].status, expected);
  }
  await fixture("<input>", [
    [
      "first_name",
      [{ path: "//input", actions: [{ path: "//div", removed: true }] }],
    ],
  ]);
  assert.equal(
    (await page.evaluate(() => (window as any).run()))[0].status,
    "filled",
  );
});

test("valuePathMap maps confirmed Yes and No to true and empty config keys", async () => {
  await fixture(
    '<input id="yes" type="radio" name="auth"><input id="no" type="radio" name="sponsor">',
    [
      [
        "work_auth",
        [
          {
            path: "//missing",
            valuePathMap: { true: "//input[@id='yes']", "": "//missing" },
          },
        ],
      ],
      [
        "sponsorship",
        [
          {
            path: "//missing",
            valuePathMap: { true: "//missing", "": "//input[@id='no']" },
          },
        ],
      ],
    ],
  );
  await page.evaluate(() => (window as any).run());
  assert.equal(await page.locator("#yes").isChecked(), true);
  assert.equal(await page.locator("#no").isChecked(), true);
});

test("repeated education and employment fields use their own section and row", async () => {
  await fixture(
    "<fieldset><legend>Employment</legend><label>Company<input></label><label>Start year<input></label></fieldset><fieldset><legend>Education</legend><label>School<input></label><label>Start year<input></label></fieldset><fieldset><legend>Education</legend><label>School<input></label><label>Start year<input></label></fieldset>",
    [
      ["education", [{ array: true, inputSelectors: [] }]],
      ["experience", [{ array: true, inputSelectors: [] }]],
    ],
  );
  await page.evaluate(async () => {
    const profile = (window as any).fixture.profile;
    const row = (organization: string, startDate: string) => ({
      organization,
      startDate,
      title: "",
      endDate: "",
      location: "",
      details: "",
    });
    profile.work = [row("Employer", "2023")];
    profile.education = [row("School A", "2018"), row("School B", "2020")];
    await (window as any).run();
  });
  assert.deepEqual(
    await page
      .locator("input")
      .evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value),
      ),
    ["Employer", "2023", "School A", "2018", "School B", "2020"],
  );
});

test("embedded probes match custom hosts and cannot combine unrelated frames", async () => {
  await fixture('<meta name="ats"><form id="application"><input></form>', [
    ["first_name", ["//input"]],
  ]);
  const matched = await page.evaluate(async () => {
    const f = (window as any).fixture;
    f.config.urls = ["https://vendor.test/*"];
    f.config.embeddedPaths = [["//meta[@name='ats']", "//form"]];
    return (window as any).run();
  });
  assert.equal(matched[0].status, "filled");
  await fixture(
    '<meta name="ats"><iframe srcdoc="<form><input></form>"></iframe>',
    [],
  );
  assert.equal(
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.config.urls = [];
      f.config.embeddedPaths = [["//meta[@name='ats']", "//form"]];
      return (window as any).Engine.matchesSiteConfig(
        f.config,
        location.href,
        document,
      );
    }),
    false,
  );
});

test("education rows pre-filled out of order are matched by school, and Other School is used only when the list lacks the school", async () => {
  const row = (n: number, school: string, major: string) => `
    <div class="CandProfileFields.Education-${n}-Container">
      <label>School<select name="school">
        <option value="">— Make a Selection —</option>
        <option ${school === "msu" ? "selected" : ""} value="msu">Michigan State University</option>
        <option value="ua">University of Michigan</option>
      </select></label>
      <label>Other School<input name="other"></label>
      <label>Major<input name="major" value="${major}"></label>
    </div>`;
  // Rows as iCIMS's resume parser left them: Penn State's major in row 1,
  // MSU's school in row 2.
  await fixture(row(1, "", "Computer Science") + row(2, "msu", ""), [
    [
      "education",
      [
        {
          containerPath: ["//div[contains(@class, 'Education-%NUMBER0%-Container')]"],
          inputSelectors: [
            [
              "education",
              [
                {
                  inputSelectors: [
                    ["name", [{ path: ".//select[@name='school']" }]],
                    ["name_optional", [{ path: ".//input[@name='other']", valueKey: "name" }]],
                  ],
                },
              ],
            ],
            ["major", [{ path: ".//input[@name='major']" }]],
          ],
        },
      ],
    ],
  ]);
  await page.evaluate(() => {
    (window as any).fixture.profile.education = [
      {
        organization: "Michigan State University",
        title: "Master of Science",
        fieldOfStudy: "Data Science",
        startDate: "2025-08",
        endDate: "2027-05",
        location: "",
        details: "",
      },
      {
        organization: "Pennsylvania State University, University Park",
        title: "Bachelor of Science",
        fieldOfStudy: "Computer Science",
        startDate: "2020-09",
        endDate: "2024-06",
        location: "",
        details: "",
      },
    ];
  });
  await page.evaluate(() => (window as any).run());
  const rows = await page.evaluate(() =>
    [1, 2].map((n) => {
      const scope = document.querySelector(`[class='CandProfileFields.Education-${n}-Container']`)!;
      return {
        school: (scope.querySelector("[name=school]") as HTMLSelectElement).value,
        other: (scope.querySelector("[name=other]") as HTMLInputElement).value,
        major: (scope.querySelector("[name=major]") as HTMLInputElement).value,
      };
    }),
  );
  // Row 1 is Penn State's: not in the list, so Other School names it.
  assert.equal(rows[0].school, "");
  assert.equal(rows[0].other, "Pennsylvania State University, University Park");
  assert.equal(rows[0].major, "Computer Science");
  // Row 2 is MSU's: chosen from the list, so Other School stays empty.
  assert.equal(rows[1].school, "msu");
  assert.equal(rows[1].other, "");
  assert.equal(rows[1].major, "Data Science");
});


test("Ashby school options compare the explicit name and never their country or domain metadata", async () => {
  await fixture(`<div role="option" class="ashby-application-form-input-autocomplete-popup-result" id="right" onclick="window.schoolClicks=(window.schoolClicks||0)+1"><span class="_canonicalSchoolResultName_fixture">Michigan State University</span><span>United States</span><span>msu.edu</span></div>
    <div role="option" class="ashby-application-form-input-autocomplete-popup-result" id="wrong" onclick="window.wrongSchool=true"><span class="_canonicalSchoolResultName_fixture">University of Michigan</span><span>Michigan State University</span><span>msu.edu</span></div>
    <div role="option" class="ashby-application-form-input-autocomplete-popup-result" id="ambiguous" onclick="window.ambiguousSchool=true"><span class="_canonicalSchoolResultName_fixture">Michigan State University</span><span class="_canonicalSchoolResultName_fixture">Michigan State University</span></div>`, [["name", [{ path: "//*[@id='right']", method: "click" }]]]);
  await page.evaluate(() => { (window as any).fixture.profile.education = [{ organization: "Michigan State University", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2022-08", endDate: "2026-05", location: "East Lansing, Michigan", details: "" }]; });
  const accepted = await page.evaluate(() => (window as any).run({ valueContext: { collection: "education", index: 0 } }));
  assert.equal(accepted[0].status, "filled");
  assert.equal(await page.evaluate(() => (window as any).schoolClicks), 1);
  for (const id of ["wrong", "ambiguous"]) {
    await page.evaluate((id) => { (window as any).fixture.config.inputSelectors = [["name", [{ path: `//*[@id='${id}']`, method: "click" }]]]; }, id);
    const rejected = await page.evaluate(() => (window as any).run({ valueContext: { collection: "education", index: 0 } }));
    assert.equal(rejected[0].status, "failed", id);
  }
  assert.equal(await page.evaluate(() => (window as any).wrongSchool), undefined);
  assert.equal(await page.evaluate(() => (window as any).ambiguousSchool), undefined);
});


test("an Ashby school result under the official name of the profile's common one is accepted, and a sibling's is not", async () => {
  const result = (id: string, name: string) =>
    `<div role="option" class="ashby-application-form-input-autocomplete-popup-result" id="${id}" onclick="window.clicked=(window.clicked||[]).concat('${id}')"><span class="_canonicalSchoolResultName_fixture">${name}</span><span>United States</span></div>`;
  await fixture(result("official", "Virginia Polytechnic Institute and State University") + result("medicine", "Virginia Tech Carilion School of Medicine") + result("state", "Virginia State University"),
    [["name", [{ path: "//*[@id='official']", method: "click" }]]]);
  await page.evaluate(() => { (window as any).fixture.profile.education = [{ organization: "Virginia Tech", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "Blacksburg, Virginia", details: "" }]; });
  assert.equal((await page.evaluate(() => (window as any).run({ valueContext: { collection: "education", index: 0 } })))[0].status, "filled");
  for (const id of ["medicine", "state"]) {
    await page.evaluate((id) => { (window as any).fixture.config.inputSelectors = [["name", [{ path: `//*[@id='${id}']`, method: "click" }]]]; }, id);
    assert.equal((await page.evaluate(() => (window as any).run({ valueContext: { collection: "education", index: 0 } })))[0].status, "failed", id);
  }
  assert.deepEqual(await page.evaluate(() => (window as any).clicked), ["official"]);
});

test("a rejected sponsorship selector cannot invert positive authorization through label fallback", async () => {
  await fixture('<label for="authorization">Are you authorized to work for any U.S. employer without sponsorship?</label><input id="authorization">', [["sponsorship", [{ path: "//*[@id='does-not-exist']" }]]]);
  await page.evaluate(() => (window as any).run());
  assert.equal(await page.locator("#authorization").inputValue(), "");
  await fixture('<fieldset><legend>Are you authorized to work without sponsorship?</legend><button id="authorization" aria-haspopup="listbox">Select One</button></fieldset>', [["sponsorship", [{ path: "//*[@id='does-not-exist']" }]]]);
  await page.evaluate(() => (window as any).run());
  assert.equal(await page.locator("#authorization").textContent(), "Select One");
});


test("configured relocation and its label fallback cannot write Yes into a permanent-address request", async () => {
  const label = "Please provide your permanent address (city, state, zip code). We use this information to determine eligibility for relocation assistance.";
  for (const path of ["//*[@id='address']", "//*[@id='does-not-exist']"]) {
    await fixture(`<label for="address">${label}</label><input id="address">`, [["relocation", [{ path }]]]);
    await page.evaluate(() => { (window as any).fixture.profile.willingToRelocate = "Yes"; });
    await page.evaluate(() => (window as any).run());
    assert.equal(await page.locator("#address").inputValue(), "");
  }
});


test("configured authorization and label fallback do not infer CPT or OPT status", async () => {
  const label = "Does your work authorization now, or will it in the future, involve CPT (Curricular Practical Training) or OPT (Optional Practical Training)?";
  for (const path of ["//*[@id='status']", "//*[@id='missing']"]) {
    await fixture(`<label for="status">${label}</label><select id="status"><option value=""></option><option>Yes</option><option>No</option></select>`, [["work_auth", [{ path }]]]);
    await page.evaluate(() => (window as any).run());
    assert.equal(await page.locator("#status").inputValue(), "");
  }
});

// Lever's location box (as of 2026-10-08) searches on a key press, not on
// input, and takes its pick on mousedown, not on click. Typed and left, the
// box shows the city while the hidden selectedLocation stays empty.
async function leverLocation(offers: boolean, marked = true) {
  const lever = JSON.parse(await readFile("src/engine/config/sites/lever.json", "utf8"));
  const rule = lever.inputSelectors.find(([key]: [string]) => key === "city_state");
  if (!marked) for (const action of rule[1][0].actions) delete action.pickRequired;
  await fixture(
    `<li class="application-question"><label><div class="application-label">Current location <span class="required">✱</span></div><div class="application-field"><input class="location-input" id="location-input" name="location" required><input id="selected-location" type="hidden" name="selectedLocation" value="stale"><div class="dropdown-container" style="display: none"><div class="dropdown-results"></div><div class="dropdown-no-results" style="display: none">No location found. Try entering a different location</div></div></div></label></li>
<script>
// A block of its own: setContent keeps the page's window, so a second
// fixture's top-level consts would clash with the first's.
{
  const input = document.getElementById("location-input"), selected = document.getElementById("selected-location");
  const box = document.querySelector(".dropdown-container"), results = document.querySelector(".dropdown-results");
  let found = [];
  input.addEventListener("input", () => (box.style.display = "flex"));
  input.addEventListener("keydown", () => setTimeout(() => {
    found = ${offers} ? [{ name: input.value + ", AZ, USA", id: "first" }, { name: input.value + ", Elsewhere", id: "second" }] : [];
    results.innerHTML = found.map((place, index) => '<div class="dropdown-location" id="location-' + index + '">' + place.name + "</div>").join("");
  }, 600));
  input.addEventListener("blur", () => {
    if (box.style.display === "none") return;
    box.style.display = "none"; results.innerHTML = ""; input.value = ""; selected.value = "";
  });
  document.addEventListener("mousedown", (event) => {
    if (!event.target.classList.contains("dropdown-location")) return;
    box.style.display = "none"; input.value = event.target.textContent;
    selected.value = JSON.stringify(found[event.target.id.split("-")[1]]); results.innerHTML = "";
  });
  document.addEventListener("click", (event) => {
    if (event.target.classList.contains("dropdown-location")) document.body.dataset.clicked = "yes";
  });
}
</script>`,
    [rule],
  );
  await page.evaluate(() => {
    (window as any).fixture.profile.city = "Tucson";
  });
  return (await page.evaluate(() => (window as any).run())) as { key: string; status: string; caution?: string }[];
}

test("Lever's location is searched by a key press and picked on mousedown", async () => {
  const statuses = await leverLocation(true);
  assert.equal(await page.locator("#location-input").inputValue(), "Tucson, AZ, USA");
  assert.deepEqual(JSON.parse(await page.locator("#selected-location").inputValue()), { name: "Tucson, AZ, USA", id: "first" });
  assert.deepEqual(statuses, [{ key: "city_state", status: "filled" }]);
  // Filled again (a second "Fill this step"), a made pick is left alone: the
  // rule used to clear it and type over it, and a fill paused before the new
  // pick left "Tucson" in the box with the list open and nothing picked.
  const events = await page.evaluate(async () => {
    const seen: string[] = [];
    for (const type of ["input", "keydown"]) document.getElementById("location-input")!.addEventListener(type, () => seen.push(type));
    return { statuses: await (window as any).run(), seen };
  });
  assert.deepEqual(events, { statuses: [{ key: "city_state", status: "skipped", reason: "The site's list already holds a pick." }], seen: [] });
  assert.equal(await page.locator("#location-input").inputValue(), "Tucson, AZ, USA");
  assert.deepEqual(JSON.parse(await page.locator("#selected-location").inputValue()), { name: "Tucson, AZ, USA", id: "first" });
  // Its own text left unpicked by such a pause is not a pick: it is redone.
  await page.evaluate(() => {
    (document.getElementById("location-input") as HTMLInputElement).value = "Tucson";
    (document.getElementById("selected-location") as HTMLInputElement).value = "";
  });
  assert.deepEqual(await page.evaluate(() => (window as any).run()), [{ key: "city_state", status: "filled" }]);
  assert.deepEqual(JSON.parse(await page.locator("#selected-location").inputValue()), { name: "Tucson, AZ, USA", id: "first" });
});

// The pick is optional, so that one stuck list does not stop the form. It
// used to fail without a word, leaving text the site held no answer for.
test("a search that was typed but offered nothing to pick is said so, not passed as filled", async () => {
  const statuses = await leverLocation(false);
  assert.equal(await page.locator("#selected-location").inputValue(), "");
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].status, "filled");
  assert.match(statuses[0].caution || "", /^Current location: typed, but nothing was picked from the site's own list/);
  // Only where the rule says the pick is the answer: on other sites' rules
  // an optional suggestion that never appears leaves a complete answer.
  assert.deepEqual(await leverLocation(false, false), [{ key: "city_state", status: "filled" }]);
});

// A report on an Ashby form, 2026-10-13: under "Which of the following
// communities do you belong to?", the box labelled "Veteran" was ticked for
// an applicant who is not one. The label fallback took the option for the
// veteran question, and any value written to a box ticks it.
test("a box or radio that is one option of another question is never the answer to a keyed one", async () => {
  const ashby = JSON.parse(await readFile("src/engine/config/sites/ashby.json", "utf8"));
  const rule = ashby.inputSelectors.find(([key]: [string]) => key === "veteran");
  const option = (name: string, index: number) =>
    `<div class="ashby-application-form-input-checkbox-group-option"><span><input type="checkbox" id="g-labeled-checkbox-${index}" name="${name}"></span><label for="g-labeled-checkbox-${index}" class="ashby-application-form-input-checkbox-group-option-label">${name}</label></div>`;
  await fixture(
    `<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Which of the following communities do you belong to? Please select all that apply.</label><div>${["Person with disability", "Neurodiverse", "Veteran", "Parent", "None of the above"].map(option).join("")}</div></div>`,
    [rule],
  );
  for (const veteranStatus of ["I am not a veteran", "I am a protected veteran"]) {
    await page.evaluate((status) => {
      (window as any).fixture.profile.veteranStatus = status;
    }, veteranStatus);
    await page.evaluate(() => (window as any).run());
    assert.deepEqual(await page.locator("input:checked").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).name)), [], veteranStatus);
  }
});

// A report on an Ashby form, 2026-10-13: "What race and/or ethnic identities
// do you identify with?" had East Asian ticked beside South Asian. "Asian",
// the answer's broader wording, is a word of both names.
test("a box naming one part of Asia is ticked only when it is the applicant's own answer", async () => {
  const ashby = JSON.parse(await readFile("src/engine/config/sites/ashby.json", "utf8"));
  const rule = ashby.inputSelectors.find(([key]: [string]) => key === "ethnicity");
  const option = (name: string, index: number) =>
    `<div class="ashby-application-form-input-checkbox-group-option"><span><input type="checkbox" id="r-labeled-checkbox-${index}" name="${name}"></span><label for="r-labeled-checkbox-${index}" class="ashby-application-form-input-checkbox-group-option-label">${name}</label></div>`;
  await fixture(
    `<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">What race and/or ethnic identities do you identify with? (please select all that apply)</label><div>${["Black of African or African-American descent", "East Asian", "Hispanic or Latinx", "South Asian", "Southeast Asian", "White or Caucasian", "I prefer not to say"].map(option).join("")}</div></div>`,
    [rule],
  );
  for (const [ethnicity, ticked] of [["South Asian", ["South Asian"]], ["Southeast Asian", ["Southeast Asian"]], ["East Asian", ["East Asian"]]] as const) {
    await page.evaluate((answer) => {
      document.querySelectorAll<HTMLInputElement>("input:checked").forEach((input) => (input.checked = false));
      (window as any).fixture.profile.ethnicity = answer;
    }, ethnicity);
    await page.evaluate(() => (window as any).run());
    assert.deepEqual(await page.locator("input:checked").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).name)), ticked, ethnicity);
  }
});
