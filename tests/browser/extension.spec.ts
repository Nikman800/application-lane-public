import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, cp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { once } from "node:events";
import { build } from "esbuild";
import { PDFDocument } from "pdf-lib";
import { Document, Packer, Paragraph } from "docx";
import { createApp } from "../../src/server/app";
import { configSchema } from "../../src/server/store";
import { profileSchema, type QueueState } from "../../src/shared/model";
import {
  groundNarrative,
  provider,
  type Generate,
} from "../../src/server/generation";
import { icimsCandidatePage } from "./icims-fixture";
import { realSchools, schoolsWithout } from "../support/schools";
import { ssrSelectMarkup } from "./ssr-select-fixture";
import { proposals as knownProposals } from "../../src/shared/matching";
import { rememberChromiumProfile, seedChromiumProfile } from "../support/chromium-profile";

const token = "browser-fixture-token-".repeat(4);

let context: BrowserContext,
  panel: Page,
  worker: Worker,
  backend: Server,
  fixture: Server;
let origin = "",
  extensionId = "",
  generatorDelay = 450,
  submitted = 0;
let runtimeGenerate: Generate | undefined;
// Each run copies dist/extension into fresh temp dirs; /tmp is a small tmpfs,
// so leaked runs eventually fail every test with EDQUOT.
const scratchDirs: string[] = [];
// This test's Chromium profile.
let profileDir: string | undefined;
const scratch = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(directory);
  return directory;
};
// The backend's config, read by its routes on each request; one test points
// it at a job-applier checkout for the duration of that test only.
let appConfig: ReturnType<typeof configSchema.parse>;
// The backend's data directory for the current test (.local in real use).
let backendDirectory = "";
// The backend's pairing code (pairing.ts), as its terminal would show it.
let pairingControl: Awaited<ReturnType<typeof createApp>>["pairing"];
const atsOrigins = [
  "https://acme.wd5.myworkdayjobs.com",
  "https://boards.greenhouse.io",
  "https://jobs.lever.co",
  "https://jobs.ashbyhq.com",
  "https://careers-acme.icims.com",
];
// Granted like atsOrigins, but outside the per-ATS fixture loop.
const oracleOrigin = "https://egug.fa.us2.oraclecloud.com";
const workableOrigin = "https://apply.workable.com";
const sapsfOrigin = "https://career55.sapsf.eu";
const adpOrigin = "https://myjobs.adp.com";
const talNetOrigin = "https://careers-fixture.tal.net";
const amazonOrigin = "https://account.amazon.jobs";
const paylocityOrigin = "https://recruiting.paylocity.com";
const jazzOrigin = "https://acme.applytojob.com";
const avatureOrigin = "https://acme.avature.net";
const breezyOrigin = "https://acme.breezy.hr";
const ripplingOrigin = "https://ats.rippling.com";
const teslaOrigin = "https://www.tesla.com";
const smartRecruitersOrigin = "https://jobs.smartrecruiters.com";
// Pages the fixture server itself serves, for tabs the extension opens: a
// Playwright route does not reach those.
const fixturePages = new Map<string, string>();
const profile = profileSchema.parse({
  firstName: "Alex",
  lastName: "Rivera",
  email: "alex@example.test",
  phone: "6025550101",
  country: "United States",
  city: "Phoenix",
  confirmed: true,
  revision: 1,
  facts: [
    {
      id: "fact-1",
      text: "Built accessible web applications with TypeScript.",
    },
    { id: "fact-2", text: "Improved performance by 30%." },
  ],
});
const html = (path: string) =>
  `<!doctype html><html><head><title>Frontend Engineer ${path}</title><style>body{font:16px system-ui;margin:40px;background:#f8faf9}form{max-width:650px}label{display:block;margin:15px 0}input,textarea,select{display:block;padding:10px;width:350px}button{padding:12px}</style></head><body><main><h1>Frontend Engineer ${path}</h1><p>Build accessible TypeScript applications and improve performance.</p><form id="application"><label>First name<input name="firstName" required></label><label>Last name<input name="lastName" required></label><label>Email<input name="email" type="email" required></label><label>Phone<input name="phone"></label><label>Country<select name="country"><option value="">Select…</option><option value="US">United States</option></select></label><label>Describe your experience<textarea name="experience"></textarea></label><label>Resume<input name="resume" type="file" accept=".pdf,.docx" required></label><label>Cover letter<textarea name="cover"></textarea></label>${path.includes("sensitive") ? '<label>Do you require visa sponsorship?<select name="visa" required><option value="">Select…</option><option>Yes</option><option>No</option></select></label>' : ""}<button type="submit">Submit application</button></form></main><script>window.submissions=0;document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.submissions++;fetch('/submitted')});</script></body></html>`;
async function state(): Promise<QueueState> {
  return panel.evaluate(
    async () => (await chrome.runtime.sendMessage({ type: "STATE" })).data,
  );
}
async function ui(message: unknown) {
  const result = await panel.evaluate(
    async (message) => chrome.runtime.sendMessage(message),
    message,
  );
  if (!result?.ok) throw new Error(result?.error || "No UI response");
  return result.data;
}
// Pre-filled answers stay as the site filled them (Settings > Processing).
async function keepPrefilled() {
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, prefilled: "keep" } });
}
async function enqueue(pages: Page[]) {
  const tabs = await panel.evaluate(async () => chrome.tabs.query({}));
  const tracked = await ui({
    type: "TRACK_ITEMS",
    items: pages.map((page) => ({
      url: page.url(),
      tabId: tabs.find((t) => t.url === page.url())!.id,
    })),
  });
  for (const page of pages) {
    const tabId = tabs.find((tab) => tab.url === page.url())!.id;
    const app = tracked.applications.find(
      (candidate: { tabId?: number }) => candidate.tabId === tabId,
    );
    if (!app) throw new Error(`Tracked application not found for ${page.url()}`);
    await ui({ type: "FILL_STEP", id: app.id });
  }
}
async function content(page: Page, message: Record<string, unknown>) {
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((t) => t.url === url)!.id!,
    page.url(),
  );
  // The extension injects its content script when it starts the application,
  // so a message sent before that fails with "Receiving end does not exist".
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await worker.evaluate(
        async ({ tabId, message }) =>
          chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
        { tabId, message },
      );
    } catch (error) {
      lastError = error;
      await panel.waitForTimeout(250);
    }
  }
  throw lastError;
}
// Headless Chromium reports every tab as focused. Content scripts share the
// extension's isolated world, so emulate a real background tab there.
async function background(page: Page) {
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((t) => t.url === url)!.id!,
    page.url(),
  );
  // The tab may still be initializing right after goto; injecting then fails
  // with "Receiving end does not exist", which reads as a product failure.
  for (let attempt = 0; attempt < 10; attempt++) {
    const injected = await worker
      .evaluate(
        async (tabId) =>
          chrome.scripting
            .executeScript({
              target: { tabId, frameIds: [0] },
              world: "ISOLATED",
              func: () => {
                window.Document.prototype.hasFocus = () => false;
              },
            })
            .then(() => true, () => false),
        tabId,
      )
      .catch(() => false);
    if (injected) return;
    await page.waitForTimeout(250);
  }
  throw new Error("Could not mark the tab as a background tab.");
}
// Parallel fills are a core use: a fill must come out the same whether its
// tab is in front of the applicant or in the background.
const tabStates = ["background", "focused"] as const;
type TabState = (typeof tabStates)[number];
async function place(page: Page, tab: TabState) {
  if (tab === "background") return background(page);
  await page.bringToFront();
}
function inEitherTab(title: string, body: (tab: TabState) => Promise<void>) {
  for (const tab of tabStates) test(`${title} (${tab} tab)`, () => body(tab));
}
test.beforeEach(async () => {
  submitted = 0;
  generatorDelay = 450;
  runtimeGenerate = undefined;
  const directory = await scratch("lane-browser-");
  backendDirectory = directory;
  appConfig = configSchema.parse({ postingLookup: false,
    documentsDir: join(directory, "documents"),
    token,
    model: "fixture-model",
    endpoint: "http://127.0.0.1:9999/v1",
  });
  const app = await createApp(
    appConfig,
    directory,
    async (req, p, signal) => {
      if (runtimeGenerate) return runtimeGenerate(req, p, signal);
      await new Promise((r) => setTimeout(r, generatorDelay));
      if (signal.aborted) throw new Error("Cancelled");
      return groundNarrative(
        {
          resume: p.facts.map((f) => ({ factId: f.id, text: f.text })),
          coverLetter: [{ text: "", factIds: ["fact-1"] }],
          answers: req.fields
            .filter((f) => /describe/i.test(f.label))
            .map((f) => ({ fieldId: f.id, value: "", factIds: ["fact-1"] })),
        },
        p,
        req,
      );
    },
  );
  app.store.data.profile = structuredClone(profile);
  await app.store.save();
  backend = app.server;
  pairingControl = app.pairing;
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const backendOrigin = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
  fixture = createServer((req, res) => {
    if (req.url === "/submitted") submitted++;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fixturePages.get(req.url || "/") ?? html(req.url || "/"));
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  origin = `http://127.0.0.1:${(fixture.address() as any).port}`;
  // A disposable installation pre-grants only our intercepted ATS fixture
  // origins, equivalent to accepting the production extension's access prompt.
  const extensionPath = await scratch("lane-extension-");
  await cp(resolve(process.env.LANE_EXTENSION_DIR || "dist/extension"), extensionPath, { recursive: true });
  const manifest = JSON.parse(
    await readFile(join(extensionPath, "manifest.json"), "utf8"),
  );
  // Keep the user's running backend untouched. Only this disposable test
  // installation connects to the ephemeral fixture backend.
  manifest.content_security_policy.extension_pages =
    manifest.content_security_policy.extension_pages.replaceAll(
      "http://127.0.0.1:4318",
      backendOrigin,
    ).replaceAll("ws://127.0.0.1:4318", backendOrigin.replace(/^http/, "ws"));
  const backgroundPath = join(extensionPath, "background.js");
  await writeFile(
    backgroundPath,
    (await readFile(backgroundPath, "utf8")).replaceAll(
      "http://127.0.0.1:4318",
      backendOrigin,
    ),
  );
  manifest.host_permissions.push(...[...atsOrigins, oracleOrigin, workableOrigin, sapsfOrigin, adpOrigin, talNetOrigin, amazonOrigin, paylocityOrigin, jazzOrigin, avatureOrigin, breezyOrigin, ripplingOrigin, teslaOrigin, smartRecruitersOrigin, "https://smartapply.indeed.com", "https://www.linkedin.com"].map((origin) => `${origin}/*`));
  await writeFile(
    join(extensionPath, "manifest.json"),
    JSON.stringify(manifest),
  );
  // One test loads a stand-in for another autofill extension beside ours.
  const extensions = test.info().title.includes("another autofill extension")
    ? `${extensionPath},${resolve("tests/browser/fake-autofill")}`
    : extensionPath;
  // A fresh profile handed Chromium's Windows password check, which costs
  // a bad password each time it runs (tests/support/chromium-profile.ts).
  profileDir = await scratch("lane-chromium-");
  await seedChromiumProfile(profileDir);
  context = await chromium.launchPersistentContext(
    profileDir,
    {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensions}`,
        `--load-extension=${extensions}`,
        "--no-sandbox",
      ],
      viewport: { width: 1120, height: 1050 },
    },
  );
  worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  await ui({ type: "PAIR", token });
  // As fills worked before the AI-filling setting: written answers filled,
  // suggestions on request. Tests of the setting choose their own level.
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, modelFill: "written" } });
  await panel.reload();
  await expect(
    panel.getByText("Connected to your local backend"),
  ).toBeVisible();
});
// The side panel (panel.html) holds the applications; the profile, issue
// reports and settings are the dashboard, a browser tab of its own.
const showDashboard = (page: "profile" | "jobs" | "submitted" | "fixer" | "issues" | "settings") =>
  panel.goto(`chrome-extension://${extensionId}/dashboard.html#${page}`);
const showPanel = () => panel.goto(`chrome-extension://${extensionId}/panel.html`);
test.afterEach(async () => {
  await context?.close();
  if (profileDir) await rememberChromiumProfile(profileDir).catch(() => {});
  if (backend) await new Promise<void>((r) => backend.close(() => r()));
  if (fixture) await new Promise<void>((r) => fixture.close(() => r()));
  for (const directory of scratchDirs.splice(0))
    await rm(directory, { recursive: true, force: true }).catch(() => {});
});

test("packaged v2 fills an embedded config through the authorized MAIN-world bridge", async () => {
  const page = await context.newPage();
  await page.route(`${origin}/config-bridge`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><form id="application-form" action="https://boards.greenhouse.io/acme">
      <label>Candidate alpha<input id="first_name" required></label>
      <label>Candidate beta<input id="last_name" required></label>
      <label>Email<input name="email" type="email" required></label>
      <label>Site parser output<input id="site-parser-output"></label>
      <label>Resume<input name="resume" type="file" accept=".pdf" required></label>
      <button type="submit">Submit application</button>
    </form><script>
      for (const id of ['first_name', 'last_name']) {
        const input = document.getElementById(id);
        input.__reactProps$fixture = { onChange(event) {
          input.dataset.mainValue = event.target.value;
          if (id === 'first_name') setTimeout(() => {
            const parserOutput = document.getElementById('site-parser-output');
            parserOutput.value = 'SITE-DERIVED';
            parserOutput.dispatchEvent(new Event('input', { bubbles: true }));
            parserOutput.dispatchEvent(new Event('change', { bubbles: true }));
          }, 50);
        } };
      }
      window.submissions = 0;
      document.querySelector('form').onsubmit = event => { event.preventDefault(); window.submissions++; };
    </script>`,
    }),
  );
  await page.goto(`${origin}/config-bridge`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0]?.status, {
      timeout: 30000,
    })
    .toBe("ready");
  await expect(page.locator("#first_name")).toHaveValue(profile.firstName);
  await expect(page.locator("#first_name")).toHaveAttribute(
    "data-main-value",
    profile.firstName,
  );
  await expect(page.locator("#last_name")).toHaveAttribute(
    "data-main-value",
    profile.lastName,
  );
  await expect(page.locator("#site-parser-output")).toHaveValue("SITE-DERIVED");
  expect(
    await page
      .locator('[type="file"]')
      .evaluate((input) => (input as HTMLInputElement).files?.length),
  ).toBe(1);
  expect(
    await page.evaluate(() => (window as any).ApplicationLaneV2),
  ).toBeUndefined();
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
  const app = (await state()).applications[0];
  const observation = (await content(page, { type: "INSPECT" })).data;
  expect(
    observation.fields.find(
      (field: { label: string }) => field.label === "Site parser output",
    ),
  ).toMatchObject({ value: "SITE-DERIVED", protected: true });
  const response = await content(page, {
    type: "AUTHORIZE_MAIN",
    applicationId: app.id,
    operation: app.operation,
    documentId: observation.documentId,
    token: crypto.randomUUID(),
  });
  expect(response).toEqual({ ok: true, data: { authorized: false } });
});

test("a captcha frame with granted access is never configured or filled", async () => {
  // Same-origin /recaptcha/ gives the disposable extension actual host
  // access, exercising the path that was missed by the no-permission tests.
  const form = '<form><label>First name<input name="firstName" required></label><label>Last name<input name="lastName" required></label><label>Email<input name="email" required></label><button type="submit">Submit application</button></form><script>window.submissions=0;document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.submissions++})</script>';
  await context.route(`${origin}/granted-captcha-shell`, route => route.fulfill({ contentType: "text/html", body: `${form}<iframe title="reCAPTCHA" src="${origin}/recaptcha/api2/anchor?fixture=1"></iframe>` }));
  await context.route(`${origin}/recaptcha/**`, route => route.fulfill({ contentType: "text/html", body: form }));
  const page = await context.newPage();
  await page.goto(`${origin}/granted-captcha-shell`);
  await expect(page.frameLocator("iframe").locator('[name=firstName]')).toBeVisible();
  const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, page.url());
  await worker.evaluate(tabId => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    (globalThis as any).__captchaConfigs = 0;
    (globalThis as any).__captchaBinds = 0;
    chrome.tabs.sendMessage = (async (...args: any[]) => {
      if (args[0] === tabId && args[2]?.frameId !== 0) {
        if (args[1]?.type === "BIND") (globalThis as any).__captchaBinds++;
        if (args[1]?.type === "CONFIG_FILL") {
          (globalThis as any).__captchaConfigs++;
          throw Error("Could not establish connection. Receiving end does not exist.");
        }
      }
      return original(...args as Parameters<typeof chrome.tabs.sendMessage>);
    }) as typeof chrome.tabs.sendMessage;
  }, tabId);
  const scanned = await ui({ type: "SCAN_TAB", tabId });
  expect(scanned.fieldCount).toBe(3);
  expect(scanned.observation.url).toBe(page.url());
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toMatch(/^(ready|awaiting-user)$/);
  await expect(page.locator('[name=firstName]')).toHaveValue(profile.firstName);
  await expect(page.locator('[name=email]')).toHaveValue(profile.email);
  await expect(page.frameLocator("iframe").locator('[name=firstName]')).toHaveValue("");
  expect(await worker.evaluate(() => [(globalThis as any).__captchaConfigs, (globalThis as any).__captchaBinds])).toEqual([0, 0]);
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
  expect(await page.frameLocator("iframe").locator("body").evaluate(() => (window as any).submissions)).toBe(0);
});

test("a real application frame configuration failure is not hidden by captcha exclusion", async () => {
  await context.route(`${origin}/config-receiver-shell`, route => route.fulfill({ contentType: "text/html", body: `<iframe src="${origin}/config-receiver-application?fixture=1"></iframe>` }));
  await context.route(`${origin}/config-receiver-application*`, route => route.fulfill({ contentType: "text/html", body: '<form><label>First name<input name="firstName" required></label><label>Last name<input name="lastName" required></label><label>Email<input name="email" required></label></form>' }));
  const page = await context.newPage();
  await page.goto(`${origin}/config-receiver-shell`);
  const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, page.url());
  await worker.evaluate(tabId => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    (globalThis as any).__applicationConfigFaults = 0;
    chrome.tabs.sendMessage = (async (...args: any[]) => {
      if (args[0] === tabId && args[1]?.type === "CONFIG_FILL" && args[2]?.frameId !== 0) {
        (globalThis as any).__applicationConfigFaults++;
        throw Error("Could not establish connection. Receiving end does not exist.");
      }
      return original(...args as Parameters<typeof chrome.tabs.sendMessage>);
    }) as typeof chrome.tabs.sendMessage;
  }, tabId);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toBe("failed");
  expect((await state()).applications[0].note).toContain(`url ${origin}/config-receiver-application`);
  expect((await state()).applications[0].note).not.toContain("?fixture=");
  expect(await worker.evaluate(() => (globalThis as any).__applicationConfigFaults)).toBe(1);
  await expect(page.frameLocator("iframe").locator('[name=firstName]')).toHaveValue("");
});

test("a missing content receiver retries one inspection without replaying a mutation", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/read-receiver-recovery`);
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  await worker.evaluate((tabId) => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    (globalThis as any).__receiverFaults = 0;
    chrome.tabs.sendMessage = (async (...args: any[]) => {
      if (args[0] === tabId && args[1]?.type === "INSPECT" && args[1]?.applicationId && !(globalThis as any).__receiverFaults) {
        (globalThis as any).__receiverFaults++;
        throw Error("Could not establish connection. Receiving end does not exist.");
      }
      return original(...args as Parameters<typeof chrome.tabs.sendMessage>);
    }) as typeof chrome.tabs.sendMessage;
  }, tabId);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toBe("ready");
  expect(await worker.evaluate(() => (globalThis as any).__receiverFaults)).toBe(1);
  await expect(page.locator('[name=firstName]')).toHaveValue(profile.firstName);
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

for (const transport of ["missing receiver", "removed frame"] as const) {
  test(`an iframe replaced before INSPECT recovers its unique document after a ${transport}`, async () => {
    await context.route(`${origin}/inspect-frame-shell`, route => route.fulfill({ contentType: "text/html", body: `<iframe src="${origin}/inspect-frame-document"></iframe>` }));
    await context.route(`${origin}/inspect-frame-document`, route => route.fulfill({ contentType: "text/html", body: '<form><label>First name<input name="firstName" required></label><label>Last name<input name="lastName" required></label><label>Email<input name="email" required></label><button type="submit">Submit application</button></form><script>window.submissions=0;document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.submissions++})</script>' }));
    const page = await context.newPage();
    await page.goto(`${origin}/inspect-frame-shell`);
    const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, page.url());
    await worker.evaluate(({ tabId, transport }) => {
      const original = chrome.tabs.sendMessage.bind(chrome.tabs);
      const inject = chrome.scripting.executeScript.bind(chrome.scripting);
      (globalThis as any).__inspectFaults = 0;
      (globalThis as any).__oldInspectCalls = 0;
      (globalThis as any).__failedReadReinjections = 0;
      chrome.scripting.executeScript = (async (...args: any[]) => {
        if (transport === "missing receiver" && (globalThis as any).__inspectFaults &&
          args[0]?.files?.includes("content.js") && args[0]?.target?.frameIds?.includes((globalThis as any).__oldInspectFrame)) {
          (globalThis as any).__failedReadReinjections++;
          throw Error(`No frame with id ${(globalThis as any).__oldInspectFrame} in tab with id ${tabId}`);
        }
        return inject(...args as Parameters<typeof chrome.scripting.executeScript>);
      }) as unknown as typeof chrome.scripting.executeScript;
      chrome.tabs.sendMessage = (async (...args: any[]) => {
        if (args[0] === tabId && args[1]?.type === "INSPECT" && args[1]?.applicationId && args[2]?.frameId !== 0) {
          if (args[2]?.frameId === (globalThis as any).__oldInspectFrame) (globalThis as any).__oldInspectCalls++;
          if (!(globalThis as any).__inspectFaults) {
            (globalThis as any).__inspectFaults++;
            (globalThis as any).__oldInspectFrame = args[2]?.frameId;
            (globalThis as any).__oldInspectCalls = 1;
            await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => {
              const frame = document.querySelector("iframe")!;
              frame.replaceWith(frame.cloneNode(true));
            } });
            throw Error(transport === "missing receiver" ? "Could not establish connection. Receiving end does not exist." : `No frame with id ${args[2]?.frameId} in tab with id ${tabId}`);
          }
        }
        return original(...args as Parameters<typeof chrome.tabs.sendMessage>);
      }) as typeof chrome.tabs.sendMessage;
    }, { tabId, transport });
    await enqueue([page]);
    await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toBe("awaiting-user");
    await expect(page.frameLocator("iframe").locator('[name=firstName]')).toHaveValue(profile.firstName);
    await expect(page.frameLocator("iframe").locator('[name=lastName]')).toHaveValue(profile.lastName);
    await expect(page.frameLocator("iframe").locator('[name=email]')).toHaveValue(profile.email);
    expect(await worker.evaluate(() => (globalThis as any).__inspectFaults)).toBe(1);
    expect(await worker.evaluate(() => (globalThis as any).__oldInspectCalls)).toBe(1);
    expect(await worker.evaluate(() => (globalThis as any).__failedReadReinjections)).toBe(transport === "missing receiver" ? 1 : 0);
    expect((await state()).applications[0].missing.join(" ")).toMatch(/upload was not repeated/);
    expect(await page.frameLocator("iframe").locator("body").evaluate(() => (window as any).submissions)).toBe(0);
  });
}

test("an empty embedded frame the page removed is no failed upload", async () => {
  // Microsoft's careers page embeds a near-empty export frame for its profile
  // and removes it; the site rule's uploads sent there failed with "Receiving
  // end does not exist", reported as a résumé and cover letter that did not
  // upload, while the résumé was in (2026-11-07).
  const markup = '<form><label>First name<input name="firstName" required></label><label>Email<input name="email" required></label><label>Resume<input type="file" name="resume"></label><button type="submit">Submit application</button></form><iframe src="/profile-export-frame"></iframe><script>window.submissions=0;document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.submissions++})</script>';
  await context.route(`${origin}/export-frame-shell`, route => route.fulfill({ contentType: "text/html", body: markup }));
  await context.route(`${origin}/profile-export-frame`, route => route.fulfill({ contentType: "text/html", body: "<html><head></head><body></body></html>" }));
  const page = await context.newPage();
  await page.goto(`${origin}/export-frame-shell`);
  const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, page.url());
  await worker.evaluate((tabId) => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    (globalThis as any).__frameUploads = 0;
    chrome.tabs.sendMessage = (async (...args: any[]) => {
      if (args[0] === tabId && args[1]?.type === "CONFIG_FILL" && args[1]?.uploads && args[2]?.frameId !== 0) {
        (globalThis as any).__frameUploads++;
        throw Error("Could not establish connection. Receiving end does not exist.");
      }
      return original(...args as Parameters<typeof chrome.tabs.sendMessage>);
    }) as typeof chrome.tabs.sendMessage;
  }, tabId);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  await expect(page.locator("[name=firstName]")).toHaveValue(profile.firstName);
  expect(await worker.evaluate(() => (globalThis as any).__frameUploads)).toBe(0);
  expect((await state()).applications[0].missing.join(" ")).not.toMatch(/upload did not finish/i);
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

for (const replacement of ["different URL", "ambiguous exact URLs"] as const) {
  test(`inspection recovery refuses a replacement with ${replacement}`, async () => {
    const markup = '<form><label>First name<input name="firstName" required></label><label>Last name<input name="lastName" required></label><label>Email<input name="email" required></label><button type="submit">Submit application</button></form><script>window.submissions=0;document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.submissions++})</script>';
    await context.route(`${origin}/refused-inspect-shell`, route => route.fulfill({ contentType: "text/html", body: `<iframe src="${origin}/refused-inspect-document"></iframe>` }));
    await context.route(`${origin}/*inspect-document`, route => route.fulfill({ contentType: "text/html", body: markup }));
    const page = await context.newPage();
    await page.goto(`${origin}/refused-inspect-shell`);
    const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, page.url());
    await worker.evaluate(({ tabId, replacement }) => {
      const original = chrome.tabs.sendMessage.bind(chrome.tabs);
      (globalThis as any).__inspectFaults = 0;
      chrome.tabs.sendMessage = (async (...args: any[]) => {
        if (args[0] === tabId && args[1]?.type === "INSPECT" && args[1]?.applicationId && args[2]?.frameId !== 0 && !(globalThis as any).__inspectFaults) {
          (globalThis as any).__inspectFaults++;
          await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, args: [replacement], func: (replacement) => {
            const frame = document.querySelector("iframe")!;
            if (replacement === "different URL") frame.src = new URL("/unrelated-inspect-document", location.href).href;
            else frame.replaceWith(frame.cloneNode(true), frame.cloneNode(true));
          } });
          throw Error(`No frame with id ${args[2]?.frameId} in tab with id ${tabId}`);
        }
        return original(...args as Parameters<typeof chrome.tabs.sendMessage>);
      }) as typeof chrome.tabs.sendMessage;
    }, { tabId, replacement });
    await enqueue([page]);
    await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toBe("failed");
    expect((await state()).applications[0].note).toMatch(/No frame with id.*command INSPECT/);
    expect(await worker.evaluate(() => (globalThis as any).__inspectFaults)).toBe(1);
    const frames = page.frames().filter(frame => frame.parentFrame());
    expect(frames).toHaveLength(replacement === "different URL" ? 1 : 2);
    for (const frame of frames) {
      await expect(frame.locator('[name=firstName]')).toHaveValue("");
      await expect(frame.locator('[name=email]')).toHaveValue("");
      expect(await frame.evaluate(() => (window as any).submissions)).toBe(0);
    }
  });
}

test("a persistent inspection receiver failure stays failed with command and document diagnostics", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/persistent-inspect-receiver-failure`);
  const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, page.url());
  await worker.evaluate(tabId => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    (globalThis as any).__inspectFaults = 0;
    chrome.tabs.sendMessage = (async (...args: any[]) => {
      if (args[0] === tabId && args[1]?.type === "INSPECT" && args[1]?.applicationId) {
        (globalThis as any).__inspectFaults++;
        throw Error("Could not establish connection. Receiving end does not exist.");
      }
      return original(...args as Parameters<typeof chrome.tabs.sendMessage>);
    }) as typeof chrome.tabs.sendMessage;
  }, tabId);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toBe("failed");
  expect(await worker.evaluate(() => (globalThis as any).__inspectFaults)).toBe(2);
  expect((await state()).applications[0].note).toMatch(/Receiving end does not exist.*command INSPECT.*frame 0.*document [a-f0-9-]+.*read recovery failed/);
  await expect(page.locator('[name=firstName]')).toHaveValue(profile.firstName);
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

test("an iframe replaced during APPLY re-inspects the same exact URL without replaying the interrupted write", async () => {
  await context.route(`${origin}/apply-receiver-shell`, (route) => route.fulfill({ contentType: "text/html", body: `<iframe src="${origin}/apply-receiver-frame"></iframe>` }));
  await context.route(`${origin}/apply-receiver-frame`, (route) => route.fulfill({ contentType: "text/html", body: '<form><label>First name<input name="firstName" required></label><label>Last name<input name="lastName" required></label><label>Email<input name="email" required></label><button type="submit">Submit application</button></form><script>window.submissions=0;document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.submissions++})</script>' }));
  const page = await context.newPage();
  await page.goto(`${origin}/apply-receiver-shell`);
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  await worker.evaluate((tabId) => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    (globalThis as any).__applyFaults = 0;
    (globalThis as any).__originalApplyCalls = 0;
    (globalThis as any).__interruptedDocument = "";
    chrome.tabs.sendMessage = (async (...args: any[]) => {
      if (args[0] === tabId && args[1]?.type === "APPLY" && args[1]?.applicationId) {
        if (args[1].documentId === (globalThis as any).__interruptedDocument)
          (globalThis as any).__originalApplyCalls++;
        if (!(globalThis as any).__applyFaults) {
          (globalThis as any).__applyFaults++;
          (globalThis as any).__interruptedDocument = args[1].documentId;
          (globalThis as any).__originalApplyCalls = 1;
          (globalThis as any).__oldApplyFrame = args[2]?.frameId;
          await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => {
            const old = document.querySelector("iframe")!;
            old.replaceWith(old.cloneNode(true));
          } });
          throw Error("Could not establish connection. Receiving end does not exist.");
        }
      }
      return original(...args as Parameters<typeof chrome.tabs.sendMessage>);
    }) as typeof chrome.tabs.sendMessage;
  }, tabId);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toBe("awaiting-user");
  expect(await worker.evaluate(() => (globalThis as any).__applyFaults)).toBe(1);
  expect(await worker.evaluate(() => (globalThis as any).__originalApplyCalls)).toBe(1);
  await expect(page.frameLocator("iframe").locator('[name=firstName]')).toHaveValue("");
  expect((await state()).applications[0].missing.join(" ")).toMatch(/interrupted write was not retried/);
  await page.waitForTimeout(1200);
  expect((await state()).applications[0].status).toBe("awaiting-user");
  await expect(page.frameLocator("iframe").locator('[name=firstName]')).toHaveValue("");
  expect(await page.frameLocator("iframe").locator("body").evaluate(() => (window as any).submissions)).toBe(0);
});

test("an APPLY receiver failure on the same document stays failed and is never replayed", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/same-document-receiver-failure`);
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  await worker.evaluate((tabId) => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    (globalThis as any).__applyFaults = 0;
    (globalThis as any).__originalApplyCalls = 0;
    (globalThis as any).__interruptedDocument = "";
    chrome.tabs.sendMessage = (async (...args: any[]) => {
      if (args[0] === tabId && args[1]?.type === "APPLY" && args[1]?.applicationId) {
        if (args[1].documentId === (globalThis as any).__interruptedDocument)
          (globalThis as any).__originalApplyCalls++;
        if (!(globalThis as any).__applyFaults) {
          (globalThis as any).__applyFaults++;
          (globalThis as any).__interruptedDocument = args[1].documentId;
          (globalThis as any).__originalApplyCalls = 1;
          throw Error("Could not establish connection. Receiving end does not exist.");
        }
      }
      return original(...args as Parameters<typeof chrome.tabs.sendMessage>);
    }) as typeof chrome.tabs.sendMessage;
  }, tabId);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toBe("failed");
  expect(await worker.evaluate(() => (globalThis as any).__applyFaults)).toBe(1);
  expect(await worker.evaluate(() => (globalThis as any).__originalApplyCalls)).toBe(1);
  await expect(page.locator('[name=firstName]')).toHaveValue("");
  expect((await state()).applications[0].note).toMatch(/Receiving end does not exist/);
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

test("a Lever-style radio click does not pause the config engine", async () => {
  const leverOrigin = atsOrigins[2];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      answers: [
        { question: "How did you hear about us?", answer: "Other" },
      ],
    },
  });
  await context.route(`${leverOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><form>
        <div class="application-question">
          <div class="application-label">Where you first heard</div>
          <div class="application-field">
            <input type="radio" name="source" value="placeholder" disabled hidden>
            <label><input id="source-other" type="radio" name="source" value="Other">Other</label>
          </div>
        </div>
        <div class="application-question">
          <div class="application-label">Where you found</div>
          <div class="application-field"><input type="text"></div>
        </div>
        <script>
          for (const type of ['input', 'change']) {
            document.querySelector('#source-other').addEventListener(type, event => {
              document.body.dataset[type + 'Trusted'] = String(event.isTrusted);
            });
          }
          document.querySelector('#source-other').addEventListener('click', () => {
            const deadline = performance.now() + 650;
            while (performance.now() < deadline) {}
          });
        </script>
      </form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${leverOrigin}/acme/engine-radio`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect(page.locator("#source-other")).toBeChecked({ timeout: 30000 });
  await expect
    .poll(async () => (await state()).applications[0].status, {
      timeout: 30000,
    })
    .not.toBe("paused");
  await expect(page.locator("body")).toHaveAttribute(
    "data-input-trusted",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-change-trusted",
    "true",
  );
});

test("a user's Yes radio survives resume and node recreation", async () => {
  const greenhouseOrigin = atsOrigins[1];
  const savedProfile = {
    ...profile,
    answers: [
      {
        question: "Are you legally authorized to work in the United States?",
        answer: "No",
      },
    ],
  };
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: savedProfile,
  });
  const radioGroup = (checked: "yes" | "no" | "none") => `
    <fieldset id="authorization">
      <legend>Are you legally authorized to work in the United States?</legend>
      <label><input id="auth-yes" type="radio" name="authorization" value="Yes" ${checked === "yes" ? "checked" : ""}>Yes</label>
      <label><input id="auth-no" type="radio" name="authorization" value="No" ${checked === "no" ? "checked" : ""}>No</label>
    </fieldset>`;
  await context.route(`${greenhouseOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><form>${radioGroup("none")}</form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${greenhouseOrigin}/acme/jobs/engine-lock`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect(page.locator("#auth-no")).toBeChecked({ timeout: 30000 });
  await page.bringToFront();
  await page.locator("#auth-yes").check();
  await expect
    .poll(async () => (await state()).applications[0].status)
    .toBe("paused");

  const app = (await state()).applications[0];
  // The card names what paused it: a pause nobody remembers causing could
  // not be traced from "You interacted" alone.
  expect(app.note).toMatch(/^You interacted with this application \((a click|an edit) on "[^"]+"\)\. Choose Fill this step when ready\.$/);
  const observation = (await content(page, { type: "INSPECT" })).data;
  const resumedOperation = app.operation + 1;
  const resumed = await content(page, {
    type: "RESUME",
    applicationId: app.id,
    operation: resumedOperation,
    documentId: observation.documentId,
  });
  expect(resumed.ok).toBe(true);
  await page.locator("#authorization").evaluate(
    (fieldset, markup) => {
      fieldset.outerHTML = markup;
    },
    radioGroup("yes"),
  );
  const filled = await content(page, {
    type: "CONFIG_FILL",
    applicationId: app.id,
    operation: resumedOperation,
    documentId: observation.documentId,
    profile: savedProfile,
  });
  expect(filled.ok).toBe(true);
  await expect(page.locator("#auth-yes")).toBeChecked();
  await expect(page.locator("#auth-no")).not.toBeChecked();
});

test("the checkboxes in a Workday multiselect's option list are not fields", async () => {
  // Jabil's Skills search list (Workday check task 80dbf488): each option
  // draws a checkbox of its own, named only by a generated id. Taken for
  // fields, ticking one redrew the list and detached the rest.
  const workdayOrigin = atsOrigins[0];
  const option = (index: number, label: string, checked: boolean) =>
    `<div id="menuItem-SKILL-${index}" data-automation-id="menuItem" role="option" aria-label="${label} ${checked ? "checked" : "not checked"}" aria-selected="${checked}">
      <div data-automation-id="promptLeafNode" data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkbox"><div dir="ltr"><div><div>
        <input type="checkbox" id="gen${index}x" data-automation-id="checkboxPanel" tabindex="-1" aria-checked="${checked}"${checked ? " checked" : ""}>
      </div></div></div></div><div data-automation-id="promptOption">${label}</div></div>
    </div>`;
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage"><form>
        <div data-automation-id="formField-currentlyWorkHere"><label for="work-current">I currently work here</label><input id="work-current" type="checkbox" name="currentlyWorkHere"></div>
        <div data-automation-id="formField-skills"><label for="skills">Type to Add Skills</label><input id="skills" data-automation-id="searchBox" placeholder="Search"></div>
      </form></main>
      <div data-automation-id="activeListContainer" data-automation-activepopup="true" role="listbox">
        ${option(1, "Problem Solving", true)}${option(2, "Problem Analysis", false)}${option(3, "Critical Thinking", false)}
      </div>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/skills-list`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0]?.status, {
      timeout: 30000,
    })
    .toMatch(/^(ready|awaiting-user)$/);
  const boxes = (await content(page, { type: "INSPECT" })).data.fields
    .filter((field: { kind: string }) => field.kind === "checkbox")
    .map((field: { label: string }) => field.label);
  expect(boxes).toEqual(["I currently work here"]);
});

test("a preselected Workday listbox button is tracked and locked", async () => {
  // Kept as the site filled it: replacing is tested on its own below.
  await keepPrefilled();
  const workdayOrigin = atsOrigins[0];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage"><form>
        <label id="country-label">Country</label>
        <button type="button" data-automation-id="countryDropdown" aria-haspopup="listbox" aria-labelledby="country-label">Canada</button>
        <span id="decorative" role="button">Open help</span>
      </form></main><script>
        window.dropdownClicks = 0;
        document.querySelector('[data-automation-id="countryDropdown"]').addEventListener('click', event => {
          window.dropdownClicks++;
          event.currentTarget.textContent = 'United States';
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/engine-dropdown`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0]?.status, {
      timeout: 30000,
    })
    .toMatch(/^(ready|awaiting-user)$/);
  const observation = (await content(page, { type: "INSPECT" })).data;
  expect(
    observation.fields.find(
      (field: { label: string }) => field.label === "Country",
    ),
  ).toMatchObject({ kind: "combobox", value: "Canada", protected: true });
  expect(
    observation.fields.some(
      (field: { label: string }) => field.label === "Open help",
    ),
  ).toBe(false);
  expect(await page.evaluate(() => (window as any).dropdownClicks)).toBe(0);
  await expect(
    page.locator('[data-automation-id="countryDropdown"]'),
  ).toHaveText("Canada");
});

test("an empty Workday listbox from the captured form remains fillable", async () => {
  const workdayOrigin = atsOrigins[0];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage"><form>
        <div data-automation-id="formField-source" data-fkit-id="source--source">
          <label for="source--source"><span>How Did You Hear About Us?<abbr aria-hidden="true">*</abbr></span></label>
          <div><button aria-haspopup="listbox" type="button" aria-label="How Did You Hear About Us? Select One Required" name="source" id="source--source">Select One</button><input type="text"></div>
        </div>
      </form></main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/captured-empty-dropdown`);
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const applicationId = crypto.randomUUID();
  const bound = await content(page, {
    type: "BIND",
    applicationId,
    operation: 1,
    locks: [],
  });
  expect(
    bound.data.fields.find(
      (field: { label: string }) => field.label === "How Did You Hear About Us?",
    ),
  ).toMatchObject({ kind: "combobox", value: "", protected: false });
  await page.locator("#source--source").evaluate((button) =>
    button.setAttribute(
      "aria-label",
      "How Did You Hear About Us? Job Board Required",
    ),
  );
  const relabelled = await content(page, { type: "INSPECT" });
  expect(
    relabelled.data.fields.find(
      (field: { label: string }) => field.label === "How Did You Hear About Us?",
    ),
  ).toMatchObject({ value: "", protected: false });
});

test("the captured Workday source dropdown uses confirmed referral preferences", async () => {
  const workdayOrigin = atsOrigins[0];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage"><form>
        <div data-automation-id="formField-source" data-fkit-id="source--source">
          <label for="source--source"><span>How Did You Hear About Us?<abbr aria-hidden="true">*</abbr></span></label>
          <button aria-haspopup="listbox" aria-expanded="false" type="button" aria-label="How Did You Hear About Us? Select One Required" name="source" id="source--source">Select One</button>
        </div>
      </form></main><script>
        const button = document.querySelector('#source--source');
        button.addEventListener('click', () => {
          if (document.querySelector('[data-automation-activepopup]')) return;
          button.setAttribute('aria-expanded', 'true');
          const popup = document.createElement('div');
          popup.setAttribute('data-automation-activepopup', 'true');
          popup.innerHTML = '<div data-automation-id="promptLeafNode"><div data-automation-id="promptOption" data-automation-label="LinkedIn">LinkedIn</div></div>';
          popup.querySelector('[data-automation-id="promptLeafNode"]').addEventListener('click', () => {
            button.textContent = 'LinkedIn';
            button.setAttribute('aria-label', 'How Did You Hear About Us? LinkedIn Required');
            button.setAttribute('aria-expanded', 'false');
            popup.remove();
          });
          document.body.append(popup);
        });
      </script>`,
    }),
  );
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, referralSource: ["LinkedIn", "Job board"] },
  });
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/captured-source`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator("#source--source")).toHaveText("LinkedIn", {
    timeout: 30_000,
  });
});

test("captured Workday address lines do not share the line-one value", async () => {
  const workdayOrigin = atsOrigins[0];
  const address = "100 Test Way";
  const county = "Maricopa";
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, address, county },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage"><form>
        <div data-automation-id="formField-addressLine1" data-fkit-id="address--addressLine1">
          <label for="address--addressLine1"><span>Address Line 1<abbr aria-hidden="true">*</abbr></span></label>
          <input type="text" id="address--addressLine1" name="addressLine1" aria-required="true">
        </div>
        <div data-automation-id="formField-addressLine2" data-fkit-id="address--addressLine2">
          <label for="address--addressLine2">Address Line 2</label>
          <input type="text" id="address--addressLine2" name="addressLine2" aria-required="false">
        </div>
        <div data-automation-id="formField-regionSubdivision1" data-fkit-id="address--regionSubdivision1">
          <label for="address--regionSubdivision1"><span>County<abbr aria-hidden="true">*</abbr></span></label>
          <input type="text" id="address--regionSubdivision1" name="regionSubdivision1" aria-required="true">
        </div>
      </form></main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/captured-address`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator("#address--addressLine1")).toHaveValue(
    address,
    { timeout: 30_000 },
  );
  await expect(page.locator("#address--addressLine2")).toHaveValue("");
  await expect(page.locator("#address--regionSubdivision1")).toHaveValue(
    county,
  );
});

test("the captured Workday state dropdown accepts a state abbreviation", async () => {
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, state: "AZ" },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage"><form>
        <div data-automation-id="formField-countryRegion" data-fkit-id="address--countryRegion">
          <label for="address--countryRegion"><span>State<abbr aria-hidden="true">*</abbr></span></label>
          <button aria-haspopup="listbox" aria-expanded="false" type="button" aria-label="State Select One Required" name="countryRegion" id="address--countryRegion">Select One</button>
        </div>
      </form></main><script>
        const button = document.querySelector('#address--countryRegion');
        button.addEventListener('click', () => {
          if (document.querySelector('[data-automation-activepopup]')) return;
          button.setAttribute('aria-expanded', 'true');
          const popup = document.createElement('div');
          popup.setAttribute('data-automation-activepopup', 'true');
          popup.innerHTML = '<div data-automation-id="promptLeafNode"><div data-automation-id="promptOption" data-automation-label="Arizona">Arizona</div></div>';
          popup.querySelector('[data-automation-id="promptLeafNode"]').addEventListener('click', () => {
            button.textContent = 'Arizona';
            button.setAttribute('aria-label', 'State Arizona Required');
            button.setAttribute('aria-expanded', 'false');
            popup.remove();
          });
          document.body.append(popup);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/captured-state`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator("#address--countryRegion")).toHaveText("Arizona", {
    timeout: 30_000,
  });
});

test("the captured Workday phone type uses the confirmed device type", async () => {
  const workdayOrigin = atsOrigins[0];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage"><form>
        <div data-automation-id="formField-phoneType" data-fkit-id="phoneNumber--phoneType">
          <label for="phoneNumber--phoneType"><span>Phone Device Type<abbr aria-hidden="true">*</abbr></span></label>
          <button aria-haspopup="listbox" aria-expanded="false" type="button" aria-label="Phone Device Type Select One Required" name="phoneType" id="phoneNumber--phoneType">Select One</button>
        </div>
      </form></main><script>
        const button = document.querySelector('#phoneNumber--phoneType');
        button.addEventListener('click', () => {
          if (document.querySelector('[data-automation-activepopup]')) return;
          button.setAttribute('aria-expanded', 'true');
          const popup = document.createElement('div');
          popup.setAttribute('data-automation-activepopup', 'true');
          popup.innerHTML = '<div data-automation-id="promptLeafNode"><div data-automation-id="promptOption" data-automation-label="Mobile">Mobile</div></div>';
          popup.querySelector('[data-automation-id="promptLeafNode"]').addEventListener('click', () => {
            button.textContent = 'Mobile';
            button.setAttribute('aria-label', 'Phone Device Type Mobile Required');
            button.setAttribute('aria-expanded', 'false');
            popup.remove();
          });
          document.body.append(popup);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/captured-phone-type`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator("#phoneNumber--phoneType")).toHaveText("Mobile", {
    timeout: 30_000,
  });
});

// TSC's Workday application started with Autofill with Resume (report
// 117fa197, 2026-10-31): the parser set Phone Device Type to Landline after
// the page was read, with no one at the keys, and that was locked as the
// applicant's edit. It is the site's guess, which the profile corrects.
test("a Workday value the resume parser sets after the page is read is corrected from the profile", async () => {
  const workdayOrigin = atsOrigins[0];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage"><form>
        <div data-automation-id="formField-phoneType" data-fkit-id="phoneNumber--phoneType">
          <label for="phoneNumber--phoneType"><span>Phone Device Type<abbr aria-hidden="true">*</abbr></span></label>
          <button aria-haspopup="listbox" aria-expanded="false" type="button" aria-label="Phone Device Type Select One Required" name="phoneType" id="phoneNumber--phoneType">Select One</button>
        </div>
      </form></main><script>
        const button = document.querySelector('#phoneNumber--phoneType');
        const show = (value) => { button.textContent = value; button.setAttribute('aria-label', 'Phone Device Type ' + value + ' Required'); };
        window.parse = () => show('Landline');
        button.addEventListener('click', () => {
          if (document.querySelector('[data-automation-activepopup]')) return;
          button.setAttribute('aria-expanded', 'true');
          const popup = document.createElement('div');
          popup.setAttribute('data-automation-activepopup', 'true');
          // As TSC's: a listbox of Select One, Landline and Mobile.
          popup.innerHTML = '<ul role="listbox">' + ['Select One', 'Landline', 'Mobile'].map((value) => '<li role="option">' + value + '</li>').join('') + '</ul>';
          for (const leaf of popup.querySelectorAll('[role="option"]'))
            leaf.addEventListener('click', () => {
              show(leaf.textContent);
              button.setAttribute('aria-expanded', 'false');
              popup.remove();
            });
          document.body.append(popup);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/parsed-phone-type`);
  await panel.bringToFront();
  await background(page);
  const tabId = (await panel.evaluate(async () => chrome.tabs.query({}))).find((tab) => tab.url === page.url())!.id!;
  await ui({ type: "TRACK_ITEMS", items: [{ url: page.url(), tabId }] });
  // The page is read as it is tracked, before the parser answers.
  await expect.poll(async () => (await state()).applications.length, { timeout: 15000 }).toBe(1);
  await page.waitForTimeout(2000);
  await page.evaluate(() => (window as any).parse());
  await page.waitForTimeout(2500);
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id, tabId });
  await expect(page.locator("#phoneNumber--phoneType")).toHaveText("Mobile", { timeout: 30_000 });
});

test("a captured collapsed Workday experience section adds only profile rows", async () => {
  const workdayOrigin = atsOrigins[0];
  const work = [
    {
      organization: "Example Labs",
      title: "Software Engineer",
      location: "Tucson, AZ",
      details: "Built TypeScript services.",
      startDate: "2025-05",
      endDate: "",
    },
  ];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, work },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div role="group" aria-labelledby="Work-Experience-section" id="experience-section">
          <h4 id="Work-Experience-section">Work Experience</h4>
          <button type="button" data-automation-id="add-button">Add</button>
        </div>
        <div data-automation-id="formField-linkedInAccount">
          <label for="linkedInAccount">What is your LinkedIn profile URL?</label>
          <input id="linkedInAccount" name="linkedInAccount">
        </div>
      </main><script>
        const section = document.querySelector('#experience-section');
        section.querySelector('[data-automation-id="add-button"]').addEventListener('click', () => {
          const number = section.querySelectorAll('[data-automation-id^="workExperience-"]').length + 1;
          const row = document.createElement('div');
          row.setAttribute('data-automation-id', 'workExperience-' + number);
          row.innerHTML = '<label>Job Title<input data-automation-id="jobTitle"></label><label>Company<input data-automation-id="company"></label><label>Location<input data-automation-id="location"></label><label>Current<input type="checkbox" data-automation-id="currentlyWorkHere"></label><label>Description<textarea data-automation-id="description"></textarea></label><div data-automation-id="formField-startDate"><input aria-label="Month"><input aria-label="Year"></div><div data-automation-id="formField-endDate"><input aria-label="Month"><input aria-label="Year"></div>';
          section.insertBefore(row, section.querySelector('button'));
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/captured-experience`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator('[data-automation-id="company"]')).toHaveValue(
    "Example Labs",
    { timeout: 30_000 },
  );
  await expect(page.locator('[data-automation-id="jobTitle"]')).toHaveValue(
    "Software Engineer",
  );
  await expect(page.locator('[data-automation-id="location"]')).toHaveValue(
    "Tucson, AZ",
  );
  await expect(page.locator('[data-automation-id="description"]')).toHaveValue(
    "Built TypeScript services.",
  );
  await expect(
    page.locator('[data-automation-id="currentlyWorkHere"]'),
  ).toBeChecked();
  await expect(page.locator('[data-automation-id^="workExperience-"]')).toHaveCount(
    1,
  );
  // Ticking it is the fill's own doing, though the browser calls the box's
  // change trusted: no pause for an edit nobody made (Jabil, report c7f05eb5).
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 30_000 }).toMatch(/^(awaiting-user|ready)$/);
  expect((await state()).applications[0].note || "").not.toMatch(/You interacted/);
});

test("the captured Workday Resume/CV input receives the generated resume", async () => {
  const workdayOrigin = atsOrigins[0];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div role="group" aria-labelledby="Resume/CV-section">
          <h4 id="Resume/CV-section">Resume/CV</h4>
          <div data-fkit-id="resumeAttachments--null">
            <div data-automation-id="formField-" data-fkit-id="resumeAttachments--attachments">
              <label id="resume-label"><span>Upload a file (5MB max)<abbr aria-hidden="true">*</abbr></span></label>
              <div data-automation-id="attachments-FileUpload" aria-labelledby="resume-label">
                <div data-automation-id="file-upload-drop-zone">Drop files here</div>
                <input data-automation-id="file-upload-input-ref" type="file" multiple>
              </div>
            </div>
          </div>
        </div>
      </main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/captured-resume`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect
    .poll(
      () =>
        page
          .locator('[data-automation-id="file-upload-input-ref"]')
          .evaluate((input: HTMLInputElement) => input.files?.[0]?.name || ""),
      { timeout: 30_000 },
    )
    .toMatch(/\.pdf$/);
});

test("the captured Workday Skills prompt selects confirmed exact matches", async () => {
  const workdayOrigin = atsOrigins[0];
  const saved = await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, skills: ["TypeScript", "Python"] },
  });
  expect(saved.skills).toEqual(["TypeScript", "Python"]);
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div data-automation-id="formField-skills">
          <label id="skills-label"><span>Skills</span></label>
          <div data-automation-id="multiSelectContainer" aria-labelledby="skills-label">
            <div data-automation-id="multiselectInputContainer"><input placeholder="Search"></div>
          </div>
        </div>
        <div data-automation-id="formField-linkedInAccount">
          <label for="linkedInAccount">What is your LinkedIn profile URL?</label>
          <input id="linkedInAccount" name="linkedInAccount">
        </div>
      </main><script>
        const input = document.querySelector('[placeholder="Search"]');
        const container = document.querySelector('[data-automation-id="multiSelectContainer"]');
        input.addEventListener('input', () => {
          document.querySelector('[data-automation-id="activeListContainer"]')?.remove();
          if (!input.value) return;
          const popup = document.createElement('div');
          popup.setAttribute('data-automation-id', 'activeListContainer');
          popup.setAttribute('data-automation-activepopup', 'true');
          for (const label of [input.value + ' Advanced', input.value]) {
            const leaf = document.createElement('div');
            leaf.setAttribute('data-automation-id', 'promptLeafNode');
            leaf.innerHTML = '<div data-automation-id="promptOption"></div>';
            const option = leaf.firstElementChild;
            option.setAttribute('data-automation-label', label);
            option.textContent = label;
            leaf.addEventListener('click', () => {
              const selected = document.createElement('div');
              selected.setAttribute('data-automation-id', 'selectedItem');
              selected.setAttribute('title', label);
              selected.textContent = label;
              container.insertBefore(selected, container.firstChild);
              input.value = '';
              popup.remove();
            });
            popup.append(leaf);
          }
          document.body.append(popup);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/captured-skills`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator('[data-automation-id="selectedItem"]')).toHaveCount(
    2,
    { timeout: 30_000 },
  );
  await expect(page.locator('[data-automation-id="selectedItem"]')).toHaveText([
    "Python",
    "TypeScript",
  ]);
});

test("the captured Workday LinkedIn field receives the confirmed profile URL", async () => {
  const workdayOrigin = atsOrigins[0];
  const linkedin = "https://www.linkedin.com/in/alex-fixture";
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, linkedin },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div role="group" aria-labelledby="Social-Network-URLs-section">
          <h4 id="Social-Network-URLs-section">Social Network URLs</h4>
          <div data-fkit-id="socialNetworkAccounts--null">
            <div data-automation-id="formField-linkedInAccount" data-fkit-id="socialNetworkAccounts--linkedInAccount">
              <label for="socialNetworkAccounts--linkedInAccount">What is your LinkedIn profile URL?</label>
              <input type="text" id="socialNetworkAccounts--linkedInAccount" name="linkedInAccount">
            </div>
          </div>
        </div>
      </main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/captured-linkedin`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator('[name="linkedInAccount"]')).toHaveValue(linkedin, {
    timeout: 30_000,
  });
});

test("the resume attaches to a Workday uploader labelled only by its section", async () => {
  const workdayOrigin = atsOrigins[0];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowMyExpPage">
        <div role="group" aria-labelledby="Resume/CV-section" data-fkit-id="resumeAttachments--null">
          <label id="Resume/CV-section">Resume/CV</label>
          <div><div>
            <button type="button" data-automation-id="select-files" id="resumeAttachments--attachments">Select files</button>
            <input data-automation-id="file-upload-input-ref" type="file" multiple>
          </div></div>
        </div>
      </main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/resume-area`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect
    .poll(
      async () =>
        page
          .locator('input[type="file"]')
          .evaluate((input: HTMLInputElement) => input.files?.[0]?.name || ""),
      { timeout: 30_000 },
    )
    .toMatch(/\.(pdf|docx)$/i);
});

test("Workday search prompts type to filter and pick the match", async () => {
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      education: [
        {
          organization: "Michigan State University",
          title: "Master of Science",
          fieldOfStudy: "Data Science",
          startDate: "2024-08",
          endDate: "2026-05",
          location: "East Lansing, MI",
          details: "",
        },
      ],
    },
  });
  // Workday's prompt filters from key events only, and a typed value that is
  // never picked from the list counts as empty.
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowMyExpPage">
        <div id="typed"></div>
        <div data-automation-id="education-1" role="group">
          <div data-automation-id="formField-school">
            <label for="education-1--school">School or University</label>
            <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
              <div data-automation-id="multiselectInputContainer">
                <input id="education-1--school" data-automation-id="school" placeholder="Search" data-uxi-widget-type="selectinput">
                <div data-automation-id="selectedItem"></div>
              </div>
            </div>
          </div>
        </div>
      </main><script>
        const schools = ${JSON.stringify(realSchools)};
        const input = document.getElementById('education-1--school');
        let typed = '';
        input.addEventListener('keydown', (event) => {
          if (event.key.length !== 1) return;
          typed += event.key;
          document.getElementById('typed').textContent = typed;
          document.querySelector('[data-automation-activepopup="true"]')?.remove();
          const popup = document.createElement('div');
          popup.setAttribute('data-automation-activepopup', 'true');
          for (const name of schools.filter((s) => s.toLowerCase().includes(typed.toLowerCase()))) {
            const leaf = document.createElement('div');
            leaf.setAttribute('data-automation-id', 'promptLeafNode');
            leaf.innerHTML = '<div data-automation-id="promptOption"></div>';
            const option = leaf.firstElementChild;
            option.setAttribute('data-automation-label', name);
            option.textContent = name;
            leaf.addEventListener('click', () => {
              document.querySelector('[data-automation-id="selectedItem"]').textContent = name;
              popup.remove();
            });
            popup.append(leaf);
          }
          document.body.append(popup);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/school-prompt`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator('[data-automation-id="selectedItem"]')).toHaveText(
    "Michigan State University",
    { timeout: 30_000 },
  );
});

// Jabil's Workday lists 325 fields of study and none is "Data Science"
// (report 8c0659ee, 2026-10-16). Its list and its search are taken from that
// report's recorded traffic: a search returns the entries containing the
// term, and text left in the box without a pick is cleared when it loses
// focus. With none of the profile's wordings listed, the closest computing
// field is picked and the fill says so.
test("a Workday field of study missing from the site's list takes the closest computing field, with a caution", async () => {
  test.setTimeout(150_000);
  const workdayOrigin = atsOrigins[0];
  const fields: string[] = JSON.parse(await readFile(join("tests", "browser", "workday-jabil-fields-of-study.json"), "utf8"));
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      education: [
        {
          organization: "Michigan State University",
          title: "Masters of Science",
          fieldOfStudy: "M.S. Data Science, Statistics & Engineering (Applied Systems)",
          startDate: "2025-08",
          endDate: "2027-05",
          location: "East Lansing, MI",
          details: "",
        },
      ],
    },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowMyExpPage">
        <div id="searches"></div>
        <div data-automation-id="education-1" role="group">
          <div data-automation-id="formField-fieldOfStudy">
            <label for="education-1--fieldOfStudy">Field of Study</label>
            <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
              <div data-automation-id="multiselectInputContainer">
                <input id="education-1--fieldOfStudy" data-automation-id="fieldOfStudy" placeholder="Search" data-uxi-widget-type="selectinput">
              </div>
            </div>
          </div>
        </div>
      </main><script>
        const fields = ${JSON.stringify(fields)};
        const input = document.getElementById('education-1--fieldOfStudy');
        const container = input.closest('[data-automation-id="multiSelectContainer"]');
        let typed = '';
        const search = () => {
          document.querySelector('[data-automation-activepopup="true"]')?.remove();
          if (!typed) return;
          document.getElementById('searches').textContent += typed + ';';
          const popup = document.createElement('div');
          popup.setAttribute('data-automation-activepopup', 'true');
          popup.setAttribute('data-automation-id', 'activeListContainer');
          for (const name of fields.filter((f) => f.toLowerCase().includes(typed.toLowerCase()))) {
            const leaf = document.createElement('div');
            leaf.setAttribute('data-automation-id', 'promptLeafNode');
            leaf.innerHTML = '<div data-automation-id="promptOption"></div>';
            const option = leaf.firstElementChild;
            option.setAttribute('data-automation-label', name);
            option.textContent = name;
            leaf.addEventListener('click', () => {
              const selected = document.createElement('div');
              selected.setAttribute('data-automation-id', 'selectedItem');
              selected.setAttribute('title', name);
              selected.textContent = name;
              container.insertBefore(selected, container.firstChild);
              input.value = '';
              typed = '';
              popup.remove();
            });
            popup.append(leaf);
          }
          document.body.append(popup);
        };
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') return search();
          if (event.key === 'Backspace') typed = typed.slice(0, -1);
          else if (event.key.length === 1) typed += event.key;
          search();
        });
        input.addEventListener('input', () => { typed = input.value; search(); });
        // Workday keeps only picks: text left in the box is dropped.
        input.addEventListener('blur', () => setTimeout(() => { input.value = ''; typed = ''; }, 50));
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/field-of-study-missing`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator('[data-automation-id="selectedItem"]')).toHaveText(
    ["Computer and Information Science"],
    { timeout: 60_000 },
  );
  // The pick is the closest, not the applicant's own wording: the fill says so.
  await expect
    .poll(async () => JSON.stringify((await state()).applications.at(-1)?.missing || []), { timeout: 30_000 })
    .toMatch(/closest|Data Science/i);
  // With the pick made, the profile's own wording is not typed into the
  // search box after it: the box read empty, so the field went on to the
  // profile matching that runs after the site rules, which typed it there.
  await page.waitForTimeout(5000);
  expect(await page.locator("#searches").textContent()).not.toContain("M.S. Data Science");
});

// GE Vernova's Workday picks the phone code itself once the country is set
// (capture 31cb0003, 2026-10-16): the pick is a chip beside an empty search
// box, and the card said "Required: Country / Territory Phone Code".
test("a Workday phone code the site picked is reported as answered, not as a required field left empty", async () => {
  const workdayOrigin = atsOrigins[0];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowMyInfoPage">
        <div data-automation-id="formField-countryPhoneCode">
          <label for="phoneNumber--countryPhoneCode"><span>Country / Territory Phone Code<abbr>*</abbr></span></label>
          <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
            <div data-automation-id="multiselectInputContainer">
              <input id="phoneNumber--countryPhoneCode" placeholder="Search" aria-required="true" data-uxi-widget-type="selectinput">
              <div data-automation-id="promptAriaInstruction">1 item selected, United States of America (+1)</div>
            </div>
            <ul role="listbox" data-automation-id="selectedItemList"><li><div role="option" data-automation-id="selectedItem" title="United States of America (+1)">
              <p data-automation-id="promptOption" data-automation-label="United States of America (+1)">United States of America (+1)</p>
            </div></li></ul>
          </div>
        </div>
      </main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/phone-code-picked`);
  const observation = (await content(page, { type: "INSPECT" })).data;
  expect(observation.fields.find((field: { label: string }) => /phone code/i.test(field.label))).toMatchObject({
    value: "United States of America (+1)",
    required: true,
  });
});

// The same page with Workday's list endpoint answering (values/educations/
// fieldsOfStudy, as its rule's optionsSource names it).
// RTX's Workday (report 9b6ea678, 2026-11-02): Enter on the search chose
// its one match, "Data Science"; the fill did not count that as its pick,
// cleared it with the pill's delete charm, and went on to Computer Science.
test("a Workday field of study chosen by the search's own Enter is kept", async () => {
  const workdayOrigin = atsOrigins[0];
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, education: [{ organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-05", location: "East Lansing, MI", details: "" }] } });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowMyExpPage">
        <div data-automation-id="education-1" role="group"><div data-automation-id="formField-fieldOfStudy">
          <label for="education-1--fieldOfStudy">Field of Study</label>
          <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect"><div data-automation-id="multiselectInputContainer">
            <input id="education-1--fieldOfStudy" placeholder="Search" data-uxi-widget-type="selectinput"></div></div></div></div>
      </main><script>
        const fields = ["Data Science", "Computer Science", "Computer and Information Science"];
        const input = document.getElementById('education-1--fieldOfStudy');
        const container = input.closest('[data-automation-id="multiSelectContainer"]');
        const pick = (name) => {
          const selected = document.createElement('div');
          selected.setAttribute('data-automation-id', 'selectedItem');
          selected.setAttribute('role', 'option');
          selected.innerHTML = '<span>' + name + '</span><div data-automation-id="DELETE_charm" role="presentation"></div>';
          selected.querySelector('[role="presentation"]').addEventListener('click', () => selected.remove());
          container.insertBefore(selected, container.firstChild);
          input.value = '';
          document.querySelector('[data-automation-activepopup="true"]')?.remove();
        };
        const search = () => {
          document.querySelector('[data-automation-activepopup="true"]')?.remove();
          const typed = input.value;
          if (!typed) return [];
          const found = fields.filter((f) => f.toLowerCase().includes(typed.toLowerCase()));
          const popup = document.createElement('div');
          popup.setAttribute('data-automation-activepopup', 'true');
          popup.innerHTML = '<ul role="listbox">' + found.map((name) => '<li role="option" data-automation-id="promptLeafNode">' + name + '</li>').join('') + '</ul>';
          document.body.append(popup);
          return found;
        };
        // Enter chooses the one match at once, as Workday's does.
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { const found = search(); if (found.length === 1) pick(found[0]); } });
        input.addEventListener('input', search);
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/field-of-study-enter`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications.at(-1)?.status, { timeout: 60_000 }).toMatch(/ready|awaiting-user/);
  await expect(page.locator('[data-automation-id="selectedItem"]')).toHaveText(["Data Science"]);
});

// KLA's Workday (report daf095e5, 2026-11-03): its field of study opens on
// folders ("Partial List (First 500 Entries)", "All") and searches only when a
// real Enter reaches the focused box. Synthetic keys set the text and nothing
// was searched; real keys blurred the box before the Enter. Answered, the
// site moves focus into its results and the box's real change event fires:
// that is not the applicant's edit (it paused the fill).
test("a Workday field of study that searches only on a real Enter in the focused box is found and picked", async () => {
  const workdayOrigin = atsOrigins[0];
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, education: [{ organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-05", location: "East Lansing, MI", details: "" }] } });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowMyExpPage">
        <div data-automation-id="education-1" role="group"><div data-automation-id="formField-fieldOfStudy">
          <label for="education-1--fieldOfStudy">Field of Study</label>
          <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect"><div data-automation-id="multiselectInputContainer">
            <input id="education-1--fieldOfStudy" placeholder="Search" data-uxi-widget-type="selectinput"></div></div></div></div>
      </main><script>
        const fields = ["Data Science", "Data Science and Engineering", "Computer Science", "Computer and Information Science", "Statistics"];
        const input = document.getElementById('education-1--fieldOfStudy');
        const container = input.closest('[data-automation-id="multiSelectContainer"]');
        const popup = (rows) => {
          document.querySelector('[data-automation-activepopup="true"]')?.remove();
          const box = document.createElement('div');
          box.setAttribute('data-automation-activepopup', 'true');
          box.innerHTML = '<div role="listbox" tabindex="-1">' + rows + '</div>';
          document.body.append(box);
          return box;
        };
        const folders = () => popup('<div data-automation-id="promptOption" data-uxi-multiselectlistitem-type="folder">Partial List (First 500 Entries)</div><div data-automation-id="promptOption" data-uxi-multiselectlistitem-type="folder">All</div>');
        input.addEventListener('focus', folders);
        input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) document.querySelector('[data-automation-activepopup="true"]')?.remove(); }, 50));
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || !event.isTrusted || document.activeElement !== input) return;
          // Workday keeps the Enter, so the box's change waits for its blur.
          event.preventDefault();
          const typed = input.value.toLowerCase();
          // Answered from the network a moment later; focus then goes into the
          // results, and the box's own change event (a real one) fires as it
          // leaves, as KLA's does.
          setTimeout(() => {
            const found = fields.filter((f) => f.toLowerCase().includes(typed));
            // Each result as KLA draws it: a menu item named with its state
            // ("Data Science not checked"), holding a hidden radio and the name.
            const box = popup(found.map((name, n) => '<div id="menuItem-' + n + '" data-automation-id="menuItem" tabindex="-1" role="option" aria-label="' + name + ' not checked" aria-selected="false"><div data-automation-id="promptLeafNode" tabindex="-1" data-automation-checked="Not Checked"><div><input id="radio-' + n + '" type="radio" aria-checked="false" data-automation-id="radioBtn" tabindex="-1"><span></span></div><div id="promptOption-' + n + '" data-automation-id="promptOption" data-automation-label="' + name + '">' + name + '</div></div></div>').join(''));
            const list = box.querySelector('[role="listbox"]');
            list.setAttribute('data-automation-id', 'activeListContainer');
            list.focus();
            // Workday's handler is on the item inside the row, and the pick is
            // added a moment later.
            for (const option of box.querySelectorAll('[data-automation-id="promptLeafNode"]'))
              option.addEventListener('click', () => setTimeout(() => {
                const selected = document.createElement('div');
                selected.setAttribute('data-automation-id', 'selectedItem');
                selected.setAttribute('role', 'option');
                selected.innerHTML = '<span>' + option.textContent + '</span><div data-automation-id="DELETE_charm" role="presentation"></div>';
                selected.querySelector('[role="presentation"]').addEventListener('click', () => selected.remove());
                container.insertBefore(selected, container.firstChild);
                input.value = '';
                box.remove();
              }, 200));
          }, 300);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/field-of-study-folders`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications.at(-1)?.status, { timeout: 60_000 }).toMatch(/ready|awaiting-user/);
  await expect(page.locator('[data-automation-id="selectedItem"]')).toHaveText(["Data Science"]);
});

// Sonos's Workday (report 2664c069, 2026-11-04): each skill was typed and
// its search never ran (real keys, then the box blurred before Enter), so
// each waited five seconds for nothing, and the Websites after them were
// never reached before the applicant gave up.
test("Workday skills searched only on a real Enter in the focused box are each picked", async () => {
  test.setTimeout(120_000);
  const workdayOrigin = atsOrigins[0];
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, skills: ["Python", "SQL", "PyTorch", "C++", "NumPy", "C#", "Dart"] } });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowMyExpPage" id="mainContent">
        <div role="group" aria-labelledby="Skills-section"><h4 id="Skills-section">Skills</h4>
          <div data-automation-id="formField-skills"><label for="skills--skills">Type to Add Skills</label>
            <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect"><div data-automation-id="multiselectInputContainer">
              <input id="skills--skills" placeholder="Search" data-uxi-widget-type="selectinput"></div></div></div></div>
      </main><script>
        // NVIDIA's lists "numpy" in lower case, and "C++" is typed as real keys
          // like the rest (2026-11-04).
          // Axiom Space's library names "C#" and "SQL" its own way (2026-11-04).
          const known = ["Python", "Python (Programming Language)", "Structured Query Language (SQL)", "SQL Design", "PyTorch", "Pytorch Lightning", "C++", "numpy", "Python Numpy", "C Sharp (Programming Language)", "Unity C#", "Dart"];
          const searchFor = { "c#": "c sharp" };
        const input = document.getElementById('skills--skills');
        const container = input.closest('[data-automation-id="multiSelectContainer"]');
        // A press on the page closes the results, as Workday's does.
        document.getElementById('mainContent').addEventListener('mousedown', (event) => {
          if (!event.target.closest('[data-automation-id="multiSelectContainer"]')) document.querySelector('[data-automation-activepopup="true"]')?.remove();
        });
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || !event.isTrusted || document.activeElement !== input) return;
          event.preventDefault();
          const typed = input.value.toLowerCase();
          // Sonos's search answers after a second or more, the last search's
          // results showing until then in the list the box names.
          setTimeout(() => {
            document.querySelector('[data-automation-activepopup="true"]')?.remove();
            const box = document.createElement('div');
            box.setAttribute('data-automation-activepopup', 'true');
            input.setAttribute('aria-expanded', 'true');
            input.setAttribute('aria-controls', 'skill-results');
            box.innerHTML = '<div id="skill-results" role="listbox" data-automation-id="activeListContainer" tabindex="-1">' + known.filter((name) => name.toLowerCase().includes(typed) || name.toLowerCase().includes(searchFor[typed] || typed)).map((name, n) => '<div id="menuItem-' + n + '" role="option" aria-label="' + name + ' not checked"><div data-automation-id="promptLeafNode"><input type="radio" tabindex="-1"><div data-automation-id="promptOption">' + name + '</div></div></div>').join('') + '</div>';
            document.body.append(box);
            box.querySelector('[role="listbox"]').focus();
            // Axiom Space's: one match is added at once, and a click on an
            // entry already added takes it off again.
            const toggle = (name) => {
              const existing = [...container.querySelectorAll('[data-automation-id="selectedItem"]')].find((item) => item.textContent === name);
              if (existing) return existing.remove();
              const selected = document.createElement('div');
              selected.setAttribute('data-automation-id', 'selectedItem');
              selected.textContent = name;
              container.insertBefore(selected, container.firstChild);
            };
            const leaves = box.querySelectorAll('[data-automation-id="promptLeafNode"]');
            if (leaves.length === 1) toggle(leaves[0].textContent);
            for (const leaf of leaves)
              leaf.addEventListener('click', () => setTimeout(() => toggle(leaf.textContent), 150));
          }, 1600);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/skills-search`);
  await panel.bringToFront();
  await background(page);
  const started = Date.now();
  await enqueue([page]);
  await expect(page.locator('[data-automation-id="selectedItem"]')).toHaveCount(7, { timeout: 60_000 });
  expect((await page.locator('[data-automation-id="selectedItem"]').allTextContents()).sort()).toEqual(["C Sharp (Programming Language)", "C++", "Dart", "PyTorch", "Python", "Structured Query Language (SQL)", "numpy"]);
  // Nor is the last search's list left open over the form (Axiom Space, its
  // last skill picked by the search itself, 2026-11-04).
  await expect(page.locator('[data-automation-activepopup="true"]')).toHaveCount(0);
  expect(Date.now() - started).toBeLessThan(40_000);
});

// NVIDIA's Workday (report 7aa68732, 2026-11-04): its search for "Computer
// Science" answered five fields, but the list drew only the two rows in view,
// and "Computer Science", third, was never on the page: the closest field
// drawn was picked instead.
test("a Workday field of study further down a list that draws only the rows in view is still picked", async () => {
  const workdayOrigin = atsOrigins[0];
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, education: [{ organization: "Virginia Tech", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "Blacksburg, VA", details: "" }] } });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowMyExpPage">
        <div data-automation-id="education-1" role="group"><div data-automation-id="formField-fieldOfStudy">
          <label for="education-1--fieldOfStudy">Field of Study</label>
          <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect"><div data-automation-id="multiselectInputContainer">
            <input id="education-1--fieldOfStudy" placeholder="Search" data-uxi-widget-type="selectinput"></div></div></div></div>
      </main><script>
        const results = ["Computational Science & Engineering", "Computer & Info Science", "Computer Science", "Computer Science & Engin.", "Electrical Engineering and Computer Science"];
        const input = document.getElementById('education-1--fieldOfStudy');
        const container = input.closest('[data-automation-id="multiSelectContainer"]');
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || !event.isTrusted) return;
          event.preventDefault();
          setTimeout(() => {
            document.querySelector('[data-automation-activepopup="true"]')?.remove();
            const box = document.createElement('div');
            box.setAttribute('data-automation-activepopup', 'true');
            // Two rows of 32px in view, drawn again as the list scrolls.
            box.innerHTML = '<div role="listbox" data-automation-id="activeListContainer" class="ReactVirtualized__Grid ReactVirtualized__List" style="height: 64px; overflow: auto; position: relative"><div class="inner" style="height: ' + results.length * 32 + 'px; position: relative"></div></div>';
            document.body.append(box);
            const grid = box.firstElementChild;
            const inner = grid.firstElementChild;
            const draw = () => {
              const first = Math.floor(grid.scrollTop / 32);
              inner.innerHTML = results.slice(first, first + 2).map((name, n) => '<div role="option" style="position: absolute; top: ' + (first + n) * 32 + 'px; height: 32px" aria-label="' + name + ' not checked"><div data-automation-id="promptLeafNode"><div data-automation-id="promptOption">' + name + '</div></div></div>').join('');
              for (const leaf of inner.querySelectorAll('[data-automation-id="promptLeafNode"]'))
                leaf.addEventListener('click', () => {
                  const selected = document.createElement('div');
                  selected.setAttribute('data-automation-id', 'selectedItem');
                  selected.textContent = leaf.textContent;
                  container.insertBefore(selected, container.firstChild);
                  input.value = '';
                  box.remove();
                });
            };
            grid.addEventListener('scroll', draw);
            draw();
          }, 300);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/field-of-study-virtual-list`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator('[data-automation-id="selectedItem"]')).toHaveText(["Computer Science"], { timeout: 60_000 });
});

// Axiom Space's Workday (2026-11-04): the school was typed, the box lost
// focus before its Enter, and the search never ran; every wording waited out
// its five seconds and the school was left unpicked.
test("a Workday school searched only on a real Enter in the focused box is picked", async () => {
  const workdayOrigin = atsOrigins[0];
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, education: [{ organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-05", location: "East Lansing, MI", details: "" }] } });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowMyExpPage">
        <div data-automation-id="education-1" role="group"><div data-automation-id="formField-school">
          <label for="education-1--school">School or University</label>
          <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect"><div data-automation-id="multiselectInputContainer">
            <input id="education-1--school" placeholder="Search" data-uxi-widget-type="selectinput"></div></div></div></div>
      </main><script>
        const schools = ["Michigan State University", "Michigan State University College of Law", "Michigan Technological University"];
        const input = document.getElementById('education-1--school');
        const container = input.closest('[data-automation-id="multiSelectContainer"]');
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || !event.isTrusted || document.activeElement !== input) return;
          event.preventDefault();
          const typed = input.value.toLowerCase();
          setTimeout(() => {
            document.querySelector('[data-automation-activepopup="true"]')?.remove();
            const box = document.createElement('div');
            box.setAttribute('data-automation-activepopup', 'true');
            box.innerHTML = '<div role="listbox" data-automation-id="activeListContainer" tabindex="-1">' + schools.filter((name) => name.toLowerCase().includes(typed)).map((name) => '<div role="option" aria-label="' + name + ' not checked"><div data-automation-id="promptLeafNode"><div data-automation-id="promptOption">' + name + '</div></div></div>').join('') + '</div>';
            document.body.append(box);
            box.querySelector('[role="listbox"]').focus();
            for (const leaf of box.querySelectorAll('[data-automation-id="promptLeafNode"]'))
              leaf.addEventListener('click', () => setTimeout(() => {
                const selected = document.createElement('div');
                selected.setAttribute('data-automation-id', 'selectedItem');
                selected.textContent = leaf.textContent;
                container.insertBefore(selected, container.firstChild);
                input.value = '';
                box.remove();
              }, 150));
          }, 400);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/school-search`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator('[data-automation-id="selectedItem"]')).toHaveText(["Michigan State University"], { timeout: 60_000 });
});

test("a Workday field of study the site's own list lacks goes straight to the closest field it lists", async () => {
  test.setTimeout(150_000);
  const workdayOrigin = atsOrigins[0];
  const fields: string[] = JSON.parse(await readFile(join("tests", "browser", "workday-jabil-fields-of-study.json"), "utf8"));
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      education: [
        {
          organization: "Michigan State University",
          title: "Masters of Science",
          fieldOfStudy: "M.S. Data Science, Statistics & Engineering (Applied Systems)",
          startDate: "2025-08",
          endDate: "2027-05",
          location: "East Lansing, MI",
          details: "",
        },
      ],
    },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowMyExpPage">
        <div id="searches"></div>
        <div data-automation-id="education-1" role="group">
          <div data-automation-id="formField-fieldOfStudy">
            <label for="education-1--fieldOfStudy">Field of Study</label>
            <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
              <div data-automation-id="multiselectInputContainer">
                <input id="education-1--fieldOfStudy" data-automation-id="fieldOfStudy" placeholder="Search" data-uxi-widget-type="selectinput">
              </div>
            </div>
          </div>
        </div>
      </main><script>
        const fields = ${JSON.stringify(fields)};
        const input = document.getElementById('education-1--fieldOfStudy');
        const container = input.closest('[data-automation-id="multiSelectContainer"]');
        let typed = '';
        const search = () => {
          document.querySelector('[data-automation-activepopup="true"]')?.remove();
          if (!typed) return;
          document.getElementById('searches').textContent += typed + ';';
          const popup = document.createElement('div');
          popup.setAttribute('data-automation-activepopup', 'true');
          popup.setAttribute('data-automation-id', 'activeListContainer');
          for (const name of fields.filter((f) => f.toLowerCase().includes(typed.toLowerCase()))) {
            const leaf = document.createElement('div');
            leaf.setAttribute('data-automation-id', 'promptLeafNode');
            leaf.innerHTML = '<div data-automation-id="promptOption"></div>';
            const option = leaf.firstElementChild;
            option.setAttribute('data-automation-label', name);
            option.textContent = name;
            leaf.addEventListener('click', () => {
              const selected = document.createElement('div');
              selected.setAttribute('data-automation-id', 'selectedItem');
              selected.setAttribute('title', name);
              selected.textContent = name;
              container.insertBefore(selected, container.firstChild);
              input.value = '';
              typed = '';
              popup.remove();
            });
            popup.append(leaf);
          }
          document.body.append(popup);
        };
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') return search();
          if (event.key === 'Backspace') typed = typed.slice(0, -1);
          else if (event.key.length === 1) typed += event.key;
          search();
        });
        input.addEventListener('input', () => { typed = input.value; search(); });
        // Workday keeps only picks: text left in the box is dropped.
        input.addEventListener('blur', () => setTimeout(() => { input.value = ''; typed = ''; }, 50));
      </script>`,
    }),
  );
  // The list the page reads its answers from, as Workday serves it.
  let listed = 0;
  await context.route(`${workdayOrigin}/wday/calypso/cxs/jobapplication/*/values/educations/fieldsOfStudy`, (route) => {
    listed++;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(fields.map((descriptor, id) => ({ id: String(id), descriptor }))) });
  });
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/field-of-study-listed`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator('[data-automation-id="selectedItem"]')).toHaveText(
    ["Computer and Information Science"],
    { timeout: 60_000 },
  );
  // The pick is the closest, not the applicant's own wording: the fill says so.
  await expect
    .poll(async () => JSON.stringify((await state()).applications.at(-1)?.missing || []), { timeout: 30_000 })
    .toMatch(/closest|Data Science/i);
  // Read from the list, no wording it lacks was searched for before the pick
  // (each empty search costs Workday about 20 s).
  expect(listed).toBe(1);
  const searches = (await page.locator("#searches").textContent()) || "";
  expect(searches.slice(0, searches.indexOf("Computer and Information Science"))).not.toMatch(/Data Sc|^M/);
});

// Jabil's Workday searches skills only when Enter is pressed ("press Enter to
// search for the skill"), and lists a skill with its kind: "Python
// (Programming Language)" before a bare "python" (report 35dd4837's recorded
// search, 2026-10-16). Typing alone found nothing, so no skill was ever added.
// A skill the site does not list must not stop the ones after it.
test("Workday skills are searched with Enter and take the site's named entry", async () => {
  test.setTimeout(150_000);
  const workdayOrigin = atsOrigins[0];
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, skills: ["Plastic SCM", "Python"] } });
  const recorded = ["Python (Programming Language)", "Python IDLE", "Python Software Development", "Maya Python", "Python Frameworks", "Python Numpy", "Programming Languages", "PHP (Scripting Language)", "Pandas Python Library", "python"];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowMyExpPage">
        <div data-automation-id="formField-skills">
          <label for="skills--skills"><span>Type to Add Skills<abbr>*</abbr></span></label>
          <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
            <div data-automation-id="multiselectInputContainer"><input id="skills--skills" placeholder="Search" aria-required="true" data-uxi-widget-type="selectinput"></div>
          </div>
        </div>
      </main><script>
        const recorded = ${JSON.stringify(recorded)};
        const input = document.getElementById('skills--skills');
        const container = input.closest('[data-automation-id="multiSelectContainer"]');
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') return document.querySelector('[data-automation-activepopup="true"]')?.remove();
          if (event.key !== 'Enter') return;
          (window.searches ||= []).push(input.value.trim());
          document.querySelector('[data-automation-activepopup="true"]')?.remove();
          const popup = document.createElement('div');
          popup.setAttribute('data-automation-activepopup', 'true');
          popup.setAttribute('data-automation-id', 'activeListContainer');
          for (const label of input.value.trim().toLowerCase() === 'python' ? recorded : []) {
            const leaf = document.createElement('div');
            leaf.setAttribute('data-automation-id', 'promptLeafNode');
            leaf.innerHTML = '<div data-automation-id="promptOption"></div>';
            leaf.firstElementChild.setAttribute('data-automation-label', label);
            leaf.firstElementChild.textContent = label;
            // A list of checkboxes, as Jabil's is: a picked entry shows
            // checked, and clicking it again takes it off.
            const picked = () => [...container.querySelectorAll('[data-automation-id="selectedItem"]')].find((item) => item.getAttribute('title') === label);
            leaf.setAttribute('data-automation-checked', picked() ? 'Checked' : 'Not Checked');
            leaf.addEventListener('click', () => {
              const existing = picked();
              if (existing) existing.remove();
              else {
                const selected = document.createElement('div');
                selected.setAttribute('data-automation-id', 'selectedItem');
                selected.setAttribute('title', label);
                selected.textContent = label;
                container.insertBefore(selected, container.firstChild);
              }
              leaf.setAttribute('data-automation-checked', picked() ? 'Checked' : 'Not Checked');
            });
            popup.append(leaf);
          }
          document.body.append(popup);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/skills-enter`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator('[data-automation-id="selectedItem"]')).toHaveText(["Python (Programming Language)"], { timeout: 90_000 });
  await expect(page.locator("#skills--skills")).toHaveValue("");
  // A second pass over the step (the fill runs its rules again) used to
  // click each pick again, which takes it off a list of checkboxes.
  const id = (await state()).applications.at(-1)!.id;
  await expect.poll(async () => (await state()).applications.find((app: { id: string }) => app.id === id)?.status, { timeout: 60_000 }).toMatch(/ready|awaiting-user/);
  // The skill the site does not list is named, not dropped in silence.
  expect((await state()).applications.find((app: { id: string }) => app.id === id)?.missing.join("\n")).toMatch(/no "Plastic SCM"/);
  const searched = (await page.evaluate(() => (window as any).searches as string[])).filter((term) => /^python$/i.test(term)).length;
  await ui({ type: "FILL_STEP", id });
  await expect.poll(async () => (await state()).applications.find((app: { id: string }) => app.id === id)?.status, { timeout: 60_000 }).toMatch(/ready|awaiting-user/);
  await page.waitForTimeout(3000);
  await expect(page.locator('[data-automation-id="selectedItem"]')).toHaveText(["Python (Programming Language)"]);
  // Python is already picked: the second fill does not search for it again.
  expect((await page.evaluate(() => (window as any).searches as string[])).filter((term) => /^python$/i.test(term)).length).toBe(searched);
});

// Citi's Workday keeps the skills search results open through a scripted
// Escape and closes them only on a click elsewhere on the page; the rules
// click #mainContent for that. The applicant had answered other questions on
// the page by hand, so the page container read as locked, the click was
// refused, and the last search's results stayed open over the form (report
// aad8b81e, 2026-10-27). The list closes on the press, not the click: of
// the applicant's own closes in the Workday recordings, each was a mousedown
// on the page, and the rules' click alone left a search that matched nothing
// (NumPy) open (Citi, 2026-10-28).
test("Workday skills search results close after a fill on a page with the applicant's own answers", async () => {
  test.setTimeout(150_000);
  const workdayOrigin = atsOrigins[0];
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, skills: [] } });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><div id="mainContent"><main data-automation-id="applyFlowMyExpPage">
        <div data-automation-id="formField-skills">
          <label for="skills--skills"><span>Type to Add Skills</span></label>
          <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
            <div data-automation-id="multiselectInputContainer"><input id="skills--skills" placeholder="Search" data-uxi-widget-type="selectinput"></div>
          </div>
        </div>
        <div data-automation-id="formField-notes"><label for="notes">Anything else we should know?</label><input id="notes" type="text"></div>
      </main></div><script>
        const input = document.getElementById('skills--skills');
        const container = input.closest('[data-automation-id="multiSelectContainer"]');
        const open = () => document.querySelector('[data-automation-activepopup="true"]');
        document.addEventListener('mousedown', (event) => {
          if (open() && !open().contains(event.target)) open().remove();
        });
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          open()?.remove();
          const popup = document.createElement('div');
          popup.setAttribute('data-automation-activepopup', 'true');
          popup.setAttribute('data-automation-id', 'activeListContainer');
          const term = input.value.trim().toLowerCase();
          for (const label of term === 'python' ? ['Python (Programming Language)', 'Python Numpy'] : term === 'numpy' ? ['Numerology', 'Nuxeo'] : []) {
            const leaf = document.createElement('div');
            leaf.setAttribute('data-automation-id', 'promptLeafNode');
            leaf.setAttribute('data-automation-checked', 'Not Checked');
            leaf.innerHTML = '<div data-automation-id="promptOption"></div>';
            leaf.firstElementChild.setAttribute('data-automation-label', label);
            leaf.firstElementChild.textContent = label;
            leaf.addEventListener('click', () => {
              const selected = document.createElement('div');
              selected.setAttribute('data-automation-id', 'selectedItem');
              selected.setAttribute('title', label);
              selected.textContent = label;
              container.insertBefore(selected, container.firstChild);
              leaf.setAttribute('data-automation-checked', 'Checked');
            });
            popup.append(leaf);
          }
          document.body.append(popup);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/skills-close`);
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  await ui({ type: "TRACK_TAB", tabId });
  const id = (await state()).applications.find((app: { tabId?: number }) => app.tabId === tabId)!.id;
  await ui({ type: "FILL_STEP", id, tabId });
  await expect.poll(async () => (await state()).applications.find((app: { id: string }) => app.id === id)?.status, { timeout: 30_000 }).toMatch(/ready|awaiting-user/);
  // The applicant answers a question themselves, then fills again with a skill.
  await page.bringToFront();
  await page.locator("#notes").click();
  await page.keyboard.type("Open to relocation", { delay: 30 });
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  const current = await ui({ type: "API", path: "/v1/profile" });
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...current, skills: ["Python", "NumPy"] } });
  await panel.bringToFront();
  await ui({ type: "FILL_STEP", id, tabId });
  await expect(page.locator('[data-automation-id="selectedItem"]')).toHaveText(["Python (Programming Language)"], { timeout: 60_000 });
  await expect.poll(async () => (await state()).applications.find((app: { id: string }) => app.id === id)?.status, { timeout: 60_000 }).toMatch(/ready|awaiting-user/);
  await expect(page.locator("#notes")).toHaveValue("Open to relocation");
  await expect(page.locator('[data-automation-activepopup="true"]')).toHaveCount(0);
});

// Typing into Workday's skills search to look around (Jabil, 2026-10-16) is
// a search, not an answer: the site drops the text unless something is
// picked. That typing used to lock the field for good, and every later fill
// left Skills empty.
test("typing a search the site discards does not keep a Workday skills box locked", async () => {
  test.setTimeout(150_000);
  const workdayOrigin = atsOrigins[0];
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, skills: [] } });
  const recorded = ["Python (Programming Language)", "Python IDLE", "python"];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowMyExpPage">
        <div data-automation-id="formField-skills">
          <label for="skills--skills"><span>Type to Add Skills<abbr>*</abbr></span></label>
          <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
            <div data-automation-id="multiselectInputContainer"><input id="skills--skills" placeholder="Search" aria-required="true" data-uxi-widget-type="selectinput"></div>
          </div>
        </div>
        <button id="elsewhere">Elsewhere</button>
      </main><script>
        const recorded = ${JSON.stringify(recorded)};
        const input = document.getElementById('skills--skills');
        const container = input.closest('[data-automation-id="multiSelectContainer"]');
        input.addEventListener('blur', () => setTimeout(() => { input.value = ''; }, 50));
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') return document.querySelector('[data-automation-activepopup="true"]')?.remove();
          if (event.key !== 'Enter') return;
          document.querySelector('[data-automation-activepopup="true"]')?.remove();
          const popup = document.createElement('div');
          popup.setAttribute('data-automation-activepopup', 'true');
          for (const label of input.value.trim().toLowerCase() === 'python' ? recorded : []) {
            const leaf = document.createElement('div');
            leaf.setAttribute('data-automation-id', 'promptLeafNode');
            leaf.innerHTML = '<div data-automation-id="promptOption"></div>';
            leaf.firstElementChild.setAttribute('data-automation-label', label);
            leaf.firstElementChild.textContent = label;
            leaf.addEventListener('click', () => {
              const selected = document.createElement('div');
              selected.setAttribute('data-automation-id', 'selectedItem');
              selected.setAttribute('title', label);
              selected.textContent = label;
              container.insertBefore(selected, container.firstChild);
              input.value = '';
              popup.remove();
            });
            popup.append(leaf);
          }
          document.body.append(popup);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/skills-typed-search`);
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  await ui({ type: "TRACK_TAB", tabId });
  const id = (await state()).applications.find((app: { tabId?: number }) => app.tabId === tabId)!.id;
  await ui({ type: "FILL_STEP", id, tabId });
  await expect.poll(async () => (await state()).applications.find((app: { id: string }) => app.id === id)?.status, { timeout: 30_000 }).toMatch(/ready|awaiting-user/);
  // The applicant types a search to see what the site offers, and leaves.
  await page.bringToFront();
  await page.locator("#skills--skills").click();
  await page.keyboard.type("python", { delay: 60 });
  await page.locator("#elsewhere").click();
  await expect(page.locator("#skills--skills")).toHaveValue("");
  await expect.poll(async () => (await state()).applications.find((app: { id: string }) => app.id === id)?.status).toBe("paused");
  // Later, with Python in the profile, on the page loaded again.
  const current = await ui({ type: "API", path: "/v1/profile" });
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...current, skills: ["Python"] } });
  await page.reload();
  await panel.bringToFront();
  await ui({ type: "FILL_STEP", id, tabId });
  await expect(page.locator('[data-automation-id="selectedItem"]')).toHaveText(["Python (Programming Language)"], { timeout: 60_000 });
});

test("Workday self-identification and terms use confirmed answers", async () => {
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      gender: "Male",
      ethnicity: "South Asian",
      veteranStatus: "No",
      acknowledgeTerms: true,
    },
  });
  // TD's Voluntary Disclosures step: standard Workday fields plus an
  // employer-worded terms checkbox.
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowVoluntaryDisclosuresPage">
        <div data-automation-id="formField-gender"><fieldset><legend>Sex:<abbr>*</abbr></legend><button id="personalInfoUS--gender" name="gender" aria-haspopup="listbox" aria-label="Sex: Select One Required">Select One</button></fieldset></div>
        <div data-automation-id="formField-ethnicity"><fieldset><legend>Race/Ethnicity:<abbr>*</abbr></legend><button id="personalInfoUS--ethnicity" name="ethnicity" aria-haspopup="listbox" aria-label="Race/Ethnicity: Select One Required">Select One</button></fieldset></div>
        <div data-automation-id="formField-veteranStatus"><fieldset><legend>Veteran Status:<abbr>*</abbr></legend><button id="personalInfoUS--veteranStatus" name="veteranStatus" aria-haspopup="listbox" aria-label="Veteran Status: Select One Required">Select One</button></fieldset></div>
        <div data-automation-id="formField-acceptTermsAndAgreements"><label for="termsAndConditions--acceptTermsAndAgreements">I willingly accept the Terms and Conditions for submitting an application with TD.</label><input id="termsAndConditions--acceptTermsAndAgreements" type="checkbox" name="acceptTermsAndAgreements" aria-required="true"></div>
      </main><script>
        const options = {
          'personalInfoUS--gender': ['Male', 'Female', 'I do not wish to self-identify'],
          'personalInfoUS--ethnicity': ['Asian (Not Hispanic or Latino)', 'White (Not Hispanic or Latino)', 'I do not wish to self-identify'],
          'personalInfoUS--veteranStatus': ['I identify as one or more of the classifications of a protected veteran', 'I am not a protected veteran', 'I do not wish to self-identify'],
        };
        for (const button of document.querySelectorAll('button[aria-haspopup="listbox"]')) {
          button.addEventListener('click', () => {
            document.querySelector('[data-automation-activepopup="true"]')?.remove();
            for (const other of document.querySelectorAll('button[aria-haspopup="listbox"]')) other.setAttribute('aria-expanded', 'false');
            button.setAttribute('aria-expanded', 'true');
            const popup = document.createElement('div');
            popup.setAttribute('data-automation-activepopup', 'true');
            for (const label of options[button.id]) {
              const leaf = document.createElement('div');
              leaf.setAttribute('data-automation-id', 'promptLeafNode');
              leaf.innerHTML = '<div data-automation-id="promptOption"></div>';
              const option = leaf.firstElementChild;
              option.setAttribute('data-automation-label', label);
              option.textContent = label;
              leaf.addEventListener('click', () => { button.textContent = label; button.setAttribute('aria-expanded', 'false'); popup.remove(); });
              popup.append(leaf);
            }
            document.body.append(popup);
          });
        }
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/td/job/disclosures`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator("#personalInfoUS--gender")).toHaveText("Male", {
    timeout: 30_000,
  });
  await expect(page.locator("#personalInfoUS--ethnicity")).toHaveText(
    "Asian (Not Hispanic or Latino)",
  );
  await expect(page.locator("#personalInfoUS--veteranStatus")).toHaveText(
    "I am not a protected veteran",
  );
  await expect(
    page.locator("#termsAndConditions--acceptTermsAndAgreements"),
  ).toBeChecked();
});

test("Workday questionnaire dropdowns answer standard questions by their wording", async () => {
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      workAuthorization: "Yes",
      sponsorship: "No",
      age18OrOlder: "Yes",
      priorEmployment: "No",
    },
  });
  // The real TD markup: the question lives in the field container's legend and
  // the control's accessible name is only "Select One".
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowPrimaryQuestionsPage"><div data-automation-id="formField-age" data-fkit-id="primaryQuestionnaire--age"><fieldset><legend><div class="rich-label"><div data-automation-id="richText"><p><span>A requirement of this position is to have reached the federal age of majority, which is 18 years old. Do you meet this requirement?</span></p></div></div><abbr>*</abbr></legend><button id="q-age" name="age" aria-haspopup="listbox" aria-label=" Select One Required">Select One</button></fieldset></div><div data-automation-id="formField-auth" data-fkit-id="primaryQuestionnaire--auth"><fieldset><legend><div class="rich-label"><div data-automation-id="richText"><p><span>Are you currently authorized to work in the United States?</span></p></div></div><abbr>*</abbr></legend><button id="q-auth" name="auth" aria-haspopup="listbox" aria-label=" Select One Required">Select One</button></fieldset></div><div data-automation-id="formField-spons" data-fkit-id="primaryQuestionnaire--spons"><fieldset><legend><div class="rich-label"><div data-automation-id="richText"><p><span>Will you now, or in the future, require sponsorship for United States employment visa status (e.g. H1-B visa status)?</span></p></div></div><abbr>*</abbr></legend><button id="q-spons" name="spons" aria-haspopup="listbox" aria-label=" Select One Required">Select One</button></fieldset></div><div data-automation-id="formField-employed" data-fkit-id="primaryQuestionnaire--employed"><fieldset><legend><div class="rich-label"><div data-automation-id="richText"><p><span>Do you currently work for TD or any of its affiliates?</span></p></div></div><abbr>*</abbr></legend><button id="q-employed" name="employed" aria-haspopup="listbox" aria-label=" Select One Required">Select One</button></fieldset></div><div data-automation-id="formField-relatives" data-fkit-id="primaryQuestionnaire--relatives"><fieldset><legend><div class="rich-label"><div data-automation-id="richText"><p><span>Do you have any relatives or people you share a financial or close personal relationship with, who work at TD Bank or any of its affiliates?</span></p></div></div><abbr>*</abbr></legend><button id="q-relatives" name="relatives" aria-haspopup="listbox" aria-label=" Select One Required">Select One</button></fieldset></div></main><script>
        for (const button of document.querySelectorAll('button[aria-haspopup="listbox"]')) {
          button.addEventListener('click', () => {
            document.querySelector('[data-automation-activepopup="true"]')?.remove();
            for (const other of document.querySelectorAll('button[aria-haspopup="listbox"]')) other.setAttribute('aria-expanded', 'false');
            button.setAttribute('aria-expanded', 'true');
            const popup = document.createElement('div');
            popup.setAttribute('data-automation-activepopup', 'true');
            for (const label of ['Yes', 'No']) {
              const leaf = document.createElement('div');
              leaf.setAttribute('data-automation-id', 'promptLeafNode');
              leaf.innerHTML = '<div data-automation-id="promptOption"></div>';
              const option = leaf.firstElementChild;
              option.setAttribute('data-automation-label', label);
              option.textContent = label;
              leaf.addEventListener('click', () => {
                button.textContent = label;
                button.setAttribute('aria-expanded', 'false');
                popup.remove();
              });
              popup.append(leaf);
            }
            document.body.append(popup);
          });
        }
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/td/job/questionnaire`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator("#q-age")).toHaveText("Yes", { timeout: 30_000 });
  await expect(page.locator("#q-auth")).toHaveText("Yes");
  await expect(page.locator("#q-spons")).toHaveText("No");
  await expect(page.locator("#q-employed")).toHaveText("No");
  // Employer-specific questions stay with the applicant, listed as required:
  // the legend's asterisk and the button's "Required" say so (KLA's OPT
  // questions were listed as optional, 2026-11-04).
  await expect(page.locator("#q-relatives")).toHaveText("Select One");
  await expect.poll(async () => (await state()).applications.at(-1)?.status, { timeout: 30_000 }).toMatch(/ready|awaiting-user/);
  const missing = (await state()).applications.at(-1)!.missing;
  expect(missing.some((item) => /^Required: Do you have any relatives/.test(item))).toBe(true);
  expect(missing.filter((item) => /^Optional unanswered:/.test(item))).toEqual([]);
});

test("captured Workday questions fill only confirmed standard answers", async () => {
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      workAuthorization: "Yes",
      sponsorship: "No",
      age18OrOlder: "Yes",
      willingToRelocate: "Yes",
      priorEmployment: "None",
    },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div data-automation-id="formField-age"><fieldset><legend>Are you over the age of 18?<abbr>*</abbr></legend><button id="age" aria-haspopup="listbox" aria-label=" Select One Required">Select One</button></fieldset></div>
        <div data-automation-id="formField-work-auth"><fieldset><legend>Are you legally authorized to work in the United States?<abbr>*</abbr></legend><button id="work-auth" aria-haspopup="listbox" aria-label=" Select One Required">Select One</button></fieldset></div>
        <div data-automation-id="formField-sponsorship"><fieldset><legend>Will you now or in the future require the company's sponsorship for an immigration-related employment benefit?<abbr>*</abbr></legend><button id="sponsorship" aria-haspopup="listbox" aria-label=" Select One Required">Select One</button></fieldset></div>
        <div data-automation-id="formField-relocation"><fieldset><legend>Are you willing to relocate?<abbr>*</abbr></legend><button id="relocation" aria-haspopup="listbox" aria-label=" Select One Required">Select One</button></fieldset></div>
        <div data-automation-id="formField-prior-employment"><fieldset><legend>Are you currently or formerly employed by a General Dynamics company?<abbr>*</abbr></legend><button id="prior-employment" aria-haspopup="listbox" aria-label=" Select One Required">Select One</button></fieldset></div>
        <div data-automation-id="formField-custom"><fieldset><legend>Do you hold this employer's project-specific certification?<abbr>*</abbr></legend><button id="custom" aria-haspopup="listbox" aria-label=" Select One Required">Select One</button></fieldset></div>
      </main><script>
        for (const button of document.querySelectorAll('button[aria-haspopup="listbox"]')) {
          button.addEventListener('click', () => {
            document.querySelector('[data-automation-id="activeListContainer"]')?.remove();
            button.setAttribute('aria-expanded', 'true');
            const popup = document.createElement('div');
            popup.setAttribute('data-automation-id', 'activeListContainer');
            popup.setAttribute('data-automation-activepopup', 'true');
            for (const label of ['Yes, with conditions', 'Yes', 'No', 'None']) {
              const leaf = document.createElement('div');
              leaf.setAttribute('data-automation-id', 'promptLeafNode');
              leaf.innerHTML = '<div data-automation-id="promptOption"></div>';
              const option = leaf.firstElementChild;
              option.setAttribute('data-automation-label', label);
              option.textContent = label;
              leaf.addEventListener('click', () => {
                button.textContent = label;
                button.setAttribute('aria-label', label + ' Required');
                button.setAttribute('aria-expanded', 'false');
                popup.remove();
              });
              popup.append(leaf);
            }
            document.body.append(popup);
          });
        }
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/captured-questions`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator("#age")).toHaveText("Yes", { timeout: 30_000 });
  await expect(page.locator("#work-auth")).toHaveText("Yes");
  await expect(page.locator("#sponsorship")).toHaveText("No");
  await expect(page.locator("#relocation")).toHaveText("Yes");
  // A saved "None" now means never having worked for a company applied to,
  // which answers a "formerly employed by" question with its plain No.
  await expect(page.locator("#prior-employment")).toHaveText("No");
  await expect(page.locator("#custom")).toHaveText("Select One");
  const labels = (await content(page, { type: "INSPECT" })).data.fields.map(
    (field: { label: string }) => field.label,
  );
  expect(labels).toContain("Are you legally authorized to work in the United States?");
  expect(labels).toContain("Do you hold this employer's project-specific certification?");
  expect(labels).not.toContain("Select One Required");
});

// AmFam's Workday (report 5730ee40): a free-text question is titled only by
// its fieldset's legend, and read as its id the draft refused it as no question.
test("Workday questionnaire text answer is named by its legend", async () => {
  const workdayOrigin = atsOrigins[0];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applyFlowSecondaryQuestionsPage"><div role="group" aria-labelledby="secondaryQuestionnaire-section">
        <div data-automation-id="formField-q1" data-fkit-id="secondaryQuestionnaire--q1"><fieldset><legend><div id="label-q1"><div data-automation-id="richText"><p><span>Which subject do you study?</span></p><p><b>Name the one closest to this role.<abbr title="required">*</abbr></b></p></div></div></legend><div><textarea id="secondaryQuestionnaire--q1" aria-required="true"></textarea></div></fieldset></div>
      </div></main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/secondary-questions`);
  const labels = (await content(page, { type: "INSPECT" })).data.fields.map(
    (field: { label: string }) => field.label,
  );
  expect(labels).toContain("Which subject do you study?Name the one closest to this role.");
  expect(labels).not.toContain("secondaryQuestionnaire--q1");
});

test("captured Workday terms acknowledgement is explicit and narrowly scoped", async () => {
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, acknowledgeTerms: true },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div data-automation-id="formField-firstName"><label for="firstName">First Name</label><input id="firstName" name="firstName"></div>
        <div data-automation-id="formField-lastName"><label for="lastName">Last Name</label><input id="lastName" name="lastName"></div>
        <div data-automation-id="formField-acceptTermsAndAgreements" data-fkit-id="termsAndConditions--acceptTermsAndAgreements">
          <label for="termsAndConditions--acceptTermsAndAgreements"><span>I have read and understand the Terms and Conditions.<abbr aria-hidden="true">*</abbr></span></label>
          <input id="termsAndConditions--acceptTermsAndAgreements" type="checkbox" aria-checked="false" name="acceptTermsAndAgreements" aria-required="true">
        </div>
        <label>By checking this box, I certify and sign this application.<input id="certification" type="checkbox" name="certification"></label>
        <button id="submit" type="submit">Submit application</button>
      </main><script>
        window.submissions = 0;
        document.querySelector('#submit').addEventListener('click', event => {
          event.preventDefault();
          window.submissions++;
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/captured-terms`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator('[name="acceptTermsAndAgreements"]')).toBeChecked({
    timeout: 30_000,
  });
  await expect(page.locator("#certification")).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

test("captured Workday disability date spinbuttons receive today's date", async () => {
  const workdayOrigin = atsOrigins[0];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div data-automation-id="formField-firstName"><label for="firstName">First Name</label><input id="firstName" name="firstName"></div>
        <div data-automation-id="formField-lastName"><label for="lastName">Last Name</label><input id="lastName" name="lastName"></div>
        <div data-automation-id="formField-dateSignedOn" data-fkit-id="selfIdentifiedDisabilityData--dateSignedOn">
          <fieldset><legend><label><span>Date<abbr aria-hidden="true">*</abbr></span></label></legend>
            <div id="selfIdentifiedDisabilityData--dateSignedOn" role="group" data-automation-id="dateInputWrapper">
              <input role="spinbutton" aria-label="Month" aria-valuemax="12" aria-valuemin="1" id="selfIdentifiedDisabilityData--dateSignedOn-dateSectionMonth-input">
              <input role="spinbutton" aria-label="Day" aria-valuemax="31" aria-valuemin="1" id="selfIdentifiedDisabilityData--dateSignedOn-dateSectionDay-input">
              <input role="spinbutton" aria-label="Year" aria-valuemax="9999" aria-valuemin="1" id="selfIdentifiedDisabilityData--dateSignedOn-dateSectionYear-input">
            </div>
          </fieldset>
        </div>
      </main><script>
        // As on Intel's self-identify page: only real keys commit, a later
        // section focused while Month is empty hands focus back to Month a
        // moment later, and two digits move focus on by themselves.
        const [month, day, year] = document.querySelectorAll('[role="spinbutton"]');
        for (const section of [month, day, year]) {
          section.setAttribute('data-committed', '');
          section.addEventListener('keydown', (event) => {
            if (!event.isTrusted) return;
            const committed = section.getAttribute('data-committed');
            section.setAttribute('data-committed', event.key === 'Backspace' ? committed.slice(0, -1) : committed + event.key);
          });
        }
        for (const later of [day, year])
          later.addEventListener('focus', () => {
            if (!month.getAttribute('data-committed')) setTimeout(() => month.focus(), 50);
          });
        month.addEventListener('keyup', (e) => { if (e.isTrusted && month.getAttribute('data-committed').length === 2) day.focus(); });
        day.addEventListener('keyup', (e) => { if (e.isTrusted && day.getAttribute('data-committed').length === 2) year.focus(); });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/captured-disability-date`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  const today = new Date();
  await expect(page.getByRole("spinbutton", { name: "Month" })).toHaveValue(
    String(today.getMonth() + 1).padStart(2, "0"),
    { timeout: 30_000 },
  );
  await expect(page.getByRole("spinbutton", { name: "Day" })).toHaveValue(
    String(today.getDate()).padStart(2, "0"),
  );
  await expect(page.getByRole("spinbutton", { name: "Year" })).toHaveValue(
    String(today.getFullYear()),
  );
  // Typed, each into its own section: what the site itself saved.
  for (const [name, value] of [
    ["Month", String(today.getMonth() + 1).padStart(2, "0")],
    ["Day", String(today.getDate()).padStart(2, "0")],
    ["Year", String(today.getFullYear())],
  ])
    await expect(page.getByRole("spinbutton", { name })).toHaveAttribute("data-committed", value);
});

test("in a window without focus, Workday's name and disability answer are saved, not just shown", async () => {
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, disabilityStatus: "I am not disabled" },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div data-automation-id="formField-name"><label for="selfIdentifiedDisabilityData--name">Name<abbr>*</abbr></label>
          <input id="selfIdentifiedDisabilityData--name" type="text"></div>
        <div data-automation-id="formField-disabilityStatus">
          <fieldset data-automation-id="disabilityStatus-CheckboxGroup" aria-required="true">
            <div><div><input id="disability-yes" type="checkbox"></div><label for="disability-yes">Yes, I have a disability, or have had one in the past</label></div>
            <div><div><input id="disability-no" type="checkbox"></div><label for="disability-no">No, I do not have a disability and have not had one in the past</label></div>
            <div><div><input id="disability-decline" type="checkbox"></div><label for="disability-decline">I do not want to answer</label></div>
          </fieldset>
        </div>
      </main><script>
        // The window's focus is in the side panel: Chrome fires no real focus
        // events in this page, and it knows it has no focus.
        document.hasFocus = () => false;
        // Like Workday: a text field is saved when focus leaves it, and a
        // disability answer only from a click; an assigned "checked" stays
        // visible but is never saved.
        window.saved = { name: '', disability: '' };
        const name = document.getElementById('selfIdentifiedDisabilityData--name');
        name.addEventListener('focusout', (event) => { if (!event.isTrusted) window.saved.name = name.value; });
        for (const box of document.querySelectorAll('[data-automation-id="disabilityStatus-CheckboxGroup"] input'))
          box.addEventListener('click', () => { window.saved.disability = box.checked ? box.id : ''; });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/unfocused-self-identify`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect
    .poll(() => page.evaluate(() => (window as any).saved), { timeout: 30_000 })
    .toEqual({ name: `${profile.firstName} ${profile.lastName}`, disability: "disability-no" });
});

// Citi's Workday (report cace1c27): "Race/Ethnicity (select all that apply)"
// is a group of checkboxes, and none was ticked for an Asian applicant.
test("Workday's race checkbox group ticks the applicant's race", async () => {
  const workdayOrigin = atsOrigins[0];
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, ethnicity: "South Asian" } });
  const races = ["American Indian or Alaska Native", "Asian", "Black or African American", "White"];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div data-automation-id="formField-ethnicityMulti">
          <fieldset><legend><label>Race/Ethnicity (select all that apply)</label></legend>
            <fieldset data-automation-id="ethnicityMulti-CheckboxGroup" id="personalInfoUS--ethnicityMulti" aria-required="false">
              <div role="grid">${races
                .map(
                  (race, i) => `<div role="row"><div role="cell"><div><div><input id="race-${i}" type="checkbox" aria-checked="false"></div>
                    <label for="race-${i}">${race} (United States of America)</label></div></div></div>`,
                )
                .join("")}</div>
            </fieldset>
          </fieldset>
        </div>
      </main><script>
        window.saved = [];
        for (const box of document.querySelectorAll('[data-automation-id="ethnicityMulti-CheckboxGroup"] input'))
          box.addEventListener('click', () => {
            box.setAttribute('aria-checked', String(box.checked));
            window.saved = [...document.querySelectorAll('[data-automation-id="ethnicityMulti-CheckboxGroup"] input:checked')].map((checked) => checked.id);
          });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/race-checkbox-group`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect.poll(() => page.evaluate(() => (window as any).saved), { timeout: 30_000 }).toEqual(["race-1"]);
});

// Cisco's Workday (report 06a46f40): the first work experience row's Job
// Title, focused by Workday when it added the row, showed the title but
// reported "required" because the fill never said focus left it.
test("in a window without focus, a Workday field the site already focused is saved", async () => {
  const workdayOrigin = atsOrigins[0];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div data-automation-id="formField-name"><label for="selfIdentifiedDisabilityData--name">Name<abbr>*</abbr></label>
          <input id="selfIdentifiedDisabilityData--name" type="text"></div>
      </main><script>
        document.hasFocus = () => false;
        window.saved = '';
        const name = document.getElementById('selfIdentifiedDisabilityData--name');
        name.addEventListener('focusout', (event) => { if (!event.isTrusted) window.saved = name.value; });
        // Like Workday on a row it just added: its first field already has focus.
        name.focus();
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/unfocused-prefocused`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator("#selfIdentifiedDisabilityData--name")).toHaveValue(
    `${profile.firstName} ${profile.lastName}`,
    { timeout: 30_000 },
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).saved), { timeout: 30_000 })
    .toBe(`${profile.firstName} ${profile.lastName}`);
});

test("a field the site rebuilds empty after a fill is filled again, not protected", async () => {
  await context.route(`${origin}/rebuilt-empty`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <div id="slot"><label>Email<input name="email" type="email" id="email"></label></div>
      </form><script>
        // Like Workday after "discard changes": the same field, a new empty node.
        window.discard = () => {
          document.getElementById('slot').innerHTML = '<label>Email<input name="email" type="email" id="email"></label>';
        };
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/rebuilt-empty`);
  await enqueue([page]);
  await expect(page.locator("#email")).toHaveValue(profile.email, { timeout: 25000 });
  const id = (await state()).applications[0].id;
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 25000 })
    .toMatch(/awaiting-user|ready/);
  await page.evaluate(() => (window as any).discard());
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "FILL_STEP", id, tabId });
  await expect(page.locator("#email")).toHaveValue(profile.email, { timeout: 25000 });
});

test("a stale Workday signing date left on the page is retyped as today", async () => {
  const workdayOrigin = atsOrigins[0];
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div data-automation-id="formField-dateSignedOn">
          <fieldset><legend><label><span>Date<abbr aria-hidden="true">*</abbr></span></label></legend>
            <div role="group" data-automation-id="dateInputWrapper">
              <input role="spinbutton" aria-label="Month" value="2" id="signed-month">
              <input role="spinbutton" aria-label="Day" value="28" id="signed-day">
              <input role="spinbutton" aria-label="Year" value="2026" id="signed-year">
            </div>
          </fieldset>
        </div>
      </main><script>
        // Only real keys change what the site saved, starting from the stale date.
        for (const section of document.querySelectorAll('[role="spinbutton"]')) {
          section.setAttribute('data-committed', section.value);
          section.addEventListener('keydown', (event) => {
            if (!event.isTrusted) return;
            const committed = section.getAttribute('data-committed');
            section.setAttribute('data-committed', event.key === 'Backspace' ? committed.slice(0, -1) : committed + event.key);
          });
        }
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/stale-signing-date`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  const today = new Date();
  await expect(page.locator("#signed-month")).toHaveAttribute(
    "data-committed",
    String(today.getMonth() + 1).padStart(2, "0"),
    { timeout: 30_000 },
  );
  await expect(page.locator("#signed-day")).toHaveAttribute("data-committed", String(today.getDate()).padStart(2, "0"));
  await expect(page.locator("#signed-year")).toHaveAttribute("data-committed", String(today.getFullYear()));
});

test("Workday education panels add each school and fill both attended years", async () => {
  // Citi, report 5092fdc5: one panel was counted twice and its From year stayed blank.
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, networkCapture: "off" } });
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: {
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Master of Science", startDate: "2025-08", endDate: "2027-05" },
      { organization: "Virginia Tech", title: "Bachelor of Science", startDate: "2021-09", endDate: "2025-06" },
    ],
  } });
  await context.route(`${atsOrigins[0]}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><main data-automation-id="applicationPage">
      <div role="group" aria-labelledby="Education-section"><h4 id="Education-section">Education</h4>
        <div id="schools"></div><div><button data-automation-id="add-button">Add Another</button></div>
      </div></main><script>
      let count = 0;
      const add = () => {
        const n = ++count, id = 'education-' + (125 + n);
        const row = document.createElement('div');
        row.setAttribute('role', 'group'); row.setAttribute('aria-labelledby', 'Education-' + n + '-panel');
        row.innerHTML = '<h5 id="Education-' + n + '-panel">Education ' + n + '</h5><div data-fkit-id="' + id + '--null">'
          + '<div data-automation-id="formField-school"><label for="' + id + '--school">School or University</label><input id="' + id + '--school" name="schoolName"></div>'
          + ['firstYearAttended', 'lastYearAttended'].map((key, i) => '<div data-automation-id="formField-' + key + '" data-fkit-id="' + id + '--' + key + '"><fieldset><legend><label>' + (i ? 'To (Actual or Expected)' : 'From') + '</label></legend><div><div role="group" data-automation-id="dateInputWrapper" id="' + id + '--' + key + '"><div><div id="' + id + '--' + key + '-dateSectionYear"><input role="spinbutton" aria-label="Year" aria-required="true" data-automation-id="dateSectionYear-input" id="' + id + '--' + key + '-dateSectionYear-input"></div></div></div></div></fieldset></div>').join('') + '</div>';
        document.querySelector('#schools').append(row);
      };
      document.querySelector('button').onclick = add; add();
      </script>`,
  }));
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/education-panels`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 40_000 }).toMatch(/ready|awaiting-user/);
  expect.soft(await page.locator('[aria-labelledby$="-panel"]').count()).toBe(2);
  const values = (selector: string) => page.locator(selector).evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  expect.soft(await values('[name="schoolName"]')).toEqual(["Michigan State University", "Virginia Tech"]);
  expect.soft(await values('[id$="firstYearAttended-dateSectionYear-input"]')).toEqual(["2025", "2021"]);
  expect.soft(await values('[id$="lastYearAttended-dateSectionYear-input"]')).toEqual(["2027", "2025"]);
});

test("Workday shared resume uploader attaches the cover letter its instructions request", async () => {
  // Citi, report 5092fdc5: both documents are requested above one multiple-file input.
  await context.route(`${atsOrigins[0]}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><main data-automation-id="applicationPage">
      <div role="group" aria-labelledby="Resume/CV-section"><h4 id="Resume/CV-section">Resume/CV</h4>
        <div><div data-automation-id="instructionalText"><p>Please upload your Resume and Candidate Cover Letter</p></div></div>
        <div data-fkit-id="resumeAttachments--null"><div data-automation-id="formField-" data-fkit-id="resumeAttachments--attachments">
          <label id="upload-label">Upload a file (5MB max)</label><div data-automation-id="attachments-FileUpload" aria-labelledby="upload-label">
            <div><button type="button" data-automation-id="select-files" id="resumeAttachments--attachments">Select files</button>
              <input data-automation-id="file-upload-input-ref" type="file" multiple></div><div id="files"></div>
          </div></div></div>
      </div></main><script>
      document.querySelector('input').onchange = event => {
        for (const file of event.target.files) {
          const item = document.createElement('div'); item.dataset.automationId = 'file-upload-item';
          const name = document.createElement('div'); name.dataset.automationId = 'file-upload-item-name'; name.textContent = file.name;
          item.append(name); document.querySelector('#files').append(item);
        }
        event.target.value = '';
      };
      </script>`,
  }));
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/shared-documents`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 40_000 }).toMatch(/ready|awaiting-user/);
  expect(await page.locator('[data-automation-id="file-upload-item-name"]').count()).toBe(2);
  await expect(page.locator('#files')).toContainText(/resume/i);
  await expect(page.locator('#files')).toContainText(/cover/i);
  const cover = (await content(page, { type: "INSPECT" })).data.fields.find((field: { documentKind?: string }) => field.documentKind === "cover");
  expect(cover).toMatchObject({ protected: false, value: expect.stringMatching(/\.pdf$/), attachmentId: expect.any(String) });
  expect((await state()).applications[0].missing).not.toContain("Verify upload: Cover letter");
});

// Leidos's Workday (report 7dd8aa83, 2026-11-07): the group asks for "any
// additional documents (e.g. cover letter, …)". The résumé's upload left
// focus on the "Select files" button, the cover letter's slot, and the
// cover letter was refused as a field in use.
test("Workday's shared uploader takes the cover letter after the résumé's upload leaves focus on its button", async () => {
  await context.route(`${atsOrigins[0]}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><main data-automation-id="applicationPage">
      <div role="group" aria-labelledby="Resume-/-CV-/-Cover-Letter-/-Other-Attachments-section"><h4 id="Resume-/-CV-/-Cover-Letter-/-Other-Attachments-section">Resume / CV / Cover Letter / Other Attachments</h4><div><div data-automation-id="instructionalText"><ul><li><span>Upload resume/CV or any additional documents (e.g. cover letter, certifications, etc.) </span></li></ul></div></div><div data-automation-id="instructional-spacer"></div><div data-fkit-id="resumeAttachments--null"><p><div data-automation-id="formField-" data-fkit-id="resumeAttachments--attachments"><label id="label110">Upload a file (5MB max)</label><div><div><div data-automation-id="attachments-FileUpload" aria-labelledby="label110"><div><div data-automation-id="file-upload-drop-zone"><div>Drop files here</div><div><div>or</div><button type="button" data-automation-id="select-files" id="resumeAttachments--attachments"><span>Select files</span></button></div></div><input data-automation-id="file-upload-input-ref" type="file" multiple=""></div><div id="files"></div></div></div></div></div></p></div></div></main><script>
      document.querySelector('input').onchange = event => {
        for (const file of event.target.files) {
          const item = document.createElement('div'); item.dataset.automationId = 'file-upload-item';
          const name = document.createElement('div'); name.dataset.automationId = 'file-upload-item-name'; name.textContent = file.name;
          item.append(name); document.querySelector('#files').append(item);
        }
        event.target.value = '';
        // As Workday does once a file is taken: focus returns to its button.
        document.getElementById('resumeAttachments--attachments').focus();
      };
      </script>`,
  }));
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/leidos-documents`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 40_000 }).toMatch(/ready|awaiting-user/);
  await expect(page.locator('#files')).toContainText(/resume/i);
  await expect(page.locator('#files')).toContainText(/cover/i);
  expect((await state()).applications[0].missing.join(" ")).not.toContain("Stale or mismatched");
});

// RTX's Workday (report fa24093e, 2026-11-02): the same uploader under
// "Candidate Attachments", its notice asking for "CV, Resume, Cover Letter".
test("Workday's Candidate Attachments uploader takes the cover letter its notice asks for", async () => {
  await context.route(`${atsOrigins[0]}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><main data-automation-id="applicationPage">
      <div role="group" aria-labelledby="Candidate-Attachments-section"><h4 id="Candidate-Attachments-section">Candidate Attachments</h4>
        <div><div data-automation-id="instructionalText"><p>Notice: Please include attachments such as CV, Resume, Cover Letter, Transcript, or any documentation you choose for this application.</p></div></div>
        <div data-fkit-id="resumeAttachments--null"><div data-automation-id="formField-" data-fkit-id="resumeAttachments--attachments">
          <label id="upload-label">Upload a file (5MB max)</label><div data-automation-id="attachments-FileUpload" aria-labelledby="upload-label">
            <div><button type="button" data-automation-id="select-files" id="resumeAttachments--attachments">Select files</button>
              <input data-automation-id="file-upload-input-ref" type="file" multiple></div><div id="files"></div>
          </div></div></div>
      </div></main><script>
      document.querySelector('input').onchange = event => {
        for (const file of event.target.files) {
          const item = document.createElement('div'); item.dataset.automationId = 'file-upload-item';
          const name = document.createElement('div'); name.dataset.automationId = 'file-upload-item-name'; name.textContent = file.name;
          item.append(name); document.querySelector('#files').append(item);
        }
        event.target.value = '';
      };
      </script>`,
  }));
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/candidate-attachments`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 40_000 }).toMatch(/ready|awaiting-user/);
  await expect(page.locator('#files')).toContainText(/resume/i);
  await expect(page.locator('#files')).toContainText(/cover/i);
});

test("Workday shared resume uploader replaces the resume a previous application left there", async () => {
  // Citi, report 1eb327d6: "use my last application" lists its resume and
  // cover letter in the uploader, and the tailored resume was added beside them.
  await context.route(`${atsOrigins[0]}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><main data-automation-id="applicationPage">
      <div role="group" aria-labelledby="Resume/CV-section"><h4 id="Resume/CV-section">Resume/CV</h4>
        <div><div data-automation-id="instructionalText"><p>Please upload your Resume and Candidate Cover Letter</p></div></div>
        <div data-fkit-id="resumeAttachments--null"><div data-automation-id="formField-" data-fkit-id="resumeAttachments--attachments">
          <label id="upload-label">Upload a file (5MB max)</label><div data-automation-id="attachments-FileUpload" aria-labelledby="upload-label">
            <div><button type="button" data-automation-id="select-files" id="resumeAttachments--attachments">Select files</button>
              <input data-automation-id="file-upload-input-ref" type="file" multiple></div><div id="files"></div>
          </div></div></div>
      </div></main><script>
      const add = (fileName) => {
        const item = document.createElement('div'); item.dataset.automationId = 'file-upload-item';
        const name = document.createElement('div'); name.dataset.automationId = 'file-upload-item-name'; name.textContent = fileName;
        const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.automationId = 'delete-file';
        remove.setAttribute('aria-label', 'Delete ' + fileName); remove.title = 'Delete'; remove.onclick = () => item.remove();
        item.append(name, remove); document.querySelector('#files').append(item);
      };
      add('Pat_Example_Resume.pdf'); add('Pat_Example_Cover_Letter.pdf');
      document.querySelector('input').onchange = event => {
        for (const file of event.target.files) add(file.name);
        event.target.value = '';
      };
      </script>`,
  }));
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/last-application-documents`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 40_000 }).toMatch(/ready|awaiting-user/);
  const names = await page.locator('[data-automation-id="file-upload-item-name"]').allTextContents();
  expect(names).not.toContain("Pat_Example_Resume.pdf");
  expect(names).toContain("Pat_Example_Cover_Letter.pdf");
  expect(names.filter((name) => /resume/i.test(name))).toHaveLength(1);
  expect(names).toHaveLength(2);
});

test("Workday date sections that only accept real keystrokes are filled and release the debugger", async () => {
  // Typing lets go of the debugger when the fill ends; network capture for
  // reports would keep it (tested with reports), so it is off here.
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, networkCapture: "off" } });
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
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
    },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div data-automation-id="workExperience-1" id="workExperience-1">
          <label>Job Title<input data-automation-id="jobTitle"></label>
          <label>Company<input data-automation-id="company"></label>
          <label>Role Description<textarea data-automation-id="description"></textarea></label>
          <div data-automation-id="formField-startDate" id="workExperience-1--startDate">
            <fieldset><legend><label><span>From<abbr aria-hidden="true">*</abbr></span></label></legend>
              <input role="spinbutton" aria-label="Month" data-automation-id="dateSectionMonth-input" id="workExperience-1--startDate-dateSectionMonth-input">
              <input role="spinbutton" aria-label="Year" data-automation-id="dateSectionYear-input" id="workExperience-1--startDate-dateSectionYear-input">
            </fieldset>
          </div>
          <div data-automation-id="formField-endDate" id="workExperience-1--endDate">
            <fieldset><legend><label><span>To</span></label></legend>
              <input role="spinbutton" aria-label="Month" data-automation-id="dateSectionMonth-input" id="workExperience-1--endDate-dateSectionMonth-input">
              <input role="spinbutton" aria-label="Year" data-automation-id="dateSectionYear-input" id="workExperience-1--endDate-dateSectionYear-input">
            </fieldset>
          </div>
        </div>
      </main><script>
        // Workday's real date sections keep their own state: an assigned value
        // updates the display but never the state, and a synthetic key event
        // does not reach them at all. Only a real keystroke commits.
        for (const section of document.querySelectorAll('[data-automation-id^="dateSection"]')) {
          section.setAttribute('data-committed', '');
          section.addEventListener('keydown', event => {
            if (!event.isTrusted) return;
            const committed = section.getAttribute('data-committed') || '';
            section.setAttribute(
              'data-committed',
              event.key === 'Backspace' ? committed.slice(0, -1) : committed + event.key,
            );
          });
        }
        // Workday saves a text field when focus leaves it, not on input.
        const title = document.querySelector('[data-automation-id="jobTitle"]');
        title.setAttribute('data-committed', '');
        title.addEventListener('focusout', () => title.setAttribute('data-committed', title.value));
        // As on Intel's Workday: an empty date sends focus from Year back to
        // Month, and a complete month moves focus on to Year by itself.
        for (const year of document.querySelectorAll('[data-automation-id="dateSectionYear-input"]')) {
          const month = year.parentElement.querySelector('[data-automation-id="dateSectionMonth-input"]');
          year.addEventListener('focus', () => {
            if (!month.getAttribute('data-committed')) month.focus();
          });
          month.addEventListener('keyup', event => {
            if (event.isTrusted && month.getAttribute('data-committed').length === 2) year.focus();
          });
        }
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/trusted-dates`);
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((t) => t.url === url)!.id!,
    page.url(),
  );
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator('[data-automation-id="company"]')).toHaveValue(
    "Example Labs",
    { timeout: 30_000 },
  );
  await expect(page.locator('[data-automation-id="jobTitle"]')).toHaveAttribute(
    "data-committed",
    "Software Engineer",
  );
  await expect(
    page.locator("#workExperience-1--startDate-dateSectionMonth-input"),
  ).toHaveAttribute("data-committed", "05", { timeout: 30_000 });
  await expect(
    page.locator("#workExperience-1--startDate-dateSectionYear-input"),
  ).toHaveAttribute("data-committed", "2025");
  await expect(
    page.locator("#workExperience-1--endDate-dateSectionMonth-input"),
  ).toHaveAttribute("data-committed", "03");
  await expect(
    page.locator("#workExperience-1--endDate-dateSectionYear-input"),
  ).toHaveAttribute("data-committed", "2026");
  await expect
    .poll(async () => (await state()).applications[0]?.status, {
      timeout: 30_000,
    })
    .toMatch(/ready|awaiting-user/);
  // The debugger belongs to the lane, not to the tab: once the lane settles,
  // attaching again must succeed, which it cannot while we still hold it.
  await expect
    .poll(
      async () =>
        worker.evaluate(async (tabId) => {
          try {
            await chrome.debugger.attach({ tabId }, "1.3");
            await chrome.debugger.detach({ tabId });
            return "detached";
          } catch (error) {
            return (error as Error).message;
          }
        }, tabId),
      { timeout: 15_000 },
    )
    .toBe("detached");
});

// American Family's Workday (report 75e68e52): the page only took focus with
// the first real key typed into a job's Year, and Workday then sent focus
// back to Month. The rest of the year landed in Month, and the fill paused
// for "a key press on Month" nobody made.
test("a Workday date section that loses focus to its Month mid-typing is retyped, not paused", async () => {
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, networkCapture: "off" } });
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      work: [{ organization: "Example Labs", title: "Software Engineer", location: "Tucson, AZ", details: "Built TypeScript services.", startDate: "2025-05", endDate: "" }],
    },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div data-automation-id="workExperience-1" id="workExperience-1">
          <label>Job Title<input data-automation-id="jobTitle"></label>
          <label>Company<input data-automation-id="company"></label>
          <div data-automation-id="formField-startDate" id="workExperience-1--startDate">
            <fieldset><legend><label><span>From<abbr aria-hidden="true">*</abbr></span></label></legend>
              <input role="spinbutton" aria-label="Month" data-automation-id="dateSectionMonth-input" id="workExperience-1--startDate-dateSectionMonth-input">
              <input role="spinbutton" aria-label="Year" data-automation-id="dateSectionYear-input" id="workExperience-1--startDate-dateSectionYear-input">
            </fieldset>
          </div>
        </div>
      </main><script>
        // Only what real keys put into a section is committed.
        for (const section of document.querySelectorAll('[data-automation-id^="dateSection"]')) {
          section.setAttribute('data-committed', '');
          section.addEventListener('input', event => {
            if (event.isTrusted) section.setAttribute('data-committed', section.value);
          });
        }
        // The first real key into Year is when the page gains focus, and
        // Workday's focus handling then moves it from Year to Month.
        const month = document.querySelector('[data-automation-id="dateSectionMonth-input"]');
        const year = document.querySelector('[data-automation-id="dateSectionYear-input"]');
        let gained = false;
        document.addEventListener('keydown', event => {
          if (!event.isTrusted || gained || event.target !== year) return;
          gained = true;
          month.focus();
        }, true);
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/refocused-date`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 40_000 }).toMatch(/ready|awaiting-user|paused/);
  expect((await state()).applications[0].status).not.toBe("paused");
  await expect(page.locator("#workExperience-1--startDate-dateSectionMonth-input")).toHaveAttribute("data-committed", "05");
  await expect(page.locator("#workExperience-1--startDate-dateSectionYear-input")).toHaveAttribute("data-committed", "2025");
});

// Workday moves focus to Year as soon as Month holds two digits, so the
// release of a month's last key lands on Year. That release counted as typing
// gone astray: the month was retyped, then assigned, and Workday dropped an
// assigned month. Every job's Month on Citi's form was left empty (report
// df423ef2, 2026-10-28).
inEitherTab("a Workday Month that hands focus to Year once complete keeps the month typed", async (tab) => {
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, networkCapture: "off" } });
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      work: [{ organization: "Example Labs", title: "Software Engineer", location: "Tucson, AZ", details: "Built TypeScript services.", startDate: "2025-05", endDate: "" }],
    },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div data-automation-id="workExperience-1" id="workExperience-1">
          <label>Job Title<input data-automation-id="jobTitle"></label>
          <label>Company<input data-automation-id="company"></label>
          <div data-automation-id="formField-startDate" id="workExperience-1--startDate">
            <fieldset><legend><label><span>From<abbr aria-hidden="true">*</abbr></span></label></legend>
              <input role="spinbutton" aria-label="Month" data-automation-id="dateSectionMonth-input" id="workExperience-1--startDate-dateSectionMonth-input">
              <input role="spinbutton" aria-label="Year" data-automation-id="dateSectionYear-input" id="workExperience-1--startDate-dateSectionYear-input">
            </fieldset>
          </div>
        </div>
      </main><script>
        // Only what real keys put into a section is committed; an assigned
        // value is lost.
        const month = document.querySelector('[data-automation-id="dateSectionMonth-input"]');
        const year = document.querySelector('[data-automation-id="dateSectionYear-input"]');
        for (const section of [month, year]) {
          section.setAttribute('data-committed', '');
          section.addEventListener('input', event => {
            section.setAttribute('data-committed', event.isTrusted ? section.value : '');
            if (event.isTrusted && section === month && month.value.length === 2) year.focus();
          });
        }
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/advancing-date`);
  await panel.bringToFront();
  await place(page, tab);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 40_000 }).toMatch(/ready|awaiting-user|paused/);
  expect((await state()).applications[0].status).not.toBe("paused");
  await expect(page.locator("#workExperience-1--startDate-dateSectionMonth-input")).toHaveAttribute("data-committed", "05");
  await expect(page.locator("#workExperience-1--startDate-dateSectionYear-input")).toHaveAttribute("data-committed", "2025");
});

// A tab in front is typed into like one behind, but never while the applicant
// is in it: a field they clicked into keeps them there, long after the click
// and after the fill has moved focus elsewhere.
test("real keys are never typed after the applicant clicks into a field of a tab in front", async () => {
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, networkCapture: "off" } });
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      work: [{ organization: "Example Labs", title: "Software Engineer", location: "Tucson, AZ", details: "Built TypeScript services.", startDate: "2025-05", endDate: "" }],
    },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <label>Notes<textarea id="notes"></textarea></label>
        <div data-automation-id="workExperience-1" id="workExperience-1">
          <label>Job Title<input data-automation-id="jobTitle"></label>
          <div data-automation-id="formField-startDate" id="workExperience-1--startDate">
            <fieldset><legend><label><span>From<abbr aria-hidden="true">*</abbr></span></label></legend>
              <input role="spinbutton" aria-label="Month" data-automation-id="dateSectionMonth-input" id="workExperience-1--startDate-dateSectionMonth-input">
              <input role="spinbutton" aria-label="Year" data-automation-id="dateSectionYear-input" id="workExperience-1--startDate-dateSectionYear-input">
            </fieldset>
          </div>
        </div>
      </main><script>
        window.trustedKeys = 0;
        for (const section of document.querySelectorAll('[role="spinbutton"]'))
          section.addEventListener('keydown', event => { if (event.isTrusted) window.trustedKeys++; });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/applicant-in-field`);
  await page.bringToFront();
  await page.click("#notes");
  // Past the moments a click alone counts for; only the field they touched holds.
  await page.waitForTimeout(3500);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 40_000 }).toMatch(/ready|awaiting-user|paused/);
  expect(await page.evaluate(() => (window as unknown as { trustedKeys: number }).trustedKeys)).toBe(0);
});

// Citi's Workday asks "Have you ever been employed by KPMG LLP…?" as a list
// button no site rule covers. The profile answers it, and the answer failed
// as "Custom control requires manual selection" on every application
// (2026-10-28). The list names no list of its own (no aria-controls), and
// the question before it can still have its list open, closing.
inEitherTab("a Workday list question no site rule covers is answered from the profile", async (tab) => {
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, networkCapture: "off" } });
  const workdayOrigin = atsOrigins[0];
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, priorEmployment: "No" } });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><div id="mainContent"><main data-automation-id="applicationPage">
        <div data-automation-id="formField-kpmg">
          <fieldset><legend><div data-automation-id="richText"><p><b>Have you ever been employed by KPMG LLP and/or its members and affiliates worldwide in the last three (3) years?</b></p></div></legend>
            <button aria-haspopup="listbox" type="button" aria-label=" Select One Required" id="primaryQuestionnaire--kpmg">Select One</button>
          </fieldset>
        </div>
      </main></div><script>
        const button = document.getElementById('primaryQuestionnaire--kpmg');
        const popup = (owner, closeAfter) => {
          const box = document.createElement('div');
          box.setAttribute('data-automation-activepopup', 'true');
          const list = document.createElement('ul');
          list.setAttribute('role', 'listbox');
          for (const label of ['Select One', 'Yes', 'No']) {
            const item = document.createElement('li');
            item.setAttribute('role', 'option');
            item.textContent = label;
            item.addEventListener('click', () => {
              owner.textContent = label;
              owner.removeAttribute('aria-expanded');
              box.remove();
            });
            list.append(item);
          }
          box.append(list);
          document.body.append(box);
          if (closeAfter) setTimeout(() => box.remove(), closeAfter);
          return box;
        };
        // Another question's list, still closing when the fill starts.
        popup(document.createElement('button'), 1500);
        button.addEventListener('click', () => {
          if (button.getAttribute('aria-expanded') === 'true') return;
          button.setAttribute('aria-expanded', 'true');
          popup(button);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/list-question`);
  await panel.bringToFront();
  await place(page, tab);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 40_000 }).toMatch(/ready|awaiting-user|paused/);
  await expect(page.locator("#primaryQuestionnaire--kpmg")).toHaveText("No", { timeout: 20_000 });
});

// Ashby's education dates are lists whose months are valued "1" to "12".
// The month written "08" matched none, and when the year was picked Ashby set
// the empty month to the current one: every start and end month read
// October (Applied Intuition, report 9027045f, 2026-10-28).
inEitherTab("an Ashby education month valued without a leading zero gets the saved month", async (tab) => {
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, networkCapture: "off" } });
  const ashbyOrigin = atsOrigins[3];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, education: [{ organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08-21", endDate: "2027-05-10", location: "", details: "" }] },
  });
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    .map((month, index) => `<option value="${index + 1}">${month}</option>`).join("");
  const years = [2027, 2026, 2025, 2024].map((year) => `<option value="${year}">${year}</option>`).join("");
  const date = (name: string, label: string) => `<div><label for="_systemfield_education_history-${name}">${label}</label>
    <div id="_systemfield_education_history-${name}"><div><select><option disabled hidden value="" selected>Month...</option>${months}</select></div>
    <div><select><option disabled hidden value="" selected>Year...</option>${years}</select></div></div></div>`;
  await context.route(`${ashbyOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><form class="ashby-application-form-container"><div data-field-path="_systemfield_education_history">
        <label for="_systemfield_education_history">Education History</label>
        <div class="_repeatableEducationEntry_1">
          ${date("startDate", "Start Date")}
          ${date("endDate", "End Date")}
        </div>
      </div></form><script>
        // Ashby sets an empty month to the current one once a year is picked.
        for (const pair of document.querySelectorAll('[id^="_systemfield_education_history-"]')) {
          const [month, year] = pair.querySelectorAll('select');
          year.addEventListener('change', () => { if (!month.value) month.value = '10'; });
        }
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${ashbyOrigin}/acme/month-values/application`);
  await panel.bringToFront();
  await place(page, tab);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 40_000 }).toMatch(/ready|awaiting-user|paused/);
  await expect(page.locator("#_systemfield_education_history-startDate select").first()).toHaveValue("8");
  await expect(page.locator("#_systemfield_education_history-endDate select").first()).toHaveValue("5");
});

// Ashby puts this year in a date's empty Year once its Month is picked. That
// change was locked as the applicant's, so the saved start year was never
// written. Its "Still Student?" box, one per school, was left to the AI,
// which ticked both (Applied Intuition, report 3fcbf55d, 2026-10-28).
test("Ashby's own year after a month is replaced, and only a school still attended is ticked as current", async () => {
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, networkCapture: "off" } });
  const ashbyOrigin = atsOrigins[3];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      education: [
        { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08-21", endDate: "2099-05-10", location: "", details: "" },
        { organization: "Virginia Tech", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15", location: "", details: "" },
      ],
    },
  });
  const thisYear = new Date().getFullYear();
  const months = Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}">${index + 1}</option>`).join("");
  const years = Array.from({ length: 90 }, (_, index) => `<option value="${2099 - index}">${2099 - index}</option>`).join("");
  const date = (name: string, label: string) => `<div><label for="_systemfield_education_history-${name}">${label}</label>
    <div id="_systemfield_education_history-${name}"><div><select><option disabled hidden value="" selected>Month...</option>${months}</select></div>
    <div><select><option disabled hidden value="" selected>Year...</option>${years}</select></div></div></div>`;
  const entry = (row: number) => `<div class="_repeatableEducationEntry_1" data-row="${row}">
    ${date("startDate", "Start Date")}
    ${date("endDate", "End Date")}
    <label for="_systemfield_education_history-isCurrent"><input type="checkbox" id="_systemfield_education_history-isCurrent">Still Student?</label>
  </div>`;
  await context.route(`${ashbyOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><form class="ashby-application-form-container"><div data-field-path="_systemfield_education_history">
        <label for="_systemfield_education_history">Education History</label>
        ${entry(0)}${entry(1)}
      </div></form><script>
        // Picking a month fills the empty year with this one, a moment later.
        for (const pair of document.querySelectorAll('[id^="_systemfield_education_history-"][id$="Date"]')) {
          const [month, year] = pair.querySelectorAll('select');
          month.addEventListener('change', () => setTimeout(() => {
            if (year.value) return;
            year.value = '${thisYear}';
            year.dispatchEvent(new Event('change', { bubbles: true }));
          }, 60));
        }
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${ashbyOrigin}/acme/site-year/application`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 40_000 }).toMatch(/ready|awaiting-user|paused/);
  const rows = page.locator("._repeatableEducationEntry_1");
  await expect(rows.nth(0).locator("#_systemfield_education_history-startDate select").nth(1)).toHaveValue("2025");
  await expect(rows.nth(1).locator("#_systemfield_education_history-startDate select").nth(1)).toHaveValue("2020");
  await expect(rows.nth(1).locator("#_systemfield_education_history-endDate select").nth(1)).toHaveValue("2024");
  await expect(rows.nth(0).locator("#_systemfield_education_history-isCurrent")).toBeChecked();
  await expect(rows.nth(1).locator("#_systemfield_education_history-isCurrent")).not.toBeChecked();
});

// Jabil's Workday form (report 882d55be, 2026-10-15) has one education entry,
// with no dates. The block found as that entry, the outermost one holding
// a single school box, was the whole form: the graduation year was typed into
// a job's end Month, which passed its keys on to Year, and the fill paused
// for an edit nobody made.
test("a Workday education entry without dates never types its year into a job's date", async () => {
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, networkCapture: "off" } });
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      // A current job: its end date stays empty, as on the reported page.
      work: [{ organization: "Example Labs", title: "Software Engineer", location: "Tucson, AZ", details: "Built TypeScript services.", startDate: "2025-05", endDate: "" }],
      education: [{ organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05", location: "", details: "" }],
    },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage"><div class="form">
        <div data-automation-id="workExperience-1" id="workExperience-1">
          <label>Job Title<input data-automation-id="jobTitle" id="workExperience-1--jobTitle"></label>
          <label>Company<input data-automation-id="company" id="workExperience-1--companyName"></label>
          <div data-automation-id="formField-startDate" id="workExperience-1--startDate">
            <fieldset><legend><label><span>From</span></label></legend>
              <input role="spinbutton" aria-label="Month" data-automation-id="dateSectionMonth-input" id="workExperience-1--startDate-dateSectionMonth-input">
              <input role="spinbutton" aria-label="Year" data-automation-id="dateSectionYear-input" id="workExperience-1--startDate-dateSectionYear-input">
            </fieldset>
          </div>
          <div data-automation-id="formField-endDate" id="workExperience-1--endDate">
            <fieldset><legend><label><span>To</span></label></legend>
              <input role="spinbutton" aria-label="Month" data-automation-id="dateSectionMonth-input" id="workExperience-1--endDate-dateSectionMonth-input">
              <input role="spinbutton" aria-label="Year" data-automation-id="dateSectionYear-input" id="workExperience-1--endDate-dateSectionYear-input">
            </fieldset>
          </div>
        </div>
        <div><div>
          <label>School or University<input id="education-8--schoolName"></label>
          <label>Field of Study<input id="education-8--fieldOfStudy"></label>
        </div></div>
      </div></main><script>
        for (const section of document.querySelectorAll('[data-automation-id^="dateSection"]')) {
          section.setAttribute('data-committed', '');
          section.addEventListener('keydown', event => {
            if (!event.isTrusted) return;
            const committed = section.getAttribute('data-committed') || '';
            section.setAttribute('data-committed', event.key === 'Backspace' ? committed.slice(0, -1) : committed + event.key);
          });
        }
        // A month takes two digits at most and then hands focus to Year.
        for (const year of document.querySelectorAll('[data-automation-id="dateSectionYear-input"]')) {
          const month = year.parentElement.querySelector('[data-automation-id="dateSectionMonth-input"]');
          month.addEventListener('keyup', event => {
            if (event.isTrusted && (month.getAttribute('data-committed').length === 2 || Number(month.getAttribute('data-committed')) > 1)) year.focus();
          });
        }
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/one-school`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator("#workExperience-1--startDate-dateSectionYear-input")).toHaveAttribute("data-committed", "2025", { timeout: 40_000 });
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 30_000 }).toMatch(/ready|awaiting-user/);
  await expect(page.locator("#workExperience-1--endDate-dateSectionMonth-input")).toHaveAttribute("data-committed", "");
  await expect(page.locator("#workExperience-1--endDate-dateSectionYear-input")).toHaveAttribute("data-committed", "");
});

// Jabil's Workday form (2026-10-16): each job is a group labelled by its
// panel's h5 ("Work or Other Experience 2"), and the first legend inside it
// is its start date's ("From"). Read as the section, every job's Location
// was one field and got the applicant's home, "Tucson, Arizona".
test("each Workday job panel is its own row, and its Location is that job's", async () => {
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      city: "Phoenix",
      state: "Arizona",
      work: [
        { organization: "Example Labs", title: "Software Engineer", location: "Tucson, AZ", details: "Built services.", startDate: "2025-05", endDate: "" },
        { organization: "Sample AI", title: "Intern", location: "Remote", details: "Built APIs.", startDate: "2023-06", endDate: "2023-09" },
      ],
    },
  });
  const panel = (n: number) => `
    <div role="group" aria-labelledby="Work-or-Other-Experience-${n}-panel">
      <div><h5 id="Work-or-Other-Experience-${n}-panel">Work or Other Experience ${n}</h5></div>
      <div><label for="job-${n}">Job Title</label><input id="job-${n}"></div>
      <div><label for="loc-${n}">Location</label><input id="loc-${n}"></div>
      <div><fieldset><legend>From</legend><label for="from-${n}">Month</label><input id="from-${n}"></fieldset></div>
    </div>`;
  await context.route(`${origin}/workday-panels`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>My Experience</title><form><label>First name<input name="first"></label>
        <div role="group" aria-labelledby="Work-or-Other-Experience-section"><h4 id="Work-or-Other-Experience-section">Work or Other Experience</h4>${panel(1)}${panel(2)}</div>
      </form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/workday-panels`);
  await enqueue([page]);
  await expect(page.locator('[name="first"]')).toHaveValue(profile.firstName, { timeout: 60000 });
  await expect(page.locator("#loc-1")).toHaveValue("Tucson, AZ", { timeout: 20000 });
  await expect(page.locator("#loc-2")).toHaveValue("Remote");
  const observed = await content(page, { type: "INSPECT" });
  expect(observed.data.fields.filter((field: { label: string }) => field.label === "Location").map((field: { section: string; index: number }) => [field.section, field.index]))
    .toEqual([["Work or Other Experience", 0], ["Work or Other Experience", 1]]);
});

test("captured Workday disability status selects exactly one confirmed answer", async () => {
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, disabilityStatus: "No" },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div data-automation-id="formField-firstName"><label for="firstName">First Name</label><input id="firstName" name="firstName"></div>
        <div data-automation-id="formField-lastName"><label for="lastName">Last Name</label><input id="lastName" name="lastName"></div>
        <div data-automation-id="formField-disabilityStatus" data-fkit-id="selfIdentifiedDisabilityData--disabilityStatus">
          <fieldset><legend><label><span>Please check one of the boxes below:<abbr aria-hidden="true">*</abbr></span></label></legend>
            <fieldset data-automation-id="disabilityStatus-CheckboxGroup" id="selfIdentifiedDisabilityData--disabilityStatus" aria-required="true">
              <div><div><input id="disability-yes" type="checkbox" aria-checked="false" aria-required="true"></div><label for="disability-yes">Yes, I have a disability, or have had one in the past</label></div>
              <div><div><input id="disability-no" type="checkbox" aria-checked="false" aria-required="true"></div><label for="disability-no">No, I do not have a disability and have not had one in the past</label></div>
              <div><div><input id="disability-decline" type="checkbox" aria-checked="false" aria-required="true"></div><label for="disability-decline">I do not want to answer</label></div>
            </fieldset>
          </fieldset>
        </div>
      </main><script>
        const choices = [...document.querySelectorAll('[data-automation-id="disabilityStatus-CheckboxGroup"] input')];
        for (const choice of choices) choice.addEventListener('change', () => {
          if (!choice.checked) return;
          for (const other of choices) if (other !== choice) other.checked = false;
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/captured-disability-status`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator("#disability-no")).toBeChecked({ timeout: 30_000 });
  await expect(page.locator("#disability-yes")).not.toBeChecked();
  await expect(page.locator("#disability-decline")).not.toBeChecked();
  expect(
    await page
      .locator('[data-automation-id="disabilityStatus-CheckboxGroup"] input:checked')
      .count(),
  ).toBe(1);
});

test("Workday disability boxes that undo an assigned tick keep the profile's answer, without refilling", async () => {
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, disabilityStatus: "I am not disabled" },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div data-automation-id="formField-disabilityStatus">
          <fieldset data-automation-id="disabilityStatus-CheckboxGroup" aria-required="true">
            <div><div><input id="disability-yes" type="checkbox"></div><label for="disability-yes">Yes, I have a disability, or have had one in the past</label></div>
            <div><div><input id="disability-no" type="checkbox"></div><label for="disability-no">No, I do not have a disability and have not had one in the past</label></div>
            <div><div><input id="disability-decline" type="checkbox"></div><label for="disability-decline">I do not want to answer</label></div>
          </fieldset>
        </div>
      </main><script>
        // Like Workday's React boxes: the state changes only on a click; an
        // assigned "checked" is put back on the next render.
        const choices = [...document.querySelectorAll('[data-automation-id="disabilityStatus-CheckboxGroup"] input')];
        let selected = null;
        window.writes = 0;
        const render = () => { for (const choice of choices) choice.checked = choice === selected; };
        for (const choice of choices) {
          choice.addEventListener('click', () => { selected = choice.checked ? choice : null; setTimeout(render); });
          choice.addEventListener('change', () => { window.writes++; setTimeout(render); });
        }
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/reverting-disability-status`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator("#disability-no")).toBeChecked({ timeout: 30_000 });
  await expect
    .poll(async () => (await state()).applications[0]?.status, { timeout: 30_000 })
    .toMatch(/ready|awaiting-user/);
  await expect(page.locator("#disability-no")).toBeChecked();
  await expect(page.locator("#disability-yes")).not.toBeChecked();
  await expect(page.locator("#disability-decline")).not.toBeChecked();
  // One answer, written a handful of times at most: no refill loop.
  expect(await page.evaluate(() => (window as any).writes)).toBeLessThan(5);
});

test("a user's Workday disability checkbox selection is protected as a group", async () => {
  // The selection is in the page before the extension: kept as found, as
  // with Keep chosen (replacing is tested on its own).
  await keepPrefilled();
  const workdayOrigin = atsOrigins[0];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, disabilityStatus: "No" },
  });
  await context.route(`${workdayOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main data-automation-id="applicationPage">
        <div data-automation-id="formField-disabilityStatus">
          <fieldset data-automation-id="disabilityStatus-CheckboxGroup" aria-required="true">
            <div><div><input id="disability-yes" type="checkbox" checked></div><label for="disability-yes">Yes, I have a disability</label></div>
            <div><div><input id="disability-no" type="checkbox"></div><label for="disability-no">No, I do not have a disability</label></div>
            <div><div><input id="disability-decline" type="checkbox"></div><label for="disability-decline">I do not want to answer</label></div>
          </fieldset>
        </div>
      </main><script>
        const choices = [...document.querySelectorAll('[data-automation-id="disabilityStatus-CheckboxGroup"] input')];
        for (const choice of choices) choice.addEventListener('change', () => {
          if (!choice.checked) return;
          for (const other of choices) if (other !== choice) other.checked = false;
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${workdayOrigin}/en-US/acme/job/protected-disability-status`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect(page.locator("#disability-yes")).toBeChecked({
    timeout: 30_000,
  });
  await expect(page.locator("#disability-no")).not.toBeChecked();
  const fields = (await content(page, { type: "INSPECT" })).data.fields;
  expect(
    fields.filter((field: { label: string }) =>
      field.label.includes("disability"),
    ),
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ protected: true })]),
  );
});

test("the profile scopes prior employment to the hiring company", async () => {
  await panel.bringToFront();
  await showDashboard("profile");
  // No global Yes/No: the work history says Yes for its own employers, and
  // No needs the applicant's explicit say-so, unset by default.
  await expect(
    panel.getByRole("combobox", { name: "Previously employed by this company", exact: true }),
  ).toHaveCount(0);
  const never = panel.getByRole("checkbox", { name: /I have never worked for any company I apply to/ });
  await expect(never).not.toBeChecked();
  await never.check();
  await expect(never).toBeChecked();
});

test("work authorization is entered country by country, with U.S. EEO questions labeled as such", async () => {
  await panel.bringToFront();
  await showDashboard("profile");
  await expect(panel.getByRole("heading", { name: "U.S. equal-opportunity questions (optional)" })).toBeVisible();
  await panel.getByRole("button", { name: "+ Add country" }).click();
  await panel.getByLabel("Work authorization 1 country").selectOption("CA");
  const entry = panel.locator(".history-row").filter({ has: panel.getByLabel("Work authorization 1 country") });
  await entry.getByLabel("Status").selectOption("citizen");
  await entry.getByLabel("Needs sponsorship there").selectOption("no");
  await panel.getByLabel("Add a citizenship").selectOption("CA");
  await panel.getByRole("checkbox", { name: /confirm they are accurate/ }).check();
  await panel.getByRole("button", { name: "Save confirmed profile" }).click();
  await expect(panel.getByRole("status")).toContainText("Profile saved");
  const saved = await ui({ type: "API", path: "/v1/profile" });
  expect(saved.workAuthorization).toEqual([{ country: "CA", status: "citizen", needsSponsorship: false }]);
  expect(saved.citizenships).toEqual(["CA"]);
});

test("network capture is off by default, and Settings says what it records", async () => {
  await panel.bringToFront();
  await showDashboard("settings");
  const capture = panel.getByLabel(/Network capture for reports/);
  await expect(capture).toHaveValue("off");
  await expect(panel.getByText(/debugging this browser/)).toBeVisible();
  expect((await state()).settings.networkCapture).not.toBe("on");
});

test("a legal detail is chosen from standard statements, written in the applicant's own words, or left to them", async () => {
  await panel.bringToFront();
  await showDashboard("profile");
  const record = panel.getByRole("combobox", { name: "Criminal record", exact: true });
  const own = panel.getByLabel("Criminal record, in your own words", { exact: true });
  await expect(record).toHaveValue("");
  await expect(own).toHaveCount(0);
  await expect(record.locator("option")).toHaveText(["Leave for me to answer", "No convictions and no pending charges", "Something else (write it)"]);
  // A standard statement is saved as the sentence it is.
  await record.selectOption("No convictions and no pending charges");
  await expect(record).toHaveValue("No convictions and no pending charges");
  await expect(own).toHaveCount(0);
  // Their own words, in a box that appears for it.
  await record.selectOption({ label: "Something else (write it)" });
  await expect(own).toHaveValue("");
  await own.fill("One dismissed misdemeanor in 2019");
  await expect(record).toHaveValue("__own__");
  // Back to leaving it for themselves: nothing is kept.
  await record.selectOption({ label: "Leave for me to answer" });
  await expect(own).toHaveCount(0);
  await record.selectOption({ label: "Something else (write it)" });
  await expect(own).toHaveValue("");
  // "Anything else" has no standard statement: it is only ever written.
  await expect(panel.getByRole("combobox", { name: "Anything else", exact: true })).toHaveCount(0);
  await expect(panel.getByLabel("Anything else, in your own words", { exact: true })).toBeVisible();
});

test("answer-bank questions are fixed choices that map to portal wording", async () => {
  await panel.bringToFront();
  await showDashboard("profile");
  const veteran = panel.getByRole("combobox", {
    name: "Veteran status",
    exact: true,
  });
  await expect(veteran).toHaveJSProperty("tagName", "SELECT");
  await expect(veteran.locator("option")).toHaveText([
    "Leave for me to answer",
    "I am a protected veteran",
    "I am not a protected veteran",
    "Decline to answer",
  ]);
  await veteran.selectOption("No");
  await expect(veteran).toHaveValue("No");
  const gender = panel.getByRole("combobox", { name: "Gender", exact: true });
  await expect(gender.locator("option")).toHaveText([
    "Leave for me to answer",
    "Male",
    "Female",
    "Non-binary",
    "Decline to answer",
  ]);
});

test("real extension prepares multiple tabs, attaches isolated documents, and never submits", async () => {
  const a = await context.newPage();
  await a.goto(`${origin}/job-a`);
  const b = await context.newPage();
  await b.goto(`${origin}/job-b`);
  await panel.bringToFront();
  const activeBefore = await panel.evaluate(
    async () => (await chrome.tabs.query({ active: true }))[0].id,
  );
  await enqueue([a, b]);
  await expect
    .poll(
      async () =>
        (await state()).applications.map((a) =>
          a.status === "ready" ? "ready" : `${a.status}: ${a.note}`,
        ),
      { timeout: 25000 },
    )
    .toEqual(["ready", "ready"]);
  for (const page of [a, b]) {
    await expect(page.locator("[name=email]")).toHaveValue(profile.email);
    await expect(page.locator("[name=country]")).toHaveValue("US");
    await expect(page.locator("[name=experience]")).toHaveValue(
      profile.facts[0].text,
    );
    expect(
      await page
        .locator("[name=resume]")
        .evaluate((e: HTMLInputElement) => e.files?.[0].size),
    ).toBeGreaterThan(1000);
    expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
  }
  const apps = (await state()).applications;
  expect(apps[0].artifacts[0].id).not.toBe(apps[1].artifacts[0].id);
  expect(apps[0].artifacts.every((a) => a.applicationId === apps[0].id)).toBe(
    true,
  );
  expect(
    await panel.evaluate(
      async () => (await chrome.tabs.query({ active: true }))[0].id,
    ),
  ).toBe(activeBefore);
  expect(submitted).toBe(0);
  await panel.screenshot({
    path: "test-results/dashboard.png",
    fullPage: true,
  });
});

test("AI response recovery prepares parallel drafts, shows warnings, and cannot write into an edited lane", async () => {
  const started = new Set<string>();
  const providerServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const input = JSON.parse(body.messages[1].content);
    started.add(input.job.title);
    if (/timeout|editing/.test(input.job.title)) return; // Real hung HTTP requests.
    const content = {
      resume: /missing-id/.test(input.job.title)
        ? [
            { factId: "f2" },
            { text: profile.facts[0].text },
            { text: "Invented claim" },
          ]
        : ["f1", "f2"],
      coverLetter: [],
      answers: input.fields.map((f: { id: string }) => ({
        fieldId: f.id,
        factIds: ["f1"],
      })),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(content) },
          },
        ],
      }),
    );
  });
  providerServer.listen(0, "127.0.0.1");
  await once(providerServer, "listening");
  runtimeGenerate = provider(
    configSchema.parse({ postingLookup: false,
      token,
      model: "recovery-fixture",
      endpoint: `http://127.0.0.1:${(providerServer.address() as { port: number }).port}/v1`,
    }),
    { timeoutMs: 2000, diagnostic: () => {} },
  );
  try {
    await context.route(`${atsOrigins[0]}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: html(new URL(route.request().url()).pathname).replace(
          "</form>",
          '<button type="button" data-automation-id="bottom-navigation-next-button" onclick="window.nextClicks=(window.nextClicks||0)+1">Next</button></form>',
        ),
      }),
    );
    const pages: Page[] = [];
    for (const path of ["missing-id", "empty-cover", "timeout", "editing"]) {
      const page = await context.newPage();
      await page.goto(`${atsOrigins[0]}/${path}`);
      pages.push(page);
    }
    await panel.bringToFront();
    await enqueue(pages);
    await expect
      .poll(() => [...started].some((title) => title.includes("editing")), {
        timeout: 25000,
      })
      .toBe(true);
    await pages[3].bringToFront();
    await pages[3].locator("[name=email]").fill("human@example.test");
    await expect
      .poll(async () => (await state()).applications.map((a) => a.status), {
        timeout: 25000,
      })
      .toEqual(["awaiting-user", "awaiting-user", "awaiting-user", "paused"]);
    const apps = (await state()).applications;
    for (let i = 0; i < 3; i++) {
      expect(apps[i].note).toContain("recovery warnings");
      expect(apps[i].missing.join(" ")).toMatch(
        i === 2 ? /Local fallback draft/ : /repaired/,
      );
      expect(apps[i].artifacts).toHaveLength(4);
      expect(
        apps[i].artifacts.every(
          (a) =>
            a.applicationId === apps[i].id && a.operation === apps[i].operation,
        ),
      ).toBe(true);
      await expect(pages[i].locator("[name=email]")).toHaveValue(profile.email);
      expect(await pages[i].locator("[name=cover]").inputValue()).toContain(
        "Dear Hiring Team",
      );
      expect(
        await pages[i]
          .locator("[name=resume]")
          .evaluate((e: HTMLInputElement) => e.files?.[0].size),
      ).toBeGreaterThan(1000);
      expect(
        await pages[i].evaluate(() => (window as any).nextClicks || 0),
      ).toBe(0);
      expect(await pages[i].evaluate(() => (window as any).submissions)).toBe(
        0,
      );
    }
    await expect(pages[2].locator("[name=experience]")).toHaveValue("");
    await expect(pages[3].locator("[name=email]")).toHaveValue(
      "human@example.test",
    );
    expect(apps[3].artifacts).toHaveLength(0);
    expect(
      await pages[3]
        .locator("[name=resume]")
        .evaluate((e: HTMLInputElement) => e.files?.length),
    ).toBe(0);
    await panel.bringToFront();
    const card = panel
      .locator("article.application")
      .filter({ hasText: "Frontend Engineer /timeout" });
    await expect(card.locator(".app-note")).toHaveText(
      "Drafts prepared with recovery warnings. Review documents before continuing.",
    );
    await card.getByRole("button", { name: "Documents", exact: true }).click();
    const dialog = panel.getByRole("dialog", { name: "Application documents" });
    await expect(dialog.getByText(/Local fallback draft/)).toBeVisible();
    expect(submitted).toBe(0);
  } finally {
    providerServer.closeAllConnections();
    await new Promise<void>((r) => providerServer.close(() => r()));
  }
});

test("reported ATS form markup resolves labels and uploads, reports invalid patterns, and fills native date parts", async () => {
  // Its preselected country is kept, as the site filled it.
  await keepPrefilled();
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      address: "100 Test Way",
      postalCode: "85001",
      state: "Arizona",
      education: [
        {
          organization: "Test University",
          title: "Bachelor's Degree",
          fieldOfStudy: "Computer Science",
          startDate: "2024-08",
          endDate: "2028-05",
        },
      ],
    },
  });
  const pageHTML = (form: string) =>
    `<!doctype html><meta charset="utf-8"><title>ATS fixture</title><main><h1>Engineering Internship</h1><form>${form}<button type="submit">Submit application</button></form></main><script>window.submissions=0;document.querySelector("form").onsubmit=e=>{e.preventDefault();window.submissions++}</script>`;
  const fixtures = [
    pageHTML(
      '<h2>Autofill with Resume</h2><div data-automation-id="file-upload-drop-zone"><div><p>Drop file here</p><input type="file" accept=".pdf" aria-hidden="true" style="display:none"></div></div>',
    ),
    pageHTML(
      '<div class="file-upload__wrapper"><label for="resume">Attach</label><input type="file" id="resume" accept=".pdf" style="display:none"></div><div class="file-upload__wrapper"><label for="cover_letter">Attach</label><input type="file" id="cover_letter" accept=".pdf" style="display:none"></div><div class="select__container"><label id="country-label">Country*</label><div class="select__single-value">Canada</div><input role="combobox" aria-labelledby="country-label" aria-expanded="false"><input required aria-hidden="true" tabindex="-1"></div>',
    ),
    pageHTML(
      '<ul><li class="application-question"><label><span class="application-label">Email ✱</span><div class="application-field"><input type="email" name="email" pattern="[a-zA-Z0-9-]+"></div></label></li><li class="application-question custom-question"><div><div class="application-label"><div class="text">Home address<span>✱</span></div></div><div class="application-field required-field"><textarea name="cards[fixture][field0]" required></textarea></div></div></li><li class="application-question custom-question"><div><div class="application-label">email ✱</div><div class="application-field"><textarea name="cards[fixture][field1]" required></textarea></div></div></li><li class="application-question"><label><span class="application-label">Current location</span><div class="application-field"><input name="location"><div>No location found. Try entering a different location</div></div></label></li></ul>',
    ),
    pageHTML(
      '<fieldset><legend>Addresses</legend><label>Address<input name="address" required></label><label>Zip/Postal Code<input name="zip" required></label></fieldset><fieldset><legend>Education</legend><label>School Dropdown<select name="school" required><option value="-1">— Make a Selection —</option><option>Test University</option></select></label><label>Degree<select name="degree" required><option value="0">Please select</option><option>Bachelor\'s Degree</option></select></label><label>Major<select name="major" required><option value="-1">Make a Selection</option><option>Computer Science</option></select></label><label>Start Date Month<select name="month" required><option value="-1">Month</option><option value="08">August</option></select></label><label>Start Date Year<input name="year" required></label><label>Did You Graduate?<select name="graduated" required><option value="-1">— Make a Selection —</option><option>Yes</option><option>No</option></select></label></fieldset><div hidden><input type="password"><div data-sitekey="hidden-fixture"></div></div><div data-sitekey="solved-fixture">Synthetic solved widget</div><textarea name="g-recaptcha-response" style="display:none"></textarea><script>document.querySelector("[name=g-recaptcha-response]").value="synthetic-solved"</script>',
    ),
  ];
  const sites = [atsOrigins[0], atsOrigins[1], atsOrigins[2], atsOrigins[4]];
  const pages: Page[] = [];
  const consoleErrors: string[] = [];
  for (let i = 0; i < sites.length; i++) {
    await context.route(`${sites[i]}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: fixtures[i] }),
    );
    const page = await context.newPage();
    page.on("console", (m) => {
      if (/invalid regular expression|Failed to read.*valid/i.test(m.text()))
        consoleErrors.push(m.text());
    });
    await page.goto(`${sites[i]}/reported-markup`);
    pages.push(page);
  }
  await panel.bringToFront();
  await enqueue(pages);
  await expect
    .poll(async () => (await state()).applications.map((a) => a.status), {
      timeout: 30000,
    })
    .toEqual(["ready", "ready", "awaiting-user", "ready"]);
  const apps = (await state()).applications;
  for (const [page, selector] of [
    [pages[0], 'input[type="file"]'],
    [pages[1], "#resume"],
    [pages[1], "#cover_letter"],
  ] as const) {
    expect(
      await page
        .locator(selector)
        .evaluate((e: HTMLInputElement) => e.files?.[0].size),
    ).toBeGreaterThan(1000);
  }
  const gh = await content(pages[1], { type: "INSPECT" });
  expect(
    gh.data.fields.filter((f: { label: string }) => f.label === "Country"),
  ).toHaveLength(1);
  expect(
    gh.data.fields.find((f: { label: string }) => f.label === "Country"),
  ).toMatchObject({ value: "Canada", protected: true, required: true });
  await expect(pages[2].locator('[name="cards[fixture][field0]"]')).toHaveValue(
    "100 Test Way\nPhoenix, Arizona, 85001\nUnited States",
  );
  await expect(pages[2].locator('[name="cards[fixture][field1]"]')).toHaveValue(
    profile.email,
  );
  const lever = await content(pages[2], { type: "INSPECT" });
  expect(
    lever.data.fields.some((f: { label: string }) =>
      /cards\[|No location found/.test(f.label),
    ),
  ).toBe(false);
  expect(apps[2].missing.join(" ")).toContain("invalid validation pattern");
  expect(await pages[2].locator('[name="email"]').getAttribute("pattern")).toBe(
    "[a-zA-Z0-9-]+",
  );
  expect(consoleErrors).toEqual([]);
  await expect(pages[3].locator('[name="address"]')).toHaveValue(
    "100 Test Way",
  );
  await expect(pages[3].locator('[name="school"]')).toHaveValue(
    "Test University",
  );
  await expect(pages[3].locator('[name="degree"]')).toHaveValue(
    "Bachelor's Degree",
  );
  await expect(pages[3].locator('[name="major"]')).toHaveValue(
    "Computer Science",
  );
  await expect(pages[3].locator('[name="month"]')).toHaveValue("08");
  await expect(pages[3].locator('[name="year"]')).toHaveValue("2024");
  // Answered from the education end date (2028-05, still ahead).
  await expect(pages[3].locator("[name=graduated]")).toHaveValue("No");
  expect(apps[3].missing.join(" ")).not.toMatch(/Sign in|CAPTCHA/);
  for (const page of pages)
    expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

test("legacy opaque edit locks protect cleared fields after improved label detection", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/legacy-lock`);
  await page.evaluate(() => {
    document.querySelector("form")!.innerHTML =
      '<li class="application-question custom-question"><div class="application-label">email ✱</div><div class="application-field"><textarea name="cards[fixture][field1]"></textarea></div></li>';
  });
  await panel.bringToFront();
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((t) => t.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      }),
    tabId,
  );
  const applicationId = crypto.randomUUID();
  const bound = await content(page, {
    type: "BIND",
    applicationId,
    operation: 1,
    locks: [":0:cards fixture field1"],
  });
  const field = bound.data.fields[0];
  expect(field).toMatchObject({ label: "email", protected: true, value: "" });
  const result = await content(page, {
    type: "APPLY",
    applicationId,
    operation: 1,
    documentId: bound.data.documentId,
    proposals: [
      {
        fieldId: field.id,
        revision: field.revision,
        expectedValue: "",
        value: "wrong@example.test",
        source: "fixture",
      },
    ],
  });
  expect(result.data.results[0].ok).toBe(false);
  expect(result.data.results[0].reason).toContain("The field is protected from automatic changes.");
  await expect(page.locator("textarea")).toHaveValue("");
});

// LinkedIn's SmartRecruiters screening page (2026-11-04): an answer planned
// before its list was read ("No") failed, and the one planned after it ("Not
// Applicable") was skipped as "already failed in this fill".
test("a field that failed one answer still takes another in the same fill", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/retried-answer`);
  await page.evaluate(() => {
    document.querySelector("form")!.innerHTML =
      '<label>Have you previously worked at Acme?<select name="past"><option value="">Select…</option><option>Not Applicable</option><option>I previously worked at Acme</option></select></label>';
  });
  await panel.bringToFront();
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!, page.url());
  await worker.evaluate(async (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }), tabId);
  const applicationId = crypto.randomUUID();
  const bound = await content(page, { type: "BIND", applicationId, operation: 1, locks: [] });
  const field = bound.data.fields.find((candidate: { label: string }) => /previously worked/.test(candidate.label));
  const apply = (value: string) => content(page, {
    type: "APPLY",
    applicationId,
    operation: 1,
    documentId: bound.data.documentId,
    proposals: [{ fieldId: field.id, revision: field.revision, expectedValue: "", value, source: "fixture" }],
  });
  expect((await apply("No")).data.results[0].ok).toBe(false);
  // The same answer again is still skipped.
  expect((await apply("No")).data.results[0].reason).toContain("already failed in this fill");
  expect((await apply("Not Applicable")).data.results[0].ok).toBe(true);
  await expect(page.locator("select")).toHaveValue("Not Applicable");
});

// SmartRecruiters' <label>s hold only whitespace around a slot: every field
// read ":0:" under its older label, and one lock saved under it left a whole
// screening step unfilled (LinkedIn, 2026-11-05).
test("a lock with no label holds no field", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/labelless-lock`);
  await page.evaluate(() => {
    document.querySelector("form")!.innerHTML =
      '<spl-input id="name-field"><span slot="label-content">Your Name</span></spl-input>';
    const host = document.getElementById("name-field")!;
    host.attachShadow({ mode: "open" }).innerHTML = '<label for="name"> <slot name="label-content"></slot> </label><input id="name" type="text">';
  });
  await panel.bringToFront();
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!, page.url());
  await worker.evaluate(async (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }), tabId);
  const applicationId = crypto.randomUUID();
  const bound = await content(page, { type: "BIND", applicationId, operation: 1, locks: [":0:"] });
  const field = bound.data.fields.find((candidate: { label: string }) => candidate.label === "Your Name");
  expect(field).toMatchObject({ protected: false });
  const result = await content(page, {
    type: "APPLY",
    applicationId,
    operation: 1,
    documentId: bound.data.documentId,
    proposals: [{ fieldId: field.id, revision: field.revision, expectedValue: "", value: "Alex Rivera", source: "fixture" }],
  });
  expect(result.data.results[0].ok).toBe(true);
});

test("a lock saved without a section does not hold every row of a section", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/sectioned-lock`);
  await page.evaluate(() => {
    const row = '<div class="rcmSectionComponent"><div class="RCMFormField"><label class="rcmFormFieldLabel">Country</label><div class="fieldComponentInput"><input class="country" aria-label="Country"></div></div></div>';
    document.querySelector("form")!.innerHTML =
      '<div class="rcmFormSection"><div class="rcmFormSectionTopBar"><span>Work Experiences</span></div>' + row + row + "</div>";
  });
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  // As an earlier build saved it, before these rows had a section.
  const bound = await content(page, {
    type: "BIND",
    applicationId: crypto.randomUUID(),
    operation: 1,
    locks: [":0:country"],
  });
  expect(
    bound.data.fields.map((f: { section?: string; index?: number; protected: boolean }) => [f.section, f.index, f.protected]),
  ).toEqual([
    ["Work Experiences", 0, false],
    ["Work Experiences", 1, false],
  ]);
});

// Expand Energy's SuccessFactors lists all read "No Selection" until picked
// (report a248361b, 2026-10-29). A lock saved under that name held every
// empty list of the row: Education Type, Country, Degree and Status. Yet it
// still holds a list with an answer in it, the applicant's own pick: without
// it, Brightline's "State of Andhra Pradesh" was filled over.
test("a lock saved under a list's placeholder does not hold every list showing it", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/placeholder-lock`);
  await page.evaluate(() => {
    const list = (label: string, value = "") =>
      `<div class="RCMFormField"><label class="rcmFormFieldLabel">${label}</label><div class="fieldComponentInput"><input role="combobox" placeholder="No Selection" class="rcmpaginatedselectinput" value="${value}"></div></div>`;
    document.querySelector("form")!.innerHTML =
      '<div class="rcmFormSection"><div class="rcmFormSectionTopBar"><span>What is your educational background?</span></div><div class="rcmSectionComponent">' +
      list("Education Type") + list("Country") + list("Degree") + list("Status", "In Progress") + list("School Name", "No Selection") + "</div></div>";
  });
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const bound = await content(page, {
    type: "BIND",
    applicationId: crypto.randomUUID(),
    operation: 1,
    locks: ["what is your educational background:0:no selection", "what is your educational background:0:degree"],
    // As the applicant's setting has it: what the page held is replaced,
    // their own edits (the locks) kept.
    replaceSiteValues: true,
  });
  expect(bound.data.fields.map((f: { label: string; protected: boolean }) => [f.label, f.protected])).toEqual([
    ["Education Type", false],
    ["Country", false],
    // A lock under the field's own name still holds it.
    ["Degree", true],
    // And the placeholder's lock holds a list the applicant answered.
    ["Status", true],
    // "No Selection" picked from the list is no answer.
    ["School Name", false],
  ]);
  expect(bound.data.fields.find((f: { label: string }) => f.label === "School Name").value).toBe("");
});

// The AI pass is given a list's options to choose from. A SuccessFactors
// list has none until opened, then draws them a page at a time as it is
// scrolled: Expand Energy's Status and Education Type went to the AI pass
// with no options at all (2026-10-30).
test("a SuccessFactors list's options are read for the AI pass, every page of them", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/sf-options`);
  await page.evaluate(() => {
    document.querySelector("form")!.innerHTML =
      '<div class="RCMFormField"><label class="rcmFormFieldLabel">Status</label><div class="fieldComponentInput"><input type="text" role="combobox" placeholder="No Selection" aria-owns="5:_listSelect" class="rcmpaginatedselectinput" id="status"></div></div>';
    const input = document.getElementById("status") as HTMLInputElement;
    const names = ["No Selection", ...Array.from({ length: 24 }, (_, n) => "Choice " + String(n + 1).padStart(2, "0"))];
    input.addEventListener("click", () => {
      document.getElementById("5:_listSelect")?.remove();
      const list = document.createElement("ul");
      list.id = "5:_listSelect";
      list.className = "sf-list-select";
      list.setAttribute("role", "listbox");
      list.style.cssText = "max-height: 120px; overflow-y: auto; margin: 0";
      let shown = 0;
      const more = () => {
        for (const name of names.slice(shown, shown + 10)) {
          const item = document.createElement("li");
          item.setAttribute("role", "option");
          item.style.height = "24px";
          item.innerHTML = "<a>" + name + "</a>";
          list.append(item);
        }
        shown += 10;
      };
      more();
      list.addEventListener("scroll", () => { if (list.scrollTop + list.clientHeight >= list.scrollHeight - 2) setTimeout(more, 100); });
      input.addEventListener("keydown", (event) => { if (event.key === "Escape") list.remove(); });
      document.body.append(list);
    });
  });
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const applicationId = crypto.randomUUID();
  const bound = await content(page, { type: "BIND", applicationId, operation: 1, locks: [] });
  const status = bound.data.fields.find((f: { label: string }) => f.label === "Status");
  const read = await content(page, { type: "OPTIONS", applicationId, operation: 1, documentId: bound.data.documentId, fieldIds: [status.id] });
  expect(read.data).toEqual([{ id: status.id, options: Array.from({ length: 24 }, (_, n) => "Choice " + String(n + 1).padStart(2, "0")) }]);
  // Nothing was chosen, and the list was closed.
  await expect(page.locator("#status")).toHaveValue("");
  await expect(page.locator("ul.sf-list-select")).toHaveCount(0);
});

// The applicant answers the same question by hand on application after
// application ("Military Status", "How did you hear about us?") and would
// not add it to the profile themselves (2026-10-30). Given the same way on
// two applications, it is offered to save; saved, it is offered no more.
test("an answer given by hand on two applications is offered to save", async () => {
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, modelFill: "off", networkCapture: "off" } });
  await context.route(`${origin}/hear-*`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Engineer</title><main><h1>Engineer</h1><p>Build accessible TypeScript applications.</p><form>
        <label>First name<input name="firstName" required></label>
        <label>How did you hear about us?<input id="hear" name="hear"></label>
        <label>Preferred work shift<input id="shift" name="shift"></label>
        <label>Internship length<select id="months" name="months"><option value="">Select</option><option value="3_to_6_months">3 to 6 months</option><option value="7_months_or_more">7 months or more</option></select></label>
        <fieldset><legend>Office</legend>
          <label><input type="radio" name="office" value="65f5e6fd-0ec6-423a-bc28-401ef04b6d76">Foster City</label>
          <label><input type="radio" name="office" value="0b1c2d3e-0ec6-423a-bc28-401ef04b6d76">Boston</label></fieldset>
        <button type="submit">Submit application</button></form></main>`,
    }),
  );
  const pages = [];
  for (const name of ["hear-one", "hear-two"]) {
    const page = await context.newPage();
    await page.goto(`${origin}/${name}`);
    pages.push(page);
  }
  await panel.bringToFront();
  await enqueue(pages);
  await expect.poll(async () => (await state()).applications.map((app) => app.status).join(","), { timeout: 40_000 }).toMatch(/^(ready|awaiting-user|paused),(ready|awaiting-user|paused)$/);
  // One application is not yet a habit.
  await pages[0].fill("#hear", "LinkedIn");
  await expect.poll(async () => (await state()).applications.some((app) => app.handAnswers?.some((entry) => entry.answer === "LinkedIn")), { timeout: 15_000 }).toBe(true);
  expect(await ui({ type: "RECURRING_ANSWERS" })).toEqual([]);
  await pages[0].fill("#shift", "Day");
  await pages[1].fill("#hear", "LinkedIn");
  await pages[1].fill("#shift", "Day");
  // A list and a radio group are kept by the text picked, not their hidden
  // values ("7_months_or_more", an office's id).
  for (const page of pages) {
    // Real keys: selectOption's events are not trusted, so not the applicant's.
    await page.focus("#months");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#months")).toHaveValue("7_months_or_more");
    await page.getByLabel("Foster City").check();
  }
  await expect.poll(async () => (await ui({ type: "RECURRING_ANSWERS" })).map((item: { question: string; answer: string }) => `${item.question} = ${item.answer}`).sort(), { timeout: 15_000 }).toEqual([
    "How did you hear about us? = LinkedIn",
    "Internship length = 7 months or more",
    "Office = Foster City",
    "Preferred work shift = Day",
  ]);
  for (const question of ["Internship length", "Office"])
    await ui({ type: "DISMISS_RECURRING_ANSWER", key: (await ui({ type: "RECURRING_ANSWERS" })).find((item: { question: string }) => item.question === question).key });
  // The first name is the profile's, never offered. On the profile page, one
  // is saved and the other dismissed.
  await showDashboard("profile");
  const card = panel.getByRole("region", { name: "Answers you keep giving" });
  await expect(card.getByText("How did you hear about us?")).toBeVisible();
  await expect(card.getByText("On 2 applications").first()).toBeVisible();
  const row = (question: string) => card.locator(".history-row").filter({ hasText: question });
  await row("How did you hear about us?").getByRole("button", { name: "Save" }).click();
  await expect(row("How did you hear about us?")).toHaveCount(0);
  await row("Preferred work shift").getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toHaveCount(0);
  const profileNow = await ui({ type: "API", path: "/v1/profile" });
  expect(profileNow.answers).toEqual(expect.arrayContaining([{ question: "How did you hear about us?", answer: "LinkedIn" }]));
  expect(profileNow.answers.some((answer: { question: string }) => answer.question === "Preferred work shift")).toBe(false);
  expect(await ui({ type: "RECURRING_ANSWERS" })).toEqual([]);
});

// Links queued from the command line (npm run lane -- add) are tracked by
// the extension as if pasted in, and its queue is mirrored to the backend for
// lane status (2026-10-30). A link for a site it may not reach waits for the
// panel to ask for access.
test("links queued from the command line are tracked, and the queue is mirrored for it", async () => {
  // As the command line does: straight to the backend, with the token.
  const lane = async (path: string, method = "GET", body?: unknown) =>
    (await fetch(`http://127.0.0.1:${(backend.address() as { port: number }).port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    })).json();
  await lane("/v1/inbox", "POST", { urls: [`${origin}/from-cli`, "https://not-granted.example.test/job"] });
  const after = await ui({ type: "PICK_UP_INBOX" });
  expect(after.applications.map((app: { url: string }) => app.url)).toContain(`${origin}/from-cli`);
  expect(after.inboxWaiting).toEqual(["https://not-granted.example.test/job"]);
  // Tracked, it is off the list; the other waits.
  expect((await lane("/v1/inbox")).map((item: { url: string }) => item.url)).toEqual(["https://not-granted.example.test/job"]);
  await showPanel();
  await expect(panel.getByRole("region", { name: "Links waiting for access" })).toContainText("1 link queued from the command line");
  // Mirrored a moment after the queue changed.
  await expect.poll(async () => {
    const queue = await lane("/v1/queue");
    return queue?.applications?.map((app: { url: string; status: string }) => `${app.url} ${app.status}`) || [];
  }, { timeout: 10_000 }).toEqual([`${origin}/from-cli awaiting-user`]);
  // Tracked before its tab had loaded, it is named by its address at first,
  // then by the page's own title once it has one.
  await expect.poll(async () => (await state()).applications.find((app) => app.url === `${origin}/from-cli`)?.title, { timeout: 10_000 }).toBe("Frontend Engineer /from-cli");
  // Picked up again, nothing is tracked twice.
  const again = await ui({ type: "PICK_UP_INBOX" });
  expect(again.applications.filter((app: { url: string }) => app.url === `${origin}/from-cli`)).toHaveLength(1);
});

// The command line's fill and switch (npm run lane -- fill | switch | ui)
// reach the extension over its live line to the backend at once, as the side
// panel's Fill this step would, and the queue comes back over it (2026-10-30).
test("the command line fills a step and switches to its tab over the live line", async () => {
  const { default: WebSocket } = await import("ws");
  const page = await context.newPage();
  await page.goto(`${origin}/live-fill`);
  await panel.bringToFront();
  const tabs = await panel.evaluate(async () => chrome.tabs.query({}));
  const tabId = tabs.find((tab) => tab.url === page.url())!.id!;
  await ui({ type: "TRACK_ITEMS", items: [{ url: page.url(), tabId }] });
  const app = (await state()).applications[0];
  // As the command line joins: no origin, the token first.
  const socket = new WebSocket(`ws://127.0.0.1:${(backend.address() as { port: number }).port}/v1/live`);
  const messages: any[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(String(data))));
  await new Promise<void>((resolve) => socket.on("open", () => (socket.send(JSON.stringify({ type: "auth", token })), resolve())));
  try {
    // The extension's queue arrives over the line.
    await expect.poll(() => messages.some((message) => message.type === "queue" && message.snapshot.applications.some((item: { id: string }) => item.id === app.id)), { timeout: 15_000 }).toBe(true);
    const send = async (action: string) => {
      const id = crypto.randomUUID();
      socket.send(JSON.stringify({ type: "command", id, action, applicationId: app.id }));
      await expect.poll(() => messages.find((message) => message.type === "result" && message.id === id), { timeout: 10_000 }).toBeTruthy();
      return messages.find((message) => message.type === "result" && message.id === id);
    };
    // Switch brings its tab to the front.
    expect(await send("switch")).toMatchObject({ ok: true });
    await expect.poll(async () => (await panel.evaluate(async (id) => (await chrome.tabs.get(id)).active, tabId))).toBe(true);
    // Fill is Fill this step: the form is filled, nothing is submitted.
    expect(await send("fill")).toMatchObject({ ok: true, detail: "Filling this step." });
    await expect(page.locator('input[name="firstName"]')).toHaveValue(profile.firstName, { timeout: 30_000 });
    // While it fills, the command line sees it filling, not the "Tracked"
    // it was before, and then how it ended: a fill saving its progress often
    // must not hold back the queue until it stops (2026-10-30).
    const seen = () => messages.filter((message) => message.type === "queue").map((message) => message.snapshot.applications.find((item: { id: string }) => item.id === app.id)?.status);
    await expect.poll(() => seen().some((status) => ["inspecting", "preparing", "filling"].includes(status)), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => seen().at(-1), { timeout: 10_000 }).toBe((await state()).applications.find((item) => item.id === app.id)?.status);
    expect(await page.evaluate(() => (window as unknown as { submissions: number }).submissions)).toBe(0);
    // Refresh puts the current build in its page (lane refresh) without
    // reloading it, so nothing entered is lost (2026-11-07).
    await expect.poll(async () => (await state()).applications.find((item) => item.id === app.id)!.status, { timeout: 30_000 }).not.toMatch(/^(inspecting|preparing|filling)$/);
    await page.evaluate(() => ((window as unknown as { before: boolean }).before = true));
    await page.locator('input[name="lastName"]').fill("Typed by hand");
    expect(await send("refresh")).toMatchObject({ ok: true, detail: "Its page now runs the current build." });
    expect(await page.evaluate(() => (window as unknown as { before?: boolean }).before)).toBe(true);
    await expect(page.locator('input[name="lastName"]')).toHaveValue("Typed by hand");
    // An application that is not there is said so.
    socket.send(JSON.stringify({ type: "command", id: "missing", action: "fill", applicationId: "nope" }));
    await expect.poll(() => messages.find((message) => message.id === "missing")?.error).toMatch(/No such application/);
  } finally {
    socket.close();
  }
});

// L3Harris's SuccessFactors page is the answer to a posted form: reloaded,
// Chrome asked "Confirm Form Resubmission", and saying yes could repeat what
// was sent; opened again at its one-time address, it showed only an error
// (2026-11-07). The fixer's refresh does neither.
test("lane refresh leaves a page a form posted to as it is, sending nothing again", async () => {
  const { default: WebSocket } = await import("ws");
  const methods: string[] = [];
  await context.route(`${origin}/posted`, (route) => {
    methods.push(route.request().method());
    return route.fulfill({ contentType: "text/html", body: html("/posted") });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/posted`);
  await page.evaluate((target) => {
    const form = document.createElement("form");
    form.method = "post";
    form.action = target;
    document.body.append(form);
    form.submit();
  }, `${origin}/posted`);
  await expect.poll(() => methods).toEqual(["GET", "POST"]);
  await panel.bringToFront();
  const tabId = (await panel.evaluate(async () => chrome.tabs.query({}))).find((tab) => tab.url === `${origin}/posted`)!.id!;
  await ui({ type: "TRACK_ITEMS", items: [{ url: `${origin}/posted`, tabId }] });
  const app = (await state()).applications.find((item) => item.tabId === tabId)!;
  const socket = new WebSocket(`ws://127.0.0.1:${(backend.address() as { port: number }).port}/v1/live`);
  const messages: any[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(String(data))));
  await new Promise<void>((resolve) => socket.on("open", () => (socket.send(JSON.stringify({ type: "auth", token })), resolve())));
  try {
    await expect.poll(() => messages.some((message) => message.type === "queue"), { timeout: 15_000 }).toBe(true);
    socket.send(JSON.stringify({ type: "command", id: "refresh-posted", action: "refresh", applicationId: app.id }));
    await expect.poll(() => messages.find((message) => message.id === "refresh-posted"), { timeout: 30_000 }).toMatchObject({ ok: true });
    // Not reloaded and not opened again: L3Harris's address was a one-time
    // one, and opening it again showed only an error (2026-11-07).
    expect(methods).toEqual(["GET", "POST"]);
  } finally {
    socket.close();
  }
});

// Finding jobs on the dashboard (2026-10-30): what to look for, a search
// over SimplifyJobs' list (served from the backend's cache here), and an
// opening tracked in one click, as the command line's lane search does.
test("the dashboard's Find jobs searches for openings and tracks one", async () => {
  await mkdir(join(backendDirectory, "search", "cache"), { recursive: true });
  const posted = Date.now() / 1000 - 86_400;
  await writeFile(join(backendDirectory, "search", "cache", "simplify-new-grad.json"), JSON.stringify([
    { id: "1", title: "Software Engineer, New Grad", company_name: "Acme", locations: ["Phoenix, AZ"], url: `${origin}/found-job`, date_posted: posted, active: true, is_visible: true },
    { id: "2", title: "Account Executive", company_name: "Beta", locations: ["Phoenix, AZ"], url: `${origin}/not-a-match`, date_posted: posted, active: true, is_visible: true },
  ]));
  await showDashboard("jobs");
  const form = panel.getByRole("region", { name: "What to look for" });
  await form.getByLabel("Roles, one per line").fill("software engineer");
  await form.getByLabel("Also look for what my profile suggests").uncheck();
  await form.getByRole("button", { name: "Search" }).click();
  const openings = panel.getByRole("region", { name: "Openings found" });
  await expect(openings).toContainText("1 openings");
  await expect(openings).toContainText("Acme — Software Engineer, New Grad");
  await expect(openings).not.toContainText("Account Executive");
  await openings.getByRole("button", { name: "Track" }).click();
  await expect(openings.getByText("Tracked", { exact: true })).toBeVisible();
  await expect.poll(async () => (await state()).applications.map((app) => app.url)).toContain(`${origin}/found-job`);
  // The settings are kept for the next search.
  await showDashboard("jobs");
  await expect(panel.getByRole("region", { name: "What to look for" }).getByLabel("Roles, one per line")).toHaveValue("software engineer");
});

test("trusted pointer and key activity pauses without locking an unchanged field", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/unchanged-interaction`);
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const applicationId = crypto.randomUUID();
  const bound = await content(page, {
    type: "BIND",
    applicationId,
    operation: 1,
    locks: [],
  });
  const field = bound.data.fields.find(
    (candidate: { label: string }) => candidate.label === "Phone",
  );
  expect(field).toMatchObject({ value: "", protected: false });

  await page.locator('[name="phone"]').click();
  await page.locator('[name="phone"]').press("ArrowLeft");
  const afterInteraction = await content(page, { type: "INSPECT" });
  expect(
    afterInteraction.data.fields.find(
      (candidate: { label: string }) => candidate.label === "Phone",
    ),
  ).toMatchObject({ revision: field.revision, value: "", protected: false });

  await page.locator('[name="phone"]').blur();
  const resumed = await content(page, {
    type: "RESUME",
    applicationId,
    operation: 2,
  });
  const resumedField = resumed.data.fields.find(
    (candidate: { label: string }) => candidate.label === "Phone",
  );
  const result = await content(page, {
    type: "APPLY",
    applicationId,
    operation: 2,
    documentId: resumed.data.documentId,
    proposals: [
      {
        fieldId: resumedField.id,
        revision: resumedField.revision,
        expectedValue: "",
        value: profile.phone,
        source: "fixture",
      },
    ],
  });
  expect(result.data.results).toEqual([
    expect.objectContaining({ id: resumedField.id, ok: true }),
  ]);
  await expect(page.locator('[name="phone"]')).toHaveValue(profile.phone);
});

test("a viewed tab keeps filling through scrolling and fills custom dropdowns until a field is touched", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/viewed-tab`);
  // Headless tabs report focus, like a tab the applicant is looking at.
  expect(await page.evaluate(() => document.hasFocus())).toBe(true);
  await page.evaluate(() => {
    const native = document.querySelector('[name="country"]')!;
    const shell = document.createElement("div");
    shell.className = "select__container";
    shell.innerHTML =
      '<label id="country-label">Country</label><input role="combobox" aria-labelledby="country-label" aria-expanded="false">';
    native.closest("label")!.replaceWith(shell);
    const input = shell.querySelector<HTMLElement>('[role="combobox"]')!;
    input.addEventListener("mousedown", () => {
      input.setAttribute("aria-expanded", "true");
      input.setAttribute("aria-controls", "countries");
      const list = document.createElement("div");
      list.id = "countries";
      list.role = "listbox";
      list.innerHTML = '<div role="option">United States</div>';
      list.querySelector("div")!.addEventListener("click", () => {
        const value = document.createElement("div");
        value.className = "select__single-value";
        value.textContent = "United States";
        shell.append(value);
        input.setAttribute("aria-expanded", "false");
        list.remove();
      });
      shell.append(list);
    });
    document.body.style.minHeight = "3000px";
  });
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const applicationId = crypto.randomUUID();
  const bound = await content(page, {
    type: "BIND",
    applicationId,
    operation: 1,
    locks: [],
  });
  await page.mouse.move(900, 400);
  await page.mouse.wheel(0, 600);
  await page.mouse.click(1000, 300);
  await page.keyboard.press("PageDown");
  const country = bound.data.fields.find(
    (candidate: { label: string }) => candidate.label === "Country",
  );
  const result = await content(page, {
    type: "APPLY",
    applicationId,
    operation: 1,
    documentId: bound.data.documentId,
    proposals: [
      {
        fieldId: country.id,
        revision: country.revision,
        expectedValue: country.value,
        value: "United States",
        source: "fixture",
      },
    ],
  });
  expect(result.data.results).toEqual([
    expect.objectContaining({ id: country.id, ok: true }),
  ]);
  await page.locator('[name="phone"]').click();
  const after = await content(page, { type: "INSPECT" });
  expect(after.data.paused).toBe(true);
});

test("a first-seen site value created during an engine write is protected", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/site-created-value`);
  await page.locator("form").evaluate((form) => {
    form.innerHTML = '<label>First name<input name="firstName"></label>';
    form.querySelector("input")!.addEventListener("change", () => {
      const label = document.createElement("label");
      label.innerHTML = 'Last name<input name="lastName" value="Site supplied">';
      form.append(label);
    });
  });
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const applicationId = crypto.randomUUID();
  const bound = await content(page, {
    type: "BIND",
    applicationId,
    operation: 1,
    locks: [],
  });
  const firstName = bound.data.fields.find(
    (field: { label: string }) => field.label === "First name",
  );
  const applied = await content(page, {
    type: "APPLY",
    applicationId,
    operation: 1,
    documentId: bound.data.documentId,
    proposals: [
      {
        fieldId: firstName.id,
        revision: firstName.revision,
        expectedValue: "",
        value: profile.firstName,
        source: "fixture",
      },
    ],
  });
  expect(
    applied.data.observation.fields.find(
      (field: { label: string }) => field.label === "Last name",
    ),
  ).toMatchObject({ value: "Site supplied", protected: true });
});

test("site changes after a write are attributed to the engine only while the grace window lasts", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/delayed-normalization`);
  // Frameworks routinely rewrite a field right after our events (Workable
  // normalizes within ~1s); that is not a user edit. Once the window expires,
  // an untrusted change is treated conservatively again.
  await page.locator("form").evaluate((form) => {
    form.innerHTML = '<label>First name<input name="firstName"></label>';
    const input = form.querySelector<HTMLInputElement>("input")!;
    const rewrite = (value: string, delay: number) =>
      setTimeout(() => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, delay);
    input.addEventListener(
      "change",
      () => {
        rewrite("Normalized by site", 1_000);
        rewrite("Changed much later", 6_500);
      },
      { once: true },
    );
  });
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const applicationId = crypto.randomUUID();
  const bound = await content(page, {
    type: "BIND",
    applicationId,
    operation: 1,
    locks: [],
  });
  const field = bound.data.fields[0];
  await content(page, {
    type: "APPLY",
    applicationId,
    operation: 1,
    documentId: bound.data.documentId,
    proposals: [
      {
        fieldId: field.id,
        revision: field.revision,
        expectedValue: "",
        value: profile.firstName,
        source: "fixture",
      },
    ],
  });
  await expect(page.locator('[name="firstName"]')).toHaveValue(
    "Normalized by site",
  );
  const normalized = await content(page, { type: "INSPECT" });
  expect(normalized.data.fields[0]).toMatchObject({
    value: "Normalized by site",
    protected: false,
  });

  await expect(page.locator('[name="firstName"]')).toHaveValue(
    "Changed much later",
    { timeout: 10_000 },
  );
  const late = await content(page, { type: "INSPECT" });
  expect(late.data.fields[0]).toMatchObject({
    value: "Changed much later",
    protected: true,
  });
});

test("config fill keeps a disabled target locked within a writable radio group", async () => {
  const greenhouseOrigin = atsOrigins[1];
  await context.route(`${greenhouseOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><form id="application-form">
        <fieldset>
          <legend>Are you authorized to work in the United States?</legend>
          <label><input id="authorized-yes" type="radio" name="authorized" value="Yes" disabled>Yes</label>
          <label><input id="authorized-no" type="radio" name="authorized" value="No">No</label>
        </fieldset>
      </form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${greenhouseOrigin}/acme/jobs/disabled-authorization`);
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  await background(page);
  const applicationId = crypto.randomUUID();
  const bound = await content(page, {
    type: "BIND",
    applicationId,
    operation: 1,
    locks: [],
  });
  const filled = await content(page, {
    type: "CONFIG_FILL",
    applicationId,
    operation: 1,
    documentId: bound.data.documentId,
    profile: {
      ...profile,
      workAuthorization: "Yes",
      confirmed: true,
    },
  });
  expect(
    filled.data.statuses.find(
      (status: { key: string }) => status.key === "work_auth",
    ),
  ).toMatchObject({ status: "skipped" });
  await expect(page.locator("#authorized-yes")).not.toBeChecked();
  await expect(page.locator("#authorized-no")).not.toBeChecked();
});

test("a sponsorship-worded authorization question uses the sponsorship answer", async () => {
  const greenhouseOrigin = atsOrigins[1];
  await context.route(`${greenhouseOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main><h1>Engineer</h1><form id="application-form">
        <label>First name<input name="first_name"></label>
        <label for="auth">Do you require work authorization?</label>
        <select id="auth" name="job_application[authorization]">
          <option value="">Select…</option><option>Yes</option><option>No</option>
        </select>
      </form></main>`,
    }),
  );
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, workAuthorization: "Yes", sponsorship: "No" },
  });
  const page = await context.newPage();
  await page.goto(`${greenhouseOrigin}/acme/jobs/requires-authorization`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  // The profile is authorized to work and does not need sponsorship, so
  // "Yes" here would claim the opposite.
  await expect(page.locator("#auth")).toHaveValue("No", { timeout: 30_000 });
});

test("radio groups use their first enabled visible member as the tracked field", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/radio-representative`);
  await page.locator("form").evaluate((form) => {
    form.innerHTML = `<fieldset><legend>Are you authorized to work?</legend>
      <input type="radio" name="authorized" value="placeholder" disabled hidden>
      <label><input type="radio" name="authorized" value="Yes">Yes</label>
      <label><input type="radio" name="authorized" value="No">No</label>
    </fieldset>`;
  });
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const applicationId = crypto.randomUUID();
  const bound = await content(page, {
    type: "BIND",
    applicationId,
    operation: 1,
    locks: [],
  });
  const fields = bound.data.fields.filter(
    (field: { label: string }) => field.label === "Are you authorized to work?",
  );
  expect(fields).toHaveLength(1);
  expect(fields[0]).toMatchObject({
    kind: "radio",
    options: ["Yes", "No"],
    protected: false,
    value: "",
  });

  const result = await content(page, {
    type: "APPLY",
    applicationId,
    operation: 1,
    documentId: bound.data.documentId,
    proposals: [
      {
        fieldId: fields[0].id,
        revision: fields[0].revision,
        expectedValue: "",
        value: "No",
        source: "fixture",
      },
    ],
  });
  expect(result.data.results).toEqual([
    expect.objectContaining({ id: fields[0].id, ok: true }),
  ]);
  await expect(page.locator('[name="authorized"][value="No"]')).toBeChecked();
});

test("repeated radio questions have separate positions without bypassing edit or node guards", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/repeated-radio-questions`);
  await page.locator("form").evaluate((form) => {
    form.innerHTML = ["a", "b"].map((suffix) => `
      <fieldset id="visa-${suffix}"><legend>Will you now or in the future require sponsorship?</legend>
        <label><input type="radio" name="visa-${suffix}" value="Yes">Yes</label>
        <label><input type="radio" name="visa-${suffix}" value="No">No</label>
      </fieldset>
      <fieldset><legend>Do you have a family member at this company?</legend>
        <label><input type="radio" name="family-${suffix}" value="Yes">Yes</label>
        <label><input type="radio" name="family-${suffix}" value="No">No</label>
      </fieldset>
      <label>Company<input name="company-${suffix}"></label>`).join("");
  });
  const tabId = await panel.evaluate(async (url) =>
    (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  await worker.evaluate(async (tabId) =>
    chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }), tabId);
  const applicationId = crypto.randomUUID();
  const bind = () => content(page, { type: "BIND", applicationId, operation: 1, locks: [] });
  const bound = await bind();
  const radios = bound.data.fields.filter((field: { kind: string }) => field.kind === "radio");
  expect(radios).toHaveLength(4);
  expect(new Set(radios.map((field: { id: string }) => field.id)).size).toBe(4);
  expect(radios.every((field: { protected: boolean }) => !field.protected)).toBe(true);
  const companies = bound.data.fields.filter((field: { label: string }) => field.label === "Company");
  expect(companies).toHaveLength(2);
  expect(companies.every((field: { protected: boolean }) => field.protected)).toBe(true);
  const applicant = profileSchema.parse({ ...profile, sponsorship: "No", workAuthorization: "Yes" });
  const answers = knownProposals(bound.data.fields, applicant);
  expect(answers).toHaveLength(2);
  expect(answers.map((answer) => answer.value)).toEqual(["No", "No"]);
  const filled = await content(page, { type: "APPLY", applicationId, operation: 1,
    documentId: bound.data.documentId, proposals: answers });
  expect(filled.data.results.every((result: { ok: boolean }) => result.ok)).toBe(true);
  await expect(page.locator('#visa-a input[value="No"]')).toBeChecked();
  await expect(page.locator('#visa-b input[value="No"]')).toBeChecked();
  expect(await page.locator('input[name^="family-"]:checked').count()).toBe(0);

  const first = filled.data.observation.fields.find((field: { id: string }) => field.id === answers[0].fieldId);
  await page.locator("#visa-a").evaluate((group) => { group.innerHTML = group.innerHTML; });
  const stale = await content(page, { type: "APPLY", applicationId, operation: 1,
    documentId: bound.data.documentId,
    proposals: [{ fieldId: first.id, revision: first.revision, expectedValue: "No", value: "Yes", source: "fixture" }] });
  expect(stale.data.results[0].ok).toBe(false);
  expect(stale.data.results[0].reason).toContain("The field was detached from the page.");
  const recreated = await bind();
  const replacement = recreated.data.fields.find((field: { id: string }) => field.id === first.id);
  expect(replacement.revision).toBeGreaterThan(first.revision);
  await expect(page.locator('#visa-a input[value="Yes"]')).not.toBeChecked();
  // Replacing the markup also clears its checked state. Only a newly bound
  // proposal may refill that position; the stale proposal above cannot.
  const refreshedAnswers = knownProposals(recreated.data.fields, applicant);
  expect(refreshedAnswers).toEqual([expect.objectContaining({
    fieldId: first.id, revision: replacement.revision, expectedValue: "", value: "No",
  })]);
  const refreshed = await content(page, { type: "APPLY", applicationId, operation: 1,
    documentId: recreated.data.documentId, proposals: refreshedAnswers });
  expect(refreshed.data.results).toEqual([expect.objectContaining({ id: first.id, ok: true })]);
  await expect(page.locator('#visa-a input[value="No"]')).toBeChecked();
  await page.locator('#visa-b input[value="Yes"]').click();
  const edited = await bind();
  expect(edited.data.fields.find((field: { id: string }) => field.id === answers[1].fieldId))
    .toMatchObject({ value: "Yes", protected: true });
  expect(knownProposals(edited.data.fields, applicant)).toHaveLength(0);
  expect(await page.evaluate(() => (window as unknown as { submissions: number }).submissions)).toBe(0);
});

test("unnamed radios are selected only within their own question", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/unnamed-radios`);
  await page.locator("form").evaluate((form) => {
    form.innerHTML = `<fieldset id="relocation"><legend>Willing to relocate?</legend>
      <label><input type="radio" value="Yes">Yes</label>
      <label><input type="radio" value="No">No</label>
    </fieldset>
    <fieldset id="authorization"><legend>Authorized to work?</legend>
      <label><input type="radio" value="Yes">Yes</label>
      <label><input type="radio" value="No">No</label>
    </fieldset>`;
  });
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const applicationId = crypto.randomUUID();
  const bound = await content(page, {
    type: "BIND",
    applicationId,
    operation: 1,
    locks: [],
  });
  const authorization = bound.data.fields.find(
    (field: { label: string }) => field.label === "Authorized to work?",
  );
  const result = await content(page, {
    type: "APPLY",
    applicationId,
    operation: 1,
    documentId: bound.data.documentId,
    proposals: [
      {
        fieldId: authorization.id,
        revision: authorization.revision,
        expectedValue: "",
        value: "No",
        source: "fixture",
      },
    ],
  });
  expect(result.data.results[0].ok).toBe(true);
  await expect(page.locator("#authorization input[value=No]")).toBeChecked();
  await expect(page.locator("#relocation input[value=No]")).not.toBeChecked();
});

test("toggle-button yes/no questions are one choice field, filled by clicking", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/toggle-choices`);
  // Ashby's Boolean question as captured (its type=submit buttons sit in no
  // <form>), plus a lone editor toggle.
  await page.locator("form").evaluate((form) => {
    form.remove();
    const host = document.createElement("div");
    document.body.append(host);
    host.innerHTML = `<div class="ashby-application-form-field-entry">
        <label class="_heading_f7cvd_52 _required_f7cvd_91" for="ae75ea65">Are you legally authorized to work in the United States?</label>
        <div class="ashby-application-form-input-yesno">
          <button type="submit" aria-pressed="false" data-option="yes">Yes</button>
          <button type="submit" aria-pressed="false" data-option="no">No</button>
          <input type="checkbox" tabindex="-1" name="ae75ea65">
        </div>
      </div>
      <div class="editor"><button type="button" aria-pressed="false">Bold</button></div>`;
    // The site's handler: a click presses one button of the pair.
    for (const button of host.querySelectorAll<HTMLButtonElement>(".ashby-application-form-input-yesno button"))
      button.addEventListener("click", () => {
        for (const other of button.parentElement!.querySelectorAll("button"))
          other.setAttribute("aria-pressed", String(other === button));
      });
  });
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const applicationId = crypto.randomUUID();
  const bound = await content(page, {
    type: "BIND",
    applicationId,
    operation: 1,
    locks: [],
  });
  // One field for the pair; nothing for the hidden checkbox or the lone toggle.
  expect(
    bound.data.fields.map((field: { label: string; kind: string; options: string[]; required: boolean }) => [
      field.label,
      field.kind,
      field.options,
      field.required,
    ]),
  ).toEqual([["Are you legally authorized to work in the United States?", "radio", ["Yes", "No"], true]]);
  const [question] = bound.data.fields;
  const result = await content(page, {
    type: "APPLY",
    applicationId,
    operation: 1,
    documentId: bound.data.documentId,
    proposals: [
      {
        fieldId: question.id,
        revision: question.revision,
        expectedValue: "",
        value: "Yes",
        source: "fixture",
      },
    ],
  });
  expect(result.data.results[0].ok).toBe(true);
  await expect(page.locator("[data-option=yes]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-option=no]")).toHaveAttribute("aria-pressed", "false");
  const after = result.data.observation.fields.find((field: { id: string }) => field.id === question.id);
  expect(after.value).toBe("Yes");
});

test("Ashby's resume field and label-titled radio questions are recognised", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/ashby-fields`);
  // Captured Ashby markup: the "Autofill from resume" pane beside the real
  // Resume field, and a radio question titled by a <label>, not a <legend>.
  await page.locator("form").evaluate((form) => {
    form.innerHTML = `<div role="presentation" class="ashby-application-form-autofill-input-root">
        <input type="file" tabindex="-1" style="position:absolute;width:1px;height:1px;clip:rect(0,0,0,0)">
        <div><h3 class="ashby-application-form-autofill-input-title">Autofill from resume</h3>
        <p>Upload your resume here to autofill key application fields.</p></div>
      </div>
      <div class="ashby-application-form-field-entry" data-field-path="_systemfield_resume">
        <label class="ashby-application-form-question-title" for="_systemfield_resume">Resume</label>
        <div role="presentation" class="ashby-application-form-input-file">
          <input type="file" id="_systemfield_resume" required tabindex="-1" style="position:absolute;width:1px;height:1px;clip:rect(0,0,0,0)">
          <button type="button">Upload File</button>
        </div>
      </div>
      <fieldset class="ashby-application-form-input-radio-group">
        <label class="ashby-application-form-question-title" for="68c5740e-fedf-4c06-96ca-b870d83cef56">Are you willing to relocate to Denver?</label>
        <div><input type="radio" id="90a27d0c-4e88-4ae1-a715-da363c2d11ac_68c5740e-fedf-4c06-96ca-b870d83cef56-labeled-radio-0" name="90a27d0c-4e88-4ae1-a715-da363c2d11ac_68c5740e-fedf-4c06-96ca-b870d83cef56">
          <label for="90a27d0c-4e88-4ae1-a715-da363c2d11ac_68c5740e-fedf-4c06-96ca-b870d83cef56-labeled-radio-0">Yes</label></div>
        <div><input type="radio" id="90a27d0c-4e88-4ae1-a715-da363c2d11ac_68c5740e-fedf-4c06-96ca-b870d83cef56-labeled-radio-1" name="90a27d0c-4e88-4ae1-a715-da363c2d11ac_68c5740e-fedf-4c06-96ca-b870d83cef56">
          <label for="90a27d0c-4e88-4ae1-a715-da363c2d11ac_68c5740e-fedf-4c06-96ca-b870d83cef56-labeled-radio-1">No</label></div>
      </fieldset>`;
  });
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const bound = await content(page, {
    type: "BIND",
    applicationId: crypto.randomUUID(),
    operation: 1,
    locks: [],
  });
  // One Resume field (the real one, not protected as ambiguous), no autofill
  // pane, and the radio question under its visible title.
  expect(
    bound.data.fields.map((field: { label: string; kind: string; protected: boolean; options: string[] }) => [
      field.label,
      field.kind,
      field.protected,
      field.options,
    ]),
  ).toEqual([
    ["Resume", "file", false, []],
    ["Are you willing to relocate to Denver?", "radio", false, ["Yes", "No"]],
  ]);
});

test("radios that only accept clicks keep the filled answer and stay unlocked", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/controlled-radios`);
  await page.locator("form").evaluate((form) => {
    form.innerHTML = `<fieldset><label for="q1">Gender</label>
      <div><input type="radio" id="g-m" name="gender"><label for="g-m">Male</label></div>
      <div><input type="radio" id="g-d" name="gender"><label for="g-d">Decline to self-identify</label></div></fieldset>
      <fieldset><label for="q2">Veteran Status</label>
      <div><input type="radio" id="v-n" name="veteran"><label for="v-n">I am not a protected veteran</label></div>
      <div><input type="radio" id="v-d" name="veteran"><label for="v-d">I decline to self-identify</label></div></fieldset>`;
    // Like a React-controlled input: state changes only on click, and every
    // render restores the checked state from that state.
    const state: Record<string, string> = {};
    const render = () => {
      for (const radio of form.querySelectorAll<HTMLInputElement>("input[type=radio]"))
        radio.checked = state[radio.name] === radio.id;
    };
    form.addEventListener("click", (event) => {
      const radio = event.target as HTMLInputElement;
      if (radio.type === "radio") state[radio.name] = radio.id;
      setTimeout(render);
    });
    form.addEventListener("change", () => setTimeout(render));
  });
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const applicationId = crypto.randomUUID();
  const bound = await content(page, {
    type: "BIND",
    applicationId,
    operation: 1,
    locks: [],
  });
  const byLabel = (label: string) =>
    bound.data.fields.find((field: { label: string }) => field.label === label);
  const result = await content(page, {
    type: "APPLY",
    applicationId,
    operation: 1,
    documentId: bound.data.documentId,
    proposals: [
      ["Gender", "Decline to self-identify"],
      ["Veteran Status", "I am not a protected veteran"],
    ].map(([label, value]) => ({
      fieldId: byLabel(label).id,
      revision: byLabel(label).revision,
      expectedValue: "",
      value,
      source: "fixture",
    })),
  });
  // Both writes land: the first click is not mistaken for the applicant's
  // edit (which would pause the fill and refuse the second).
  expect(result.data.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true]);
  await page.waitForTimeout(50);
  await expect(page.locator("#g-d")).toBeChecked();
  await expect(page.locator("#v-n")).toBeChecked();
  const fields = result.data.observation.fields;
  expect(fields.filter((field: { protected: boolean }) => field.protected)).toEqual([]);
});

test("on Ashby each write waits for its save, so saves never overlap", async () => {
  const ashbyOrigin = atsOrigins[3];
  // Ashby saves every field to its server as it changes; overlapping saves
  // lose each other there. This endpoint is slow on purpose.
  await context.route(`${ashbyOrigin}/api/non-user-graphql**`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({ contentType: "application/json", body: '{"data":{}}' });
  });
  await context.route(`${ashbyOrigin}/acme/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Apply</title><form>
        <label for="a">Name</label><input id="a">
        <label for="b">Email</label><input id="b" type="email">
        <label for="c">City</label><input id="c">
      </form>
      <script>
        window.inFlight = 0; window.maxInFlight = 0; window.saved = 0;
        document.addEventListener('change', async () => {
          window.inFlight++; window.maxInFlight = Math.max(window.maxInFlight, window.inFlight);
          await fetch('/api/non-user-graphql?op=ApiSetFormValue', { method: 'POST', body: '{}' });
          window.inFlight--; window.saved++;
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${ashbyOrigin}/acme/pace/application`);
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const applicationId = crypto.randomUUID();
  const bound = await content(page, {
    type: "BIND",
    applicationId,
    operation: 1,
    locks: [],
  });
  const values: Record<string, string> = { Name: "Alex Fixture", Email: "alex@example.test", City: "Phoenix" };
  const result = await content(page, {
    type: "APPLY",
    applicationId,
    operation: 1,
    documentId: bound.data.documentId,
    proposals: bound.data.fields.map((field: { id: string; label: string; revision: number }) => ({
      fieldId: field.id,
      revision: field.revision,
      expectedValue: "",
      value: values[field.label],
      source: "fixture",
    })),
  });
  expect(result.data.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, true]);
  await expect.poll(() => page.evaluate(() => (window as any).saved)).toBe(3);
  expect(await page.evaluate(() => (window as any).maxInFlight)).toBe(1);
});

test("a field's own character limit is reported for written answers", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/max-length`);
  await page.locator("form").evaluate((form) => {
    form.innerHTML = `<label for="why">Why are you interested in this role?</label><textarea id="why" maxlength="500"></textarea>
      <label for="about">Anything else?</label><textarea id="about"></textarea>`;
  });
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const bound = await content(page, {
    type: "BIND",
    applicationId: crypto.randomUUID(),
    operation: 1,
    locks: [],
  });
  expect(
    bound.data.fields.map((field: { label: string; maxLength?: number }) => [field.label, field.maxLength]),
  ).toEqual([
    ["Why are you interested in this role?", 500],
    ["Anything else?", undefined],
  ]);
});

test("the profile tab names answers that disagree with the tailoring notes", async () => {
  // A tailoring folder whose preferences put home base elsewhere than the
  // test profile's Phoenix.
  const checkout = await scratch("lane-tailoring-");
  await mkdir(join(checkout, "resumes"), { recursive: true });
  await writeFile(join(checkout, "profile.md"), "## Experience\n- Built things.\n");
  await writeFile(join(checkout, "preferences.md"), "## Logistics (confirmed)\n- **Home base:** Tucson, AZ.\n");
  appConfig.tailorDir = checkout;
  try {
    await panel.bringToFront();
    await showDashboard("profile");
    const banner = panel.getByRole("status", { name: "Profile disagreements" });
    await expect(banner).toContainText("disagree");
    await expect(banner).toContainText("Home city: here “Phoenix”, preferences.md “Tucson, AZ.”");
  } finally {
    delete appConfig.tailorDir;
    await showPanel();
  }
});

test("a toggle choice that would submit its form is never clicked", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/toggle-submit`);
  let submitted = false;
  await page.exposeFunction("markSubmitted", () => (submitted = true));
  await page.locator("form").evaluate((form) => {
    form.innerHTML = `<fieldset><legend>Are you authorized to work in the United States?</legend>
      <div class="choice"><button type="submit" aria-pressed="false">Yes</button><button type="submit" aria-pressed="false">No</button></div>
    </fieldset>`;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      (window as unknown as { markSubmitted: () => void }).markSubmitted();
    });
  });
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
    tabId,
  );
  const applicationId = crypto.randomUUID();
  const bound = await content(page, {
    type: "BIND",
    applicationId,
    operation: 1,
    locks: [],
  });
  const [question] = bound.data.fields;
  expect(question.label).toBe("Are you authorized to work in the United States?");
  const result = await content(page, {
    type: "APPLY",
    applicationId,
    operation: 1,
    documentId: bound.data.documentId,
    proposals: [
      {
        fieldId: question.id,
        revision: question.revision,
        expectedValue: "",
        value: "Yes",
        source: "fixture",
      },
    ],
  });
  expect(result.data.results[0]).toMatchObject({ ok: false, reason: expect.stringContaining("submit button") });
  expect(submitted).toBe(false);
  await expect(page.locator("button", { hasText: "Yes" })).toHaveAttribute("aria-pressed", "false");
});

test("older content scripts request a safe refresh before any field writes", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/old-engine`);
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((t) => t.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          (window as any).__applicationLane = { inspect() {} };
          chrome.runtime.onMessage.addListener((message, _, respond) => {
            if (message.type === "ENGINE_INFO")
              respond({ ok: true, data: { version: "older-engine" } });
          });
        },
      }),
    tabId,
  );
  await panel.bringToFront();
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0].status)
    .toBe("awaiting-user");
  expect((await state()).applications[0].missing.join(" ")).toContain(
    "Save any unsaved edits, reload Application Lane in chrome://extensions, refresh the application page",
  );
  await expect(page.locator('[name="email"]')).toHaveValue("");
});

test("delayed accessible dropdowns preserve selected values and stop immediately for trusted edits", async () => {
  const pages: Page[] = [];
  for (const mode of ["success", "editing", "unsafe", "duplicate", "attention"]) {
    const page = await context.newPage();
    await page.goto(`${origin}/dropdown-${mode}`);
    await page.evaluate((mode) => {
      const native = document.querySelector('[name="country"]')!;
      const shell = document.createElement("div");
      shell.className = "select__container";
      shell.innerHTML = `<label id="country-label">Country</label>${mode === "unsafe" ? '<button role="combobox" aria-labelledby="country-label" aria-expanded="false" data-placeholder="true">Select…</button>' : '<input role="combobox" aria-labelledby="country-label" aria-expanded="false">'}<input required tabindex="-1" aria-hidden="true">`;
      native.closest("label")!.replaceWith(shell);
      const input = shell.querySelector<HTMLElement>('[role="combobox"]')!;
      (window as any).choiceClicks = 0;
      input.addEventListener("mousedown", () => {
        if (mode === "unsafe") return;
        // Ashby applies focus after its opening handler returns. The engine
        // must own this delayed focus while still stopping for real edits.
        if (mode !== "attention") setTimeout(() => input.focus(), 100);
        input.setAttribute("aria-expanded", "true");
        input.setAttribute("aria-controls", "countries");
        document.body.dataset.opened = "true";
        const render = () => {
          const list = document.createElement("div");
          list.id = "countries";
          list.role = "listbox";
          list.innerHTML =
            '<div role="option">United States</div>' +
            (mode === "duplicate"
              ? '<div role="option">United States</div>'
              : "");
          list
            .querySelectorAll<HTMLElement>('[role="option"]')
            .forEach((option) =>
              option.addEventListener("click", () => {
                (window as any).choiceClicks++;
                const value = document.createElement("div");
                value.className = "select__single-value";
                value.textContent = "United States";
                shell.append(value);
                input.setAttribute("aria-expanded", "false");
                list.remove();
              }),
            );
          shell.append(list);
        };
        // A trusted key on the body need not edit any field. Focus applied by
        // the site after that attention must not be claimed by automation.
        if (mode === "attention") {
          document.addEventListener("keydown", (event) => {
            if (!event.isTrusted) return;
            input.focus();
            render();
          }, { once: true });
          return;
        }
        // The "editing" page presents its options only once the human edit has
        // landed. A fixed delay races with that edit under load, and the engine
        // then legitimately picks an option before any edit exists.
        if (mode !== "editing") {
          setTimeout(render, mode === "success" ? 2000 : 100);
          return;
        }
        const waitForEdit = setInterval(() => {
          const email =
            document.querySelector<HTMLInputElement>('[name="email"]');
          if (!email?.value.startsWith("human@")) return;
          clearInterval(waitForEdit);
          render();
        }, 50);
      });
    }, mode);
    pages.push(page);
  }
  await panel.bringToFront();
  for (const page of pages) await background(page);
  await enqueue(pages);
  await expect
    .poll(async () => {
      if (await pages[1].locator("body").getAttribute("data-opened"))
        return true;
      const app = (await state()).applications[1];
      if (["failed", "awaiting-user", "ready"].includes(app.status))
        throw new Error(
          `Dropdown did not open: ${JSON.stringify({ note: app.note, missing: app.missing, observation: (await content(pages[1], { type: "INSPECT" })).data.fields.filter((f: { label: string }) => f.label === "Country") })}`,
        );
      return false;
    })
    .toBe(true);
  await pages[1].bringToFront();
  await pages[1].locator('[name="email"]').fill("human@example.test");
  await expect(pages[4].locator("body")).toHaveAttribute("data-opened", "true");
  await pages[4].bringToFront();
  await pages[4].evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  await pages[4].keyboard.press("ArrowRight");
  await expect
    .poll(async () => (await state()).applications.map((a) => a.status), {
      timeout: 30000,
    })
    .toEqual(["ready", "paused", "awaiting-user", "awaiting-user", "awaiting-user"]);
  expect(await pages[0].evaluate(() => (window as any).choiceClicks)).toBe(1);
  await expect(pages[0].locator(".select__single-value")).toHaveText(
    "United States",
  );
  await expect(pages[1].locator('[name="email"]')).toHaveValue(
    "human@example.test",
  );
  for (const page of pages.slice(1))
    expect(await page.evaluate(() => (window as any).choiceClicks)).toBe(0);
  expect((await state()).applications[2].missing.join(" ")).toContain(
    "could navigate or submit",
  );
  expect((await state()).applications[3].missing.join(" ")).toContain(
    "duplicate matching options",
  );
  for (const page of pages)
    expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
  expect(
    await pages[1]
      .locator('[name="resume"]')
      .evaluate((e: HTMLInputElement) => e.files?.length),
  ).toBe(0);
});

for (const fieldPath of ["_systemfield_location", "0d93dbbe-396f-43c0-a6f3-9d16960f9ba7"]) {
test(`Ashby location searches select only an exact owned option and never retain an unselected query (${fieldPath})`, async () => {
  const pages: Page[] = [];
  for (const mode of ["success", "missing", "duplicate", "editing"]) {
    const page = await context.newPage();
    await page.goto(`${origin}/ashby-location-search-${mode}`);
    await page.evaluate(({ mode, fieldPath }) => {
      const shell = document.createElement("div");
      shell.className = "ashby-application-form-field-entry";
      shell.dataset.fieldPath = fieldPath;
      shell.innerHTML = '<label for="current-location">Current Location</label><input id="current-location" class="ashby-application-form-input-autocomplete" role="combobox" aria-autocomplete="list" aria-expanded="false" required>';
      document.querySelector('[name="country"]')!.closest("label")!.replaceWith(shell);
      const input = shell.querySelector<HTMLInputElement>("input")!;
      (window as any).choiceClicks = 0;
      (window as any).locationSearches = [];
      input.addEventListener("input", () => {
        shell.querySelector('[role="listbox"]')?.remove();
        if (!input.value) {
          input.setAttribute("aria-expanded", "false");
          input.removeAttribute("aria-controls");
          return;
        }
        (window as any).locationSearches.push(input.value);
        input.setAttribute("aria-expanded", "true");
        input.setAttribute("aria-controls", ":locations:");
        const render = () => {
          const list = document.createElement("div");
          list.id = ":locations:";
          list.role = "listbox";
          const labels = mode === "missing" ? ["Other", "Phoenixville, United States"]
            : mode === "duplicate" ? ["Phoenix, United States", "Phoenix, United States"]
              : ["Phoenix, United States", "Phoenixville, United States"];
          for (const label of labels) {
            const option = document.createElement("div");
            option.role = "option";
            option.textContent = label;
            option.addEventListener("click", () => {
              (window as any).choiceClicks++;
              input.value = label;
              input.setAttribute("aria-expanded", "false");
              list.remove();
            });
            list.append(option);
          }
          shell.append(list);
        };
        if (mode !== "editing") setTimeout(render, 100);
        else {
          const wait = setInterval(() => {
            if (!document.querySelector<HTMLInputElement>('[name="email"]')?.value.startsWith("human@")) return;
            clearInterval(wait);
            render();
          }, 50);
        }
      });
    }, { mode, fieldPath });
    pages.push(page);
  }
  await panel.bringToFront();
  for (const page of pages) await background(page);
  await enqueue(pages);
  await expect(pages[3].locator("#current-location")).toHaveValue("Phoenix");
  await pages[3].bringToFront();
  await pages[3].locator('[name="email"]').fill("human@example.test");
  await expect.poll(async () => (await state()).applications.map(a => a.status), { timeout: 30000 })
    .toEqual(["ready", "awaiting-user", "awaiting-user", "paused"]);
  await expect(pages[0].locator("#current-location")).toHaveValue("Phoenix, United States");
  expect(await pages[0].evaluate(() => (window as any).choiceClicks)).toBe(1);
  for (const page of pages.slice(1)) expect(await page.evaluate(() => (window as any).choiceClicks)).toBe(0);
  for (const page of pages.slice(1, 3)) await expect(page.locator("#current-location")).toHaveValue("");
  await expect(pages[3].locator('[name="email"]')).toHaveValue("human@example.test");
  for (const page of pages) {
    expect(await page.evaluate(() => (window as any).locationSearches.every((s: string) => s === "Phoenix"))).toBe(true);
    expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
  }
  const paused = (await content(pages[3], { type: "INSPECT" })).data.fields.find((f: { label: string }) => f.label === "Current Location");
  expect(paused.value).toBe("");
});
}

test("a combobox that opens on focus and lists plain-button options is chosen from, searching once only when its list lacks the answer", async () => {
  // C3 AI's own form over Greenhouse (046094a1bc36): a press does not open
  // the list, options are <button type="button" role="option">, and the school
  // list asks the server for what is typed.
  const pages: Page[] = [];
  for (const mode of ["listed", "searched", "missing"]) {
    const page = await context.newPage();
    await page.goto(`${origin}/focus-combobox-${mode}`);
    await page.evaluate((mode) => {
      const shell = document.createElement("div");
      shell.className = "control typeahead";
      shell.innerHTML = '<label for="where">Current Location</label><input id="where" class="typeahead-input" role="combobox" aria-autocomplete="list" aria-controls="where-listbox" aria-expanded="false" required>';
      document.querySelector('[name="country"]')!.closest("label")!.replaceWith(shell);
      const input = shell.querySelector<HTMLInputElement>("input")!;
      (window as any).choiceClicks = 0;
      (window as any).searches = [];
      const render = (labels: string[]) => {
        shell.querySelector('[role="listbox"]')?.remove();
        const list = document.createElement("div");
        list.id = "where-listbox";
        list.setAttribute("role", "listbox");
        for (const label of labels) {
          const option = document.createElement("button");
          option.type = "button";
          option.setAttribute("role", "option");
          option.textContent = label;
          option.addEventListener("click", () => {
            (window as any).choiceClicks++;
            input.value = label;
            input.setAttribute("aria-expanded", "false");
            list.remove();
          });
          list.append(option);
        }
        shell.append(list);
        input.setAttribute("aria-expanded", "true");
      };
      const first = mode === "listed" ? ["Other", "Phoenix, United States"] : ["Other", "Austin, United States"];
      input.addEventListener("focus", () => render(first));
      input.addEventListener("blur", () => setTimeout(() => {
        shell.querySelector('[role="listbox"]')?.remove();
        input.setAttribute("aria-expanded", "false");
      }, 150));
      input.addEventListener("input", () => {
        if (!input.value) return render(first);
        (window as any).searches.push(input.value);
        setTimeout(() => render(mode === "searched" ? ["Phoenix, United States", "Phoenixville, United States"] : ["Other"]), 100);
      });
    }, mode);
    pages.push(page);
  }
  await panel.bringToFront();
  for (const page of pages) await background(page);
  await enqueue(pages);
  await expect.poll(async () => (await state()).applications.map(a => a.status), { timeout: 30000 })
    .toEqual(["ready", "ready", "awaiting-user"]);
  await expect(pages[0].locator("#where")).toHaveValue("Phoenix, United States");
  await expect(pages[1].locator("#where")).toHaveValue("Phoenix, United States");
  await expect(pages[2].locator("#where")).toHaveValue("");
  expect(await pages[0].evaluate(() => (window as any).searches)).toEqual([]);
  expect(await pages[1].evaluate(() => (window as any).searches)).toEqual(["Phoenix"]);
  expect(await pages[2].evaluate(() => (window as any).searches)).toEqual(["Phoenix"]);
  expect(await Promise.all(pages.map(page => page.evaluate(() => (window as any).choiceClicks)))).toEqual([1, 1, 0]);
  for (const page of pages) expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

test("Ashby and Rippling dropdowns are read by their own question, opened the way each opens, and closed again when nothing fits", async () => {
  // Ashby (009277eebc70): a custom dropdown sits in a fieldset, lists its
  // options only from its arrow, and an open list hides every other question.
  // Rippling (3f1d8d729174): the question is written above the field, the
  // control is named only "Select", and it opens on a click.
  const pages: Page[] = [];
  for (const mode of ["ashby", "ashby-missing", "rippling", "rippling-radio"]) {
    const page = await context.newPage();
    await page.goto(`${origin}/listed-dropdown-${mode}`);
    await page.evaluate((mode) => {
      const old = document.querySelector('[name="country"]')!.closest("label")!;
      (window as any).choiceClicks = 0;
      const labels = mode === "ashby-missing" ? ["Canada", "Mexico"] : ["Canada", "United States"];
      const shell = document.createElement(mode === "rippling" ? "div" : "fieldset");
      const listed = (control: HTMLElement, id: string, close: () => void, chosen: (label: string) => void) => {
        const list = document.createElement("div");
        list.id = id;
        list.setAttribute("role", "listbox");
        for (const label of labels) {
          const option = document.createElement("div");
          option.setAttribute("role", "option");
          option.textContent = label;
          option.addEventListener("click", () => { (window as any).choiceClicks++; chosen(label); close(); });
          list.append(option);
        }
        return list;
      };
      if (mode === "rippling-radio") {
        // Each option is an ARIA radio drawn around a native one, named
        // through the native input; the question is above the field.
        shell.innerHTML = '<div><p>Country</p></div><div data-testid="field"><div data-testid="customQuestions.a.c" role="radiogroup">' + labels.map((label, i) =>
          `<div role="radio" data-value="${label}" aria-checked="false" tabindex="0"><input type="radio" name="customQuestions.a.c" value="${label}" aria-labelledby="label-customQuestions.a.c-${i}"><div id="label-customQuestions.a.c-${i}"><p>${label}</p></div></div>`).join("") + "</div></div>";
        old.replaceWith(shell);
        for (const radio of shell.querySelectorAll<HTMLInputElement>("input"))
          radio.addEventListener("click", () => {
            (window as any).choiceClicks++;
            for (const wrapper of shell.querySelectorAll('[role="radio"]')) wrapper.setAttribute("aria-checked", String(wrapper.contains(radio)));
          });
        return;
      }
      if (mode === "rippling") {
        shell.innerHTML = '<div><p>Country</p></div><div data-testid="field"><div data-testid="customQuestions.a.b"><div data-testid="select-controller"><div id="pick" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-label="Select" aria-required="true" tabindex="0"><p>Select</p></div></div></div></div>';
        old.replaceWith(shell);
        const control = shell.querySelector<HTMLElement>("#pick")!;
        const close = () => { document.getElementById("pick-list")?.remove(); control.setAttribute("aria-expanded", "false"); control.removeAttribute("aria-controls"); };
        control.addEventListener("click", () => {
          if (control.getAttribute("aria-expanded") === "true") return;
          control.setAttribute("aria-expanded", "true");
          control.setAttribute("aria-controls", "pick-list");
          shell.append(listed(control, "pick-list", close, (label) => { control.querySelector("p")!.textContent = label; }));
        });
        document.addEventListener("mousedown", (event) => { if (!shell.contains(event.target as Node)) close(); });
        return;
      }
      shell.className = "_fieldEntry_test";
      shell.innerHTML = '<label class="ashby-application-form-question-title _required_x" for="no-such-id">Country</label><div><input id="pick" class="ashby-application-form-input-autocomplete" placeholder="Start typing..." aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox" role="combobox"><button></button></div>';
      // Ashby's application is not a <form>: its arrow can submit nothing.
      old.remove();
      document.body.append(shell);
      const input = shell.querySelector<HTMLInputElement>("input")!;
      const others = () => [...document.querySelectorAll<HTMLElement>("form label")].filter((label) => !shell.contains(label));
      const close = () => {
        document.getElementById("pick-list")?.remove();
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-controls");
        for (const other of others()) other.removeAttribute("aria-hidden");
      };
      shell.querySelector("button")!.addEventListener("click", () => {
        if (input.getAttribute("aria-expanded") === "true") return close();
        input.setAttribute("aria-expanded", "true");
        input.setAttribute("aria-controls", "pick-list");
        for (const other of others()) other.setAttribute("aria-hidden", "true");
        shell.append(listed(input, "pick-list", close, (label) => { input.value = label; }));
        setTimeout(() => input.focus(), 20);
      });
      input.addEventListener("input", () => {
        document.getElementById("pick-list")?.remove();
        const empty = document.createElement("div");
        empty.id = "pick-list";
        empty.setAttribute("role", "listbox");
        shell.append(empty);
      });
    }, mode);
    pages.push(page);
  }
  await panel.bringToFront();
  for (const page of pages) await background(page);
  await enqueue(pages);
  await expect.poll(async () => (await state()).applications.map(a => a.status), { timeout: 40000 })
    .toEqual(["ready", "awaiting-user", "ready", "ready"]);
  await expect(pages[0].locator("#pick")).toHaveValue("United States");
  await expect(pages[2].locator("#pick")).toHaveText("United States");
  // Nothing fitted: the list is closed again, so no other question is hidden,
  // and no search text is left behind.
  await expect(pages[1].locator("#pick")).toHaveValue("");
  await expect(pages[1].locator("#pick")).toHaveAttribute("aria-expanded", "false");
  expect(await pages[1].evaluate(() => document.querySelectorAll('[aria-hidden="true"]').length)).toBe(0);
  expect((await state()).applications[1].missing.join(" ")).toMatch(/Country/);
  await expect(pages[3].locator('[role="radio"][data-value="United States"]')).toHaveAttribute("aria-checked", "true");
  await expect(pages[3].locator('[role="radio"][data-value="Canada"]')).toHaveAttribute("aria-checked", "false");
  expect(await Promise.all(pages.map(page => page.evaluate(() => (window as any).choiceClicks)))).toEqual([1, 0, 1, 1]);
  for (const page of pages) expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

test("trusted edits pause one tab while another finishes; cleared edits survive resume and rerender", async () => {
  generatorDelay = 1600;
  const a = await context.newPage();
  await a.goto(`${origin}/edit-a`);
  const b = await context.newPage();
  await b.goto(`${origin}/edit-b`);
  await enqueue([a, b]);
  await expect(a.locator("[name=email]")).toHaveValue(profile.email);
  await a.bringToFront();
  await a.locator("[name=email]").fill("human@example.test");
  await expect
    .poll(async () => (await state()).applications[0].status)
    .toBe("paused");
  await expect
    .poll(async () => (await state()).applications[1].status, {
      timeout: 25000,
    })
    .toBe("ready");
  await expect(a.locator("[name=email]")).toHaveValue("human@example.test");
  expect(
    await a
      .locator("[name=resume]")
      .evaluate((e: HTMLInputElement) => e.files?.length),
  ).toBe(0);
  await a.locator("[name=email]").fill("");
  await a.evaluate(() => {
    const input = document.querySelector("[name=email]")!;
    input.replaceWith(input.cloneNode(true));
  });
  await panel.bringToFront();
  const id = (await state()).applications[0].id;
  await ui({ type: "RESUME_APP", id });
  await expect
    .poll(async () => (await state()).applications[0].status, {
      timeout: 25000,
    })
    .toBe("awaiting-user");
  await expect(a.locator("[name=email]")).toHaveValue("");
  // Left alone because the applicant cleared it, and the item says so.
  expect((await state()).applications[0].missing).toContainEqual(
    expect.stringMatching(/^Required: Email \(left alone: .*a real input on "Email"/),
  );
  expect(submitted).toBe(0);
});

test("rejects stale operations and wrong-application artifacts; preserves existing values", async () => {
  const a = await context.newPage();
  await a.goto(`${origin}/stale`);
  await a.locator("[name=email]").fill("existing@example.test");
  await enqueue([a]);
  await expect
    .poll(async () => (await state()).applications[0].status, {
      timeout: 25000,
    })
    .toBe("ready");
  await expect(a.locator("[name=email]")).toHaveValue("existing@example.test");
  const app = (await state()).applications[0];
  const snapshot = await content(a, {
    type: "INSPECT",
    applicationId: app.id,
    operation: app.operation,
  });
  const bad = await content(a, {
    type: "APPLY",
    applicationId: app.id,
    operation: app.operation - 1,
    documentId: snapshot.data.documentId,
    proposals: [],
  });
  expect(bad.ok).toBe(false);
  const wrong = await content(a, {
    type: "ATTACH",
    applicationId: app.id,
    operation: app.operation,
    documentId: snapshot.data.documentId,
    fieldId: "resume",
    revision: 0,
    expectedValue: "",
    artifact: {
      ...app.artifacts[0],
      applicationId: crypto.randomUUID(),
      data: "",
    },
  });
  expect(wrong.ok).toBe(false);
  expect(submitted).toBe(0);
});

test("unknown eligibility stays unanswered and cancelling discards delayed generation", async () => {
  generatorDelay = 1300;
  const a = await context.newPage();
  await a.goto(`${origin}/sensitive`);
  await enqueue([a]);
  await expect
    .poll(async () => (await state()).applications[0].status, {
      timeout: 25000,
    })
    .toBe("awaiting-user");
  await expect(a.locator("[name=visa]")).toHaveValue("");
  const b = await context.newPage();
  await b.goto(`${origin}/cancel`);
  await enqueue([b]);
  await expect(b.locator("[name=email]")).toHaveValue(profile.email);
  await ui({ type: "CANCEL_APP", id: (await state()).applications[1].id });
  await new Promise((r) => setTimeout(r, 1800));
  expect((await state()).applications[1].status).toBe("cancelled");
  expect(
    await b
      .locator("[name=resume]")
      .evaluate((e: HTMLInputElement) => e.files?.length),
  ).toBe(0);
  expect(submitted).toBe(0);
});

test("fills permitted frames, accessible shadow roots, custom selects, and repeated employment rows", async () => {
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      linkedin: "https://linkedin.com/in/alex-fixture",
      work: [
        {
          organization: "First Co",
          title: "Engineer",
          startDate: "2020-01",
          endDate: "2022-12",
          details: "",
          location: "",
        },
        {
          organization: "Second Co",
          title: "Senior Engineer",
          startDate: "2023-01",
          endDate: "",
          details: "",
          location: "",
        },
      ],
    },
  });
  const a = await context.newPage();
  await a.goto(`${origin}/frames`);
  await a.evaluate((origin) => {
    document.querySelector("form")!.remove();
    const iframe = document.createElement("iframe");
    iframe.src = `${origin}/embedded`;
    iframe.style.cssText = "width:800px;height:1500px";
    document.querySelector("main")!.append(iframe);
  }, origin);
  const frame = a.frameLocator("iframe");
  await expect(frame.locator("form")).toBeVisible();
  await a.frames()[1].evaluate(() => {
    const form = document.querySelector("form")!;
    const host = document.createElement("div");
    form.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<label>LinkedIn URL<input name="linkedin"></label>';
    for (let i = 0; i < 2; i++) {
      const group = document.createElement("fieldset");
      group.innerHTML =
        '<legend>Work experience</legend><label>Company<input name="company"></label><label>Job title<input name="title"></label>';
      form.append(group);
    }
    const select = document.querySelector("select[name=country]")!;
    const combo = document.createElement("div");
    combo.innerHTML =
      '<button type="button" role="combobox" aria-label="Country" aria-controls="countries" aria-expanded="false" data-placeholder="true">Select country</button><div id="countries" role="listbox" hidden><div role="option">United States</div></div>';
    select.closest("label")!.replaceWith(combo);
    const button = combo.querySelector("button")!;
    const list = combo.querySelector<HTMLElement>("[role=listbox]")!;
    button.addEventListener("click", () => {
      list.hidden = false;
      button.setAttribute("aria-expanded", "true");
    });
    list
      .querySelector<HTMLElement>("[role=option]")!
      .addEventListener("click", () => {
        button.setAttribute("aria-valuetext", "United States");
        button.setAttribute("data-placeholder", "false");
        button.textContent = "United States";
        list.hidden = true;
        button.setAttribute("aria-expanded", "false");
      });
  });
  await panel.bringToFront();
  await enqueue([a]);
  await expect
    .poll(async () => (await state()).applications[0].status, {
      timeout: 25000,
    })
    .toBe("ready");
  await expect(frame.locator("[name=email]")).toHaveValue(profile.email);
  await expect(frame.locator("[name=linkedin]")).toHaveValue(
    "https://linkedin.com/in/alex-fixture",
  );
  await expect(frame.locator("[name=company]").nth(0)).toHaveValue("First Co");
  await expect(frame.locator("[name=company]").nth(1)).toHaveValue("Second Co");
  await expect(frame.locator("[role=combobox]")).toHaveText("United States");
  expect(submitted).toBe(0);
});

test("worker termination pauses in-flight work and resume safely reconciles the page", async () => {
  generatorDelay = 2200;
  const a = await context.newPage();
  await a.goto(`${origin}/restart`);
  await enqueue([a]);
  await expect(a.locator("[name=email]")).toHaveValue(profile.email);
  const cdp = await context.newCDPSession(panel);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await expect
    .poll(async () => (await state()).applications[0].status)
    .toBe("paused");
  await expect(a.locator("[name=email]")).toHaveValue(profile.email);
  await ui({ type: "RESUME_APP", id: (await state()).applications[0].id });
  await expect
    .poll(async () => (await state()).applications[0].status, {
      timeout: 25000,
    })
    .toBe("ready");
  expect(submitted).toBe(0);
});

test("ATS fixtures use packaged adapters but leave every Next step to the user", async () => {
  const names = ["Workday", "Greenhouse", "Lever", "Ashby", "iCIMS"];
  const nextAttrs = [
    'data-automation-id="bottom-navigation-next-button"',
    'data-testid="next-button"',
    'data-qa="next"',
    'data-testid="next-button"',
    'data-action="next"',
  ];
  for (let i = 0; i < atsOrigins.length; i++) {
    await context.route(`${atsOrigins[i]}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: html(`/ats-${i}`)
          .replace(
            '<button type="submit">Submit application</button>',
            `<button type="button" ${nextAttrs[i]} id="safe-next">Next</button>`,
          )
          .replace(
            "</script>",
            `document.querySelector('#safe-next').addEventListener('click',()=>{document.querySelector('#safe-next').outerHTML='<button type="submit">Submit application</button>';const label=document.createElement('label');label.innerHTML='City<input name="city">';document.querySelector('form').append(label)});</script>`,
          ),
      }),
    );
  }
  const pages: Page[] = [];
  for (const url of atsOrigins) {
    const page = await context.newPage();
    await page.goto(`${url}/job`);
    pages.push(page);
  }
  await panel.bringToFront();
  await enqueue(pages);
  await expect
    .poll(async () => (await state()).applications.map((a) => a.status), {
      timeout: 45000,
    })
    .toEqual(names.map(() => "awaiting-user"));
  const apps = (await state()).applications;
  expect(apps.map((a) => a.ats)).toEqual(names);
  expect(apps.every((a) => a.steps === 0)).toBe(true);
  for (const page of pages) {
    await expect(page.locator("[name=email]")).toHaveValue(profile.email);
    await expect(page.locator("#safe-next")).toBeVisible();
    await expect(page.locator("[name=city]")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
  }
});

// Lever's location box as its own script runs it (retrieveLocations.js,
// 2026-10-08): typing shows the list, a key press searches after half a
// second, mousedown on a result picks it, and leaving the box with the list
// still open empties the box and the pick.
const leverLocationPage = `<!doctype html><html><head><title>Acme - Frontend Engineer</title></head><body>
<form id="application-form" method="POST" enctype="multipart/form-data" onsubmit="window.submissions++; return false"><ul>
<li class="application-question"><label><div class="application-label">Full name <span class="required">✱</span></div><div class="application-field"><input type="text" name="name" required></div></label></li>
<li class="application-question"><label><div class="application-label">Email <span class="required">✱</span></div><div class="application-field"><input type="email" name="email" required></div></label></li>
<li class="application-question" data-qa="structured-contact-location-question"><label><div class="application-label">Current location <span class="required">✱</span></div><div class="application-field"><input class="location-input" id="location-input" type="text" maxlength="100" name="location" required><input id="selected-location" type="hidden" name="selectedLocation"><div class="dropdown-container" style="display:none"><div class="dropdown-results"></div><div class="dropdown-no-results" style="display:none">No location found. Try entering a different location</div></div></div></label></li>
</ul><button type="submit">Submit application</button></form>
<script>
  window.submissions = 0; window.timeline = [];
  const input = document.getElementById("location-input"), selected = document.getElementById("selected-location");
  const box = document.querySelector(".dropdown-container"), results = document.querySelector(".dropdown-results");
  const note = (what) => window.timeline.push(Math.round(performance.now()) + " " + what + " box=" + input.value + " picked=" + Boolean(selected.value));
  let found, timer;
  const empty = () => { results.innerHTML = ""; found = undefined; };
  input.addEventListener("input", () => { note("input"); box.style.display = "flex"; });
  input.addEventListener("keydown", (event) => {
    note("keydown " + event.key);
    if (/^Arrow|^Enter$/.test(event.key)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      empty();
      const asked = input.value;
      if (!asked) return;
      note("search");
      setTimeout(() => {
        found = [{ name: asked.split(",")[0] + ", AZ, USA", id: "first" }];
        results.innerHTML = found.map((place, index) => '<div class="dropdown-location" id="location-' + index + '">' + place.name + "</div>").join("");
        note("results");
      }, 250);
    }, 500);
  });
  input.addEventListener("blur", () => {
    note("blur");
    if (box.style.display === "none") return;
    box.style.display = "none"; empty(); input.value = ""; selected.value = "";
  });
  document.addEventListener("mousedown", (event) => {
    if (!event.target.classList || !event.target.classList.contains("dropdown-location")) return;
    box.style.display = "none"; input.value = event.target.textContent;
    selected.value = JSON.stringify(found[event.target.id.split("-")[1]]); empty(); note("picked");
  });
</script></body></html>`;

test("Lever's location is picked from its search and still picked when the fill is done", async () => {
  await context.route("https://jobs.lever.co/**", (route) => route.fulfill({ contentType: "text/html", body: leverLocationPage }));
  const page = await context.newPage();
  await page.goto("https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000001/apply");
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  const seen = async () => ({
    box: await page.locator("#location-input").inputValue(),
    picked: await page.locator("#selected-location").inputValue(),
    timeline: await page.evaluate(() => (window as any).timeline),
  });
  await page.waitForTimeout(3000);
  const first = await seen();
  // The applicant asks for the step again (a redraft, a second look).
  const id = (await state()).applications[0].id;
  await ui({ type: "FILL_STEP", id });
  await page.waitForTimeout(1500);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  await page.waitForTimeout(3000);
  const after = await seen();
  // The second fill never touched the box: before, it cleared the pick and
  // typed again, and a pause in that moment left the city unpicked.
  expect(after.timeline).toEqual(first.timeline);
  expect(after, after.timeline.join("\n")).toMatchObject({ box: `${profile.city}, AZ, USA`, picked: JSON.stringify({ name: `${profile.city}, AZ, USA`, id: "first" }) });
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

// Reports on two Ashby forms, 2026-10-13: a box of a checkbox question was
// read as a question of its own. "Veteran" (one of several communities) was
// ticked for an applicant who is not one, and both degree boxes were ticked.
// Notion's (2026-10-30): a required one, "the locations you would be
// interested in relocating to", read as optional boxes listed one by one,
// and nothing ticked them for an applicant who will relocate anywhere.
test("an Ashby checkbox question keeps its boxes together: each carries the question, and only the answer is ticked", async () => {
  const group = (path: string, title: string, options: string[], required = false) =>
    `<div class="ashby-application-form-field-entry" data-field-path="${path}"><label class="ashby-application-form-question-title${required ? " _required_x" : ""}">${title}</label>${options
      .map((name, index) => `<div class="ashby-application-form-input-checkbox-group-option"><span><input type="checkbox" id="${path}-labeled-checkbox-${index}" name="${name}"></span><label for="${path}-labeled-checkbox-${index}" class="ashby-application-form-input-checkbox-group-option-label">${name}</label></div>`)
      .join("")}</div>`;
  await context.route("https://jobs.ashbyhq.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>Engineer @ Acme</title></head><body><form onsubmit="window.submissions++; return false">
        <div class="ashby-application-form-field-entry" data-field-path="_systemfield_email"><label class="ashby-application-form-question-title" for="email">Email</label><input id="email" name="email" type="email" required></div>
        ${group("degree", "Degree Type", ["Undergraduate/Bachelors", "Master's", "PhD", "MBA"])}
        ${group("communities", "Which of the following communities do you belong to? Please select all that apply.", ["Person with disability", "Neurodiverse", "Veteran", "Parent", "None of the above"])}
        ${group("relocate", "Please indicate all of the locations that you would be interested in relocating to for this position.", ["New York, NY", "San Francisco, CA"], true)}
        ${group("heard", "How did you hear about this opportunity? (select all that apply)", ["LinkedIn", "Referral"], true)}
        <button type="submit">Submit Application</button></form><script>window.submissions = 0;</script></body></html>`,
    }),
  );
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      veteranStatus: "I am not a veteran",
      answers: [{ question: "Are you willing to relocate?", answer: "Yes" }],
      education: [
        { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05-10", location: "East Lansing, Michigan" },
        { organization: "Virginia Tech", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "Blacksburg, Virginia" },
      ],
    },
  });
  const page = await context.newPage();
  await page.goto("https://jobs.ashbyhq.com/acme/00000000-0000-4000-8000-000000000003/application");
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  await expect(page.locator("#email")).toHaveValue(profile.email);
  // The degree in progress, none of the communities, and every place to
  // relocate to.
  await expect.poll(() => page.locator("input:checked").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).name))).toEqual(["Master's", "New York, NY", "San Francisco, CA"]);
  // A required question nothing answered is named once, by its question,
  // never box by box; one answered is not named at all.
  const missing = (await state()).applications[0].missing;
  expect(missing).toContain("Required: How did you hear about this opportunity? (select all that apply)");
  expect(missing.filter((item) => /LinkedIn|Referral|New York|San Francisco|relocating/.test(item))).toEqual([]);
  // And the card marks each question left as required or optional.
  const card = panel.getByRole("article").first();
  // The problems are folded until opened.
  await card.getByLabel("Problems to resolve").locator("summary").click();
  await expect(card.getByLabel("Problems to resolve").getByRole("listitem").filter({ hasText: "How did you hear" }).locator(".question-mark")).toHaveText("Required");
  await expect(card.locator(".app-notes li").filter({ hasText: "communities do you belong to" }).locator(".question-mark")).toHaveText("Optional");
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  const fields = (await ui({ type: "SCAN_TAB", tabId })).observation.fields as { label: string; question?: string }[];
  expect(fields.find((field) => field.label === "Veteran")?.question).toBe("Which of the following communities do you belong to? Please select all that apply.");
  expect(fields.find((field) => field.label === "Master's")?.question).toBe("Degree Type");
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

// Rippling's voluntary questions (report ee348448, 2026-11-01): each is a
// div that says "Select..." until answered and opens its list on a click.
// Its rule's opening click was refused as if the box were a list's empty
// "Select" choice, so Hispanic/Latino and Veteran Status were left blank.
test("Rippling's EEO dropdowns that read Select... are opened and answered", async () => {
  const question = (id: string, field: number, label: string, options: string[]) =>
    `<div><div data-testid="field"><div><span id="field-${field}-label">${label}</span></div><div><div data-testid="eeoc.${id}"><div><div data-testid="select-controller"><div><div id="field-${field}" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="field-${field}-label" aria-label="Select..." aria-required="false" tabindex="0" data-options="${options.join("|")}"><p>Select...</p></div></div><div><span aria-hidden="true"></span></div></div></div></div></div></div></div>`;
  await context.route(`${ripplingOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>Apply - Software Engineer Intern</title></head><body><form onsubmit="window.submissions++; return false">
        <label>Email<input id="email" name="email" type="email"></label>
        ${question("gender", 56, "Gender", ["Male", "Female", "Non-binary", "Choose not to disclose"])}
        ${question("hispanicOrLatino", 69, "Are you Hispanic/Latino?", ["Yes", "No", "Choose not to disclose"])}
        ${question("veteranStatus", 75, "Veteran Status", ["I identify as one or more of the classifications of protected veterans", "I am not a protected veteran", "Choose not to disclose"])}
        <button type="submit">Submit application</button></form>
        <script>
          window.submissions = 0;
          const closeAll = () => document.querySelectorAll('[role="combobox"]').forEach((box) => {
            box.closest('[data-testid^="eeoc."]').querySelector("ul")?.remove();
            box.setAttribute("aria-expanded", "false");
          });
          for (const box of document.querySelectorAll('[role="combobox"]')) {
            box.addEventListener("click", () => {
              if (box.getAttribute("aria-expanded") === "true") return;
              closeAll();
              box.setAttribute("aria-expanded", "true");
              const list = document.createElement("ul");
              list.setAttribute("role", "listbox");
              box.dataset.options.split("|").forEach((text, index) => {
                const option = document.createElement("li");
                option.id = box.id + "-list-option-" + index;
                option.setAttribute("role", "option");
                option.dataset.selectable = "true";
                option.textContent = text;
                option.addEventListener("click", () => { box.querySelector("p").textContent = text; closeAll(); });
                list.append(option);
              });
              box.closest('[data-testid^="eeoc."]').append(list);
            });
          }
          document.addEventListener("mousedown", (event) => { if (!event.target.closest('[data-testid^="eeoc."]')) closeAll(); });
        </script></body></html>`,
    }),
  );
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, gender: "Male", hispanic: "No", veteranStatus: "I am not a veteran" } });
  const page = await context.newPage();
  await page.goto(`${ripplingOrigin}/acme/jobs/2ba326f7-9259-47df-9f54-bef4ce5c5fb5/apply?step=application`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  await expect(page.locator("#field-56")).toHaveText("Male");
  await expect(page.locator("#field-69")).toHaveText("No");
  await expect(page.locator("#field-75")).toHaveText("I am not a protected veteran");
  expect((await state()).applications[0].missing.filter((item) => /Hispanic|Veteran|Gender/.test(item))).toEqual([]);
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

// Rippling's confirmation (2026-11-02): "You have successfully applied to
// Software Engineer Intern" on step=confirmation, outside the action card
// its rule looked in, so the application was never marked submitted.
test("Rippling's own confirmation step marks the application submitted", async () => {
  const apply = `${ripplingOrigin}/acme/jobs/7c0ffee0-0000-4000-8000-000000000001/apply?step=application`;
  await context.route(apply, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Apply - Software Engineer Intern</title><div id="app"><form onsubmit="return false">
        <label>Email<input name="email" type="email"></label><label>Phone<input name="phone"></label>
        <button type="submit">Apply</button></form></div>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(apply);
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  expect((await state()).applications[0].workflowStage).not.toBe("submitted");
  await page.evaluate(() => {
    history.pushState({}, "", location.href.replace("step=application", "step=confirmation"));
    document.getElementById("app")!.innerHTML = '<div><div>Confirmation</div><div><span aria-hidden="true">✓</span><div>You have successfully applied to Software Engineer Intern</div></div><button type="button">See all openings</button></div>';
  });
  await expect.poll(async () => (await state()).applications[0].workflowStage, { timeout: 20000 }).toBe("submitted");
});

// A report on a JazzHR form (Axtria, 2026-10-14): the sponsorship question
// was drawn as Yes, No and Other boxes, each named on its own, its <label>
// bound to the hidden input that collects them; and the school, major and
// degree were asked of one level of study each. Elucid's (capture c11a168d,
// 2026-10-30): the citizenship list's first choice, "No answer", read as an
// answer, and every question marked with JazzHR's asterisk read as optional.
test("a JazzHR form answers its level-of-study questions and ticks the sponsorship box the profile answers", async () => {
  const question = (id: number, label: string, control: string) =>
    `<div class="form-group"><label id="resumator-questionnaire-q${id}-label" for="resumator-questionnaire-q${id}" class="control-label">${label}<i class="asterisk">*</i></label>${control}</div>`;
  const select = (id: number, options: string[]) =>
    `<select id="resumator-questionnaire-q${id}" name="resumator-questionnaire[${id}]" class="form-control resumator-select-field"><option value="resumator_no_selection" selected>-- No answer --</option>${options.map((option) => `<option value="${option}">${option}</option>`).join("")}</select>`;
  const text = (id: number) => `<input type="text" id="resumator-questionnaire-q${id}" name="resumator-questionnaire[${id}]" class="form-control resumator-field">`;
  // The list names Virginia Tech officially; the profile by its common name.
  const schools = [...realSchools, "Other (US Based Schools)"];
  const boxes = ["Yes", "No", "Other (please explain below)"]
    .map((name, index) => `<label class="checkbox" for="resumator-checkbox-7-${index + 1}"><input type="checkbox" id="resumator-checkbox-7-${index + 1}" name="resumator-checkbox-7-${index + 1}" class="resumator-questionnaire-checkbox">${name}</label>`)
    .join("");
  await context.route(`${jazzOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>Analyst - Acme - Career Page</title></head><body><form onsubmit="window.submissions++; return false">
        <div class="form-group"><label for="resumator-email-value" class="control-label">Email Address</label><input id="resumator-email-value" name="resumator-email-value" type="email"></div>
        ${question(1, "Highest Degree Earned/Pursuing", select(1, ["Associate Degree", "Bachelor", "Master", "MBA", "PhD", "Others"]))}
        ${question(2, "Completion date of your highest degree (mm/yyyy)", text(2))}
        ${question(3, "Name of the School: Undergraduate Degree", select(3, schools))}
        ${question(4, "Field of Study / Major: Undergraduate Degree", text(4))}
        ${question(5, "Name of the School: Graduate/MBA/PhD Degree", select(5, schools))}
        ${question(6, "Field of Study: Graduate/MBA/PhD Degree", text(6))}
        <div class="form-group"><label id="resumator-citizen-label" for="resumator-citizen-value" class="control-label">What's your citizenship / employment eligibility?<i class="asterisk">*</i></label><select id="resumator-citizen-value" name="resumator-citizen-value" class="form-control"><option value="0" selected>No answer</option><optgroup label="United States"><option value="10">I am a U.S. Citizen/Permanent Resident</option><option value="20">Non-citizen allowed to work for any employer</option></optgroup><optgroup label="Canada"><option value="60">I am a Canadian Citizen/Permanent Resident</option></optgroup><option value="99">Other</option></select></div>
        ${question(8, "Are you available starting January 2027 through the end of the spring semester (May/June 2027)?", select(8, ["Yes", "No"]))}
        <div class="form-group"><label id="resumator-questionnaire-q7-label" for="resumator-questionnaire-q7" class="control-label">Will you in the future (beyond the expiration of your current visa status, such as F-1 student status with OPT eligibility), require sponsorship for employment visa status (such as H-1B, TN, O1 visa statuses, etc.) to work legally for our Company in the United States?<i class="asterisk">*</i></label><input type="hidden" id="resumator-questionnaire-q7" name="resumator-questionnaire[7]" class="resumator-questionnaire-checkbox-answer">${boxes}</div>
        <button type="submit">Submit Application</button></form><script>window.submissions = 0;</script></body></html>`,
    }),
  );
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      sponsorship: "No",
      workAuthorization: "US Citizen",
      education: [
        { organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05-10", location: "East Lansing, Michigan" },
        { organization: "Virginia Tech", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "Blacksburg, Virginia" },
      ],
    },
  });
  const page = await context.newPage();
  await page.goto(`${jazzOrigin}/apply/AbCdEf1234/Analyst`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  await expect(page.locator("#resumator-email-value")).toHaveValue(profile.email);
  await expect(page.locator("#resumator-questionnaire-q1")).toHaveValue("Master");
  await expect(page.locator("#resumator-questionnaire-q2")).toHaveValue("05/2099");
  await expect(page.locator("#resumator-questionnaire-q3")).toHaveValue("Virginia Polytechnic Institute and State University");
  await expect(page.locator("#resumator-questionnaire-q4")).toHaveValue("Computer Science");
  await expect(page.locator("#resumator-questionnaire-q5")).toHaveValue("Michigan State University");
  await expect(page.locator("#resumator-questionnaire-q6")).toHaveValue("Data Science");
  await expect.poll(() => page.locator("input:checked").evaluateAll((inputs) => inputs.map((input) => input.id))).toEqual(["resumator-checkbox-7-2"]);
  await expect(page.locator("#resumator-citizen-value")).toHaveValue("10");
  // A question nothing answered is required, as its asterisk says.
  const missing = (await state()).applications[0].missing;
  expect(missing).toContain("Required: Are you available starting January 2027 through the end of the spring semester (May/June 2027)?");
  expect(missing.filter((item) => /^Optional unanswered:/.test(item))).toEqual([]);
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

// The same form again (report 14eb9da9): the resume went into an input JazzHR
// keeps hidden until "Attach resume" is chosen, so the applicant saw none
// attached; and a school the list lacks was left, where the applicant wanted
// "Other" and the school's name in the box after it. Schools sharing its
// words (Virginia Tech Carilion School of Medicine, Virginia State
// University) are listed, and are not it.
test("a JazzHR form attaches the resume where it shows, and names an unlisted school under Other", async () => {
  await context.route(`${jazzOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>Analyst - Acme - Career Page</title><style>.none { display: none; }</style></head><body><form onsubmit="window.submissions++; return false">
        <div class="form-group"><label for="resumator-email-value" class="control-label">Email Address</label><input id="resumator-email-value" name="resumator-email-value" type="email"></div>
        <div id="resumator-resume" class="form-group"><label id="resumator-resume-label" for="resumator-resume-value" class="control-label">Resume<i class="asterisk">*</i></label>
          <div id="resumator-resume-options"><a id="resumator-choose-upload" href="#">Attach resume</a> or <a id="resumator-choose-paste" href="#">Paste resume</a></div>
          <div id="resumator-resume-upload-wrapper" class="none"><input type="file" id="resumator-resume-value" name="resumator-resume-value"></div></div>
        <div class="form-group"><label for="q3" class="control-label">Name of the School: Undergraduate Degree<i class="asterisk">*</i></label><select id="q3" name="resumator-questionnaire[3]"><option value="resumator_no_selection" selected>-- No answer --</option>${schoolsWithout("Virginia Polytechnic Institute and State University").map((school) => `<option>${school}</option>`).join("")}<option>Other (International Schools)</option><option>Other (US Based Schools)</option></select></div>
        <div class="form-group"><label for="q4" class="control-label">If you selected "OTHER" , please enter the full name of the school where you are pursuing your Undergraduate degree</label><input type="text" id="q4" name="resumator-questionnaire[4]"></div>
        <button type="submit">Submit Application</button></form><script>
        window.submissions = 0;
        document.getElementById('resumator-choose-upload').addEventListener('click', (event) => {
          event.preventDefault();
          document.getElementById('resumator-resume-upload-wrapper').classList.remove('none');
          document.getElementById('resumator-resume-options').style.display = 'none';
        });
      </script></body></html>`,
    }),
  );
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      education: [{ organization: "Virginia Tech", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "Blacksburg, Virginia" }],
    },
  });
  const page = await context.newPage();
  await page.goto(`${jazzOrigin}/apply/AbCdEf1234/Analyst`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect(page.locator("#q3")).toHaveValue("Other (US Based Schools)", { timeout: 45000 });
  await expect(page.locator("#q4")).toHaveValue("Virginia Tech");
  await expect.poll(() => page.locator("#resumator-resume-value").evaluate((input: HTMLInputElement) => input.files?.[0]?.name || ""), { timeout: 60000 }).toMatch(/resume.*\.pdf$/i);
  await expect(page.locator("#resumator-resume-value")).toBeVisible();
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

// The same form (Axtria, task 8135eb3d): JazzHR's "-- No answer --" choice,
// valued resumator_no_selection, read as an answer the site had given, so the
// experience questions were neither answered nor listed as unanswered.
test("a JazzHR list left on -- No answer -- reads as empty and is listed as unanswered", async () => {
  await context.route(`${jazzOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>Analyst - Acme - Career Page</title></head><body><form onsubmit="window.submissions++; return false">
        <div class="form-group"><label for="resumator-email-value" class="control-label">Email Address</label><input id="resumator-email-value" name="resumator-email-value" type="email"></div>
        <div class="form-group"><label id="resumator-questionnaire-q8-label" for="resumator-questionnaire-q8" class="control-label">Which best describes your experience with spreadsheet tools?<i class="asterisk">*</i></label><select id="resumator-questionnaire-q8" name="resumator-questionnaire[8]" class="form-control resumator-select-field"><option value="resumator_no_selection" selected>-- No answer --</option><option value="Little or none">Little or none</option><option value="Coursework">Coursework</option><option value="Projects in use">Projects in use</option></select></div>
        <button type="submit">Submit Application</button></form><script>window.submissions = 0;</script></body></html>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${jazzOrigin}/apply/AbCdEf1234/Analyst`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  await expect(page.locator("#resumator-email-value")).toHaveValue(profile.email);
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  const fields = (await ui({ type: "SCAN_TAB", tabId })).observation.fields as { label: string; value: string; options: string[] }[];
  const question = fields.find((field) => /spreadsheet tools/.test(field.label))!;
  expect(question.value).toBe("");
  expect(question.options).toEqual(["Little or none", "Coursework", "Projects in use"]);
  expect((await state()).applications[0].missing.some((item: string) => /spreadsheet tools/.test(item))).toBe(true);
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

// The applicant had to choose Mark submitted after every application, though
// the site had just told them, and the card said nothing of what a fill was
// doing beyond "Filling".
test("the card lists what a fill worked on, and the site's own confirmation marks the application submitted", async () => {
  await context.route("https://jobs.lever.co/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: route.request().url().endsWith("/thanks")
        ? `<!doctype html><html><head><title>Acme - Frontend Engineer</title></head><body><h3 data-qa="msg-submit-success">Application submitted!</h3></body></html>`
        : leverLocationPage,
    }),
  );
  const page = await context.newPage();
  await page.goto("https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000004/apply");
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  const filled = (await state()).applications[0];
  // Nothing is being written any more, and what was is listed in order.
  expect(filled.progress?.current).toBeUndefined();
  expect(filled.progress?.answered).toEqual(expect.arrayContaining(["Full name", "Email", "Current location"]));
  expect(filled.workflowStage).not.toBe("submitted");
  await expect(panel.getByText(`Worked on so far (${filled.progress!.answered.length})`).first()).toBeVisible();
  // The applicant submits, and Lever shows its page: no Mark submitted needed.
  await page.goto("https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000004/thanks");
  await expect.poll(async () => (await state()).applications[0].workflowStage, { timeout: 20000 }).toBe("submitted");
  const sent = (await state()).applications[0];
  expect(sent.note).toMatch(/^The site confirmed this application was submitted\./);
  expect(sent.submittedAt).toBeGreaterThan(0);
  // It goes into the history of submissions, which outlives the list.
  await expect.poll(async () => (await ui({ type: "API", path: "/v1/submissions" })).map((record: { applicationId: string; confirmedBySite: boolean }) => [record.applicationId, record.confirmedBySite]), { timeout: 10000 })
    .toEqual([[sent.id, true]]);
  // A profile change does not ask a submitted application to be filled
  // again, nor count it as needing the applicant (37 did, 2026-10-16).
  const statusBefore = (await state()).applications[0].status;
  const current = await ui({ type: "API", path: "/v1/profile" });
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...current, city: current.city } });
  expect((await state()).applications[0]).toMatchObject({ status: statusBefore, note: sent.note });
  await expect(panel.locator(".stats")).toContainText("1Submitted");
  // A stage the applicant then sets themselves is not overridden by the same page.
  await ui({ type: "SET_WORKFLOW", id: sent.id, stage: "review" });
  // Moved back out of Submitted: it was not, and leaves the history.
  await expect.poll(async () => (await ui({ type: "API", path: "/v1/submissions" })).length, { timeout: 10000 }).toBe(0);
  await page.reload();
  await page.waitForTimeout(2500);
  expect((await state()).applications[0].workflowStage).toBe("review");
  expect(await page.evaluate(() => (window as any).submissions)).toBeUndefined();
});

test("a confirmation drawn in place marks the application submitted, and a hidden one does not", async () => {
  await context.route("https://jobs.ashbyhq.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>Engineer @ Acme</title></head><body><form onsubmit="return false">
        <div class="ashby-application-form-field-entry" data-field-path="_systemfield_email"><label class="ashby-application-form-question-title" for="email">Email</label><input id="email" name="email" type="email" required></div>
        <button type="submit">Submit Application</button></form>
        <div id="done" class="ashby-application-form-success-container" style="display:none"><h2>Success</h2><p>Your application was successfully submitted.</p></div></body></html>`,
    }),
  );
  const page = await context.newPage();
  await page.goto("https://jobs.ashbyhq.com/acme/00000000-0000-4000-8000-000000000005/application");
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  await expect(page.locator("#email")).toHaveValue(profile.email);
  // The message is in the page from the start, hidden: that is not a confirmation.
  await page.waitForTimeout(1500);
  expect((await state()).applications[0].workflowStage).not.toBe("submitted");
  await page.evaluate(() => {
    document.querySelector("form")!.remove();
    (document.getElementById("done") as HTMLElement).style.display = "block";
  });
  await expect.poll(async () => (await state()).applications[0].workflowStage, { timeout: 20000 }).toBe("submitted");
});

// A report on an Ashby form, 2026-10-13: "When can you start a new role?" is
// a text box that opens a calendar. "Immediately" was typed into it, and the
// picker dropped the word when the box was left.
// Nokia's Oracle form (report 1f68e4f9, 2026-10-31): a graduation date in
// three lists after its question, each opened from its arrow button, not a
// press on the box. The fill focused the box instead, and in a page out of
// view that focus comes without a focus event: it was taken for the
// applicant's, and all three were left.
test("Oracle's graduation date in three lists is filled in a page out of view", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile,
    education: [{ organization: "Example State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-12-13", location: "", details: "" }] } });
  const list = (part: string, options: string[]) => `<div class="input-row"><label for="${part}">What is your expected year of graduation? ${part}</label>
    <input id="${part}" role="combobox" aria-haspopup="grid" aria-controls="${part}-list" aria-expanded="false" class="cx-select-input" autocomplete="off">
    <button type="button" class="icon-dropdown-arrow" tabindex="-1" aria-controls="${part}-list" aria-label="Open the drop-down list for ${part}."></button>
    <div id="${part}-list" role="grid" hidden>${options.map((option, index) => `<div role="row"><div role="gridcell" id="${part}-listitem-${index}" class="cx-select__list-item">${option}</div></div>`).join("")}</div></div>`;
  await context.route(`${origin}/oracle-graduation`, (route) => route.fulfill({ contentType: "text/html",
    body: `<!doctype html><title>Questions</title><main><form>
      ${list("Month", ["January", "June", "December"])}${list("Day", ["1", "13", "28"])}${list("Year", ["2098", "2099"])}
      </form></main><script>
      // As in a page out of view: focus moves, and no focus event says so.
      for (const type of ['focus', 'focusin']) window.addEventListener(type, (event) => event.stopImmediatePropagation(), true);
      for (const input of document.querySelectorAll('[role="combobox"]')) {
        const listbox = document.getElementById(input.getAttribute('aria-controls'));
        input.parentElement.querySelector('button').addEventListener('click', () => setTimeout(() => {
          input.focus();
          listbox.hidden = false;
          input.setAttribute('aria-expanded', 'true');
        }, 30));
        listbox.addEventListener('click', (event) => {
          input.value = event.target.textContent;
          listbox.hidden = true;
          input.setAttribute('aria-expanded', 'false');
        });
      }
      </script>` }));
  const page = await context.newPage();
  await page.goto(`${origin}/oracle-graduation`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect(page.locator("#Month")).toHaveValue("December", { timeout: 30000 });
  await expect(page.locator("#Day")).toHaveValue("13");
  await expect(page.locator("#Year")).toHaveValue("2099");
  await page.close();
});

test("a date picker asked when the applicant can start gets today's date, which it keeps", async () => {
  await context.route("https://jobs.ashbyhq.com/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><head><title>Engineer @ Acme</title></head><body><form onsubmit="window.submissions++; return false">
        <div class="ashby-application-form-field-entry" data-field-path="_systemfield_email"><label class="ashby-application-form-question-title" for="email">Email</label><input id="email" name="email" type="email" required></div>
        <div class="ashby-application-form-field-entry" data-field-path="start"><label class="ashby-application-form-question-title" for="start">When can you start a new role?</label>
        <div class="react-datepicker-wrapper"><div class="react-datepicker__input-container"><input id="start" type="text" placeholder="Pick date..." class="ashby-application-form-input-date" required></div></div></div>
        <button type="submit">Submit Application</button></form>
        <script>
          window.submissions = 0;
          // As react-datepicker does: what is not a date is gone on leaving.
          const start = document.getElementById("start");
          start.addEventListener("blur", () => { if (!/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(start.value)) start.value = ""; });
        </script></body></html>`,
    }),
  );
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, answers: [{ question: "When can you start?", answer: "Immediately" }] } });
  const page = await context.newPage();
  await page.goto("https://jobs.ashbyhq.com/acme/00000000-0000-4000-8000-000000000006/application");
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  await expect(page.locator("#email")).toHaveValue(profile.email);
  const today = await page.evaluate(() => {
    const now = new Date();
    const two = (n: number) => String(n).padStart(2, "0");
    return `${two(now.getMonth() + 1)}/${two(now.getDate())}/${now.getFullYear()}`;
  });
  await page.locator("#start").focus();
  await page.locator("#email").focus();
  await expect(page.locator("#start")).toHaveValue(today);
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

// A report on a Greenhouse form, 2026-10-13: "Please identify your race"
// is a list whose options appear only once it is opened, shown only after
// "Are you Hispanic/Latino?" is answered No. It was left empty.
test("a race list that shows its options only when opened is answered, also when an earlier answer brings it out", async () => {
  await context.route(`${origin}/eeo-follow-up`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Engineer | Acme</title><form onsubmit="window.submissions++; return false">
        <label>Email<input name=email type=email></label>
        <label>Are you Hispanic/Latino?<select id=hispanic><option value="">Select...</option><option>Yes</option><option>No</option><option>Decline To Self Identify</option></select></label>
        <div id=more></div><button type=submit>Submit</button></form>
        <script>
          window.submissions = 0;
          const races = ["American Indian or Alaskan Native", "Asian", "Black or African American", "White", "Two or More Races", "Decline To Self Identify"];
          document.getElementById("hispanic").addEventListener("change", (event) => {
            const more = document.getElementById("more");
            if (event.target.value !== "No") { more.innerHTML = ""; return; }
            more.innerHTML = '<label id=race-label for=race>Please identify your race</label><input id=race role=combobox aria-labelledby=race-label aria-expanded=false aria-controls=race-list aria-autocomplete=list><ul id=race-list role=listbox hidden></ul>';
            const input = document.getElementById("race"), list = document.getElementById("race-list");
            const open = () => {
              list.innerHTML = races.map((name) => '<li role=option>' + name + '</li>').join("");
              list.hidden = false;
              input.setAttribute("aria-expanded", "true");
            };
            input.addEventListener("mousedown", open);
            input.addEventListener("click", open);
            input.addEventListener("keydown", (event) => { if (event.key === "ArrowDown" || event.key === "Enter") open(); });
            list.addEventListener("click", (event) => {
              const option = event.target.closest("[role=option]");
              if (!option) return;
              input.value = option.textContent;
              list.hidden = true;
              list.innerHTML = "";
              input.setAttribute("aria-expanded", "false");
            });
          });
        </script>`,
    }),
  );
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, hispanic: "No", ethnicity: "South Asian" } });
  const page = await context.newPage();
  await page.goto(`${origin}/eeo-follow-up`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  await expect(page.locator("#hispanic")).toHaveValue("No");
  await expect(page.locator("#race")).toHaveValue("Asian");
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

// A report on Epic Games' careers site, 2026-10-14: its Greenhouse form
// labels each box with <label for="First Name"> though no box has that id,
// and writes "First Name\u2060*\u2060:". Every box read as its placeholder
// "Enter", so boxes alike were held back and nothing but a few was filled.
test("a form whose labels name no box, around invisible joiners, is read and filled by those labels", async () => {
  const group = (label: string, name: string, extra = "") =>
    `<div class="field-group"><div class="InputLabel"><label for="${label}"><span>${label}\u2060*\u2060:</span></label></div><div><div class="job-form-text-field-container"><input name="${name}" type="text" placeholder="Enter" ${extra}></div></div></div>`;
  await context.route(`${origin}/careers-greenhouse`, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>Research Intern | Epic Games</title><form onsubmit="window.submissions++; return false">
        ${group("First Name", "questions.first_name")}
        ${group("Last Name", "questions.last_name")}
        ${group("Email", "questions.email")}
        <div class="field-group"><div class="phone-number"><div class="InputLabel"><label for="questions.phone"><span>Phone\u2060*\u2060:</span></label></div><input type="tel" id="questions.phone" name="questions.phone" placeholder="Enter"></div></div>
        ${group("LinkedIn Profile", "questions.question_1")}
        ${group("Website / Portfolio", "questions.question_2")}
        <button type="submit">Submit Application</button></form><script>window.submissions = 0;</script>`,
    }),
  );
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, linkedin: "linkedin.com/in/alex-example", website: "https://alex.example" } });
  const page = await context.newPage();
  await page.goto(`${origin}/careers-greenhouse`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  await expect(page.locator('[name="questions.first_name"]')).toHaveValue(profile.firstName);
  await expect(page.locator('[name="questions.last_name"]')).toHaveValue(profile.lastName);
  await expect(page.locator('[name="questions.email"]')).toHaveValue(profile.email);
  await expect(page.locator('[name="questions.phone"]')).not.toHaveValue("");
  await expect(page.locator('[name="questions.question_1"]')).toHaveValue(/linkedin\.com/);
  await expect(page.locator(`[name="questions.question_2"]`)).toHaveValue("https://alex.example");
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  const labels = ((await ui({ type: "SCAN_TAB", tabId })).observation.fields as { label: string }[]).map((field) => field.label);
  expect(labels).toEqual(expect.arrayContaining(["First Name", "Last Name", "Email", "Phone", "LinkedIn Profile", "Website / Portfolio"]));
  expect(labels).not.toContain("Enter");
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

// Reports, 2026-10-14: Pinterest's and Roblox's careers pages show the
// Greenhouse form, and its "thank you" after Submit, in a frame of their own.
// Only the top page was asked whether it showed a confirmation.
test("a confirmation drawn in the form's own frame marks the application submitted", async () => {
  await context.route("https://boards.greenhouse.io/embed/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: route.request().url().includes("/confirmation")
        ? `<!doctype html><title>Thank you</title><div class="confirmation"><div class="confirmation__content"><p>Good news: your application is in!</p></div></div>`
        : `<!doctype html><title>Apply</title><form action="/embed/job_app/confirmation" method="get"><label for="first_name">First Name</label><input id="first_name" name="first_name"><button type="submit">Submit application</button></form>`,
    }),
  );
  await context.route(`${origin}/framed-careers*`, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>Engineer | Acme Careers</title><h1>Engineer</h1><iframe id="grnhse_iframe" src="https://boards.greenhouse.io/embed/job_app?for=acme&token=1" style="width:800px;height:400px"></iframe>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/framed-careers?gh_jid=1`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  expect((await state()).applications[0].workflowStage).not.toBe("submitted");
  // The applicant submits inside the frame; the frame shows Greenhouse's page.
  await page.frameLocator("#grnhse_iframe").locator("button[type=submit]").click();
  await expect(page.frameLocator("#grnhse_iframe").locator(".confirmation__content")).toBeVisible();
  await expect.poll(async () => (await state()).applications[0].workflowStage, { timeout: 20000 }).toBe("submitted");
  expect((await state()).applications[0].note).toMatch(/^The site confirmed this application was submitted\./);
});

// A second report from Epic Games' careers site, 2026-10-14: its yes/no
// dropdowns (an older react-select), the phone box that opens once its
// country is chosen, and both schools' date boxes were all left empty.
test("an older react-select, a phone box opened by its country, and repeated school rows are filled", async () => {
  const compiled = await build({
    entryPoints: ["tests/browser/legacy-select-fixture.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await context.route(`${origin}/legacy-select`, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><head><title>Research Intern | Acme Games</title></head><body><div id="root"></div><script>${compiled.outputFiles[0].text}</script></body></html>`,
    }),
  );
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      workAuthorization: "Yes",
      sponsorship: "No",
      priorEmployment: "No",
      education: [
        { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-05", location: "East Lansing, Michigan" },
        { organization: "Virginia Tech", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "Blacksburg, Virginia" },
      ],
    },
  });
  const page = await context.newPage();
  await page.goto(`${origin}/legacy-select`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 60000 }).toMatch(/^(awaiting-user|ready)$/);
  await expect(page.locator('[name="questions.email"]')).toHaveValue(profile.email);
  await expect.poll(() => page.evaluate(() => (window as any).selected)).toMatchObject({
    country: "United States +1",
    previously: "No",
    sponsorship: "No",
    authorized: "Yes",
  });
  await expect(page.locator('[name="questions.phone"]')).not.toHaveValue("");
  await expect(page.locator('[name="educations[0].start_date.year"]')).toHaveValue("2025");
  await expect(page.locator('[name="educations[1].start_date.year"]')).toHaveValue("2020");
  await expect(page.locator('[name="educations[1].end_date.year"]')).toHaveValue("2024");
  // The posting sits outside the form, on a page with no main region: the
  // topics a question lists from it reach the answers (the same report).
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  expect((await ui({ type: "SCAN_TAB", tabId })).observation.description).toContain("Multi-modal diffusion models");
});

// A report, 2026-10-14: Epic Games' careers page replaced its form with
// "Your application has been submitted successfully." No site rule knew it.
test("a site's own submitted message, where its form was, marks the application submitted", async () => {
  await context.route(`${origin}/own-confirmation`, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>Research Intern | Acme Games</title><h1>Research Intern</h1>
        <p>Thank you for applying through our careers site; we read every application.</p>
        <div id="apply"><form onsubmit="return false"><label>Email<input name="email" type="email"></label><label>Phone<input name="phone"></label><button type="submit">Submit Application</button></form></div>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/own-confirmation`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  // "Thank you for applying" beside a form still to fill is no confirmation.
  await page.waitForTimeout(1500);
  expect((await state()).applications[0].workflowStage).not.toBe("submitted");
  await page.evaluate(() => {
    document.getElementById("apply")!.innerHTML = "<h2>Your application has been submitted successfully.</h2><p>Thank you for applying!</p>";
  });
  await expect.poll(async () => (await state()).applications[0].workflowStage, { timeout: 20000 }).toBe("submitted");
});

// Found in review, 2026-10-14: an employer's page around a framed form has
// no boxes of its own, and its job text may thank applicants. Only a frame
// the fill wrote to may say the application went in by its words alone.
test("an employer page's own thanks around a framed form does not mark the application submitted", async () => {
  await context.route("https://boards.greenhouse.io/embed/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>Apply</title><form onsubmit="return false"><label for="email">Email</label><input id="email" name="email" type="email"><button type="submit">Submit application</button></form>`,
    }),
  );
  await context.route(`${origin}/thanks-around-frame*`, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>Engineer | Acme Careers</title><h1>Engineer</h1><p>Thank you for applying to Acme!</p><iframe id="grnhse_iframe" src="https://boards.greenhouse.io/embed/job_app?for=acme&token=2" style="width:800px;height:300px"></iframe>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/thanks-around-frame?gh_jid=2`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 45000 }).toMatch(/^(awaiting-user|ready)$/);
  await expect(page.frameLocator("#grnhse_iframe").locator("#email")).toHaveValue(profile.email);
  await page.waitForTimeout(2000);
  expect((await state()).applications[0].workflowStage).not.toBe("submitted");
});

test("React-controlled inputs, conditional questions, and upload-parser conflicts are verified in the page", async () => {
  const compiled = await build({
    entryPoints: ["tests/browser/react-fixture.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await context.route(`${origin}/react`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><div id="root"></div><script>${compiled.outputFiles[0].text}</script></body></html>`,
    }),
  );
  const a = await context.newPage();
  await a.goto(`${origin}/react`);
  await panel.bringToFront();
  await enqueue([a]);
  await expect
    .poll(async () => (await state()).applications[0].status, {
      timeout: 25000,
    })
    .toBe("awaiting-user");
  await expect(a.locator("[name=email]")).toHaveValue(profile.email);
  await expect(a.locator("[name=firstName]")).toHaveValue(profile.firstName);
  await expect(a.locator("[name=phone]")).toHaveValue("SITE-PARSER-CHANGED");
  const react = JSON.parse(await a.locator("#react-state").innerText());
  expect(react.email).toBe(profile.email);
  expect(react.firstName).toBe(profile.firstName);
  expect((await state()).applications[0].missing).toContain(
    "Site changed an autofilled value: Phone. Please verify it.",
  );
  expect(await a.evaluate(() => (window as any).submissions)).toBe(0);
});

test("a same-URL config navigation is re-inspected without repeating the interrupted click", async () => {
  let requests = 0;
  await context.route(`${paylocityOrigin}/**`, (route) => {
    requests++;
    return route.fulfill({ contentType: "text/html", body: `<form>
      ${requests === 1 ? '<div data-automation-id="btnPublicApply"><a href="">Apply</a></div>' : ""}
      <label>First Name<input id="info.firstName" required></label><label>Last Name<input id="info.lastName" required></label><label>Email Address<input id="info.email" required></label>
      <label>Resume<input name="resume" type="file"></label><label>Cover Letter<input name="cover" type="file"></label><button type="submit">Submit application</button></form>` });
  });
  const page = await context.newPage();
  await page.goto(`${paylocityOrigin}/Recruiting/Jobs/Apply/navigation-fixture`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect(page.locator('[id="info.firstName"]')).toHaveValue(profile.firstName, { timeout: 30000 });
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 30000 }).toMatch(/^(ready|awaiting-user)$/);
  expect(requests).toBe(2);
});

test("Paylocity committed selections are recognized and its role-less pickers use component options without a reload", async () => {
  const compiled = await build({ entryPoints: ["tests/browser/paylocity-select-fixture.tsx"], bundle: true, write: false, format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  await context.route(`${paylocityOrigin}/**`, (route) => route.fulfill({ contentType: "text/html", body: `<html><body><div id="root"></div><script>${compiled.outputFiles[0].text}</script></body></html>` }));
  const current = await ui({ type: "API", path: "/v1/profile" });
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...current, confirmed: true, state: "Arizona" } });
  const page = await context.newPage();
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  await page.goto(`${paylocityOrigin}/Recruiting/Jobs/Apply/fixture`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect(page.locator('[id="info.firstName"]')).toHaveValue(profile.firstName);
  await expect(page.locator('label').filter({ has: page.locator('[id="public-site-address-us-state"]') }).locator('.input-select-input-single-value')).toHaveText("Arizona");
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 30000 }).toMatch(/^(ready|awaiting-user)$/);
  const observation = (await content(page, { type: "INSPECT" })).data;
  // The picker's own input stays empty and "required"; that is no rejection.
  expect(observation.fields.find((f: { label: string }) => f.label === "Country")).toMatchObject({ value: "United States", kind: "combobox", invalid: false });
  expect(observation.fields.find((f: { label: string }) => f.label === "State")).toMatchObject({ value: "Arizona", invalid: false });
  expect(await page.evaluate(() => [(window as any).pickerClicks, (window as any).submissions])).toEqual([0, 0]);
  expect(navigations).toBe(1);
  await expect(page.locator("#useAttachedResumeToFillOutApplication")).not.toBeChecked();
});

test("an upload-triggered same-URL reload refills known answers without repeating the upload", async () => {
  let requests = 0;
  let uploads = 0;
  await context.route(`${paylocityOrigin}/**`, (route) => {
    requests++;
    return route.fulfill({ contentType: "text/html", body: `<form>
      <div class="form-group"><label>First Name (required)</label><input id="info.firstName"></div>
      <div class="form-group"><label>Last Name (required)</label><input id="info.lastName"></div>
      <div class="form-group"><label>Email Address (required)</label><input id="info.email"></div>
      <label>Resume<input name="resume" type="file"></label><label>Cover Letter<input name="cover" type="file"></label>
      <button type="submit">Submit application</button></form><script>
      document.querySelector('[name="cover"]').addEventListener('change', () => {
        console.log('fixture-upload'); window.location.reload();
      });</script>` });
  });
  const page = await context.newPage();
  page.on("console", (message) => { if (message.text() === "fixture-upload") uploads++; });
  await page.goto(`${paylocityOrigin}/Recruiting/Jobs/Apply/upload-navigation-fixture`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 30000 }).toMatch(/^(ready|awaiting-user)$/);
  await expect(page.locator('[id="info.firstName"]')).toHaveValue(profile.firstName);
  await expect(page.locator('[id="info.email"]')).toHaveValue(profile.email);
  expect(requests).toBe(2);
  expect(uploads).toBe(1);
  expect((await state()).applications[0].missing.join(" ")).toContain("Confirm the uploaded documents manually");
});

inEitherTab("react-select dropdowns get real selections, including async lists, and no leftover search text", async (tab) => {
  const compiled = await build({
    entryPoints: ["tests/browser/react-select-fixture.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await context.route(`${origin}/react-select`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><div id="root"></div><script>${compiled.outputFiles[0].text}</script></body></html>`,
    }),
  );
  const current = await ui({ type: "API", path: "/v1/profile" });
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...current,
      confirmed: true,
      // A GPA is a school's, on its scale.
      // Virginia Tech, which the list names officially.
      education: [{ organization: "Virginia Tech", title: "Bachelor of Science", startDate: "2022-08", endDate: "2026-05", location: "", details: "", gpa: "3.62", gpaScale: "4" }],
      pronouns: "He/Him",
      answers: [
        { question: "Gender Identity", answer: "Man" },
        { question: "School", answer: "Virginia Tech" },
        { question: "Race/Ethnicity", answer: "Martian" },
      ],
    },
  });
  const page = await context.newPage();
  await page.goto(`${origin}/react-select`);
  await place(page, tab);
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 25000 })
    .toMatch(/awaiting-user|ready/);
  // The component's own state holds each option; the display is not faked.
  expect(await page.evaluate(() => (window as any).selected)).toMatchObject({
    gender: "g1",
    gpa: "gpa1",
    pronoun: "p1",
    school: "s27",
  });
  // No matching option: the field stays empty with no typed text left behind.
  await expect(page.locator("#race")).toHaveValue("");
  expect(await page.evaluate(() => (window as any).selected.race)).toBeUndefined();
  expect((await state()).applications[0].missing.join("\n")).toContain(
    'No dropdown option matches "Martian"',
  );
});

test("react-select verifies a canonical country by its unique option ID and refuses colliding or wrong IDs", async () => {
  const compiled = await build({ entryPoints: ["tests/browser/react-select-fixture.tsx"],
    bundle: true, write: false, format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  await context.route(`${origin}/canonical-country*`, route => route.fulfill({ contentType: "text/html",
    body: `<html><body><div id="root"></div><script>${compiled.outputFiles[0].text}</script></body></html>` }));
  const current = await ui({ type: "API", path: "/v1/profile" });
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...current, confirmed: true, country: "United States" } });
  await worker.evaluate(() => {
    (globalThis as any).countryOutcomes = [];
    const execute = chrome.scripting.executeScript.bind(chrome.scripting) as (injection: any) => Promise<any[]>;
    chrome.scripting.executeScript = async function (...args: any[]) {
      const result = await execute(args[0]);
      const request = args[0]?.args?.[0] as { method?: string; values?: string[] } | undefined;
      if (request?.method === "reactSelectChoose" && request.values?.[0] === "United States +1")
        (globalThis as any).countryOutcomes.push(result[0]?.result);
      return result;
    } as unknown as typeof chrome.scripting.executeScript;
  });
  // "late": the pick shows 400 ms after it is made, and is still kept.
  const modes = ["unique", "collision", "wrong", "late"];
  for (const mode of modes) {
    const page = await context.newPage();
    await page.goto(`${origin}/canonical-country?country=${mode}`);
    await enqueue([page]);
    await expect.poll(async () => (await state()).applications.find(app => app.url === page.url())?.status,
      { timeout: 25000 }).toMatch(/awaiting-user|ready/);
    const outcomes = await worker.evaluate(() => (globalThis as any).countryOutcomes);
    expect(outcomes).toHaveLength(modes.indexOf(mode) + 1);
    if (mode === "unique" || mode === "late") {
      expect(await page.evaluate(() => (window as any).selected.country)).toBe("us");
      expect(outcomes.at(-1)).toMatchObject({ ok: true });
    } else expect(outcomes.at(-1)).toMatchObject({ ok: false, reason: "The dropdown did not keep the selection." });
    expect(await page.evaluate(() => (window as any).countryWrites)).toBe(1);
    expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
    await page.close();
  }
});

test("a hydrated form fills while an unrelated image keeps the page loading", async () => {
  const compiled = await build({ entryPoints: ["tests/browser/react-select-fixture.tsx"],
    bundle: true, write: false, format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  let releaseImage: (() => void) | undefined;
  const imagePending = new Promise<void>(resolve => { releaseImage = resolve; });
  await context.route(`${origin}/held-image`, async route => {
    await imagePending;
    await route.abort();
  });
  await context.route(`${origin}/loading-country*`, route => route.fulfill({ contentType: "text/html",
    body: `<html><body><div id="root"></div><img src="/held-image"><script>${compiled.outputFiles[0].text}</script></body></html>` }));
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/loading-country?country=unique`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#country")).toBeVisible();
    expect(await page.evaluate(() => document.readyState)).toBe("interactive");
    await enqueue([page]);
    await expect.poll(async () => (await state()).applications.find(app => app.url === page.url())?.status,
      { timeout: 15000 }).toMatch(/awaiting-user|ready/);
    expect(await page.evaluate(() => document.readyState)).toBe("interactive");
    expect(await page.evaluate(() => (window as any).selected.country)).toBe("us");
    expect(await page.evaluate(() => (window as any).countryWrites)).toBe(1);
    expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
  } finally {
    const apps = (await state()).applications.filter(app => app.url === page.url());
    console.log("Loading-form state:", JSON.stringify(apps.map(app => ({ status: app.status, note: app.note }))));
    releaseImage!();
    await page.close();
  }
});

test("a resume swapped for a filename chip does not count as the cover letter", async () => {
  await context.route(`${origin}/chip-uploaders`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form><div class="fields">
        <div class="field" id="resume-field"><label>Resume/CV<input type="file" name="resume" accept=".pdf"></label></div>
        <div class="field"><label>Cover Letter<input type="file" name="cover" accept=".pdf"></label></div>
      </div></form>
      <script>
        window.coverFiles = 0;
        document.querySelector('[name="resume"]').addEventListener("change", (event) => {
          // Like Greenhouse: the uploaded resume becomes a filename chip.
          const name = event.target.files[0].name;
          document.getElementById("resume-field").innerHTML = '<span class="file-name">' + name + '</span>';
        });
        document.querySelector('[name="cover"]').addEventListener("change", () => window.coverFiles++);
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/chip-uploaders`);
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 25000 })
    .toMatch(/awaiting-user|ready/);
  expect(await page.evaluate(() => (window as any).coverFiles)).toBe(1);
  const missing = (await state()).applications[0].missing.join(" ");
  expect(missing).not.toContain("Stale or mismatched document attachment");
  expect(missing).not.toContain("Review existing document: Cover letter");
});

// Amazon keeps the account's resume and shows it beside a Replace input
// (2026-10-31). It gives way to this application's tailored one as answers
// the site filled in do; with those kept, the card offers it instead.
test("a resume the site already held is replaced with the tailored one, or offered for replacing", async () => {
  const body = `<!doctype html><title>Apply to a Job</title><main><h1>Upload your resume</h1><form>
      <label for="name">Full name</label><input id="name">
      <div role="tabpanel" aria-label="Resume"><h2>Upload your resume</h2>
        <div class="card document-block"><a class="document-block-title" href="/download">Download Old_Account_Resume.pdf</a>
        <label for="document-replace-input" class="document-replace-link"><button type="button">Replace<span class="sr-only">Resume</span></button></label>
        <input type="file" id="document-replace-input" class="file-upload"></div></div></form></main>
    <script>
      window.replaced = [];
      document.getElementById("document-replace-input").addEventListener("change", (event) => {
        const name = event.target.files[0].name;
        window.replaced.push(name);
        document.querySelector(".document-block-title").textContent = "Download " + name;
      });
    </script>`;
  await context.route(`${origin}/held-resume*`, (route) => route.fulfill({ contentType: "text/html", body }));
  const settings = { concurrency: 4, generationConcurrency: 2 };
  try {
    // Pre-filled answers replaced (the default): the tailored resume goes in.
    await ui({ type: "SETTINGS", settings: { ...settings, prefilled: "replace" } });
    const page = await context.newPage();
    await page.goto(`${origin}/held-resume?replace=1`);
    await enqueue([page]);
    const app = async () => (await state()).applications.find((candidate: { url: string }) => candidate.url.includes("replace=1"))!;
    await expect.poll(async () => (await app()).status, { timeout: 45000 }).toMatch(/awaiting-user|ready/);
    const replaced = await page.evaluate(() => (window as any).replaced);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).not.toBe("Old_Account_Resume.pdf");
    expect((await app()).missing.join(" ")).not.toContain("Review existing document");
    expect(((await app()).configNotes || []).join(" ")).toContain("Replaced the Resume the site already had");
    // Filled again: the resume it uploaded is not sent a second time.
    await ui({ type: "FILL_STEP", id: (await app()).id });
    await expect.poll(async () => (await app()).attempts.length, { timeout: 15000 }).toBeGreaterThan(1);
    await expect.poll(async () => (await app()).status, { timeout: 45000 }).toMatch(/awaiting-user|ready/);
    expect(await page.evaluate(() => (window as any).replaced)).toHaveLength(1);
    // It is this application's own resume now, not one to review.
    expect((await app()).missing.join(" ")).not.toContain("Review existing document");
    // Kept: nothing is replaced until the applicant asks, from the card.
    await ui({ type: "SETTINGS", settings: { ...settings, prefilled: "keep" } });
    const kept = await context.newPage();
    await kept.goto(`${origin}/held-resume?keep=1`);
    await enqueue([kept]);
    const keptApp = async () => (await state()).applications.find((candidate: { url: string }) => candidate.url.includes("keep=1"))!;
    await expect.poll(async () => (await keptApp()).status, { timeout: 45000 }).toMatch(/awaiting-user|ready/);
    expect(await kept.evaluate(() => (window as any).replaced)).toEqual([]);
    expect((await keptApp()).missing).toContain("Review existing document: Resume. It was preserved and may differ from the newly generated version.");
    await ui({ type: "REPLACE_DOCUMENTS", id: (await keptApp()).id });
    await expect.poll(() => kept.evaluate(() => (window as any).replaced.length), { timeout: 45000 }).toBe(1);
    // Asked once: the next fill keeps it again.
    await expect.poll(async () => (await keptApp()).replaceDocuments, { timeout: 45000 }).toBe(false);
    expect((await keptApp()).missing.join(" ")).not.toContain("Review existing document");
  } finally {
    await ui({ type: "SETTINGS", settings: { ...settings, prefilled: "replace" } });
  }
});

// Nokia's Oracle form (report 392583f7, 2026-10-31): an "Additional
// Documents" uploader named only "Upload Attachment", whose instructions ask
// for a cover letter, got none.
test("an Oracle uploader whose instructions name the cover letter gets it", async () => {
  await context.route(`${origin}/oracle-attachments`, (route) => route.fulfill({ contentType: "text/html",
    body: `<!doctype html><title>Application</title><form><label>Full name<input name="name"></label>
      <div class="apply-flow-block"><div class="apply-flow-block__header"><h3 class="apply-flow-block__title"><span>Additional Documents</span></h3>
        <p class="apply-flow-block__instructions">Add any additional documents. E.g.: Cover Letter, Certificate, Reference letter.</p></div>
        <div class="apply-flow-block__form-list" role="region" aria-label="Additional Documents "><attachment-upload-button><div>
          <div class="attachment-upload-button"><div class="attachment-upload-button__container">
            <div class="attachment-upload-button__drag-and-drop"><span>Drop attachment here</span></div>
            <div class="attachment-upload-button__upload-button"><span>Or</span><div class="file-form-element">
              <input type="file" class="file-form-element__input upload-button" multiple id="attachment-upload-1" name="attachment-upload">
              <label class="file-form-element__label" for="attachment-upload-1"><span>Upload Attachment</span></label>
            </div></div></div></div></div></attachment-upload-button></div></div>
      </form><script>
        window.attached = [];
        // As Nokia's: the file is listed in a part of the page that is not
        // shown, with its Remove button, and the visible uploader stays empty.
        const hidden = document.createElement('div');
        hidden.hidden = true;
        document.body.append(hidden);
        document.querySelector('input[type=file]').addEventListener('change', (event) => {
          const name = event.target.files[0].name;
          window.attached.push(name);
          hidden.innerHTML = '<div><span></span><button type="button">Remove Cover Letter</button></div>';
          hidden.querySelector('span').textContent = name;
          // Its own state empties the box a moment after it took the file.
          setTimeout(() => { event.target.value = ''; }, 400);
        });
      </script>` }));
  const page = await context.newPage();
  await page.goto(`${origin}/oracle-attachments`);
  await enqueue([page]);
  await expect.poll(() => page.evaluate(() => (window as any).attached), { timeout: 45000 }).toEqual([expect.stringMatching(/cover/i)]);
  // Filled again, the uploader still empty to the eye: it gets the letter
  // again, not a name it cannot see.
  await expect.poll(async () => (await state()).applications.find((app: { url: string }) => app.url.includes("oracle-attachments"))?.status, { timeout: 30000 }).toMatch(/awaiting-user|ready/);
  await ui({ type: "FILL_STEP", id: (await state()).applications.find((app: { url: string }) => app.url.includes("oracle-attachments"))!.id });
  await expect.poll(() => page.evaluate(() => (window as any).attached.length), { timeout: 45000 }).toBe(2);
  await page.close();
});

// RTX's Workday (report 6e6db787): with no pick made by its site rule, the
// fill typed the program's name into Field of Study's search box, the site
// dropped it, and it was typed again every two seconds.
test("a list of picks' search box is never typed in as an answer", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile,
    education: [{ organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-12", location: "East Lansing, Michigan", details: "" }] } });
  await context.route(`${origin}/pick-list-search`, (route) => route.fulfill({ contentType: "text/html",
    body: `<!doctype html><title>Education</title><form><label>Full name<input name="name"></label>
      <div role="group" aria-labelledby="education-heading"><h4 id="education-heading">Education 1</h4>
        <label>School or University<input name="schoolName"></label>
        <div data-automation-id="formField-fieldOfStudy"><label for="study">Field of Study</label>
          <div data-automation-id="multiSelectContainer"><input id="study" data-uxi-widget-type="selectinput" placeholder="Search"></div></div></div>
      </form><script>
        window.typed = 0;
        const study = document.getElementById('study');
        study.addEventListener('input', () => { if (study.value) window.typed++; });
        // As Workday's: a search that picks nothing is dropped.
        study.addEventListener('blur', () => { study.value = ''; });
      </script>` }));
  const page = await context.newPage();
  await page.goto(`${origin}/pick-list-search`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications.find((app: { url: string }) => app.url.includes("pick-list-search"))?.status, { timeout: 30000 }).toMatch(/awaiting-user|ready/);
  await page.waitForTimeout(3000);
  expect(await page.evaluate(() => (window as any).typed)).toBe(0);
  await page.close();
});

// NeuroHire's Workable form (report c98cf17c, 2026-10-31): entries already
// saved show as cards, not as forms, and the school and each job were added
// again by the next fill.
test("Workable entries already saved as cards are not added again", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile,
    education: [{ organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-12", location: "East Lansing, Michigan", details: "" }],
    work: [
      { organization: "Northwind Labs", title: "Creative Technology Associate", location: "Tucson, AZ", details: "Built XR tools.", startDate: "2026-03", endDate: "" },
      { organization: "Brightline.AI", title: "Software Engineer Intern", location: "Remote", details: "Built APIs.", startDate: "2023-07", endDate: "2023-09" },
    ] } });
  const card = (rows: [string, string][]) =>
    `<li><div data-ui="group">${rows.map(([name, value]) => `<dl><dt>${name}</dt><dd data-ui="${name.toLowerCase().replace(/ /g, "_")}"><span>${value}</span></dd></dl>`).join("")}<a data-ui="remove-section" aria-label="Delete" role="button" tabindex="0"></a></div></li>`;
  await context.route(`${workableOrigin}/acme/j/ABC123DEF4/apply**`, (route) => route.fulfill({ contentType: "text/html",
    body: `<!doctype html><title>Apply</title><main><form>
      <label for="firstname">First name</label><input id="firstname" name="firstname">
      <div data-ui="education"><p>Education</p><button data-ui="add-section" aria-label="Add Education" type="button">+ Add</button>
        <ul>${card([["School", "Michigan State University"], ["Field of study", "Data Science"], ["Degree", "Master's Degree"]])}</ul></div>
      <div data-ui="experience"><p>Experience</p><button data-ui="add-section" aria-label="Add Experience" type="button">+ Add</button>
        <ul>${card([["Title", "Software Engineer Intern"], ["Company", "Brightline.AI"]])}${card([["Title", "Creative Technology Associate"], ["Company", "Northwind Labs"]])}</ul></div>
      </form></main><script>
        window.adds = 0;
        for (const button of document.querySelectorAll('[data-ui="add-section"]')) button.addEventListener('click', () => window.adds++);
      </script>` }));
  const page = await context.newPage();
  await page.goto(`${workableOrigin}/acme/j/ABC123DEF4/apply/`);
  await enqueue([page]);
  await expect(page.locator("#firstname")).toHaveValue(profile.firstName, { timeout: 45000 });
  await expect.poll(async () => (await state()).applications.find((app: { url: string }) => app.url.includes("ABC123DEF4"))?.status, { timeout: 45000 }).toMatch(/awaiting-user|ready/);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).adds)).toBe(0);
  await page.close();
});

// NeuroHire's Workable form (report bb39258c, 2026-10-31): with MSU saved as
// a card, "+ Add" for Penn State drew its editor first in the list, and the
// fill wrote MSU into it and left it open.
test("a Workable entry added above the saved cards gets its own row and is saved", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile,
    education: [
      { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-12", location: "East Lansing, Michigan", details: "" },
      { organization: "Pennsylvania State University, University Park", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "University Park, PA", details: "" },
    ] } });
  await context.route(`${workableOrigin}/acme/j/ADD456GHI7/apply**`, (route) => route.fulfill({ contentType: "text/html",
    body: `<!doctype html><title>Apply</title><main><form>
      <label for="firstname">First name</label><input id="firstname" name="firstname">
      <div data-ui="education"><p>Education</p><button data-ui="add-section" aria-label="Add Education" type="button">+ Add</button>
        <ul><li><div data-ui="group"><dl><dt>School</dt><dd data-ui="school"><span>Michigan State University</span></dd></dl><dl><dt>Field of study</dt><dd><span>Data Science</span></dd></dl><a data-ui="remove-section" aria-label="Delete" role="button" tabindex="0"></a></div></li></ul></div>
      </form></main><script>
        window.saved = [];
        const add = document.querySelector('[aria-label="Add Education"]');
        add.addEventListener('click', () => {
          add.disabled = true;
          const li = document.createElement('li');
          li.innerHTML = '<div data-ui="editor"><label><span id="school_label">School</span><input id="school" name="school" aria-labelledby="school_label" required></label>'
            + '<label><span id="field_of_study_label">Field of study</span><input id="field_of_study" name="field_of_study" aria-labelledby="field_of_study_label"></label>'
            + '<button type="button" data-ui="save-section">Save</button><button type="button" data-ui="cancel-section">Cancel</button></div>';
          document.querySelector('[data-ui="education"] ul').prepend(li);
          li.querySelector('[data-ui="save-section"]').addEventListener('click', () => {
            window.saved.push(li.querySelector('#school').value);
            li.innerHTML = '<div data-ui="group"><dl><dt>School</dt><dd><span></span></dd></dl></div>';
            li.querySelector('span').textContent = window.saved.at(-1);
            add.disabled = false;
          });
        });
      </script>` }));
  const page = await context.newPage();
  await page.goto(`${workableOrigin}/acme/j/ADD456GHI7/apply/`);
  await enqueue([page]);
  await expect.poll(() => page.evaluate(() => (window as any).saved), { timeout: 45000 }).toEqual(["Pennsylvania State University, University Park"]);
  await page.close();
});

// Samsung Semiconductor's Greenhouse form (report c577407b, 2026-10-31):
// every employment row asks "Current role", and with no row told apart the
// boxes were one field asked three times and all were left.
test("each Greenhouse employment row's Current role is answered for its own job", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile,
    work: [
      { organization: "Northwind Labs", title: "Creative Technology Associate", location: "Tucson, AZ", details: "Built XR tools.", startDate: "2026-03", endDate: "" },
      { organization: "Brightline.AI", title: "Software Engineer Intern", location: "Remote", details: "Built APIs.", startDate: "2023-07", endDate: "2023-09" },
    ] } });
  const row = (n: number) => `<div class="employment-form"><p>Employment</p>
    <label for="company-${n}">Company name</label><input id="company-${n}">
    <div class="checkbox" id="current-role-${n}"><input type="checkbox" id="current-role-${n}_1"><label for="current-role-${n}_1">Current role</label></div></div>`;
  await context.route(`${origin}/greenhouse-employment`, (route) => route.fulfill({ contentType: "text/html",
    body: `<!doctype html><title>Apply</title><form><label for="first_name">First Name</label><input id="first_name">${row(0)}${row(1)}</form>` }));
  const page = await context.newPage();
  await page.goto(`${origin}/greenhouse-employment`);
  await enqueue([page]);
  await expect(page.locator("#current-role-0_1")).toBeChecked({ timeout: 45000 });
  await expect.poll(async () => (await state()).applications.find((app: { url: string }) => app.url.includes("greenhouse-employment"))?.status, { timeout: 30000 }).toMatch(/awaiting-user|ready/);
  await expect(page.locator("#current-role-1_1")).not.toBeChecked();
  await page.close();
});

// A checkbox beside a <label for=""> (2026-10-31): reading it built an
// invalid selector, and the fill stopped with "0 fields filled".
test("a checkbox beside a label with an empty for does not stop the fill", async () => {
  await context.route(`${origin}/empty-label-for`, (route) => route.fulfill({ contentType: "text/html",
    body: `<!doctype html><title>Apply</title><form><label for="first_name">First Name</label><input id="first_name">
      <div><label for="">Terms</label><input type="checkbox" id="terms"><label for="terms">I agree</label></div></form>` }));
  const page = await context.newPage();
  await page.goto(`${origin}/empty-label-for`);
  await enqueue([page]);
  await expect(page.locator("#first_name")).toHaveValue(profile.firstName, { timeout: 45000 });
  await page.close();
});

test("recording captures another tool's fill across a reload, and our own fill", async () => {
  await context.route(`${origin}/recorded-form**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Recorded application</title><form>
        <label>First name<input name="firstName"></label>
        <label>Password<input name="password" type="password"></label>
        <div id="degree"><label id="degree-label">Degree</label>
          <div role="combobox" aria-labelledby="degree-label" aria-expanded="false" tabindex="0">Select…</div></div>
      </form>
      <script>
        // Another autofill tool, driven from the test.
        window.otherTool = async () => {
          const name = document.querySelector('[name="firstName"]');
          name.focus();
          name.value = "Alex";
          name.dispatchEvent(new Event("input", { bubbles: true }));
          name.dispatchEvent(new Event("change", { bubbles: true }));
          const password = document.querySelector('[name="password"]');
          password.value = "hunter2-secret";
          password.dispatchEvent(new Event("input", { bubbles: true }));
          const box = document.querySelector('[role="combobox"]');
          box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          box.setAttribute("aria-expanded", "true");
          const list = document.createElement("div");
          list.setAttribute("role", "listbox");
          list.innerHTML = '<div role="option">Bachelor&#39;s Degree</div><div role="option">Master&#39;s Degree</div>';
          document.getElementById("degree").append(list);
          await fetch("/degrees?term=Master&token=request-secret").catch(() => {});
          list.children[1].click();
          box.textContent = "Master's Degree";
          list.remove();
          box.setAttribute("aria-expanded", "false");
        };
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/recorded-form`);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "TRACK_TAB", tabId });
  await ui({ type: "START_RECORDING", tabId });
  await page.evaluate(() => (window as any).otherTool());
  await page.waitForTimeout(800);
  // A second page of the same flow is followed after the reload.
  await page.reload();
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as any).otherTool());
  await page.waitForTimeout(800);
  const { recording, saved } = await ui({ type: "STOP_RECORDING", tabId });
  expect(saved).toBe(true);
  const events = recording.events as { kind: string; data: any }[];
  const json = JSON.stringify(recording);
  // What the tool did, in page terms, with untrusted events marked as such.
  expect(
    events.some(
      (e) => e.kind === "event" && e.data.type === "input" && e.data.value === "Alex" && e.data.trusted === false,
    ),
  ).toBe(true);
  expect(
    events.some((e) => e.kind === "menu" && e.data.op === "added" && e.data.options?.includes("Master's Degree")),
  ).toBe(true);
  expect(
    events.some((e) => e.kind === "event" && e.data.type === "click" && e.data.target?.text === "Master's Degree"),
  ).toBe(true);
  expect(events.some((e) => e.kind === "attribute" && e.data.name === "aria-expanded")).toBe(true);
  expect(events.some((e) => e.kind === "network" && String(e.data.url).includes("/degrees?term=Master"))).toBe(true);
  expect(events.some((e) => e.kind === "navigation")).toBe(true);
  const ends = events.filter((e) => e.kind === "fields" && e.data.moment === "end");
  expect(ends.at(-1)!.data.fields).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: "First name", value: "Alex" })]),
  );
  // Both pages were recorded: the tool's input happened twice.
  expect(events.filter((e) => e.kind === "event" && e.data.type === "input" && e.data.value === "Alex")).toHaveLength(2);
  expect(json).not.toContain("hunter2-secret");
  expect(json).not.toContain("request-secret");
  // Saved locally and listed with the issue reports.
  const listed = await ui({ type: "API", path: "/v1/recordings" });
  expect(listed).toEqual([expect.objectContaining({ id: recording.id, eventCount: events.length })]);
  await showDashboard("issues");
  await expect(panel.getByText("Recorded application")).toBeVisible();
});

test("our own fill can be recorded, and its page calls are labelled as ours", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/record-own-fill`);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "TRACK_TAB", tabId });
  await ui({ type: "START_RECORDING", tabId });
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id, tabId });
  await expect(page.locator("[name=email]")).toHaveValue(profile.email, { timeout: 25000 });
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 25000 })
    .toMatch(/awaiting-user|ready/);
  const { recording } = await ui({ type: "STOP_RECORDING", tabId });
  const events = recording.events as { kind: string; data: any }[];
  expect(
    events.some(
      (e) => e.kind === "value" && e.data.target?.name === "email" && e.data.to === profile.email,
    ),
  ).toBe(true);
  // No trusted input arrived, so nothing paused the fill.
  expect((await state()).applications[0].status).not.toBe("paused");
});

test("recording attributes page-function calls to another autofill extension and flags direct changes", async () => {
  const compiled = await build({
    entryPoints: ["tests/browser/react-select-fixture.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await context.route(`${origin}/react-select`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><div id="root"></div><script>${compiled.outputFiles[0].text}</script></body></html>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/react-select`);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "START_RECORDING", tabId });
  await page.waitForTimeout(400);
  // The stand-in selects dropdown options through react-select's API from the
  // page's world, and sets the email field from its isolated world.
  await page.evaluate(() => window.postMessage("fake-autofill-go", "*"));
  await page.waitForTimeout(1200);
  const { recording } = await ui({ type: "STOP_RECORDING", tabId });
  const events = recording.events as { kind: string; data: any }[];
  const calls = events.filter((e) => e.kind === "call");
  const other = Object.keys(recording.summary.callsBySource).find((source) =>
    source.startsWith("extension:"),
  );
  expect(other).toBeTruthy();
  expect(calls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          fn: "react-select.selectOption",
          source: other,
          value: "Man",
          target: expect.objectContaining({ id: "gender" }),
          frames: expect.arrayContaining([expect.stringContaining("fakeFillDropdowns @ chrome-extension://")]),
        }),
      }),
    ]),
  );
  // Selections made through the API fire no events: they read as direct.
  const change = (label: string) =>
    events.find((e) => e.kind === "value" && e.data.target?.label === label)?.data;
  expect(change("Gender Identity")).toMatchObject({ to: "Man", direct: true });
  // The isolated-world write leaves no call, only an unexplained change.
  expect(change("Email")).toMatchObject({ to: "direct@example.test", direct: true });
  expect(calls.some((e) => e.data.target?.label === "Email")).toBe(false);
  expect(recording.summary.directChanges).toBeGreaterThanOrEqual(2);
  // Monitoring ended with the recording: the page's functions are restored.
  expect(
    await page.evaluate(
      () => !Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.name.includes("laneMonitor"),
    ),
  ).toBe(true);
});

test("recorded value changes caused by a click or typing are not marked direct", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/caused-changes`);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "START_RECORDING", tabId });
  await page.waitForTimeout(400);
  await page.locator('[name="firstName"]').fill("Jamie");
  await page.locator('[name="country"]').selectOption("US");
  await page.waitForTimeout(800);
  const { recording } = await ui({ type: "STOP_RECORDING", tabId });
  const changes = (recording.events as { kind: string; data: any }[]).filter(
    (e) => e.kind === "value",
  );
  expect(changes.find((e) => e.data.target?.name === "firstName")?.data).toMatchObject({
    to: "Jamie",
    direct: false,
  });
  expect(changes.find((e) => e.data.target?.name === "country")?.data.direct).toBe(false);
  expect(recording.summary.directChanges).toBe(0);
});

// A tab brought to the front is named at once (2026-11-07): its read took
// seconds while a fill ran, and the card meanwhile showed the tab left
// behind, its buttons acting on that application.
test("the current-tab card names a newly active tab while it is still being read", async () => {
  const first = await context.newPage();
  await first.goto(`${origin}/first-tab`);
  await first.bringToFront();
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  const card = panel.getByRole("region", { name: "Current browser tab" });
  await expect(card).toContainText("Frontend Engineer /first-tab");
  const second = await context.newPage();
  await second.goto(`${origin}/second-tab`);
  // The page is busy, so reading it takes seconds.
  await second.evaluate(() => { setTimeout(() => { const until = Date.now() + 2500; while (Date.now() < until); }, 50); });
  await second.bringToFront();
  await expect(card).toContainText("Frontend Engineer /second-tab", { timeout: 1000 });
  await expect(card).not.toContainText("/first-tab");
  await second.close();
  await first.close();
});

test("the current-tab card records and stops through its buttons", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/record-buttons`);
  // Make the form the active tab, then let the panel scan it.
  await page.bringToFront();
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  const card = panel.getByRole("region", { name: "Current browser tab" });
  await card.getByRole("button", { name: "Record page activity" }).click();
  await expect(card).toContainText("Recording ·");
  await page.locator('[name="firstName"]').fill("Jamie");
  await expect(card).toContainText(/Recording · [1-9]\d* events/);
  await card.getByRole("button", { name: "Stop recording" }).click();
  await expect(panel.getByRole("status")).toContainText("Recording saved with");
  await expect(card.getByRole("button", { name: "Record page activity" })).toBeVisible();
});

test("the current-tab card finds a form that a single-page app draws after loading", async () => {
  // Like Ashby: the page finishes loading as an empty shell, then renders.
  await context.route(`${origin}/late-form`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Late form</title><main id="app"></main>
        <script>setTimeout(() => {
          document.querySelector('#app').innerHTML = '<form><label>Name<input name="name"></label><label>Email<input name="email" type="email"></label></form>';
        }, 2000);</script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/late-form`);
  await page.bringToFront();
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  const card = panel.getByRole("region", { name: "Current browser tab" });
  await expect(card).toContainText("No form");
  // No click, tab switch or reload: the panel looks again by itself.
  await expect(card).toContainText("2 fields", { timeout: 10_000 });
});

test("a value the site rejects once is filled again on the next request, not locked", async () => {
  await context.route(`${origin}/rejects-once`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <label>Email<input name="email" type="email"></label>
        <label>Phone<input name="phone"></label>
      </form>
      <script>
        // The first written email is thrown away by the site.
        let rejected = false;
        const email = document.querySelector('[name="email"]');
        email.addEventListener("input", () => {
          if (rejected) return;
          rejected = true;
          setTimeout(() => { email.value = ""; }, 200);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/rejects-once`);
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 25000 })
    .toMatch(/awaiting-user|ready/);
  // The cleared value was written again instead of being locked as an edit.
  await expect(page.locator('[name="email"]')).toHaveValue(profile.email);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  const scanned = await ui({ type: "SCAN_TAB", tabId });
  expect(
    scanned.observation.fields.find((f: { label: string }) => f.label === "Email").protectedReason,
  ).toBeUndefined();
});

test("a site reformatting a filled value later does not lock the field", async () => {
  test.setTimeout(60000);
  await context.route(`${origin}/slow-format`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <label>Phone<input name="phone"></label>
      </form>
      <script>
        // Formats the number well after the extension's grace window.
        const phone = document.querySelector('[name="phone"]');
        phone.addEventListener("input", () => setTimeout(() => {
          const d = phone.value.replace(/\\D/g, "");
          if (d.length === 10) phone.value = "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
        }, 6500));
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/slow-format`);
  await enqueue([page]);
  await expect(page.locator('[name="phone"]')).toHaveValue("(602) 555-0101", { timeout: 25000 });
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  const phone = (await ui({ type: "SCAN_TAB", tabId })).observation.fields.find(
    (f: { label: string }) => f.label === "Phone",
  );
  expect(phone.protectedReason).toBeUndefined();
});

test("answers typed into custom questions can be saved and fill the same question next time", async () => {
  const questions = `<form>
    <label>Email<input name="email" type="email"></label>
    <label>Why do you want to work here?<textarea name="why"></textarea></label>
    <label>Are you willing to work from our Boston office?<select name="boston">
      <option value="">Select…</option><option>Yes</option><option>No</option></select></label>
  </form>`;
  for (const path of ["first-custom", "second-custom"])
    await context.route(`${origin}/${path}`, (route) =>
      route.fulfill({ contentType: "text/html", body: `<!doctype html><title>${path}</title>${questions}` }),
    );
  const first = await context.newPage();
  await first.goto(`${origin}/first-custom`);
  await first.bringToFront();
  await first.locator('[name="why"]').fill("I like building accessible tools.");
  await first.locator('[name="boston"]').selectOption("Yes");
  await first.locator('[name="email"]').fill(profile.email);
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  const card = panel.getByRole("region", { name: "Current browser tab" });
  await card.getByRole("button", { name: "Save answers I entered" }).click();
  const dialog = panel.getByRole("dialog", { name: "Save your answers" });
  await expect(dialog).toContainText("Why do you want to work here?");
  await expect(dialog).toContainText("I like building accessible tools.");
  await expect(dialog).toContainText("Are you willing to work from our Boston office?");
  // The profile already answers the email question.
  await expect(dialog).not.toContainText(profile.email);
  await dialog.getByRole("button", { name: "Save selected" }).click();
  await expect(panel.getByRole("status")).toContainText("Saved 2 answers");
  const saved = await ui({ type: "API", path: "/v1/profile" });
  expect(saved.answers).toEqual(
    expect.arrayContaining([
      { question: "Why do you want to work here?", answer: "I like building accessible tools." },
      { question: "Are you willing to work from our Boston office?", answer: "Yes" },
    ]),
  );

  const second = await context.newPage();
  await second.goto(`${origin}/second-custom`);
  await enqueue([second]);
  await expect(second.locator('[name="why"]')).toHaveValue("I like building accessible tools.", { timeout: 25000 });
  await expect(second.locator('[name="boston"]')).toHaveValue("Yes");
});

test("Unlock empty fields is offered for an optional field the applicant emptied", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/unlock-optional`);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "TRACK_TAB", tabId });
  const id = (await state()).applications[0].id;
  await ui({ type: "FILL_STEP", id, tabId });
  await expect(page.locator("[name=phone]")).toHaveValue(profile.phone);
  // Phone is optional: its review item reads "Protected: Phone (edit lock …)".
  await page.bringToFront();
  await page.locator("[name=phone]").fill("");
  await page.locator("[name=phone]").blur();
  await expect.poll(async () => (await state()).applications[0].status).toBe("paused");
  await ui({ type: "FILL_STEP", id, tabId });
  await expect
    .poll(async () => (await state()).applications[0].missing.join(" "), { timeout: 25000 })
    .toContain("Protected: Phone (edit lock");
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  await panel
    .getByRole("region", { name: "Current browser tab" })
    .getByRole("button", { name: "Unlock empty fields" })
    .click();
  await expect(panel.getByRole("status")).toContainText("Empty fields unlocked");
  await ui({ type: "FILL_STEP", id, tabId });
  await expect(page.locator("[name=phone]")).toHaveValue(profile.phone, { timeout: 25000 });
});

test("Unlock empty fields lets a locked empty field be filled again", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/unlock-empty`);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "TRACK_TAB", tabId });
  const id = (await state()).applications[0].id;
  await ui({ type: "FILL_STEP", id, tabId });
  await expect(page.locator("[name=email]")).toHaveValue(profile.email);
  // The applicant clears the field: that edit is remembered.
  await page.bringToFront();
  await page.locator("[name=email]").fill("");
  // The cursor leaves the field: nothing is ever written where you type.
  await page.locator("[name=email]").blur();
  await expect.poll(async () => (await state()).applications[0].status).toBe("paused");
  await ui({ type: "FILL_STEP", id, tabId });
  await expect
    .poll(async () => (await state()).applications[0].missing.join(" "), { timeout: 25000 })
    .toContain("Required: Email (left alone: edit lock");
  expect((await state()).applications[0].missing.join(" ")).toContain(
    "Choose Unlock empty fields to have it filled.",
  );
  await expect(page.locator("[name=email]")).toHaveValue("");
  // Offered on the current-tab card, where the applicant works.
  await page.bringToFront();
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  await panel
    .getByRole("region", { name: "Current browser tab" })
    .getByRole("button", { name: "Unlock empty fields" })
    .click();
  await expect(panel.getByRole("status")).toContainText("Empty fields unlocked");
  await ui({ type: "FILL_STEP", id, tabId });
  await expect(page.locator("[name=email]")).toHaveValue(profile.email, { timeout: 25000 });
  // Filled fields were never overwritten.
  expect(submitted).toBe(0);
});

test("Oracle's resume slot is filled beside its profile-import uploader, and hidden steps are left alone", async () => {
  // An answer the hidden step would take, so leaving it alone is a decision.
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, gender: "Male" } });
  await context.route(`${oracleOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      // Shaped like egug.fa.us2.oraclecloud.com's apply flow (issue report,
      // 2026-09-30): every step is in the page, the later ones hidden.
      body: `<!doctype html><title>Personal Info</title><main>
        <div class="apply-flow-section" data-section-number="1">
          <div class="apply-flow-profile-import-awli__button--file-upload">
            <span id="resumeParserLabel">Resume</span>
            <input type="file" class="apply-flow-profile-import-awli__file-upload" aria-labelledby="resumeParserLabel" aria-label="Import your profile from resume" accept=".pdf" id="profile-import">
          </div>
          <div class="input-row"><label class="input-row__label" for="namInformation15-43">Preferred Full Name</label>
            <input class="input-row__control" id="namInformation15-43" name="namInformation15" aria-required="true" required></div>
          <div class="file-form-element">
            <input type="file" class="file-form-element__input upload-button" id="attachment-upload-4" name="attachment-upload" accept=".txt, .pdf">
            <label class="file-form-element__label" for="attachment-upload-4"><span>Upload Resume</span></label>
          </div>
        </div>
        <div class="apply-flow-section" data-section-number="4" style="display: none;">
          <div class="input-row"><label for="gender-8">Gender (International)</label>
            <input id="gender-8" name="US-DFF-axpOrcGenderIntl-ATTRIBUTE9" role="combobox" type="text"></div>
        </div>
      </main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${oracleOrigin}/hcmUI/CandidateExperience/en/sites/CX_1/job/1/apply/section/1`);
  await enqueue([page]);
  const chosen = (id: string) =>
    page.locator(`#${id}`).evaluate((input: HTMLInputElement) => input.files?.[0]?.name || "");
  await expect.poll(() => chosen("attachment-upload-4"), { timeout: 60000 }).toMatch(/\.pdf$/);
  await expect(page.locator("#namInformation15-43")).toHaveValue(`${profile.firstName} ${profile.lastName}`);
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 30000 })
    .toMatch(/awaiting-user|ready/);
  // The import uploader rewrites the form from a resume; it is never used.
  expect(await chosen("profile-import")).toBe("");
  // Step 4 is not this step: nothing there is touched.
  await expect(page.locator("#gender-8")).toHaveValue("");
});

test("answers an earlier application left are replaced, and the applicant's own edits are kept", async () => {
  // As a returning applicant's saved profile fills a form before the
  // extension does: an old email and name, another country.
  await context.route(`${origin}/prefilled`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <label>First name<input name="firstName" value="Alexander"></label>
        <label>Email<input name="email" type="email" value="old.alex@example.test"></label>
        <label>Phone<input name="phone" value="${profile.phone}"></label>
        <label>Country<select name="country"><option value="">Select…</option><option value="CA" selected>Canada</option><option value="US">United States</option></select></label>
      </form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/prefilled`);
  await enqueue([page]);
  await expect(page.locator("[name=email]")).toHaveValue(profile.email, { timeout: 30000 });
  await expect(page.locator("[name=firstName]")).toHaveValue(profile.firstName);
  await expect(page.locator("[name=country]")).toHaveValue("US");
  // Already right: left as it was.
  await expect(page.locator("[name=phone]")).toHaveValue(profile.phone);
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 30000 })
    .toMatch(/ready|awaiting-user/);
  // The applicant changes an answer; the next fill keeps it.
  await page.bringToFront();
  await page.locator("[name=email]").fill("chosen@example.test");
  await page.locator("[name=email]").blur();
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!, page.url());
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id, tabId });
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 30000 })
    .toMatch(/ready|awaiting-user/);
  await expect(page.locator("[name=email]")).toHaveValue("chosen@example.test");
});

// PageUp (report 645e8cca): the account's older address comes back in the
// form, and its second line stayed under the profile's street.
test("a second address line an earlier application left is emptied when the profile has none", async () => {
  const address = "100 Test Way";
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, address } });
  await context.route(`${origin}/prefilled-address`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <div><label for="sStreet1">Home address:</label><input type="text" name="sStreet1" id="sStreet1" autocomplete="address-line1" value="9 Former Road"></div>
        <div><label for="sStreet2">Home address line two:</label><input type="text" name="sStreet2" id="sStreet2" aria-label="Home address line two" autocomplete="address-line2" value="Oldtown ZZ"></div>
        <div><label for="sSuburb">City:</label><input type="text" name="sSuburb" id="sSuburb" value="Oldtown"></div>
      </form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/prefilled-address`);
  await enqueue([page]);
  await expect(page.locator("#sStreet1")).toHaveValue(address, { timeout: 30000 });
  await expect(page.locator("#sSuburb")).toHaveValue(profile.city);
  await expect(page.locator("#sStreet2")).toHaveValue("");
});

// PageUp (report b040f06f): the education step comes pre-filled from the
// resume, and "Education status: Completed" stayed on a degree under way.
test("a pre-filled education status is corrected from the degree's end date", async () => {
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      education: [{ organization: "Test University", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2024-08", endDate: "2099-05", location: "", details: "" }],
    },
  });
  await context.route(`${origin}/education-status`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Education</title><form>
        <div role="group" aria-labelledby="head_educationType_1">
          <div class="form-group"><h3 id="head_educationType_1">Highest level of education</h3></div>
          <div class="form-group"><label for="institutionOther_1">School name:</label><input type="text" id="institutionOther_1" name="institutionOther_1" value="Test University"></div>
          <div class="form-group" id="r_educationStatus_1" role="group" aria-labelledby="educationStatus_1_label">
            <label id="educationStatus_1_label" for="educationStatus_1-edit">Education status:<span class="asterisk" aria-hidden="true">*</span></label>
            <div id="educationStatus_1" class="input-group cb pu-select">
              <input autocomplete="off" id="educationStatus_1-edit" class="form-control dropdownEdit" type="text" role="combobox" aria-labelledby="educationStatus_1_label" aria-autocomplete="both" aria-owns="educationStatus_1-list" aria-expanded="false" aria-controls="educationStatus_1-list" aria-required="True">
              <input type="hidden" name="q1_educationStatus_1" id="educationStatus_1-postback" value="COMPLETED">
              <ul id="educationStatus_1-list" class="cb_list" tabindex="-1" role="listbox" aria-expanded="false" style="display:none">
                <li role="option" data-value="" class="cb_option">Select</li>
                <li role="option" data-value="ABD" class="cb_option">All But Dissertation</li>
                <li role="option" data-value="COMPLETED" class="cb_option selected">Completed</li>
                <li role="option" data-value="IN_PROGRESS" class="cb_option">In progress</li>
                <li role="option" data-value="INCOMPLETE" class="cb_option">Incomplete</li>
              </ul>
            </div>
          </div>
        </div>
      </form>
      <script>
        // PageUp's combobox: mousedown on the edit box toggles the list and
        // focuses the box; an option's click stores it and closes the list.
        const edit = document.getElementById('educationStatus_1-edit');
        const list = document.getElementById('educationStatus_1-list');
        const postback = document.getElementById('educationStatus_1-postback');
        const show = (open) => {
          list.style.display = open ? '' : 'none';
          list.setAttribute('aria-expanded', String(open));
          edit.setAttribute('aria-expanded', String(open));
        };
        edit.value = list.querySelector('.selected').textContent;
        edit.addEventListener('mousedown', () => { show(list.getAttribute('aria-expanded') !== 'true'); edit.focus(); });
        for (const option of list.querySelectorAll('li'))
          option.addEventListener('click', () => {
            list.querySelector('.selected').classList.remove('selected');
            option.classList.add('selected');
            edit.value = option.textContent;
            postback.value = option.dataset.value;
            show(false);
          });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/education-status`);
  await enqueue([page]);
  await expect(page.locator("#educationStatus_1-edit")).toHaveValue("In progress", { timeout: 30000 });
  await expect(page.locator("#educationStatus_1-postback")).toHaveValue("IN_PROGRESS");
});

test("with Keep chosen, answers the site filled in stay as they are", async () => {
  await keepPrefilled();
  await context.route(`${origin}/prefilled-kept`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <label>First name<input name="firstName" value="Alexander"></label>
        <label>Last name<input name="lastName"></label>
        <label>Email<input name="email" type="email" value="old.alex@example.test"></label>
      </form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/prefilled-kept`);
  await enqueue([page]);
  await expect(page.locator("[name=lastName]")).toHaveValue(profile.lastName, { timeout: 30000 });
  await expect(page.locator("[name=email]")).toHaveValue("old.alex@example.test");
  await expect(page.locator("[name=firstName]")).toHaveValue("Alexander");
});

inEitherTab("Oracle documents left from an earlier application are replaced with this one's", async (tab) => {
  // As egug.fa.us2.oraclecloud.com shows a returning applicant (screenshot,
  // 2026-10-03): both slots already hold files, with Remove buttons, and
  // earlier uploads are listed to pick from.
  await context.route(`${oracleOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Personal Info</title><main>
        <div class="apply-flow-section" data-section-number="1">
          <div class="input-row"><label class="input-row__label" for="namInformation15-43">Preferred Full Name</label>
            <input class="input-row__control" id="namInformation15-43" name="namInformation15" aria-required="true" required></div>
          <h2>Supporting Documents and URLs</h2>
          <resume-upload-button id="resume-slot"></resume-upload-button>
          <attachment-preuploaded><a href="javascript:void(0)" class="file-upload-attachments-preuploaded__filename">Older_Resume.pdf</a>
            <a href="javascript:void(0)" class="file-upload-attachments-preuploaded__use-button">Use</a></attachment-preuploaded>
          <cover-letter-upload-button id="cover-slot"></cover-letter-upload-button>
        </div>
      </main>
      <script>
        window.removed = []; window.uploaded = [];
        const slot = (id, label, initial) => {
          const host = document.getElementById(id);
          const filled = (name) => {
            host.innerHTML = '<div class="attachment-upload-button attachment-upload-button--filled"><div class="attachment-upload-button__filled">'
              + '<button type="button" class="attachment-upload-button__download">' + name + '</button>'
              + '<button type="button" class="attachment-upload-button__bottom-button">Remove ' + label + '</button></div></div>';
            host.querySelector('.attachment-upload-button__bottom-button').addEventListener('click', () => {
              window.removed.push(name);
              // Oracle shows the empty slot a moment later.
              setTimeout(waiting, 300);
            });
          };
          const waiting = () => {
            host.innerHTML = '<div class="attachment-upload-button attachment-upload-button--waiting"><div class="file-form-element">'
              + '<input type="file" class="file-form-element__input upload-button" id="' + id + '-input" accept=".txt, .rtf, .doc, .docx, .pdf">'
              + '<label class="file-form-element__label" for="' + id + '-input"><span>Upload ' + label + '</span></label></div></div>';
            host.querySelector('input').addEventListener('change', (event) => {
              const name = event.target.files[0]?.name;
              if (!name) return;
              window.uploaded.push(name);
              filled(name);
            });
          };
          filled(initial);
        };
        slot('resume-slot', 'Resume', 'Old_Software_Engineer_Resume.pdf');
        // The earlier application's letter has the very name this one's will
        // (screenshot, 2026-10-03: both "Alex_Rivera_Cover_Letter.pdf").
        slot('cover-slot', 'Cover Letter', 'Rivera-cover-Personal-Info.pdf');
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${oracleOrigin}/hcmUI/CandidateExperience/en/sites/CX_1/job/1/apply/section/1`);
  await place(page, tab);
  await enqueue([page]);
  await expect.poll(() => page.evaluate(() => (window as any).uploaded.length), { timeout: 90000 }).toBe(2);
  expect(await page.evaluate(() => (window as any).removed)).toEqual(["Old_Software_Engineer_Resume.pdf", "Rivera-cover-Personal-Info.pdf"]);
  await expect(page.locator("#resume-slot .attachment-upload-button__download")).toHaveText(/\.pdf$/);
  await expect(page.locator("#resume-slot .attachment-upload-button__download")).not.toHaveText("Old_Software_Engineer_Resume.pdf");
  expect(await page.evaluate(() => (window as any).uploaded)).toContain("Rivera-cover-Personal-Info.pdf");
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 60000 })
    .toMatch(/awaiting-user|ready/);
  expect((await state()).applications[0].missing.join(" ")).not.toMatch(/upload did not finish/);
  // A second fill finds this application's files attached and leaves them.
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!, page.url());
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id, tabId });
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 60000 })
    .toMatch(/awaiting-user|ready/);
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as any).removed)).toHaveLength(2);
});

test("an Oracle step holding only Add buttons can be filled", async () => {
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      education: [{ organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-05", location: "", details: "" }],
      work: [{ organization: "Example Labs", title: "Software Engineer", location: "Tucson, AZ", details: "Built services.", startDate: "2025-05", endDate: "2026-03" }],
    },
  });
  await context.route(`${oracleOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      // Shaped like section 2 of egug.fa.us2.oraclecloud.com's apply flow
      // (issue report, 2026-09-30): no inputs until an Add button is pressed.
      body: `<!doctype html><title>Education and Experience</title><main>
        <div class="apply-flow-section" data-section-number="2">
          <h2 class="apply-flow-block__title"><span>Education</span></h2>
          <div class="apply-flow-block__form-list" role="region" aria-label="Education Required">
            <div class="profile-add-item">
              <button type="button" class="button apply-flow-profile-item-tile__new-tile" id="add-education">
                <span class="button__label">Add Education</span>
              </button>
            </div>
          </div>
          <h2 class="apply-flow-block__title"><span>Experience</span></h2>
          <div class="apply-flow-block__form-list" role="region" aria-label="Experience ">
            <div class="profile-add-item">
              <button type="button" class="button apply-flow-profile-item-tile__new-tile" id="add-experience">
                <span class="button__label">Add Experience</span>
              </button>
            </div>
          </div>
        </div>
      </main><script>
        window.added = [];
        for (const button of document.querySelectorAll('button')) button.addEventListener('click', () => window.added.push(button.id));
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${oracleOrigin}/hcmUI/CandidateExperience/en/sites/CX_1/job/1/apply/section/2`);
  // The current-tab card counts a step with no inputs yet as a form.
  await page.bringToFront();
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  const card = panel.getByRole("region", { name: "Current browser tab" });
  await expect(card).not.toContainText("No form");
  await enqueue([page]);
  await expect
    .poll(() => page.evaluate(() => (window as any).added), { timeout: 30000 })
    .toContain("add-education");
  expect((await state()).applications[0].note).not.toContain("Open the application form");
});

test("Oracle education entries are each filled from lists and saved before the next", async () => {
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      education: [
        { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-05", location: "", details: "" },
        { organization: "Pennsylvania State University", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "", details: "" },
      ],
      work: [
        { organization: "Northwind Labs", title: "Creative Technology Associate", location: "Tucson, AZ", details: "Built VR simulations.", startDate: "2026-03", endDate: "" },
        { organization: "Brightline.AI", title: "Software Engineer Intern", location: "Pune", details: "Built REST APIs.", startDate: "2023-06", endDate: "2023-09" },
      ],
    },
  });
  await context.route(`${oracleOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      // Oracle's inline profile items (recordings, 2026-09-30): Add opens a
      // form in place, dropdowns are lists of gridcells, and the footer's
      // save button (also "Add Education") saves the entry and closes it.
      // The whole step is one application form: each entry's save button is,
      // to the browser, its submit button (issue report, 2026-09-30).
      body: `<!doctype html><title>Education and Experience</title><main>
        <form class="apply-flow__content apply-flow__content-form" novalidate method="post" action="/apply-submitted">
        <div class="apply-flow-section" data-section-number="2">
          <h2 class="apply-flow-block__title"><span>Education</span></h2>
          <div class="apply-flow-block__form-list" role="region" aria-label="Education Required" id="education">
            <div class="profile-add-item"><button type="button" class="button apply-flow-profile-item-tile__new-tile" id="add-education"><span class="button__label">Add Education</span></button></div>
          </div>
          <h2 class="apply-flow-block__title"><span>Experience</span></h2>
          <div class="apply-flow-block__form-list" role="region" aria-label="Experience " id="experience">
            <div class="profile-add-item"><button type="button" class="button apply-flow-profile-item-tile__new-tile" id="add-experience"><span class="button__label">Add Experience</span></button></div>
          </div>
        </div>
        </form>
      </main><div id="lists"></div><script>
        window.saved = [];
        window.jobs = [];
        const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        const years = Array.from({ length: 15 }, (_, i) => String(2027 - i));
        const lists = document.getElementById('lists');
        const showList = (input, options) => {
          lists.innerHTML = '';
          for (const option of options) {
            const item = document.createElement('div');
            item.setAttribute('role', 'gridcell');
            item.className = 'cx-select__list-item';
            item.textContent = option;
            item.addEventListener('click', () => { input.value = option; input.dataset.picked = option; lists.innerHTML = ''; });
            lists.append(item);
          }
        };
        const row = (label, id, name) => '<div class="input-row"><label for="' + id + '">' + label + '</label><div class="input-field-container"><input id="' + id + '" name="' + name + '" role="combobox"></div></div>';
        document.getElementById('add-education').addEventListener('click', () => {
          const block = document.getElementById('education');
          block.querySelector('.profile-add-item').hidden = true;
          const form = document.createElement('div');
          form.className = 'profile-item-content';
          form.innerHTML = row('Degree', 'degree', 'contentItemId') + row('Major', 'major', 'major') + row('School', 'educationalEstablishment', 'educationalEstablishment')
            + '<div class="input-row"><label>Start Date</label>' + '<div class="input-field-container"><input id="month-startDate" name="startDate" aria-label="Start Date Month"></div><div class="input-field-container"><input id="year-startDate" name="startDate" aria-label="Start Date Year"></div></div>'
            + '<div class="input-row"><label>End Date</label>' + '<div class="input-field-container"><input id="month-endDate" name="endDate" aria-label="End Date Month"></div><div class="input-field-container"><input id="year-endDate" name="endDate" aria-label="End Date Year"></div></div>'
            + '<label class="apply-flow-input-checkbox"><span id="af-checkbox-graduatedFlag"></span><span class="apply-flow-input-checkbox__button" id="graduated"></span>Graduated</label>'
            + '<div class="app-dialog__footer"><button class="button app-dialog__footer-button save-btn">Add Education</button></div>';
          block.append(form);
          const school = form.querySelector('#educationalEstablishment');
          school.addEventListener('input', () => showList(school, school.value ? [school.value] : []));
          for (const id of ['month-startDate', 'month-endDate']) { const input = form.querySelector('#' + id); input.addEventListener('click', () => showList(input, months)); }
          for (const id of ['year-startDate', 'year-endDate']) { const input = form.querySelector('#' + id); input.addEventListener('click', () => showList(input, years)); }
          const graduated = form.querySelector('#graduated');
          graduated.addEventListener('click', () => graduated.classList.toggle('apply-flow-input-checkbox__button--checked'));
          // The page saves on click and does not stop the form submitting.
          form.querySelector('.save-btn').addEventListener('click', () => {
            const value = (id) => form.querySelector('#' + id).dataset.picked || '';
            window.saved.push({
              school: value('educationalEstablishment'),
              major: form.querySelector('#major').value,
              start: value('month-startDate') + ' ' + value('year-startDate'),
              end: value('month-endDate') + ' ' + value('year-endDate'),
              graduated: graduated.classList.contains('apply-flow-input-checkbox__button--checked'),
            });
            // Closed after the click, as a page that saves first and redraws later.
            setTimeout(() => { form.remove(); block.querySelector('.profile-add-item').hidden = false; });
          });
        });
        // Experience: Current Job takes effect only from a click, as the
        // screenshot showed an assigned tick not taking.
        document.getElementById('add-experience').addEventListener('click', () => {
          const block = document.getElementById('experience');
          block.querySelector('.profile-add-item').hidden = true;
          const form = document.createElement('div');
          form.className = 'profile-item-content';
          form.innerHTML = '<div class="input-row"><label for="employerName">Employer Name</label><input id="employerName" name="employerName" class="input-row__control"></div>'
            + '<div class="input-row"><label for="jobTitle">Job Title</label><input id="jobTitle" name="jobTitle" class="input-row__control"></div>'
            + '<div class="input-row"><label>Start Date</label><div class="input-field-container"><input id="month-startDate-x" aria-label="Start Date Month"></div><div class="input-field-container"><input id="year-startDate-x" aria-label="Start Date Year"></div></div>'
            + '<div class="input-row"><label>End Date</label><div class="input-field-container"><input id="month-endDate-x" aria-label="End Date Month"></div><div class="input-field-container"><input id="year-endDate-x" aria-label="End Date Year"></div></div>'
            + '<div class="input-row"><input type="checkbox" id="af-checkbox-currentJobFlag-1" class="input-row__hidden-control"><label for="af-checkbox-currentJobFlag-1">Current Job</label></div>'
            + '<div class="app-dialog__footer"><button class="button app-dialog__footer-button save-btn">Add Experience</button></div>';
          block.append(form);
          for (const id of ['month-startDate-x', 'month-endDate-x']) { const input = form.querySelector('#' + id); input.addEventListener('click', () => showList(input, months)); }
          for (const id of ['year-startDate-x', 'year-endDate-x']) { const input = form.querySelector('#' + id); input.addEventListener('click', () => showList(input, years)); }
          let current = false;
          const box = form.querySelector('#af-checkbox-currentJobFlag-1');
          box.addEventListener('click', () => { current = box.checked; });
          box.addEventListener('change', () => setTimeout(() => { box.checked = current; }));
          form.querySelector('.save-btn').addEventListener('click', () => {
            const picked = (id) => form.querySelector('#' + id).dataset.picked || '';
            window.jobs.push({
              employer: form.querySelector('#employerName').value,
              title: form.querySelector('#jobTitle').value,
              start: picked('month-startDate-x') + ' ' + picked('year-startDate-x'),
              current,
            });
            // Closed after the click, as a page that saves first and redraws later.
            setTimeout(() => { form.remove(); block.querySelector('.profile-add-item').hidden = false; });
          });
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().startsWith(oracleOrigin)) posts++;
  });
  await page.goto(`${oracleOrigin}/hcmUI/CandidateExperience/en/sites/CX_1/job/1/apply/section/2`);
  await enqueue([page]);
  await expect
    .poll(() => page.evaluate(() => (window as any).saved.length), { timeout: 60000 })
    .toBe(2);
  await expect
    .poll(() => page.evaluate(() => (window as any).jobs.length), { timeout: 60000 })
    .toBe(2);
  expect(await page.evaluate(() => (window as any).jobs)).toEqual([
    { employer: "Northwind Labs", title: "Creative Technology Associate", start: "March 2026", current: true },
    { employer: "Brightline.AI", title: "Software Engineer Intern", start: "June 2023", current: false },
  ]);
  expect(await page.evaluate(() => (window as any).saved)).toEqual([
    { school: "Michigan State University", major: "Data Science", start: "August 2025", end: "May 2027", graduated: false },
    { school: "Pennsylvania State University", major: "Computer Science", start: "September 2020", end: "June 2024", graduated: true },
  ]);
  // Saving entries never submitted the application form.
  expect(posts).toBe(0);
});

test("Oracle language skill pills take each language's level from the profile", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, languages: ["English: Native", "Spanish: Intermediate"] } });
  await context.route(`${oracleOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      // egug.fa.us2.oraclecloud.com (report 395479e7, 2026-10-25): an added
      // language row asks Reading, Writing and Speaking as pills, buttons
      // already showing their text, which a value write took for answered.
      body: `<!doctype html><title>Education and Experience</title><main>
        <div class="apply-flow-section" data-section-number="2">
          <h2 class="apply-flow-block__title"><span>Languages</span></h2>
          <div class="apply-flow-block__form-list" role="region" aria-label="Languages " id="languages">
            <div class="profile-add-item"><button type="button" class="button apply-flow-profile-item-tile__new-tile" id="add-language"><span class="button__label">Add Language</span></button></div>
          </div>
        </div>
      </main><div id="lists"></div><script>
        window.saved = [];
        const lists = document.getElementById('lists');
        const pills = (label) => '<div class="input-row input-row--has-picker"><label class="input-row__label"><span>' + label + '</span></label>'
          + '<div class="input-row__control-container"><ul role="radiogroup" aria-label="' + label + '" class="cx-select-pills-container">'
          + ['Advanced', 'Intermediate', 'Beginner'].map((level) => '<li role="presentation"><button type="button" role="radio" aria-checked="false" class="cx-select-pill-section "><span class="cx-select-pill-name"> ' + level + '</span></button></li>').join('')
          + '</ul></div></div>';
        document.getElementById('add-language').addEventListener('click', () => {
          const block = document.getElementById('languages');
          block.querySelector('.profile-add-item').hidden = true;
          const form = document.createElement('div');
          form.className = 'profile-item-content';
          form.innerHTML = '<div class="input-row"><label for="language"><span>Language</span></label><div class="input-field-container"><input id="language" role="combobox" class="cx-select-input"></div></div>'
            + pills('Reading') + pills('Writing') + pills('Speaking')
            + '<div class="profile-item-footer"><button class="button app-dialog__footer-button save-btn"><span class="button__label">Add Language</span></button></div>';
          block.append(form);
          const input = form.querySelector('#language');
          input.addEventListener('input', () => {
            lists.innerHTML = '';
            for (const option of ['English', 'Spanish'].filter((o) => input.value && o.startsWith(input.value))) {
              const item = document.createElement('div');
              item.setAttribute('role', 'gridcell');
              item.className = 'cx-select__list-item';
              item.textContent = option;
              item.addEventListener('click', () => { input.value = option; input.dataset.picked = option; lists.innerHTML = ''; });
              lists.append(item);
            }
          });
          for (const pill of form.querySelectorAll('.cx-select-pill-section')) pill.addEventListener('click', () => {
            for (const other of pill.closest('ul').querySelectorAll('button')) {
              other.classList.toggle('cx-select-pill-section--selected', other === pill);
              other.setAttribute('aria-checked', String(other === pill));
            }
          });
          form.querySelector('.save-btn').addEventListener('click', () => {
            const level = (label) => form.querySelector('ul[aria-label="' + label + '"] [aria-checked="true"]')?.textContent.trim() || '';
            window.saved.push({ language: input.dataset.picked || '', reading: level('Reading'), writing: level('Writing'), speaking: level('Speaking') });
            setTimeout(() => { form.remove(); block.querySelector('.profile-add-item').hidden = false; });
          });
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${oracleOrigin}/hcmUI/CandidateExperience/en/sites/CX_1/job/1/apply/section/2`);
  await enqueue([page]);
  await expect
    .poll(() => page.evaluate(() => (window as any).saved.length), { timeout: 60000 })
    .toBe(2);
  expect(await page.evaluate(() => (window as any).saved)).toEqual([
    { language: "English", reading: "Advanced", writing: "Advanced", speaking: "Advanced" },
    { language: "Spanish", reading: "Intermediate", writing: "Intermediate", speaking: "Intermediate" },
  ]);
});

test("Oracle entries already saved to the candidate profile are kept, not added again", async () => {
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      education: [
        // Named more fully than the tile names it (Nokia's, report 1f68e4f9).
        { organization: "Example State University", title: "Master of Science", fieldOfStudy: "M.S. Data Science, Statistics & Engineering (Applied Systems)", startDate: "2025-08", endDate: "2027-12", location: "", details: "" },
        { organization: "Example Polytechnic", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "", details: "" },
      ],
      work: [
        { organization: "Example Labs", title: "Research Associate", location: "Tucson, AZ", details: "Built simulations.", startDate: "2026-03", endDate: "" },
        { organization: "Sample Corp", title: "Software Engineer Intern", location: "Phoenix, AZ", details: "Built APIs.", startDate: "2023-07", endDate: "2023-09" },
      ],
    },
  });
  // egug.fa.us2.oraclecloud.com (report e5a51b64, 2026-10-24): entries saved
  // to the candidate profile show as tiles with no fields, the major (or job
  // title, employer) and dates. The fill added every profile row again.
  const tile = (title: string, subtitle: string) =>
    `<article class="apply-flow-profile-item-tile"><div class="apply-flow-profile-item-tile__summary" role="group" tabindex="0" aria-label="${title} ${subtitle}">
      <div class="apply-flow-profile-item-tile__summary-content"><div class="apply-flow-profile-item-tile__summary-title"><span>${title}</span></div>
      <div class="apply-flow-profile-item-tile__summary-subtitle text-color-secondary">${subtitle}</div></div>
      <div class="apply-flow-profile-item-tile__actions-container"><button class="apply-flow-profile-item-tile__edit-item-icon" aria-label="Edit"></button><button class="apply-flow-profile-item-tile__delete-icon" aria-label="Delete"></button></div>
    </div></article>`;
  await context.route(`${oracleOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Education and Experience</title><main>
        <div class="apply-flow-section" data-section-number="2">
          <h2 class="apply-flow-block__title"><span>Education</span></h2>
          <div class="apply-flow-block__form-list" role="region" aria-label="Education " id="education">
            <div class="profile-item-list" role="group">${tile("Computer Science", "\n09/2020 - 06/2024")}${tile("Data Science", "Example State University\n08/2025 - 05/2027")}</div>
            <div class="profile-add-item"><button type="button" class="button apply-flow-profile-item-tile__new-tile" id="add-education"><span class="button__label">Add Education</span></button></div>
          </div>
          <h2 class="apply-flow-block__title"><span>Experience</span></h2>
          <div class="apply-flow-block__form-list" role="region" aria-label="Experience " id="experience">
            <div class="profile-item-list" role="group">${tile("Research Associate", "Example Labs\n03/2026 - Present")}</div>
            <div class="profile-add-item"><button type="button" class="button apply-flow-profile-item-tile__new-tile" id="add-experience"><span class="button__label">Add Experience</span></button></div>
          </div>
        </div>
      </main><script>
        window.saved = [];
        const open = (id, fields, label) => {
          const block = document.getElementById(id);
          block.querySelector('.profile-add-item').hidden = true;
          const form = document.createElement('div');
          form.className = 'profile-item-content';
          form.innerHTML = fields + '<div class="app-dialog__footer"><button class="button app-dialog__footer-button save-btn">' + label + '</button></div>';
          block.append(form);
          form.querySelector('.save-btn').addEventListener('click', () => {
            window.saved.push([...form.querySelectorAll('input')].map((input) => input.value).join(' / '));
            setTimeout(() => { form.remove(); block.querySelector('.profile-add-item').hidden = false; });
          });
        };
        document.getElementById('add-education').addEventListener('click', () => open('education',
          '<div class="input-row"><label for="major">Major</label><input id="major" name="major"></div>'
          + '<div class="input-row"><label for="school">School</label><input id="school" name="educationalEstablishment"></div>', 'Add Education'));
        document.getElementById('add-experience').addEventListener('click', () => open('experience',
          '<div class="input-row"><label for="employerName">Employer Name</label><input id="employerName" name="employerName" class="input-row__control"></div>'
          + '<div class="input-row"><label for="jobTitle">Job Title</label><input id="jobTitle" name="jobTitle" class="input-row__control"></div>', 'Add Experience'));
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${oracleOrigin}/hcmUI/CandidateExperience/en/sites/CX_1/job/1/apply/section/2`);
  await enqueue([page]);
  await expect
    .poll(() => page.evaluate(() => (window as any).saved), { timeout: 60000 })
    .toContainEqual(expect.stringContaining("Sample Corp"));
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 60000 }).toMatch(/^(awaiting-user|ready)$/);
  const saved: string[] = await page.evaluate(() => (window as any).saved);
  expect(saved.filter((entry) => /Example Labs|Example State|Data Science|Computer Science/.test(entry))).toEqual([]);
  expect(saved.filter((entry) => entry.includes("Sample Corp"))).toHaveLength(1);
});

test("Oracle's race list is answered from the profile, and its City rule never writes there", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, city: "Tucson", ethnicity: "Asian" } });
  await context.route(`${oracleOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      // From an Amex demographics step (recording, 2026-09-30): the race box's
      // id holds "Ethnicity", which contains "city".
      body: `<!doctype html><title>More About You</title><main>
        <div class="apply-flow-section" data-section-number="4">
          <div class="input-row"><label class="input-row__label" for="US-DFF-axpOrcEthnicityUs-ATTRIBUTE11-60"><span class="input-row__label-text">Race/Ethnic Group</span></label>
            <div class="input-field-container"><input id="US-DFF-axpOrcEthnicityUs-ATTRIBUTE11-60" name="US-DFF-axpOrcEthnicityUs-ATTRIBUTE11" role="combobox" class="cx-select-input"></div></div>
        </div>
      </main><div id="lists"></div><script>
        window.typed = [];
        const input = document.querySelector('input');
        input.addEventListener('input', (event) => window.typed.push(event.target.value));
        // Oracle's cx-select: a list of grid cells, filtered by what is typed;
        // only a click on one sets the answer.
        const options = ["American Indian or Alaska Native (Not Hispanic or Latino)", "Asian (Not Hispanic or Latino)", "Black or African American (Not Hispanic or Latino)", "White (Not Hispanic or Latino)", "I do not wish to provide this information"];
        const lists = document.getElementById('lists');
        const show = () => {
          lists.innerHTML = '';
          const query = input.dataset.picked ? '' : input.value.toLowerCase();
          for (const option of options.filter((o) => o.toLowerCase().includes(query))) {
            const item = document.createElement('div');
            item.setAttribute('role', 'gridcell');
            item.className = 'cx-select__list-item';
            item.textContent = option;
            item.addEventListener('click', () => { input.value = option; input.dataset.picked = option; lists.innerHTML = ''; });
            lists.append(item);
          }
        };
        input.addEventListener('click', show);
        // As on Amex's page (recording, 2026-09-30): leaving the box closes
        // the list, and only typing a person does filters it; text a script
        // writes changes nothing.
        input.addEventListener('blur', () => setTimeout(() => { lists.innerHTML = ''; }, 50));
        input.addEventListener('input', (event) => { if (event.isTrusted) { delete input.dataset.picked; show(); } });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${oracleOrigin}/hcmUI/CandidateExperience/en/sites/CX_1/job/1/apply/section/4`);
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0]?.status, { timeout: 30000 })
    .toMatch(/ready|awaiting-user/);
  expect(await page.evaluate(() => (window as any).typed)).not.toContain("Tucson");
  await expect(page.locator("input")).toHaveAttribute("data-picked", "Asian (Not Hispanic or Latino)");
});

test("an embedded frame that never finishes loading does not hold up tracking or filling", async () => {
  // As awardco.com and Scale AI's board (full eval runs, 2026-10-07): a
  // third-party frame that never finishes loading kept the tab "loading" and
  // script injection pending, so the fill waited for the page for good.
  const tracker = atsOrigins[2];
  await context.route(`${tracker}/never.js`, () => {
    /* Never answered: the frame, and so the tab, stays loading. */
  });
  await context.route(`${tracker}/pixel-frame`, (route) =>
    route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Pixel</title><script src="/never.js"></script>' }),
  );
  await context.route(`${origin}/stalled-frame`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Software Engineer</title><main><form>
        <label>First name<input name="first_name"></label>
        <label>Last name<input name="last_name"></label>
        <label>Email<input type="email" name="email"></label>
      </form><iframe width="300" height="100" src="${tracker}/pixel-frame"></iframe></main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/stalled-frame`, { waitUntil: "domcontentloaded" });
  await expect(page.locator('[name="first_name"]')).toBeVisible();
  await enqueue([page]);
  await expect(page.locator('[name="first_name"]')).toHaveValue(profile.firstName, { timeout: 60000 });
  await expect(page.locator('[name="email"]')).toHaveValue(profile.email);
});

test("a forced resume dialog that fills the application is recognized as replacing the form", async () => {
  // Paylocity (seen live, 2026-10-07): the page opens under an "Apply with
  // resume" dialog whose upload rewrites the form. It was not recognized, so
  // the form was filled behind the dialog and the later upload parsed over it.
  await context.route(`${paylocityOrigin}/forced-resume`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Software Intern</title><main>
        <div class="modal" id="forceUploadResumeModal" role="dialog"><div class="modal-dialog"><div class="modal-content">
          <div class="modal-header"><h2>Apply with resume</h2></div>
          <div class="modal-body"><p>Upload your resume and we'll automatically fill out your application</p></div>
          <div class="modal-footer"><input accept=".doc,.docx,.pdf" id="btn-forceResume" type="file" style="display: none;"><button type="button">Upload Resume</button></div>
        </div></div></div>
        <form><label>First name<input name="first_name"></label><label>Last name<input name="last_name"></label><label>Email<input type="email" name="email"></label></form></main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${paylocityOrigin}/forced-resume`);
  await enqueue([page]);
  const fields: { kind: string; replacesForm?: boolean }[] = (await content(page, { type: "INSPECT" })).data.fields;
  expect(fields.find((field) => field.kind === "file")?.replacesForm).toBe(true);
});

test("Paylocity Citrus pickers fill each address and keep education values in their own rows", async () => {
  test.setTimeout(120000);
  // Paylocity, report 9a0880b3: Citrus uses functional components, not
  // react-select; repeated addresses and schools need independent answers.
  const compiled = await build({ entryPoints: ["tests/browser/paylocity-history-fixture.tsx"], bundle: true, write: false, format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  await context.route(`${paylocityOrigin}/**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Software Intern</title><div id="root"></div><script>${compiled.outputFiles[0].text}</script>` }));
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: {
    ...profile, state: "Arizona",
    work: [
      { organization: "Example Labs", title: "Developer", country: "United States", state: "Arizona", startDate: "2025-03", endDate: "" },
      { organization: "Sample Systems", title: "Intern", country: "India", startDate: "2023-06", endDate: "2023-09" },
    ],
    education: [
      { organization: "Example University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-12" },
      { organization: "Sample College", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06" },
    ],
  } });
  const page = await context.newPage();
  await page.goto(`${paylocityOrigin}/Recruiting/Jobs/Apply/history-fixture`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect(page.locator('[id="info.firstName"]')).toHaveValue(profile.firstName, { timeout: 30000 });
  const selected = (id: string) => page.locator(`[id="${id}-select-wrapper"] .input-select-input-single-value`);
  await expect(selected("public-site-address-us-state")).toHaveText("AZ", { timeout: 30000 });
  await expect(selected("public-candidate-work-history-address-0-us-state")).toHaveText("AZ", { timeout: 30000 });
  await expect(selected("public-candidate-work-history-address-1-country")).toHaveText("India");
  await expect(selected("public-candidate-work-history-address-1-us-state")).toHaveText("Select a state");
  await expect(page.locator('[data-automation-id="educationHistoryName0"]')).toHaveValue("Example University");
  await expect(page.locator('[data-automation-id="educationHistoryName1"]')).toHaveValue("Sample College");
  await expect(page.locator('[id="educationHistory.degreeId.0"] .rw-input')).toHaveText("Master");
  await expect(page.locator('[id="educationHistory.degreeId.1"] .rw-input')).toHaveText("Bachelor");
  await expect(page.locator('[data-automation-id="txt-educationHistory-graduationDate-1"]')).toHaveValue("06/2024");
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 90000 }).toMatch(/^(ready|awaiting-user)$/);
  await expect(selected("public-candidate-work-history-address-1-country")).toHaveText("India");
  await expect(page.locator('[data-automation-id="educationHistoryName1"]')).toHaveValue("Sample College");
  await expect(page.locator('[data-automation-id="txt-educationHistory-graduationDate-1"]')).toHaveValue("06/2024");
  const fields = (await content(page, { type: "INSPECT" })).data.fields;
  expect(fields.filter((field: { label: string }) => /State|Country|School Name/.test(field.label)).every((field: { protected: boolean }) => !field.protected)).toBe(true);
});

test("each Paylocity work and education block is its own row, not one ambiguous field", async () => {
  // Issue report, 2026-10-07: every job repeats Company Name, City, State…
  // and every school repeats School Name and GPA. With no row they were
  // refused as "another field has the same label", and both schools were
  // filled from the first one.
  const block = (kind: string, title: string, fields: string) =>
    `<div class="col-xs-12 ${kind}-history-group"><div><div class="section-heading">${title}</div></div>${fields}</div>`;
  const job = '<div class="form-group"><label>Company Name</label><input name="company"></div><div class="form-group"><label>City</label><input name="jobcity"></div>';
  const school = '<div class="form-group"><label>School Name</label><input name="school"></div>';
  await context.route(`${paylocityOrigin}/rows`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Software Intern</title><main><form>
        <label>First Name<input name="first_name"></label><label>Last Name<input name="last_name"></label><label>Email Address<input name="email"></label>
        <div class="section-heading">Work History</div>${block("work", "Work History 1", job)}${block("work", "Work History 2", job)}
        <div class="section-heading">Education History</div>${block("education", "Education History 1", school)}${block("education", "Education History 2", school)}
      </form></main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${paylocityOrigin}/rows`);
  await enqueue([page]);
  await expect(page.locator('[name="first_name"]')).toHaveValue(profile.firstName, { timeout: 30000 });
  const fields: { label: string; section?: string; index?: number; protected: boolean }[] = (await content(page, { type: "INSPECT" })).data.fields;
  const rows = (label: string) => fields.filter((field) => field.label === label).map((field) => [field.section, field.index, field.protected]);
  expect(rows("Company Name")).toEqual([["Work History", 0, false], ["Work History", 1, false]]);
  expect(rows("City")).toEqual([["Work History", 0, false], ["Work History", 1, false]]);
  expect(rows("School Name")).toEqual([["Education History", 0, false], ["Education History", 1, false]]);
});

test("an Avature work section titled by a paragraph gets a filled row for each job", async () => {
  // Intuit's Avature Register page (form check, rows-short | work): the
  // section's title is a <p>, not a <label>, so the site config never found
  // its rows, added none, and every row's Employer was one ambiguous field.
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      work: [
        { organization: "Example Labs", title: "Software Engineer", location: "Tucson, AZ", details: "Built services.", startDate: "2025-05", endDate: "" },
        { organization: "Sample AI", title: "Intern", location: "Remote", details: "Built APIs.", startDate: "2023-06", endDate: "2023-09" },
      ],
    },
  });
  const field = (row: string, n: number, label: string) =>
    `<div class="fieldSpec TextField fieldSpec--in-dataset"><label class="WizardFieldLabel" for="1354-${n}-${row}" id="1354-${n}-${row}-label">${label}</label><input type="text" id="1354-${n}-${row}" name="1354-${n}-${row}" class="TextField WizardFieldInput" aria-labelledby="1354-${n}-${row}-label"></div>`;
  const row = (id: string) =>
    `<fieldset class="datasetField__row${id === "sample" ? " datasetField__row--sample" : ""}" id="datasetField__row--1354_${id}"${id === "sample" ? ' aria-hidden="true" hidden=""' : ""}>${field(id, 1, "Employer")}${field(id, 2, "Position title")}<div class="datasetField__button"><a href="javascript:void(0)" name="removeRowFor_1354" role="button" class="WizardFieldLink">remove</a></div></fieldset>`;
  await context.route(`${avatureOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Software Engineer</title><main><form>
        <fieldset><legend class="WizardFieldLabel">Personal information</legend>
          <div class="fieldSpec"><label class="WizardFieldLabel" for="first">Preferred first name</label><input type="text" id="first" name="first" class="WizardFieldInput"></div>
          <div class="fieldSpec datasetField"><p class="WizardFieldLabel tc_formLabel" id="1354-label">Work experience</p>
            <div class="datasetcontent" id="1354" role="group" aria-labelledby="1354-label">${row("sample")}${row("0")}
              <div class="datasetField__button--add"><a href="#" id="addRowFor_1354" role="button" class="WizardFieldLink">add another</a></div>
            </div>
          </div>
        </fieldset>
      </form></main><script>
        let rows = 1;
        document.querySelector('#addRowFor_1354').addEventListener('click', (event) => {
          event.preventDefault();
          const sample = document.querySelector('#datasetField__row--1354_sample');
          const html = sample.outerHTML.replaceAll('sample', String(rows++)).replace(' aria-hidden="true" hidden=""', '').replace(' datasetField__row--' + (rows - 1), '');
          event.target.parentElement.insertAdjacentHTML('beforebegin', html);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${avatureOrigin}/en_US/careers/Register?pipelineId=1`);
  await enqueue([page]);
  await expect(page.locator("#first")).toHaveValue(profile.firstName, { timeout: 30000 });
  const input = (id: string) => page.locator(`[id="${id}"]`);
  await expect(input("1354-1-0")).toHaveValue("Example Labs", { timeout: 30000 });
  await expect(input("1354-1-1")).toHaveValue("Sample AI");
  await expect(input("1354-2-1")).toHaveValue("Intern");
});

test("each Avature job row gets its own start and end month, added rows too", async () => {
  // Intuit's Avature Register page (fill capture, 2026-10-17): the third
  // job, in a row the extension added, kept no end month and showed a start
  // month from no job in the profile.
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      work: [
        { organization: "Example Labs", title: "Software Engineer", location: "Tucson, AZ", details: "Built services.", startDate: "2026-03-27", endDate: "" },
        { organization: "Side Project", title: "Founder", location: "Remote", details: "Built a site.", startDate: "2025-03-01", endDate: "" },
        { organization: "Sample AI", title: "Intern", location: "Remote", details: "Built APIs.", startDate: "2023-07-03", endDate: "2023-09-08" },
      ],
    },
  });
  const labelled = (row: string, n: number, label: string, control: string) =>
    `<div class="fieldSpec fieldSpecPadder fieldSpec--in-dataset" id="fieldSpecContainer1354-${n}-${row}"><label class="WizardFieldLabel tc_formLabel" for="1354-${n}-${row}" id="1354-${n}-${row}-label">${label}</label>${control}</div>`;
  const text = (row: string, n: number, label: string) =>
    labelled(row, n, label, `<input type="text" id="1354-${n}-${row}" name="1354-${n}-${row}" class="TextField WizardFieldInputContainer WizardFieldInput" aria-labelledby="1354-${n}-${row}-label">`);
  const month = (row: string, n: number, label: string) =>
    `<div class="fieldSpec DateFormField fieldSpecPadder fieldSpec--in-dataset" id="fieldSpecContainer1354-${n}-${row}"><div id="1354-${n}-${row}-accessibleContainer"><label class="WizardFieldLabel tc_formLabel" for="1354-${n}-${row}" id="1354-${n}-${row}-label">${label}</label><input type="month" id="1354-${n}-${row}" name="1354-${n}-${row}" class="DateFormField WizardFieldInputContainer WizardFieldInput" aria-labelledby="1354-${n}-${row}-label"></div></div>`;
  const current = (row: string) =>
    labelled(row, 6, "Current position?", `<select name="1354-6-${row}" id="1354-6-${row}" class="SelectFormField WizardFieldInputContainer WizardFieldInput" aria-labelledby="1354-6-${row}-label"><option value="">Select an option</option><option value="7">Yes</option><option value="8">No</option></select>`);
  const row = (id: string) =>
    `<fieldset class="datasetField__row${id === "sample" ? " datasetField__row--sample" : ""}" id="datasetField__row--1354_${id}"${id === "sample" ? ' aria-hidden="true" hidden=""' : ""}>${text(id, 1, "Employer")}${text(id, 2, "Position title")}${current(id)}${month(id, 4, "Start date")}${month(id, 5, "End date")}<div class="datasetField__button"><a href="javascript:void(0)" name="removeRowFor_1354" role="button" class="WizardFieldLink">remove</a></div></fieldset>`;
  await context.route(`${avatureOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Software Engineer</title><main><form>
        <fieldset><legend class="WizardFieldLabel">Personal information</legend>
          <div class="fieldSpec"><label class="WizardFieldLabel" for="first">Preferred first name</label><input type="text" id="first" name="first" class="WizardFieldInput"></div>
          <div class="fieldSpec datasetField"><p class="WizardFieldLabel tc_formLabel" id="1354-label">Work experience</p>
            <div class="datasetcontent" id="1354" role="group" aria-labelledby="1354-label">${row("sample")}${row("0")}${row("1")}
              <div class="datasetField__button--add"><a href="#" id="addRowFor_1354" role="button" class="WizardFieldLink">add another</a></div>
            </div>
          </div>
        </fieldset>
      </form></main><script>
        let rows = 2;
        document.querySelector('#addRowFor_1354').addEventListener('click', (event) => {
          event.preventDefault();
          const sample = document.querySelector('#datasetField__row--1354_sample');
          const html = sample.outerHTML.replaceAll('sample', String(rows++)).replace(' aria-hidden="true" hidden=""', '').replace(' datasetField__row--' + (rows - 1), '');
          event.target.parentElement.insertAdjacentHTML('beforebegin', html);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${avatureOrigin}/en_US/careers/Register?pipelineId=1`);
  await enqueue([page]);
  const input = (id: string) => page.locator(`[id="${id}"]`);
  await expect(input("1354-1-2")).toHaveValue("Sample AI", { timeout: 30000 });
  // Start, end and current, row by row.
  const dates = () => Promise.all(["0", "1", "2"].map((row) => Promise.all([4, 5, 6].map((n) => input(`1354-${n}-${row}`).inputValue()))));
  await expect.poll(dates, { timeout: 30000 }).toEqual([
    ["2026-03", "", "7"],
    ["2025-03", "", "7"],
    ["2023-07", "2023-09", "8"],
  ]);
});

test("each Avature school row gets its school from the site's search, its major and whether it was finished", async () => {
  // Intuit's Avature Register page (fill capture, 2026-10-17): University/
  // School lists only what its server finds for the typed text, and the
  // rules gave it no school; "Did you graduate?" was answered with a year.
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      education: [
        // Its common name; the server knows only the official one.
        { organization: "Virginia Tech", title: "Master of Science", fieldOfStudy: "Data Science", location: "Blacksburg, VA", details: "", startDate: "2025-08", endDate: "2099-05" },
        { organization: "Pennsylvania State University, University Park", title: "Bachelor of Science", fieldOfStudy: "Computer Science", location: "", details: "", startDate: "2015-09", endDate: "2019-06" },
      ],
    },
  });
  const labelled = (row: string, n: number, label: string, control: string, extra = "") =>
    `<div class="fieldSpec fieldSpecPadder fieldSpec--in-dataset${extra}" id="fieldSpecContainer1353-${n}-${row}"><label class="WizardFieldLabel tc_formLabel" for="1353-${n}-${row}" id="1353-${n}-${row}-label">${label}</label>${control}</div>`;
  const select = (row: string, n: number, label: string, options: [string, string][]) =>
    labelled(row, n, label, `<select name="1353-${n}-${row}" id="1353-${n}-${row}" class="SelectFormField WizardFieldInputContainer WizardFieldInput" aria-labelledby="1353-${n}-${row}-label"><option value="">Select an option</option>${options.map(([value, text]) => `<option value="${value}">${text}</option>`).join("")}</select>`);
  const school = (row: string) =>
    `<div class="fieldSpec SelectFormField AutoCompleteField fieldSpecPadder fieldSpec--in-dataset" id="fieldSpecContainer1353-9-${row}"><label class="WizardFieldLabel tc_formLabel" for="1353-9-${row}" id="1353-9-${row}-label">University/School<span class="screenReaderVisibility" aria-hidden="true">Select an option</span></label><div class="ui-widget AutocompleteSelectFieldUIWidget"><select name="1353-9-${row}" id="1353-9-${row}" class="SelectFormField AutoCompleteField select2-hidden-accessible" aria-hidden="true" tabindex="-1"><option selected></option></select><span class="select2 select2-container WizardFieldInputContainer WizardFieldInput select2-container--default"><span class="selection"><span class="select2-selection select2-selection--single" role="combobox" aria-labelledby="1353-9-${row}-label" aria-haspopup="true" aria-expanded="false" tabindex="0"><span class="select2-selection__rendered WizardFieldInput" role="textbox" aria-readonly="true"><span class="select2-selection__placeholder WizardFieldInput">Select an option</span></span></span></span></span></div></div>`;
  const row = (id: string) =>
    `<fieldset class="datasetField__row${id === "sample" ? " datasetField__row--sample" : ""}" id="datasetField__row--1353_${id}"${id === "sample" ? ' aria-hidden="true" hidden=""' : ""}>${select(id, 2, "Degree", [["18", "Bachelor's Degree"], ["19", "Master's Degree"]])}${school(id)}${labelled(id, 1, "Major", `<input type="text" id="1353-1-${id}" name="1353-1-${id}" class="TextField WizardFieldInputContainer WizardFieldInput" aria-labelledby="1353-1-${id}-label">`)}${select(id, 5, "Did you graduate?", [["7", "Yes"], ["8", "No"]])}<div class="datasetField__button"><a href="javascript:void(0)" name="removeRowFor_1353" role="button" class="WizardFieldLink">remove</a></div></fieldset>`;
  await context.route(`${avatureOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Software Engineer</title><main><form>
        <fieldset><legend class="WizardFieldLabel">Personal information</legend>
          <div class="fieldSpec"><label class="WizardFieldLabel" for="first">Preferred first name</label><input type="text" id="first" name="first" class="WizardFieldInput"></div>
          <div class="fieldSpec datasetField"><p class="WizardFieldLabel tc_formLabel" id="1353-label">Education History</p>
            <div class="datasetcontent" id="1353" role="group" aria-labelledby="1353-label">${row("sample")}${row("0")}${row("1")}
              <div class="datasetField__button--add"><a href="#" id="addRowFor_1353" role="button" class="WizardFieldLink">add another</a></div>
            </div>
          </div>
        </fieldset>
      </form></main><script>
        // The server's school list, searched as Select2 asks it: by the
        // words typed, with each campus its own school. Searched for
        // "Virginia Tech", it finds only the Carilion medical school.
        const schools = Object.fromEntries(${JSON.stringify([...realSchools, "Pennsylvania State University-University Park"])}.map((name, index) => [String(11 + index), name]));
        let open;
        const close = () => { open?.list.remove(); open?.control.setAttribute("aria-expanded", "false"); open = undefined; };
        document.addEventListener("mousedown", (event) => {
          const control = event.target.closest(".select2-selection");
          if (!control) return;
          if (open) return close();
          const list = document.createElement("span");
          list.className = "select2-container select2-container--default select2-container--open";
          list.style.position = "absolute";
          list.innerHTML = '<span class="select2-dropdown"><span class="select2-search"><input class="select2-search__field" type="search"></span><span class="select2-results"><ul class="select2-results__options" role="listbox" aria-expanded="true" aria-hidden="false"></ul></span></span>';
          document.body.append(list);
          control.setAttribute("aria-expanded", "true");
          open = { control, list };
          const box = list.querySelector("input");
          const results = list.querySelector("ul");
          let timer;
          box.addEventListener("input", () => {
            clearTimeout(timer);
            results.innerHTML = '<li class="select2-results__option loading-results" role="option" aria-disabled="true">Searching…</li>';
            timer = setTimeout(() => {
              const found = Object.entries(schools).filter(([, name]) => name.toLowerCase().includes(box.value.trim().toLowerCase()));
              results.innerHTML = found.length
                ? found.map(([id, name]) => '<li class="select2-results__option" role="option" aria-selected="false" data-id="' + id + '">' + name + '</li>').join("")
                : '<li role="alert" class="select2-results__option select2-results__message">No results found</li>';
            }, 300);
          });
          results.addEventListener("mouseup", (up) => {
            const item = up.target.closest("li[data-id]");
            if (!item) return;
            const select = control.closest(".select2-container").previousElementSibling;
            select.innerHTML = '<option value="' + item.dataset.id + '" selected>' + item.textContent + '</option>';
            select.dispatchEvent(new Event("change", { bubbles: true }));
            control.querySelector(".select2-selection__rendered").textContent = item.textContent;
            close();
          });
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${avatureOrigin}/en_US/careers/Register?pipelineId=1`);
  await enqueue([page]);
  const input = (id: string) => page.locator(`[id="${id}"]`);
  // School, major and graduated, row by row.
  const schoolRows = () => Promise.all(["0", "1"].map((id) => Promise.all([9, 1, 5].map((n) => input(`1353-${n}-${id}`).inputValue()))));
  await expect.poll(schoolRows, { timeout: 60000 }).toEqual([
    ["37", "Data Science", "8"],
    ["41", "Computer Science", "7"],
  ]);
  await expect.poll(async () => (await state()).applications[0]?.missing.join(" ")).not.toMatch(/same label|filled in by the site/);
});

test("a question written as text above its options labels the radios and checkboxes under it", async () => {
  // Paylocity's screener questions (issue report, 2026-10-07): a paragraph,
  // then one row per option, with nothing tying them together. The fields
  // were named after the inputs ("multiQuestionAnswer1856497") and no
  // question could be answered or shown.
  const question = (id: number, text: string, type: string, options: string[]) =>
    `<div class="form-group multi-question"><p><span class="type-semibold">${text}</span> (required)</p>${options
      .map((option, index) => `<div class="drag-edit-radios"><input id="multiQuestionAnswer${id}_${index}" name="multiQuestionAnswer${id}" type="${type}"><label for="multiQuestionAnswer${id}_${index}">${option}</label></div>`)
      .join("")}</div>`;
  await context.route(`${paylocityOrigin}/screener`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Software Intern</title><main><form>
        <label>First name<input name="first_name"></label><label>Last name<input name="last_name"></label><label>Email<input type="email" name="email"></label>
        ${question(1, "Are you able to work on-site in Bohemia, NY for this internship?", "radio", ["Yes", "No"])}
        ${question(2, "Which languages are you comfortable with?", "checkbox", ["Python", "C#"])}
      </form></main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${paylocityOrigin}/screener`);
  await enqueue([page]);
  await expect(page.locator('[name="first_name"]')).toHaveValue(profile.firstName, { timeout: 30000 });
  const fields: { label: string; kind: string; required: boolean; options: string[] }[] = (await content(page, { type: "INSPECT" })).data.fields;
  const radio = fields.find((field) => field.kind === "radio")!;
  expect(radio.label).toBe("Are you able to work on-site in Bohemia, NY for this internship?");
  expect(radio.options).toEqual(["Yes", "No"]);
  expect(radio.required).toBe(true);
  expect(fields.filter((field) => field.kind === "checkbox").map((field) => field.label)).toEqual([
    "Which languages are you comfortable with?: Python",
    "Which languages are you comfortable with?: C#",
  ]);
});

test("a SuccessFactors page fills ordinary names, keeps its signature manual and ignores hidden cookie and captcha frames", async () => {
  // Shaped like CNH's SuccessFactors application (issue report, 2026-09-30):
  // a zero-size cookie-manager frame from another site, and an e-signature
  // asking for "First & Last Name".
  await context.route("https://join.cnh.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Cookies</title>" }),
  );
  await context.route("https://www.google.com/recaptcha/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>reCAPTCHA</title>" }),
  );
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Career Opportunities: Apply for Software Engineer Intern (5659)</title><main>
        <iframe height="0" style="visibility:hidden;border:0" id="cookiemanageriframe" src="https://join.cnh.com/widgets/cookiemanageriframe/"></iframe>
        <iframe title="reCAPTCHA" width="304" height="78" src="https://www.google.com/recaptcha/api2/anchor?k=fixture"></iframe>
        <label for="60:_txtFld">* Legal First Name</label><input data-testid="sfTextField" name="firstName" id="60:_txtFld" type="text" aria-required="true">
        <label for="68:_txtFld">* Last Name</label><input data-testid="sfTextField" name="lastName" id="68:_txtFld" type="text" aria-required="true">
        <label for="250:_txtFld">* First &amp; Last Name</label><input data-testid="sfTextField" name="custSign" id="250:_txtFld" type="text" aria-required="true">
      </main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?_s.crb=fixture`);
  await enqueue([page]);
  await expect(page.locator('[name="firstName"]')).toHaveValue(profile.firstName, { timeout: 30000 });
  await expect(page.locator('[name="lastName"]')).toHaveValue(profile.lastName);
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 30000 })
    .toMatch(/ready|awaiting-user/);
  expect((await state()).applications[0].missing.join(" ")).not.toContain("Grant access to embedded site");
  await expect(page.locator('[name="custSign"]')).toHaveValue("");
  await page.locator('[name="custSign"]').fill("Manually signed name");
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
  await expect.poll(async () => (await state()).applications[0].explicitFill, { timeout: 30000 }).toBe(false);
  await expect(page.locator('[name="custSign"]')).toHaveValue("Manually signed name");
});

// L3Harris's SuccessFactors application (report fcabe714, 2026-11-04): its
// sections open folded behind their title bars, the form read as one
// Language field, and nothing was filled.
test("a SuccessFactors application's folded sections are opened and filled", async () => {
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Career Opportunities: Apply for Software Engineering Intern (46504)</title><main>
        <label for="1:_lang">Language</label><select id="1:_lang"><option selected>English US</option></select>
        <div id="147:section" class="rcmFormSection row">
          <h2 class="sectionTitle rcmFormSectionTitle"><button id="147:topBar" class="topBar rcmFormSectionTopBar" aria-expanded="false"><span>Profile Information</span></button></h2>
          <div class="rcmSectionComponent" hidden>
            <label for="60:_txtFld">* First Name</label><input data-testid="sfTextField" name="firstName" id="60:_txtFld" type="text" aria-required="true">
            <label for="68:_txtFld">* Last Name</label><input data-testid="sfTextField" name="lastName" id="68:_txtFld" type="text" aria-required="true">
          </div>
        </div>
      </main><script>
        for (const bar of document.querySelectorAll(".rcmFormSectionTopBar"))
          bar.addEventListener("click", () => {
            const open = bar.getAttribute("aria-expanded") === "true";
            bar.setAttribute("aria-expanded", String(!open));
            // The section's fields are drawn a moment after it opens.
            setTimeout(() => { bar.closest(".rcmFormSection").querySelector(".rcmSectionComponent").hidden = open; }, 200);
          });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?_s.crb=folded`);
  await enqueue([page]);
  await expect(page.locator('[name="firstName"]')).toHaveValue(profile.firstName, { timeout: 30000 });
  await expect(page.locator('[name="lastName"]')).toHaveValue(profile.lastName);
});

test("a race option named by its question, escaped markup and a definition is chosen by its group", async () => {
  // Shaped like a PageUp demographics step (issue report, 2026-10-03): each
  // radio's aria-labelledby lists the question's legend and a hidden copy of
  // the option whose markup is escaped, and each group carries its definition.
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, gender: "Female", ethnicity: "White" } });
  const option = (id: number, name: string, definition: string) =>
    `<label class="radio" for="q7_${id}"><input class="radio" type="radio" name="q7" id="q7_${id}" aria-labelledby="q7_label desc7_${id}">${name}<br> ${definition}</label>
     <span id="desc7_${id}" class="sr-only">${(name + "<br> " + definition).replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/,/g, "\\,")}</span>`;
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Voluntary Demographic Questions</title><main><form>
        <fieldset><legend role="heading" aria-level="2" id="q6_label"><b>Gender</b><span class="asterisk">*</span></legend>
          <label class="radio" for="q6_1"><input class="radio" type="radio" name="q6" id="q6_1" aria-labelledby="q6_label desc6_1">Male</label><span id="desc6_1" class="sr-only">Male</span>
          <label class="radio" for="q6_2"><input class="radio" type="radio" name="q6" id="q6_2" aria-labelledby="q6_label desc6_2">Female</label><span id="desc6_2" class="sr-only">Female</span>
        </fieldset>
        <fieldset><legend role="heading" aria-level="2" id="q7_label"><b>Race/Ethnicity Category*</b> <br>Please select the option that describes the race/ethnicity category with which you <b>primarily</b> identify.<span class="asterisk">*</span></legend>
          ${option(1, "<b>Hispanic or Latino</b>", "A person of Cuban, Mexican, Puerto Rican, South or Central American, or other Spanish culture or origin, regardless of race.")}
          ${option(2, "<b>White (<u>Not</u> Hispanic or Latino)</b>", "A person having origins in any of the original peoples of Europe, the Middle East, or North Africa.")}
          ${option(3, "<b>American Indian or Alaska Native (<u>Not</u> Hispanic or Latino)</b>", "A person having origins in any of the original peoples of North and South America (including Central America), and who maintains tribal affiliation or community attachment.")}
          ${option(4, "<b>Asian (<u>Not</u> Hispanic or Latino)</b>", "A person having origins in any of the original peoples of the Far East, Southeast Asia, or the Indian Subcontinent, including, for example, China, India, Japan, Korea and Vietnam.")}
          ${option(5, "<b>Two or More Races (<u>Not</u> Hispanic or Latino)</b>", "All persons who identify with more than one of the above races, excluding those who identify themselves as Hispanic or Latino.")}
          <label class="radio" for="q7_6"><input class="radio" type="radio" name="q7" id="q7_6" aria-labelledby="q7_label desc7_6"><b>Not Disclosed</b></label><span id="desc7_6" class="sr-only">&lt;b&gt;Not Disclosed&lt;/b&gt;</span>
        </fieldset>
      </form></main><style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/apply/demographics`);
  await enqueue([page]);
  await expect(page.locator("#q7_2")).toBeChecked({ timeout: 30000 });
  await expect(page.locator("#q6_2")).toBeChecked();
  await expect(page.locator('input[name="q7"]:checked')).toHaveCount(1);
});

test("a veteran question that only says \"protected veterans\" is answered from the profile", async () => {
  // Shaped like a PageUp VEVRAA step (issue report, 2026-10-03): the legend
  // never says "veteran status", and the decline has a Unicode hyphen.
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, veteranStatus: "Decline" } });
  const option = (id: number, name: string) =>
    `<label class="radio" for="q9_${id}"><input class="radio" type="radio" name="q9" id="q9_${id}" aria-labelledby="q9_label desc9_${id}">${name}</label>
     <span id="desc9_${id}" class="sr-only">${name}</span>`;
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Voluntary Self-Identification of Protected Veteran Status</title><main><form>
        <fieldset><legend role="heading" aria-level="2" id="q9_label">If you believe you belong to any of the categories of protected veterans listed above, please indicate by checking the appropriate box below. As a Government contractor subject to VEVRAA, we request this information in order to measure the effectiveness of our outreach.<span class="asterisk">*</span></legend>
          ${option(1, "I identify as one or more of the classifications of protected veteran listed above.")}
          ${option(2, "I am not a protected veteran.")}
          ${option(3, "I choose not to self‐identify.")}
        </fieldset>
      </form></main><style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/apply/veteran`);
  await enqueue([page]);
  await expect(page.locator("#q9_3")).toBeChecked({ timeout: 30000 });
  await expect(page.locator('input[name="q9"]:checked')).toHaveCount(1);
});

test("a disability question that only says \"check one of the boxes below\" is answered from the profile", async () => {
  // Shaped like a PageUp CC-305 step (issue report, 2026-10-03): the legend
  // never says "disability"; only the options do, with escaped markup in
  // their hidden copies.
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, disabilityStatus: "No" } });
  const option = (id: number, name: string) =>
    `<label class="radio" for="q8_${id}"><input class="radio" type="radio" name="q8" id="q8_${id}" aria-labelledby="q8_label desc8_${id}"><b>${name}</b></label>
     <span id="desc8_${id}" class="sr-only">&lt;b&gt;${name.replace(/,/g, "\\,")}&lt;/b&gt;</span>`;
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Voluntary Self-Identification of Disability</title><main><form>
        <p>How do I know if I have a disability? You are considered to have a disability if you have a physical or mental impairment.</p>
        <fieldset><legend role="heading" aria-level="2" id="q8_label">Please check one of the boxes below:<span class="asterisk">*</span></legend>
          ${option(1, "Yes, I have a disability (or previously had a disability)")}
          ${option(2, "No, I don't have a disability")}
          ${option(3, "I don't wish to answer")}
        </fieldset>
      </form></main><style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/apply/disability`);
  await enqueue([page]);
  await expect(page.locator("#q8_2")).toBeChecked({ timeout: 30000 });
  await expect(page.locator('input[name="q8"]:checked')).toHaveCount(1);
});

test("an employer page embedding its Greenhouse form names the form's frame for Fill to ask for", async () => {
  // As ASM's careers page (issue report, 2026-10-02): the form is a shown
  // job-boards.eu.greenhouse.io frame the extension has no access to yet,
  // beside a captcha frame and a hidden one that need none.
  const embedded = "https://job-boards.eu.greenhouse.io";
  await context.route(`${embedded}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Apply</title><label>First Name<input name="first_name"></label>' }),
  );
  await context.route("https://www.recaptcha.net/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>reCAPTCHA</title>" }),
  );
  await context.route("https://consent.example-cmp.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Consent</title>" }),
  );
  await context.route(`${origin}/embedded-greenhouse`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Software Engineering Intern</title><main>
        <label>What are you looking for?<input name="search"></label>
        <iframe id="grnhse_iframe" width="800" height="600" src="${embedded}/embed/job_app?for=asm&token=4830113101"></iframe>
        <iframe width="304" height="78" src="https://www.recaptcha.net/recaptcha/enterprise/anchor?k=fixture"></iframe>
        <iframe height="0" style="visibility:hidden" src="https://consent.example-cmp.test/frame"></iframe>
      </main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/embedded-greenhouse`);
  await expect(page.frameLocator("#grnhse_iframe").locator('[name="first_name"]')).toBeVisible();
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  const scanned = await ui({ type: "SCAN_TAB", tabId });
  // Asked for as the whole site, so its other hosts need no second prompt.
  expect(scanned.frameOrigins).toEqual(["https://*.greenhouse.io/*"]);
  // The current-tab card of the tracked application says why Fill this
  // step will ask.
  await enqueue([page]);
  await page.bringToFront();
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  const card = panel.getByRole("region", { name: "Current browser tab" });
  await expect(card.getByText(/The form is in an embedded frame from greenhouse\.io\./)).toBeVisible({ timeout: 15000 });
  // What the fill could not do is listed on the card itself, not folded
  // away in the Applications list.
  await expect
    .poll(async () => (await state()).applications[0].missing.join(" "), { timeout: 30000 })
    .toContain("Grant access to embedded site: https://job-boards.eu.greenhouse.io");
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  const problems = card.getByLabel("Problems to resolve");
  await expect(problems).toContainText("Grant access to embedded site: https://job-boards.eu.greenhouse.io");
  await expect(card.getByRole("button", { name: "Grant frame access" })).toBeVisible();
  await expect(card.getByText(/Needs attention|Ready to review/)).toBeVisible();
  // And open on the application's own card.
  await expect(panel.getByRole("article").first().getByLabel("Problems to resolve")).toContainText("Grant access to embedded site");
  // Granting it from that card while another tab is in front leaves the
  // current-tab card on the tab in front (an Indeed step shown as the
  // LinkedIn application, 2026-10-10).
  await context.route(`${origin}/elsewhere`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Somewhere else</title><label>Note<input name=note></label>" }),
  );
  const other = await context.newPage();
  await other.goto(`${origin}/elsewhere`);
  await other.bringToFront();
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  await expect(card.getByRole("heading", { name: "Somewhere else" })).toBeVisible();
  await panel.evaluate(() => {
    chrome.permissions.request = (async () => true) as typeof chrome.permissions.request;
  });
  await panel.getByRole("article").first().getByRole("button", { name: "Grant frame access" }).click();
  await expect(panel.getByRole("article").first().getByRole("button", { name: "Grant frame access" })).toBeEnabled();
  await panel.waitForTimeout(1500);
  await expect(card.getByRole("heading", { name: "Somewhere else" })).toBeVisible();
  await other.close();
});

test("an apply page on a host without access asks for it even when a frame inside it is readable", async () => {
  // As Amazon's apply page (issue report df17e712, 2026-10-24): access was
  // given on amazon.jobs, sign-in led to account.amazon.jobs, and only an
  // empty ad frame on the page could be read. Fill said to open the form.
  const applyOrigin = "https://account.example-jobs.test";
  await context.route(`${origin}/ad-frame`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title></title><img alt=''>" }),
  );
  await context.route(`${applyOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Apply to a Job</title><main>
        <label>First name<input id="applicant_first_name"></label>
        <iframe width="300" height="100" src="${origin}/ad-frame"></iframe>
      </main>`,
    }),
  );
  await context.route(`${origin}/posting-with-apply`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Software Engineer Intern</title><main><h1>Software Engineer Intern</h1><a href='#'>Apply now</a></main>" }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/posting-with-apply`);
  await enqueue([page]);
  const id = (await state()).applications[0].id;
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 30000 }).toBe("awaiting-user");
  await page.goto(`${applyOrigin}/applicant/jobs/1/apply`);
  // The panel offers the grant for the page itself: with no fields read,
  // Fill this step is not available to ask for it.
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  expect(await ui({ type: "SCAN_TAB", tabId })).toMatchObject({
    accessible: false,
    permissionOrigin: "https://*.example-jobs.test/*",
  });
  await ui({ type: "FILL_STEP", id });
  await expect
    .poll(async () => (await state()).applications[0].missing.join(" "), { timeout: 30000 })
    .toContain(applyOrigin);
  const app = (await state()).applications[0];
  expect(app.accessOrigins).toContain("https://*.example-jobs.test/*");
});

test("Indeed's apply steps give the application its posting and employer from the page", async () => {
  // As smartapply.indeed.com (issue report, 2026-10-10): the steps are in
  // main, the posting in a collapsed card beside them, and the address names
  // nobody. A tag manager's frame on the page is not a form to ask about.
  const step = "https://smartapply.indeed.com/beta/indeedapply/form/questions-module/questions/1";
  await context.route("https://sgtm.indeed.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><script>var m={}</script>" }),
  );
  await context.route(step, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Answer screener questions from the employer | Indeed.com</title>
      <aside><div class="ia-JobHeader-information">
        <h1 id="ia-JobHeader-title" class="ia-JobHeader-title">Software Engineer</h1>
        <span>Sound Decisions - Herriman, UT</span>
        <button aria-label="See more details"><span>See more details</span></button>
      </div></aside>
      <aside><div class="ia-JobDescription ia-JobDescription--collapsed" style="display:none">Software Engineer — Full-Stack (Front-End Focused)<br>
        We're hiring a Software Engineer to take ownership of the front-end product experience in React and TypeScript.</div></aside>
      <main><h2>Answer these questions from the employer</h2>
        <label>What is your full name? *<input name="q_name" required></label>
        <label>Do you want to tell us anything else about yourself?<textarea name="q_else"></textarea></label>
        <button type="button">Continue</button>
      </main>
      <iframe width="300" height="100" src="https://sgtm.indeed.com/_/service_worker/6a60/sw_iframe.html?origin=x"></iframe>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(step);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  const scanned = await ui({ type: "SCAN_TAB", tabId });
  expect(scanned.observation.description).toContain("ownership of the front-end product experience");
  expect(scanned.observation.company).toBe("Sound Decisions");
  expect(scanned.frameOrigins).toBeUndefined();
  await ui({ type: "TRACK_TAB", tabId });
  const app = (await state()).applications[0];
  expect(app.title).toBe("Software Engineer");
  expect(app.company).toBe("Sound Decisions");
  expect(app.sourceDescription).toContain("React and TypeScript");
  await page.close();
});

test("Breezy's apply page gives the application its posting, title and questions", async () => {
  // As matroid.breezy.hr (report ba965f2e, 2026-10-17): the apply page shows
  // only the job's title, keeps the posting in its data-position, opens with
  // a hidden "Application Submitted" heading, and heads each of the
  // employer's questions with an <h3> and no label.
  const step = `${breezyOrigin}/p/0a1b2c3d4e5f-vision-systems-engineer/apply`;
  const position = JSON.stringify({
    _id: "0a1b2c3d4e5f",
    name: "Vision Systems Engineer",
    description: "<p><strong>About Example Corp</strong></p>\n<p>We build inspection systems that find defects in factory imagery with deep learning.</p>",
  }).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  await context.route(step, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Vision Systems Engineer</title><style>.ng-hide{display:none!important}</style>
      <div ng-controller="PositionApplyViewCtrl" data-position="${position}">
        <div class="confirmation-container ng-hide"><div class="application-confirmed"><h1>Application Submitted</h1><p>Your application has been submitted successfully.</p></div></div>
        <div class="hero"><div class="banner"><h1>Vision Systems Engineer</h1></div></div>
        <form name="form">
          <div class="section"><h3><span>Full Name</span><span class="required">*</span></h3><input name="cName" type="text" placeholder="Full Name"></div>
          <div class="questionnaire-section"><div class="section questions"><ul>
            <li class="question"><div><h3><span>What is the hardest vision problem you have solved?</span><span title="Required" class="required">*</span></h3>
              <div class="question-body"><p>Tell us about it.</p></div>
              <input name="section_1_question_0" type="text" required></div></li>
            <li class="question"><div class="multiplechoice"><h3><span>Can you work on site in Springfield?</span><span title="Required" class="required">*</span></h3>
              <ul class="options">
                <li class="option"><label><input type="radio" name="section_1_question_1" value="Yes"><span>Yes</span></label></li>
                <li class="option"><label><input type="radio" name="section_1_question_1" value="No"><span>No</span></label></li>
              </ul></div></li>
          </ul></div></div>
          <button type="submit">Submit Application</button>
        </form>
      </div>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(step);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  const scanned = await ui({ type: "SCAN_TAB", tabId });
  expect(scanned.observation.title).toBe("Vision Systems Engineer");
  expect(scanned.observation.description).toContain("find defects in factory imagery with deep learning");
  const labels = scanned.observation.fields.map((field: { label: string }) => field.label);
  expect(labels).toContain("What is the hardest vision problem you have solved?");
  expect(labels).toContain("Can you work on site in Springfield?");
  expect(labels.join(" ")).not.toContain("section_1_question");
  await page.close();
});

test("LinkedIn and Indeed are read and drafted for, and never written to", async () => {
  // Both forbid tools that automate activity on them (decided 2026-10-10):
  // no fill of any kind reaches their pages, whatever asks for it.
  const step = "https://smartapply.indeed.com/beta/indeedapply/form/questions-module/questions/7";
  await context.route(step, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Answer screener questions from the employer | Indeed.com</title>
      <main><h1>Software Engineer</h1>
        <label>First name *<input name="firstName" required></label>
        <label>Email *<input name="email" type="email" required></label>
        <label>Which best describes your recent Python experience? *<select name="python" required>
          <option value="">Select an option</option><option>Building backend applications or REST APIs.</option><option>Scripting only.</option></select></label>
        <label>Describe a project you are proud of. *<textarea name="project" required></textarea></label>
        <button type="button">Continue</button>
      </main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(step);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  expect((await ui({ type: "SCAN_TAB", tabId })).draftOnly).toBe(true);
  await ui({ type: "TRACK_TAB", tabId });
  const id = (await state()).applications[0].id;
  await expect(ui({ type: "FILL_STEP", id, tabId })).rejects.toThrow(/does not allow tools to fill its forms/);
  await expect(ui({ type: "RESUME_APP", id })).rejects.toThrow(/does not allow tools to fill its forms/);
  await page.waitForTimeout(1500);
  const app = (await state()).applications[0];
  expect(app.attempts).toEqual([]);
  expect(app.explicitFill).toBe(false);
  await expect(page.locator("[name=firstName]")).toHaveValue("");
  await expect(page.locator("[name=email]")).toHaveValue("");
  // The open fields are offered for suggestions without a fill behind them.
  const open = await ui({ type: "UNRESOLVED_FIELDS", id, tabId });
  expect(open.available).toBe(true);
  expect(open.problems.map((problem: { label: string }) => problem.label)).toContain("Which best describes your recent Python experience?");
  // The card says so and offers no fill.
  await page.bringToFront();
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  const card = panel.getByRole("region", { name: "Current browser tab" });
  await expect(card.getByText(/does not allow tools to fill its forms/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Fill this step" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Draft documents" })).toBeVisible();
  await page.close();
});

test("Lever's self-identification date is filled with today's date", async () => {
  // As Shield AI's form (issue report, 2026-10-11): the date beside the
  // disability form's name was left alone as a signature. It is a date.
  const form = "https://jobs.lever.co/datedco/59e0cf9b-04d7-43c0-8a65-9d411fe56c68/apply";
  await context.route(form, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Dated Co - Engineer</title><form class="application-form">
        <label>Full name<input name="name" required></label>
        <label>Email<input name="email" type="email" required></label>
        <h4>Voluntary Self-Identification of Disability</h4>
        <label>Name<input name="eeo[disabilitySignature]" required></label>
        <label>Date<input name="eeo[disabilitySignatureDate]" placeholder="MM/DD/YYYY" required></label>
      </form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(form);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "TRACK_TAB", tabId });
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id, tabId });
  const today = new Date();
  await expect(page.locator('[name="eeo[disabilitySignatureDate]"]')).toHaveValue(
    `${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}/${today.getFullYear()}`,
    { timeout: 25000 },
  );
  await page.close();
});

test("an Apply with LinkedIn widget does not stop the fill of the form around it", async () => {
  // As Shield AI's Lever form (issue report, 2026-10-10): the widget is a
  // linkedin.com frame the extension can read. It is never a fill target,
  // and being draft-only must not fail the fill of the Lever page.
  const form = "https://jobs.lever.co/widgetco/59e0cf9b-04d7-43c0-8a65-9d411fe56c68/apply";
  await context.route("https://www.linkedin.com/talentwidgets/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><button>Apply with LinkedIn</button>" }),
  );
  await context.route(form, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Widget Co - Engineer</title><form class="application-form">
        <iframe width="300" height="60" src="https://www.linkedin.com/talentwidgets/apply-with-linkedin"></iframe>
        <label>Full name<input name="name" required></label>
        <label>Email<input name="email" type="email" required></label>
      </form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(form);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  const scanned = await ui({ type: "SCAN_TAB", tabId });
  expect(scanned.draftOnly).toBeUndefined();
  await ui({ type: "TRACK_TAB", tabId });
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id, tabId });
  await expect(page.locator("[name=email]")).toHaveValue(profile.email, { timeout: 25000 });
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 25000 })
    .toMatch(/awaiting-user|ready/);
  expect((await state()).applications[0].missing.join(" ")).not.toMatch(/does not allow tools/);
  await page.close();
});

test("a modal apply box is the whole form, and LinkedIn's radio questions are read by name", async () => {
  // As LinkedIn's Easy Apply (issue reports, 2026-10-10): a <dialog> over the
  // job page, whose search filters were listed as questions; every radio of
  // a group carries the question as its aria-label and an empty label, with
  // the option's text drawn beside it.
  await context.route(`${origin}/easy-apply`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Associate Engineer | Precisely | LinkedIn</title>
      <main><label>Describe the job you want<input name="search"></label>
        <label><input type="checkbox" name="f1">Filter by Easy Apply</label></main>
      <dialog data-testid="dialog" aria-labelledby="dialog-header"><h2 id="dialog-header">Apply to Precisely</h2>
        <p>LinkedIn Profile*</p><div><input required aria-label="LinkedIn Profile" type="text"></div>
        <div><p>Are you 18 years or older?*</p><fieldset role="radiogroup"><div>
          <div><div><input id="r1" aria-label="Are you 18 years or older?" type="radio" name="radio-group-_r_d4_"><label for="r1"></label></div><div><p>Yes</p></div></div>
          <div><div><input id="r2" aria-label="Are you 18 years or older?" type="radio" name="radio-group-_r_d4_"><label for="r2"></label></div><div><p>No</p></div></div>
        </div></fieldset></div>
      </dialog><script>document.querySelector("dialog").showModal()</script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/easy-apply`);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  const scanned = await ui({ type: "SCAN_TAB", tabId });
  const fields = scanned.observation.fields as { label: string; kind: string; options: string[] }[];
  expect(fields.map((field) => field.label)).toEqual(["LinkedIn Profile", "Are you 18 years or older?"]);
  expect(fields[1]).toMatchObject({ kind: "radio", options: ["Yes", "No"] });
  // Closed, the page behind is the form again.
  await page.evaluate(() => document.querySelector("dialog")!.close());
  const behind = await ui({ type: "SCAN_TAB", tabId });
  expect((behind.observation.fields as { label: string }[]).map((field) => field.label)).toEqual([
    "Describe the job you want",
    "Filter by Easy Apply",
  ]);
  await page.close();
});

test("a cookie notice that calls itself a modal dialog does not hide the form behind it", async () => {
  // As Pinpoint's application page (nightly eval, 2026-10-11): a notice in
  // the corner and its preferences box, kept in the page invisible, both
  // role=dialog aria-modal=true. Nothing behind them was read.
  await context.route(`${origin}/cookie-modal`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>New Application | Intern | Example Careers</title>
      <form><label>First Name<input name="first" required></label><label>Email Address<input name="email" type="email" required></label></form>
      <div role="dialog" aria-modal="true" style="position:fixed;bottom:0;right:0"><h2>Cookies</h2>
        <p>We use cookies to ensure you get the best experience.</p>
        <label><input type="checkbox" name="analytics">Analytics</label><button type="button">Accept all</button></div>
      <div role="dialog" aria-modal="true" style="position:fixed;top:20%;left:20%;visibility:hidden;opacity:0"><h2>Preferences</h2>
        <label>Your reference<input name="hidden-required" required></label></div>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/cookie-modal`);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  const scanned = await ui({ type: "SCAN_TAB", tabId });
  expect((scanned.observation.fields as { label: string }[]).map((field) => field.label)).toEqual(
    expect.arrayContaining(["First Name", "Email Address"]),
  );
  await page.close();
});

test("documents can be drafted and saved as files without anything being written to the page", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/ui-flow`);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "TRACK_TAB", tabId });
  const id = (await state()).applications[0].id;
  await ui({ type: "DRAFT_DOCUMENTS", id });
  await expect
    .poll(async () => (await state()).applications[0].artifacts.map((artifact: { kind: string }) => artifact.kind), { timeout: 30000 })
    .toEqual(expect.arrayContaining(["resume", "cover"]));
  const app = (await state()).applications[0];
  expect(app.draftJobId).toBeUndefined();
  expect(app.status).toBe("awaiting-user");
  expect(app.filled || 0).toBe(0);
  await expect(page.locator("[name=firstName]")).toHaveValue("");
  const saved = await ui({ type: "API", path: `/v1/jobs/${app.documentJobId}/files` });
  expect(saved.files.length).toBe(app.artifacts.length);
  for (const file of saved.files) expect((await stat(file.path)).isFile()).toBe(true);
  // The card offers them for the applicant's own upload.
  await page.bringToFront();
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  const card = panel.getByRole("region", { name: "Current browser tab" });
  await expect(card.getByRole("button", { name: "Redraft documents" })).toBeVisible();
  await expect(card.getByRole("group", { name: "Files to upload yourself" })).toBeVisible();
  await page.close();
});

inEitherTab("Greenhouse's job-board uploads stay attached when the site swaps the input for the file's name", async (tab) => {
  // As ASM's embedded job-boards.eu form (issue report, 2026-10-02): once a
  // file is chosen the site drops the input and shows the file's name with a
  // Remove file button. The upload must count as done, and nothing may
  // click Remove file to upload again.
  await context.route("https://boards.greenhouse.io/asmfixture/jobs/1", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Software Engineering Intern</title>
      <form id="application-form" class="application--form" method="get" action="https://boards.greenhouse.io/asmfixture/jobs/1">
        <div class="field-wrapper"><label for="first_name">First Name<span class="required">*</span></label><input id="first_name" type="text" aria-required="true"></div>
        ${["resume", "cover_letter"]
          .map(
            (id) => `<div class="field-wrapper"><div role="group" aria-labelledby="upload-label-${id}" class="file-upload" data-allow-s3="false">
              <div id="upload-label-${id}" class="label upload-label">${id === "resume" ? "Resume/CV" : "Cover Letter"}</div>
              <div class="file-upload__wrapper"><div class="button-container"><button type="button" class="btn">Attach</button>
              <label class="visually-hidden" for="${id}">Attach</label><input id="${id}" class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf"></div></div></div></div>`,
          )
          .join("")}
      </form>
      <script>
        window.chosen = []; window.removed = 0;
        const wire = (id) => document.getElementById(id).addEventListener('change', (event) => {
          const name = event.target.files[0]?.name;
          if (!name) return;
          window.chosen.push(id + ':' + name);
          // The site keeps the file itself and empties the input.
          event.target.value = '';
          const wrapper = document.querySelector('[aria-labelledby="upload-label-' + id + '"] .file-upload__wrapper');
          const before = wrapper.innerHTML;
          wrapper.innerHTML = '<div class="file-upload__filename">' + name + '</div><button type="button" aria-label="Remove file">x</button>';
          wrapper.querySelector('button').addEventListener('click', () => { window.removed++; wrapper.innerHTML = before; wire(id); });
        });
        wire('resume'); wire('cover_letter');
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto("https://boards.greenhouse.io/asmfixture/jobs/1");
  await place(page, tab);
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0]?.status, { timeout: 60000 })
    .toMatch(/ready|awaiting-user/);
  await expect(page.locator('[aria-labelledby="upload-label-resume"] .file-upload__filename')).toHaveText(/\.pdf$/);
  await expect(page.locator('[aria-labelledby="upload-label-cover_letter"] .file-upload__filename')).toHaveText(/\.pdf$/);
  const chosen: string[] = await page.evaluate(() => (window as any).chosen);
  expect(chosen.map((entry) => entry.split(":")[0]).sort()).toEqual(["cover_letter", "resume"]);
  expect(await page.evaluate(() => (window as any).removed)).toBe(0);
  const missing = (await state()).applications[0].missing.join(" ");
  expect(missing).not.toMatch(/Verify upload|upload did not finish|cleared the value|did not retain/);
  // A second fill finds the names on the page and leaves the uploads alone.
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!, page.url());
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id, tabId });
  await expect
    .poll(async () => (await state()).applications[0]?.status, { timeout: 60000 })
    .toMatch(/ready|awaiting-user/);
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as any).removed)).toBe(0);
});

test("a file an earlier application left on a Greenhouse job board is replaced", async () => {
  await context.route("https://boards.greenhouse.io/asmfixture/jobs/2", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Software Engineering Intern</title>
      <form id="application-form" class="application--form" method="get" action="https://boards.greenhouse.io/asmfixture/jobs/2">
        <div class="field-wrapper"><label for="first_name">First Name<span class="required">*</span></label><input id="first_name" type="text" aria-required="true"></div>
        <div class="field-wrapper"><div role="group" aria-labelledby="upload-label-resume" class="file-upload" data-allow-s3="false">
          <div id="upload-label-resume" class="label upload-label">Resume/CV</div>
          <div class="file-upload__wrapper"></div></div></div>
      </form>
      <script>
        window.chosen = []; window.removed = [];
        const wrapper = document.querySelector('.file-upload__wrapper');
        const empty = '<div class="button-container"><button type="button" class="btn">Attach</button><label class="visually-hidden" for="resume">Attach</label><input id="resume" class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf"></div>';
        const chip = (name) => {
          wrapper.innerHTML = '<div class="file-upload__filename">' + name + '</div><button type="button" aria-label="Remove file">x</button>';
          wrapper.querySelector('button').addEventListener('click', () => {
            window.removed.push(name);
            wrapper.innerHTML = empty;
            document.getElementById('resume').addEventListener('change', (event) => {
              const file = event.target.files[0]?.name;
              if (!file) return;
              window.chosen.push(file);
              event.target.value = '';
              chip(file);
            });
          });
        };
        // Attached by an earlier application.
        chip('Old_Software_Engineer_Resume.pdf');
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto("https://boards.greenhouse.io/asmfixture/jobs/2");
  await enqueue([page]);
  await expect.poll(() => page.evaluate(() => (window as any).chosen.length), { timeout: 60000 }).toBe(1);
  expect(await page.evaluate(() => (window as any).removed)).toEqual(["Old_Software_Engineer_Resume.pdf"]);
  await expect(page.locator(".file-upload__filename")).not.toHaveText("Old_Software_Engineer_Resume.pdf");
  await expect
    .poll(async () => (await state()).applications[0]?.status, { timeout: 60000 })
    .toMatch(/ready|awaiting-user/);
  // A second fill leaves this application's file in place.
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!, page.url());
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id, tabId });
  await expect
    .poll(async () => (await state()).applications[0]?.status, { timeout: 60000 })
    .toMatch(/ready|awaiting-user/);
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as any).removed)).toHaveLength(1);
});

test("ADP expands employer panels and fills each employment history entry", async () => {
  // ADP employment form, report f165df17-aed9-4a3d-ab20-985264bd7e7e.
  // The captured sdf-expandable-box hides its slotted controls until the
  // shadow button is clicked; dates have two nested shadow roots.
  test.setTimeout(90000);
  const work = [
    { organization: "Example Labs", title: "Engineer", location: "Tucson", details: "Built services.", startDate: "2025-05", endDate: "" },
    { organization: "Sample Systems", title: "Developer", location: "Phoenix", details: "Tested applications.", startDate: "2023-02", endDate: "2025-04" },
    { organization: "Demo Company", title: "Intern", location: "Mesa", details: "Maintained tools.", startDate: "2022-06", endDate: "2022-08" },
  ];
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, work } });
  await context.route(`${adpOrigin}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><title>Employment History</title><cx-root><form>
      <h1>Employment History</h1><div id="employers"></div>
      <div class="add-button-container"><sdf-button role="button" aria-label=" Add employer ">Add employer</sdf-button></div>
      <sdf-expandable-box id="unrelated"><div slot="header">Other information</div><label>Notes<input></label></sdf-expandable-box>
      <button type="submit">Submit application</button>
    </form></cx-root><script>
      window.submissions = 0;
      document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.submissions++; });
      customElements.define('sdf-expandable-box', class extends HTMLElement {
        connectedCallback() {
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = '<style>:host{display:block}#content[aria-hidden="true"]{display:none}</style><div id="header"><slot name="header"></slot><button aria-controls="content" aria-expanded="false">Show content</button></div><div id="content" aria-hidden="true"><slot></slot></div>';
          root.querySelector('button').addEventListener('click', () => {
            const opened = root.querySelector('button').getAttribute('aria-expanded') !== 'true';
            root.querySelector('button').setAttribute('aria-expanded', String(opened));
            root.querySelector('#content').setAttribute('aria-hidden', String(!opened));
            this.dispatchEvent(new CustomEvent(opened ? 'sdfOpen' : 'sdfClose'));
          });
        }
      });
      customElements.define('sdf-input', class extends HTMLElement {
        connectedCallback() {
          const group = this.closest('adp-form-group') || this.getRootNode().host.closest('adp-form-group');
          const label = group.querySelector('label').textContent;
          this.attachShadow({ mode: 'open' }).innerHTML = '<label for="input">' + label + '</label><input id="input" name="' + label + '" placeholder="' + (label.includes('Date') ? 'MM/DD/YYYY' : '') + '">';
        }
      });
      customElements.define('sdf-textarea', class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<label for="input">Job Duties</label><textarea id="input"></textarea>'; }
      });
      customElements.define('sdf-date-picker', class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<sdf-input></sdf-input>'; }
      });
      customElements.define('sdf-select-simple', class extends HTMLElement {
        connectedCallback() {
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = '<div class="trigger-button" role="button" aria-expanded="false"><span id="selected-label"></span><span id="select-placeholder">Select...</span></div><div id="options" hidden><input role="combobox" aria-label="Enter text to filter your options"><sdf-select-item role="option" value="00001000">Current Employer</sdf-select-item><sdf-select-item role="option" value="00002000">Previous Employer</sdf-select-item></div>';
          root.querySelector('.trigger-button').addEventListener('click', () => {
            root.querySelector('.trigger-button').setAttribute('aria-expanded', 'true');
            root.querySelector('#options').hidden = false;
          });
          for (const item of root.querySelectorAll('[role="option"]')) item.addEventListener('click', () => {
            root.querySelector('#selected-label').textContent = item.textContent;
            root.querySelector('#select-placeholder').hidden = true;
            root.querySelector('.trigger-button').setAttribute('aria-expanded', 'false');
            root.querySelector('#options').hidden = true;
            root.querySelector('input').value = '';
            this.dataset.value = item.getAttribute('value');
            this.dispatchEvent(new CustomEvent('sdfChange', { bubbles: true, detail: { value: this.dataset.value, label: item.textContent } }));
          });
        }
      });
      function addEmployer() {
        const box = document.createElement('sdf-expandable-box');
        const number = document.querySelectorAll('#employers > sdf-expandable-box').length + 1;
        box.innerHTML = '<div slot="header">Employer ' + number + '</div><div>'
          + ['Type', 'Employer', 'City', 'Start Date', 'End Date', 'Position/Title', 'May We Contact?', 'Job Duties'].map((label, index) => {
            const tag = label === 'Type' || label === 'May We Contact?' ? 'sdf-select-simple' : label.includes('Date') ? 'sdf-date-picker' : label === 'Job Duties' ? 'sdf-textarea' : 'sdf-input';
            return '<div class="form-field"><adp-form-group data-name="synthetic-' + index + '_' + number + '"><label class="form-control-label" data-adp-field-label="' + label + '">' + label + '</label><' + tag + '></' + tag + '></adp-form-group></div>';
          }).join('') + '</div>';
        document.getElementById('employers').append(box);
      }
      addEmployer(); addEmployer();
      document.querySelector('.add-button-container sdf-button').addEventListener('click', addEmployer);
    </script>`,
  }));
  const page = await context.newPage();
  await page.goto(`${adpOrigin}/fixture/cx/app?workflowComponent=appbuilder_eform`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toMatch(/ready|awaiting-user/);
  const boxes = page.locator('#employers > sdf-expandable-box');
  await expect(boxes).toHaveCount(3);
  for (const [index, row] of work.entries()) {
    const box = boxes.nth(index);
    await expect(box.locator('button[aria-controls="content"]')).toHaveAttribute('aria-expanded', 'true');
    for (const [label, value] of [
      ['Employer', row.organization], ['City', row.location], ['Position/Title', row.title], ['Job Duties', row.details],
      ['Start Date', row.startDate.slice(5) + '/01/' + row.startDate.slice(0, 4)],
      ['End Date', row.endDate ? row.endDate.slice(5) + '/01/' + row.endDate.slice(0, 4) : ''],
    ]) await expect(box.locator('adp-form-group').filter({ has: page.locator('label[data-adp-field-label="' + label + '"]') }).locator('input:not([role]),textarea')).toHaveValue(value);
    await expect(box.locator('adp-form-group').filter({ has: page.locator('[data-adp-field-label="Type"]') }).locator('sdf-select-simple')).toHaveAttribute('data-value', row.endDate ? '00002000' : '00001000');
    await expect(box.locator('adp-form-group').filter({ has: page.locator('[data-adp-field-label="May We Contact?"]') }).locator('sdf-select-simple')).not.toHaveAttribute('data-value');
  }
  await expect(page.locator('#unrelated button')).toHaveAttribute('aria-expanded', 'false');
  const title = boxes.nth(1).locator('adp-form-group').filter({ has: page.locator('[data-adp-field-label="Position/Title"]') }).locator('input');
  await title.fill('My edited title');
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toMatch(/ready|awaiting-user/);
  await expect(title).toHaveValue('My edited title');
  await expect(boxes).toHaveCount(3);
  await expect(boxes.locator('button[aria-controls="content"][aria-expanded="true"]')).toHaveCount(3);
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

test("ADP leaves selected employer types alone on repeated fills", async () => {
  // ADP employment form, report 99f73927-60dc-4d78-9204-7e3adf66f430.
  test.setTimeout(90000);
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: {
    ...profile, work: [
      { organization: "Example Labs", title: "Engineer", startDate: "2025-05", endDate: "" },
      { organization: "Sample Systems", title: "Developer", startDate: "2023-02", endDate: "2025-04" },
    ],
  } });
  await context.route(`${adpOrigin}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><title>Employment History</title><cx-root><form>
      <h1>Employment History</h1>
      ${["Example Labs", "Sample Systems"].map((company, index) => `<sdf-expandable-box>
        <div slot="header">Employer ${index + 1}</div>
        <adp-form-group><label data-adp-field-label="Type">Type</label><sdf-select-simple></sdf-select-simple></adp-form-group>
        <adp-form-group><label data-adp-field-label="Employer">Employer</label><sdf-input data-company="${company}"></sdf-input></adp-form-group>
      </sdf-expandable-box>`).join("")}
      <button type="submit">Submit application</button>
    </form></cx-root><script>
      window.picks = [0, 0]; window.opens = [0, 0]; window.submissions = 0;
      document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.submissions++; });
      customElements.define('sdf-input', class extends HTMLElement {
        connectedCallback() {
          this.attachShadow({ mode: 'open' }).innerHTML = '<input name="Employer" value="' + this.dataset.company + '">';
        }
      });
      customElements.define('sdf-select-simple', class extends HTMLElement {
        connectedCallback() {
          const index = [...document.querySelectorAll('sdf-select-simple')].indexOf(this);
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = '<div class="trigger-button" role="button" aria-expanded="false"><span id="selected-label"></span></div><div id="options" hidden><sdf-select-item role="option" value="00001000" aria-selected="false">Current</sdf-select-item><sdf-select-item role="option" value="00002000" aria-selected="false">Previous</sdf-select-item></div>';
          if (index === 1) {
            root.querySelector('[value="00001000"]').setAttribute('aria-selected', 'true');
            root.querySelector('#selected-label').textContent = 'Current';
          }
          root.querySelector('.trigger-button').addEventListener('click', () => {
            window.opens[index]++;
            root.querySelector('.trigger-button').setAttribute('aria-expanded', 'true');
            root.querySelector('#options').hidden = false;
          });
          for (const item of root.querySelectorAll('[role="option"]')) item.addEventListener('click', () => {
            window.picks[index]++;
            for (const option of root.querySelectorAll('[role="option"]')) option.setAttribute('aria-selected', String(option === item));
            root.querySelector('#selected-label').textContent = item.textContent;
            root.querySelector('.trigger-button').setAttribute('aria-expanded', 'false');
            root.querySelector('#options').hidden = true;
            this.dispatchEvent(new CustomEvent('sdfChange', { bubbles: true, detail: { value: item.getAttribute('value'), label: item.textContent } }));
          });
        }
      });
    </script>`,
  }));
  const page = await context.newPage();
  await page.goto(`${adpOrigin}/fixture/cx/app?workflowComponent=appbuilder_eform`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toMatch(/ready|awaiting-user/);
  await expect(page.locator('sdf-select-simple #selected-label')).toHaveText(["Current", "Previous"]);
  expect(await page.evaluate(() => (window as any).picks)).toEqual([1, 1]);
  expect(await page.evaluate(() => (window as any).opens)).toEqual([1, 1]);
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toMatch(/ready|awaiting-user/);
  expect(await page.evaluate(() => (window as any).picks)).toEqual([1, 1]);
  expect(await page.evaluate(() => (window as any).opens)).toEqual([1, 1]);
  await expect(page.locator('sdf-select-simple .trigger-button[aria-expanded="false"]')).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

test("ADP document dialogs detect each slot and save the resume and transcript", async () => {
  // ADP documents step, report 348c3d98-978a-4b4f-97e6-62941f5af8c7.
  // The captured component creates a shadow uploader on click and saves
  // only on sdfAccept; an internship essay does not identify a cover letter.
  test.setTimeout(90000);
  appConfig.transcriptsDir = await scratch("lane-transcripts-");
  await context.route(`${adpOrigin}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><title>Documents</title><cx-root><form>
      ${[["resume", "Resume", true], ["additionalDocURL", "Unofficial Transcript", true], ["$$additionalDoc2", "Additional Document 2 - Internship Essay", false]].map(([id, label, required]) =>
        '<adp-form-group data-name="' + id + '"><label class="form-control-label">' + label + (required ? '<span class="required">*</span>' : '') + '</label>'
        + '<dynamic-form-sdf-upload><div class="file-uploader"><div class="flex justify-between"><div class="filename"></div><div>'
        + '<sdf-button role="button" aria-label="Open ' + label + ', external link" disabled>Open</sdf-button>'
        + '<sdf-button role="button" aria-label="upload ' + label + '" icon="action-upload">Upload</sdf-button></div></div></div></dynamic-form-sdf-upload></adp-form-group>'
      ).join('')}
    </form></cx-root><script>
      customElements.define('sdf-button', class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<div class="button"><slot></slot></div>'; }
      });
      customElements.define('sdf-file-uploader', class extends HTMLElement {
        connectedCallback() {
          this.attachShadow({ mode: 'open' }).innerHTML = '<input type="file" accept=".pdf,.docx" style="display:none"><button type="button">Select a file</button>';
          this.shadowRoot.querySelector('input').addEventListener('change', event => this.dispatchEvent(new CustomEvent('sdfChange', { detail: [...event.target.files], bubbles: true })));
        }
      });
      window.saved = [];
      for (const component of document.querySelectorAll('dynamic-form-sdf-upload')) {
        const upload = component.querySelector('[icon="action-upload"]');
        upload.addEventListener('click', () => {
          const pane = document.createElement('sdf-focus-pane');
          pane.setAttribute('accept-label', 'Save');
          pane.innerHTML = '<sdf-file-uploader></sdf-file-uploader>';
          pane.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot><sdf-button id="accept-button" role="button">Save</sdf-button>';
          let file;
          pane.addEventListener('sdfChange', event => { file = event.detail[0]; });
          pane.shadowRoot.querySelector('sdf-button').addEventListener('click', () => pane.dispatchEvent(new CustomEvent('sdfAccept')));
          pane.addEventListener('sdfAccept', () => {
            if (!file) return;
            window.saved.push({ slot: component.closest('adp-form-group').dataset.name, name: file.name });
            component.querySelector('.filename').innerHTML = '<p class="text-sm">' + file.name + '</p>';
            component.querySelector('[disabled]').removeAttribute('disabled');
            pane.remove();
          });
          component.append(pane);
        });
      }
    </script>`,
  }));
  let page = await context.newPage();
  await page.goto(`${adpOrigin}/fixture/cx/app?workflowComponent=documents`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications.find((app) => app.url === page.url())?.status, { timeout: 30000 }).toMatch(/ready|awaiting-user/);
  expect((await state()).applications[0].missing.join(" ")).toContain("No transcript to upload");
  expect((await state()).applications[0].missing.join(" ")).toContain("Choose a file manually: Additional Document 2 - Internship Essay");
  await expect.poll(() => page.evaluate(() => (window as any).saved)).toEqual([
    { slot: "resume", name: "Rivera-resume-Documents.pdf" },
  ]);
  await writeFile(join(appConfig.transcriptsDir, "Unofficial_Transcript.pdf"), "%PDF-1.4\n% synthetic transcript\n");
  page = await context.newPage();
  await page.goto(`${adpOrigin}/fixture-second/cx/app?workflowComponent=documents`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications.find((app) => app.url === page.url())?.status, { timeout: 30000 }).toMatch(/ready|awaiting-user/);
  await expect.poll(() => page.evaluate(() => (window as any).saved)).toEqual([
    { slot: "resume", name: "Rivera-resume-Documents.pdf" },
    { slot: "additionalDocURL", name: "Unofficial_Transcript.pdf" },
  ]);
  await expect(page.locator('sdf-focus-pane')).toHaveCount(0);
  expect((await state()).applications.find((app) => app.url === page.url())!.missing.join(" ")).not.toMatch(/Verify upload|No transcript to upload/);
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  const fields = (await ui({ type: "SCAN_TAB", tabId })).observation.fields;
  expect(fields.filter((field: { kind: string }) => field.kind === "file")).toHaveLength(3);
  expect(fields.find((field: { documentKind?: string }) => field.documentKind === "transcript")).toMatchObject({ required: true, value: "Unofficial_Transcript.pdf" });
});

test("ADP demographic radios expose their questions and retain clicked answers", async () => {
  // ADP EEOC form, report c109ddd6-8937-4459-a179-00a750b590e3.
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: {
    ...profile, hispanic: "No", ethnicity: "East Asian", gender: "Female", veteranStatus: "No",
  } });
  const questions = [
    ["eeoRace", "Are you Hispanic or Latino?", ["Yes", "No", "Decline to identify"]],
    ["eeoEthnicity", "Ethnicity", ["White", "Asian", "Decline to identify"]],
    ["eeoGender", "Gender", ["Male", "Female", "Other", "Decline to identify"]],
    ["eeoVeteran", "Veteran Status", ["I am a protected veteran", "I am not a protected veteran", "Decline to identify"]],
  ] as const;
  await context.route(`${adpOrigin}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><title>Equal Employment Opportunity Information</title><cx-root><form>
      ${questions.map(([key, label, options]) => `<adp-form-group data-name="${key}">
        <label class="form-control-label">${label}<span class="required">*</span></label>
        <dynamic-form-radio-group><sdf-radio-group>
          <span id="${key}-label">${key === "eeoRace" ? "A description of Hispanic or Latino origin." : ""}</span>
          <div role="radiogroup" aria-labelledby="${key}-label">
            ${options.map((option, index) => `<div><sdf-radio-button role="radio" aria-checked="false" tabindex="${index === 0 ? 0 : -1}" value="code-${index}" data-label="${option}"></sdf-radio-button></div>`).join("")}
            <sdf-radio-button role="radio" aria-checked="false" hidden data-label="Hidden choice"></sdf-radio-button>
          </div>
        </sdf-radio-group></dynamic-form-radio-group>
      </adp-form-group>`).join("")}
    </form></cx-root><script>
      customElements.define('sdf-radio-button', class extends HTMLElement {
        connectedCallback() {
          this.attachShadow({ mode: 'open' }).innerHTML = '<label id="label" for="toggle">' + this.dataset.label + '<slot></slot></label><span class="description">Option description<slot name="description"></slot></span>';
          this.addEventListener('click', () => {
            const group = this.closest('[role="radiogroup"]');
            setTimeout(() => {
              for (const option of group.querySelectorAll('[role="radio"]')) option.setAttribute('aria-checked', String(option === this));
              this.dispatchEvent(new CustomEvent('sdfChange', { bubbles: true, composed: true, detail: { value: this.getAttribute('value'), checked: true, label: this.dataset.label } }));
            });
          });
        }
      });
    </script>`,
  }));
  const page = await context.newPage();
  await page.goto(`${adpOrigin}/fixture/cx/app?workflowComponent=eeoc`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toMatch(/ready|awaiting-user/);
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  const fields = async () => (await ui({ type: "SCAN_TAB", tabId })).observation.fields;
  expect((await fields()).map((field: { label: string; options: string[]; required: boolean; value: string; protected: boolean; fillWarning?: string }) => ({
    label: field.label, options: field.options, required: field.required, value: field.value, protected: field.protected, fillWarning: field.fillWarning,
  }))).toEqual(questions.map(([, label, options], index) => ({
    label, options: [...options], required: true, value: ["No", "Asian", "Female", "I am not a protected veteran"][index], protected: false, fillWarning: undefined,
  })));
  await page.locator('[data-name="eeoGender"] [data-label="Male"]').click();
  await expect.poll(async () => (await fields()).find((field: { label: string }) => field.label === "Gender")?.value).toBe("Male");
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toMatch(/ready|awaiting-user/);
  expect((await fields()).find((field: { label: string }) => field.label === "Gender")).toMatchObject({ value: "Male", protected: true });
});

test("native inputs behind custom choices retain answers and preserve applicant edits", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: {
    ...profile, workAuthorization: "Yes", sponsorship: "No",
    answers: [{ question: "Receive my requested update?", answer: "Yes" }],
  } });
  await context.route(`${origin}/native-custom-choices`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><style>[role=radio],[role=checkbox]{display:block;padding:12px}input[aria-hidden=true]{display:none}</style><form>
      <fieldset role="radiogroup" aria-labelledby="auth-question"><span id="auth-question">Are you authorized to work in the United States?*</span>
        <label for="auth-yes"><div role="radio" aria-checked="false" aria-required="true" aria-labelledby="auth-question auth-yes-label"><input id="auth-yes" name="auth" type="radio" aria-hidden="true"><span id="auth-yes-label">Yes</span></div></label>
        <label for="auth-no"><div role="radio" aria-checked="false" aria-labelledby="auth-question auth-no-label"><input id="auth-no" name="auth" type="radio" aria-hidden="true"><span id="auth-no-label">No</span></div></label></fieldset>
      <fieldset role="radiogroup" aria-labelledby="spons-question"><span id="spons-question">Will you require sponsorship for work in the United States?*</span>
        <div role="radio" aria-checked="false" aria-required="true" aria-labelledby="spons-question spons-yes-label"><label for="spons-yes"><input id="spons-yes" name="spons" type="radio" aria-hidden="true"><span id="spons-yes-label">Yes</span></label></div>
        <div role="radio" aria-checked="false" aria-labelledby="spons-question spons-no-label"><label for="spons-no"><input id="spons-no" name="spons" type="radio" aria-hidden="true"><span id="spons-no-label">No</span></label></div></fieldset>
      <fieldset role="radiogroup" aria-labelledby="family-question"><span id="family-question">Does a family member work here?</span>
        <div role="radio" aria-checked="false" aria-labelledby="family-question family-yes-label"><input id="family-yes" name="family" type="radio" aria-hidden="true"><span id="family-yes-label">Yes</span></div>
        <div role="radio" aria-checked="false" aria-labelledby="family-question family-no-label"><input id="family-no" name="family" type="radio" aria-hidden="true"><span id="family-no-label">No</span></div></fieldset>
      <label for="update"><div role="checkbox" aria-checked="false" aria-label="Receive my requested update?"><input id="update" type="checkbox" aria-hidden="true"></div></label>
      <label>Signature<input id="signature" required></label><button type="submit">Submit application</button></form><script>
        window.submissions = 0; window.saved = {};
        document.querySelector('form').onsubmit = event => { event.preventDefault(); window.submissions++; };
        for (const input of document.querySelectorAll('input[type=radio],input[type=checkbox]')) input.onchange = event => {
          const wrapper = input.closest('[role=radio],[role=checkbox]');
          const group = wrapper.closest('[role=radiogroup]');
          if (group) for (const choice of group.querySelectorAll('[role=radio]')) choice.setAttribute('aria-checked', String(choice.querySelector('input').checked));
          else wrapper.setAttribute('aria-checked', String(input.checked));
          window.saved[input.name || input.id] = input.id;
        };
      </script>`,
  }));
  const page = await context.newPage();
  await page.goto(`${origin}/native-custom-choices`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toBe("awaiting-user");
  const observation = (await content(page, { type: "INSPECT" })).data;
  expect(observation.fields.filter((field: { kind: string }) => field.kind === "radio").map((field: { label: string; options: string[]; value: string }) => ({ label: field.label, options: field.options, value: field.value }))).toEqual([
    { label: "Are you authorized to work in the United States?", options: ["Yes", "No"], value: "Yes" },
    { label: "Will you require sponsorship for work in the United States?", options: ["Yes", "No"], value: "No" },
    { label: "Does a family member work here?", options: ["Yes", "No"], value: "" },
  ]);
  expect(await page.evaluate(() => (window as any).saved)).toMatchObject({ auth: "auth-yes", spons: "spons-no", update: "update" });
  await expect(page.locator('#update').locator('..')).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('#signature')).toHaveValue("");
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
  await page.locator('label[for=auth-no]').click();
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toBe("awaiting-user");
  const edited = (await content(page, { type: "INSPECT" })).data.fields.find((field: { label: string }) => field.label === "Are you authorized to work in the United States?");
  expect(edited).toMatchObject({ value: "No", protected: true });
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

test("Ashby single-control question titles identify remote fields without crossing adjacent or ambiguous controls", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: {
    ...profile, state: "Arizona", education: [{ organization: "Test University", title: "Bachelor of Science", startDate: "2024-08", endDate: "2028-05" }],
  } });
  await context.route(`${origin}/ashby-question-titles`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><form><style>[role=combobox],[role=option]{display:block;padding:10px}</style>
      <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_fixture" for="missing-location-id">Location</label><div><input id="location-picker" role="combobox" aria-controls="location-options" aria-expanded="false" placeholder="Start typing..."><div id="location-options" role="listbox" hidden><div role="option">Phoenix, Arizona, United States</div></div></div></div>
      <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_fixture" for="missing-university-id">University</label><div><input id="university-picker" role="combobox" aria-controls="university-options" aria-expanded="false" placeholder="Start typing..."><div id="university-options" role="listbox" hidden><div role="option">Test University</div></div></div></div>
      <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title" for="missing-favorite-id">Favorite campus</label><input id="favorite-picker" role="combobox" placeholder="Start typing..." required></div>
      <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Location</label><input id="ambiguous-a" role="combobox" placeholder="Start typing..."><input id="ambiguous-b" role="combobox" placeholder="Start typing..."></div>
      <button type="submit">Submit application</button></form><script>
        window.submissions = 0;
        document.querySelector('form').onsubmit = event => { event.preventDefault(); window.submissions++; };
        for (const input of document.querySelectorAll('#location-picker,#university-picker')) {
          const menu = input.nextElementSibling;
          const open = () => { menu.hidden = false; input.setAttribute('aria-expanded','true'); };
          input.onfocus = open; input.oninput = open; input.onclick = open; input.onmousedown = open;
          input.onkeydown = event => { if (event.key === 'Escape') { menu.hidden = true; input.setAttribute('aria-expanded','false'); } };
          menu.firstElementChild.onclick = () => { input.value = menu.firstElementChild.textContent; menu.hidden = true; input.setAttribute('aria-expanded','false'); input.dispatchEvent(new Event('change',{bubbles:true})); };
        }
      </script>`,
  }));
  const page = await context.newPage();
  await page.goto(`${origin}/ashby-question-titles`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toBe("awaiting-user");
  await expect(page.locator('#location-picker')).toHaveValue("Phoenix, Arizona, United States");
  await expect(page.locator('#university-picker')).toHaveValue("Test University");
  const fields = (await content(page, { type: "INSPECT" })).data.fields;
  expect(fields.find((field: { label: string }) => field.label === "University")).toMatchObject({ value: "Test University", required: true });
  expect(fields.find((field: { label: string }) => field.label === "Favorite campus")).toMatchObject({ value: "" });
  await expect(page.locator('#ambiguous-a')).toHaveValue("");
  await expect(page.locator('#ambiguous-b')).toHaveValue("");
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

test("an explicit location-address helper fills confirmed location without replacing a real applicant edit", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, state: "Arizona", address: "100 Test Way" } });
  await context.route(`${origin}/location-address`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><form>
    <label for="address">Address</label><input id="address" required aria-describedby="address_helper" value="Seattle, Washington, United States">
    <p id="address_helper">Include your city, region, and country, so that employers can easily manage your application.</p>
    <label for="street">Home address</label><input id="street" required>
    <label>Signature<input required></label><button type="submit">Submit</button></form><script>
      window.submissions=0; window.locationSaved='';
      document.querySelector('form').onsubmit=event=>{event.preventDefault();window.submissions++};
      document.querySelector('#address').onchange=event=>{event.preventDefault();window.locationSaved=event.target.value};
    </script>` }));
  const page = await context.newPage();
  await page.goto(`${origin}/location-address`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toBe("awaiting-user");
  await expect(page.locator("#address")).toHaveValue("Phoenix, Arizona, United States");
  await expect(page.locator("#street")).toHaveValue("100 Test Way");
  expect(await page.evaluate(() => (window as any).locationSaved)).toBe("Phoenix, Arizona, United States");
  const fields = (await content(page, { type: "INSPECT" })).data.fields;
  expect(fields.find((field: { label: string }) => field.label === "Address (city, region, country)")).toMatchObject({ value: "Phoenix, Arizona, United States", required: true });
  await page.locator("#address").fill("Applicant's confirmed new location");
  await page.locator("#address").blur();
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toBe("awaiting-user");
  await expect(page.locator("#address")).toHaveValue("Applicant's confirmed new location");
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});

test("ADP phone controls apply their keyboard formatting during autofill", async () => {
  // ADP contact form, report 5ee92470-7aae-417f-b930-ac5a6a3bd0df.
  // The capture lacks the mask script; model the keyboard-driven formatting
  // reported by the applicant in the saved phone control's shadow structure.
  await context.route(`${adpOrigin}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><title>Contact Information</title><cx-root><form>
      <label>Email Address<input name="emailAddress" type="email"></label>
      <adp-form-group data-name="phone"><label>Phone</label>
        <dynamic-form-sdf-phone-number><sdf-phone-number-input></sdf-phone-number-input></dynamic-form-sdf-phone-number>
      </adp-form-group>
    </form></cx-root><script>
      customElements.define('sdf-phone-number-input', class extends HTMLElement {
        connectedCallback() {
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = '<label for="input">Phone</label><div class="sdf-input-container"><input id="input" type="tel" autocomplete="off" placeholder="Enter phone number"></div>';
          const input = root.querySelector('input');
          input.addEventListener('keyup', () => {
            const digits = input.value.replace(/[^0-9]/g, '');
            if (digits.length === 10) input.value = '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
          });
        }
      });
    </script>`,
  }));
  const page = await context.newPage();
  await page.goto(`${adpOrigin}/fixture/cx/app?workflowComponent=contact`);
  await background(page);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toMatch(/ready|awaiting-user/);
  await expect(page.locator('sdf-phone-number-input input')).toHaveValue("(602) 555-0101");
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  const phone = (await ui({ type: "SCAN_TAB", tabId })).observation.fields.find(
    (field: { label: string }) => field.label === "Phone",
  );
  expect(phone.protected).toBe(false);
  expect(phone.fillWarning).toBeUndefined();
  await expect(page.locator('[name="emailAddress"]')).toHaveValue(profile.email);
});

test("ADP keeps selected dropdown answers when their filter boxes are empty", async () => {
  // ADP contact form, report 63f5ef6a-b7a0-4ec3-995b-a718c9327ae7:
  // choosing an option clears the filter; choosing Country resets State.
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, state: "Colorado" } });
  await context.route(`${adpOrigin}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><title>Contact Information</title><cx-root><form>
      <label>Email Address<input name="emailAddress" type="email"></label>
      <adp-form-group data-name="phoneType"><label>Phone Type</label><sdf-select-simple></sdf-select-simple></adp-form-group>
      <adp-form-group data-name="country"><label>Country</label><sdf-select-simple></sdf-select-simple></adp-form-group>
      <adp-form-group data-name="state"><label>State</label><sdf-select-simple></sdf-select-simple></adp-form-group>
    </form></cx-root><script>
      customElements.define('sdf-select-simple', class extends HTMLElement {
        connectedCallback() {
          const key = this.closest('adp-form-group').dataset.name;
          const choices = { phoneType: ['Cell', 'Home'], country: ['United States', 'United States Minor Outlying Islands'], state: ['Colorado', 'California'] }[key];
          this.dataset.picks = '0';
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = '<div class="trigger-button" role="button" tabindex="0" aria-expanded="false"><span id="selected-label">-</span></div>'
            + '<sdf-floating-pane style="display:none"><input class="filter" type="text" role="combobox" aria-label="Enter text to filter your options" placeholder="Filter...">'
            + '<div role="listbox">' + choices.map(name => '<sdf-select-item role="option" aria-selected="false">' + name + '</sdf-select-item>').join('') + '</div></sdf-floating-pane>';
          const trigger = root.querySelector('.trigger-button'), pane = root.querySelector('sdf-floating-pane'), filter = root.querySelector('input');
          trigger.addEventListener('click', () => { trigger.setAttribute('aria-expanded', 'true'); pane.style.display = 'block'; });
          filter.addEventListener('keyup', () => {
            for (const item of root.querySelectorAll('sdf-select-item')) item.style.display = item.textContent.toLowerCase().includes(filter.value.toLowerCase()) ? 'block' : 'none';
          });
          for (const item of root.querySelectorAll('sdf-select-item')) item.addEventListener('click', () => {
            this.dataset.picks = String(Number(this.dataset.picks) + 1);
            root.querySelector('#selected-label').textContent = item.textContent;
            for (const option of root.querySelectorAll('sdf-select-item')) option.setAttribute('aria-selected', String(option === item));
            filter.value = '';
            trigger.setAttribute('aria-expanded', 'false');
            pane.style.display = 'none';
            if (key === 'country') document.querySelector('[data-name="state"] sdf-select-simple').shadowRoot.querySelector('#selected-label').textContent = '-';
          });
        }
      });
    </script>`,
  }));
  const page = await context.newPage();
  await page.goto(`${adpOrigin}/fixture/cx/app?workflowComponent=contact`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toMatch(/ready|awaiting-user/);
  const selections = async () => page.locator('sdf-select-simple').evaluateAll((elements) => elements.map((element) => ({
    label: element.shadowRoot!.querySelector('#selected-label')!.textContent,
    picks: (element as HTMLElement).dataset.picks,
    filter: (element.shadowRoot!.querySelector('input') as HTMLInputElement).value,
  })));
  const expected = ['Cell', 'United States', 'Colorado'].map((label) => ({ label, picks: '1', filter: '' }));
  expect(await selections()).toEqual(expected);
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toMatch(/ready|awaiting-user/);
  expect(await selections()).toEqual(expected);
  await expect(page.locator('.trigger-button')).toHaveCount(3);
  for (const trigger of await page.locator('.trigger-button').all()) await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test("a location search that finds nothing is closed, so the rest of the form stays visible", async () => {
  // As Talos's Ashby form in the nightly replay (2026-10-02): the search
  // answers "No results", and while its list is open the site hides every
  // other field from assistive technology (aria-hidden), so the next look
  // at the form found two fields and attached nothing.
  const ashby = atsOrigins[3];
  await context.route(`${ashby}/locationfixture/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Quantitative Analyst Intern</title><main><form>
        <div class="fieldEntry"><label class="question-title" for="loc">Location</label>
          <input id="loc" role="combobox" aria-expanded="false" aria-controls="loc-list" placeholder="Start typing..."></div>
        <ul id="loc-list" role="listbox" hidden><li role="option" aria-disabled="true">No results</li></ul>
        <div id="rest">
          <div class="fieldEntry"><label for="email">Email</label><input id="email" type="email"></div>
          <div class="fieldEntry"><label for="_systemfield_resume">Resume</label><input id="_systemfield_resume" name="_systemfield_resume" type="file" accept=".pdf"></div>
        </div>
      </form></main>
      <script>
        const loc = document.getElementById('loc'), list = document.getElementById('loc-list'), rest = document.getElementById('rest');
        const open = () => { loc.setAttribute('aria-expanded', 'true'); list.hidden = false; rest.setAttribute('aria-hidden', 'true'); };
        const close = () => { loc.setAttribute('aria-expanded', 'false'); list.hidden = true; rest.removeAttribute('aria-hidden'); };
        loc.addEventListener('input', () => (loc.value ? open() : close()));
        loc.addEventListener('keydown', (event) => event.key === 'Escape' && close());
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${ashby}/locationfixture/d6d0c99a-f281-4efe-89c4-026f7f5edc2b/application`);
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0]?.status, { timeout: 60000 })
    .toMatch(/ready|awaiting-user/);
  await expect(page.locator("#loc-list")).toBeHidden();
  await expect(page.locator("#rest")).not.toHaveAttribute("aria-hidden", "true");
  expect(await page.locator("#_systemfield_resume").evaluate((input: HTMLInputElement) => input.files?.[0]?.name || "")).toMatch(/\.pdf$/);
});

test("SuccessFactors uploads the resume through its dialog and fills rows it adds", async () => {
  // Each search the list cannot answer waits out its pick (5s), on every pass.
  test.setTimeout(180000);
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      country: "United States of America",
      state: "Arizona",
      education: [
        { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "M.S. Data Science, Statistics & Engineering", startDate: "2025-08", endDate: "2027-05", location: "", details: "" },
      ],
      work: [
        { organization: "Northwind Labs", title: "Creative Technology Associate", location: "Tucson, AZ", details: "Built VR simulations.", startDate: "2026-03", endDate: "" },
        { organization: "Brightline.AI", title: "Software Engineer Intern", location: "Pune", details: "Built REST APIs.", startDate: "2023-06", endDate: "2023-09" },
      ],
    },
  });
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      // Shaped like CNH's SuccessFactors application (issue reports and a
      // recording, 2026-09-30): "Upload a Resume" opens a dialog holding the
      // file input, and Add creates rows in the Work Experiences section.
      body: `<!doctype html><title>Career Opportunities: Apply for Software Engineer Intern (5659)</title><main>
        <div class="RCMFormField rcmFormElement attachmentField"><label class="rcmFormFieldLabel">Resume</label>
          <div class="attachmentComponentInput"><div id="51:_attachLabel" class="attachmentLabel attachmentText"><span>Upload a Resume</span></div>
            <div class="attachActions"><span role="button" id="51:_attachIcon" class="glyphicon glyphicon-plus-sign addAttachments"></span></div></div></div>
        <div class="RCMFormField"><label class="rcmFormFieldLabel">Country of Residence</label>
          <div class="fieldComponentInput"><input role="combobox" aria-label="Country of Residence" id="86:_input" class="rcmpaginatedselectinput"></div></div>
        <div class="RCMFormField"><label class="rcmFormFieldLabel">USA State</label>
          <div class="fieldComponentInput"><input role="combobox" aria-label="USA State" id="93:_input" class="rcmpaginatedselectinput"></div></div>
        <div id="123:section" class="rcmFormSection row">
          <h2 class="sectionTitle"><button id="123:topBar" class="topBar rcmFormSectionTopBar"><span>Work Experiences</span></button></h2>
          <div id="rows"></div>
          <div id="123:_addRowBtn" role="button" title="Add new row" class="addRowButton">Add</div>
        </div>
        <div id="125:section" class="rcmFormSection row">
          <h2 class="sectionTitle"><button id="125:topBar" class="topBar rcmFormSectionTopBar"><span>Education</span></button></h2>
          <div id="eduRows"></div>
          <div id="125:_addRowBtn" role="button" title="Add new row" class="addRowButton">Add</div>
        </div>
      </main><script>
        window.uploaded = [];
        // SuccessFactors' search: only options holding what was typed show,
        // about 0.7s after typing (recording, 2026-10-01).
        let searching;
        const searchable = (input, options) => (input.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') (clearTimeout(searching), document.querySelector('ul.sf-list-select')?.remove());
        }), ['keyup', 'input'].forEach((type) => input.addEventListener(type, (event) => {
          if (event.key === 'Escape' || !input.value) return;
          if (event.type === 'input') input.dataset.typed = String(Number(input.dataset.typed || 0) + 1);
          document.querySelector('ul.sf-list-select')?.remove();
          clearTimeout(searching);
          searching = setTimeout(() => {
          const list = document.createElement('ul');
          list.className = 'sf-list-select';
          for (const name of options.filter((n) => n.toLowerCase().includes(input.value.toLowerCase()))) {
            const item = document.createElement('li');
            item.setAttribute('role', 'option');
            item.innerHTML = '<a title="' + name + '">' + name + '</a>';
            item.querySelector('a').addEventListener('click', () => { input.value = name; input.dataset.picked = name; list.remove(); });
            list.append(item);
          }
          document.body.append(list);
          }, 700);
        })));
        const country = document.getElementById('86:_input');
        searchable(country, ['United Kingdom', 'United States', 'United States Minor Outlying Islands']);
        // A list without the answer: nothing may be left typed in the box.
        searchable(document.getElementById('93:_input'), ['California', 'Texas']);
        // A UI5 date picker: the value lives on the component, behind two
        // shadow roots, as on SuccessFactors.
        customElements.define('ui5-datetime-input-xweb-calendar-widget', class extends HTMLElement {
          constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<input class="ui5-input-inner" type="text">'; }
        });
        customElements.define('ui5-date-picker-xweb-calendar-widget', class extends HTMLElement {
          constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<ui5-datetime-input-xweb-calendar-widget></ui5-datetime-input-xweb-calendar-widget>'; this._value = ''; }
          get value() { return this._value; }
          set value(v) { this._value = v; this.setAttribute('value', v); }
        });
        // As on CNH's page (recording, 2026-10-01): the label text does
        // nothing; the + icon opens the dialog.
        document.getElementById('51:_attachIcon').addEventListener('click', () => setTimeout(() => {
          const panel = document.createElement('div');
          panel.className = 'sfPanelComponent';
          panel.innerHTML = '<span class="panelHeaderTitle" title="Upload Resume">Upload Resume</span><input type="file" name="fileData"><button type="button" title="Upload">Upload</button>';
          document.body.append(panel);
          panel.querySelector('button').addEventListener('click', () => {
            window.uploaded.push(panel.querySelector('input').files[0]?.name || '');
            panel.remove();
            const done = document.createElement('span');
            done.className = 'important-focus-msg';
            done.textContent = 'Your resume has been uploaded.';
            document.body.append(done);
            // Then the site reloads the form from what it saved: unsaved rows
            // and answers are gone (recording, 2026-10-01).
            setTimeout(() => {
              document.getElementById('rows').innerHTML = '';
              rows = 0;
              country.value = '';
              delete country.dataset.picked;
            }, 500);
          });
        }, 300));
        let rows = 0;
        // Education: Field of Study lists no data science, only "Other".
        document.getElementById('125:_addRowBtn').addEventListener('click', () => {
          const row = document.createElement('div');
          row.className = 'layoutWrapper row rcmSectionComponent rowBreak';
          row.innerHTML = '<div class="RCMFormField"><label class="rcmFormFieldLabel">School</label><div class="fieldComponentInput"><input type="text" name="school"></div></div>'
            + '<div class="RCMFormField"><label class="rcmFormFieldLabel">Field of Study</label><div class="fieldComponentInput"><input role="combobox" aria-label="Field of Study" class="rcmpaginatedselectinput fieldOfStudy"></div></div>';
          document.getElementById('eduRows').append(row);
          searchable(row.querySelector('.fieldOfStudy'), ['Administration', 'Computer Science', 'Other', 'Other Technology']);
        });
        document.getElementById('123:_addRowBtn').addEventListener('click', () => {
          rows++;
          const row = document.createElement('div');
          row.className = 'layoutWrapper row rcmSectionComponent rowBreak';
          row.innerHTML = '<div class="RCMFormField"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;Start Date</label><div class="fieldComponentInput"><div class="datePicker"><ui5-date-picker-xweb-calendar-widget accessible-name="Start Date" title="Start Date"></ui5-date-picker-xweb-calendar-widget></div></div></div>'
            + '<div class="RCMFormField"><label class="rcmFormFieldLabel" for="pos' + rows + '"><span class="requiredField">*</span>&nbsp;Position</label><div class="fieldComponentInput"><input type="text" id="pos' + rows + '" name="VFLD9"></div></div>'
            + '<div class="RCMFormField"><label class="rcmFormFieldLabel" for="co' + rows + '"><span class="requiredField">*</span>&nbsp;Company</label><div class="fieldComponentInput"><input type="text" id="co' + rows + '" name="VFLD1"></div></div>'
            + '<div class="RCMFormField"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;Country</label><div class="fieldComponentInput"><input role="combobox" aria-label="Country" class="rcmpaginatedselectinput rowCountry"></div></div>';
          document.getElementById('rows').append(row);
          searchable(row.querySelector('.rowCountry'), ['United States', 'United States Minor Outlying Islands']);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture`);
  await enqueue([page]);
  await expect.poll(() => page.evaluate(() => (window as any).uploaded), { timeout: 60000 }).toEqual([
    expect.stringMatching(/resume.*\.pdf$/i),
  ]);
  // Filled again after the reload, and the resume uploaded only once.
  await page.waitForTimeout(1500);
  await expect(page.locator('[name="VFLD1"]').nth(0)).toHaveValue("Northwind Labs", { timeout: 60000 });
  await expect(page.locator('[name="VFLD1"]').nth(1)).toHaveValue("Brightline.AI");
  await expect(page.locator('[name="VFLD9"]').nth(1)).toHaveValue("Software Engineer Intern");
  await expect(page.locator('[name="VFLD1"]')).toHaveCount(2);
  // "United States of America" finds nothing; the next value is searched.
  await expect(page.locator('[aria-label="Country of Residence"]')).toHaveAttribute("data-picked", "United States", { timeout: 30000 });
  expect(await page.evaluate(() => (window as any).uploaded)).toHaveLength(1);
  await expect(page.locator('[aria-label="USA State"]')).toHaveValue("");
  // Every pass finished: a later one must not type over what was picked.
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 120000 })
    .toMatch(/^(ready|awaiting-user|failed)$/);
  // Each row's own Country; an unavailable field of study stays manual.
  await expect(page.locator(".rowCountry").nth(0)).toHaveAttribute("data-picked", "United States");
  await expect(page.locator(".rowCountry").nth(1)).toHaveAttribute("data-picked", "United States");
  await expect(page.locator(".fieldOfStudy")).not.toHaveAttribute("data-picked", /.+/);
  await expect(page.locator(".fieldOfStudy")).not.toHaveValue("Other");
  expect((await state()).applications[0].missing.join(" ")).toMatch(/Field of Study/i);
  await expect(page.locator('[aria-label="Country of Residence"]')).toHaveValue("United States");
  // Rows are told apart: each field has its own section and row.
  const observed = await content(page, { type: "INSPECT" });
  const countries = observed.data.fields.filter((f: { label: string }) => f.label === "* Country" || f.label === "Country");
  expect(countries.map((f: { section?: string; index?: number }) => [f.section, f.index])).toEqual([
    ["Work Experiences", 0],
    ["Work Experiences", 1],
  ]);
  // A date's input inside its picker's shadow root belongs to the row too
  // (L3Harris, report 56e13a52: every "Start Date" was one locked field).
  // (This copy's picker gives its input no label of its own.)
  const starts = observed.data.fields.filter((f: { label: string; kind: string }) => f.kind === "text" && /Start Date|Unlabelled field/.test(f.label));
  expect(starts.map((f: { section?: string; index?: number }) => [f.section, f.index])).toEqual([
    ["Work Experiences", 0],
    ["Work Experiences", 1],
  ]);
  await expect(page.locator("ul.sf-list-select")).toHaveCount(0);
  // Each row's start date, set on the UI5 component.
  await expect(page.locator("ui5-date-picker-xweb-calendar-widget").nth(0)).toHaveAttribute("value", "03/01/2026");
  await expect(page.locator("ui5-date-picker-xweb-calendar-widget").nth(1)).toHaveAttribute("value", "06/01/2023");
});

// Expand Energy's SuccessFactors form (report a248361b, 2026-10-29) titles
// its schools "What is your educational background?". The section was found
// only by the word "education", so its rows were not seen: the one row the
// page showed was filled field by field, and the second school never added.
// Its Degree list then took "Bachelor in Business Administration" for
// "Bachelors of Science": the generic "Bachelor" matched it by its start
// before "Bachelor of Science" was looked for by its title. And its School
// Name took "Michigan College of Beauty - Troy" for Michigan State University:
// a rule's "%value%" was never filled in, and translate() spelled it from
// "Michigan " itself. Its lists also show their options a hundred at a time
// and load more as they are scrolled to the end, so a school far down the
// alphabet ("Pennsylvania State University-University Park") was
// never drawn to be picked (report 8f198b5b). Once drawn, the option just
// before it, "…University University Park Dietetic Internship", was taken by
// its start; the one that is the school's name, punctuation aside, is wanted.
// A school the list lacks takes its "Other…" and the name in "If other,
// enter School Name", which stays empty beside a school the list has.
test("a SuccessFactors section about educational background gets a row for each school", async () => {
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      education: [
        { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05", location: "", details: "" },
        { organization: "Pennsylvania State University, University Park", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "", details: "" },
        { organization: "Oregon Institute of Technology", title: "Bachelor of Arts", fieldOfStudy: "History", startDate: "2016-09", endDate: "2018-06", location: "", details: "" },
      ],
    },
  });
  const school = `<div class="layoutWrapper row rcmSectionComponent rowBreak"><div class="RCMFormField"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;School Name</label><div class="fieldComponentInput"><input type="text" role="combobox" aria-label="School Name" placeholder="No Selection" class="rcmpaginatedselectinput school" name="school"></div></div>`
    + `<div class="RCMFormField"><label class="rcmFormFieldLabel">If other, enter School Name</label><div class="fieldComponentInput"><input type="text" class="otherSchool"></div></div>`
    + `<div class="RCMFormField"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;Degree</label><div class="fieldComponentInput"><input type="text" role="combobox" aria-label="Degree" placeholder="No Selection" class="rcmpaginatedselectinput degree"></div></div>`
    // Only "Status", the required marker and a no-break space before it (report 3478a76e).
    + `<div class="RCMFormField"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;Status</label><div class="fieldComponentInput"><input type="text" role="combobox" placeholder="No Selection" class="rcmpaginatedselectinput status"></div></div></div>`;
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Career Opportunities: Apply for Software Engineer I (23589)</title><main>
        <div class="rcmFormSection row"><h2 class="sectionTitle"><button class="topBar rcmFormSectionTopBar"><span>What is your educational background?</span></button></h2>
          <div id="eduRows">${school}</div>
          <div role="button" title="Add new row" class="addRowButton" id="addSchool">Add</div>
        </div>
      </main><script>
        // As on Expand Energy's form: the whole list opens on a click.
        const degrees = ['No Selection', 'Associates Degree', 'Bachelor in Business Administration', 'Bachelor of Arts', 'Bachelor of Science', 'Master of Science'];
        const schools = ['No Selection', 'A.T. Still University of Health Sciences Arizona School of D', 'Michigan College of Beauty - Troy', 'Michigan State University',
          'Michigan Technological University', 'Middlebury College', 'Mississippi State University', 'Missouri State University', 'Montana State University', 'Montclair State University', 'Morehouse College', 'Mount Holyoke College', 'New Jersey Institute of Technology', 'New Mexico State University', 'New York University', 'North Carolina State University', 'North Dakota State University', 'Northeastern University', 'Northern Illinois University', 'Northwestern University', 'Oakland University', 'Oberlin College', 'Occidental College', 'Ohio State University', 'Ohio University', 'Oklahoma State University', 'Old Dominion University', 'Oregon State University', 'Pace University', 'Pacific Lutheran University', 'Pennsylvania College of Technology', 'Pennsylvania State University College of Medicine', 'Pennsylvania State University Dickinson Law', 'Pennsylvania State University Great Valley',
          'Pennsylvania State University University Park Dietetic Internship', 'Pennsylvania State University-University Park', 'Other (Provide Name in Next Field)'];
        // Ten options at first, ten more each time the list is scrolled to its end.
        // Each list is named by the box it belongs to, as on SuccessFactors.
        let lists = 0;
        const picklist = (input, choices = degrees) => (input.setAttribute('aria-owns', 'list' + ++lists), input.addEventListener('click', () => {
          document.querySelector('ul.sf-list-select')?.remove();
          const list = document.createElement('ul');
          list.className = 'sf-list-select';
          list.setAttribute('role', 'listbox');
          list.id = input.getAttribute('aria-owns');
          list.style.cssText = 'max-height: 120px; overflow-y: auto; margin: 0';
          let shown = 0;
          const more = () => {
            for (const name of choices.slice(shown, shown + 10)) {
              const item = document.createElement('li');
              item.setAttribute('role', 'option');
              item.style.height = '24px';
              item.innerHTML = '<a title="' + name + '">' + name + '</a>';
              // The pick is shown in the box and named in its title, as on SuccessFactors.
              item.querySelector('a').addEventListener('click', () => { input.value = name === 'No Selection' ? '' : name; input.title = input.value; list.remove(); });
              list.append(item);
            }
            shown += 10;
          };
          more();
          list.addEventListener('scroll', () => { if (list.scrollTop + list.clientHeight >= list.scrollHeight - 2) setTimeout(more, 100); });
          setTimeout(() => document.body.append(list), 150);
        }));
        document.querySelectorAll('.degree').forEach((input) => picklist(input));
        const statuses = ['No Selection', 'Currently Attending', 'Graduated', 'Incomplete'];
        document.querySelectorAll('.status').forEach((input) => picklist(input, statuses));
        document.querySelectorAll('.school').forEach((input) => picklist(input, schools));
        document.getElementById('addSchool').addEventListener('click', () => {
          document.getElementById('eduRows').insertAdjacentHTML('beforeend', ${JSON.stringify(school)});
          picklist([...document.querySelectorAll('.degree')].at(-1));
          picklist([...document.querySelectorAll('.status')].at(-1), statuses);
          picklist([...document.querySelectorAll('.school')].at(-1), schools);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?educational`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 40_000 }).toMatch(/ready|awaiting-user|paused/);
  await expect(page.locator('input[name="school"]')).toHaveCount(3);
  await expect(page.locator('input[name="school"]').nth(0)).toHaveValue("Michigan State University");
  await expect(page.locator('input[name="school"]').nth(1)).toHaveValue("Pennsylvania State University-University Park");
  await expect(page.locator(".degree").nth(0)).toHaveValue("Master of Science");
  await expect(page.locator(".degree").nth(1)).toHaveValue("Bachelor of Science");
  await expect(page.locator('input[name="school"]').nth(2)).toHaveValue("Other (Provide Name in Next Field)");
  await expect(page.locator(".otherSchool").nth(2)).toHaveValue("Oregon Institute of Technology");
  await expect(page.locator(".otherSchool").nth(0)).toHaveValue("");
  await expect(page.locator(".otherSchool").nth(1)).toHaveValue("");
  await expect(page.locator(".status").nth(0)).toHaveValue("Currently Attending");
  await expect(page.locator(".status").nth(1)).toHaveValue("Graduated");
  // Filled again, a list set to Other keeps it: the name was typed over it
  // each pass and picked again (report on Expand Energy, 2026-10-30).
  await page.evaluate(() => {
    (window as unknown as { typedSchools: number }).typedSchools = 0;
    (window as unknown as { reopened: number }).reopened = 0;
    const lists = document.querySelectorAll('input[name="school"]');
    for (const input of lists)
      input.addEventListener('input', () => (window as unknown as { typedSchools: number }).typedSchools++);
    // The list already set to Other is not opened again either: each pass
    // reopened Expand Energy's and left it open, marked invalid (2026-10-30).
    lists[2].addEventListener('click', () => (window as unknown as { reopened: number }).reopened++);
  });
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 40_000 }).toMatch(/ready|awaiting-user|paused/);
  await expect(page.locator('input[name="school"]').nth(2)).toHaveValue("Other (Provide Name in Next Field)");
  await expect(page.locator(".otherSchool").nth(2)).toHaveValue("Oregon Institute of Technology");
  expect(await page.evaluate(() => (window as unknown as { typedSchools: number }).typedSchools)).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { reopened: number }).reopened)).toBe(0);
});

// A report on Wisconsin Public Service's SuccessFactors profile, 2026-10-14:
// each job's "Present Employer" (Current or Prior) and each school's
// "Education Status" were left, both lists that open only on a click.
test("a SuccessFactors profile answers each job's Present Employer and each school's Education Status", async () => {
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      education: [
        { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05", location: "", details: "" },
        { organization: "Virginia Tech", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "", details: "" },
      ],
      work: [
        { organization: "Example Labs", title: "Associate", location: "Tucson, AZ", details: "Built simulations.", startDate: "2026-03", endDate: "" },
        { organization: "Sample AI", title: "Intern", location: "Remote", details: "Built APIs.", startDate: "2023-06", endDate: "2023-09" },
      ],
    },
  });
  const picklist = (row: string, label: string, id: string, delay = 200) =>
    `<div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;${label}</label><div class="fieldComponentInput"><span class="sfCascadingPicklist"><input type="text" role="combobox" aria-label="${label}" aria-expanded="false" aria-owns="${id}:_listSelect" data-delay="${delay}" placeholder="No Selection" class="rcmpaginatedselectinput ${row}"><button type="button" class="rcmpaginatedselectbutton" aria-label="${label}"></button></span></div></div>`;
  // The first job's list comes late, as one did on the reported page (6.4s
  // after its click, behind the site's own request for it).
  const job = (n: number) =>
    `<div class="layoutWrapper row rcmSectionComponent rowBreak"><div class="RCMFormField"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;Company Name</label><div class="fieldComponentInput"><input type="text" name="VFLD1" id="co${n}"></div></div>${picklist("present", "Present Employer", `job${n}`, n === 1 ? 6000 : 200)}</div>`;
  const school = (n: number) =>
    `<div class="layoutWrapper row rcmSectionComponent rowBreak"><div class="RCMFormField"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;School</label><div class="fieldComponentInput"><input type="text" name="school" id="school${n}"${n === 1 ? ' value="Michigan State University"' : ""}></div></div>${picklist("status", "Education Status:", `school${n}`)}${picklist("level", "Level  (High School,College, University, Other)", `level${n}`)}</div>`;
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      // The page keeps inline scripts inside its content region, and asks
      // for a cover letter only in the words of a slot labelled "Additional
      // Attachments" (the report again, 22:54).
      body: `<!doctype html><title>Candidate Profile</title><main id="rmkContent">
        <script>/* verp-client: SMRF Globals */ window.smrf = { images: {} };</script>
        <div class="RCMFormField rcmFormElement attachmentField"><label class="rcmFormFieldLabel">Additional Attachments</label>
          <div class="attachmentComponentInput"><div class="attachmentLabel attachmentText"><span>Attach a Cover Letter</span></div>
            <div class="attachActions"><span role="button" id="53:_attachIcon" class="glyphicon glyphicon-plus-sign addAttachments"></span></div></div></div>
        <div class="rcmFormSection row"><h2 class="sectionTitle"><button class="topBar rcmFormSectionTopBar"><span>Previous employment</span></button></h2>${job(1)}${job(2)}</div>
        <div class="rcmFormSection row"><h2 class="sectionTitle"><button class="topBar rcmFormSectionTopBar"><span>Formal education</span></button></h2>${school(1)}${school(2)}</div>
      </main><script>
        // As on the report's page: the list opens on a click, never on a
        // bare mousedown, and lists every option at once.
        const picklist = (input, options) => input.addEventListener('click', () => {
          document.querySelector('ul.sf-list-select')?.remove();
          const list = document.createElement('ul');
          list.className = 'sf-list-select';
          list.setAttribute('role', 'listbox');
          list.id = input.getAttribute('aria-owns');
          for (const name of options) {
            const item = document.createElement('li');
            item.setAttribute('role', 'option');
            item.innerHTML = '<a title="' + name + '">' + name + '</a>';
            item.querySelector('a').addEventListener('click', () => { input.value = name === 'No Selection' ? '' : name; input.dataset.picked = name; list.remove(); input.setAttribute('aria-expanded', 'false'); });
            list.append(item);
          }
          input.setAttribute('aria-expanded', 'true');
          setTimeout(() => document.body.append(list), Number(input.dataset.delay));
        });
        document.querySelectorAll('.present').forEach((input) => picklist(input, ['No Selection', 'Current', 'Prior']));
        document.querySelectorAll('.status').forEach((input) => picklist(input, ['No Selection', 'Currently Attending', 'Graduated', 'Incomplete']));
        window.levelTyped = [];
        document.querySelectorAll('.level').forEach((input) => input.addEventListener('input', () => window.levelTyped.push(input.value)));
        document.querySelectorAll('.level').forEach((input) => picklist(input, ['No Selection', 'Advanced Technical Degree', "Bachelor's Degree", 'Basic Education (Primary)', "Doctor's Degree", "Master's Degree", 'Middle School Education (Secondary)', 'Specialized Technical Degree', 'University Degree']));
        window.uploaded = [];
        // L3Harris's newer chooser (2026-11-07): "Upload from Device" over a
        // file input named "fileData1", no Upload button; choosing a file
        // uploads it.
        document.getElementById('53:_attachIcon').addEventListener('click', () => setTimeout(() => {
          const panel = document.createElement('div');
          panel.className = 'sfPanelComponent';
          panel.setAttribute('role', 'dialog');
          panel.setAttribute('aria-label', 'Select a source for your file upload');
          panel.innerHTML = '<span class="attachmentLabel"><span>Upload from Device</span><br><input tabindex="0" type="file" class="fileUpload" name="fileData1"></span>';
          document.body.append(panel);
          panel.querySelector('input').addEventListener('change', () => {
            window.uploaded.push(panel.querySelector('input').files[0]?.name || '');
            panel.remove();
            const done = document.createElement('span');
            done.className = 'important-focus-msg';
            done.textContent = 'Your cover letter has been uploaded.';
            document.body.append(done);
          });
        }, 300));
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture&navBarLevel=MY_PROFILE`);
  await enqueue([page]);
  await expect(page.locator("#co2")).toHaveValue("Sample AI", { timeout: 60000 });

  await expect(page.locator(".present").nth(0)).toHaveAttribute("data-picked", "Current", { timeout: 30000 });
  await expect(page.locator(".present").nth(1)).toHaveAttribute("data-picked", "Prior");
  await expect(page.locator(".status").nth(0)).toHaveAttribute("data-picked", "Currently Attending");
  await expect(page.locator(".status").nth(1)).toHaveAttribute("data-picked", "Graduated");
  // L3Harris's school rows ask the degree as "Level (High School,College,
  // University, Other)": a degree, though it names schools (report
  // 0234ca67, 2026-10-15, where each school's name was typed into it; and
  // report 9981ed08, where a School Name the page already held sent the
  // name on to the next box whose aria-label names a school).
  await expect(page.locator(".level").nth(0)).toHaveAttribute("data-picked", "Master's Degree");
  await expect(page.locator(".level").nth(1)).toHaveAttribute("data-picked", "Bachelor's Degree");
  expect(await page.evaluate(() => (window as any).levelTyped)).not.toContainEqual(expect.stringMatching(/University|Polytechnic/));
  // The page's words, not its scripts, describe it; so the letter it asks
  // for is drafted and goes through the site's upload dialog.
  const observed = await content(page, { type: "INSPECT" });
  expect(observed.data.description).toContain("Attach a Cover Letter");
  expect(observed.data.description).not.toContain("verp-client");
  await expect.poll(() => page.evaluate(() => (window as any).uploaded), { timeout: 60000 }).toEqual([expect.stringMatching(/cover.*\.pdf$/i)]);
});

// L3Harris's SuccessFactors form after its resume upload rebuilt it
// (report 92f363c7, 2026-10-15): a Country list from a field the site had
// replaced stayed open, and Gender's "M" picked its "Malaysia" while
// Gender's own list was still loading; Veteran Status, whose list never
// came, then took a choice from another open list. A field that names its
// list chooses only from that list.
test("a SuccessFactors picklist chooses only from its own list, never one another field left open", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, gender: "Male", veteranStatus: "No" } });
  // Gender's says it is open with no list drawn, as one on L3Harris's form
  // did after a refresh (report 726eafd7, 2026-11-07): it is opened all the same.
  const picklist = (label: string, id: string, delay: number, staleOpen = false) =>
    `<div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;${label}</label><div class="fieldComponentInput"><span class="sfCascadingPicklist"><input type="text" role="combobox" aria-label="${label}" aria-expanded="${staleOpen}" aria-owns="${id}:_listSelect" data-delay="${delay}" placeholder="No Selection" class="rcmpaginatedselectinput"><button type="button" class="rcmpaginatedselectbutton" aria-label="${label}"></button></span></div></div>`;
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Apply</title><main id="rmkContent">
        <label>First name <input name="first"></label>
        <div class="rcmFormSection row"><h2 class="sectionTitle"><button class="topBar rcmFormSectionTopBar"><span>Job-Specific Information</span></button></h2>
          ${picklist("Gender", "1175", 1500, true)}${picklist("Veteran Status", "1200", 600000)}</div>
      </main>
      <div class="globalMenu sf-combo-listselect" id="637:"><ul id="637:_listSelect" role="listbox" class="sf-list-select">
        <li role="option" id="637:item0"><a role="menuitem" title="No Selection">No Selection</a></li>
        <li role="option" id="637:item1"><a role="menuitem" title="Malaysia">Malaysia</a></li>
        <li role="option" id="637:item2"><a role="menuitem" title="I am not a protected veteran">I am not a protected veteran</a></li>
      </ul></div>
      <script>
        window.strayClicks = [];
        document.getElementById("637:_listSelect").addEventListener("click", (event) => window.strayClicks.push(event.target.textContent));
        const options = { Gender: ["No Selection", "Female", "Male", "Prefer not to Specify"], "Veteran Status": ["No Selection", "Not Protected Veteran (OFCCP)", "Prefer Not To Answer"] };
        document.querySelectorAll(".rcmpaginatedselectinput").forEach((input) => input.addEventListener("click", () => {
          if (input.dataset.opened) return;
          input.dataset.opened = "1";
          input.setAttribute("aria-expanded", "true");
          setTimeout(() => {
            const id = input.getAttribute("aria-owns");
            const list = document.createElement("ul");
            list.className = "sf-list-select";
            list.setAttribute("role", "listbox");
            list.id = id;
            options[input.getAttribute("aria-label")].forEach((name, index) => {
              const item = document.createElement("li");
              item.setAttribute("role", "option");
              item.id = id.replace("_listSelect", "item" + index);
              item.innerHTML = '<a role="menuitem" title="' + name + '">' + name + '</a>';
              item.querySelector("a").addEventListener("click", () => { input.value = name === "No Selection" ? "" : name; input.dataset.picked = name; list.remove(); input.setAttribute("aria-expanded", "false"); delete input.dataset.opened; });
              list.append(item);
            });
            document.body.append(list);
          }, Number(input.dataset.delay));
        }));
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture&career_job_req_id=42826`);
  await enqueue([page]);
  await expect(page.locator('input[name="first"]')).toHaveValue(profile.firstName, { timeout: 60000 });
  await expect(page.locator('input[aria-label="Gender"]')).toHaveAttribute("data-picked", "Male", { timeout: 60000 });
  await expect(page.locator('input[aria-label="Veteran Status"]')).toHaveValue("");
  expect(await page.evaluate(() => (window as any).strayClicks)).toEqual([]);
});

// A SuccessFactors picklist as on L3Harris's form: its choices come from a
// timer the page sets on the click, after `delay` milliseconds.
const sfPicklistPage = (fields: { label: string; id: string; delay: number; options: string[] }[]) =>
  `<!doctype html><title>Apply</title><main id="rmkContent"><label>First name <input name="first"></label>
    <div class="rcmFormSection row"><h2 class="sectionTitle"><button class="topBar rcmFormSectionTopBar"><span>Job-Specific Information</span></button></h2>
    ${fields.map(({ label, id, delay }) => `<div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;${label}</label><div class="fieldComponentInput"><span class="sfCascadingPicklist"><input type="text" role="combobox" aria-label="${label}" aria-expanded="false" aria-owns="${id}:_listSelect" data-delay="${delay}" placeholder="No Selection" class="rcmpaginatedselectinput"><button type="button" class="rcmpaginatedselectbutton" aria-label="${label}"></button></span></div></div>`).join("")}</div></main>
  <script>
    const options = ${JSON.stringify(Object.fromEntries(fields.map((field) => [field.label, field.options])))};
    document.querySelectorAll(".rcmpaginatedselectinput").forEach((input) => {
      input.addEventListener("click", () => {
        if (input.dataset.opened) return;
        input.dataset.opened = "1";
        input.setAttribute("aria-expanded", "true");
        setTimeout(() => {
          const id = input.getAttribute("aria-owns");
          const list = document.createElement("ul");
          list.className = "sf-list-select";
          list.setAttribute("role", "listbox");
          list.id = id;
          options[input.getAttribute("aria-label")].forEach((name, index) => {
            const item = document.createElement("li");
            item.setAttribute("role", "option");
            item.id = id.replace("_listSelect", "item" + index);
            item.innerHTML = '<a role="menuitem" title="' + name + '">' + name + '</a>';
            item.querySelector("a").addEventListener("click", () => { input.value = name === "No Selection" ? "" : name; input.dataset.picked = name; list.remove(); input.setAttribute("aria-expanded", "false"); delete input.dataset.opened; });
            list.append(item);
          });
          document.body.append(list);
          window.shown = { ...window.shown, [id]: (window.shown?.[id] || 0) + 1 };
        }, Number(input.dataset.delay));
      });
      // As on L3Harris's: Escape marks it closed and leaves its list drawn.
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        input.setAttribute("aria-expanded", "false");
        delete input.dataset.opened;
      });
    });
    // A press anywhere else takes every list away.
    document.addEventListener("mousedown", (event) => {
      if (event.target.closest?.(".sf-list-select, .sfCascadingPicklist")) return;
      document.querySelectorAll(".sf-list-select").forEach((list) => list.remove());
      document.querySelectorAll(".rcmpaginatedselectinput").forEach((input) => { input.setAttribute("aria-expanded", "false"); delete input.dataset.opened; });
    });
  </script>`;

// The applicant minimizes the window while a fill runs (report 92f363c7,
// 2026-10-15): Chrome then runs the page's own timers about once a minute,
// and SuccessFactors asks for a list's choices from one, so each came a
// minute late. Headless Chrome never hides a page; here the page is told it
// is hidden and its timers are slowed as Chrome slows them. While a fill
// runs, the page's timers keep their delays.
test("a hidden page's own timers keep their delays while a fill runs", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, gender: "Male" } });
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: sfPicklistPage([{ label: "Gender", id: "375", delay: 300, options: ["No Selection", "Female", "Male"] }]) }),
  );
  const page = await context.newPage();
  await page.addInitScript(() => {
    const slowed = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
      slowed(handler, (Number(ms) || 0) + 60_000, ...args)) as typeof window.setTimeout;
    Object.defineProperty(Document.prototype, "visibilityState", { get: () => "hidden" });
    Object.defineProperty(Document.prototype, "hidden", { get: () => true });
  });
  // The extension's own script, injected when the fill begins, sees the
  // page hidden too.
  const cdp = await context.newCDPSession(page);
  cdp.on("Runtime.executionContextCreated", ({ context: created }) => {
    if (created.auxData?.type === "isolated" && created.name === "Application Lane")
      void cdp.send("Runtime.evaluate", {
        contextId: created.id,
        expression: `Object.defineProperty(Document.prototype, "visibilityState", { get: () => "hidden" }); Object.defineProperty(Document.prototype, "hidden", { get: () => true });`,
      }).catch(() => {});
  });
  await cdp.send("Runtime.enable");
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture&career_job_req_id=42826`);
  await enqueue([page]);
  await expect(page.locator('input[aria-label="Gender"]')).toHaveAttribute("data-picked", "Male", { timeout: 40000 });
});

// A list that comes long after the fill gave up on it is closed, not left
// over the form; one the applicant opens stays open.
test("a SuccessFactors list that opens long after its click is closed, and one the applicant opens is not", async () => {
  test.setTimeout(300000);
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, gender: "Male" } });
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: sfPicklistPage([
        { label: "Gender", id: "375", delay: 170_000, options: ["No Selection", "Female", "Male"] },
        { label: "Shirt Size", id: "390", delay: 300, options: ["No Selection", "Small", "Large"] },
      ]),
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture&career_job_req_id=42826`);
  await enqueue([page]);
  await expect(page.locator('input[name="first"]')).toHaveValue(profile.firstName, { timeout: 60000 });
  // Gender's list arrives 170 seconds after the fill's click, past even a
  // SuccessFactors pass's 150, when the fill has given up on it, and is
  // closed, not picked from.
  await expect.poll(() => page.evaluate(() => (window as any).shown?.["375:_listSelect"] || 0), { timeout: 200000 }).toBeGreaterThan(0);
  // (Within 20 seconds of the fill's last click it is left a while: the
  // fill may still be waiting for it.)
  await expect(page.locator('[id="375:_listSelect"]')).toHaveCount(0, { timeout: 25000 });
  await expect(page.locator('input[aria-label="Gender"]')).not.toHaveAttribute("data-picked", /./);
  await page.locator('input[aria-label="Shirt Size"]').click();
  await expect(page.locator('[id="390:_listSelect"]')).toHaveCount(1);
  await page.waitForTimeout(2000);
  await expect(page.locator('[id="390:_listSelect"]')).toHaveCount(1);
});

// L3Harris's SuccessFactors form (report ebfd5371, 2026-10-15): each Yes/No
// question is a radio group of spans, each named by the label after it, and
// the site puts back the answer it stored for one ("No") when another field
// of the form changes. The profile's answer is the one left.
test("a SuccessFactors Yes/No radio group gets the option its answer names", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, workAuthorization: "US Citizen", legal: { criminal: "No convictions and no pending charges" } } });
  const radio = (id: number, name: string) =>
    `<div class="globalRadio sfRadioInputField fd-form-item fd-form-item--compact" id="${id}:_anchorButton"><span id="${id}:_radio" class="radioCheck radioOff"><span class="radioContainer radioAnchorTag" rel="noopener" id="${id}:_anchor" role="radio" aria-checked="false" aria-labelledby="${id}:_radiolabel" tabindex="-1"><span class="radioIcon"><span class="dot"></span></span></span><label id="${id}:_radiolabel" class="radioLabel">${name}</label></span></div>`;
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Apply</title><main id="rmkContent"><label>First name <input name="first"></label>
        <div class="RCMFormField rcmFormQuestionElement "><label id="175:" for="171:" class="rcmFormQuestionLabel">Are you eligible to obtain a U.S. security clearance?  This is typically based on having U.S. citizenship and successful completion and disposition of an extensive background investigation.</label><div class="fieldComponentInput" id="174:_fieldComponentInput"><div id="171:" class="radioGroup" role="radiogroup" aria-labelledby="175:">${radio(172, "Yes")}${radio(173, "No")}</div></div></div>
      </main><script>
        document.querySelectorAll('[role="radio"]').forEach((option) => option.addEventListener("click", () => {
          document.querySelectorAll('[role="radio"]').forEach((other) => other.setAttribute("aria-checked", String(other === option)));
          window.chosen = document.getElementById(option.getAttribute("aria-labelledby")).textContent;
        }));
        // Before the fill reaches the question, as on the reported page.
        document.querySelector('input[name="first"]').addEventListener("input", () => document.getElementById("173:_anchor").click());
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture&career_job_req_id=42826`);
  await enqueue([page]);
  await expect(page.locator('input[name="first"]')).toHaveValue(profile.firstName, { timeout: 60000 });
  await expect.poll(() => page.evaluate(() => (window as any).chosen), { timeout: 30000 }).toBe("Yes");
});

// L3Harris's "Wage Or Salary Required" (report b5d63aeb, 2026-10-15): a box
// of type "currency", which the browser reads as text, got "$100,000 per
// year." and said "Invalid number." It takes the saved figure alone.
test("a SuccessFactors currency box gets the saved salary as a number", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, answers: [{ question: "What are your salary expectations?", answer: "$100,000/year" }] } });
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Apply</title><main id="rmkContent"><label>First name <input name="first"></label>
        <div class="RCMFormField rcmFormElement"><label for="1065:_txtFld" class="rcmFormFieldLabel">Wage Or Salary Required</label><div class="fieldComponentInput"><div class="sfTextFieldCss"><input data-testid="sfTextField" name="wage" id="1065:_txtFld" class="fd-input" type="currency" maxlength="1024"></div></div></div>
      </main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture&career_job_req_id=42826`);
  await enqueue([page]);
  await expect(page.locator('input[name="first"]')).toHaveValue(profile.firstName, { timeout: 60000 });
  await expect(page.locator('input[name="wage"]')).toHaveValue("100000", { timeout: 30000 });
});

// L3Harris's SuccessFactors form, 2026-10-15 (reports 0234ca67, 202b470a):
// a cover letter left from an earlier day's attempt held the slot, which
// then offers only its trash button, so the letter tailored today was never
// attached. A letter dated before today is deleted, through the site's own
// "Are you sure" dialog, and replaced; one from today is kept.
for (const dated of ["older", "today"] as const)
  test(`a SuccessFactors cover letter slot holding a letter from ${dated === "older" ? "an earlier day is replaced" : "today is kept"}`, async () => {
    await context.route(`${sapsfOrigin}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>Apply</title><main id="rmkContent"><p>Please attach a cover letter.</p>
          <div class="RCMFormField rcmFormElement attachmentField"><label id="677:" class="rcmFormFieldLabel">Cover Letter</label>
            <div class="attachmentComponentInput" id="676:_fieldComponentInput">
              <div id="682:_attachWrapper" class="attachWrapper"><div id="682:_attach" class="successBtn" style="display:inline-block;">
                <div role="button" class="attachmentLabel attachmentText"><span>Old_Cover_Letter.pdf</span><span id="682:_lastModifiedDate" class="attachmentLastModified"></span></div>
                <div class="attachActions"><span tabindex="0" role="button" id="682:_attachIcon" class="glyphicon glyphicon-trash removeAttachments"></span></div></div></div>
            </div></div>
          <label>First name <input name="first"></label>
        </main><script>
          const day = new Date(Date.now() - (${dated === "older" ? 2 : 0}) * 86400000);
          const pad = (n) => String(n).padStart(2, "0");
          document.getElementById("682:_lastModifiedDate").textContent = "(" + pad(day.getMonth() + 1) + "/" + pad(day.getDate()) + "/" + day.getFullYear() + ")";
          window.uploaded = [];
          window.deleted = 0;
          document.getElementById("682:_attachIcon").addEventListener("click", () => setTimeout(() => {
            const dialog = document.createElement("div");
            dialog.setAttribute("role", "dialog");
            dialog.className = "dialogBoxWrapper fd-dialog";
            dialog.innerHTML = '<span>Press the ESC key to close the dialog.</span><h1>Confirm</h1><p>Are you sure you want to delete this document?</p><button type="button" name="Cancel">Cancel</button><button type="button" name="OK">OK</button>';
            document.body.append(dialog);
            dialog.querySelector('[name="OK"]').addEventListener("click", () => {
              dialog.remove();
              setTimeout(() => {
                window.deleted++;
                document.getElementById("682:_attach").style.display = "none";
                document.getElementById("682:_attachIcon").style.display = "none";
                const empty = document.createElement("div");
                empty.className = "attachWrapper";
                empty.innerHTML = '<div class="attachmentBtn"><div class="attachmentLabel attachmentText"><span>Attach a Cover Letter</span></div><div class="attachActions"><span tabindex="0" role="button" id="1310:_attachIcon" class="glyphicon glyphicon-plus-sign addAttachments"></span></div></div>';
                document.getElementById("676:_fieldComponentInput").append(empty);
                empty.querySelector(".addAttachments").addEventListener("click", () => setTimeout(() => {
                  const panel = document.createElement("div");
                  panel.innerHTML = '<input type="file" name="fileData"><button type="button" title="Upload">Upload</button>';
                  document.body.append(panel);
                  panel.querySelector("button").addEventListener("click", () => { window.uploaded.push(panel.querySelector("input").files[0]?.name || ""); panel.remove(); });
                }, 200));
              }, 400);
            });
          }, 300));
        </script>`,
      }),
    );
    const page = await context.newPage();
    await page.goto(`${sapsfOrigin}/portalcareer?company=fixture&career_job_req_id=42826`);
    await enqueue([page]);
    await expect(page.locator('input[name="first"]')).toHaveValue(profile.firstName, { timeout: 60000 });
    if (dated === "older") {
      await expect.poll(() => page.evaluate(() => (window as any).uploaded), { timeout: 60000 }).toEqual([expect.stringMatching(/cover.*\.pdf$/i)]);
      expect(await page.evaluate(() => (window as any).deleted)).toBe(1);
    } else {
      await page.waitForTimeout(3000);
      expect(await page.evaluate(() => [(window as any).deleted, (window as any).uploaded])).toEqual([0, []]);
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
      // Kept, it is no failed upload: the slot offers no add button then, and
      // looking for one reported "Cover letter upload did not finish"
      // (L3Harris, 2026-11-07).
      await expect.poll(async () => JSON.stringify((await state()).applications.at(-1)), { timeout: 30000 }).toMatch(/"status":"(awaiting-user|ready)"/);
      expect(JSON.stringify((await state()).applications.at(-1))).not.toMatch(/upload did not finish/i);
    }
  });

// Westinghouse's SuccessFactors (report d57dca7e, 2026-10-28): the account
// kept a resume from an earlier application ("Last Modified: 05/27/2025"),
// and the slot then offers only its trash button, so the resume tailored for
// this job was never attached. As with a cover letter, it is replaced.
test("a SuccessFactors resume slot holding a resume from an earlier day is replaced", async () => {
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Apply</title><main id="rmkContent">
        <div class="RCMFormField rcmFormElement attachmentField"><label id="38:" class="rcmFormFieldLabel">Resume</label>
          <div class="attachmentComponentInput" id="37:_fieldComponentInput">
            <div id="51:_attachWrapper" class="attachWrapper"><div id="51:_attach" class="successBtn" style="display:inline-block;">
              <div role="button" id="51:_attachDownloadLabel" class="attachmentLabel attachmentText"><span>Old_Resume.pdf</span><span id="51:_lastModifiedDate" class="attachmentLastModified">(05/27/2025)</span></div>
              <div class="attachActions"><span tabindex="0" role="button" id="51:_attachIcon" class="glyphicon glyphicon-trash removeAttachments"></span></div></div></div>
          </div></div>
        <label>First name <input name="first"></label>
      </main><script>
        window.uploaded = [];
        window.deleted = 0;
        document.getElementById("51:_attachIcon").addEventListener("click", () => setTimeout(() => {
          const dialog = document.createElement("div");
          dialog.setAttribute("role", "dialog");
          dialog.className = "dialogBoxWrapper fd-dialog";
          dialog.innerHTML = '<h1>Confirm</h1><p>Are you sure you want to delete this document?</p><button type="button" name="Cancel">Cancel</button><button type="button" name="OK">OK</button>';
          document.body.append(dialog);
          dialog.querySelector('[name="OK"]').addEventListener("click", () => {
            dialog.remove();
            setTimeout(() => {
              window.deleted++;
              document.getElementById("51:_attach").remove();
              const empty = document.createElement("div");
              empty.className = "attachWrapper";
              empty.innerHTML = '<div class="attachmentBtn"><div class="attachmentLabel attachmentText"><span>Upload a Resume</span></div><div class="attachActions"><span tabindex="0" role="button" id="1310:_attachIcon" class="glyphicon glyphicon-plus-sign addAttachments"></span></div></div>';
              document.getElementById("37:_fieldComponentInput").append(empty);
              empty.querySelector(".addAttachments").addEventListener("click", () => setTimeout(() => {
                const panel = document.createElement("div");
                panel.innerHTML = '<input type="file" name="fileData"><button type="button" title="Upload">Upload</button>';
                document.body.append(panel);
                panel.querySelector("button").addEventListener("click", () => { window.uploaded.push(panel.querySelector("input").files[0]?.name || ""); panel.remove(); });
              }, 200));
            }, 400);
          });
        }, 300));
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture&career_job_req_id=42826`);
  await enqueue([page]);
  await expect(page.locator('input[name="first"]')).toHaveValue(profile.firstName, { timeout: 60000 });
  await expect.poll(() => page.evaluate(() => (window as any).uploaded), { timeout: 60000 }).toEqual([expect.stringMatching(/resume.*\.pdf$/i)]);
  expect(await page.evaluate(() => (window as any).deleted)).toBe(1);
});

// Tesla's posting (2026-11-02): tracked before its script drew the job, so
// nothing of it was read, and the backend is refused the page. Its Apply
// opens the form in a new tab, and the form was filled with no posting. The
// posting's tab, still open, is read again before drafting.
test("a posting drawn after it was tracked is read again from its tab when its form opens in another", async () => {
  const job = `${origin}/scripted-posting/287982`;
  const tabId = (page: Page) => panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  await context.route(`${origin}/scripted-posting/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: route.request().url().includes("/apply/")
        ? `<!doctype html><title>Internship, Data Engineer Application</title><form onsubmit="return false"><label>Email<input name="email" type="email"></label><label>Phone<input name="phone"></label><button type="submit">Submit</button></form>`
        : `<!doctype html><title>Careers</title><nav><a href="#main">Skip to main content</a></nav><main id="main"></main>
           <script>window.draw = () => { document.getElementById("main").innerHTML = '<h1>Internship, Data Engineer, Energy</h1><p>' + "The Energy data team builds the pipelines that forecast battery storage dispatch across the grid. ".repeat(8) + '</p><a id="apply" href="/scripted-posting/apply/287982" target="_blank">Apply</a>'; };</script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(job);
  await panel.bringToFront();
  await ui({ type: "TRACK_TAB", tabId: await tabId(page) });
  let app = (await state()).applications.find((a: { sourceUrl: string }) => a.sourceUrl === job)!;
  expect(app.sourceDescription || "").not.toContain("battery storage");
  await page.evaluate(() => (window as any).draw());
  const [form] = await Promise.all([context.waitForEvent("page"), page.click("#apply")]);
  await form.waitForLoadState();
  await panel.bringToFront();
  await ui({ type: "ATTACH_TAB", id: app.id, tabId: await tabId(form) });
  await ui({ type: "FILL_STEP", id: app.id });
  await expect(form.locator('[name="email"]')).toHaveValue(profile.email, { timeout: 45000 });
  // Read before drafting, which may start after the profile's own answers.
  await expect.poll(async () => (await state()).applications.find((a: { id: string }) => a.id === app.id)!.sourceDescription || "", { timeout: 20000 }).toContain("forecast battery storage dispatch");
  app = (await state()).applications.find((a: { id: string }) => a.id === app.id)!;
  expect(app.postingUrl).toBe(job);
});

// Tesla's again (2026-11-02): tracked from its form, its posting's link
// pasted, the job page not open. The backend is refused the page, so the fit
// had nothing to go on: the link is read in a tab out of view, then closed.
test("a posting link the backend cannot read is read in a tab of its own for the fit", async () => {
  // Drawn by its script a while after it loads, as Tesla's is.
  const job = `${origin}/scripted-job/287982`;
  // Served by the fixture server: the tab the extension opens to read it is
  // not one a Playwright route reaches.
  fixturePages.set("/scripted-job/apply/287982", `<!doctype html><title>Internship Application</title><form onsubmit="return false"><label>Email<input name="email" type="email"></label><button type="submit">Submit</button></form>`);
  fixturePages.set("/scripted-job/287982", `<!doctype html><title>Careers</title><main id="main"><a id="apply" href="/scripted-job/apply/287982" target="_blank">Apply</a></main>
    <script>setTimeout(() => { document.getElementById("main").insertAdjacentHTML("beforeend", '<h1>Internship, Data Engineer, Energy</h1><p>' + "The Energy data team builds the pipelines that forecast battery storage dispatch across the grid. ".repeat(8) + '</p>'); }, 3000);</script>`);
  // Tracked from its posting before the posting was drawn, then filled in
  // the form its Apply opened.
  const posting = await context.newPage();
  await posting.goto(job);
  await panel.bringToFront();
  const tabOf = (page: Page) => panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  await ui({ type: "TRACK_TAB", tabId: await tabOf(posting) });
  let app = (await state()).applications.find((a: { sourceUrl: string }) => a.sourceUrl === job)!;
  expect(app.sourceDescription || "").not.toContain("battery storage");
  const [form] = await Promise.all([context.waitForEvent("page"), posting.click("#apply")]);
  await form.waitForLoadState();
  await panel.bringToFront();
  await ui({ type: "ATTACH_TAB", id: app.id, tabId: await tabOf(form) });
  // The job page closed, as after Apply opened the form.
  await posting.close();
  await expect.poll(async () => (await state()).applications.find((a: { id: string }) => a.id === app.id)!.fitJobId ?? "none", { timeout: 30000 }).toBe("none");
  await ui({ type: "CHECK_FIT", id: app.id });
  await expect.poll(async () => (await state()).applications.find((a: { id: string }) => a.id === app.id)!.sourceDescription || "", { timeout: 30000 }).toContain("forecast battery storage dispatch");
  // The tab it was read in is gone again.
  expect(await panel.evaluate(async (url) => (await chrome.tabs.query({})).some((tab) => tab.url === url), job)).toBe(false);
});

// SmartRecruiters' screening questions (Syngenta, report f3db7e7f,
// 2026-11-02): each question is page text slotted into a web component's
// label, and each choice is named only by its own label attribute. Read as
// slots, the questions were their element ids or "Unlabelled field".
test("a web component's slotted question and its choices' label attributes name its fields", async () => {
  await context.route(`${origin}/slotted-questions`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Screening questions</title><form id="form" onsubmit="return false">
        <spl-radio-group id="spl-form-element_90" required><span slot="label-content">Are you over the age of 18 years?<br><br>¿Es usted mayor de 18 años?</span>
          <spl-radio id="spl-form-element_91" label="Yes" role="radio" aria-checked="false" value="1" tabindex="0"></spl-radio>
          <spl-radio id="spl-form-element_92" label="No" role="radio" aria-checked="false" value="0" tabindex="-1"></spl-radio>
        </spl-radio-group>
        <spl-textfield id="salary"><span slot="label-content">Salary Expectations (gross salary)</span></spl-textfield>
        </form>
        <script>
          customElements.define("spl-radio-group", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML =
            '<label id="group-label"><span><slot name="label-content"></slot><span aria-hidden="true">*</span></span></label><fieldset role="radiogroup" aria-labelledby="group-label" aria-required="true"><slot></slot></fieldset>'; } });
          customElements.define("spl-radio", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<label><span>' + this.getAttribute("label") + '</span></label>'; } });
          customElements.define("spl-textfield", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML =
            '<label for="salary-input"><slot name="label-content"></slot></label><div><input id="salary-input" type="text"></div>'; } });
        </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/slotted-questions`);
  await panel.bringToFront();
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  const fields = (await ui({ type: "SCAN_TAB", tabId })).observation.fields as { label: string; kind: string }[];
  const labels = fields.map((field) => field.label);
  expect(labels.filter((label) => /over the age of 18/.test(label)).length).toBeGreaterThan(0);
  expect(labels).toContain("Salary Expectations (gross salary)");
  expect(labels.join(" ")).not.toMatch(/spl-form-element|Unlabelled field/);
});

// SmartRecruiters (report a8c856cd, 2026-11-05): an education entry left
// open has a Major and a Degree that name no school; the general fill wrote
// one school's into another's. The site rule fills its entries; the general
// fill leaves them.
test("a SmartRecruiters entry editor's fields are left to its site rule", async () => {
  await context.route(`${origin}/entry-editor`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form onsubmit="return false">
        <label for="email">Email</label><input id="email" type="email">
        <oc-education-entry data-test="experience-entry"><div data-test="education-edit-form">
          <label for="major">Major</label><input id="major">
          <label for="degree">Degree</label><input id="degree">
        </div></oc-education-entry></form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/entry-editor`);
  await panel.bringToFront();
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  const fields = (await ui({ type: "SCAN_TAB", tabId })).observation.fields as { label: string; protected: boolean }[];
  expect(fields.find((field) => field.label === "Email")?.protected).toBe(false);
  expect(fields.filter((field) => /^(Major|Degree)$/.test(field.label)).map((field) => field.protected)).toEqual([true, true]);
});

// Tesla's legal step (report 64249b85, 2026-11-02): its Yes/No questions
// share one fieldset, each <label for="<id>"> over radios "<id>_yes" and
// "<id>_no". Every radio read as the fieldset's first label, and one answer
// given locked every "Yes" on the step.
test("Yes/No questions sharing a fieldset are read by their own labels, and one answer locks only its own", async () => {
  const question = (id: string, text: string) =>
    `<div><label for="${id}">${text}</label><div>${["yes", "no"].map((value) => `<div><input id="${id}_${value}" type="radio" name="legal.${id}"><div><label for="${id}_${value}">${value === "yes" ? "Yes" : "No"}</label></div></div>`).join("")}</div></div>`;
  await context.route(`${origin}/shared-fieldset`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Job Application</title><form onsubmit="return false"><fieldset>
        <div><label aria-live="polite">November 2026</label></div>
        ${question("q1", "I authorize Tesla to consider me for other job opportunities for the next 36 months.")}
        ${question("q2", "Will you now or in the future require immigration sponsorship for employment with Tesla?")}
        ${question("q3", "Have you previously been employed by Tesla?")}
      </fieldset></form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/shared-fieldset`);
  // The applicant answers the last one themselves.
  await page.click("#q3_no");
  await panel.bringToFront();
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  const fields = (await ui({ type: "SCAN_TAB", tabId })).observation.fields as { id: string; label: string; protected: boolean }[];
  const radios = (prefix: string) => fields.filter((field) => field.label.startsWith(prefix));
  expect(radios("I authorize Tesla").length).toBe(1);
  expect(radios("Will you now or in the future require immigration sponsorship").length).toBe(1);
  expect(radios("Have you previously been employed by Tesla").length).toBe(1);
  expect(fields.some((field) => field.label === "November 2026")).toBe(false);
  // The applicant's answer holds its own question, not every Yes.
  expect(radios("Will you now").every((field) => !field.protected)).toBe(true);
});

// TSC's Workday (report e48a61a1, 2026-11-02): a questionnaire date's
// Month, Day and Year are named only so; the question is the field's legend.
test("a Workday questionnaire date's parts carry their question", async () => {
  await context.route(`${atsOrigins[0]}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application Questions</title><main><div data-automation-id="formField-10bc"><fieldset><legend><div data-automation-id="richText"><p><span>What is your first available start date?</span></p></div></legend>
        <div role="group" data-automation-id="dateInputWrapper">${["Month", "Day", "Year"].map((part) => `<div><input role="spinbutton" aria-label="${part}" data-automation-id="dateSection${part}-input"></div>`).join("/")}</div></fieldset></div></main>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/Remote/Engineer_JR1/apply/applyManually`);
  await panel.bringToFront();
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  const labels = ((await ui({ type: "SCAN_TAB", tabId })).observation.fields as { label: string }[]).map((field) => field.label);
  expect(labels).toEqual(["What is your first available start date?: Month", "What is your first available start date?: Day", "What is your first available start date?: Year"]);
});

// NGC's Workday (report cfbf90ad, 2026-11-02): Phone Device Type had no
// exact option for "Mobile", and the list opened for it stayed over the form.
test("a Workday list opened for an answer it does not hold is closed again", async () => {
  await context.route(`${atsOrigins[0]}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>My Information</title><div data-automation-id="mainContent"><main>
        <div data-automation-id="formField-deviceKind"><label for="pdt">Phone Device Type</label>
          <button type="button" id="pdt" aria-haspopup="listbox" aria-expanded="false">Select One</button></div>
      </main></div><script>
        const button = document.getElementById("pdt");
        button.addEventListener("click", () => {
          if (document.getElementById("popup")) return;
          button.setAttribute("aria-expanded", "true");
          const popup = document.createElement("div");
          popup.id = "popup";
          popup.setAttribute("data-automation-activepopup", "true");
          popup.innerHTML = '<ul role="listbox"><li role="option">Select One</li><li role="option">Business Phone</li><li role="option">Fax</li></ul>';
          document.body.append(popup);
        });
        document.querySelector('[data-automation-id="mainContent"]').addEventListener("click", (event) => {
          if (event.target === button) return;
          document.getElementById("popup")?.remove();
          button.setAttribute("aria-expanded", "false");
        });
      </script>`,
    }),
  );
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, phoneDeviceType: "Mobile" } });
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/Remote/Engineer_JR1/apply/applyManually`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 45000 }).toMatch(/awaiting-user|ready/);
  await expect(page.locator("#popup")).toHaveCount(0, { timeout: 15000 });
});

// DraftKings' Workday (report c875e6c5, 2026-11-02): a questionnaire date
// keeps only what is typed, and its Month and Day read back empty; its school
// list says to pick "Other" when the school is not listed.
test("a Workday questionnaire date is typed, and Other is picked where the question says to", async () => {
  await context.route(`${atsOrigins[0]}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application Questions</title><div data-automation-id="mainContent"><main>
        <div data-automation-id="formField-grad"><fieldset><legend><div data-automation-id="richText"><p><span>What is your projected/approximate graduation date?</span></p></div></legend>
          <div role="group" data-automation-id="dateInputWrapper">${["Month", "Day", "Year"].map((part) => `<div><input role="spinbutton" aria-label="${part}" data-automation-id="dateSection${part}-input"></div>`).join("/")}</div></fieldset></div>
        <div data-automation-id="formField-school"><label for="school">What is your school? (Select "Other" if it is not in list)</label>
          <button type="button" id="school" aria-haspopup="listbox" aria-expanded="false">Select One</button></div>
      </main></div><script>
        // Only typed keys stick: a value set from script is taken back.
        for (const input of document.querySelectorAll('[role="spinbutton"]')) {
          let typed = false;
          input.addEventListener("keydown", (event) => { typed = event.isTrusted; });
          input.addEventListener("input", () => { if (!typed) input.value = ""; typed = false; });
        }
        const button = document.getElementById("school");
        button.addEventListener("click", () => {
          if (document.getElementById("popup")) return;
          button.setAttribute("aria-expanded", "true");
          const popup = document.createElement("div");
          popup.id = "popup";
          popup.setAttribute("data-automation-activepopup", "true");
          popup.innerHTML = '<ul role="listbox">' + ["Select One", "Boston University", "Other"].map((name) => '<li role="option">' + name + '</li>').join("") + '</ul>';
          popup.querySelectorAll("li").forEach((option) => option.addEventListener("click", () => { button.textContent = option.textContent; button.setAttribute("aria-expanded", "false"); popup.remove(); }));
          document.body.append(popup);
        });
      </script>`,
    }),
  );
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, education: [{ organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-12-13", location: "East Lansing, Michigan" }] } });
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/Remote/Engineer_JR1/apply/applyManually`);
  await enqueue([page]);
  await expect(page.locator('[aria-label="Year"]')).toHaveValue("2099", { timeout: 60000 });
  await expect(page.locator('[aria-label="Month"]')).toHaveValue(/^0?12$/);
  // The school as an AI suggestion gives it (the profile's rules ask no
  // questionnaire for it): the list lacks it, and the question says "Other".
  const app = (await state()).applications[0];
  const inspected = (await content(page, { type: "INSPECT" })).data;
  const school = inspected.fields.find((field: { label: string }) => /What is your school/.test(field.label));
  const result = await content(page, {
    type: "APPLY",
    applicationId: app.id,
    operation: app.operation,
    documentId: inspected.documentId,
    proposals: [{ fieldId: school.id, revision: school.revision, expectedValue: school.value, value: "Michigan State University", source: "fixture" }],
  });
  expect(result.data.results?.[0]?.ok ?? result.data[0]?.ok).toBe(true);
  await expect(page.locator("#school")).toHaveText("Other");
});

// Leidos's Workday (2026-11-08): typing a date's Month moves focus to its
// Day, as Workday does, and the Day was then refused as a field in use; the
// date was left half typed and Workday made its year 2005. A Backspace
// empties a whole part, and a second one, in the emptied part, sent focus
// back to the Day before the year was typed.
test("a Workday date whose Month moves focus to its Day gets all three parts", async () => {
  await context.route(`${atsOrigins[0]}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application Questions</title><div data-automation-id="mainContent"><main>
        <div data-automation-id="formField-completion"><fieldset><legend><div data-automation-id="richText"><p><span>5a. Expected degree completion date.</span></p></div></legend>
          <div role="group" data-automation-id="dateInputWrapper">${["Month", "Day", "Year"].map((part) => `<div><input role="spinbutton" aria-label="${part}" data-automation-id="dateSection${part}-input"></div>`).join("/")}</div></fieldset></div>
      </main></div><script>{
        const parts = [...document.querySelectorAll('[role="spinbutton"]')];
        // As the live form held it: a year Workday filled in by itself.
        parts[2].value = "2005";
        parts.forEach((input, index) => {
          let typed = false;
          input.addEventListener("keydown", (event) => {
            typed = event.isTrusted;
            // A Backspace empties the whole part; in an empty part it moves
            // focus back to the one before.
            if (event.key === "Backspace") {
              event.preventDefault();
              if (input.value) input.value = "";
              else if (index > 0) parts[index - 1].focus();
            }
          });
          input.addEventListener("input", () => {
            if (!typed) { input.value = ""; return; }
            typed = false;
            // A full Month or Day moves on to the next part.
            if (index < 2 && input.value.length >= 2) parts[index + 1].focus();
          });
        });
      }</script>`,
    }),
  );
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, education: [{ organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05-10", location: "East Lansing, Michigan" }] } });
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/Remote/Engineer_JR2/apply/applyManually`);
  await enqueue([page]);
  await expect(page.locator('[aria-label="Year"]')).toHaveValue("2099", { timeout: 60000 });
  await expect(page.locator('[aria-label="Month"]')).toHaveValue(/^0?5$/);
  await expect(page.locator('[aria-label="Day"]')).toHaveValue("10");
  // Each part typed is the fill's own, none locked as the applicant's edit.
  await page.waitForTimeout(1500);
  const parts = (await content(page, { type: "INSPECT" })).data.fields.filter((field: { label: string }) => /completion date/.test(field.label));
  expect(parts.map((field: { protected: boolean }) => field.protected)).toEqual([false, false, false]);
});

// Tesla's (report d207d4aa, 2026-11-02): "When are you available to start
// an internship?" is a read-only box filled from its calendar. The applicant
// can start immediately: today is picked there.
test("Tesla's start date is picked from its calendar as today", async () => {
  await context.route(`${teslaOrigin}/careers/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Internship Application</title><form class="job-application-form" onsubmit="return false"><label>Email<input name="personal.email" type="email"></label><fieldset><div variant="date">
        <label for="start">When are you available to start an internship?</label>
        <div><input id="start" name="job.jobAvailabilityToStartInternship" readonly required placeholder="Pick a date">
          <div><button type="button" id="open">Calendar</button></div>
          <div role="tooltip" hidden id="calendar"><div aria-label="Use arrow keys to increment the date"></div></div></div>
      </div></fieldset></form><script>
        const now = new Date();
        const grid = document.querySelector('[aria-label="Use arrow keys to increment the date"]');
        for (let day = 1; day <= 31; day++) {
          const button = document.createElement("button");
          button.type = "button";
          button.innerHTML = "<span>" + day + "</span>";
          button.addEventListener("click", () => { document.getElementById("start").value = now.toLocaleString("en-US", { month: "long" }) + " " + day + ", " + now.getFullYear(); });
          grid.append(button);
        }
        document.getElementById("open").addEventListener("click", () => { document.getElementById("calendar").hidden = false; });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${teslaOrigin}/careers/search/job/apply/287982`);
  await enqueue([page]);
  const today = new Date();
  await expect(page.locator("#start")).toHaveValue(`${today.toLocaleString("en-US", { month: "long" })} ${today.getDate()}, ${today.getFullYear()}`, { timeout: 45000 });
  // Read as a question, so an empty one would be listed as needing you.
  await panel.bringToFront();
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  const fields = (await ui({ type: "SCAN_TAB", tabId })).observation.fields as { label: string; kind: string }[];
  expect(fields.find((field) => field.label === "When are you available to start an internship?")?.kind).toBe("datepicker");
});

// Reports from L3Harris's, Space Tango's and Jabil's forms, 2026-10-14: an
// application form tracked on its own read no posting, so nothing was
// tailored. The page that led to it is the posting: the tab that opened it,
// or the page the browser says it came from.
test("a form tracked on its own takes the page that led to it as its posting", async () => {
  const posting = `${atsOrigins[2]}/acme/11111111-1111-4111-8111-111111111111`;
  await context.route(`${atsOrigins[2]}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: route.request().url().includes("/apply")
        ? `<!doctype html><title>Apply - Acme</title><form><label>Full name <input name="name"></label></form>`
        : `<!doctype html><title>Engineer - Acme</title><main><h1>Engineer</h1><p>Acme builds rocket telemetry pipelines and needs engineers who write careful Go services.</p>
           <a id="new" href="${new URL(route.request().url()).pathname}/apply" target="_blank">Apply in a new tab</a>
           <a id="same" href="${new URL(route.request().url()).pathname}/apply?same=1">Apply here</a></main>`,
    }),
  );
  const tabOf = (url: string) => panel.evaluate(async (wanted) => (await chrome.tabs.query({})).find((tab) => tab.url === wanted)!.id!, url);
  const page = await context.newPage();
  await page.goto(posting);
  // Opened in a new tab: the posting's address, and its words.
  const [form] = await Promise.all([context.waitForEvent("page"), page.click("#new")]);
  await form.waitForLoadState();
  await ui({ type: "TRACK_TAB", tabId: await tabOf(form.url()) });
  let app = (await state()).applications.find((a: { url: string }) => a.url.includes("/apply"))!;
  expect(app.postingUrl).toBe(posting);
  expect(app.sourceDescription).toContain("rocket telemetry pipelines");
  // Reached in the same tab: the address the browser says it came from.
  await page.click("#same");
  await page.waitForURL(/same=1/);
  await ui({ type: "TRACK_TAB", tabId: await tabOf(page.url()) });
  app = (await state()).applications.find((a: { url: string }) => a.url.includes("same=1"))!;
  expect(app.postingUrl).toBe(posting);
  // From another site in the same tab (L3Harris's posting, its form on
  // ns2cloud.com): the referrer names only that site; the tab's own pages
  // name the posting.
  const elsewhere = `${atsOrigins[1]}/acme/jobs/4242424242`;
  await context.route(`${atsOrigins[1]}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: { "Referrer-Policy": "strict-origin-when-cross-origin" },
      body: `<!doctype html><title>Analyst - Acme</title><main><h1>Analyst</h1><a id="cross" href="${posting}/apply?cross=1">Apply</a></main>`,
    }),
  );
  const other = await context.newPage();
  await other.goto(elsewhere);
  await other.click("#cross");
  await other.waitForURL(/cross=1/);
  await ui({ type: "TRACK_TAB", tabId: await tabOf(other.url()) });
  app = (await state()).applications.find((a: { url: string }) => a.url.includes("cross=1"))!;
  expect(app.postingUrl).toBe(elsewhere);
  // A list of jobs opened the posting in a tab of its own, and the form was
  // reached from the posting in that tab (Simplify's list on GitHub, then
  // Oracle's posting and its form, 2026-10-24): the list opened the
  // posting's tab, not the form.
  await context.route(`${atsOrigins[1]}/lists/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Summer internships</title><main><a id="open" href="${listed}" target="_blank">Acme Engineer</a></main>` }),
  );
  const listed = `${atsOrigins[2]}/acme/22222222-2222-4222-8222-222222222222`;
  const list = await context.newPage();
  await list.goto(`${atsOrigins[1]}/lists/internships`);
  const [opened] = await Promise.all([context.waitForEvent("page"), list.click("#open")]);
  await opened.waitForLoadState();
  await opened.click("#same");
  await opened.waitForURL(/same=1/);
  await ui({ type: "TRACK_TAB", tabId: await tabOf(opened.url()) });
  app = (await state()).applications.find((a: { url: string }) => a.url.includes("22222222") && a.url.includes("same=1"))!;
  expect(app.postingUrl).toBe(listed);
  // Tracked on the posting the list opened, before its form (Amazon's,
  // 2026-10-25): the posting is its own, not the list.
  const listedPosting = `${atsOrigins[2]}/acme/33333333-3333-4333-8333-333333333333`;
  await context.route(listedPosting, (route) =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Software Engineer Intern - Acme</title>
      <header><form action="/en/search" method="get"><input name="base_query" role="combobox" aria-label="Search for jobs by title or keyword"><input name="loc_query" role="combobox" aria-label="search job by location"></form>
      <div role="combobox" aria-haspopup="menu" aria-label="English" tabindex="0">English</div></header><main><h1>Software Engineer Intern</h1>
      <p>Acme builds rocket telemetry pipelines. As an intern you will write careful Go services, review designs with senior engineers, and ship features to production.
      You are pursuing a degree in computer science or a related field, graduating between December 2027 and June 2028, and have built projects with at least one programming language.</p>
      <a href="${listedPosting}/apply">Apply now</a></main>` }),
  );
  await list.evaluate((url) => { document.querySelector<HTMLAnchorElement>("#open")!.href = url; }, listedPosting);
  const [read] = await Promise.all([context.waitForEvent("page"), list.click("#open")]);
  await read.waitForLoadState();
  await ui({ type: "TRACK_TAB", tabId: await tabOf(read.url()) });
  app = (await state()).applications.find((a: { url: string }) => a.url === listedPosting)!;
  // Its header's job search and language menu are not a form.
  expect(app.note).toBe("Tracked. Open the application form when you are ready.");
  expect(app.postingUrl).toBe(listedPosting);
});

// Amazon's posting (2026-10-31): Fill this step on a posting with no form
// stopped there, and the applicant pressed Apply and filled again. The
// posting's own Apply is used once, in the same tab, and the fill goes on in
// the form; an Apply through another site is never pressed.
test("Fill this step on a posting uses its Apply and fills the form it opens", async () => {
  const description = "<p>Acme builds rocket telemetry pipelines. As an intern you will write careful Go services, review designs with senior engineers, and ship features to production. You are pursuing a degree in computer science or a related field and have built projects with at least one programming language.</p>";
  const header = `<header><form action="/en/search" method="get"><input name="base_query" role="combobox" aria-label="Search for jobs by title or keyword"></form></header>`;
  await context.route(`${talNetOrigin}/posting/**`, (route) => {
    const url = route.request().url();
    route.fulfill({
      contentType: "text/html",
      body: url.endsWith("/apply")
        ? `<!doctype html><title>Apply - Acme</title><main><h1>Application</h1><form><label for="first">First name</label><input id="first" required>
            <label for="email">Email</label><input id="email" type="email" required><button type="submit">Submit application</button></form></main>`
        : url.includes("elsewhere")
          ? `<!doctype html><title>Engineer Intern - Acme</title>${header}<main><h1>Engineer Intern</h1>${description}<a href="https://www.linkedin.com/jobs/apply">Apply with LinkedIn</a></main>`
          : `<!doctype html><title>Engineer Intern - Acme</title>${header}<main><h1>Engineer Intern</h1>${description}
              <a href="https://www.linkedin.com/jobs/apply">Apply with LinkedIn</a><a href="/posting/1/apply" target="_blank">Apply now</a></main>`,
    });
  });
  const posting = `${talNetOrigin}/posting/1`;
  const page = await context.newPage();
  await page.goto(posting);
  await panel.bringToFront();
  await enqueue([page]);
  // The same tab goes to the form, and the same request fills it.
  await expect(page.locator("#first")).toHaveValue(profile.firstName, { timeout: 45000 });
  await expect(page.locator("#email")).toHaveValue(profile.email);
  expect(context.pages().filter((other) => other.url().includes("/posting/1/apply"))).toHaveLength(1);
  const app = (await state()).applications.find((candidate: { url: string }) => candidate.url.includes("/posting/1"))!;
  expect(app.url).toBe(`${posting}/apply`);
  expect(app.postingUrl).toBe(posting);
  // Only another site's Apply: nothing is pressed, and the card says what to do.
  const other = await context.newPage();
  await other.goto(`${talNetOrigin}/posting/elsewhere`);
  await panel.bringToFront();
  await enqueue([other]);
  await expect.poll(async () => (await state()).applications.find((candidate: { url: string }) => candidate.url.includes("elsewhere"))?.note, { timeout: 30000 })
    .toBe("Open the application form or sign in, then choose Fill this step.");
  expect(other.url()).toBe(`${talNetOrigin}/posting/elsewhere`);
});

// WEC Energy Group's SuccessFactors application again (report 54daf500,
// 2026-10-15): the disability form (CC-305) asks "Please check one of the
// boxes below:" and names disability only in its heading, and its signing
// date is a date picker labelled "Date:". Both were left.
test("a SuccessFactors disability form answers its boxes question and dates itself", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, disabilityStatus: "I am not disabled" } });
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Career Opportunities: Apply for Analyst</title><main>
        <h3>Voluntary Self-Identification of Disability</h3>
        <div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel" for="dis"><span class="requiredField">*</span>&nbsp;Please check one of the boxes below:</label><div class="fieldComponentInput"><span class="sfCascadingPicklist"><input id="dis" role="combobox" aria-label="Please check one of the boxes below:" aria-expanded="false" aria-owns="80:_listSelect" placeholder="No Selection" class="rcmpaginatedselectinput"></span></div></div>
        <div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel">Date:</label><div class="fieldComponentInput"><div class="datePicker"><ui5-date-picker-xweb-calendar-widget accessible-name="Date:" title="Date:"></ui5-date-picker-xweb-calendar-widget></div></div></div>
      </main><script>
        customElements.define('ui5-datetime-input-xweb-calendar-widget', class extends HTMLElement {
          constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<input class="ui5-input-inner" type="text">'; }
        });
        customElements.define('ui5-date-picker-xweb-calendar-widget', class extends HTMLElement {
          constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<ui5-datetime-input-xweb-calendar-widget></ui5-datetime-input-xweb-calendar-widget>'; this._value = ''; }
          get value() { return this._value; }
          set value(v) { this._value = v; this.setAttribute('value', v); }
        });
        const dis = document.getElementById('dis');
        dis.addEventListener('click', () => {
          if (document.getElementById('80:_listSelect')) return;
          dis.setAttribute('aria-expanded', 'true');
          setTimeout(() => {
            // As on L3Harris's page: a click with no focus marks it open
            // and loads nothing.
            if (document.activeElement !== dis) return;
            const list = document.createElement('ul');
            list.id = '80:_listSelect';
            list.className = 'sf-list-select';
            list.setAttribute('role', 'listbox');
            for (const name of ['No Selection', 'Yes, I have a disability (or previously had a disability)', 'No, I do not have a disability and have not had one in the past', 'I do not want to answer']) {
              const item = document.createElement('li');
              item.setAttribute('role', 'option');
              item.innerHTML = '<a role="menuitem" title="' + name + '">' + name + '</a>';
              item.querySelector('a').addEventListener('click', () => { dis.value = name; list.remove(); dis.setAttribute('aria-expanded', 'false'); });
              list.append(item);
            }
            document.body.append(list);
          }, 300);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture&career_ns=job_application`);
  await enqueue([page]);
  await expect(page.locator("#dis")).toHaveValue("No, I do not have a disability and have not had one in the past", { timeout: 60000 });
  const today = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  await expect(page.locator("ui5-date-picker-xweb-calendar-widget")).toHaveAttribute("value", `${two(today.getMonth() + 1)}/${two(today.getDate())}/${today.getFullYear()}`, { timeout: 30000 });
});

// A report on WEC Energy Group's SuccessFactors application, 2026-10-14:
// "What is your desired salary?" got the applicant's website, because a
// rule took any input near the words "Company Website" (an answer shown for
// "How did you hear about us?"); and every question no site rule knows
// ("Have you previously worked for…") timed out, its list never opened.
test("a SuccessFactors questions page picks from lists no rule knows, and keeps the website out of the salary", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, website: "https://example.dev", priorEmployment: "No" } });
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Career Opportunities: Apply for Analyst</title><main>
        <div class="rcmFormSection row"><h2 class="sectionTitle"><button class="topBar rcmFormSectionTopBar"><span>Job-Specific Information</span></button></h2>
          <div class="sectionContent">
            <div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel" for="salary">What is your desired salary?</label><div class="fieldComponentInput"><input type="text" id="salary" name="customDesiredSalary"></div></div>
            <div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel">How did you hear about us?</label><div class="fieldComponentInput"><span class="picked">Internet / Company Website</span></div></div>
            <div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel" for="prior">Have you previously worked for Acme or any of its subsidiaries?</label><div class="fieldComponentInput"><span class="sfCascadingPicklist"><input id="prior" role="combobox" aria-label="Have you previously worked for Acme or any of its subsidiaries?" aria-expanded="false" aria-owns="70:_listSelect" placeholder="No Selection" class="rcmpaginatedselectinput"></span></div></div>
            <div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel" for="other">Have you previously worked for Beta Corp?</label><div class="fieldComponentInput"><span class="sfCascadingPicklist"><input id="other" role="combobox" aria-label="Have you previously worked for Beta Corp?" aria-expanded="false" aria-owns="71:_listSelect" placeholder="No Selection" class="rcmpaginatedselectinput"></span></div></div>
          </div>
        </div>
      </main><script>
        // As on the reported page: a press does nothing, a click opens it,
        // and each option is a menu item link inside the option.
        const prior = document.getElementById('prior');
        prior.addEventListener('click', () => {
          if (document.getElementById('70:_listSelect')) return;
          prior.setAttribute('aria-expanded', 'true');
          setTimeout(() => {
            // As on L3Harris's page: a click with no focus marks it open
            // and loads nothing.
            if (document.activeElement !== prior) return;
            const list = document.createElement('ul');
            list.id = '70:_listSelect';
            list.className = 'sf-list-select';
            list.setAttribute('role', 'listbox');
            for (const name of ['No Selection', 'Yes', 'No']) {
              const item = document.createElement('li');
              item.setAttribute('role', 'option');
              item.innerHTML = '<a role="menuitem" title="' + name + '">' + name + '</a>';
              item.querySelector('a').addEventListener('click', () => {
                prior.value = name;
                list.remove();
                prior.setAttribute('aria-expanded', 'false');
                // As the Country list did (WEC, 2026-10-15): the page still
                // loading when the pick was made opens the list again.
                if (!window.reopened) setTimeout(() => { window.reopened = true; prior.setAttribute('aria-expanded', 'true'); document.body.append(list); }, 200);
              });
              list.append(item);
            }
            document.body.append(list);
          }, 300);
        });
        prior.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          document.getElementById('70:_listSelect')?.remove();
          prior.setAttribute('aria-expanded', 'false');
        });
        // A list without the answer ("No" is missing): left as it was, and
        // closed again (L3Harris's profile, 2026-10-15, lists stacked open).
        const other = document.getElementById('other');
        const otherList = () => {
          const list = document.createElement('ul');
          list.id = '71:_listSelect';
          list.className = 'sf-list-select';
          list.setAttribute('role', 'listbox');
          list.innerHTML = ['No Selection', 'Yes', 'Unsure'].map((name) => '<li role="option"><a role="menuitem" title="' + name + '">' + name + '</a></li>').join('');
          return list;
        };
        other.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          document.getElementById('71:_listSelect')?.remove();
          other.setAttribute('aria-expanded', 'false');
          // As on L3Harris's server: a page still on its way opens it again
          // after it was closed (report f5b57962).
          if (!window.otherLate) setTimeout(() => { window.otherLate = true; other.setAttribute('aria-expanded', 'true'); document.body.append(otherList()); }, 500);
        });
        other.addEventListener('click', () => {
          if (document.getElementById('71:_listSelect')) return;
          other.setAttribute('aria-expanded', 'true');
          setTimeout(() => {
            if (document.activeElement !== other) return;
            document.body.append(otherList());
          }, 300);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture&career_ns=job_application`);
  await enqueue([page]);
  await expect(page.locator("#prior")).toHaveValue("No", { timeout: 60000 });
  await expect.poll(() => page.evaluate(() => (window as any).reopened), { timeout: 10000 }).toBe(true);
  await expect(page.locator('[id="70:_listSelect"]')).toHaveCount(0, { timeout: 10000 });
  await expect(page.locator("#prior")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#prior")).toHaveValue("No");
  await expect.poll(() => page.evaluate(() => (window as any).otherLate), { timeout: 30000 }).toBe(true);
  await expect(page.locator("#other")).toHaveAttribute("aria-expanded", "false", { timeout: 30000 });
  await expect(page.locator('[id="71:_listSelect"]')).toHaveCount(0);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 60000 }).toMatch(/^(awaiting-user|ready)$/);
  await expect(page.locator("#salary")).toHaveValue("");
});

test("a profile exported from the profile page can be imported again, with its settings", async () => {
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, modelFill: "review", legalQuestions: "model" } });
  await showDashboard("profile");
  await expect(panel.getByLabel("First name", { exact: true })).toHaveValue(profile.firstName);
  const [download] = await Promise.all([
    panel.waitForEvent("download"),
    panel.getByRole("button", { name: "Export profile", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^application-lane-profile-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(exported.format).toBe("application-lane-profile");
  expect(exported.profile.firstName).toBe(profile.firstName);
  expect(exported.settings).toMatchObject({ modelFill: "review", legalQuestions: "model" });
  expect(JSON.stringify(exported)).not.toContain(token);
  // Another installation's export replaces what is here, once confirmed.
  const file = join(await scratch("lane-profile-export-"), "profile.json");
  await writeFile(
    file,
    JSON.stringify({
      ...exported,
      profile: { ...exported.profile, firstName: "Imported", legal: { ...exported.profile.legal, clearance: "None; never held one" } },
      tailoring: [{ path: "preferences.md", text: "## Logistics (confirmed)\n- **Home base:** Tucson, AZ.\n" }, { path: "resumes/Alex_Fixture_Resume.tex", text: "\\documentclass{article}" }],
      settings: { ...exported.settings, modelFill: "off" },
    }),
  );
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, modelFill: "auto", legalQuestions: "manual" } });
  panel.once("dialog", (dialog) => void dialog.accept());
  await panel.getByLabel("Import profile", { exact: true }).setInputFiles(file);
  await expect(panel.getByText("Profile imported, with 2 tailoring files")).toBeVisible();
  await expect(panel.getByLabel("First name", { exact: true })).toHaveValue("Imported");
  expect((await ui({ type: "API", path: "/v1/profile" })).legal.clearance).toBe("None; never held one");
  expect((await state()).settings).toMatchObject({ modelFill: "off", legalQuestions: "model", concurrency: 4 });
  expect(await readFile(join(backendDirectory, "tailoring", "preferences.md"), "utf8")).toContain("Tucson");
  // A file that is not an export changes nothing.
  const other = join(await scratch("lane-profile-export-"), "other.json");
  await writeFile(other, JSON.stringify({ firstName: "Wrong" }));
  panel.once("dialog", (dialog) => void dialog.accept());
  await panel.getByLabel("Import profile", { exact: true }).setInputFiles(other);
  await expect(panel.getByRole("alert")).toContainText("not a profile export");
  await expect(panel.getByLabel("First name", { exact: true })).toHaveValue("Imported");
});

test("the side panel holds only applications; the rest opens as a dashboard tab", async () => {
  await panel.bringToFront();
  await expect(panel.getByRole("navigation")).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "Applications", exact: true })).toBeVisible();
  const opened = context.waitForEvent("page");
  await panel.getByRole("button", { name: "Dashboard" }).click();
  const dashboard = await opened;
  await expect(dashboard).toHaveURL(/dashboard\.html#profile$/);
  await expect(dashboard.getByRole("navigation").getByRole("button")).toHaveText(["Your profile", "Find jobs", "Submitted", "Fixer", "Issues", "Settings"]);
  await expect(dashboard.getByRole("heading", { name: "Applications", exact: true })).toHaveCount(0);
  await dashboard.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(dashboard.getByRole("heading", { name: "Backend connection" })).toBeVisible();
  // Asked for again, the open dashboard is reused, on the page asked for.
  await panel.bringToFront();
  await panel.getByRole("button", { name: "Dashboard" }).click();
  await expect(dashboard).toHaveURL(/dashboard\.html#profile$/);
  await expect(dashboard.getByLabel("First name", { exact: true })).toBeVisible();
  expect(context.pages().filter((page) => page.url().includes("dashboard.html"))).toHaveLength(1);
});

// Pairing used to mean copying a 64-character token out of a config file:
// the dashboard now asks for the six-digit code the backend shows.
test("the dashboard connects to an unpaired backend with the code it shows", async () => {
  // As a fresh backend: bound to no extension, with a token this one lacks.
  appConfig.extensionId = undefined;
  appConfig.token = "fresh-backend-token-".repeat(4);
  const dashboard = await context.newPage();
  try {
    await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html#profile`);
    const card = dashboard.getByRole("region", { name: "Connect to Application Lane" });
    await expect(card).toContainText("saved token was not accepted");
    const { code } = pairingControl.open("unpaired");
    await expect(card.getByLabel("Pairing code")).toBeVisible({ timeout: 10000 });
    await card.getByLabel("Pairing code").fill(code === "000000" ? "111111" : "000000");
    await card.getByRole("button", { name: "Connect" }).click();
    await expect(card.getByRole("alert")).toContainText("does not match");
    await card.getByLabel("Pairing code").fill(`${code.slice(0, 3)} ${code.slice(3)}`);
    await card.getByRole("button", { name: "Connect" }).click();
    await expect(card).toHaveCount(0);
    expect(appConfig.extensionId).toBe(extensionId);
    await expect(dashboard.getByRole("region", { name: "Getting started" })).toContainText("Connect the backend");
    await expect(dashboard.getByLabel("First name", { exact: true })).toBeVisible();
  } finally {
    await dashboard.close();
  }
});

// The fixer's work was in files only (2026-10-17): the dashboard shows
// whether it runs, what it is on, and what it found and fixed.
test("the dashboard's Fixer page shows whether the fixer runs and its work", async () => {
  const folder = join(backendDirectory, "fixer");
  await mkdir(join(folder, "tasks"), { recursive: true });
  const task = "00000000-0000-4000-8000-0000000000f1";
  const done = "00000000-0000-4000-8000-0000000000f2";
  await writeFile(join(folder, "heartbeat.json"), JSON.stringify({ at: Date.now(), branch: "windows-aware-tests" }));
  await writeFile(join(folder, "tasks", `${task}.json`), JSON.stringify({ id: task, kind: "check", createdAt: 1, rule: "required-empty", site: "avature.net", signature: "required-empty | employer", examples: [{ label: "Employer", detail: "Required and empty after the fill." }] }));
  await writeFile(join(folder, `${task}.json`), JSON.stringify({ status: "working", startedAt: Date.now() - 5 * 60_000 }));
  await writeFile(join(folder, "tasks", `${done}.json`), JSON.stringify({ id: done, kind: "check", createdAt: 2, rule: "rows-short", site: "avature.net", signature: "rows-short | work", examples: [{ label: "work", detail: "2 of 3 work entries have a row." }] }));
  await writeFile(join(folder, `${done}.json`), JSON.stringify({ status: "fixed", summary: "Work rows are added.", commit: "abcdef1234", finishedAt: Date.now() }));
  await showDashboard("fixer");
  await expect(panel.getByRole("status").filter({ hasText: "Running" })).toContainText("Running on windows-aware-tests.");
  const rows = panel.locator(".issue-row");
  await expect(rows).toHaveCount(2);
  // Work in progress first, then what finished.
  await expect(rows.nth(0)).toContainText("Employer on avature.net");
  await expect(rows.nth(0)).toContainText("working for 5 min");
  await expect(rows.nth(1)).toContainText("Work history rows on avature.net");
  await expect(rows.nth(1)).toContainText("Fixed (abcdef1): Work rows are added.");
  // Whether each agent can work, from the fixer's health check.
  await writeFile(join(folder, "health.json"), JSON.stringify({ claude: { ok: true, checkedAt: Date.now(), detail: "Ran a command and wrote a file." }, codex: { ok: false, checkedAt: Date.now(), detail: "helper_unknown_error: setup refresh had errors", version: "codex-cli 0.162.1" } }));
  await panel.reload();
  const agentsList = panel.getByRole("region", { name: "Fixer agents and models" });
  await expect(agentsList).toContainText("Works");
  await expect(agentsList).toContainText("Does not work: helper_unknown_error: setup refresh had errors");
  await agentsList.getByRole("button", { name: "Check again" }).click();
  await expect(panel.getByText("The fixer will check every agent again")).toBeVisible();
  expect(await stat(join(folder, "health.json")).then(() => true, () => false)).toBe(false);
  // Its agents and models are chosen here, and saved where it reads them.
  const chosen = panel.getByRole("region", { name: "Fixer agents and models" });
  await chosen.getByRole("button", { name: "Try Codex earlier" }).click();
  await chosen.getByLabel("Claude model").fill("sonnet");
  await chosen.getByRole("button", { name: "Save fixer settings" }).click();
  await expect(panel.getByText("Fixer settings saved.")).toBeVisible();
  const saved = JSON.parse(await readFile(join(folder, "settings.json"), "utf8"));
  expect(saved).toMatchObject({ agents: ["codex", "claude"], claudeModel: "sonnet" });
  // A fixer that stopped beating is not running.
  await writeFile(join(folder, "heartbeat.json"), JSON.stringify({ at: Date.now() - 10 * 60_000, branch: "windows-aware-tests" }));
  await panel.reload();
  await expect(panel.getByRole("status").filter({ hasText: "Not running" })).toContainText("Start it with npm run fixer.");
});

test("drafting providers, the API endpoint and folders are set on the dashboard", async () => {
  await showDashboard("settings");
  const drafting = panel.getByRole("region", { name: "Drafting" });
  // The backend's one model, as the legacy settings read.
  await expect(drafting.getByRole("group")).toHaveCount(1);
  await drafting.getByRole("button", { name: "Add Codex" }).click();
  const codex = drafting.getByRole("group", { name: "Provider 2: Codex" });
  await codex.getByLabel("Reasoning effort").selectOption("medium");
  await codex.getByRole("button", { name: "Move up" }).click();
  await panel.getByRole("region", { name: "API endpoint" }).getByLabel("API key").fill("sk-dashboard-key");
  // The model that checks drafts: empty, it is the endpoint's own, and the box says which.
  const checker = panel.getByRole("region", { name: "API endpoint" }).getByLabel("Checking model (optional)");
  await expect(checker).toHaveValue("");
  await expect(checker).toHaveAttribute("placeholder", `Uses ${appConfig.model}`);
  await checker.fill("checker-large");
  // Who checks, in an order of its own (2026-11-02): a smaller Codex model.
  const checking = panel.getByRole("region", { name: "Checking" });
  await expect(checking).toContainText("The Drafting order checks.");
  await checking.getByRole("button", { name: "Add Codex" }).click();
  await checking.getByRole("group", { name: "Checker 1: Codex" }).getByLabel("Model").fill("codex-checker-model");
  await panel.getByRole("button", { name: "Save drafting settings" }).click();
  await expect(panel.getByText("Settings saved.")).toBeVisible();
  expect(appConfig.checkProviders.map((step) => [step.provider, step.model])).toEqual([["codex-cli", "codex-checker-model"]]);
  expect(appConfig.verifyModel).toBe("checker-large");
  await expect(checker).toHaveValue("checker-large");
  // The applicant's transcript is added here, not by finding a folder on disk.
  appConfig.transcriptsDir = await scratch("lane-transcripts-");
  await panel.reload();
  await showDashboard("settings");
  const transcript = panel.getByRole("region", { name: "Transcript" });
  await expect(transcript).toContainText("No transcript yet.");
  await transcript.locator('input[type="file"]').setInputFiles({ name: "Unofficial transcript.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 synthetic transcript") });
  await expect(transcript).toContainText("Current transcript: Unofficial transcript.pdf");
  expect(await readFile(join(appConfig.transcriptsDir, "Unofficial transcript.pdf"), "utf8")).toBe("%PDF-1.4 synthetic transcript");
  // A file that is not one is refused, and the transcript stays as it was.
  await transcript.locator('input[type="file"]').setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("plain text") });
  await expect(panel.getByRole("alert")).toContainText("not a PDF");
  await expect(transcript).toContainText("Current transcript: Unofficial transcript.pdf");
  expect(appConfig.draftProviders.map((step) => [step.provider, step.effort])).toEqual([
    ["codex-cli", "medium"],
    ["http", undefined],
  ]);
  expect(appConfig.apiKey).toBe("sk-dashboard-key");
  // The key is never shown again, and a program that is not the CLI is refused.
  await expect(panel.getByLabel("API key")).toHaveValue("");
  await expect(panel.getByLabel("API key")).toHaveAttribute("placeholder", /A key is saved/);
  await drafting.getByRole("group", { name: "Provider 1: Codex" }).getByLabel("Program path (optional)").fill("/bin/sh");
  await panel.getByRole("button", { name: "Save drafting settings" }).click();
  await expect(panel.getByRole("alert")).toContainText('must start with "codex"');
  expect(appConfig.draftProviders[0].command).toBeUndefined();
});

test("document checking is chosen in the panel and kept by the backend", async () => {
  await panel.bringToFront();
  await showDashboard("settings");
  await panel.getByLabel("Document checking").selectOption("fast");
  await panel.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => appConfig.checking).toBe("fast");
  await panel.getByLabel("Document checking").selectOption("thorough");
  await panel.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => appConfig.checking).toBe("thorough");
  // Pre-filled answers: replaced unless Keep is chosen.
  expect((await state()).settings.prefilled ?? "replace").toBe("replace");
  await panel.getByLabel("Pre-filled answers").selectOption("keep");
  await panel.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(async () => (await state()).settings.prefilled).toBe("keep");
});

test("an issue report keeps what web components hold in their shadow roots", async () => {
  await context.route(`${origin}/shadow-report`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <label>Email<input name="email" type="email"></label>
        <date-widget></date-widget>
      </form><script>
        customElements.define('date-widget', class extends HTMLElement {
          constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<input class="inner-date" placeholder="MM/DD/YYYY">'; }
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/shadow-report`);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "TRACK_TAB", tabId });
  const captured = await ui({ type: "REPORT_ISSUE", tabId, category: "other", note: "Date picker." });
  const exported = await ui({ type: "API", path: `/v1/issues/${captured.report.id}` });
  const html = exported.frames[0].html as string;
  expect(html).toMatch(/<date-widget><template shadowrootmode="open"><input class="inner-date"/);
  expect(exported.application).toHaveProperty("configNotes");
});

test("a form's transcript field gets the applicant's transcript, and the resume field the resume", async () => {
  // As Georgia Tech Research Institute's PageUp "Document Uploads" step
  // (2026-10-03): a resume and an unofficial transcript, side by side.
  await context.route(`${origin}/documents/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Document Uploads</title><form>
        <label>First name<input name="first"></label>
        <label for="resume-file">Resume to use for this application:*</label><input id="resume-file" type="file" accept=".pdf,.docx">
        <label for="transcript-file">Unofficial Transcript (no SSN) with current coursework and cumulative GPA*</label><input id="transcript-file" type="file" accept=".pdf,.docx">
      </form>`,
    }),
  );
  const upload = async (path: string) => {
    const page = await context.newPage();
    await page.goto(`${origin}/documents/${path}`);
    await enqueue([page]);
    await expect
      .poll(async () => (await state()).applications.find((a: { url: string }) => a.url.endsWith(path))?.status, { timeout: 30000 })
      .toMatch(/ready|awaiting-user/);
    const chosen = (id: string) => page.locator(`#${id}`).evaluate((input: HTMLInputElement) => input.files?.[0]?.name || "");
    const app = (await state()).applications.find((a: { url: string }) => a.url.endsWith(path))!;
    const fields = (await content(page, { type: "INSPECT" })).data.fields;
    return { chosen, app, fields };
  };
  // No transcript yet: the card says where it goes, and nothing is put there.
  appConfig.transcriptsDir = await scratch("lane-transcripts-");
  const without = await upload("first");
  expect(await without.chosen("transcript-file")).toBe("");
  expect(without.app.missing.join(" ")).toContain("No transcript to upload for Transcript");
  expect(without.fields.find((f: { documentKind?: string }) => f.documentKind === "transcript")).toMatchObject({ label: "Transcript", kind: "file" });
  // With one, each field gets its own document.
  await writeFile(join(appConfig.transcriptsDir, "Unofficial_Transcript.pdf"), "%PDF-1.4\n% a transcript\n");
  const withIt = await upload("second");
  await expect.poll(() => withIt.chosen("transcript-file"), { timeout: 30000 }).toBe("Unofficial_Transcript.pdf");
  expect(await withIt.chosen("resume-file")).toMatch(/\.pdf$/);
  expect(await withIt.chosen("resume-file")).not.toBe("Unofficial_Transcript.pdf");
});

// Databricks' Greenhouse form (2026-11-08): one transcript for each degree.
// With only the newest file, the graduate transcript went into the box for
// the undergraduate one. Each school now has its own.
test("each degree's transcript field gets that school's transcript, and none of another degree's", async () => {
  const group = (id: string, question: string) =>
    `<div class="field-wrapper"><div role="group" aria-labelledby="upload-label-${id}" class="file-upload"><div id="upload-label-${id}" class="label upload-label">${question}</div><div class="file-upload__wrapper"><div class="file-upload__buttons"><button type="button" class="btn btn--pill">Attach</button><input id="${id}" class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf"></div></div></div></div>`;
  await context.route(`${origin}/two-transcripts/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Apply</title><form><label>First name<input name="first"></label><div class="application--questions">
        ${group("question_1", 'Please provide a recent transcript of your undergraduate studies.<span class="required">*</span>')}
        ${group("question_2", "Please provide a recent transcript of your graduate studies (if applicable)")}
      </div></form>`,
    }),
  );
  appConfig.transcriptsDir = await scratch("lane-transcripts-");
  await writeFile(join(appConfig.transcriptsDir, "Graduate_Transcript.pdf"), "%PDF-1.4\n% graduate\n");
  const education = [
    { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05", location: "", details: "" },
    { organization: "Penn State", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "", details: "" },
  ];
  const fill = async (path: string) => {
    const page = await context.newPage();
    await page.goto(`${origin}/two-transcripts/${path}`);
    await enqueue([page]);
    await expect
      .poll(async () => (await state()).applications.find((a: { url: string }) => a.url.endsWith(path))?.status, { timeout: 30000 })
      .toMatch(/ready|awaiting-user/);
    const chosen = (id: string) => page.locator(`#${id}`).evaluate((input: HTMLInputElement) => input.files?.[0]?.name || "");
    return { chosen, app: (await state()).applications.find((a: { url: string }) => a.url.endsWith(path))! };
  };
  // Only the newest file, no school's own: never into the undergraduate box.
  const saveEducation = async (rows: unknown[]) => {
    const current = await ui({ type: "API", path: "/v1/profile" });
    await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...current, confirmed: true, education: rows } });
  };
  await saveEducation(education);
  const before = await fill("first");
  await expect.poll(() => before.chosen("question_2"), { timeout: 30000 }).toBe("Graduate_Transcript.pdf");
  expect(await before.chosen("question_1")).toBe("");
  expect(before.app.missing.join(" ")).toContain("Upload your undergraduate transcript yourself");
  // Each school's own: each box gets its degree's.
  await writeFile(join(appConfig.transcriptsDir, "Undergraduate_Transcript.pdf"), "%PDF-1.4\n% undergraduate\n");
  await saveEducation([{ ...education[0], transcript: "Graduate_Transcript.pdf" }, { ...education[1], transcript: "Undergraduate_Transcript.pdf" }]);
  const after = await fill("second");
  await expect.poll(() => after.chosen("question_1"), { timeout: 30000 }).toBe("Undergraduate_Transcript.pdf");
  await expect.poll(() => after.chosen("question_2"), { timeout: 30000 }).toBe("Graduate_Transcript.pdf");
});

test("when the posting cannot be read, the applicant pastes it on the card and the next fill uses it", async () => {
  // The site's posting is not found (no ATS endpoint, a page that is only
  // its form), as on Georgia Tech's PageUp application.
  appConfig.postingLookup = true;
  const descriptions: string[] = [];
  runtimeGenerate = async (req, p) => {
    descriptions.push(req.description);
    return groundNarrative(
      { resume: p.facts.map((f) => ({ factId: f.id, text: f.text })), coverLetter: [{ text: "", factIds: ["fact-1"] }], answers: [] },
      p,
      req,
    );
  };
  const page = await context.newPage();
  await page.goto(`${origin}/given-posting`);
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0]?.missing.join(" "), { timeout: 30000 })
    .toContain("Add the posting's link or text to this application");
  await page.bringToFront();
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  const prompt = panel.getByRole("region", { name: "Current browser tab" }).getByRole("form", { name: "Add the job posting" });
  await prompt.getByText("Or paste its text").click();
  const pasted = "Build accessible TypeScript interfaces for the Acme design system, working with designers and the platform team. ".repeat(3);
  await prompt.getByLabel("Posting text").fill(pasted);
  await prompt.getByRole("button", { name: "Save posting" }).click();
  await expect.poll(async () => (await state()).applications[0].postingText).toBe(pasted.trim());
  // The next fill is tailored from it, and the card says where it came from.
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!, page.url());
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id, tabId });
  await expect.poll(() => descriptions.at(-1) || "", { timeout: 30000 }).toContain("Acme design system");
  await expect
    .poll(async () => (await state()).applications[0].posting?.source, { timeout: 30000 })
    .toBe("Pasted");
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  await expect(panel.getByRole("region", { name: "Current browser tab" }).getByText("Documents tailored from the posting you pasted.")).toBeVisible();
});

test("a report recovers loaded scripts without reloading and keeps interactions after the fill", async () => {
  // Network capture is off unless the applicant turns it on.
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, networkCapture: "on" } });
  // Reports 5ee92470 and 4c8463f6: the applicant cannot return to the form.
  let loads = 0;
  await context.route(`${origin}/report-once/**`, (route) => {
    if (route.request().url().endsWith("app.js"))
      return route.fulfill({ contentType: "text/javascript", body: `
        const field = document.querySelector('phone-widget').attachShadow({mode:'open'});
        field.innerHTML = '<label>Phone<input type="tel" name="phone"></label><button type="button">Format phone</button>';
        field.querySelector('button').onclick = () => {
          field.querySelector('input').value = '(602) 555-0101';
          const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
          dialog.textContent = 'Phone formatted'; field.append(dialog);
        };` });
    loads++;
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><title>One visit</title><form><label>Email<input type="email" name="email"></label><phone-widget></phone-widget></form><script src="/report-once/app.js"></script>' });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/report-once/apply`);
  await expect(page.locator('[name="phone"]')).toBeAttached();
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 30000 }).toMatch(/ready|awaiting-user/);
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Format phone" }).click();
  await page.waitForTimeout(400);
  const tabId = (await state()).applications[0].tabId!;
  const captured = await ui({ type: "REPORT_ISSUE", tabId, category: "wrong-value", note: "Phone needed an interaction." });
  expect(captured.saved).toBe(true);
  // A later report gets its own snapshot and cannot rewrite this evidence.
  await page.locator('[name="phone"]').fill("4805550102");
  const later = await ui({ type: "REPORT_ISSUE", tabId, category: "wrong-value", note: "Another interaction." });
  expect(later.report.recordingId).not.toBe(captured.report.recordingId);
  await page.close();
  expect(loads).toBe(1);
  const recording = JSON.parse(await readFile(join(backendDirectory, "recordings", `${captured.report.recordingId}.json`), "utf8"));
  expect(recording.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "event", data: expect.objectContaining({ type: "click", target: expect.objectContaining({ text: "Format phone" }) }) }),
    expect.objectContaining({ kind: "value", data: expect.objectContaining({ to: "(602) 555-0101" }) }),
    expect.objectContaining({ kind: "menu", data: expect.objectContaining({ op: "added" }) }),
  ]));
  expect(JSON.stringify(recording.events)).not.toContain("4805550102");
  const har = JSON.parse(await readFile(join(backendDirectory, "issues", `${captured.report.id}.har.json`), "utf8"));
  expect(har.log.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ request: expect.objectContaining({ url: `${origin}/report-once/app.js` }), response: expect.objectContaining({ content: expect.objectContaining({ text: expect.stringContaining("attachShadow") }) }) }),
  ]));
  expect(captured.report.network.fromLoad).toBe(false);
  expect(captured.report.network.recovered).toBeGreaterThan(0);
});

test("a report carries the fill's recording and the page's network traffic, which replays the site", async () => {
  // Network capture is off unless the applicant turns it on.
  await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, networkCapture: "on" } });
  // The site's own script builds the form from data it fetches: only a
  // replay of its traffic, not a snapshot of its HTML, brings that back.
  await context.route(`${origin}/captured/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/app.js"))
      return route.fulfill({
        contentType: "text/javascript",
        body: "fetch('/captured/form.json').then((r) => r.json()).then((form) => { document.querySelector('form').innerHTML = form.fields.map((f) => '<label>' + f + '<input name=\"' + f + '\"></label>').join(''); });",
      });
    if (path.endsWith("/form.json")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ fields: ["Email", "Captured Question"] }) });
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Captured</title><form></form><script src="/captured/app.js"></script>' });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/captured/apply`);
  await expect(page.locator('[name="Captured Question"]')).toBeAttached();
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0]?.status, { timeout: 30000 })
    .toMatch(/ready|awaiting-user/);
  // The fill recorded itself.
  await expect.poll(async () => (await state()).applications[0].lastRecordingId, { timeout: 15000 }).toMatch(/^[a-f0-9-]{36}$/);
  // And left a capture of the page as it left it, with its traffic, for the
  // eval's checks (eval/check.ts), without anyone filing a report.
  const fillCaptures = async () => (await readdir(join(backendDirectory, "captures")).catch(() => [] as string[])).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
  await expect.poll(async () => (await fillCaptures()).length, { timeout: 30000 }).toBeGreaterThan(0);
  const fillCapture = JSON.parse(await readFile(join(backendDirectory, "captures", (await fillCaptures())[0]), "utf8"));
  expect(fillCapture).toMatchObject({ trigger: "fill", applicationId: (await state()).applications[0].id, recordingId: (await state()).applications[0].lastRecordingId });
  expect(fillCapture.frames.flatMap((frame: { observation?: { fields: { label: string }[] } }) => frame.observation?.fields.map((field) => field.label) || [])).toContain("Captured Question");
  const fillHar = JSON.parse(await readFile(join(backendDirectory, "captures", `${fillCapture.id}.har.json`), "utf8"));
  expect(fillHar.log.entries.length).toBe(fillCapture.network.entries);
  // An application tab's traffic is kept from the page's first request.
  await page.reload();
  await expect(page.locator('[name="Captured Question"]')).toBeAttached();
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!, page.url());
  const captured = await ui({ type: "REPORT_ISSUE", tabId, category: "other", note: "Captured page." });
  expect(captured.saved).toBe(true);
  expect(captured.report.recordingId).toBe((await state()).applications[0].lastRecordingId);
  expect(captured.report.network).toMatchObject({ fromLoad: true });
  const harPath = join(backendDirectory, "issues", `${captured.report.id}.har.json`);
  const har = JSON.parse(await readFile(harPath, "utf8"));
  const urls = har.log.entries.map((entry: { request: { url: string } }) => new URL(entry.request.url).pathname);
  expect(urls).toEqual(expect.arrayContaining(["/captured/apply", "/captured/app.js", "/captured/form.json"]));
  expect(JSON.stringify(har)).not.toMatch(/"name":\s*"(cookie|set-cookie|authorization)"/i);
  // The capture replays: the site's script runs against its captured data.
  await context.unroute(`${origin}/captured/**`);
  const replay = await context.newPage();
  await replay.routeFromHAR(harPath, { notFound: "abort" });
  await replay.goto(`${origin}/captured/apply`);
  await expect(replay.locator('[name="Captured Question"]')).toBeAttached();
  // The Issues tab says what the report holds.
  await panel.bringToFront();
  await showDashboard("issues");
  await expect(panel.getByText(/with recording · network from page load/)).toBeVisible();
});

test("a field the site changed and then emptied is filled again", async () => {
  await context.route(`${origin}/site-changed-then-empty`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <label>Email<input name="email" type="email"></label>
      </form><script>
        window.siteChange = () => { document.querySelector('[name="email"]').value = "restored@example.test"; };
        window.siteClear = () => { document.querySelector('[name="email"]').value = ""; };
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/site-changed-then-empty`);
  await enqueue([page]);
  await expect(page.locator("[name=email]")).toHaveValue(profile.email, { timeout: 25000 });
  const id = (await state()).applications[0].id;
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 25000 })
    .toMatch(/awaiting-user|ready/);
  // The site rewrites the field (now protected), then empties it.
  await page.evaluate(() => (window as any).siteChange());
  await ui({ type: "SCAN_TAB", tabId });
  await page.evaluate(() => (window as any).siteClear());
  await ui({ type: "FILL_STEP", id, tabId });
  await expect(page.locator("[name=email]")).toHaveValue(profile.email, { timeout: 25000 });
});

test("only the applicant's own edits are saved as locks with the application", async () => {
  await context.route(`${origin}/script-change`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <label>Email<input name="email" type="email"></label>
        <label>City<input name="city"></label>
      </form>
      <script>
        window.pageScript = () => { document.querySelector('[name="city"]').value = "Set by the page"; };
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/script-change`);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "TRACK_TAB", tabId });
  const id = (await state()).applications[0].id;
  await ui({ type: "FILL_STEP", id, tabId });
  await expect(page.locator("[name=email]")).toHaveValue(profile.email);
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 25000 })
    .toMatch(/awaiting-user|ready/);
  // The page changes a field itself; then the applicant edits another.
  await page.evaluate(() => (window as any).pageScript());
  await ui({ type: "SCAN_TAB", tabId });
  await page.bringToFront();
  await page.locator("[name=email]").fill("human@example.test");
  await expect.poll(async () => (await state()).applications[0].status).toBe("paused");
  const saved = await worker.evaluate(
    async (id) => ((await chrome.storage.local.get("locks")).locks || {})[id] || [],
    id,
  );
  expect(saved.some((key: string) => key.includes("email"))).toBe(true);
  expect(saved.some((key: string) => key.includes("city"))).toBe(false);
});

test("a resume chosen by hand is attached again after a reload", async () => {
  await context.route(`${origin}/rechoose-resume`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <label>Email<input name="email" type="email"></label>
        <label>Resume/CV<input type="file" name="resume"></label>
      </form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/rechoose-resume`);
  await enqueue([page]);
  const resume = page.locator("[name=resume]");
  const chosen = () => resume.evaluate((input: HTMLInputElement) => input.files?.[0]?.name || "");
  await expect.poll(chosen, { timeout: 60000 }).toMatch(/\.pdf$/);
  const generated = await chosen();
  // As after a failed submit: the applicant picks the file again by hand,
  // and that edit is saved as a lock with the application.
  await page.bringToFront();
  const chooser = page.waitForEvent("filechooser");
  await resume.click();
  await (await chooser).setFiles({ name: "mine.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
  await expect.poll(async () => (await state()).applications[0].status).toBe("paused");
  const id = (await state()).applications[0].id;
  // A reload empties every file input; the lock must not keep it empty.
  await page.reload();
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "FILL_STEP", id, tabId });
  await expect.poll(chosen, { timeout: 25000 }).toBe(generated);
});

test("an answer edited by hand under a long label still gets documents after a reload", async () => {
  // Lever-length question text: its lock reason repeats the label twice.
  const question = `Please describe how you heard about this opportunity and ${"which of our programs interest you most ".repeat(5)}`;
  await context.route(`${origin}/long-lock`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <label>Email<input name="email" type="email"></label>
        <label>${question}<input name="heard"></label>
        <label>Resume/CV<input type="file" name="resume"></label>
      </form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/long-lock`);
  await enqueue([page]);
  const chosen = () =>
    page.locator("[name=resume]").evaluate((input: HTMLInputElement) => input.files?.[0]?.name || "");
  await expect.poll(chosen, { timeout: 60000 }).toMatch(/\.pdf$/);
  await page.bringToFront();
  await page.locator("[name=heard]").fill("A friend");
  await page.locator("[name=heard]").blur();
  await expect.poll(async () => (await state()).applications[0].status).toBe("paused");
  const id = (await state()).applications[0].id;
  await page.reload();
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "FILL_STEP", id, tabId });
  await expect.poll(chosen, { timeout: 60000 }).toMatch(/\.pdf$/);
  const app = (await state()).applications[0];
  expect(app.status).not.toBe("failed");
  expect(app.note).not.toContain("Invalid request fields");
});

test("documents cut off by a backend restart are generated again, not given up", async () => {
  // The backend marks the jobs it was running this way when it restarts.
  let calls = 0;
  runtimeGenerate = async () => {
    calls++;
    throw new Error("Backend restarted. Retry to create fresh documents.");
  };
  await context.route(`${origin}/restarted`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <label>Email<input name="email" type="email"></label>
        <label>Resume/CV<input type="file" name="resume"></label>
      </form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/restarted`);
  await enqueue([page]);
  await expect.poll(() => calls, { timeout: 25000 }).toBeGreaterThan(0);
  runtimeGenerate = undefined;
  const chosen = () =>
    page.locator("[name=resume]").evaluate((input: HTMLInputElement) => input.files?.[0]?.name || "");
  await expect.poll(chosen, { timeout: 60000 }).toMatch(/\.pdf$/);
  expect((await state()).applications[0].status).not.toBe("failed");
});

test("an upload the site rejects is reported with its message, not as attached", async () => {
  await context.route(`${origin}/broken-uploader`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <label>Email<input name="email" type="email"></label>
        <div class="field"><label>Resume/CV<input type="file" name="resume" accept=".pdf"></label>
          <p>Accepted file types: pdf</p><p class="helper-text--error" hidden></p></div>
      </form>
      <script>
        document.querySelector('[name="resume"]').addEventListener("change", () => {
          const error = document.querySelector(".helper-text--error");
          error.hidden = false;
          error.textContent = "Cannot read properties of undefined (reading 'uploadFile')";
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/broken-uploader`);
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0]?.missing.join(" "), {
      timeout: 25000,
    })
    .toContain(
      `Resume upload failed on the site: "Cannot read properties of undefined (reading 'uploadFile')". Reload the page`,
    );
});

// Jabil's Workday form (report f062d50f, 2026-10-15): its Languages and
// Websites sections were left, the applicant's languages had nowhere to
// live, and the links a form asks for elsewhere (its LinkedIn box) are not
// to be given twice.
test("a Workday form adds a row for each language and each link it does not ask for elsewhere", async () => {
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, languages: ["English: Native", "Hindi: Basic"], linkedin: "linkedin.com/in/example", github: "github.com/example", website: "https://example.dev" },
  });
  await context.route(`${atsOrigins[0]}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>My Experience</title><main>
        <div data-automation-id="formField-linkedinQuestion"><label for="li">LinkedIn</label><input id="li" data-automation-id="linkedinQuestion"></div>
        <div role="group" aria-labelledby="Languages-section"><h4 id="Languages-section">Languages</h4><button data-automation-id="add-button" type="button" id="addLanguage">Add</button></div>
        <div role="group" aria-labelledby="Websites-section"><h4 id="Websites-section">Websites</h4><button data-automation-id="add-button" type="button" id="addWebsite">Add</button></div>
      </main><script>
        let languages = 0, websites = 0;
        document.getElementById('addLanguage').addEventListener('click', () => {
          const row = document.createElement('div');
          row.setAttribute('data-automation-id', 'language-' + (++languages));
          row.innerHTML = '<div data-automation-id="formField-language"><label>Language</label><button type="button" aria-haspopup="listbox" aria-expanded="false">Select One</button></div>'
            + '<div data-automation-id="formField-native"><label for="native-' + languages + '">I am fluent in this language.</label><input type="checkbox" name="native" id="native-' + languages + '"></div>'
            + '<div data-automation-id="formField-comprehension"><label>Comprehension</label><button type="button" class="skill" aria-haspopup="listbox" aria-expanded="false" aria-label="Comprehension Select One">Select One</button></div>';
          // As React does: only a click is seen (report b5a71768).
          const native = row.querySelector('[name="native"]');
          native.addEventListener('click', () => { native.dataset.seen = String(native.checked); });
          const skill = row.querySelector('.skill');
          skill.addEventListener('click', () => {
            skill.setAttribute('aria-expanded', 'true');
            const popup = document.createElement('div');
            popup.setAttribute('data-automation-activepopup', 'true');
            popup.innerHTML = '<ul role="listbox">' + ['Select One', '1 - Beginner', '3 - Intermediate', '5 - Fluent'].map((name) => '<li role="option">' + name + '</li>').join('') + '</ul>';
            popup.querySelectorAll('li').forEach((option) => option.addEventListener('click', () => { skill.textContent = option.textContent; skill.setAttribute('aria-label', 'Comprehension ' + option.textContent); skill.setAttribute('aria-expanded', 'false'); popup.remove(); }));
            document.body.append(popup);
          });
          const button = row.querySelector('button');
          button.addEventListener('click', () => {
            button.setAttribute('aria-expanded', 'true');
            const popup = document.createElement('div');
            popup.setAttribute('data-automation-activepopup', 'true');
            popup.innerHTML = '<ul role="listbox">' + ['English', 'French', 'Hindi'].map((name) => '<li role="option">' + name + '</li>').join('') + '</ul>';
            popup.querySelectorAll('li').forEach((option) => option.addEventListener('click', () => { button.textContent = option.textContent; button.setAttribute('aria-expanded', 'false'); popup.remove(); }));
            document.body.append(popup);
          });
          document.querySelector('[aria-labelledby="Languages-section"]').append(row);
        });
        document.getElementById('addWebsite').addEventListener('click', () => {
          const row = document.createElement('div');
          row.setAttribute('data-automation-id', 'websitePanelSet-' + (++websites));
          row.innerHTML = '<label>URL</label><input type="text" data-automation-id="website">';
          document.querySelector('[aria-labelledby="Websites-section"]').append(row);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/Remote/Engineer_JR1/apply/applyManually`);
  await enqueue([page]);
  await expect(page.locator('[data-automation-id="formField-language"] button')).toHaveText(["English", "Hindi"], { timeout: 60000 });
  // Each language's level, and the fluent box clicked, not set.
  await expect(page.locator(".skill")).toHaveText(["5 - Fluent", "1 - Beginner"], { timeout: 30000 });
  await expect(page.locator('[name="native"]').nth(0)).toHaveAttribute("data-seen", "true");
  await expect(page.locator('[name="native"]').nth(1)).not.toBeChecked();
  await expect(page.locator('[data-automation-id="website"]')).toHaveCount(2);
  expect(await page.locator('[data-automation-id="website"]').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual([
    "https://github.com/example",
    "https://example.dev",
  ]);
  await expect(page.locator("#li")).toHaveValue(/linkedin\.com\/in\/example$/);
});

// KLA's Workday (report 5c049c5a, 2026-11-02): the site read GitHub from
// the resume into a Websites row, and the fill added GitHub again.
test("a Workday Websites row the site already filled keeps its link, and that link is not added again", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, linkedin: "", github: "github.com/example", website: "https://example.dev" } });
  await context.route(`${atsOrigins[0]}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>My Experience</title><main>
        <div role="group" aria-labelledby="Websites-section"><h4 id="Websites-section">Websites</h4>
          <div data-automation-id="websitePanelSet-1"><label>URL</label><input type="text" data-automation-id="website"></div>
          <div data-automation-id="websitePanelSet-2"><label>URL</label><input type="text" data-automation-id="website"></div>
          <div data-automation-id="websitePanelSet-3"><label>URL</label><input type="text" data-automation-id="website" value="https://www.linkedin.com/in/example-41ab/"></div>
          <div data-automation-id="websitePanelSet-4"><label>URL</label><input type="text" data-automation-id="website" value="https://github.com/example/"></div>
          <button data-automation-id="add-button" type="button" id="addWebsite">Add Another</button></div>
      </main><script>
        let websites = 4;
        document.getElementById('addWebsite').addEventListener('click', () => {
          const row = document.createElement('div');
          row.setAttribute('data-automation-id', 'websitePanelSet-' + (++websites));
          row.innerHTML = '<label>URL</label><input type="text" data-automation-id="website">';
          document.getElementById('addWebsite').before(row);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/Remote/Engineer_JR1/apply/applyManually`);
  await enqueue([page]);
  await expect.poll(() => page.locator('[data-automation-id="website"]').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)), { timeout: 60000 })
    .toEqual(["https://example.dev", "", "https://www.linkedin.com/in/example-41ab/", "https://github.com/example/"]);
});

// A Workday language list drawn as a bare listbox the button names in
// aria-controls, with no active-popup wrapper, its options a moment later: the
// language was left open and unanswered (report daf095e5, 2026-11-03).
test("a Workday language picked from the listbox its button controls", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, languages: ["English: Native"] } });
  await context.route(`${atsOrigins[0]}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>My Experience</title><main>
        <div role="group" aria-labelledby="Languages-section"><h4 id="Languages-section">Languages</h4>
          <div data-automation-id="language-1"><div data-automation-id="formField-language"><label>Language</label>
            <button type="button" name="language" id="lang" aria-haspopup="listbox" aria-expanded="false">Select One</button></div></div>
        </div>
      </main><script>
        const button = document.getElementById("lang");
        button.addEventListener("click", () => {
          if (document.getElementById("langlist")) return;
          button.setAttribute("aria-expanded", "true");
          button.setAttribute("aria-controls", "langlist");
          const list = document.createElement("ul");
          list.id = "langlist";
          list.setAttribute("role", "listbox");
          list.innerHTML = '<li role="option" aria-disabled="true"><div>Select One</div></li>';
          document.body.append(list);
          setTimeout(() => {
            for (const name of ["Albanian", "Amharic", "Dutch", "English", "French"]) {
              const option = document.createElement("li");
              option.setAttribute("role", "option");
              option.innerHTML = "<div>" + name + "</div>";
              option.addEventListener("click", () => { button.textContent = name; button.setAttribute("aria-expanded", "false"); list.remove(); });
              list.append(option);
            }
          }, 300);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/Remote/Engineer_JR1/apply/applyManually`);
  await enqueue([page]);
  await expect(page.locator("#lang")).toHaveText("English", { timeout: 45000 });
});

// KLA's Workday form filled slowly (report 6d839e90, 2026-11-04): every
// dropdown is a bare listbox its button names in aria-controls, which the
// rules looked for only inside an active-popup wrapper, so each pick waited
// its full four seconds before another way found it, and a level scale that
// lists none of the profile's wordings waited as long again.
test("Workday dropdowns drawn as bare listboxes are answered without waiting out each pick", async () => {
  test.setTimeout(120_000);
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, languages: ["English: Native"], workAuthorization: "Yes", sponsorship: "No" } });
  const dropdown = (id: string, name: string) => `<button type="button" id="${id}" name="${name}" aria-haspopup="listbox" aria-expanded="false" class="pick">Select One</button>`;
  await context.route(`${atsOrigins[0]}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>My Experience</title><main>
        <div role="group" aria-labelledby="Languages-section"><h4 id="Languages-section">Languages</h4>
          <div data-automation-id="language-1">
            <div data-automation-id="formField-language"><label for="lang">Language</label>${dropdown("lang", "language")}</div>
            <div data-automation-id="formField-native"><input type="checkbox" id="native" name="native"><label for="native">I am fluent in this language.</label></div>
            ${["Listening", "Reading", "Speaking", "Writing"].map((level) => `<div data-automation-id="formField-${level.toLowerCase()}"><label for="lv-${level}">${level}</label>${dropdown(`lv-${level}`, level.toLowerCase())}</div>`).join("")}
          </div>
        </div>
        <div data-automation-id="formField-auth"><fieldset><legend><p>Are you legally authorized to work in the United States?<abbr title="required">*</abbr></p></legend>${dropdown("q-auth", "auth")}</fieldset></div>
        <div data-automation-id="formField-spons"><fieldset><legend><p>Will you now, or in the future, require sponsorship to legally work in the US?<abbr title="required">*</abbr></p></legend>${dropdown("q-spons", "spons")}</fieldset></div>
      </main><script>
        const choices = { lang: ["Dutch", "English", "French"], auth: ["Yes", "No"], spons: ["Yes", "No"] };
        let lists = 0;
        for (const button of document.querySelectorAll("button.pick")) {
          button.addEventListener("click", () => {
            document.querySelector('[role="listbox"]')?.remove();
            for (const other of document.querySelectorAll("button.pick")) { other.setAttribute("aria-expanded", "false"); other.removeAttribute("aria-controls"); }
            const list = document.createElement("ul");
            list.id = "list-" + ++lists;
            list.setAttribute("role", "listbox");
            button.setAttribute("aria-expanded", "true");
            button.setAttribute("aria-controls", list.id);
            const names = choices[button.id.replace(/^q-/, "")] || ["1 - Low", "2 - Medium", "3 - High"];
            list.innerHTML = '<li role="option"><div>Select One</div></li>';
            for (const name of names) {
              const option = document.createElement("li");
              option.setAttribute("role", "option");
              option.innerHTML = "<div>" + name + "</div>";
              option.addEventListener("click", () => { button.textContent = name; button.setAttribute("aria-expanded", "false"); button.removeAttribute("aria-controls"); list.remove(); });
              list.append(option);
            }
            document.body.append(list);
          });
        }
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/Remote/Engineer_JR1/apply/applyManually`);
  const started = Date.now();
  await enqueue([page]);
  await expect(page.locator("#q-spons")).toHaveText("No", { timeout: 60_000 });
  await expect(page.locator("#lang")).toHaveText("English");
  for (const level of ["Listening", "Reading", "Speaking", "Writing"]) await expect(page.locator(`#lv-${level}`)).toHaveText("3 - High");
  await expect(page.locator("#q-auth")).toHaveText("Yes");
  // Seven picks: a few seconds, not four seconds each.
  expect(Date.now() - started).toBeLessThan(15_000);
});

// NVIDIA's Workday (2026-11-04): Phone Device Type lists only "Home" and
// "Home Cellular". "Mobile" matched neither, the list was left open over the
// form, and the required field was left for the applicant.
test("a Workday phone type listed as Home Cellular is picked for a mobile, and the list is not left open", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, phoneDeviceType: "Mobile" } });
  await context.route(`${atsOrigins[0]}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>My Information</title><main data-automation-id="mainContent">
        <div role="group" aria-labelledby="Phone-section"><h4 id="Phone-section">Phone</h4>
          <div data-automation-id="formField-phoneType"><label for="phoneNumber--phoneType"><span>Phone Device Type<abbr>*</abbr></span></label>
            <button aria-haspopup="listbox" type="button" aria-label="Phone Device Type Select One Required" name="phoneType" id="phoneNumber--phoneType" aria-expanded="false">Select One</button></div>
        </div>
      </main><script>
        const button = document.getElementById("phoneNumber--phoneType");
        const close = () => { document.getElementById("types")?.remove(); button.setAttribute("aria-expanded", "false"); button.removeAttribute("aria-controls"); };
        button.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
        button.addEventListener("click", () => {
          if (document.getElementById("types")) return close();
          const list = document.createElement("ul");
          list.id = "types";
          list.setAttribute("role", "listbox");
          list.innerHTML = '<li role="option"><div>Select One</div></li>';
          for (const name of ["Home", "Home Cellular"]) {
            const option = document.createElement("li");
            option.setAttribute("role", "option");
            option.innerHTML = "<div>" + name + "</div>";
            option.addEventListener("click", () => { button.textContent = name; close(); });
            list.append(option);
          }
          document.body.append(list);
          button.setAttribute("aria-expanded", "true");
          button.setAttribute("aria-controls", "types");
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/Remote/Engineer_JR2/apply/applyManually`);
  await enqueue([page]);
  await expect(page.locator("#phoneNumber--phoneType")).toHaveText("Home Cellular", { timeout: 45_000 });
  await expect(page.locator('[role="listbox"]')).toHaveCount(0);
});

// A Workday question whose answers show only once its list is opened
// (2026-11-04): nothing could answer "…at this location?" without its
// options. The page's questionnaire lists them, and without one the list is
// opened, read and closed with nothing chosen, before answers are decided.
for (const source of ["questionnaire", "opened list"] as const)
  test(`a Workday question is answered from its real options, read from the ${source}`, async () => {
    const workdayOrigin = atsOrigins[0];
    await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, workAuthorization: "Yes", sponsorship: "No" } });
    const questionId = "2f2764b3a829100642af26ec534f0000";
    await context.route(`${workdayOrigin}/**`, (route) => {
      if (route.request().url().includes("/questionnaire/"))
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ id: "2f2764b3a82910064296831695150000", questions: [{ id: questionId, body: "<p>Will you require visa support to work at this location?</p>", order: "a", required: true,
            possibleAnswers: [{ id: "a1", answerText: "Yes", order: "a" }, { id: "a2", answerText: "No", order: "b" }] }] }),
        });
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><main data-automation-id="mainContent"><div data-automation-id="applyFlowPrimaryQuestionsPage">
          <div data-automation-id="formField-${questionId}"><fieldset><legend><p>Will you require visa support to work at this location?<abbr title="required">*</abbr></p></legend>
            <button aria-haspopup="listbox" type="button" aria-label=" Select One Required" name="${questionId}" id="primaryQuestionnaire--${questionId}" aria-expanded="false">Select One</button></fieldset></div>
        </div></main><script>
          ${source === "questionnaire" ? `fetch("/wday/cxs/common/acme/questionnaire/2f2764b3a82910064296831695150000");` : ""}
          window.opened = 0;
          const button = document.getElementById("primaryQuestionnaire--${questionId}");
          const close = () => { document.getElementById("answers")?.remove(); button.setAttribute("aria-expanded", "false"); button.removeAttribute("aria-controls"); };
          button.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
          button.addEventListener("click", () => {
            if (document.getElementById("answers")) return close();
            window.opened++;
            const list = document.createElement("ul");
            list.id = "answers";
            list.setAttribute("role", "listbox");
            list.innerHTML = '<li role="option"><div>Select One</div></li>';
            document.body.append(list);
            button.setAttribute("aria-expanded", "true");
            button.setAttribute("aria-controls", "answers");
            // Its answers come a moment after it opens; with the
            // questionnaire, so late that only the questionnaire can have
            // told what they are before the pick.
            setTimeout(() => {
              for (const name of ["Yes", "No"]) {
                const option = document.createElement("li");
                option.setAttribute("role", "option");
                option.innerHTML = "<div>" + name + "</div>";
                option.addEventListener("click", () => { button.textContent = name; close(); });
                list.append(option);
              }
            }, ${source === "questionnaire" ? 2500 : 200});
          });
        </script>`,
      });
    });
    const page = await context.newPage();
    await page.goto(`${workdayOrigin}/en-US/acme/job/Remote/Engineer_JR3/apply/applyManually`);
    await enqueue([page]);
    await expect(page.locator(`#primaryQuestionnaire--${questionId}`)).toHaveText("No", { timeout: 45_000 });
    await expect(page.locator('[role="listbox"]')).toHaveCount(0);
  });

// Microsoft's careers form (report cb45d0c9, 2026-11-04): its dropdowns open
// on a whole click, not on a press or on focus, so the list never showed and
// work authorization was left unanswered.
test("a combobox that opens only on a whole click is opened and answered", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, workAuthorization: "Yes", sponsorship: "No" } });
  const page = await context.newPage();
  await page.goto(`${origin}/click-only-combobox`);
  await page.evaluate(() => {
    document.body.innerHTML = `<form><label id="auth-label" for="input-43">Are you legally authorized to work in the country/region you are applying for?</label>
      <div class="wrap"><input id="input-43" role="combobox" aria-controls="list-41" aria-expanded="false" aria-labelledby="auth-label" aria-required="true" placeholder="Select" type="text">
      <button aria-hidden="true" tabindex="-1" type="button" class="icon-button"></button></div><ul id="list-41" role="listbox" hidden></ul>
      <label for="email">Email</label><input id="email" name="email" type="email"></form>`;
    const input = document.getElementById("input-43") as HTMLInputElement;
    const list = document.getElementById("list-41")!;
    input.addEventListener("click", () => {
      input.setAttribute("aria-expanded", "true");
      list.hidden = false;
      list.innerHTML = "";
      for (const name of ["Yes", "No"]) {
        const option = document.createElement("li");
        option.setAttribute("role", "option");
        option.textContent = name;
        option.addEventListener("click", () => { input.value = name; input.setAttribute("aria-expanded", "false"); list.hidden = true; });
        list.append(option);
      }
    });
  });
  await panel.bringToFront();
  await enqueue([page]);
  await expect(page.locator("#input-43")).toHaveValue("Yes", { timeout: 45_000 });
});

// Microsoft's acknowledgments (report bce03da9, 2026-11-04): three lone boxes
// each named only "Yes", their questions in legends the group names by
// aria-labelledby. As one label repeated, all three were left alone.
test("lone Yes boxes take their group's question and are each answered", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, acknowledgeTerms: true } });
  const page = await context.newPage();
  await page.goto(`${origin}/acknowledgments`);
  await page.evaluate(() => {
    const box = (id: string, question: string) => `<legend id="${id}_legend"><span>${question}</span></legend>
      <div id="${id}" aria-labelledby="${id}_legend"><div><input aria-label="Yes" id="${id}-0" name="${id}" type="checkbox" aria-required="true"><label for="${id}-0"><span>Yes</span></label></div></div>`;
    document.body.innerHTML = `<form><fieldset><legend>Acknowledgment</legend>
      ${box("ack_qualifications", "By selecting yes, you agree that you answered these questions accurately.")}
      ${box("ack_privacy", "By checking this you agree to the Data Privacy Notice.")}
      ${box("ack_conduct", "By checking this, you agree to the candidate code of conduct.")}
      </fieldset><label for="email">Email</label><input id="email" name="email" type="email"></form>`;
  });
  await panel.bringToFront();
  await enqueue([page]);
  for (const id of ["ack_qualifications", "ack_privacy", "ack_conduct"]) await expect(page.locator(`#${id}-0`)).toBeChecked({ timeout: 45_000 });
});

// SmartRecruiters (2026-11-04): a typed box's menu lists "Fill manually"
// first and the site's own entries after it, and Down and Enter took the
// manual one even when the site listed the city.
for (const mode of ["keys", "deaf"] as const)
test(`a SmartRecruiters box picks the site's own entry over its fill-manually one${mode === "deaf" ? ", by a real click when Down does nothing" : ""}`, async () => {
  await context.route(`${smartRecruitersOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main><oc-personal-information><label>Email</label><input id="email" type="email"></oc-personal-information></main><script>{
        const shadowed = (tag, inner) => { const host = document.createElement(tag); host.attachShadow({ mode: "open" }).innerHTML = inner; return host; };
        const box = shadowed("spl-autocomplete", "<div><label>City</label><div class='slot'></div></div>");
        box.setAttribute("label", "City");
        box.setAttribute("data-test", "location-autocomplete");
        // As the site's: the box names its menu, and each entry draws its
        // role="option" in its own shadow root around the label slotted in.
        customElements.define("spl-select-option", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<div role="option" tabindex="-1"><slot></slot></div>'; } });
        const field = shadowed("spl-input", '<input type="text" role="combobox" aria-label="City" aria-controls="city-menu" aria-autocomplete="list">');
        box.shadowRoot.querySelector(".slot").append(field);
        document.querySelector("oc-personal-information").append(box);
        const input = field.shadowRoot.querySelector("input");
        // The first Down after its menu shows is let pass, as the site's
        // was once (LinkedIn, 2026-11-05), and an Enter in the box clears it.
        let passed = false;
        input.addEventListener("input", () => {
          clearTimeout(input.offer);
          input.offer = setTimeout(() => {
            box.shadowRoot.querySelector('[role="listbox"]')?.remove();
            const menu = document.createElement("div");
            menu.setAttribute("role", "listbox");
            menu.id = "city-menu";
            for (const name of ["Fill manually", input.value + ", AZ, United States"]) {
              const option = document.createElement("spl-select-option");
              option.textContent = name;
              option.addEventListener("click", (event) => { if (event.isTrusted) box.setAttribute("value", name); });
              menu.append(option);
            }
            input.position = undefined;
            passed = false;
            box.shadowRoot.append(menu);
          }, 300);
        });
        // Down moves through the entries and Enter takes the highlighted
        // one, as the site's does; the entries ignore a script's click, as
        // the site's did (the applicant's account, 2026-11-04).
        // Down moves focus into the menu, onto its next entry, and the Enter
        // lands on that entry, as the site's does.
        const step = (event) => {
          const options = [...box.shadowRoot.querySelectorAll("spl-select-option")];
          // ?deaf: every Down is let pass, as Intuitive's Company menu did
          // (2026-11-07); only a real click on its entry takes it.
          if (event.key === "ArrowDown" && (!passed || location.search.includes("deaf"))) { passed = true; return; }
          if (event.key === "Enter" && event.composedPath()[0] === input) { input.value = ""; return; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            input.position = event.key === "ArrowDown" ? Math.min((input.position ?? -1) + 1, options.length - 1) : Math.max((input.position ?? 0) - 1, 0);
            options[input.position].shadowRoot.querySelector('[role="option"]').focus();
          }
          if (event.key === "Enter" && input.position !== undefined && event.composedPath().includes(options[input.position])) box.setAttribute("value", options[input.position].textContent);
        };
        input.addEventListener("keydown", step);
        box.shadowRoot.addEventListener("keydown", (event) => { if (!event.composedPath().includes(input)) step(event); });
      }</script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${smartRecruitersOrigin}/oneclick-ui/company/Acme/publication/1${mode === "deaf" ? "?deaf" : ""}`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect.poll(() => page.evaluate(() => document.querySelector("spl-autocomplete")!.getAttribute("value")), { timeout: 45_000 }).toBe(`${profile.city}, AZ, United States`);
});

// Microsoft's careers form (2026-11-07): a list draws its options only once
// opened, from its arrow, and its sponsorship question, read with none, went
// unanswered; a multiselect shows its picks as pills beside a read-only box,
// and a chosen location was reported as missing.
test("Microsoft's lists are read before answering, and a multiselect's pills are its value", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, workAuthorization: "Yes", sponsorship: "No" } });
  const select = (id: string, label: string, list: string) => `
    <div class="field"><label id="${id}_label" for="${id}">${label}</label>
      <div class="select-module_select-wrapper__x" id="${id}">
        <div class="select-module_select-input-group__x"><input aria-controls="${list}" aria-expanded="false" aria-labelledby="${id}_label" aria-required="true" role="combobox" class="select-module_select-input__bO0s9" readonly type="text">
        <div class="input-module_action-wrapper__x"><button aria-hidden="true" tabindex="-1" type="button" class="arrow"></button></div></div>
      </div></div>`;
  await context.route(`${origin}/microsoft-lists`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Submit application</title><main><form onsubmit="return false">
        <div class="field"><label id="loc_label" for="loc">Where would you like to apply for Research Intern</label>
          <div class="select-module_select-wrapper__x select-module_select-wrapper-multiple__x" id="loc">
            <div class="select-module_multi-select-pills__x"><div class="pills-module_tag-pills__x select-module_multi-select-pill__x"><span class="pills-module_label__x">United States, Washington, Redmond</span></div></div>
            <div class="select-module_select-input-group__x"><input aria-controls="list-9" aria-expanded="false" aria-labelledby="loc_label" aria-required="true" role="combobox" class="select-module_select-input__bO0s9" readonly type="text">
            <div class="input-module_action-wrapper__x"><button aria-hidden="true" tabindex="-1" type="button" class="arrow"></button></div></div>
          </div></div>
        ${select("sponsor", "In order to obtain or maintain employment eligibility, will you now or in the future require the company's sponsorship for an immigration-related employment benefit (i.e., a work visa, work permit, etc.)?", "list-44")}
      </form></main><script>
        // Only its arrow opens it, and its options are drawn then.
        const input = document.querySelector('#sponsor input');
        const open = () => {
          if (input.getAttribute('aria-expanded') === 'true') return;
          const list = document.createElement('ul');
          list.id = 'list-44';
          list.setAttribute('role', 'listbox');
          list.innerHTML = ['Yes', 'No'].map((name, i) => '<li><button type="button" role="option" id="list-44-option-' + i + '" title="' + name + '">' + name + '</button></li>').join('');
          // A click on an option only lights it, as the site's did; Down
          // and Up move the light, and Enter keeps the lit one.
          list.querySelectorAll('button').forEach((button) => button.addEventListener('click', (event) => {
            input.setAttribute('aria-activedescendant', button.id);
            if (event.isTrusted) { input.value = button.title; close(); }
          }));
          document.body.append(list);
          input.setAttribute('aria-expanded', 'true');
        };
        input.addEventListener('keydown', (event) => {
          const buttons = [...document.querySelectorAll('#list-44 button')];
          if (!buttons.length) return;
          const at = buttons.findIndex((button) => button.id === input.getAttribute('aria-activedescendant'));
          // As on the live site: its arrows light nothing (2026-11-07); a real
          // click on an option keeps it.
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') event.preventDefault();
          if (event.key === 'Enter' && at >= 0) { input.value = buttons[at].title; close(); }
        });
        // Closing hands focus back to the box, as the site's does.
        const close = () => { document.getElementById('list-44')?.remove(); input.setAttribute('aria-expanded', 'false'); setTimeout(() => input.focus(), 50); };
        document.querySelector('#sponsor .arrow').addEventListener('click', open);
        input.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
        document.addEventListener('mousedown', (event) => { if (!event.target.closest('#sponsor, #list-44')) close(); });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/microsoft-lists`);
  await panel.bringToFront();
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
  const fields = (await ui({ type: "SCAN_TAB", tabId })).observation.fields as { label: string; value: string }[];
  expect(fields.find((field) => /Where would you like/.test(field.label))?.value).toBe("United States, Washington, Redmond");
  expect((fields as unknown as { label: string; kind: string }[]).find((field) => /sponsorship/.test(field.label))?.kind).toBe("combobox");
  await enqueue([page]);
  await expect(page.locator("#sponsor input")).toHaveValue("No", { timeout: 45_000 });
  // Kept, and its list closed.
  await expect(page.locator("#list-44")).toHaveCount(0);
});

// SmartRecruiters' screening questions (LinkedIn's, 2026-11-04): each list
// is an spl-autocomplete whose menu sits in its shadow root, one root above
// the box, and whose options draw role="option" in their own shadow roots;
// a script's click on one is ignored, and only Down and Enter choose it. Its
// Yes and No are spl-radio choices slotted into a group drawn in a shadow
// root. Every list waited 5 seconds for options it never saw, and each Yes
// and No was refused as "another field has the same label".
test("SmartRecruiters' screening lists and slotted Yes/No choices are answered", async () => {
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, veteranStatus: "No", neverWorkedForApplyingCompanies: true, education: [{ organization: "Penn State", title: "Masters of Science", startDate: "2025-08-21", endDate: "2099-12-13" }] },
  });
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  await context.route(`${smartRecruitersOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Screening</title><main><form onsubmit="return false">
        <spl-radio-group id="spl-form-element_105" required><span slot="label-content">Have you ever worked for Acme or any of its affiliates?</span>
          <spl-radio id="spl-form-element_106" label="Yes" role="radio" aria-checked="false" value="1" tabindex="0"></spl-radio>
          <spl-radio id="spl-form-element_107" label="No" role="radio" aria-checked="false" value="0" tabindex="-1"></spl-radio>
        </spl-radio-group>
        <div id="month-slot"></div><div id="veteran-slot"></div><div id="past-slot"></div>
      </form></main><script>{
        customElements.define("spl-radio-group", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML =
          '<label id="group-label"><span><slot name="label-content"></slot><span aria-hidden="true">*</span></span></label><fieldset role="radiogroup" aria-labelledby="group-label" aria-required="true"><slot></slot></fieldset>'; } });
        customElements.define("spl-radio", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<label><span>' + this.getAttribute("label") + '</span></label>';
          this.addEventListener("click", () => { for (const radio of this.parentElement.querySelectorAll("spl-radio")) radio.setAttribute("aria-checked", String(radio === this)); }); } });
        // Its option is drawn only once its list first opens, as the site's are.
        customElements.define("spl-select-option", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }); }
          draw() { if (!this.shadowRoot.innerHTML) this.shadowRoot.innerHTML = '<div role="option" tabindex="-1" aria-selected="false"><slot></slot></div>'; } });
        const list = (slot, id, label, names, multi = false) => {
          const box = document.createElement(multi ? "spl-multiselect-autocomplete" : "spl-autocomplete");
          box.id = id;
          const root = box.attachShadow({ mode: "open" });
          // Its options are made only when it first opens, as the site's are.
          root.innerHTML = '<label for="' + id + '">' + label + '</label><div class="trigger"></div><div id="menu-' + id + '" role="listbox" hidden></div>';
          const field = document.createElement("spl-input");
          field.attachShadow({ mode: "open" }).innerHTML = '<input id="' + id + '" type="text" role="combobox" aria-label="' + label + '" aria-controls="menu-' + id + '" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-required="true">';
          root.querySelector(".trigger").append(field);
          document.getElementById(slot).append(box);
          const input = field.shadowRoot.querySelector("input");
          const menu = root.querySelector('[role="listbox"]');
          let position = -1;
          // Whether a key has moved the list's place since it opened.
          let moved = false;
          const options = () => [...menu.querySelectorAll("spl-select-option")];
          const light = () => options().forEach((option, index) => option.shadowRoot.querySelector('[role="option"]').classList.toggle("active", index === position));
          // It opens with its first entry lit, as the site's does; Down
          // moves the light on from there.
          const open = () => { if (!menu.hidden) return;
            if (!menu.children.length) menu.innerHTML = names.map((name, index) => '<spl-select-option value="id-' + index + '"><span>' + name + '</span></spl-select-option>').join("");
            options().forEach((option) => option.draw()); menu.hidden = false; input.setAttribute("aria-expanded", "true"); position = 0; moved = false; light(); };
          input.addEventListener("mousedown", open);
          input.addEventListener("click", open);
          // A press elsewhere closes it.
          document.addEventListener("mousedown", (event) => { if (!event.composedPath().includes(box)) { menu.hidden = true; input.setAttribute("aria-expanded", "false"); position = -1; } });
          const step = (event) => {
            // Down and Up move the list's own place, and focus with it; an
            // entry focused any other way leaves the place where it was.
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (menu.hidden) open();
              else position = event.key === "ArrowDown" ? Math.min(position + 1, options().length - 1) : Math.max(position - 1, 0);
              moved = true;
              light();
              options()[position].shadowRoot.querySelector('[role="option"]').focus();
            }
            // Only a real Enter on the focused option takes it.
            // A multiselect takes only an Enter on the entry itself: one in
            // the box closes it with nothing taken, as LinkedIn's does.
            if (multi && event.key === "Enter" && event.isTrusted && (!moved || !event.composedPath().includes(options()[position]))) {
              menu.hidden = true; input.setAttribute("aria-expanded", "false"); position = -1;
              return;
            }
            if (event.key === "Enter" && event.isTrusted && position >= 0 && !menu.hidden) {
              // A multiselect keeps its box empty and shows each pick as a
              // tag named by its label attribute.
              if (multi) {
                // Its picks are its value, the ids of the entries chosen, and
                // a tag each, named only in the tag's own shadow root; Enter on
                // a chosen entry takes it away again, as the site's does.
                const id = options()[position].getAttribute("value");
                const chosen = (box.getAttribute("value") || "").split(",").filter(Boolean);
                box.setAttribute("value", (chosen.includes(id) ? chosen.filter((other) => other !== id) : [...chosen, id]).join(","));
                let tags = root.querySelector("spl-tags-list");
                if (!tags) { tags = document.createElement("spl-tags-list"); tags.attachShadow({ mode: "open" }); root.append(tags); }
                tags.shadowRoot.innerHTML = "";
                for (const kept of box.getAttribute("value").split(",").filter(Boolean)) {
                  const tag = document.createElement("spl-tag");
                  tag.attachShadow({ mode: "open" }).textContent = options().find((option) => option.getAttribute("value") === kept).textContent.trim();
                  tags.shadowRoot.append(tag);
                }
              }
              else input.value = options()[position].textContent.trim();
              menu.hidden = true;
              input.setAttribute("aria-expanded", "false");
              position = -1;
            }
          };
          input.addEventListener("keydown", step);
          menu.addEventListener("keydown", step);
        };
        list("month-slot", "question_month", "Please select your Graduation Month", ${JSON.stringify(months)});
        list("veteran-slot", "question_veteran", "If you believe you belong to any of the categories of protected veterans listed above, please indicate by checking the appropriate box below.", ["I identify as one or more of the classifications of protected veteran listed above", "I am not a protected veteran", "I prefer not to specify"]);
        list("past-slot", "question_past", "Do you currently or have you previously worked at Acme in any capacity? (Select all that apply)", ["Not Applicable", "I currently work at Acme", "I previously worked at Acme"], true);
      }</script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${smartRecruitersOrigin}/oneclick-ui/company/Acme/publication/1/screening`);
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  const value = (id: string) => page.evaluate((id) => document.getElementById(id)!.shadowRoot!.querySelector("spl-input")!.shadowRoot!.querySelector("input")!.value, id);
  await expect.poll(() => value("question_month"), { timeout: 45_000 }).toBe("December");
  await expect.poll(() => value("question_veteran"), { timeout: 45_000 }).toBe("I am not a protected veteran");
  const tags = (id: string) => page.evaluate((id) => [...(document.getElementById(id)!.shadowRoot!.querySelector("spl-tags-list")?.shadowRoot?.querySelectorAll("spl-tag") || [])].map((tag) => tag.shadowRoot!.textContent), id);
  await expect.poll(() => tags("question_past"), { timeout: 45_000 }).toEqual(["Not Applicable"]);
  // The pick is seen as made: no "did not confirm" left on it.
  const app = (await state()).applications.find((candidate: { url: string }) => candidate.url === page.url())!;
  await expect.poll(async () => JSON.stringify((await state()).applications.find((candidate: { id: string }) => candidate.id === app.id)), { timeout: 20_000 }).not.toContain("did not confirm");
  await expect(page.locator("#spl-form-element_107")).toHaveAttribute("aria-checked", "true", { timeout: 45_000 });
  await expect(page.locator("#spl-form-element_106")).toHaveAttribute("aria-checked", "false");
  // No list is left open.
  expect(await page.evaluate(() => [...document.querySelectorAll("spl-autocomplete,spl-multiselect-autocomplete")].filter((box) => box.shadowRoot!.querySelector('[role="listbox"]:not([hidden])')).length)).toBe(0);
  // Filled again, the list already holding its answer keeps it: picked a
  // second time, it was taken away (LinkedIn, 2026-11-05).
  const current = async () => (await state()).applications.find((candidate: { id: string }) => candidate.id === app.id)! as unknown as { status: string; operation: number };
  await expect.poll(async () => (await current()).status, { timeout: 45_000 }).toMatch(/^(awaiting-user|ready)$/);
  const first = (await current()).operation;
  await ui({ type: "FILL_STEP", id: app.id });
  await expect.poll(async () => { const now = await current(); return now.operation > first && /^(awaiting-user|ready)$/.test(now.status); }, { timeout: 45_000 }).toBe(true);
  expect(await tags("question_past")).toEqual(["Not Applicable"]);
});

// Carrier's Workday form (report f59d9efd, 2026-10-26): a language row asks
// for an overall level named "All" beside Reading; Reading was filled and All
// was left.
test("a Workday language row's All gets that language's level", async () => {
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: { ...profile, languages: ["English: Native"] },
  });
  await context.route(`${atsOrigins[0]}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>My Experience</title><main>
        <div role="group" aria-labelledby="Languages-section"><h4 id="Languages-section">Languages</h4><button data-automation-id="add-button" type="button" id="addLanguage">Add</button></div>
      </main><script>
        const pick = (button, label, names) => button.addEventListener('click', () => {
          button.setAttribute('aria-expanded', 'true');
          const popup = document.createElement('div');
          popup.setAttribute('data-automation-activepopup', 'true');
          popup.innerHTML = '<ul role="listbox">' + names.map((name) => '<li role="option">' + name + '</li>').join('') + '</ul>';
          popup.querySelectorAll('li').forEach((option) => option.addEventListener('click', () => { button.textContent = option.textContent; if (label) button.setAttribute('aria-label', label + ' ' + option.textContent + ' Required'); button.setAttribute('aria-expanded', 'false'); popup.remove(); }));
          document.body.append(popup);
        });
        document.getElementById('addLanguage').addEventListener('click', () => {
          const row = document.createElement('div');
          row.setAttribute('data-automation-id', 'language-1');
          row.innerHTML = '<div data-automation-id="formField-language"><label>Language</label><button type="button" aria-haspopup="listbox" aria-expanded="false">Select One</button></div>'
            + ['All', 'Reading'].map((label) => '<div data-automation-id="formField-' + label + '"><label for="skill-' + label + '"><span>' + label + '<abbr aria-hidden="true">*</abbr></span></label><button type="button" class="skill" id="skill-' + label + '" aria-haspopup="listbox" aria-expanded="false" aria-label="' + label + ' Select One Required">Select One</button></div>').join('');
          pick(row.querySelector('button'), '', ['English', 'French']);
          row.querySelectorAll('.skill').forEach((skill) => pick(skill, skill.id.slice(6), ['Select One', 'Beginner', 'Intermediate', 'Expert']));
          document.querySelector('[aria-labelledby="Languages-section"]').append(row);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/en-US/acme/job/Remote/Engineer_JR1/apply/applyManually`);
  await enqueue([page]);
  await expect(page.locator('[data-automation-id="formField-language"] button')).toHaveText(["English"], { timeout: 60000 });
  await expect(page.locator(".skill")).toHaveText(["Expert", "Expert"], { timeout: 30000 });
});

// WEC Energy Group's SuccessFactors profile (report 7810d2d5, 2026-10-15):
// rows the site filled from the resume, the first a current job with no End
// Date box, the second current too, the third ended. The third's end date was
// written into the second row's box.
test("a SuccessFactors end date goes only into its own job's row", async () => {
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      work: [
        { organization: "Example Labs", title: "Associate", location: "", details: "", startDate: "2026-03-27", endDate: "" },
        { organization: "Sample Studio", title: "Founder", location: "", details: "", startDate: "2025-03-01", endDate: "" },
        { organization: "Demo AI", title: "Intern", location: "", details: "", startDate: "2023-07-03", endDate: "2023-09-08" },
      ],
    },
  });
  const picker = (name: string, value: string) =>
    `<div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel">${name}</label><div class="fieldComponentInput"><div class="datePicker"><ui5-date-picker-xweb-calendar-widget accessible-name="${name}" title="${name}" value="${value}"></ui5-date-picker-xweb-calendar-widget></div></div></div>`;
  const row = (company: string, title: string, from: string, end?: string) =>
    `<div class="layoutWrapper row rcmSectionComponent rowBreak"><div class="leftColumn col-xs-12"><div class="row">
      <div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;Company Name</label><div class="fieldComponentInput"><input type="text" name="VFLD1" value="${company}"></div></div>
      <div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;Title</label><div class="fieldComponentInput"><input type="text" name="VFLD3" value="${title}"></div></div>
      ${picker("From Date", from)}${end === undefined ? "" : picker("End Date", end)}
    </div></div></div>`;
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Candidate Profile</title><main>
        <div class="rcmFormSection row"><h2 class="sectionTitle"><button class="topBar rcmFormSectionTopBar"><span>Previous employment</span></button></h2>
          <div role="group" class="sectionContent">
            ${row("Example Labs", "Associate", "03/27/2026")}
            ${row("Sample Studio", "Founder", "03/01/2025", "")}
            ${row("Demo AI", "Intern", "07/03/2023", "09/08/2023")}
          </div></div>
      </main><script>
        customElements.define('ui5-datetime-input-xweb-calendar-widget', class extends HTMLElement {
          constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<input class="ui5-input-inner" type="text">'; }
        });
        customElements.define('ui5-date-picker-xweb-calendar-widget', class extends HTMLElement {
          constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<ui5-datetime-input-xweb-calendar-widget></ui5-datetime-input-xweb-calendar-widget>'; this._value = this.getAttribute('value') || ''; }
          connectedCallback() { const inner = this.shadowRoot.querySelector('ui5-datetime-input-xweb-calendar-widget').shadowRoot.querySelector('input'); inner.value = this._value; }
          get value() { return this._value; }
          set value(v) { this._value = v; this.setAttribute('value', v); }
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture&navBarLevel=MY_PROFILE`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 60000 }).toMatch(/^(awaiting-user|ready)$/);
  await page.waitForTimeout(1000);
  const ends = page.locator('ui5-date-picker-xweb-calendar-widget[accessible-name="End Date"]');
  await expect(ends.nth(0)).toHaveAttribute("value", "");
  await expect(ends.nth(1)).toHaveAttribute("value", "09/08/2023");
});

// Westinghouse's SuccessFactors (report cc40f1fb, 2026-10-27): the site filled
// the jobs from the resume with other jobs' end dates, and a job still held
// kept "05/27/2025" because the profile had no end date to write over it.
test("a SuccessFactors end date the site filled under a current job is emptied", async () => {
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      work: [
        { organization: "Example Labs", title: "Associate", location: "", details: "", startDate: "2026-03-27", endDate: "" },
        { organization: "Sample Studio", title: "Founder", location: "", details: "", startDate: "2025-03-01", endDate: "" },
        { organization: "Demo AI", title: "Intern", location: "", details: "", startDate: "2023-07-03", endDate: "2023-09-08" },
      ],
    },
  });
  const picker = (name: string, value: string) =>
    `<div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel">${name}</label><div class="fieldComponentInput"><div class="datePicker"><ui5-date-picker-xweb-calendar-widget accessible-name="${name}" title="${name}" value="${value}"></ui5-date-picker-xweb-calendar-widget></div></div></div>`;
  const row = (company: string, title: string, from: string, end: string) =>
    `<div class="layoutWrapper row rcmSectionComponent rowBreak"><div class="leftColumn col-xs-12"><div class="row">
      <div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;Company Name</label><div class="fieldComponentInput"><input type="text" name="VFLD1" value="${company}"></div></div>
      <div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;Title</label><div class="fieldComponentInput"><input type="text" name="VFLD3" value="${title}"></div></div>
      ${picker("Start Date", from)}${picker("End Date", end)}
    </div></div></div>`;
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Candidate Profile</title><main>
        <div class="rcmFormSection row"><h2 class="sectionTitle"><button class="topBar rcmFormSectionTopBar"><span>Previous employment</span></button></h2>
          <div role="group" class="sectionContent">
            ${row("Example Labs", "Associate", "03/27/2026", "05/27/2025")}
            ${row("Sample Studio", "Founder", "03/01/2025", "09/08/2023")}
            ${row("Demo AI", "Intern", "07/03/2023", "09/08/2023")}
          </div></div>
      </main><script>
        customElements.define('ui5-datetime-input-xweb-calendar-widget', class extends HTMLElement {
          constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<input class="ui5-input-inner" type="text">'; }
        });
        customElements.define('ui5-date-picker-xweb-calendar-widget', class extends HTMLElement {
          constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<ui5-datetime-input-xweb-calendar-widget></ui5-datetime-input-xweb-calendar-widget>'; this._value = this.getAttribute('value') || ''; }
          connectedCallback() { const inner = this.shadowRoot.querySelector('ui5-datetime-input-xweb-calendar-widget').shadowRoot.querySelector('input'); inner.value = this._value; }
          get value() { return this._value; }
          set value(v) { this._value = v; this.setAttribute('value', v); }
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture&navBarLevel=MY_PROFILE`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 60000 }).toMatch(/^(awaiting-user|ready)$/);
  const ends = page.locator('ui5-date-picker-xweb-calendar-widget[accessible-name="End Date"]');
  await expect(ends.nth(0)).toHaveAttribute("value", "");
  await expect(ends.nth(1)).toHaveAttribute("value", "");
  await expect(ends.nth(2)).toHaveAttribute("value", "09/08/2023");
});

// Westinghouse's SuccessFactors (report cc40f1fb, 2026-10-27): the resume left
// one school row, the profile's second school. Added for the first school,
// the row was looked for by its position and found the old one at once, so
// the first school's name went into the second school's row, and its new
// row got nothing else: no major, country, graduation year or progress.
test("a SuccessFactors school row added beside one the site filled gets that school's own details", async () => {
  test.setTimeout(150000);
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      education: [
        { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05", location: "East Lansing, MI", details: "" },
        { organization: "Virginia Tech", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "Blacksburg, Virginia", details: "" },
      ],
    },
  });
  // The row the site filled is kept as it is, as it was for the applicant:
  // it names its school, so it is that school's row.
  await keepPrefilled();
  const list = (label: string, value = "") =>
    `<div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel">${label}</label><div class="fieldComponentInput"><input role="combobox" aria-label="${label}" placeholder="No Selection" value="${value}" class="rcmpaginatedselectinput"></div></div>`;
  const row = (school = "", degree = "", major = "", country = "", year = "", progress = "") =>
    `<div class="layoutWrapper row rcmSectionComponent rowBreak">
      <div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;Institution/School</label><div class="fieldComponentInput"><input type="text" name="VFLD1" value="${school}"></div></div>
      ${list("Highest Degree Achieved", degree)}${list("Country", country)}${list("Major", major)}${list("Graduation Year, if applicable", year)}${list("Progress", progress)}
    </div>`;
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Career Opportunities: Apply for Summer Intern</title><main>
        <div id="246:section" class="rcmFormSection row">
          <h2 class="sectionTitle"><button class="topBar rcmFormSectionTopBar"><span>Education</span></button></h2>
          <div id="eduRows">${row("Virginia Tech", "Bachelor's Degree", "Computer Science", "United States", "2024", "Degree Complete")}</div>
          <div id="246:_addRowBtn" role="button" title="Add new row" class="addRowButton">Add</div>
        </div>
      </main><script>
        const options = {
          'Highest Degree Achieved': ["Bachelor's Degree", "Master's Degree"],
          Country: ['Afghanistan', 'Albania', 'Algeria', 'India', 'Mexico', 'Peru', 'Spain', 'United Kingdom', 'United States'],
          Major: ['Accounting', 'Computer Science', 'Data Science'],
          'Graduation Year, if applicable': Array.from({ length: 140 }, (_, i) => String(1970 + i)),
          Progress: ['Degree Complete', 'Degree in Progress'],
        };
        // SuccessFactors' lists: a click opens the list's first page, and what
        // was typed narrows it, shortly after a key is let go (typing alone
        // does not). Escape closes it. The site's search of Country finds
        // nothing, whatever is typed: its search of India's states found no
        // "Telangana", which the list holds (Westinghouse, report d57dca7e).
        let searching;
        const searchable = (input) => ['click', 'keyup', 'keydown'].forEach((type) => input.addEventListener(type, (event) => {
          if (event.type === 'keydown') { if (event.key === 'Escape') document.querySelector('ul.sf-list-select')?.remove(); return; }
          if (event.type === 'click' && document.querySelector('ul.sf-list-select')) return;
          document.querySelector('ul.sf-list-select')?.remove();
          clearTimeout(searching);
          if (event.type !== 'click' && !input.value) return;
          const typed = event.type === 'click' ? '' : input.value;
          const label = input.getAttribute('aria-label');
          searching = setTimeout(() => {
            const list = document.createElement('ul');
            list.className = 'sf-list-select';
            const found = typed && label === 'Country' ? [] : options[label].filter((n) => n.toLowerCase().includes(typed.toLowerCase())).slice(0, 10);
            if (!found.length) list.innerHTML = '<li role="alert" class="no-results">There were no results</li>';
            for (const name of found) {
              const item = document.createElement('li');
              item.setAttribute('role', 'option');
              item.innerHTML = '<a title="' + name + '">' + name + '</a>';
              item.querySelector('a').addEventListener('click', () => { input.value = name; input.dataset.picked = name; list.remove(); });
              list.append(item);
            }
            document.body.append(list);
          }, 300);
        }));
        document.querySelectorAll('[role=combobox]').forEach(searchable);
        // The new row is drawn a moment after the click.
        document.getElementById('246:_addRowBtn').addEventListener('click', () => setTimeout(() => {
          document.getElementById('eduRows').insertAdjacentHTML('beforeend', ${JSON.stringify(row())});
          document.querySelectorAll('#eduRows .rcmSectionComponent:last-child [role=combobox]').forEach(searchable);
        }, 400));
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 120000 }).toMatch(/^(awaiting-user|ready)$/);
  const schools = page.locator('[name="VFLD1"]');
  await expect(schools).toHaveCount(2);
  await expect(schools.nth(0)).toHaveValue("Virginia Tech");
  await expect(schools.nth(1)).toHaveValue("Michigan State University");
  const added = page.locator("#eduRows .rcmSectionComponent").nth(1);
  await expect(added.locator('[aria-label="Major"]')).toHaveValue("Data Science");
  await expect(added.locator('[aria-label="Country"]')).toHaveValue("United States");
  await expect(added.locator('[aria-label="Graduation Year, if applicable"]')).toHaveValue("2099");
  await expect(added.locator('[aria-label="Progress"]')).toHaveValue("Degree in Progress");
  const kept = page.locator("#eduRows .rcmSectionComponent").nth(0);
  await expect(kept.locator('[aria-label="Major"]')).toHaveValue("Computer Science");
  await expect(kept.locator('[aria-label="Graduation Year, if applicable"]')).toHaveValue("2024");
});

// Westinghouse's SuccessFactors (report d57dca7e, 2026-10-28): three jobs and
// two schools, with lists that found none of a job's places, five seconds
// each. A minute in, the pass ended while the second school's Highest Degree
// Achieved list was loading; "Master" stayed typed in the box, unpicked, and
// the site emptied it.
test("a long SuccessFactors form still picks the degree of a school after a minute of empty searches", async () => {
  test.setTimeout(240000);
  const jobs = ["Example Labs", "Sample Studio", "Demo AI", "Test Works"];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      work: jobs.map((organization) => ({ organization, title: "Intern", location: "Tucson, AZ", details: "", startDate: "2023-06", endDate: "2023-09" })),
      education: [
        { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05", location: "", details: "" },
      ],
    },
  });
  const list = (label: string, delay: number) =>
    `<div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;${label}</label><div class="fieldComponentInput"><input role="combobox" aria-label="${label}" placeholder="No Selection" data-delay="${delay}" class="rcmpaginatedselectinput"></div></div>`;
  const job = (company: string) =>
    `<div class="layoutWrapper row rcmSectionComponent rowBreak">
      <div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;Company Name</label><div class="fieldComponentInput"><input type="text" name="VFLD1" value="${company}"></div></div>
      ${list("Country", 300)}
    </div>`;
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Career Opportunities: Apply for Summer Intern</title><main>
        <div class="rcmFormSection row"><h2 class="sectionTitle"><button class="topBar rcmFormSectionTopBar"><span>Previous Employment</span></button></h2>
          ${jobs.map(job).join("")}</div>
        <div class="rcmFormSection row"><h2 class="sectionTitle"><button class="topBar rcmFormSectionTopBar"><span>Education</span></button></h2>
          <div class="layoutWrapper row rcmSectionComponent rowBreak">
            <div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel"><span class="requiredField">*</span>&nbsp;Institution/School</label><div class="fieldComponentInput"><input type="text" name="school" value="Michigan State University"></div></div>
            ${list("Highest Degree Achieved", 2000)}
          </div></div>
      </main><script>
        const options = {
          Country: ['Canada', 'Mexico'],
          'Highest Degree Achieved': ["No Selection", "Bachelor's Degree", "Master's Degree"],
        };
        // SuccessFactors' lists: what was typed narrows the list, once the
        // site's server answers (2.1 s for the reported degree list).
        let searching;
        document.querySelectorAll('[role=combobox]').forEach((input) => ['keyup', 'input'].forEach((type) => input.addEventListener(type, () => {
          document.querySelector('ul.sf-list-select')?.remove();
          clearTimeout(searching);
          if (!input.value) return;
          const typed = input.value;
          searching = setTimeout(() => {
            const list = document.createElement('ul');
            list.className = 'sf-list-select';
            for (const name of options[input.getAttribute('aria-label')].filter((n) => n.toLowerCase().includes(typed.toLowerCase()))) {
              const item = document.createElement('li');
              item.setAttribute('role', 'option');
              item.innerHTML = '<a title="' + name + '">' + name + '</a>';
              item.querySelector('a').addEventListener('click', () => { input.value = name; input.dataset.picked = name; list.remove(); });
              list.append(item);
            }
            document.body.append(list);
          }, Number(input.dataset.delay));
        })));
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture`);
  await enqueue([page]);
  await expect(page.locator('[aria-label="Highest Degree Achieved"]')).toHaveAttribute("data-picked", "Master's Degree", { timeout: 200000 });
});

// Westinghouse's SuccessFactors (report cc40f1fb, 2026-10-27): the question is
// a note above the list ("1. Are you one of the following? U.S. Citizen or
// National…"), and the list itself is only "Make Selection Here".
test("a SuccessFactors list labelled only Make Selection Here answers the question in the note above it", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, workAuthorization: "US Citizen" } });
  const list = (id: string, label: string) =>
    `<div class="col-md-4 col-xs-12 col-sm-4"><div class="RCMFormField rcmFormElement"><label class="rcmFormFieldLabel" for="${id}"><span class="requiredField">*</span>&nbsp;${label}</label><div class="fieldComponentInput"><span class="sfCascadingPicklist"><input id="${id}" role="combobox" aria-label="${label}" aria-required="true" aria-expanded="false" aria-owns="${id}_listSelect" placeholder="No Selection" class="rcmpaginatedselectinput"></span></div></div></div>`;
  await context.route(`${sapsfOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Career Opportunities: Apply for Summer Intern</title><main>
        <div class="rcmFormSection row"><h2 class="sectionTitle"><button class="topBar rcmFormSectionTopBar"><span>Job-Specific Information</span></button></h2>
          <div class="sectionContent">
            <div class="col-xs-12"><div class="RCMFormField rcmFormElement instructionField" role="note"><label class="rcmFormFieldLabel" for=""></label><div class="fieldComponentInput"><span><b>1. Are you one of the following?</b></span><ul><li>U.S. Citizen or National</li><li>U.S. Lawful Permanent Resident.</li><li>Person granted Refugee status in the United States.</li><li>Person granted Asylum in the United States.</li></ul></div></div></div>
            <div class="clearfix visible-xs"></div>
            ${list("selection", "Make Selection Here")}
            <div class="col-xs-12"><div class="RCMFormField rcmFormElement instructionField" role="note"><div class="fieldComponentInput">Important Note: If your answer to Question 1 above is "Yes", please list US as "Country 1 Name".</div></div></div>
            ${list("country1", "Country 1 Name")}
          </div>
        </div>
      </main><script>
        const options = { selection: ['No Selection', 'No', 'Yes'], country1: ['No Selection', 'United Kingdom', 'United States'] };
        for (const input of document.querySelectorAll('[role=combobox]')) {
          input.addEventListener('click', () => {
            if (document.querySelector('ul.sf-list-select[data-for="' + input.id + '"]')) return;
            document.querySelectorAll('ul.sf-list-select').forEach((open) => open.remove());
            input.setAttribute('aria-expanded', 'true');
            setTimeout(() => {
              const list = document.createElement('ul');
              list.className = 'sf-list-select';
              list.dataset.for = input.id;
              list.id = input.id + '_listSelect';
              list.setAttribute('role', 'listbox');
              for (const name of options[input.id]) {
                const item = document.createElement('li');
                item.setAttribute('role', 'option');
                item.innerHTML = '<a role="menuitem" title="' + name + '">' + name + '</a>';
                item.querySelector('a').addEventListener('click', () => { input.value = name; list.remove(); input.setAttribute('aria-expanded', 'false'); });
                list.append(item);
              }
              document.body.append(list);
            }, 200);
          });
          input.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            document.querySelector('ul.sf-list-select')?.remove();
            input.setAttribute('aria-expanded', 'false');
          });
        }
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${sapsfOrigin}/portalcareer?company=fixture`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 60000 }).toMatch(/^(awaiting-user|ready)$/);
  await expect(page.locator("#selection")).toHaveValue("Yes");
  await expect(page.locator("#country1")).toHaveValue("United States");
});

// L3Harris's SuccessFactors form (report 9a11d03e, 2026-10-15): saving the
// uploaded resume rebuilt the form with the site's own guesses where the
// fill's values were ("UNSPECIFIED", a month's first day), and those were
// then kept as if chosen. Nobody typed there: the next fill corrects them.
test("values a site writes into a rebuilt form are corrected by the next fill", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, currentCompany: "Example Labs", city: "Phoenix" } });
  await context.route(`${origin}/rebuilding-form`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form id="form">
        <label>Current company<input name="company"></label>
        <label>City<input name="city"></label>
      </form><script>
        // Seconds after the fill has written (as after saving an upload), the
        // site rebuilds the form with its own values.
        const watch = setInterval(() => {
          if (document.querySelector('[name="company"]').value !== 'Example Labs') return;
          clearInterval(watch);
          setTimeout(() => {
            document.getElementById('form').innerHTML = '<label>Current company<input name="company" value="UNSPECIFIED"></label><label>City<input name="city" value="Tucson"></label>';
            window.rebuilt = true;
          }, 3000);
        }, 100);
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/rebuilding-form`);
  await enqueue([page]);
  await expect.poll(() => page.evaluate(() => (window as any).rebuilt), { timeout: 30000 }).toBe(true);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 30000 }).toMatch(/^(awaiting-user|ready|paused)$/);
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
  await expect(page.locator('[name="company"]')).toHaveValue("Example Labs", { timeout: 30000 });
  await expect(page.locator('[name="city"]')).toHaveValue("Phoenix");
});

// L3Harris's SuccessFactors form (report 56e13a52, 2026-10-15): the site's
// resume parser wrote "UNSPECIFIED" as a company, and with site values kept
// it stayed. A placeholder is no answer: it is replaced; a real value stays.
test("a placeholder the site wrote is replaced even when site values are kept", async () => {
  await keepPrefilled();
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, currentCompany: "Example Labs", city: "Phoenix" } });
  await context.route(`${origin}/placeholder-form`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <label>Current company<input name="company" value="UNSPECIFIED"></label>
        <label>City<input name="city" value="Tucson"></label>
      </form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/placeholder-form`);
  await enqueue([page]);
  await expect(page.locator('[name="company"]')).toHaveValue("Example Labs", { timeout: 60000 });
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 60000 }).toMatch(/^(awaiting-user|ready)$/);
  await expect(page.locator('[name="city"]')).toHaveValue("Tucson");
});

// Workday announces a finished upload in an alert (Jabil, report f062d50f,
// 2026-10-15): "…Resume.pdf successfully uploaded" was reported as a failure.
// AMD's iCIMS (2026-11-07): every list is drawn as an <a role="combobox">
// with no address, and each job's Country was refused as able to navigate.
test("a list drawn as a link with no address is chosen from", async () => {
  await context.route(`${origin}/link-list`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Apply</title><form onsubmit="return false">
        <label id="country-label">Country</label>
        <a id="1_WorkCountry_icimsDropdown" class="dropdown-select" role="combobox" tabindex="0" aria-expanded="false" aria-labelledby="country-label"><span class="dropdown-text"></span></a>
        <div id="1_WorkCountry_icimsDropdown_ctnr" class="dropdown-container"><ul id="1_WorkCountry_dropdown-results" role="listbox" hidden></ul></div>
      </form><script>
        // As iCIMS draws them: the link names no list; the list is in the
        // "_ctnr" box beside it.
        const box = document.getElementById('1_WorkCountry_icimsDropdown');
        const list = document.getElementById('1_WorkCountry_dropdown-results');
        // It opens on a mousedown; a click alone does nothing, as on iCIMS.
        box.addEventListener('mousedown', () => {
          list.innerHTML = ['— Make a Selection —', 'Canada', 'United States', 'Mexico'].map((name) => '<li role="option">' + name + '</li>').join('');
          list.querySelectorAll('[role="option"]').forEach((option) => option.addEventListener('click', () => {
            box.querySelector('.dropdown-text').textContent = option.textContent;
            list.hidden = true;
            box.setAttribute('aria-expanded', 'false');
          }));
          list.hidden = false;
          box.setAttribute('aria-expanded', 'true');
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/link-list`);
  await panel.bringToFront();
  await enqueue([page]);
  await expect(page.locator('[id="1_WorkCountry_icimsDropdown"] .dropdown-text')).toHaveText("United States", { timeout: 45_000 });
});

// AMD's iCIMS screening page (report 4933eec7, 2026-11-07): native lists
// marked role="combobox", naming a listbox that is never drawn. Waited on
// as custom lists, every one ended "Dropdown options were not available".
test("a native list given the combobox role is set as a select", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, workAuthorization: "Yes" } });
  await context.route(`${origin}/native-combobox`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Questions</title><form onsubmit="return false">
        <div class="iCIMS_TableRow"><div id="Q62_questionText" class="iCIMS_InfoField iCIMS_InfoField_Questions iCIMS_TableCell"><label class="iCIMS_LabelText" for="Q62">
Are you legally authorized to work in the United States?<span class="Field_Required"><span class="Field_RequiredStar">*</span></span>
</label></div>
<div class="iCIMS_InfoData iCIMS_InfoData_Questions iCIMS_TableCell"><select id="Q62" name="Q62" data-label="Q62" class=" iCIMS_Forms_Global customFieldContainer iCIMS_Forms_DropDown iCIMS_Forms_Qnull iCIMS_Forms_RequiredField form-control" icimsdropdown-enabled="0" icimsdropdown-ajax="1" icimsdropdown-search="0" icimsdropdown-selected="" aria-labelledby="label_Q62" aria-required="true" i_required="true" aria-describedby="Q62_error" role="combobox" aria-expanded="false" aria-controls="Q62_listbox" aria-activedescendant=""><option legacy="true" value="" selected="">— Make a Selection —</option><option title="Yes" value="Yes" dataid="Yes" sourceid="Yes">Yes</option><option title="No" value="No" dataid="No" sourceid="No">No</option></select></div></div>
      </form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/native-combobox`);
  await enqueue([page]);
  await expect(page.locator("#Q62")).toHaveValue("Yes", { timeout: 40000 });
  expect((await state()).applications[0].missing.join(" ")).not.toContain("Dropdown options were not available");
});

// AMD's iCIMS EEO form (report c1e21ba3, 2026-11-07): radios with no
// labels, each in a span of its own, the option as text after it, and the
// question as the text before them. Read as "icims_f_Veteran", it was left.
test("radios named only by the text beside them answer the veteran question", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, veteranStatus: "I am not a protected veteran" } });
  await context.route(`${origin}/eeo-veteran`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Form</title><form onsubmit="return false"><table><tr><td><span style="font-size: 13px; font-family: arial,helvetica,sans-serif;"><br>2. If you believe you belong to any of the categories of protected veterans listed above, please indicate by checking the appropriate box below. As a Government contractor subject to VEVRAA, we request this information in order to measure the effectiveness of the outreach and positive recruitment efforts we undertake pursuant to VEVRAA.<br><br><span class="iCIMS_Forms_Global customFieldContainer iCIMS_Forms_RadioGroup iCIMS_Forms_QVeteran iCIMS_Forms_RequiredField form-control"><input type="radio" id="icims_f_Veteran_ProtectedVeteran" name="icims_f_Veteran" aria-required="true" i_required="true"></span> I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERAN LISTED ABOVE<br><br><span class="iCIMS_Forms_Global customFieldContainer iCIMS_Forms_RadioGroup iCIMS_Forms_QVeteran iCIMS_Forms_RequiredField form-control"><input type="radio" id="icims_f_Veteran_NotProtectedVeteran" name="icims_f_Veteran" aria-required="true" i_required="true"></span> I AM NOT A PROTECTED VETERAN<br><br><span class="iCIMS_Forms_Global customFieldContainer iCIMS_Forms_RadioGroup iCIMS_Forms_QVeteran iCIMS_Forms_RequiredField form-control"><input type="radio" id="icims_f_Veteran_optout" name="icims_f_Veteran" aria-required="true" i_required="true"></span> I DON'T WISH TO ANSWER<br><br></span></td></tr></table></form>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/eeo-veteran`);
  await enqueue([page]);
  await expect(page.locator("#icims_f_Veteran_NotProtectedVeteran")).toBeChecked({ timeout: 40000 });
  await expect(page.locator("#icims_f_Veteran_ProtectedVeteran")).not.toBeChecked();
});

// Databricks' Greenhouse form (report b3cb8c2b, 2026-11-08): a sanctions
// list and its follow-up. Read as what they ask, "None of the above" and
// "Not applicable" are ticked, and boxes ticked before are cleared; the
// page's own state put "U.S. citizen" back when the next box was ticked,
// and the box is set again.
test("a sanctions list and its follow-up get None and Not applicable, and stay so", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, country: "United States", citizenships: ["US"], willingToRelocate: "Yes" } });
  const list = (id: string, question: string, options: string[], ticked: string[]) =>
    `<fieldset class="checkbox"><legend class="label checkbox__description">${question}</legend>` +
    options.map((option, n) => `<div class="checkbox__wrapper"><div class="checkbox__input"><input type="checkbox" id="${id}[]_${n}" name="${id}[]"${ticked.includes(option) ? " checked" : ""}></div><label for="${id}[]_${n}">${option}</label></div>`).join("") + `</fieldset>`;
  const sanctions = "Please confirm whether any of the below applies to you. Select all that apply. Note: This information will only be used to ensure compliance with U.S. sanctions and export controls.";
  const followUp = "If you selected a response to the prior question other than “none of the above,” please confirm whether any of the following also applies to you. Select all that apply.";
  await context.route(`${origin}/sanctions-list`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Apply</title><form onsubmit="return false"><label>First name<input name="first"></label>
        ${list("q1", sanctions, ["Citizen or permanent resident of Cuba, Iran, North Korea, or Syria", "Ordinarily a resident of Russia or Belarus and not willing to relocate for a Databricks role", "None of the above"], ["Ordinarily a resident of Russia or Belarus and not willing to relocate for a Databricks role"])}
        ${list("q2", followUp, ["U.S. citizen", "U.S. permanent resident (Green Card holder)", "Not applicable (i.e., I selected “none of the above” for the prior question)"], ["U.S. citizen"])}
      </form><script>{
        // The page keeps its own state and draws the boxes from it after
        // each click; it misses the first change of "U.S. citizen".
        const state = new Map([...document.querySelectorAll('input[type="checkbox"]')].map((box) => [box.id, box.checked]));
        let missed = false;
        document.addEventListener("click", (event) => {
          const box = event.target.closest('input[type="checkbox"]');
          if (!box) return;
          if (box.id === "q2[]_0" && !missed) missed = true;
          else state.set(box.id, box.checked);
          setTimeout(() => { for (const [id, checked] of state) document.getElementById(id).checked = checked; }, 50);
        });
      }</script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/sanctions-list`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.status, { timeout: 40000 }).toMatch(/awaiting-user|ready/);
  await page.waitForTimeout(1000);
  const ticked = await page.locator('input[type="checkbox"]').evaluateAll((boxes) => boxes.map((box) => `${box.id}:${(box as HTMLInputElement).checked}`));
  expect(ticked).toEqual(["q1[]_0:false", "q1[]_1:false", "q1[]_2:true", "q2[]_0:false", "q2[]_1:false", "q2[]_2:true"]);
  // Answered, so not listed as left for the applicant.
  expect((await state()).applications[0].missing.join(" ")).not.toContain("Legal or eligibility question left for you");
});

test("an upload the site announces as successful is not reported as failed", async () => {
  await context.route(`${origin}/announcing-uploader`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Application</title><form>
        <label>Email<input name="email" type="email"></label>
        <div class="field"><label>Resume/CV<input type="file" name="resume" accept=".pdf"></label>
          <div role="alert" class="status"></div></div>
      </form>
      <script>
        // As Workday does: "loading", then "successfully uploaded", the input
        // emptied and the file listed beside it (report f0a42a0f).
        window.uploads = 0;
        const input = document.querySelector('[name="resume"]');
        input.addEventListener("change", () => {
          const name = input.files[0].name;
          window.uploads++;
          document.querySelector('[role="alert"]').textContent = name + " loading";
          setTimeout(() => {
            document.querySelector('[role="alert"]').textContent = name + " successfully uploaded";
            input.value = "";
            const listed = document.createElement("div");
            listed.innerHTML = '<span></span><button type="button" aria-label="Delete file">x</button>';
            listed.querySelector("span").textContent = name;
            input.closest(".field").append(listed);
          }, 400);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/announcing-uploader`);
  await enqueue([page]);
  await expect.poll(() => page.locator('[role="alert"]').textContent(), { timeout: 25000 }).toMatch(/successfully uploaded/);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 25000 }).toMatch(/^(awaiting-user|ready)$/);
  expect((await state()).applications[0].missing.join(" ")).not.toMatch(/upload failed on the site/);
  // A second fill of the same step does not send the same document again.
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 25000 }).toMatch(/^(awaiting-user|ready)$/);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).uploads)).toBe(1);
});

async function icimsProfileFill(options: { schoolListed?: boolean }) {
  const current = await ui({ type: "API", path: "/v1/profile" });
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...current,
      confirmed: true,
      // As in the applicant's profile: the country is spelled out, which the
      // ported config shortens to "United State".
      country: "United States of America",
      state: "Arizona",
      education: [
        { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "M.S. Data Science, Statistics & Engineering (Applied Systems)", startDate: "2025-08-19", endDate: "2027-05", location: "", details: "" },
        { organization: "Pennsylvania State University, University Park", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "", details: "" },
      ],
    },
  });
  const site = "https://careers-acme.icims.com";
  await context.route(`${site}/jobs/1/intern/candidate**`, (route) =>
    route.fulfill({ contentType: "text/html", body: icimsCandidatePage(options) }),
  );
  const page = await context.newPage();
  await page.goto(`${site}/jobs/1/intern/candidate?from=login`);
  await enqueue([page]);
  const row = (n: number) => page.locator(".iCIMS_CollectionContainer").nth(n);
  const text = (n: number, field: string) =>
    row(n).locator(`a[id$="_CandProfileFields.${field}_icimsDropdown"]`);
  // One request finishes after the site's rebuild.
  await expect(text(0, "School")).toHaveText("Michigan State University", { timeout: 90000 });
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 90000 })
    .toMatch(/awaiting-user|ready/);
  // Profile order: MSU first, whatever the parser guessed.
  await expect(text(0, "Degree")).toHaveText("Masters Degree");
  // Found by searching the shorter name; not "Engineering" from the
  // unfiltered first page.
  await expect(text(0, "Major")).toHaveText("Data Science");
  // "In Progress", the first of the rule's two answers for an unfinished
  // degree, over the parser's "Received" (AMD, 2026-11-07).
  await expect(row(0).locator("select[id$='IsGraduated']")).toHaveValue("28595");
  await expect(row(0).locator("select[name$='EducationStartDate_Month']")).toHaveValue("08");
  await expect(row(0).locator("select[name$='EducationStartDate_Date']")).toHaveValue("19");
  await expect(row(0).locator("input[name$='EducationStartDate_Year']")).toHaveValue("2025");
  await expect(row(0).locator("input[name$='OtherSchool']")).toHaveValue("");
  await expect(text(1, "Degree")).toHaveText("Bachelors Degree");
  await expect(text(1, "Major")).toHaveText("Computer Science");
  await expect(row(1).locator("select[id$='IsGraduated']")).toHaveValue("28598");
  await expect(row(1).locator("input[name$='EducationStartDate_Year']")).toHaveValue("2020");
  await expect(row(1).locator("select[name$='EducationStartDate_Month']")).toHaveValue("09");
  await expect(row(1).locator("select[name$='EducationStartDate_Date']")).toHaveValue("1");
  // The address keeps its state: the country was already right.
  await expect(page.locator("a[id$='AddressState_icimsDropdown']")).toHaveText("Arizona");
  expect(await page.evaluate(() => (window as any).stateResets)).toBe(0);
  // The parser's extra row is gone, and the review says so.
  await expect(page.locator(".iCIMS_CollectionContainer")).toHaveCount(2);
  expect((await state()).applications[0].missing.join(" ")).toContain("so it was removed");
  // A parsed answer the rule found already right is not one to check (AMD,
  // 2026-11-07).
  expect((await state()).applications[0].missing.join(" ")).not.toContain("Did You Graduate?");
  expect(await page.evaluate(() => (window as any).uploads)).toBe(1);
  return { text, row };
}

test("an iCIMS profile rebuilt from the resume is corrected in profile order, and the parser's extra row is removed", async () => {
  test.setTimeout(150000);
  const { text, row } = await icimsProfileFill({ schoolListed: true });
  // The right campus, found by searching a shorter name; not Penn State Harrisburg.
  await expect(text(1, "School")).toHaveText("Pennsylvania State University-University Park");
  await expect(row(1).locator("input[name$='OtherSchool']")).toHaveValue("");
  // Filled again, the rows are already right and skipped whole: what the
  // site holds is still read as the profile's, its list by its text and a
  // date's day as a day (AMD, 2026-11-07).
  const before = (await state()).applications[0].attempts.length;
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
  await expect.poll(async () => (await state()).applications[0].attempts.length, { timeout: 60000 }).toBeGreaterThan(before);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 60000 }).toMatch(/^(awaiting-user|ready)$/);
  const review = (await state()).applications[0].missing.join(" ");
  expect(review).not.toContain("Did You Graduate?");
  expect(review).not.toMatch(/Start Date (Day|Month|Year)/);
});

// AMD's iCIMS (2026-11-07): the site showed both schools exactly, the other
// way round from the profile. Paired by position, each took the other's
// graduation and "not listed" box; each row now keeps its own school.
test("iCIMS rows showing both schools in the other order keep their own schools", async () => {
  test.setTimeout(150000);
  const current = await ui({ type: "API", path: "/v1/profile" });
  await ui({
    type: "API", path: "/v1/profile", method: "PUT",
    body: {
      ...current, confirmed: true, country: "United States of America", state: "Arizona",
      education: [
        { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08-19", endDate: "2099-05", location: "", details: "" },
        { organization: "Pennsylvania State University, University Park", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "", details: "" },
      ],
    },
  });
  const site = "https://careers-acme.icims.com";
  await context.route(`${site}/jobs/2/intern/candidate**`, (route) =>
    route.fulfill({ contentType: "text/html", body: icimsCandidatePage({ swapped: true }) }),
  );
  const page = await context.newPage();
  await page.goto(`${site}/jobs/2/intern/candidate?from=login`);
  await enqueue([page]);
  const row = (n: number) => page.locator(".iCIMS_CollectionContainer").nth(n);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 120000 }).toMatch(/awaiting-user|ready/);
  await expect(row(0).locator('a[id$="_CandProfileFields.School_icimsDropdown"]')).toHaveText("Pennsylvania State University-University Park");
  await expect(row(0).locator("select[id$='IsGraduated']")).toHaveValue("28598");
  await expect(row(0).locator("select[name$='EducationStartDate_Year'], input[name$='EducationStartDate_Year']")).toHaveValue("2020");
  await expect(row(1).locator('a[id$="_CandProfileFields.School_icimsDropdown"]')).toHaveText("Michigan State University");
  await expect(row(1).locator("select[id$='IsGraduated']")).toHaveValue("28595");
  await expect(row(1).locator("input[name$='EducationStartDate_Year']")).toHaveValue("2025");
});

test("an iCIMS school missing from the list gets the list's Not Found entry and Other School", async () => {
  test.setTimeout(150000);
  const { text, row } = await icimsProfileFill({ schoolListed: false });
  await expect(text(1, "School")).toHaveText("*School Not Found (enter into Other School)");
  await expect(row(1).locator("input[name$='OtherSchool']")).toHaveValue(
    "Pennsylvania State University, University Park",
  );
});

test("parsed education rows are corrected in profile order, and what cannot be corrected is flagged", async () => {
  test.setTimeout(90000);
  const current = await ui({ type: "API", path: "/v1/profile" });
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...current,
      confirmed: true,
      address: "100 Test Way",
      postalCode: "85001",
      education: [
        { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-05", location: "", details: "", gpa: "3.84", gpaScale: "4" },
        { organization: "Test Polytechnic", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "", details: "" },
      ],
    },
  });
  const row = (n: number) => `
    <fieldset><legend>Education (${n})</legend>
      <label>School Dropdown<select name="school-${n}"><option value=""></option>
        <option>Michigan State University</option><option>University of Michigan</option></select></label>
      <label>Major<input name="major-${n}"></label>
      <label>Overall Result (GPA)<input name="gpa-${n}"></label>
      <label>Did You Graduate?<select name="grad-${n}"><option value=""></option><option>Yes</option><option>No</option></select></label>
      <fieldset><label>Start Date Year<input name="year-${n}"></label></fieldset>
    </fieldset>`;
  await context.route(`${origin}/icims-like`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Candidate Profile</title><form>
        <div><h3>Resume</h3>
          <p>Provide your resume below to pre-fill your profile. Existing data in the form will be replaced.</p>
          <label>Please upload your resume<input type="file" name="Resume_File" accept=".pdf,.docx"></label>
          <div id="Resume_FileNameLabel" class="iCIMS_NoDisplay"><span></span></div>
        </div>
        <fieldset><legend>Addresses (1)</legend>
          <label>Address<input name="address"></label><label>Zip/Postal Code<input name="zip"></label>
        </fieldset>
        <div id="education">${row(1)}</div>
      </form>
      <script>
        const parsed = sessionStorage.getItem("parsed");
        if (parsed) {
          const label = document.getElementById("Resume_FileNameLabel");
          label.className = "iCIMS_CurrentFile";
          label.querySelector("span").textContent = parsed;
          // The parser's guesses: one school's major beside nothing, the
          // other school twice, and a wrong "Yes".
          document.getElementById("education").innerHTML = ${JSON.stringify(row(1) + row(2) + row(3))};
          const set = (name, value) => { document.querySelector('[name="' + name + '"]').value = value; };
          set("major-1", "Computer Science"); set("grad-1", "Yes"); set("gpa-1", "3.84");
          set("school-2", "Michigan State University"); set("grad-2", "Yes");
          set("school-3", "Michigan State University");
        }
        document.querySelector('[name="Resume_File"]').addEventListener("change", (event) => {
          sessionStorage.setItem("parsed", event.target.files[0].name);
          setTimeout(() => location.reload(), 1500);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/icims-like`);
  await enqueue([page]);
  await expect(page.locator('[name="address"]')).toHaveValue("100 Test Way", { timeout: 60000 });
  await expect(page.locator('[name="zip"]')).toHaveValue("85001");
  // Profile order, whatever the parser guessed: MSU's details in row 1, and
  // the parser's "Yes" becomes "No" (graduation is still ahead).
  await expect(page.locator('[name="school-1"]')).toHaveValue("Michigan State University");
  await expect(page.locator('[name="major-1"]')).toHaveValue("Data Science");
  await expect(page.locator('[name="grad-1"]')).toHaveValue("No");
  await expect(page.locator('[name="year-1"]')).toHaveValue("2025");
  await expect(page.locator('[name="major-2"]')).toHaveValue("Computer Science");
  await expect(page.locator('[name="grad-2"]')).toHaveValue("Yes");
  await expect(page.locator('[name="year-2"]')).toHaveValue("2020");
  // Row 2's school is not in this list, so the parser's guess stays and is
  // flagged; row 3 has no delete control here, so it is flagged too.
  const review = async () => (await state()).applications[0].missing.join(" ");
  await expect.poll(review, { timeout: 25000 }).toContain(
    'School Dropdown: "Michigan State University" was filled in by the site from your resume and not corrected',
  );
  expect(await review()).toContain('Education row 3 ("Michigan State University") is not in your profile');
  // The parser's GPA is the profile's own (Jabil, 2026-10-16): left as it
  // is, and not flagged.
  await expect(page.locator('[name="gpa-1"]')).toHaveValue("3.84");
  expect(await review()).not.toContain('Overall Result (GPA): "3.84"');
});

async function continuationFixture(mode: "in-place" | "reload") {
  const url = `${origin}/resume-continuation-${mode}`;
  await context.route(url, route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><title>Candidate Profile</title><form>
      <div id="resume-row"><h3>Resume</h3><p>Provide your resume below to pre-fill your profile. Existing data in the form will be replaced.</p>
        <label>Please upload your resume<input type="file" name="Resume_File" accept=".pdf,.docx"></label>
        <div id="Resume_FileNameLabel" class="iCIMS_NoDisplay"><span></span></div>
      </div>
      <label>First name<input name="firstName" required></label>
      <label>Email<input name="email" type="email" required></label>
      <label>City<input name="city" required></label>
      <button type="submit">Submit application</button>
    </form><script>
      window.submissions = 0;
      document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.submissions++; });
      window.uploads = Number(sessionStorage.getItem('uploads') || 0);
      const parsed = sessionStorage.getItem('parsed');
      const applyParsed = (name) => {
        const label = document.getElementById('Resume_FileNameLabel');
        label.className = 'iCIMS_CurrentFile'; label.querySelector('span').textContent = name;
        document.querySelector('[name=firstName]').value = 'Parsed';
        document.querySelector('[name=email]').value = '';
        document.querySelector('[name=city]').value = '';
      };
      if (parsed) applyParsed(parsed);
      document.querySelector('[name=Resume_File]').addEventListener('change', event => {
        window.uploads++;
        sessionStorage.setItem('uploads', String(window.uploads));
        const name = event.target.files[0].name;
        sessionStorage.setItem('parsed', name);
        setTimeout(() => ${mode === "reload" ? "location.reload()" : "applyParsed(name)"}, 1500);
      });
    </script>`,
  }));
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

for (const mode of ["in-place", "reload"] as const) {
  test(`a ${mode} resume continuation never appears complete before its follow-up fill is queued`, async () => {
    const page = await continuationFixture(mode);
    await worker.evaluate(() => {
      const original = chrome.storage.local.set.bind(chrome.storage.local);
      (globalThis as any).__prematureSettlements = [];
      chrome.storage.local.set = (async (items: any) => {
        for (const app of items.queue?.applications || []) {
          if (/Correcting and completing/.test(app.note)) {
            if (["awaiting-user", "ready"].includes(app.status) && !app.continueAfterSiteFill && !app.explicitFill)
              (globalThis as any).__prematureSettlements.push(app);
            // Make the storage boundary observable to a polling panel/eval.
            await new Promise(resolve => setTimeout(resolve, 800));
          }
        }
        return original(items);
      }) as typeof chrome.storage.local.set;
    });
    await enqueue([page]);
    await expect(page.locator('[name=email]')).toHaveValue(profile.email, { timeout: 45000 });
    await expect(page.locator('[name=firstName]')).toHaveValue(profile.firstName);
    await expect(page.locator('[name=city]')).toHaveValue(profile.city);
    // Settled: ready once the resume it uploaded is no longer listed for
    // review as if it were the site's (2026-10-31).
    await expect.poll(async () => {
      const app = (await state()).applications[0];
      return [["awaiting-user", "ready"].includes(app.status), app.explicitFill, Boolean(app.continueAfterSiteFill)];
    }, { timeout: 30000 }).toEqual([true, false, false]);
    expect(await worker.evaluate(() => (globalThis as any).__prematureSettlements)).toEqual([]);
    expect((await state()).applications[0].attempts).toHaveLength(2);
    await page.waitForTimeout(2000);
    await expect(page.locator('[name=firstName]')).toHaveValue(profile.firstName);
    await expect(page.locator('[name=email]')).toHaveValue(profile.email);
    expect(await page.evaluate(() => (window as any).uploads)).toBe(1);
    expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
  });
}

for (const action of ["PAUSE_APP", "CANCEL_APP"] as const) {
  test(`${action} cancels a delayed resume continuation without writing or submitting`, async () => {
    const page = await continuationFixture("in-place");
    await enqueue([page]);
    await expect.poll(async () => {
      const app = (await state()).applications[0];
      return app?.status === "awaiting-user" && Boolean(app.continueAfterSiteFill);
    }, { timeout: 30000 }).toBe(true);
    const app = (await state()).applications[0];
    await ui({ type: action, id: app.id });
    await page.waitForTimeout(7000);
    const stopped = (await state()).applications[0];
    expect(stopped.status).toBe(action === "PAUSE_APP" ? "paused" : "cancelled");
    expect(stopped.explicitFill).toBe(false);
    expect(stopped.continueAfterSiteFill).toBe(false);
    expect(stopped.attempts).toHaveLength(1);
    await expect(page.locator('[name=email]')).toHaveValue("");
    expect(await page.evaluate(() => (window as any).uploads)).toBe(1);
    expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
  });
}

test("a resume uploader that rewrites the form gets the resume first, once", async () => {
  await context.route(`${origin}/resume-prefill`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Candidate Profile</title><form>
        <div id="resume-row"><h3>Resume</h3>
          <p>Provide your resume below to pre-fill your profile. Existing data in the form will be replaced.</p>
          <label>Please upload your resume<input type="file" name="Resume_File" accept=".pdf,.docx"></label>
          <div id="Resume_FileNameLabel" class="iCIMS_NoDisplay"><span></span></div>
        </div>
        <label>First name<input name="firstName"></label>
        <label>Email<input name="email" type="email"></label>
        <label>City<input name="city"></label>
      </form>
      <script>
        const parsed = sessionStorage.getItem("parsed");
        window.uploads = Number(sessionStorage.getItem("uploads") || 0);
        if (parsed) {
          const label = document.getElementById("Resume_FileNameLabel");
          label.className = "iCIMS_CurrentFile";
          label.querySelector("span").textContent = parsed;
          document.querySelector('[name="firstName"]').value = "Parsed";
        }
        document.querySelector('[name="Resume_File"]').addEventListener("change", (event) => {
          sessionStorage.setItem("uploads", String(window.uploads + 1));
          sessionStorage.setItem("parsed", event.target.files[0].name);
          // The site parses the resume, then reloads with its own values.
          setTimeout(() => location.reload(), 1500);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/resume-prefill`);
  await enqueue([page]);
  // One request: the resume goes first, the site rewrites the form, and the
  // fill carries on by itself once the page settles.
  await expect(page.locator('[name="email"]')).toHaveValue(profile.email, {
    timeout: 40000,
  });
  // The site's parse is replaced by the confirmed profile, and the resume
  // on file is not sent again.
  await expect(page.locator('[name="firstName"]')).toHaveValue(profile.firstName);
  await expect(page.locator('[name="city"]')).toHaveValue(profile.city);
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 25000 })
    .toMatch(/awaiting-user|ready/);
  expect(await page.evaluate(() => (window as any).uploads)).toBe(1);
});

// Microsoft's careers form (2026-11-07): an uploaded résumé is taken into
// its own résumé list, named in that list's box, and the file input is
// emptied. Every upload re-applies its parse, which empties Address and Zip.
// The résumé was sent again on each fill, after the address was typed, and
// the address was left blank.
test("a résumé named in the site's own list is not sent again over a typed address", async () => {
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, address: "100 Test Way", postalCode: "85001" } });
  await context.route(`${origin}/resume-list`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Apply</title><form onsubmit="return false">
        <label for="input-3">Upload your resume</label>
        <input id="input-3" role="combobox" aria-haspopup="listbox" readonly value="">
        <label>Resume<input type="file" name="resume" accept=".pdf,.docx"></label>
        <label>First name<input name="firstName"></label>
        <label for="address">Address</label><input id="address" name="address" aria-required="true">
        <label for="zip">Postal Code/Zip</label><input id="zip" name="zip" aria-required="true">
      </form>
      <script>
        window.uploads = 0;
        document.querySelector('[name="resume"]').addEventListener("change", (event) => {
          const name = event.target.files[0].name;
          window.uploads++;
          setTimeout(() => {
            document.getElementById("input-3").value = name;
            event.target.value = "";
            document.getElementById("address").value = "";
            document.getElementById("zip").value = "";
          }, 300);
        });
      </script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/resume-list`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 40000 }).toMatch(/awaiting-user|ready/);
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 40000 }).toMatch(/awaiting-user|ready/);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).uploads)).toBe(1);
  await expect(page.locator("#address")).toHaveValue("100 Test Way");
  await expect(page.locator("#zip")).toHaveValue("85001");
});

test("manual workspace tracks related tabs, fills only on request, and saves a redacted issue snapshot", async () => {
  await expect(
    ui({ type: "PAIR", token: extensionId }),
  ).rejects.toThrow("Chrome extension ID, not the pairing token");
  generatorDelay = 3000;
  const posting = await context.newPage();
  await posting.route(`${origin}/manual-posting`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Platform Engineer at Acme</title><h1>Platform Engineer</h1><p>Build TypeScript systems.</p>",
    }),
  );
  await posting.goto(`${origin}/manual-posting`);
  const tabId = async (page: Page) =>
    panel.evaluate(
      async (url) =>
        (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
      page.url(),
    );
  await ui({ type: "TRACK_TAB", tabId: await tabId(posting) });
  let app = (await state()).applications[0];
  expect(app.status).toBe("awaiting-user");
  expect(app.tabs).toHaveLength(1);
  expect(app.sourceDescription).toContain("Build TypeScript systems");

  const form = await context.newPage();
  await form.route(`${origin}/emailed-session?*`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Acme candidate application</title>
      <meta name="csrf-token" content="meta-csrf-secret">
      <a href="/continue?session_token=link-session-secret">Continue</a>
      <form>
        <input type="hidden" name="authenticity_token" value="rails-authenticity-secret">
        <input type="hidden" name="Resume_TEMP" value="JVBERi0x${"Q".repeat(400)}">
        <button type="button" onclick="location='https://sso.example/?state=inline-handler-secret'">SSO</button>
        <label>Email<input name="email" type="email" required></label>
        <label>City<input name="city" value="Phoenix"></label>
        <label>Password<input name="password" type="password" value="super-secret"></label>
        <label>Session token<textarea name="sessionToken">session-secret</textarea></label>
        <button type="submit">Submit application</button>
      </form>`,
    }),
  );
  await form.goto(`${origin}/emailed-session?token=url-session-secret&step=2`);
  await panel.bringToFront();
  const formTabId = await tabId(form);
  await ui({ type: "ATTACH_TAB", id: app.id, tabId: formTabId });
  app = (await state()).applications[0];
  expect(app.tabs).toHaveLength(2);
  expect(app.tabId).toBe(formTabId);
  await expect(form.locator('[name="email"]')).toHaveValue("");

  await ui({ type: "FILL_STEP", id: app.id });
  await expect
    .poll(async () => (await state()).applications[0].status, {
      timeout: 15000,
    })
    .toMatch(/preparing|filling/);
  await expect(form.locator('[name="email"]')).toHaveValue(profile.email);
  const captured = await ui({
    type: "REPORT_ISSUE",
    tabId: formTabId,
    category: "wrong-value",
    note: "City was unexpected.",
  });
  expect(captured.saved).toBe(true);
  expect((await state()).applications[0].status).toBe("paused");
  const exported = await ui({
    type: "API",
    path: `/v1/issues/${captured.report.id}`,
  });
  const json = JSON.stringify(exported);
  expect(json).toContain("Phoenix");
  expect(json).toContain("[redacted]");
  expect(json).not.toContain("super-secret");
  expect(json).not.toContain("session-secret");
  expect(json).not.toContain("meta-csrf-secret");
  expect(json).not.toContain("rails-authenticity-secret");
  expect(json).not.toContain("JVBERi0x");
  expect(json).not.toContain("inline-handler-secret");
  expect(json).toContain("step=2");
  await panel.bringToFront();
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  await panel.setViewportSize({ width: 380, height: 900 });
  await panel.screenshot({
    path: "test-results/manual-workspace-side-panel.png",
    fullPage: true,
  });
  await ui({ type: "DELETE_ISSUE", reportId: captured.report.id });
  expect((await state()).applications[0].issueCount).toBe(0);
  expect(await ui({ type: "API", path: "/v1/issues" })).toHaveLength(0);
  // The panel reads the saved profile: one not confirmed blocks filling.
  const saved = await ui({ type: "API", path: "/v1/profile" });
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...saved, confirmed: false } });
  await panel.reload();
  await expect(panel.locator("article.application .fill-blocker")).toContainText(
    "Confirm your profile before filling.",
  );
});

test("clicking Fill this step keeps the panel rendered", async () => {
  const errors: string[] = [];
  panel.on("pageerror", (error) => errors.push(error.message));
  const page = await context.newPage();
  await page.goto(`${origin}/panel-click`);
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "TRACK_TAB", tabId });
  await panel.bringToFront();
  await panel
    .locator("article.application")
    .getByRole("button", { name: "Fill this step" })
    .click();
  await expect(page.locator('[name="firstName"]')).toHaveValue(
    profile.firstName,
  );
  await expect(
    panel.getByRole("heading", { name: "Applications", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("Mark submitted records the submission from the application card", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/mark-submitted`);
  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  const tracked = await ui({ type: "TRACK_TAB", tabId });
  const id = tracked.applications.find((app: { tabId?: number }) => app.tabId === tabId).id;
  await panel.bringToFront();
  const card = panel.locator("article.application").filter({ has: panel.locator(`select`) }).last();
  await card.getByRole("button", { name: "Mark submitted" }).click();
  await expect
    .poll(async () => (await state()).applications.find((app: { id: string }) => app.id === id)?.workflowStage)
    .toBe("submitted");
  await expect(panel.getByRole("status")).toContainText("Marked submitted");
  // Submitted applications leave the open list and are kept under Submitted,
  // where the Stage menu still changes it and the button is gone.
  const title = (await state()).applications.find((app: { id: string }) => app.id === id)!.title;
  const cards = panel.locator("article.application").filter({ hasText: title });
  await expect(cards).toHaveCount(0);
  await panel.getByLabel("Filter applications").selectOption("submitted");
  const kept = cards.last();
  await expect(kept.getByRole("button", { name: "Mark submitted" })).toHaveCount(0);
  await expect(kept.getByRole("combobox")).toHaveValue("submitted");
  await panel.getByLabel("Filter applications").selectOption("open");
});

// The applicant, 2026-10-31: a position given up on is abandoned from the
// current tab's card, after a confirmation, and leaves the open list.
test("Abandon on the current tab's card abandons the application after a confirmation", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/ui-flow`);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await ui({ type: "TRACK_TAB", tabId });
  const id = (await state()).applications.find((app: { tabId?: number }) => app.tabId === tabId)!.id;
  await page.bringToFront();
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  const card = panel.getByRole("region", { name: "Current browser tab" });
  // Declined: nothing changes.
  panel.once("dialog", (dialog) => void dialog.dismiss());
  await card.getByRole("button", { name: "Abandon" }).click();
  await panel.waitForTimeout(500);
  expect((await state()).applications.find((app: { id: string }) => app.id === id)?.workflowStage).toBe("applying");
  // Confirmed: abandoned, and the button is gone.
  panel.once("dialog", (dialog) => void dialog.accept());
  await card.getByRole("button", { name: "Abandon" }).click();
  await expect.poll(async () => (await state()).applications.find((app: { id: string }) => app.id === id)?.workflowStage).toBe("abandoned");
  await expect(panel.getByRole("status")).toContainText("Abandoned");
  await expect(card.getByRole("button", { name: "Abandon" })).toHaveCount(0);
  await page.close();
});

// A report, 2026-10-13: a Greenhouse form inside an employer's own careers
// site was read (the card showed its 22 fields), but Track as new answered
// "Grant site access for https://www.pinterestcareers.com." with no prompt.
test("Track as new asks for the site's access inside the click", async () => {
  await context.route(`${origin}/careers-form`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Engineer | Acme Careers</title><form><label>First Name<input name=first></label><label>Email<input name=email type=email></label></form>" }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/careers-form`);
  await page.bringToFront();
  await panel.getByRole("button", { name: "Scan current tab" }).click();
  const card = panel.getByRole("region", { name: "Current browser tab" });
  await expect(card).toContainText("Engineer");
  await panel.evaluate(() => {
    (window as any).asked = [];
    chrome.permissions.request = (async (request: chrome.permissions.Permissions) => {
      (window as any).asked.push(...(request.origins || []));
      return true;
    }) as typeof chrome.permissions.request;
  });
  await card.getByRole("button", { name: "Track as new" }).click();
  await expect.poll(async () => (await state()).applications.some((app: { url: string }) => app.url.includes("/careers-form"))).toBe(true);
  expect(await panel.evaluate(() => (window as any).asked)).toContain(`${new URL(origin).origin}/*`);
  await page.close();
});

test("a tab that cannot be scanned still offers the current-tab actions", async () => {
  // The panel page itself is the active tab here, and it cannot be scanned.
  const card = panel.getByRole("region", { name: "Current browser tab" });
  await expect(card).toContainText("Couldn’t read this tab");
  await expect(card.getByRole("button", { name: "Scan again" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Track as new" })).toBeVisible();
});

test("Documents opens its dialog over the panel wherever the panel is scrolled", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/docs-button`);
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0].status, { timeout: 25000 })
    .toMatch(/awaiting-user|ready/);
  await panel.bringToFront();
  await panel.setViewportSize({ width: 380, height: 700 });
  await panel.reload();
  const button = panel
    .locator("article.application")
    .getByRole("button", { name: "Documents", exact: true });
  await button.scrollIntoViewIfNeeded();
  await button.click();
  const dialog = panel.getByRole("dialog", { name: "Application documents" });
  await expect(dialog).toBeInViewport();
  await expect(dialog).toContainText("Built accessible web applications");
});

test("filling from a related tab makes it the current fill target", async () => {
  const posting = await context.newPage();
  await posting.goto(`${origin}/related-posting`);
  const form = await context.newPage();
  await form.goto(`${origin}/related-form`);
  const tabId = async (page: Page) =>
    panel.evaluate(
      async (url) =>
        (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
      page.url(),
    );
  await ui({ type: "TRACK_TAB", tabId: await tabId(posting) });
  const app = (await state()).applications[0];
  await ui({ type: "ATTACH_TAB", id: app.id, tabId: await tabId(form) });
  // The side panel on the posting tab fills that tab, not the form target.
  const result = await ui({
    type: "FILL_STEP",
    id: app.id,
    tabId: await tabId(posting),
  });
  expect(result.applications).toHaveLength(1);
  expect((await state()).applications[0].tabId).toBe(await tabId(posting));
  await expect(posting.locator('[name="firstName"]')).toHaveValue(
    profile.firstName,
  );
  await expect(form.locator('[name="firstName"]')).toHaveValue("");
});

test("GPA, internships, pronouns and orientation are saved in the profile and fill portal wording", async () => {
  // A GPA belongs to a school, on that school's scale.
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, education: [{ organization: "Example University", title: "Bachelor of Science", startDate: "2022-08", endDate: "2026-05", location: "", details: "" }] } });
  await showDashboard("profile");
  await panel.getByLabel("GPA or grade (optional)").first().fill("3.62");
  await panel.getByLabel("GPA scale").first().selectOption("4");
  await panel.getByLabel("Prior internships / co-ops").fill("5");
  await panel.getByLabel("Pronouns").selectOption("He/Him");
  await panel.getByLabel("Sexual orientation").selectOption("Decline");
  await panel
    .getByRole("checkbox", { name: /confirm they are accurate/ })
    .check();
  await panel.getByRole("button", { name: "Save confirmed profile" }).click();
  await expect(panel.getByRole("status")).toContainText("Profile saved");
  const saved = await ui({ type: "API", path: "/v1/profile" });
  expect(saved.education[0]).toMatchObject({ gpa: "3.62", gpaScale: "4" });
  expect(saved).toMatchObject({
    internshipCount: "5",
    pronouns: "He/Him",
    sexualOrientation: "Decline",
  });

  const page = await context.newPage();
  await page.goto(`${origin}/background-questions`);
  await page.evaluate(() => {
    const form = document.querySelector("form")!;
    const extra = document.createElement("div");
    extra.innerHTML = `
      <label>Pronoun<select name="pronoun"><option value="">Select…</option><option>He/Him/His</option><option>She/Her/Hers</option></select></label>
      <label>Sexual Orientation<select name="orientation"><option value="">Select…</option><option>Straight</option><option>I don't wish to answer</option></select></label>
      <label>How many prior internship(s) have you completed?<select name="internships"><option value="">Select…</option><option>None</option><option>3</option><option>3+</option></select></label>
      <div class="select__container"><label id="gpa-label">What is your GPA?</label><input role="combobox" aria-labelledby="gpa-label" aria-expanded="false"></div>`;
    form.prepend(extra);
    const shell = extra.querySelector<HTMLElement>(".select__container")!;
    const input = shell.querySelector<HTMLElement>('[role="combobox"]')!;
    input.addEventListener("mousedown", () => {
      input.setAttribute("aria-expanded", "true");
      input.setAttribute("aria-controls", "gpas");
      const list = document.createElement("div");
      list.id = "gpas";
      list.role = "listbox";
      list.innerHTML = ["Below 2", "3.25 - 3.49", "3.5 - 3.74", "3.75 - 4", "4+"]
        .map((gpa) => `<div role="option">${gpa}</div>`)
        .join("");
      list.querySelectorAll<HTMLElement>('[role="option"]').forEach((option) =>
        option.addEventListener("click", () => {
          const value = document.createElement("div");
          value.className = "select__single-value";
          value.textContent = option.textContent;
          shell.append(value);
          input.setAttribute("aria-expanded", "false");
          list.remove();
        }),
      );
      shell.append(list);
    });
  });
  await enqueue([page]);
  await expect(page.locator('[name="pronoun"]')).toHaveValue("He/Him/His");
  await expect(page.locator('[name="orientation"]')).toHaveValue(
    "I don't wish to answer",
  );
  await expect(page.locator('[name="internships"]')).toHaveValue("3+");
  await expect(page.locator(".select__single-value")).toHaveText("3.5 - 3.74");
});

test("dashboard profile confirmation, on-demand document preview, and data deletion work through the UI", async () => {
  await showDashboard("profile");
  await panel.getByLabel("First name", { exact: true }).fill("Jamie");
  await expect(
    panel.getByRole("button", { name: "Save confirmed profile" }),
  ).toBeDisabled();
  await panel
    .getByRole("checkbox", { name: /confirm they are accurate/ })
    .check();
  await panel.getByRole("button", { name: "Save confirmed profile" }).click();
  await expect(panel.getByRole("status")).toContainText("Profile saved");
  await showPanel();
  await panel.locator("#urls").fill(`${origin}/ui-flow`);
  await panel.getByRole("button", { name: "Track links", exact: true }).click();
  await expect
    .poll(async () => (await state()).applications[0]?.status)
    .toBe("awaiting-user");
  await panel
    .getByRole("button", { name: "Fill this step", exact: true })
    .click();
  await expect
    .poll(async () => (await state()).applications[0]?.status, {
      timeout: 25000,
    })
    .toBe("ready");
  await panel.reload();
  await panel.getByRole("button", { name: "Documents", exact: true }).click();
  await expect(panel.getByRole("dialog")).toBeVisible();
  await expect(panel.getByRole("dialog")).toContainText(
    "Built accessible web applications",
  );
  // A PDF opens in a tab to be read; only Save downloads it.
  await panel.getByRole("button", { name: "Resume · PDF", exact: true }).click();
  const viewedTabs = () =>
    panel.evaluate(async () =>
      (await chrome.tabs.query({})).filter((tab) => /^blob:chrome-extension:/.test(tab.pendingUrl || tab.url || "")).map((tab) => tab.id!),
    );
  await expect.poll(async () => (await viewedTabs()).length).toBe(1);
  await panel.evaluate(async (ids) => chrome.tabs.remove(ids), await viewedTabs());
  const [saved] = await Promise.all([
    panel.waitForEvent("download"),
    panel.getByRole("button", { name: "Save Resume PDF", exact: true }).click(),
  ]);
  expect(saved.suggestedFilename()).toMatch(/\.pdf$/);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await panel.bringToFront();
  await panel.getByRole("button", { name: "Copy letter text", exact: true }).click();
  await expect(panel.getByText("Letter text copied.")).toBeVisible();
  const letter = await panel.locator(".letter").allInnerTexts();
  expect(letter.length).toBeGreaterThan(0);
  // The Windows clipboard hands text back with CRLF line ends.
  expect((await panel.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(
    letter.map((text) => text.trim()).join("\n\n"),
  );
  // The same documents are files on this machine, for a site whose upload
  // is done by hand: the panel hands over the path, never the page.
  await panel.getByRole("dialog").getByRole("button", { name: "Copy resume PDF path", exact: true }).click();
  await expect(panel.getByText("Path copied.")).toBeVisible();
  const copied = await panel.evaluate(() => navigator.clipboard.readText());
  expect(copied.startsWith(join(backendDirectory, "documents") + sep)).toBe(true);
  expect(basename(copied)).toMatch(/^Jamie_Rivera_Resume(_[A-Za-z0-9_]+)?\.pdf$/);
  expect((await stat(copied)).size).toBeGreaterThan(500);
  // Once submitted, the folder is under Sent; reopened, it is back.
  const stage = (to: string) =>
    panel.evaluate(
      async ({ id, to }) => chrome.runtime.sendMessage({ type: "SET_WORKFLOW", id, stage: to }),
      { id: applicationId, to },
    );
  const applicationId = (await state()).applications[0].id;
  const sentPath = copied.replace(join(backendDirectory, "documents"), join(backendDirectory, "documents", "Sent"));
  await stage("submitted");
  expect((await stat(sentPath)).isFile()).toBe(true);
  await expect(stat(copied)).rejects.toThrow();
  await stage("applying");
  expect((await stat(copied)).isFile()).toBe(true);
  await panel.getByRole("button", { name: "Close documents" }).click();
  const applicationPage = context
    .pages()
    .find((p) => p.url() === `${origin}/ui-flow`)!;
  await expect(applicationPage.locator("[name=firstName]")).toHaveValue(
    "Jamie",
  );
  await showDashboard("settings");
  await panel
    .getByRole("button", {
      name: "Delete local application data…",
      exact: true,
    })
    .click();
  await panel
    .getByRole("button", { name: "Delete local application data", exact: true })
    .click();
  await expect.poll(async () => (await state()).applications.length).toBe(0);
  await expect(applicationPage.locator("[name=firstName]")).toHaveValue(
    "Jamie",
  );
});

test("long question labels retain distinct identities and unsupported optional controls are reported", async () => {
  const prefix = "Question with a shared label prefix ".repeat(8);
  const questions = [`${prefix} A`, `${prefix} B`];
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      answers: [
        { question: questions[0], answer: "Alpha" },
        { question: questions[1], answer: "Beta" },
      ],
    },
  });
  const a = await context.newPage();
  await a.goto(`${origin}/long-fields`);
  await a.evaluate((questions) => {
    for (let i = 0; i < questions.length; i++) {
      const label = document.createElement("label");
      label.textContent = questions[i];
      const input = document.createElement("input");
      input.name = `long-${i}`;
      input.required = true;
      label.append(input);
      document.querySelector("form")!.append(label);
    }
    const label = document.createElement("label");
    label.textContent = "Anything else you would like us to know?";
    label.innerHTML += '<input name="unknown-optional">';
    document.querySelector("form")!.append(label);
  }, questions);
  await panel.bringToFront();
  await enqueue([a]);
  await expect
    .poll(async () => (await state()).applications[0].status, {
      timeout: 25000,
    })
    .toBe("awaiting-user");
  await expect(a.locator("[name=long-0]")).toHaveValue("Alpha");
  await expect(a.locator("[name=long-1]")).toHaveValue("Beta");
  expect((await state()).applications[0].missing).toContain(
    "Optional unanswered: Anything else you would like us to know?",
  );
});

test("an invisible CAPTCHA is reported for review, and a solved one is not", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/invisible-captcha`);
  // Lever's apply form: hCaptcha runs with no widget to click, and its token
  // field stays empty until the site verifies the submission.
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.src = "https://js.hcaptcha.com/1/api.js?host=fixture";
    document.head.append(script);
    const frame = document.createElement("iframe");
    frame.src = "https://newassets.hcaptcha.com/captcha/v1/static/hcaptcha.html";
    frame.style.cssText = "display:none";
    const token = document.createElement("textarea");
    token.name = "h-captcha-response";
    token.style.cssText = "display:none";
    document.querySelector("form")!.append(frame, token);
  });
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0].status, {
      timeout: 25_000,
    })
    .toBe("awaiting-user");
  expect((await state()).applications[0].missing.join(" ")).toContain(
    "verifies submissions with a CAPTCHA you cannot see",
  );
  // Once the site holds a token there is nothing left to warn about.
  await page.evaluate(() => {
    document.querySelector<HTMLTextAreaElement>(
      '[name="h-captcha-response"]',
    )!.value = "solved-token";
  });
  const blockers = (await content(page, { type: "INSPECT" })).data.blockers;
  expect(blockers.join(" ")).not.toContain("CAPTCHA");
});

test("a visible CAPTCHA still asks the applicant to complete it", async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/visible-captcha`);
  await page.evaluate(() => {
    const widget = document.createElement("div");
    widget.dataset.sitekey = "fixture-key";
    widget.style.cssText = "width:300px;height:74px";
    widget.textContent = "I am human";
    const token = document.createElement("textarea");
    token.name = "g-recaptcha-response";
    token.style.cssText = "display:none";
    document.querySelector("form")!.append(widget, token);
  });
  await panel.bringToFront();
  await background(page);
  await enqueue([page]);
  await expect
    .poll(async () => (await state()).applications[0].status, {
      timeout: 25_000,
    })
    .toBe("awaiting-user");
  expect((await state()).applications[0].missing.join(" ")).toContain(
    "Complete the site’s CAPTCHA if requested.",
  );
});

test("a user-driven slow Next navigation pauses until the new step is explicitly filled", async () => {
  await context.route(`${atsOrigins[0]}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      path === "/step2"
        ? html(path)
        : html(path)
            .replace(
              '<button type="submit">Submit application</button>',
              '<button type="button" data-automation-id="bottom-navigation-next-button" id="safe-next">Next</button>',
            )
            .replace(
              "</script>",
              `document.querySelector('#safe-next').addEventListener('click',()=>{sessionStorage.setItem('nextClicks',String(Number(sessionStorage.getItem('nextClicks')||0)+1));document.querySelector('#safe-next').disabled=true;setTimeout(()=>location.assign('/step2'),1500)});</script>`,
            );
    return route.fulfill({ contentType: "text/html", body });
  });
  const a = await context.newPage();
  await a.goto(`${atsOrigins[0]}/step1`);
  await panel.bringToFront();
  await enqueue([a]);
  await expect
    .poll(async () => (await state()).applications[0].status, {
      timeout: 25000,
    })
    .toBe("awaiting-user");
  await expect(a.locator("[name=email]")).toHaveValue(profile.email);
  await a.locator("#safe-next").click();
  await a.waitForURL(`${atsOrigins[0]}/step2`);
  await expect
    .poll(async () => (await state()).applications[0].status)
    .toBe("paused");
  expect(a.url()).toBe(`${atsOrigins[0]}/step2`);
  expect(await a.evaluate(() => sessionStorage.getItem("nextClicks"))).toBe(
    "1",
  );
  await expect(a.locator("[name=email]")).toHaveValue("");
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
  await expect
    .poll(async () => (await state()).applications[0].status, {
      timeout: 25000,
    })
    .toBe("ready");
  await expect(a.locator("[name=email]")).toHaveValue(profile.email);
  expect((await state()).applications[0].steps).toBe(0);
  expect(await a.evaluate(() => (window as any).submissions)).toBe(0);
});

test("multiple resumes accumulate facts, deduplicate repeats, and report a failed file without losing edits", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  page.drawText(`${profile.facts[0].text}\nDelivered reliable backend APIs.`, {
    x: 50,
    y: 700,
    size: 12,
    lineHeight: 18,
  });
  const pdfFile = {
    name: "engineering.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await pdf.save()),
  };
  const docxFile = {
    name: "leadership.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph("Delivered reliable backend APIs."),
              new Paragraph("Mentored three engineers."),
            ],
          },
        ],
      }),
    ),
  };
  await showDashboard("profile");
  await panel
    .getByLabel("Resume facts", { exact: true })
    .fill(
      `${profile.facts.map((f) => f.text).join("\n")}\nExisting unsaved fact.`,
    );
  // Hold the real extraction response so an actual edit can occur while pending.
  let began!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  backend.prependListener("request", (req, res) => {
    if (req.url === "/v1/import" && !held) {
      held = true;
      const end = res.end.bind(res);
      res.end = ((...args: Parameters<typeof res.end>) => {
        began();
        void gate.then(() => end(...args));
        return res;
      }) as typeof res.end;
    }
  });
  const input = panel.getByLabel("Add resumes to your facts", { exact: true });
  await input.setInputFiles([
    pdfFile,
    {
      name: "broken.docx",
      mimeType: docxFile.mimeType,
      buffer: Buffer.from("not a zip document"),
    },
    docxFile,
  ]);
  await started;
  try {
    await panel
      .getByLabel("Resume facts", { exact: true })
      .fill(
        `${profile.facts.map((f) => f.text).join("\n")}\nFact edited while importing.`,
      );
  } finally {
    release();
  }
  const report = panel.getByRole("status", { name: "Resume import results" });
  await expect(report).toContainText(
    "engineering.pdf: 1 facts added, 1 duplicates skipped.",
  );
  await expect(report).toContainText(
    "leadership.docx: 1 facts added, 1 duplicates skipped.",
  );
  await expect(report).toContainText("broken.docx");
  await expect(report.locator(".error")).toBeVisible();
  const cumulative = `${profile.facts.map((f) => f.text).join("\n")}\nFact edited while importing.\nDelivered reliable backend APIs.\nMentored three engineers.`;
  await expect(panel.getByLabel("Resume facts", { exact: true })).toHaveValue(
    cumulative,
  );
  await expect(
    panel.getByRole("checkbox", { name: /confirm they are accurate/ }),
  ).not.toBeChecked();
  await expect(input).toBeEnabled();
  // Selecting the same file again must trigger an import and add no duplicates.
  await input.setInputFiles(pdfFile);
  await expect(report).toHaveText(
    "engineering.pdf: 0 facts added, 2 duplicates skipped.",
  );
  await expect(panel.getByLabel("Resume facts", { exact: true })).toHaveValue(
    cumulative,
  );
  await panel
    .getByRole("checkbox", { name: /confirm they are accurate/ })
    .check();
  await panel.getByRole("button", { name: "Save confirmed profile" }).click();
  await expect(
    panel.getByText(
      "Profile saved. Resume paused applications to use these facts.",
      { exact: true },
    ),
  ).toBeVisible();
  const saved = await ui({ type: "API", path: "/v1/profile" });
  expect(saved.facts.slice(0, 2).map((f: { id: string }) => f.id)).toEqual(
    profile.facts.map((f) => f.id),
  );
  await panel.reload();
  await showDashboard("profile");
  await expect(panel.getByLabel("Resume facts", { exact: true })).toHaveValue(
    cumulative,
  );
});

test("throughput benchmark compares ten applications at one and four lanes", async () => {
  test.setTimeout(180000);
  generatorDelay = 1000;
  for (const url of atsOrigins)
    await context.route(`${url}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: html(new URL(route.request().url()).pathname).replace(
          "</script>",
          'window.emailFilledAt=0;document.querySelector("[name=email]").addEventListener("input",()=>{if(!window.emailFilledAt)window.emailFilledAt=Date.now()});</script>',
        ),
      }),
    );
  const measure = async (concurrency: number) => {
    await ui({
      type: "SETTINGS",
      settings: { concurrency, generationConcurrency: 4 },
    });
    const pages: Page[] = [];
    for (let i = 0; i < 10; i++) {
      const page = await context.newPage();
      await page.goto(
        `${atsOrigins[i % atsOrigins.length]}/benchmark-${concurrency}-${i}`,
      );
      pages.push(page);
    }
    await panel.bringToFront();
    const started = Date.now();
    await enqueue(pages);
    await expect
      .poll(
        async () =>
          (await state()).applications
            .filter((a) => a.url.includes(`/benchmark-${concurrency}-`))
            .map((a) => a.status),
        { timeout: 75000 },
      )
      .toEqual(Array(10).fill("ready"));
    const elapsedMs = Date.now() - started;
    const apps = (await state()).applications.filter((a) =>
      a.url.includes(`/benchmark-${concurrency}-`),
    );
    const filling: number[] = [];
    for (const page of pages) {
      await expect(page.locator("[name=email]")).toHaveValue(profile.email);
      const filledAt = await page.evaluate(
        () => (window as any).emailFilledAt as number,
      );
      filling.push(
        filledAt - apps.find((a) => a.url === page.url())!.startedAt!,
      );
      expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
      expect(
        await page
          .locator("[name=resume]")
          .evaluate((e: HTMLInputElement) => e.files?.length),
      ).toBe(1);
    }
    return {
      elapsedMs,
      deterministicP95Ms: filling.sort((a, b) => a - b)[9],
      applications: 10,
      lanes: concurrency,
    };
  };
  const sequential = await measure(1);
  const parallel = await measure(4);
  const result = {
    sequential,
    parallel,
    speedup: sequential.elapsedMs / parallel.elapsedMs,
    environment:
      "Local intercepted ATS fixtures; 1-second fake AI delay; real PDF/DOCX rendering; four AI slots; no live employer or competitor measurement.",
  };
  await writeFile(
    "test-results/benchmark.json",
    JSON.stringify(result, null, 2),
  );
  console.log(
    `Batch benchmark: ${sequential.elapsedMs}ms → ${parallel.elapsedMs}ms (${result.speedup.toFixed(2)}×), fill p95 ${parallel.deterministicP95Ms}ms.`,
  );
  expect(result.speedup).toBeGreaterThanOrEqual(2);
  expect(parallel.deterministicP95Ms).toBeLessThan(2000);
});


// Bank of America / TalNet, report d778b524: revealing graduation exposes
// a site-default year that was absent when the application was bound.
for (const prefilled of ["replace", "keep"] as const) {
  test(`TalNet fills the default year of a newly revealed graduation date (${prefilled})`, async () => {
    if (prefilled === "keep") await keepPrefilled();
    await ui({
      type: "API", path: "/v1/profile", method: "PUT",
      body: {
        ...profile,
        education: [{ organization: "Example University", title: "Master of Science", startDate: "2025-08", endDate: "2099-12" }],
      },
    });
    const dates = (id: string, label: string) => `<div class="form-group">
      <label class="eform_field_label"><span>${label}</span></label><div class="form_value">
        <fieldset class="form_datetime_wrapper"><legend>${label}</legend>
          <label for="${id}--MONTH">Month</label><select id="${id}--MONTH" name="${id}--MONTH"><option value="">mm</option><option value="8">August</option><option value="12">December</option></select>
          <label for="${id}--YEAR">Year</label><select id="${id}--YEAR" name="${id}--YEAR"><option value="">yyyy</option><option>2025</option><option selected>2026</option><option>2098</option><option>2099</option></select>
        </fieldset>
      </div></div>`;
    await context.route(`${talNetOrigin}/**`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <style>.viz_hide{display:none}</style><main><h1>Engineering Internship</h1><form>
        <div class="eform_page"><h2 class="eform_page_title">Current / Most Recent University Education</h2>
          <div class="form_root form_section" data-section_id="100"><div class="form_section" data-section_id="101">
            <label class="eform_field_label"><span>Current University / School</span></label><div class="form_value"><select><option value="">Select</option><option>Example University</option></select></div>
            ${dates("start", "Start date")}
            <label class="eform_field_label"><span>Degree expected / obtained?</span></label><div class="form_value"><select id="status"><option value="">Select</option><option>Expected</option><option>Obtained</option></select></div>
            <div id="graduation" class="viz_hide">${dates("end", "Expected graduation date")}</div>
          </div></div>
        </div><button type="submit">Submit application</button>
      </form></main><script>
        document.querySelector('form').onsubmit = e => e.preventDefault();
        document.getElementById('status').onchange = e => document.getElementById('graduation').classList.toggle('viz_hide', e.target.value !== 'Expected');
      </script>` }));
    const page = await context.newPage();
    await page.goto(`${talNetOrigin}/vx/candidate/graduation`);
    await enqueue([page]);
    await expect(page.locator('[id="end--MONTH"]')).toHaveValue("12", { timeout: 30000 });
    await expect(page.locator('[id="end--YEAR"]')).toHaveValue(prefilled === "keep" ? "2026" : "2099");
    await expect(page.locator('[id="start--YEAR"]')).toHaveValue(prefilled === "keep" ? "2026" : "2025");
    await expect.poll(async () => (await state()).applications[0]?.attempts.filter(a => a.completedAt).length).toBe(1);
    await page.locator('[id="end--YEAR"]').selectOption("2098");
    await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
    await expect.poll(async () => (await state()).applications[0]?.attempts.filter(a => a.completedAt).length).toBe(2);
    await expect(page.locator('[id="end--YEAR"]')).toHaveValue("2098");
  });
}

// Amazon (account.amazon.jobs, report f686f6a0, 2026-10-25): each question is
// a Select2 inside a <label> whose "for" names no element, named only by the
// selection's aria-labelledby. Each was listed twice, an unlabelled select
// with the options and a named box without them, and neither was answered.
test("an Amazon Select2 question is one field, named by its selection, and filled", async () => {
  await ui({
    type: "API", path: "/v1/profile", method: "PUT",
    body: { ...profile, education: [{ organization: "Example University", title: "Master of Science", startDate: "2025-08-21", endDate: "2099-12-13" }] },
  });
  const question = (id: string, label: string, options: string) => `
    <div class="form-group"><div class="question">
      <div class="question-label required"><label id="${id}-label" aria-hidden="true">${label}</label><span class="sr-only">Question ${label} required</span></div>
      <div class="drop-down-menu"><div class="drop-down-menu-select"><label for="dropDownValues" style="width: 100%;">
        <select tabindex="-1" class="select2-hidden-accessible" aria-hidden="true"><option value="" selected></option>${options}</select><span class="select2 select2-container" style="width: 100%;"><span class="selection"><span class="select2-selection select2-selection--single" role="combobox" aria-haspopup="true" aria-expanded="false" tabindex="0" aria-labelledby="${id}-label" aria-required="true"><span class="select2-selection__rendered" role="textbox" aria-readonly="true"><span class="select2-selection__placeholder">Select an option</span></span></span></span></span>
      </label></div></div>
    </div></div>`;
  await context.route(`${amazonOrigin}/**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html>
    <style>.select2-hidden-accessible{position:absolute;width:1px;height:1px;clip:rect(0,0,0,0);overflow:hidden} .select2-selection{display:block;padding:8px;border:1px solid} .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>
    <title>Apply to a Job | Amazon.jobs</title><main><h2>Job-specific questions</h2><form>
      ${question("adult", "Are you 18 years of age or older?", '<option value="1">Yes</option><option value="2">No</option>')}
      ${question("country", "What country/region are you currently located?", '<option value="3">Canada</option><option value="4">United States</option>')}
      <div class="form-group"><div class="question"><div class="question-label required"><label id="grad-label" aria-hidden="true">In what month and year did you (or do you expect to) graduate from your highest degree?</label></div></div>
        <div class="datepicker-component"><input type="text" class="form-control required" data-provide="datepicker-inline" placeholder="YYYY-MM-DD" aria-label="In what month and year did you (or do you expect to) graduate from your highest degree? Date: Year-Month-Day " aria-required="true" aria-autocomplete="none" role="combobox" aria-expanded="false" aria-haspopup="dialog" aria-controls="cb-dialog-1"></div></div>
    </form>
    <div id="RESUME" role="tabpanel" aria-label="Resume"><h2>Upload your resume</h2><div class="card document-block"><div class="card-body">
      <div class="document-name-container"><a class="document-block-title" href="/api/apply/documents/1/download">Download Alex_Rivera_Resume.pdf</a><p>Uploaded: Today at 1:26AM</p></div>
      <div><label for="document-replace-input"><button type="submit">Replace<span class="sr-only">Resume</span></button></label><input type="file" id="document-replace-input" class="file-upload"></div>
    </div></div></div></main>
    <script>
      for (const select of document.querySelectorAll("select")) select.onchange = () => {
        select.nextElementSibling.querySelector(".select2-selection__rendered").textContent = select.selectedOptions[0].textContent;
      };
    </script>` }));
  const page = await context.newPage();
  await page.goto(`${amazonOrigin}/en-US/applicant/jobs/1/apply`);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  const fields = (await ui({ type: "SCAN_TAB", tabId })).observation.fields as { label: string; kind: string; options: string[]; required: boolean; value: string }[];
  expect(fields.map((field) => [field.label, field.kind, field.options, field.required])).toEqual([
    ["Are you 18 years of age or older?", "select", ["Yes", "No"], true],
    ["What country/region are you currently located?", "select", ["Canada", "United States"], true],
    ["In what month and year did you (or do you expect to) graduate from your highest degree? Date: Year-Month-Day", "datepicker", [], true],
    ["Resume", "file", [], false],
  ]);
  // The resume the account already holds is the uploader's file, read as
  // the site's: this application's tailored one replaces it, once
  // (2026-10-31, the applicant's choice).
  expect(fields[3]).toMatchObject({ value: "Alex_Rivera_Resume.pdf" });
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.attempts.filter((a) => a.completedAt).length, { timeout: 30000 }).toBe(1);
  await expect(page.locator("select").nth(1)).toHaveValue("4");
  await expect(page.locator(".select2-selection__rendered").nth(1)).toHaveText("United States");
  // Its date box is typed in the format it names, not opened as a list.
  await expect(page.locator('[placeholder="YYYY-MM-DD"]')).toHaveValue("2099-12-13");
  expect(await page.locator("#document-replace-input").evaluate((input: HTMLInputElement) => input.files?.length)).toBe(1);
  // A click on a question pauses the application; what the fill left is
  // still offered for suggestions (the panel showed no review box).
  await page.bringToFront();
  await page.locator(".select2-selection").first().click();
  await expect.poll(async () => (await state()).applications[0].status, { timeout: 10000 }).toBe("paused");
  const open = await ui({ type: "UNRESOLVED_FIELDS", id: (await state()).applications[0].id, tabId });
  expect(open.available).toBe(true);
  expect(open.problems.map((problem: { label: string }) => problem.label)).toContain("Are you 18 years of age or older?");
});

// Amazon (account.amazon.jobs, report 71e8bf05, 2026-10-25): a text question
// keeps its answer only from onBlur, which React 15 hears as a captured blur
// on the document. Filled with input and change alone, the box showed the
// answer and Continue still called it required.
test("an Amazon text question keeps the filled answer", async () => {
  await context.route(`${amazonOrigin}/**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html>
    <style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>
    <title>Apply to a Job | Amazon.jobs</title><main><h2>Job-specific questions</h2><form>
      <div class="form-group"><div class="question" data-questionid="q-city">
        <div class="question question-text"><div class="question-label required"><label id="q-city-label" class="text-tooltip-label" aria-hidden="true">City</label><span class="sr-only">Question City required</span></div></div>
        <div class="text-field"><input type="text" id="q-city" class="form-control required" aria-labelledby="q-city-label" aria-required="true"></div>
      </div></div>
    </form></main>
    <script>
      document.addEventListener("blur", (event) => {
        if (event.target.id === "q-city") document.body.dataset.answer = event.target.value.trim();
      }, true);
    </script>` }));
  const page = await context.newPage();
  await page.goto(`${amazonOrigin}/en-US/applicant/jobs/1/apply`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.attempts.filter((a) => a.completedAt).length, { timeout: 30000 }).toBe(1);
  await expect(page.locator("#q-city")).toHaveValue("Phoenix");
  await expect(page.locator("body")).toHaveAttribute("data-answer", "Phoenix");
});

// Bank of America / TalNet, report 9e6f698b: previous education uses
// "Degree type" rather than the current page's "Degree Type".
test("TalNet fills Degree type on the previous university education page", async () => {
  await ui({
    type: "API", path: "/v1/profile", method: "PUT",
    body: {
      ...profile,
      education: [{ organization: "Example College", title: "Bachelor of Science", startDate: "2020-09", endDate: "2024-06" }],
    },
  });
  await context.route(`${talNetOrigin}/**`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
    <meta charset="utf-8"><style>.select2-hidden-accessible{position:absolute;width:1px;height:1px;clip:rect(0,0,0,0)} .select2-selection{display:block;padding:8px;border:1px solid}</style>
    <main><h1>Engineering Internship</h1><form><div class="eform_page"><h2 class="eform_page_title">Previous University Education</h2>
      <div class="form_root form_section" data-section_id="100"><div class="form_section" data-section_id="101">
        <div class="form-group" data-field_id="degree">
          <label class="eform_field_label" for="degree"><span class="hform_lbl_text">Degree type</span><span aria-hidden="true">*</span></label>
          <div class="form_value"><select id="degree" required aria-hidden="true" tabindex="-1" class="select2-hidden-accessible wcn-managed-by-select2 select2-offscreen">
            <option value="">Select</option><option value="bachelors">Bachelor’s</option><option value="grande">Grande École</option><option value="masters">Master’s</option><option value="mba">MBA</option><option value="phd">PhD</option><option value="other">Other</option>
          </select><span class="select2 select2-container"><span class="selection"><span class="select2-selection" role="button" aria-haspopup="true" tabindex="0" aria-label="Degree type"><span class="select2-selection__rendered">Choose one...</span></span></span></span></div>
        </div>
      </div></div>
    </div><button type="submit">Submit application</button></form></main>
    <script>
      document.querySelector('form').onsubmit = e => e.preventDefault();
      document.getElementById('degree').onchange = e => {
        document.querySelector('.select2-selection__rendered').textContent = e.target.selectedOptions[0].textContent;
      };
    </script>` }));
  const page = await context.newPage();
  await page.goto(`${talNetOrigin}/vx/candidate/previous-education`);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications[0]?.attempts.filter(a => a.completedAt).length).toBe(1);
  await expect(page.locator("#degree")).toHaveValue("bachelors");
  await expect(page.locator("#degree + .select2")).toHaveText("Bachelor’s");
  expect((await state()).applications[0].missing).not.toContain("Required: Degree type");
});

// Bank of America / TalNet, report 6527a0ce: Select2 hides the native selects
// and nests result sections inside the one current-education row.
test("TalNet education dropdowns are filled and unanswered Select2 questions are reported", async () => {
  await ui({
    type: "API", path: "/v1/profile", method: "PUT",
    body: {
      ...profile,
      education: [
        // Listed as "The Ohio State University", beside Ohio University.
        { organization: "Ohio State University", title: "Master of Science", fieldOfStudy: "Computer Science", startDate: "2025-08", endDate: "2099-05" },
        { organization: "Michigan State University", title: "Bachelor of Science", fieldOfStudy: "Mathematics", startDate: "2020-09", endDate: "2024-06" },
      ],
    },
  });
  const dropdown = (id: string, label: string, options: string, selected = "") => `
    <div class="form-group" data-field_id="${id}">
      <label class="eform_field_label" for="${id}"><span class="hform_lbl_text">${label}</span></label>
      <div class="form_value"><select id="${id}" name="${id}" required aria-hidden="true" tabindex="-1" class="select2-hidden-accessible wcn-managed-by-select2 select2-offscreen">
        <option value="">Select</option>${options}
      </select><span class="select2 select2-container"><span class="selection"><span class="select2-selection" role="button" aria-haspopup="true" tabindex="0" aria-label="${label}"><span class="select2-selection__rendered">${selected || "Choose one..."}</span></span></span></span></div>
    </div>`;
  const dates = (id: string, label: string) => `<div class="form-group">
    <label class="eform_field_label"><span>${label}</span></label><div class="form_value"><fieldset><legend>${label}</legend>
      <label for="${id}--MONTH">Month</label><select id="${id}--MONTH" name="${id}--MONTH"><option value="">mm</option><option value="5">May</option><option value="8">August</option><option value="9">September</option></select>
      <label for="${id}--YEAR">Year</label><select id="${id}--YEAR" name="${id}--YEAR"><option value="">yyyy</option><option>2024</option><option>2025</option><option>2099</option></select>
    </fieldset></div></div>`;
  await context.route(`${talNetOrigin}/**`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
    <style>.select2-hidden-accessible{position:absolute;width:1px;height:1px;clip:rect(0,0,0,0)} .select2-selection{display:block;padding:8px;border:1px solid} .viz_hide{display:none}</style>
    <main><h1>Engineering Internship</h1><form><div class="eform_page"><h2 class="eform_page_title">Current / Most Recent University Education</h2>
      <div class="form_root form_section" data-section_id="100"><div class="form_section" data-section_id="101">
        ${dropdown("study", "Location of study", '<option value="US">United States</option>')}
        ${dropdown("school", "Current University / School", '')}
        ${dates("start", "Start date")}
        ${dropdown("degree", "Degree Type", '<option value="masters">Master of Science</option><option value="bachelors">Bachelor of Science</option>')}
        ${dropdown("major", "Subject / Major", '<option value="cs">Computer Science</option><option value="math">Mathematics</option>')}
        ${dropdown("status", "Degree expected / obtained?", '<option value="expected">Expected</option><option value="obtained">Obtained</option>')}
        <div id="graduation" class="viz_hide">${dates("end", "Expected graduation date")}</div>
        <div class="form_section" data-section_id="102"><div class="viz_hide">${dates("obtained", "Date degree obtained")}</div>
          ${dropdown("result", "Expected Result Scale", '<option value="gpa">GPA</option>')}
        </div>
      </div>
      ${dropdown("previous", "Do you have any previous university education?", '<option value="yes">Yes</option><option value="no" selected>No</option>', "No")}
      ${dropdown("community", "Have you ever attended a community college or taken classes/certifications at a community college?", '<option value="yes">Yes</option><option value="no">No</option>')}
      <div class="viz_hide">${dropdown("hidden", "Hidden question", '<option>Yes</option>')}</div>
      <select id="unrelated" aria-hidden="true"><option>Unrelated hidden select</option></select>
      </div></div><button type="submit">Submit application</button></form></main>
    <script>
      document.querySelector('form').onsubmit = e => e.preventDefault();
      for (const select of document.querySelectorAll('.select2-hidden-accessible')) {
        select.addEventListener('change', () => {
          select.nextElementSibling.querySelector('.select2-selection__rendered').textContent = select.selectedOptions[0].textContent;
        });
      }
      document.getElementById('study').addEventListener('change', () => {
        setTimeout(() => document.getElementById('school').innerHTML = '<option value="">Select</option>${realSchools.map((name) => `<option value="${name === "The Ohio State University" ? "graduate" : name === "Michigan State University" ? "undergraduate" : name.toLowerCase().replace(/\W+/g, "-")}">${name}</option>`).join("")}', 100);
      });
      document.getElementById('status').addEventListener('change', e => {
        document.getElementById('graduation').classList.toggle('viz_hide', e.target.value !== 'expected');
      });
      document.querySelector('#previous + .select2 .select2-selection').addEventListener('click', () => {
        const select = document.getElementById('previous');
        select.value = 'no'; select.dispatchEvent(new Event('change', {bubbles:true}));
      });
    </script>` }));
  const page = await context.newPage();
  await page.goto(`${talNetOrigin}/vx/candidate/education`);
  await enqueue([page]);
  await expect(page.locator("#study")).toHaveValue("US", { timeout: 30000 });
  await expect(page.locator("#school")).toHaveValue("graduate");
  await expect(page.locator("#degree")).toHaveValue("masters");
  await expect(page.locator("#major")).toHaveValue("cs");
  await expect(page.locator("#status")).toHaveValue("expected");
  await expect(page.locator('[id="start--MONTH"]')).toHaveValue("8");
  await expect(page.locator('[id="start--YEAR"]')).toHaveValue("2025");
  await expect(page.locator('[id="end--MONTH"]')).toHaveValue("5");
  await expect(page.locator('[id="end--YEAR"]')).toHaveValue("2099");
  await expect(page.locator('[id="obtained--MONTH"]')).toHaveValue("");
  await expect(page.locator('[id="obtained--YEAR"]')).toHaveValue("");
  await expect(page.locator("#result")).toHaveValue("");
  await expect(page.locator("#previous")).toHaveValue("yes");
  await expect(page.locator("#previous + .select2")).toHaveText("Yes");
  await expect.poll(async () => (await state()).applications[0]?.missing.join(" ")).toContain("community college");
  const observation = (await content(page, { type: "INSPECT" })).data;
  expect(observation.fields.map((f: {label:string}) => f.label)).not.toContain("Hidden question");
  expect(observation.fields.map((f: {label:string}) => f.label)).not.toContain("unrelated");
  await page.locator('#previous + .select2 .select2-selection').click();
  await expect(page.locator("#previous")).toHaveValue("no");
  await ui({ type: "FILL_STEP", id: (await state()).applications[0].id });
  await expect.poll(async () => (await state()).applications[0]?.attempts.filter(a => a.completedAt).length).toBe(2);
  await expect(page.locator("#previous")).toHaveValue("no");
});

test("job fit checks show evidence and eligibility issues without filling, and discard assessments when inputs change", async () => {
  let calls = 0;
  const requirement = "Experience building TypeScript web applications";
  const preference = "Rust experience preferred";
  const sponsorship = "Applicants must not require visa sponsorship";
  const posting = `Requirements: ${requirement}. ${preference}. We are looking for an engineer to build accessible web applications for our product team, review implementation details, write automated tests, improve response times and collaborate with designers. Our benefits support flexible work and professional development for all members of the engineering team.`;
  const providerServer = createServer(async (req, res) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages[1].content);
    const background = input.evidence.find((entry: { text: string }) => entry.text.includes("Built accessible web applications"));
    const requirements = [
      { requirement, importance: "required", status: "matched", evidence: [{ id: background.id, quote: background.text }] },
      { requirement: preference, importance: "preferred", status: "gap", evidence: [] },
    ];
    if (input.job.description.includes(sponsorship)) {
      const fact = input.evidence.find((entry: { text: string }) => /^Work authorization: United States: .*needs sponsorship: yes$/.test(entry.text));
      requirements.push({ requirement: sponsorship, importance: "required", status: "unmet", evidence: [{ id: fact.id, quote: fact.text }] });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ requirements }) } }] }));
  });
  providerServer.listen(0, "127.0.0.1");
  await once(providerServer, "listening");
  appConfig.endpoint = `http://127.0.0.1:${(providerServer.address() as { port: number }).port}/v1`;
  try {
    const saved = await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, sponsorship: "Yes" } });
    await panel.reload();
    await context.route(`${atsOrigins[0]}/**`, (route) => route.fulfill({ contentType: "text/html", body: html("/fit-check") }));
    const page = await context.newPage();
    await page.goto(`${atsOrigins[0]}/fit-check`);
    const tabs = await panel.evaluate(async () => chrome.tabs.query({}));
    const tabId = tabs.find((tab) => tab.url === page.url())!.id!;
    await ui({ type: "TRACK_ITEMS", items: [{ url: page.url(), tabId }] });
    const app = (await state()).applications[0];
    await ui({ type: "UPDATE_APP", id: app.id, postingText: posting });
    await panel.bringToFront();
    const card = panel.getByRole("region", { name: `Job fit for ${app.title}`, exact: true }).first();
    await card.getByRole("button", { name: "Check fit", exact: true }).click();
    await expect(card.getByText("Good fit", { exact: true })).toBeVisible();
    await card.getByText("Evidence and gaps (2)").click();
    await expect(card.getByText("Built accessible web applications with TypeScript.", { exact: true })).toBeVisible();
    await expect(card.getByText("Preferred · Gap in your background evidence", { exact: true })).toBeVisible();
    const checked = (await state()).applications[0];
    expect(checked.fit?.profileRevision).toBe(saved.revision);
    expect(checked.fit?.verdict).toBe("good");
    expect(checked.attempts).toEqual([]);
    expect(checked.artifacts).toEqual([]);
    expect(checked.filled).toBe(0);
    expect(checked.explicitFill).toBe(false);
    expect(checked.status).toBe("awaiting-user");
    await expect(page.locator("[name=firstName]")).toHaveValue("");
    await expect(page.locator("[name=email]")).toHaveValue("");
    await panel.reload();
    await expect(card.getByText("Good fit", { exact: true })).toBeVisible();
    expect(calls).toBe(1);
    await ui({ type: "UPDATE_APP", id: app.id, postingText: posting + ` ${sponsorship}.` });
    await expect(card.getByText("Good fit", { exact: true })).toHaveCount(0);
    await card.getByRole("button", { name: "Check fit", exact: true }).click();
    await expect(card.getByText("Poor fit", { exact: true })).toBeVisible();
    await expect(card.getByText("Eligibility issue:", { exact: true })).toBeVisible();
    await expect(card.getByText(/^Your background: Work authorization: United States: .*needs sponsorship: yes$/)).toBeVisible();
    expect(calls).toBe(2);
    await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...saved, sponsorship: "No" } });
    expect((await state()).applications[0].fit).toBeUndefined();
    await expect(card.getByText("Poor fit", { exact: true })).toHaveCount(0);
    expect(submitted).toBe(0);
  } finally {
    providerServer.closeAllConnections();
    await new Promise<void>((resolve) => providerServer.close(() => resolve()));
  }
});

test("job fit requests a readable posting and handles model failures without a misleading verdict", async () => {
  await context.route(`${atsOrigins[0]}/**`, (route) => route.fulfill({ contentType: "text/html", body: html("/missing-fit-posting") }));
  const page = await context.newPage();
  await page.goto(`${atsOrigins[0]}/missing-fit-posting`);
  const tabs = await panel.evaluate(async () => chrome.tabs.query({}));
  await ui({ type: "TRACK_ITEMS", items: [{ url: page.url(), tabId: tabs.find((tab) => tab.url === page.url())!.id }] });
  const app = (await state()).applications[0];
  await ui({ type: "CHECK_FIT", id: app.id });
  await expect.poll(async () => (await state()).applications[0].fit?.needsPosting).toBe(true);
  const card = panel.getByRole("region", { name: `Job fit for ${app.title}`, exact: true }).first();
  await expect(card.getByText("Not enough information", { exact: true })).toBeVisible();
  await expect(panel.getByRole("form", { name: "Add the job posting" }).first()).toBeVisible();
  await ui({ type: "UPDATE_APP", id: app.id, postingText: "Requirements: Build TypeScript applications. " + "Work with our engineering team to build, test and maintain accessible interfaces for customers. ".repeat(5) });
  await ui({ type: "CHECK_FIT", id: app.id });
  await expect.poll(async () => (await state()).applications[0].fit?.verdict).toBe("unknown");
  await expect(card.getByText(/AI service is available/)).toBeVisible();
  expect((await state()).applications[0].artifacts).toEqual([]);
});

const answerPrompt = "Please give brief examples of technical products/work that you have worked on which has allowed you to demonstrate your strongest technical competencies (300 word limit).";
async function answerPage() {
  let calls = 0;
  const providerServer = createServer(async (req, res) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages[1].content);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers: input.questions.map((question: { id: string }) => ({ fieldId: question.id, text: "I built accessible web applications with TypeScript. I improved performance by 30%.", sources: ["Web application", "Performance work"] })) }) } }] }));
  });
  providerServer.listen(0, "127.0.0.1"); await once(providerServer, "listening");
  appConfig.endpoint = `http://127.0.0.1:${(providerServer.address() as { port: number }).port}/v1`;
  await context.route(`${talNetOrigin}/**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Global Technology Summer Analyst</title><main><h1>Business Specific Questions</h1><form>
    <fieldset><legend>Work examples</legend><div><label for="technical">${answerPrompt}</label><textarea id="technical" required></textarea><p>Maximum Word Count of 300words</p></div>
    <div><label for="other">Describe a project you are proud of</label><textarea id="other" maxlength="200"></textarea></div></fieldset>
    <div><label for="existing">Describe your biggest achievement</label><textarea id="existing">My existing answer</textarea></div>
    <label>Full name<input id="name"></label><label>I certify the information is true<textarea id="consent"></textarea></label>
    <button type="submit">Submit application</button></form></main><script>window.submissions=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submissions++}</script>` }));
  const page = await context.newPage(); await page.goto(`${talNetOrigin}/candidate/questions`);
  const tabs = await panel.evaluate(async () => chrome.tabs.query({}));
  const tabId = tabs.find((tab) => tab.url === page.url())!.id!;
  await ui({ type: "TRACK_ITEMS", items: [{ url: page.url(), tabId }] });
  const app = (await state()).applications[0];
  return { page, tabId, app, calls: () => calls, close: async () => { providerServer.closeAllConnections(); await new Promise<void>((r) => providerServer.close(() => r())); } };
}
async function completedAnswerJob() {
  let job: any;
  await expect.poll(async () => {
    const app = (await state()).applications[0];
    if (!app.answerSession) return "none";
    job = await ui({ type: "API", path: `/v1/jobs/${app.answerSession.jobId}` });
    return job.status;
  }).toBe("complete");
  return job;
}

test("TalNet questions support one or all drafts, editable review, limits and selected filling without documents", async () => {
  const fixture = await answerPage();
  try {
    const { page, tabId, app } = fixture;
    await page.bringToFront();
    const card = panel.getByRole("region", { name: "Application question answers", exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: "Draft all written responses (2)", exact: true })).toBeEnabled();
    const fields = (await ui({ type: "QUESTION_FIELDS", tabId })).fields;
    expect(fields).toHaveLength(2);
    expect(fields.find((field: { label: string }) => field.label === answerPrompt).maxWords).toBe(300);
    await card.getByText("Draft one question", { exact: true }).click();
    await card.getByRole("button", { name: "Draft this question", exact: true }).first().click();
    const single = await completedAnswerJob();
    expect(single.answerDrafts).toHaveLength(1);
    await expect(card.getByRole("textbox", { name: `Draft answer: ${answerPrompt}`, exact: true })).toHaveValue(/TypeScript/);
    await expect(page.locator("#technical")).toHaveValue("");
    const editor = card.getByRole("textbox", { name: `Draft answer: ${answerPrompt}`, exact: true });
    await editor.fill("word ".repeat(301));
    await expect(card.getByText("Use at most 300 words.", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Fill this answer", exact: true })).toBeDisabled();
    await editor.fill("I built accessible web applications with TypeScript.");
    await card.getByRole("button", { name: "Fill this answer", exact: true }).click();
    await expect(page.locator("#technical")).toHaveValue("I built accessible web applications with TypeScript.");
    await expect(page.locator("#other")).toHaveValue("");
    await expect(card.getByText("Filled", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Draft all written responses (1)", exact: true }).click();
    const batch = await completedAnswerJob();
    expect(batch.answerDrafts).toHaveLength(1);
    await expect(card.getByRole("button", { name: "Fill selected answers (1)", exact: true })).toBeEnabled();
    await card.getByRole("button", { name: "Fill selected answers (1)", exact: true }).click();
    await expect(page.locator("#other")).toHaveValue(/TypeScript/);
    await expect(card.getByText("No empty written-response questions are on this page.", { exact: false })).toBeVisible();
    await expect(card.getByRole("button", { name: /Draft all written responses/ })).toHaveCount(0);
    await expect(page.locator("#existing")).toHaveValue("My existing answer");
    await expect(page.locator("#name")).toHaveValue("");
    await expect(page.locator("#consent")).toHaveValue("");
    const saved = (await state()).applications[0];
    expect(saved.id).toBe(app.id); expect(saved.artifacts).toEqual([]); expect(saved.attempts).toEqual([]);
    expect(saved.filled).toBe(2); expect(fixture.calls()).toBe(2);
    expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
  } finally { await fixture.close(); }
});

test("reviewed batch filling keeps changed fields and refuses drafts after navigation or profile changes", async () => {
  const fixture = await answerPage();
  try {
    const { page, tabId, app } = fixture;
    await ui({ type: "DRAFT_ANSWERS", id: app.id, tabId });
    const job = await completedAnswerJob();
    expect(job.answerDrafts).toHaveLength(2);
    await page.locator("#technical").evaluate((element: HTMLTextAreaElement) => { element.value = "My newer answer"; });
    const result = await ui({ type: "FILL_ANSWERS", id: app.id, tabId, jobId: job.id, answers: job.answerDrafts.map((draft: any) => ({ fieldId: draft.fieldId, value: draft.value })) });
    expect(result.results.filter((result: any) => result.ok)).toHaveLength(1);
    expect(result.results.find((result: any) => !result.ok).reason).toMatch(/changed|protected/);
    await expect(page.locator("#technical")).toHaveValue("My newer answer");
    await expect(page.locator("#other")).toHaveValue(/TypeScript/);
    await page.goto(`${talNetOrigin}/candidate/next-page`);
    await expect.poll(async () => (await state()).applications[0].operation).not.toBe(result.state.applications[0].answerSession.operation);
    await expect(ui({ type: "FILL_ANSWERS", id: app.id, tabId, jobId: job.id, answers: [{ fieldId: job.answerDrafts[0].fieldId, value: job.answerDrafts[0].value }] })).rejects.toThrow(/stale/);
    await expect(page.locator("#technical")).toHaveValue("");
    await ui({ type: "DRAFT_ANSWERS", id: app.id, tabId });
    const refreshed = await completedAnswerJob();
    await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, facts: [...profile.facts, { id: "extra", text: "Built web interfaces." }] } });
    await expect(ui({ type: "FILL_ANSWERS", id: app.id, tabId, jobId: refreshed.id, answers: [{ fieldId: refreshed.answerDrafts[0].fieldId, value: refreshed.answerDrafts[0].value }] })).rejects.toThrow(/stale/);
    await expect(page.locator("#technical")).toHaveValue("");
  } finally { await fixture.close(); }
});

test("question drafting includes embedded frames and fills a reviewed batch across frames", async () => {
  const fixture = await answerPage();
  try {
    const { page, tabId, app } = fixture;
    await context.route(`${atsOrigins[1]}/**`, (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><form><div><label for="embedded">Describe your technical strengths</label><textarea id="embedded"></textarea><p>Maximum Word Count of 20words</p></div></form>' }));
    await page.locator("main").evaluate((main, url) => { const iframe = document.createElement("iframe"); iframe.src = url; main.append(iframe); }, `${atsOrigins[1]}/embedded-question`);
    await expect(page.frameLocator("iframe").locator("#embedded")).toBeVisible();
    const fields = (await ui({ type: "QUESTION_FIELDS", tabId })).fields;
    expect(fields).toHaveLength(3);
    expect(fields.find((field: { label: string }) => field.label === "Describe your technical strengths").maxWords).toBe(20);
    expect(fields.find((field: { label: string }) => field.label === "Describe a project you are proud of").maxWords).toBeUndefined();
    await ui({ type: "DRAFT_ANSWERS", id: app.id, tabId });
    const job = await completedAnswerJob();
    expect(job.answerDrafts).toHaveLength(3);
    const result = await ui({ type: "FILL_ANSWERS", id: app.id, tabId, jobId: job.id, answers: job.answerDrafts.map((draft: any) => ({ fieldId: draft.fieldId, value: draft.value })) });
    expect(result.results.filter((result: any) => result.ok)).toHaveLength(3);
    await expect(page.locator("#technical")).toHaveValue(/TypeScript/);
    await expect(page.locator("#other")).toHaveValue(/TypeScript/);
    await expect(page.frameLocator("iframe").locator("#embedded")).toHaveValue(/TypeScript/);
    expect((await state()).applications[0].artifacts).toEqual([]);
  } finally { await fixture.close(); }
});

// The AI-filling setting (decided 2026-10-11): what Fill this step lets the
// model do, and whether it may answer a legal question the profile cannot.
for (const level of [
  { modelFill: "auto", legalQuestions: "manual", legalDetails: false },
  { modelFill: "auto", legalQuestions: "manual", legalDetails: true },
  { modelFill: "auto", legalQuestions: "model", legalDetails: false },
  { modelFill: "review", legalQuestions: "manual", legalDetails: false },
  { modelFill: "off", legalQuestions: "manual", legalDetails: false },
] as const)
  test(`AI filling "${level.modelFill}" with legal questions "${level.legalQuestions}"${level.legalDetails ? " and saved legal details" : ""} fills, drafts or leaves what the setting says`, async () => {
    const asked: string[] = [];
    const providerServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages[1].content);
      // As a model would: a legal answer cites the saved legal detail when
      // there is one, and otherwise reaches for something unrelated.
      const saved = (input.sources || []).some((source: { id: string }) => source.id === "legal.criminal");
      const suggestions = (input.fields || []).map((candidate: { id: string; label: string }) => {
        asked.push(candidate.label);
        return /school attended/i.test(candidate.label)
          ? { fieldId: candidate.id, value: "Michigan State University", sourceIds: ["education.1"] }
          : /^minor$/i.test(candidate.label)
            ? { fieldId: candidate.id, value: "Mathematics", sourceIds: ["education.1"] }
          : /please explain/i.test(candidate.label)
            ? saved
              ? { fieldId: candidate.id, value: "N/A", sourceIds: ["legal.criminal"] }
              : { fieldId: candidate.id, skip: "Not in the saved details." }
            : /convicted/i.test(candidate.label)
              ? { fieldId: candidate.id, value: "No", sourceIds: [saved ? "legal.criminal" : "education.1"] }
              : { fieldId: candidate.id, skip: "Not in the saved details." };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions }) } }] }));
    });
    providerServer.listen(0, "127.0.0.1");
    await once(providerServer, "listening");
    try {
      appConfig.endpoint = `http://127.0.0.1:${(providerServer.address() as { port: number }).port}/v1`;
      await ui({
        type: "API",
        path: "/v1/profile",
        method: "PUT",
        body: {
          ...profile,
          education: [{ organization: "Michigan State University", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2022-08", endDate: "2026-05", location: "East Lansing, Michigan" }],
          ...(level.legalDetails ? { legal: { criminal: "No convictions and no pending charges" } } : {}),
        },
      });
      await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, modelFill: level.modelFill, legalQuestions: level.legalQuestions } });
      await panel.reload();
      await context.route(`${talNetOrigin}/ai-filling`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><title>AI filling</title><main><h1>Application</h1><form>
            <label for="email">Email</label><input id="email" type="email" required>
            <label for="school">School Attended</label><input id="school" required>
            <label for="felony">Have you ever been convicted of a felony?</label><select id="felony" required><option value="">Choose</option><option>Yes</option><option>No</option></select>
            <label for="explain">If you have been convicted of a felony, please explain</label><textarea id="explain"></textarea>
            <label for="essay">Describe a project</label><textarea id="essay"></textarea>
            <label for="minor">Minor</label><input id="minor">
            <button type="submit">Submit application</button></form></main>`,
        }),
      );
      const page = await context.newPage();
      await page.goto(`${talNetOrigin}/ai-filling`);
      const tabId = (await panel.evaluate(async () => chrome.tabs.query({}))).find((tab) => tab.url === page.url())!.id!;
      await ui({ type: "TRACK_ITEMS", items: [{ url: page.url(), tabId }] });
      await ui({ type: "FILL_STEP", id: (await state()).applications[0].id, tabId });
      // The profile's part is the same at every level.
      await expect(page.locator("#email")).toHaveValue(profile.email, { timeout: 25000 });
      const app = async () => (await state()).applications[0];
      if (level.modelFill === "auto") {
        await expect(page.locator("#school")).toHaveValue("Michigan State University", { timeout: 30000 });
        await expect(page.locator("#essay")).not.toHaveValue("");
        await expect.poll(async () => ((await app()).aiFilled || []).map((entry: { label: string }) => entry.label)).toEqual(
          expect.arrayContaining(["School Attended", "Describe a project"]),
        );
        // What AI filled is no longer listed as unanswered (Elucid's "College
        // or University", 2026-10-30: filled, and still listed as optional).
        await expect(page.locator("#minor")).toHaveValue("Mathematics", { timeout: 30000 });
        await expect.poll(async () => (await app()).missing.filter((item: string) => item === "Optional unanswered: Minor")).toEqual([]);
        const left = async () => (await app()).missing.filter((item: string) => item.startsWith("Legal or eligibility question left for you"));
        if (level.legalDetails) {
          // The applicant's own saved words answer both, at the default setting.
          await expect(page.locator("#felony")).toHaveValue("No", { timeout: 30000 });
          await expect(page.locator("#explain")).toHaveValue("N/A");
          expect(await left()).toEqual([]);
        } else if (level.legalQuestions === "manual") {
          await expect.poll(async () => (await left()).length).toBe(2);
          await expect(page.locator("#felony")).toHaveValue("");
          await expect(page.locator("#explain")).toHaveValue("");
          expect(asked.join(" | ")).not.toMatch(/convicted/i);
        } else {
          // Any saved source will do; what the model skips is still listed.
          await expect(page.locator("#felony")).toHaveValue("No", { timeout: 30000 });
          await expect(page.locator("#explain")).toHaveValue("");
          await expect.poll(async () => (await left()).join(" | ")).toContain("please explain");
        }
        // Nothing waits for approval, and the card lists what to check.
        await expect.poll(async () => (await app()).fieldFallbackSession).toBeUndefined();
        await page.bringToFront();
        await panel.getByRole("button", { name: "Scan current tab" }).click();
        await expect(panel.getByText(/Filled by AI: check these/)).toBeVisible();
      } else if (level.modelFill === "review") {
        await expect.poll(async () => Boolean((await app()).fieldFallbackSession?.jobId), { timeout: 30000 }).toBe(true);
        await expect.poll(async () => Boolean((await app()).answerSession?.jobId), { timeout: 30000 }).toBe(true);
        await expect(page.locator("#school")).toHaveValue("");
        await expect(page.locator("#essay")).toHaveValue("");
        await expect(page.locator("#felony")).toHaveValue("");
        expect((await app()).aiFilled || []).toEqual([]);
      } else {
        await expect.poll(async () => (await app()).status, { timeout: 25000 }).toBe("awaiting-user");
        await page.waitForTimeout(3000);
        await expect(page.locator("#school")).toHaveValue("");
        await expect(page.locator("#essay")).toHaveValue("");
        expect((await app()).fieldFallbackSession).toBeUndefined();
        expect(asked).toEqual([]);
      }
      await page.close();
    } finally {
      await new Promise<void>((resolve) => providerServer.close(() => resolve()));
    }
  });

// A filled form looks finished while the model is still suggesting values
// for the rest. The applicant starts on the remaining fields, and that edit
// used to discard the suggestions (a live application, 2026-10-12: the school, degree
// and export-control answers of earlier runs never arrived).
test("an edit while AI is still suggesting keeps the suggestions and the applicant's own answer", async () => {
  const providerServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages[1].content);
    const suggestions = (input.fields || []).map((candidate: { id: string; label: string }) =>
      /school attended/i.test(candidate.label)
        ? { fieldId: candidate.id, value: "Michigan State University", sourceIds: ["education.1"] }
        : /nickname/i.test(candidate.label)
          ? { fieldId: candidate.id, value: "Model", sourceIds: ["education.1"] }
          : { fieldId: candidate.id, skip: "Not in the saved details." },
    );
    // Slow enough for the applicant to start typing first.
    if ((input.fields || []).some((candidate: { label: string }) => /school attended/i.test(candidate.label)))
      await new Promise((resolve) => setTimeout(resolve, 4000));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions }) } }] }));
  });
  providerServer.listen(0, "127.0.0.1");
  await once(providerServer, "listening");
  try {
    appConfig.endpoint = `http://127.0.0.1:${(providerServer.address() as { port: number }).port}/v1`;
    await ui({
      type: "API",
      path: "/v1/profile",
      method: "PUT",
      body: { ...profile, education: [{ organization: "Michigan State University", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2022-08", endDate: "2026-05", location: "East Lansing, Michigan" }] },
    });
    await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, modelFill: "auto", legalQuestions: "manual" } });
    await panel.reload();
    await context.route(`${talNetOrigin}/still-suggesting`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>Still suggesting</title><main><h1>Application</h1><form>
          <label for="email">Email</label><input id="email" type="email" required>
          <label for="school">School Attended</label><input id="school" required>
          <label for="nickname">Nickname</label><input id="nickname" required>
          <button type="submit">Submit application</button></form></main>`,
      }),
    );
    const page = await context.newPage();
    await page.goto(`${talNetOrigin}/still-suggesting`);
    const tabId = (await panel.evaluate(async () => chrome.tabs.query({}))).find((tab) => tab.url === page.url())!.id!;
    await ui({ type: "TRACK_ITEMS", items: [{ url: page.url(), tabId }] });
    await ui({ type: "FILL_STEP", id: (await state()).applications[0].id, tabId });
    const app = async () => (await state()).applications[0];
    // The fill reads as finished, and the suggestion step is running.
    await expect.poll(async () => { const now = await app(); return now.assisting && ["awaiting-user", "ready"].includes(now.status); }, { timeout: 30000 }).toBe(true);
    await expect(page.locator("#school")).toHaveValue("");
    // The card says so, where it used to read "Needs attention".
    await expect(panel.getByText("Still filling").first()).toBeVisible();
    await page.bringToFront();
    await page.locator("#nickname").click();
    await page.keyboard.type("Lex");
    // The suggestion still arrives, and never over what the applicant typed.
    await expect(page.locator("#school")).toHaveValue("Michigan State University", { timeout: 30000 });
    await expect(page.locator("#nickname")).toHaveValue("Lex");
    await expect.poll(async () => (await app()).assisting, { timeout: 30000 }).toBeFalsy();
    const done = await app();
    expect((done.aiFilled || []).map((entry: { label: string }) => entry.label)).toEqual(["School Attended"]);
    expect(done.status).not.toBe("paused");
    await expect(page.locator("#nickname")).toHaveValue("Lex");
    // A later edit, with nothing running, pauses the application, and the
    // card names it. The extension had already paused the page itself when
    // the fill ended, and the note then came without its cause.
    await page.locator("#school").click();
    await expect.poll(async () => (await app()).status).toBe("paused");
    expect((await app()).note).toMatch(/^You interacted with this application \(a click on "School Attended"\)\./);
  } finally {
    await new Promise<void>((resolve) => providerServer.close(() => resolve()));
  }
});

test("with AI filling automatically, trying it again is offered only when something has changed", async () => {
  const providerServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages[1].content);
    const suggestions = (input.fields || []).map((candidate: { id: string; label: string }) =>
      /school attended/i.test(candidate.label)
        ? { fieldId: candidate.id, value: "Michigan State University", sourceIds: ["education.1"] }
        : { fieldId: candidate.id, skip: "Not in the saved details." },
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions }) } }] }));
  });
  providerServer.listen(0, "127.0.0.1");
  await once(providerServer, "listening");
  try {
    appConfig.endpoint = `http://127.0.0.1:${(providerServer.address() as { port: number }).port}/v1`;
    const education = [{ organization: "Michigan State University", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2022-08", endDate: "2026-05", location: "East Lansing, Michigan" }];
    await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...profile, education } });
    await ui({ type: "SETTINGS", settings: { concurrency: 4, generationConcurrency: 2, modelFill: "auto", legalQuestions: "manual" } });
    await panel.reload();
    await context.route(`${talNetOrigin}/try-again`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>Try again</title><main><h1>Application</h1><form>
          <label for="email">Email</label><input id="email" type="email" required>
          <label for="school">School Attended</label><input id="school" required>
          <label for="years">Years Completed</label><input id="years" required>
          <button type="submit">Submit application</button></form></main>`,
      }),
    );
    const page = await context.newPage();
    await page.goto(`${talNetOrigin}/try-again`);
    const tabId = (await panel.evaluate(async () => chrome.tabs.query({}))).find((tab) => tab.url === page.url())!.id!;
    await ui({ type: "TRACK_ITEMS", items: [{ url: page.url(), tabId }] });
    await ui({ type: "FILL_STEP", id: (await state()).applications[0].id, tabId });
    const app = async () => (await state()).applications[0];
    await expect(page.locator("#school")).toHaveValue("Michigan State University", { timeout: 30000 });
    await expect.poll(async () => (await app()).aiPass?.finished, { timeout: 30000 }).toBe(true);
    await page.bringToFront();
    const review = panel.getByRole("region", { name: "AI review for unfilled fields", exact: true });
    // The one it skipped had no saved source: asking again would find none.
    await expect(review.getByText("Years Completed", { exact: true })).toBeVisible();
    await expect(review.getByText(/AI already looked at these/)).toBeVisible();
    await expect(review.getByRole("button", { name: /Try AI again|Ask AI for suggestions/ })).toHaveCount(0);
    // A changed profile might answer it.
    const saved = await ui({ type: "API", path: "/v1/profile" });
    await ui({ type: "API", path: "/v1/profile", method: "PUT", body: { ...saved, location: "Phoenix, Arizona" } });
    await panel.reload();
    await page.bringToFront();
    await expect(review.getByRole("button", { name: "Try AI again (1)", exact: true })).toBeVisible();
  } finally {
    await new Promise<void>((resolve) => providerServer.close(() => resolve()));
  }
});

test("structured AI fallback lists unresolved fields before an explicit reviewed fill", async () => {
  // "Degree Level Sought": the profile answers a plain "Degree Level" (the
  // degree under way, 2026-11-05), so the list AI must suggest for asks
  // something the profile does not hold.
  let calls = 0;
  const providerServer = createServer(async (req, res) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(
      JSON.parse(Buffer.concat(chunks).toString()).messages[1].content,
    );
    const suggestions = input.fields.map(
      (candidate: { id: string; label: string }) =>
        /school attended/i.test(candidate.label)
          ? {
              fieldId: candidate.id,
              value: "Michigan State University",
              sourceIds: ["education.1"],
            }
          : /degree level/i.test(candidate.label)
            ? {
                fieldId: candidate.id,
                value: "Bachelor's degree",
                sourceIds: ["education.1"],
              }
            : {
                fieldId: candidate.id,
                skip: "The saved dates do not state how this site counts completed years.",
              },
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ suggestions }) } }],
      }),
    );
  });
  providerServer.listen(0, "127.0.0.1");
  await once(providerServer, "listening");
  try {
  appConfig.endpoint = `http://127.0.0.1:${(providerServer.address() as { port: number }).port}/v1`;
  await ui({
    type: "API",
    path: "/v1/profile",
    method: "PUT",
    body: {
      ...profile,
      education: [
        {
          organization: "Michigan State University",
          title: "Bachelor of Science",
          fieldOfStudy: "Computer Science",
          startDate: "2022-08",
          endDate: "2026-05",
          location: "East Lansing, Michigan",
        },
      ],
    },
  });
  // Refresh the panel's profile revision after changing the backend directly.
  await panel.reload();
  await context.route(`${talNetOrigin}/structured-fallback`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Education fallback</title><main><h1>Education Information</h1><form><fieldset><legend>Education Information 1</legend>
        <label for="school">School Attended</label><input id="school" required>
        <label for="degree">Degree Level Sought</label><select id="degree" required><option value="">Choose</option><option>High school</option><option>Bachelor's degree</option><option>Master's degree</option></select>
        <label for="years">Years Completed</label><input id="years" required>
        </fieldset><label for="essay">Describe a project</label><textarea id="essay"></textarea>
        <label><input id="certify" type="checkbox"> I certify this information is true</label>
        <button type="submit">Submit application</button></form></main>
        <script>window.submissions=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submissions++}</script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${talNetOrigin}/structured-fallback`);
  const tabs = await panel.evaluate(async () => chrome.tabs.query({}));
  const tabId = tabs.find((tab) => tab.url === page.url())!.id!;
  await ui({ type: "TRACK_ITEMS", items: [{ url: page.url(), tabId }] });
  const app = (await state()).applications[0];
  await ui({ type: "FILL_STEP", id: app.id, tabId });
  await expect
    .poll(async () => (await state()).applications[0].status)
    .toBe("awaiting-user");
  expect(calls).toBe(0);
  await page.bringToFront();
  const review = panel.getByRole("region", {
    name: "AI review for unfilled fields",
    exact: true,
  });
  await expect(review).toBeVisible();
  await expect(review.getByText("School Attended", { exact: true })).toBeVisible();
  await expect(review.getByText("Degree Level Sought", { exact: true })).toBeVisible();
  await expect(review.getByText("Years Completed", { exact: true })).toBeVisible();
  await expect(review.getByText("Describe a project", { exact: true })).toHaveCount(0);
  await expect(review.getByText(/Normal fill could not match this field/)).toHaveCount(3);
  await expect(page.locator("#school")).toHaveValue("");
  await review.getByRole("button", { name: "Ask AI for suggestions (3)", exact: true }).click();
  let job: any;
  await expect.poll(async () => {
    const current = (await state()).applications[0];
    if (!current.fieldFallbackSession?.jobId) return "none";
    job = await ui({ type: "API", path: `/v1/jobs/${current.fieldFallbackSession.jobId}` });
    return job.status;
  }).toBe("complete");
  expect(calls).toBe(1);
  expect(job.artifacts).toEqual([]);
  expect(job.fieldDrafts).toHaveLength(3);
  await expect(page.locator("#school")).toHaveValue("");
  const school = review.getByRole("textbox", {
    name: "Suggested value: School Attended",
    exact: true,
  });
  await expect(school).toHaveValue("Michigan State University");
  await school.fill("MSU");
  await expect(
    review.getByRole("combobox", {
      name: "Suggested value: Degree Level Sought",
      exact: true,
    }),
  ).toHaveValue("Bachelor's degree");
  await expect(review.getByText(/AI left this blank: The saved dates/)).toBeVisible();
  // A value entered on the page after review wins over the AI suggestion.
  await page.locator("#school").evaluate((element: HTMLInputElement) => {
    element.value = "My newer school";
  });
  await review
    .getByRole("button", { name: "Fill selected suggestions (2)", exact: true })
    .click();
  await expect(page.locator("#school")).toHaveValue("My newer school");
  await expect(page.locator("#degree")).toHaveValue("Bachelor's degree");
  await expect(review.getByText(/field changed, was filled, or is protected/i)).toBeVisible();
  await expect(page.locator("#years")).toHaveValue("");
  await expect(page.locator("#essay")).toHaveValue(/TypeScript/);
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
  } finally {
    providerServer.closeAllConnections();
    await new Promise<void>((resolve) => providerServer.close(() => resolve()));
  }
});

test("profile writes wait for the form's delayed select handlers", async () => {
  const compiled = await build({
    entryPoints: ["tests/browser/react-select-fixture.tsx"], bundle: true, write: false,
    format: "iife", define: { "process.env.NODE_ENV": '"production"' },
  });
  await context.route(`${origin}/delayed-form-handlers`, route => route.fulfill({
    contentType: "text/html",
    body: `<html><body><div id="root"></div><script>${compiled.outputFiles[0].text}</script></body></html>`,
  }));
  const current = await ui({ type: "API", path: "/v1/profile" });
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: {
    ...current, confirmed: true, answers: [{ question: "School", answer: "Michigan State University" }],
  } });
  const page = await context.newPage();
  await page.goto(`${origin}/delayed-form-handlers`);
  await expect(page.locator("#school")).toBeVisible();
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#school")!;
    const key = Object.keys(input).find(key => key.startsWith("__reactFiber$"))!;
    if (!key) throw new Error("Fixture component did not attach.");
    const fiber = (input as any)[key];
    delete (input as any)[key];
    (window as any).earlyProfileWrites = 0;
    (window as any).fixtureSubmits = 0;
    const email = document.querySelector<HTMLInputElement>('input[name="email"]')!;
    const observe = () => {
      if (!(input as any)[key]) (window as any).earlyProfileWrites++;
    };
    email.addEventListener("input", observe);
    email.addEventListener("change", observe);
    document.querySelector("form")!.addEventListener("submit", () => (window as any).fixtureSubmits++);
    setTimeout(() => { (input as any)[key] = fiber; }, 6000);
  });
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications.find(app => app.url === page.url())?.status,
    { timeout: 25000 }).toMatch(/awaiting-user|ready/);
  expect(await page.evaluate(() => (window as any).earlyProfileWrites)).toBe(0);
  await expect(page.locator('input[name="email"]')).toHaveValue(current.email);
  expect(await page.evaluate(() => (window as any).selected.school)).toBe("s11");
  await expect(page.locator("#school")).toHaveValue("");
  expect(await page.evaluate(() => (window as any).fixtureSubmits)).toBe(0);
  await page.close();
});

test("server-rendered selects wait for their first React commit before selecting", async () => {
  const compiled = await build({
    entryPoints: ["tests/browser/ssr-select-fixture.tsx"], bundle: true, write: false,
    format: "iife", define: { "process.env.NODE_ENV": '"production"' },
  });
  await context.route(`${origin}/hydrating-select`, route => route.fulfill({
    contentType: "text/html",
    body: `<html><body><div id="root">${ssrSelectMarkup()}</div><script>${compiled.outputFiles[0].text}</script></body></html>`,
  }));
  const current = await ui({ type: "API", path: "/v1/profile" });
  const page = await context.newPage();
  await page.goto(`${origin}/hydrating-select`);
  expect(await page.evaluate(() => (window as any).formCommitted)).toBe(false);
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications.find(app => app.url === page.url())?.status,
    { timeout: 25000 }).toBe("ready");
  expect(await page.evaluate(() => (window as any).earlySelections)).toBe(0);
  expect(await page.evaluate(() => (window as any).formCommitted)).toBe(true);
  await expect(page.locator('input[name="email"]')).toHaveValue(current.email);
  await expect(page.locator(".select__single-value")).toHaveText("United States");
  expect(await page.evaluate(() => (window as any).selectedCountry)).toBe("us");
  expect(await page.evaluate(() => (window as any).fixtureSubmits)).toBe(0);
  await page.close();
});

test("profile writes wait for the select API even when its React marker already exists", async () => {
  const compiled = await build({
    entryPoints: ["tests/browser/react-select-fixture.tsx"], bundle: true, write: false,
    format: "iife", define: { "process.env.NODE_ENV": '"production"' },
  });
  await context.route(`${origin}/delayed-select-api`, route => route.fulfill({
    contentType: "text/html",
    body: `<html><body><div id="root"></div><script>${compiled.outputFiles[0].text}</script></body></html>`,
  }));
  const current = await ui({ type: "API", path: "/v1/profile" });
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: {
    ...current, confirmed: true, answers: [{ question: "School", answer: "Michigan State University" }],
  } });
  const page = await context.newPage();
  await page.goto(`${origin}/delayed-select-api`);
  await expect(page.locator("#school")).toBeVisible();
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#school")!;
    const key = Object.keys(input).find(key => key.startsWith("__reactFiber$"))!;
    let fiber = (input as any)[key];
    let select: any;
    for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
      if (typeof fiber.stateNode?.selectOption === "function" && Array.isArray(fiber.stateNode.props?.options)) {
        select = fiber.stateNode;
        break;
      }
    }
    if (!select) throw new Error("Fixture select API did not attach.");
    const original = select.selectOption;
    select.selectOption = undefined;
    (window as any).earlyProfileWrites = 0;
    (window as any).fixtureSubmits = 0;
    const observe = () => {
      if (typeof select.selectOption !== "function") (window as any).earlyProfileWrites++;
    };
    const email = document.querySelector<HTMLInputElement>('input[name="email"]')!;
    email.addEventListener("input", observe);
    email.addEventListener("change", observe);
    document.querySelector("form")!.addEventListener("submit", () => (window as any).fixtureSubmits++);
    setTimeout(() => { select.selectOption = original; }, 6000);
  });
  await enqueue([page]);
  await expect.poll(async () => (await state()).applications.find(app => app.url === page.url())?.status,
    { timeout: 25000 }).toMatch(/awaiting-user|ready/);
  expect(await page.evaluate(() => (window as any).earlyProfileWrites)).toBe(0);
  await expect(page.locator('input[name="email"]')).toHaveValue(current.email);
  expect(await page.evaluate(() => (window as any).selected.school)).toBe("s11");
  await expect(page.locator("#school")).toHaveValue("");
  expect(await page.evaluate(() => (window as any).fixtureSubmits)).toBe(0);
  await page.close();
});

test("react-select waits for component attachment without replaying an opening or overriding a real edit", async () => {
  const compiled = await build({
    entryPoints: ["tests/browser/react-select-fixture.tsx"], bundle: true, write: false,
    format: "iife", define: { "process.env.NODE_ENV": '"production"' },
  });
  await context.route(`${origin}/delayed-component*`, route => route.fulfill({
    contentType: "text/html",
    body: `<html><body><div id="root"></div><script>${compiled.outputFiles[0].text}</script></body></html>`,
  }));
  const current = await ui({ type: "API", path: "/v1/profile" });
  await ui({ type: "API", path: "/v1/profile", method: "PUT", body: {
    ...current, confirmed: true, answers: [{ question: "School", answer: "Michigan State University" }],
  } });
  for (const mode of ["delayed", "never", "real-edit"]) {
    const page = await context.newPage();
    await page.goto(`${origin}/delayed-component?mode=${mode}`);
    await expect(page.locator("#school")).toBeVisible();
    await page.evaluate(mode => {
      const input = document.querySelector<HTMLInputElement>("#school")!;
      const key = Object.keys(input).find(key => key.startsWith("__reactFiber$"))!;
      if (!key) throw new Error("Fixture component did not attach.");
      const fiber = (input as any)[key];
      delete (input as any)[key];
      (window as any).waitingForComponent = false;
      (window as any).earlyOpenings = 0;
      (window as any).fixtureSubmits = 0;
      input.addEventListener("mousedown", event => {
        if (!event.isTrusted && !(input as any)[key]) (window as any).earlyOpenings++;
      });
      document.querySelector("form")!.addEventListener("submit", () => (window as any).fixtureSubmits++);
      const observer = new MutationObserver(records => {
        if (!records.some(record => record.attributeName === "data-application-lane-main")) return;
        observer.disconnect();
        (window as any).waitingForComponent = true;
        if (mode !== "never") setTimeout(() => { (input as any)[key] = fiber; }, mode === "real-edit" ? 1500 : 200);
      });
      observer.observe(input, { attributes: true });
    }, mode);
    await enqueue([page]);
    if (mode === "real-edit") {
      await expect.poll(() => page.evaluate(() => (window as any).waitingForComponent)).toBe(true);
      await page.bringToFront();
      await page.locator("#school").fill("My school edit");
    }
    await expect.poll(async () => (await state()).applications.find(app => app.url === page.url())?.status,
      { timeout: 25000 }).toMatch(/awaiting-user|ready|paused/);
    if (mode === "delayed") {
      expect(await page.evaluate(() => (window as any).selected.school)).toBe("s11");
      await expect(page.locator("#school")).toHaveValue("");
      expect(await page.evaluate(() => (window as any).earlyOpenings)).toBe(0);
    } else if (mode === "never") {
      expect(await page.evaluate(() => (window as any).selected.school)).toBeUndefined();
      await expect(page.locator("#school")).toHaveValue("");
      expect(await page.evaluate(() => (window as any).earlyOpenings)).toBe(0);
      expect((await state()).applications.find(app => app.url === page.url())?.missing.join(" ")).toContain("component was not ready within 5 seconds");
    } else {
      await page.waitForTimeout(1800);
      expect(await page.evaluate(() => (window as any).selected.school)).toBeUndefined();
      await expect(page.locator("#school")).toHaveValue("My school edit");
    }
    expect(await page.evaluate(() => (window as any).fixtureSubmits)).toBe(0);
    await page.close();
  }
});
