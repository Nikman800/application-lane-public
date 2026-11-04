# Development

How to build, test and package Application Lane. For how the pieces fit together, see [architecture and limits](architecture.md). For contribution guidelines, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Layout

| Path | What it is |
| --- | --- |
| `src/extension/` | The Manifest V3 extension: service worker (`background.ts`), content script (`content.ts`), and the React side panel and dashboard (`panel.tsx`) |
| `src/engine/` | The form engine and its per-site rules (`src/engine/config/sites/*.json`) |
| `src/server/` | The local backend on `127.0.0.1:4318`: profile storage, drafting, document rendering, job search |
| `src/shared/` | Types and logic shared by both, including themes (`theme.ts`) and progress (`progress.ts`) |
| `scripts/lane.ts` | The command line and full-screen terminal view |
| `scripts/build.mjs` | The build |
| `tailor/` | Optional Python/LaTeX résumé tailoring engine |
| `tests/` | Unit tests (`tests/*.test.ts`) and the browser suite (`tests/browser/`) |

## Setup

```bash
nvm use            # or install Node 22 another way; .nvmrc says 22
npm ci
```

## Everyday commands

```bash
npm run check                              # TypeScript type check
node --import tsx --test tests/*.test.ts   # unit tests (same as npm test)
npm run build                              # build the extension and the backend bundle
npm run dev                                # backend that restarts when src/ changes
```

`npm run build` writes:

- `dist/extension/`: the extension to load unpacked
- `dist/server/*.mjs`: the backend bundled into plain JavaScript (`node dist/server/index.mjs`)

After a build, reload the extension in `chrome://extensions`; it does not hot reload. A newer build waiting to be loaded is announced in the panel.

`npm start` runs the backend from source through `tsx`.

## Browser suite

The browser tests load the built extension in a disposable Chromium profile, with synthetic applicant data, a local fixture server and a fake drafting provider. They never contact real job sites or send applicant data anywhere.

```bash
npx playwright install chromium
npm run build
npm run test:browser                                          # everything but the benchmark
npx playwright test tests/browser/extension.spec.ts -g "<pattern>"   # one test or group
npm run benchmark                                             # throughput benchmark only
```

The suite runs Playwright's Chromium headless, three tests in parallel, and only one suite runs per machine at a time, so it also works on a machine without a display. `test-results/` keeps screenshots and traces of failures.

`npm run verify` runs the type check, unit tests, build and browser suite in one go.

## Chrome Web Store build

```bash
npm run build -- --store
```

writes `dist/extension-store/`, a variant for the Chrome Web Store. It has no `debugger` permission (so Workday date fields that need real keystrokes are left for the user to type, and network capture for issue reports is unavailable), no developer tools, and no manifest `key`.

## Packaging a release

```bash
npm run package
```

writes, under `release/`:

- `application-lane-extension-<version>.zip`: the built extension, ready to unzip and load unpacked
- `application-lane-extension-store-<version>.zip`: the Chrome Web Store build (dist/extension-store).
- `application-lane-backend-<version>.tgz`: the backend as an npm package. `npm i -g ./application-lane-backend-<version>.tgz` installs two commands: `application-lane` (the backend) and `lane` (the command line).

The version comes from `package.json`. Add a section to [CHANGELOG.md](../CHANGELOG.md) for each release.

## Data folder during development

The backend uses the per-user data folder described in [advanced use](advanced.md#where-your-data-lives). A checkout with an existing `.local/config.json` keeps using `.local/`. To work with throwaway data, set `LANE_DATA_DIR`:

```bash
LANE_DATA_DIR=/tmp/lane-dev npm start
```

Never commit anything from a data folder, `transcripts/`, or real résumés and profiles. Test fixtures use synthetic applicants only.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request: install, type check, unit tests, both builds and packaging. The browser suite can be run by hand from the Actions tab (`workflow_dispatch`).
