import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";

let browser: Browser;
let page: Page;
let bundle: string;

before(async () => {
  const output = await build({
    bundle: true,
    entryPoints: ["src/engine/page/mainWorld.ts"],
    format: "iife",
    globalName: "MainWorld",
    platform: "browser",
    write: false,
  });
  bundle = `window.__name = (fn) => fn;\n${output.outputFiles[0].text}`;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
});

test("MAIN-world option writes require exact names rather than contained words", async () => {
  await page.setContent('<select id="degree"><option value="">Select</option><option value="BS">Bachelor of Science</option></select>');
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(() => {
    const input = document.querySelector<HTMLSelectElement>("#degree")!;
    const apply = (values: string[]) => {
      const token = "11111111-1111-4111-8111-111111111111";
      input.setAttribute("data-application-lane-main", token);
      return (window as any).MainWorld.applyMainWorld({ method: "default", token, values });
    };
    const vague = apply(["Science"]), untouched = input.value, exact = apply(["BS"]);
    return { vague, untouched, exact, value: input.value };
  });
  assert.equal(result.vague.ok, false);
  assert.equal(result.untouched, "");
  assert.equal(result.exact.ok, true);
  assert.equal(result.value, "BS");
});

test("uses native and React setters in the page world", async () => {
  await page.setContent(`
    <input id="name">
    <script>
      window.reactHandler = function(event) {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setAttribute('data-prevented', String(event.defaultPrevented));
        event.target.setAttribute('data-react-value', event.target.value);
      };
    </script>
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#name")!;
    (input as any).__reactProps$fixture = {
      onChange: (window as any).reactHandler,
    };
    const token = "11111111-1111-4111-8111-111111111111";
    input.setAttribute("data-application-lane-main", token);
    const applied = (window as any).MainWorld.applyMainWorld({
      method: "react",
      token,
      values: ["Alex"],
    });
    return {
      applied,
      marker: input.hasAttribute("data-application-lane-main"),
      reactValue: input.getAttribute("data-react-value"),
      prevented: input.getAttribute("data-prevented"),
      value: input.value,
    };
  });
  assert.equal(result.applied.ok, true);
  assert.equal(result.value, "Alex");
  assert.equal(result.reactValue, "Alex");
  assert.equal(result.prevented, "true");
  assert.equal(result.marker, false);
});

test("a failing React handler releases only focus acquired by the engine", async () => {
  await page.setContent('<input id="target"><input id="other">');
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(() => {
    const target = document.querySelector<HTMLInputElement>("#target")!;
    const other = document.querySelector<HTMLInputElement>("#other")!;
    const run = (handler: () => void) => {
      (target as any).__reactProps$fixture = { onChange: handler };
      const token = "11111111-1111-4111-8111-111111111111";
      target.setAttribute("data-application-lane-main", token);
      const applied = (window as any).MainWorld.applyMainWorld({ method: "react", token, values: ["Alex"] });
      return { applied, focus: document.activeElement?.id };
    };
    const released = run(() => { throw Error("handler failed"); });
    const moved = run(() => { other.focus(); throw Error("handler moved focus"); });
    target.focus();
    const existing = run(() => { throw Error("existing focus"); });
    return { released, moved, existing };
  });
  assert.equal(result.released.applied.ok, false);
  assert.notEqual(result.released.focus, "target");
  assert.equal(result.moved.focus, "other");
  assert.equal(result.existing.focus, "target");
});

test("MAIN-world value writes ignore certification labels", async () => {
  await page.setContent(
    '<label for="answer">I certify this answer is accurate</label><input id="answer">',
  );
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#answer")!;
    const token = "11111111-1111-4111-8111-111111111111";
    input.setAttribute("data-application-lane-main", token);
    return (window as any).MainWorld.applyMainWorld({
      method: "default",
      token,
      values: ["Alex"],
    });
  });
  assert.equal(result.ok, true);
  assert.equal(result.value, "Alex");
});

test("uploads a bound artifact through DataTransfer", async () => {
  await page.setContent('<input id="resume" type="file">');
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#resume")!;
    const token = "22222222-2222-4222-8222-222222222222";
    input.setAttribute("data-application-lane-main", token);
    return (window as any).MainWorld.applyMainWorld({
      method: "uploadResume",
      token,
      values: [],
      file: {
        applicationId: "33333333-3333-4333-8333-333333333333",
        operation: 4,
        data: btoa("fixture resume"),
        mime: "application/pdf",
        name: "resume.pdf",
      },
    });
  });
  assert.equal(result.ok, true);
  assert.equal(result.value, "resume.pdf");
});

test("an upload the site takes into its own component, once its server answers, is kept", async () => {
  // SmartRecruiters (LLNL and Syngenta, 2026-11-02): its dropzone clears the
  // file input at once, and names the file in its own files attribute when
  // the upload is answered, about half a second later. Read once at 500 ms,
  // an upload that went in was reported as not finished.
  await page.setContent('<spl-dropzone data-test="resume-upload" files="[]"></spl-dropzone>');
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(() => {
    const host = document.querySelector("spl-dropzone")!;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = '<div class="drop"><input type="file"></div>';
    const input = root.querySelector<HTMLInputElement>("input")!;
    input.addEventListener("change", () => {
      const name = input.files?.[0]?.name;
      input.value = "";
      setTimeout(() => host.setAttribute("files", JSON.stringify([{ fileName: name, attachmentType: "RESUME" }])), 800);
    });
    const token = "66666666-6666-4666-8666-666666666666";
    input.setAttribute("data-application-lane-main", token);
    (window as any).MainWorld.bindRoot?.(root);
    return (window as any).MainWorld.applyMainWorld({
      method: "uploadResume",
      token,
      values: [],
      file: { applicationId: "33333333-3333-4333-8333-333333333333", operation: 4, data: btoa("fixture resume"), mime: "application/pdf", name: "Alex_Rivera_Resume_LLNL.pdf" },
    });
  });
  assert.equal(result.ok, true, result.reason);
});

test("refuses submit activation and ambiguous markers", async () => {
  await page.setContent(`
    <button id="submit" type="button">Finish</button>
    <input id="one"><input id="two">
  `);
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(() => {
    const submit = document.querySelector("#submit")!;
    const submitToken = "44444444-4444-4444-8444-444444444444";
    submit.setAttribute("data-application-lane-main", submitToken);
    const refused = (window as any).MainWorld.applyMainWorld({
      method: "click",
      token: submitToken,
      values: [],
    });
    const duplicateToken = "55555555-5555-4555-8555-555555555555";
    document
      .querySelector("#one")!
      .setAttribute("data-application-lane-main", duplicateToken);
    document
      .querySelector("#two")!
      .setAttribute("data-application-lane-main", duplicateToken);
    const ambiguous = (window as any).MainWorld.applyMainWorld({
      method: "default",
      token: duplicateToken,
      values: ["unsafe"],
    });
    return { ambiguous, refused };
  });
  assert.equal(result.refused.ok, false);
  assert.match(result.refused.reason, /Refused/);
  assert.equal(result.ambiguous.ok, false);
  assert.match(result.ambiguous.reason, /ambiguous/);
});

test("MAIN-world markers resolve nested shadow roots and reject cross-root duplicates", async () => {
  await page.setContent('<div id="host"></div>');
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(() => {
    const outer = document
      .querySelector("#host")!
      .attachShadow({ mode: "open" });
    outer.innerHTML = "<div></div><input>";
    const inner = outer.querySelector("div")!.attachShadow({ mode: "open" });
    inner.innerHTML = "<input>";
    const input = inner.querySelector("input")!;
    const token = "11111111-1111-4111-8111-111111111111";
    const apply = () =>
      (window as any).MainWorld.applyMainWorld({
        token,
        method: "default",
        values: ["Alex"],
      });
    input.setAttribute("data-application-lane-main", token);
    const success = apply();
    input.setAttribute("data-application-lane-main", token);
    outer
      .querySelector("input")!
      .setAttribute("data-application-lane-main", token);
    return { success, duplicate: apply(), value: input.value };
  });
  assert.equal(result.success.ok, true);
  assert.equal(result.value, "Alex");
  assert.equal(result.duplicate.ok, false);
});

test("MAIN-world blocks implicit submits and phrase-labelled actions through descendants", async () => {
  await page.setContent(
    '<form><button><span id="implicit">Continue</span></button><button type="button"><span id="phrase">I agree and submit</span></button></form>',
  );
  await page.addScriptTag({ content: bundle });
  const results = await page.evaluate(() =>
    ["implicit", "phrase"].map((id) => {
      const token = "11111111-1111-4111-8111-111111111111";
      document
        .getElementById(id)!
        .setAttribute("data-application-lane-main", token);
      return (window as any).MainWorld.applyMainWorld({
        token,
        method: "event",
        event: "click",
        values: [],
      });
    }),
  );
  assert.ok(results.every((result) => !result.ok));
});

test("MAIN-world selects No radios and ignores placeholder and substring options", async () => {
  await page.setContent(
    '<input type="radio" value="no"><select><option value="no">Select</option><option value="other">Not applicable</option><option value="answer">No</option></select>',
  );
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(() => {
    const apply = (element: Element) => {
      const token = "11111111-1111-4111-8111-111111111111";
      element.setAttribute("data-application-lane-main", token);
      return (window as any).MainWorld.applyMainWorld({
        token,
        method: "default",
        values: ["No"],
      });
    };
    const input = document.querySelector("input")!;
    const select = document.querySelector("select")!;
    apply(input);
    const selected = apply(select);
    select.querySelector('[value="answer"]')!.remove();
    const substring = apply(select);
    return { checked: input.checked, selected, substring };
  });
  assert.equal(result.checked, true);
  assert.equal(result.selected.value, "answer");
  assert.equal(result.substring.ok, false);
});

test("MAIN-world key events fire once without changing the current value", async () => {
  await page.setContent('<div><input value="preserved"></div>');
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(() => {
    const input = document.querySelector("input")!;
    const seen: string[] = [];
    document
      .querySelector("div")!
      .addEventListener("keydown", (event) =>
        seen.push((event as KeyboardEvent).key),
      );
    const token = "11111111-1111-4111-8111-111111111111";
    input.setAttribute("data-application-lane-main", token);
    (window as any).MainWorld.applyMainWorld({
      token,
      method: "event",
      event: "keydown",
      eventOptions: { key: "a", code: "KeyA" },
      values: [],
    });
    return { seen, value: input.value };
  });
  assert.deepEqual(result, { seen: ["a"], value: "preserved" });
});

test("MAIN-world allows consent inputs but blocks submit ancestors outside a shadow root", async () => {
  await page.setContent(
    '<label for="consent">I agree to the terms</label><input id="consent" type="checkbox"><form><button><span id="host"></span></button></form>',
  );
  await page.addScriptTag({ content: bundle });
  const results = await page.evaluate(() => {
    const root = document
      .querySelector("#host")!
      .attachShadow({ mode: "open" });
    root.innerHTML = "<span>Continue</span>";
    return [document.querySelector("input")!, root.querySelector("span")!].map(
      (element) => {
        const token = "11111111-1111-4111-8111-111111111111";
        element.setAttribute("data-application-lane-main", token);
        return (window as any).MainWorld.applyMainWorld({
          token,
          method: "click",
          values: [],
        });
      },
    );
  });
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(await page.locator("#consent").isChecked(), true);
});

test("checkOption checks the chosen control and rejects non-option targets", async () => {
  await page.setContent(
    '<input id="no" type="checkbox"><input id="off" type="checkbox" checked><input id="text">',
  );
  await page.addScriptTag({ content: bundle });
  const results = await page.evaluate(() => {
    const token = "11111111-1111-4111-8111-111111111111";
    const apply = (id: string, method: string) => {
      const element = document.querySelector<HTMLElement>(id)!;
      element.setAttribute("data-application-lane-main", token);
      return (window as any).MainWorld.applyMainWorld({
        token,
        method,
        values: ["No"],
      });
    };
    return {
      chosen: apply("#no", "checkOption"),
      cleared: apply("#off", "selectCheckboxOrRadio"),
      text: apply("#text", "checkOption"),
    };
  });
  assert.equal(results.chosen.ok, true);
  assert.equal(await page.locator("#no").isChecked(), true);
  assert.equal(results.cleared.ok, true);
  assert.equal(await page.locator("#off").isChecked(), false);
  assert.equal(results.text.ok, false);
  assert.equal(await page.locator("#text").inputValue(), "");
});
