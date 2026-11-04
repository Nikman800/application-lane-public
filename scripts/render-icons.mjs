// Renders src/extension/icons/logo.svg to the PNG sizes Chrome's toolbar and
// extensions page use. Run after changing the logo:
//   node scripts/render-icons.mjs
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

const svg = await readFile("src/extension/icons/logo.svg", "utf8");
const browser = await chromium.launch();
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await writeFile(`src/extension/icons/icon-${size}.png`, await page.screenshot({ omitBackground: true }));
    await page.close();
  }
} finally {
  await browser.close();
}
console.log("Icons written to src/extension/icons.");
