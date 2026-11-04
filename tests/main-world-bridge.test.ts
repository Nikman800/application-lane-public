import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

test("pending MAIN-world requests require the bound document and abort revokes their markers", async () => {
  const bundle = (
    await build({
      entryPoints: ["src/engine/page/bridge.ts"],
      bundle: true,
      format: "iife",
      globalName: "Bridge",
      write: false,
    })
  ).outputFiles[0].text;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://fixture.test/", (route) =>
      route.fulfill({ body: "<input>", contentType: "text/html" }),
    );
    await page.goto("https://fixture.test/");
    await page.addScriptTag({
      content: `window.__name = (fn) => fn;\n${bundle}`,
    });
    const result = await page.evaluate(async () => {
      let request: any;
      let finish!: (value: unknown) => void;
      (window as any).chrome = {
        runtime: {
          sendMessage(message: unknown) {
            request = message;
            return new Promise((resolve) => {
              finish = resolve;
            });
          },
        },
      };
      const controller = new AbortController();
      const guard = {
        applicationId: "app",
        operation: 1,
        documentId: "document",
      };
      const input = document.querySelector("input")!;
      const pending = (window as any).Bridge.requestMainWorld(
        input,
        guard,
        { method: "default", values: ["Alex"] },
        controller.signal,
      );
      const token = request.request.token;
      const authorized = (window as any).Bridge.authorizeMainWorld(
        guard,
        token,
      );
      const stale = (window as any).Bridge.authorizeMainWorld(
        { ...guard, documentId: "stale" },
        token,
      );
      controller.abort();
      const cancelled = (window as any).Bridge.authorizeMainWorld(guard, token);
      finish({ ok: true, data: { ok: true } });
      let error = "";
      try {
        await pending;
      } catch (e) {
        error = (e as Error).name;
      }
      return {
        authorized,
        stale,
        cancelled,
        marker: input.hasAttribute("data-application-lane-main"),
        error,
      };
    });
    assert.deepEqual(result, {
      authorized: true,
      stale: false,
      cancelled: false,
      marker: false,
      error: "AbortError",
    });
  } finally {
    await browser.close();
  }
});

test("a trusted-typing request carries the claim and the deletions the field holds", async () => {
  const bundle = (
    await build({
      entryPoints: ["src/engine/page/bridge.ts"],
      bundle: true,
      format: "iife",
      globalName: "Bridge",
      write: false,
    })
  ).outputFiles[0].text;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://fixture.test/", (route) =>
      route.fulfill({ body: "<input>", contentType: "text/html" }),
    );
    await page.goto("https://fixture.test/");
    await page.addScriptTag({
      content: `window.__name = (fn) => fn;\n${bundle}`,
    });
    const result = await page.evaluate(async () => {
      let request: any;
      let finish!: (value: unknown) => void;
      (window as any).chrome = {
        runtime: {
          sendMessage(message: unknown) {
            request = message;
            return new Promise((resolve) => {
              finish = resolve;
            });
          },
        },
      };
      const guard = {
        applicationId: "app",
        operation: 3,
        documentId: "document",
      };
      const input = document.querySelector("input")!;
      const pending = (window as any).Bridge.requestTrustedType(
        input,
        guard,
        "2025",
        2,
      );
      const token = request.request.token;
      // Only the element the background was asked about may be typed into.
      const authorized = (window as any).Bridge.authorizeMainWorld(
        guard,
        token,
      );
      const other = (window as any).Bridge.authorizeMainWorld(
        guard,
        "00000000-0000-4000-8000-000000000000",
      );
      finish({ ok: true, data: { ok: true } });
      await pending;
      return {
        type: request.type,
        text: request.request.text,
        clear: request.request.clear,
        operation: request.operation,
        authorized,
        other,
        marker: input.hasAttribute("data-application-lane-main"),
      };
    });
    assert.deepEqual(result, {
      type: "TRUSTED_TYPE",
      text: "2025",
      clear: 2,
      operation: 3,
      authorized: true,
      other: false,
      marker: false,
    });
  } finally {
    await browser.close();
  }
});
