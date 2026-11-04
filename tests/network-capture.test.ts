import { test } from "node:test";
import assert from "node:assert/strict";

let event: (source: any, method: string, params: any) => void;
let commands: string[] = [];
let response: Promise<any> = Promise.resolve({ body: "finished body", base64Encoded: false });
const url = "https://jobs.example.test/apply";
(globalThis as any).chrome = {
  runtime: { getManifest: () => ({ version: "test" }) },
  debugger: {
    attach: async () => {}, detach: async () => {},
    onEvent: { addListener: (listener: typeof event) => { event = listener; } },
    sendCommand: async (_target: any, method: string) => {
      commands.push(method);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.getResourceTree") return { frameTree: { frame: { id: "main", url }, resources: [
        { url: `${url}/widget.js`, type: "Script", mimeType: "text/javascript" },
        { url: `${url}/private.js?access_token=private`, type: "Script", mimeType: "text/javascript" },
      ] } };
      if (method === "Page.getResourceContent") return { content: "cached resource", base64Encoded: false };
      if (method === "Network.getResponseBody") return response;
      return {};
    },
  },
};
const { startCapture, stopCapture, captureHar } = await import("../src/extension/network-capture");

test("late capture recovers cached resources without a reload or network request", async () => {
  commands = [];
  await startCapture(10, false);
  const capture = await captureHar(10);
  assert.equal(capture?.fromLoad, false);
  assert.equal(capture?.recovered, 2);
  assert.equal(capture?.missing, 1);
  const entries = (capture?.har as any).log.entries;
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry: any) => entry._fromCacheRecovery));
  assert.ok(!JSON.stringify(entries).includes("access_token"));
  assert.ok(commands.includes("Page.enable"));
  assert.ok(commands.every((method) => !/navigate|reload|loadNetworkResource|fetch/i.test(method)));
  await stopCapture(10);
});

test("a report waits for in-flight response bodies and strips credential headers", async () => {
  let finish!: (body: any) => void;
  response = new Promise((resolve) => { finish = resolve; });
  await startCapture(11, true);
  event({ tabId: 11 }, "Network.requestWillBeSent", { requestId: "request", type: "Fetch", request: {
    method: "GET", url: `${url}/data`, headers: { Cookie: "private", Authorization: "private", "X-Api-Key": "private", Accept: "application/json" },
  } });
  event({ tabId: 11 }, "Network.responseReceived", { requestId: "request", response: { status: 200, mimeType: "application/json", headers: { "Set-Cookie": "private" } } });
  event({ tabId: 11 }, "Network.loadingFinished", { requestId: "request", encodedDataLength: 10 });
  const reporting = captureHar(11);
  finish({ body: '{"result":"complete"}', base64Encoded: false });
  const capture = await reporting;
  const entries = (capture?.har as any).log.entries;
  const data = entries.find((entry: any) => entry.request.url.endsWith("/data"));
  assert.equal(data.response.content.text, '{"result":"complete"}');
  assert.deepEqual(data.request.headers, [{ name: "Accept", value: "application/json" }]);
  assert.deepEqual(data.response.headers, []);
  await stopCapture(11);
});
