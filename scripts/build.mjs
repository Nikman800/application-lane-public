import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, copyFile, cp, rm, writeFile, readdir } from "node:fs/promises";
import { extensionManifest } from "./manifest.mjs";

// npm run build            the extension (dist/extension), the eval's
//                          baseline (dist/extension-baseline) and the
//                          backend bundle (dist/server)
// npm run build -- --store the Chrome Web Store build (dist/extension-store)
const store = process.argv.includes("--store");
// The one place the version is kept.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

// When and from what this build was made, for the panel (src/shared/build.ts)
// and the backend, which tells a loaded build from a newer one in dist/.
const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const changed = git("status", "--porcelain", "--untracked-files=no", "--", "src", "scripts");
// The themes (src/shared/theme.ts) as CSS custom properties, linked before
// panel.css so a page draws in its theme from the first frame.
const themeModule = await build({
  entryPoints: ["src/shared/theme.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const { themeStylesheet } = await import(
  `data:text/javascript;base64,${Buffer.from(themeModule.outputFiles[0].text).toString("base64")}`
);
const themesCss = themeStylesheet();
const icons = (await readdir("src/extension/icons")).filter((file) => /^icon-\d+\.png$/.test(file));
const iconSet = Object.fromEntries(
  icons.map((file) => [file.match(/\d+/)[0], `icons/${file}`]).sort((a, b) => Number(a[0]) - Number(b[0])),
);
const stamp = { builtAt: Date.now(), commit: `${git("rev-parse", "--short", "HEAD") || "unknown"}${changed ? "+changes" : ""}` };

// The owner's development tools (the dashboard's Fixer page): on where
// scripts/fixer.ts is in the tree, unless LANE_DEV_TOOLS=1 or 0 says
// otherwise. The same rule as devToolsEnabled in src/shared/dev-tools.ts.
const devTools = process.env.LANE_DEV_TOOLS === "1" || (process.env.LANE_DEV_TOOLS !== "0" && existsSync("scripts/fixer.ts"));

const targets = store
  ? [["dist/extension-store", "store"]]
  : [
      ["dist/extension", "extension"],
      ["dist/extension-baseline", "baseline"],
    ];
for (const [outdir, target] of targets) {
  const configEngine = target !== "baseline";
  // A store build starts clean, so nothing from an older build is shipped.
  if (target === "store") await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: [
      "src/extension/background.ts",
      "src/extension/content.ts",
      "src/extension/panel.tsx",
      "src/extension/theme-boot.ts",
    ],
    outdir,
    bundle: true,
    format: "iife",
    target: "chrome120",
    sourcemap: true,
    minify: false,
    define: {
      "process.env.NODE_ENV": '"production"',
      __CONFIG_ENGINE__: String(configEngine),
      __BUILD__: JSON.stringify(stamp),
      __LANE_DEV_TOOLS__: String(devTools && target !== "store"),
      __STORE_BUILD__: String(target === "store"),
    },
  });
  await writeFile(`${outdir}/build.json`, JSON.stringify(stamp));
  await build({
    entryPoints: ["src/engine/page/mainWorld.ts"],
    outdir,
    bundle: true,
    format: "iife",
    target: "chrome120",
    sourcemap: true,
    minify: false,
    treeShaking: false,
  });
  for (const file of ["panel.html", "dashboard.html", "panel.css"])
    await copyFile(`src/extension/${file}`, `${outdir}/${file}`);
  await writeFile(`${outdir}/themes.css`, themesCss);
  await mkdir(`${outdir}/icons`, { recursive: true });
  for (const file of [...icons, "logo.svg"])
    await copyFile(`src/extension/icons/${file}`, `${outdir}/icons/${file}`);
  await writeFile(`${outdir}/manifest.json`, JSON.stringify(extensionManifest({ target, version, icons: iconSet }), null, 2));
  console.log(
    `Extension built: ${outdir} (${target === "baseline" ? "baseline" : target === "store" ? "Chrome Web Store" : "v2"}, ${version})`,
  );
}

// The backend as plain JavaScript, so it runs with node alone (no tsx):
// node dist/server/index.mjs, or the application-lane and lane commands
// (package.json bin). The runtime dependencies stay in node_modules: pdf.js
// in particular is imported on demand and must keep its own files.
// dist/server sits two levels below the package root like src/server, so
// paths.ts finds the root, tailor/ and dist/extension the same way.
if (!store) {
  for (const [entry, name] of [
    ["src/server/index.ts", "index"],
    ["src/server/setup.ts", "setup"],
    ["scripts/lane.ts", "lane"],
  ])
    await build({
      entryPoints: [entry],
      outfile: `dist/server/${name}.mjs`,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      packages: "external",
      sourcemap: true,
      banner: { js: "#!/usr/bin/env node" },
      logLevel: "warning",
    });
  // Files the backend reads beside its own module.
  for (const folder of ["words", "defaults"])
    await cp(`src/server/${folder}`, `dist/server/${folder}`, { recursive: true });
  console.log(`Backend built: dist/server (${version})`);
}
