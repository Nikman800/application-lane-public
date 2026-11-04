// npm run package: release artifacts in release/.
//   application-lane-extension-<version>.zip        dist/extension, to load unpacked
//   application-lane-extension-store-<version>.zip  dist/extension-store, for the Chrome Web Store
//   application-lane-backend-<version>.tgz          the bundled backend as an npm package
//                                                   (npm i -g ./application-lane-backend-<version>.tgz)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const { version } = pkg;
const node = process.execPath;

execFileSync(node, ["scripts/build.mjs"], { stdio: "inherit" });
execFileSync(node, ["scripts/build.mjs", "--store"], { stdio: "inherit" });
await rm("release", { recursive: true, force: true });
await mkdir("release", { recursive: true });

async function files(folder) {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else found.push(path);
  }
  return found.sort();
}

// A plain zip (deflate), so packaging needs no zip program.
async function zip(folder, out, keep = () => true) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const path of (await files(folder)).filter(keep)) {
    const name = Buffer.from(relative(folder, path).split("\\").join("/"));
    const data = await readFile(path);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12); // 1980-01-01, for reproducible archives
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await writeFile(out, Buffer.concat([...local, directory, end]));
  console.log(`Packaged ${out}`);
}

// Source maps stay out of the release extension.
const noMaps = (path) => !path.endsWith(".map");
await zip("dist/extension", `release/application-lane-extension-${version}.zip`, noMaps);
await zip("dist/extension-store", `release/application-lane-extension-store-${version}.zip`, noMaps);

// The backend package: the bundle, the tailoring engine, and only the
// dependencies the backend imports (React is bundled into the extension).
const stage = join("release", ".stage");
await mkdir(join(stage, "dist"), { recursive: true });
await cp("dist/server", join(stage, "dist", "server"), { recursive: true, filter: (path) => !path.endsWith(".map") });
// So the backend can tell the dashboard which extension build it came with.
if (existsSync("dist/extension/build.json")) {
  await mkdir(join(stage, "dist", "extension"), { recursive: true });
  await cp("dist/extension/build.json", join(stage, "dist", "extension", "build.json"));
}
await cp("tailor", join(stage, "tailor"), { recursive: true, filter: (path) => !/__pycache__|\.pyc$/.test(path) });
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"])
  if (existsSync(file)) await cp(file, join(stage, file));
const runtime = ["@pdf-lib/fontkit", "docx", "mammoth", "pdf-lib", "pdfjs-dist", "ws", "zod"];
await writeFile(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "application-lane",
      version,
      description: "The local backend of Application Lane: prepares job applications in your browser, never submits them.",
      license: pkg.license,
      type: "module",
      engines: pkg.engines,
      bin: pkg.bin,
      files: ["dist/", "tailor/", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"],
      dependencies: Object.fromEntries(runtime.map((name) => [name, pkg.dependencies[name]])),
    },
    null,
    2,
  ),
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = execFileSync(npm, ["pack", "--silent", "--pack-destination", ".."], { cwd: stage, encoding: "utf8", shell: process.platform === "win32" })
  .trim()
  .split("\n")
  .at(-1);
await rename(join("release", packed), `release/application-lane-backend-${version}.tgz`);
await rm(stage, { recursive: true, force: true });
console.log(`Packaged release/application-lane-backend-${version}.tgz`);
