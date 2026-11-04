# Third-party notices

Application Lane is MIT-licensed (see `LICENSE`). It includes or depends on the following third-party material, each under its own license.

## Bundled in this repository

### SCOWL word list — `src/server/words/american-english`

The English word list used to check cover letters for misspellings comes from SCOWL (Spell Checker Oriented Word Lists) by Kevin Atkinson and contributors, as packaged by Debian (`wamerican`). Its copyright and permission notice is kept beside it in `src/server/words/COPYRIGHT` and must stay with the file. In short: permission to use, copy, modify, distribute and sell the lists is granted without fee, provided the copyright and permission notices are retained; the lists are provided "as is".

### Tailoring engine — `tailor/`

The Python résumé and cover-letter tailoring engine was adapted from the project owner's own earlier job-apply tooling. It is the owner's own work and is covered by this repository's MIT license.

## Runtime npm dependencies

Installed by `npm ci`, not copied into this repository. Versions are those in `package-lock.json` at the time of writing.

| Package | Version | License |
| --- | --- | --- |
| `@pdf-lib/fontkit` | 1.1.1 | MIT |
| `docx` | 9.7.1 | MIT |
| `mammoth` | 1.12.3 | BSD-2-Clause |
| `pdf-lib` | 1.17.1 | MIT |
| `pdfjs-dist` | 5.7.284 | Apache-2.0 |
| `react` | 19.2.8 | MIT |
| `react-dom` | 19.2.8 | MIT |
| `ws` | 8.22.0 | MIT |
| `zod` | 3.25.76 | MIT |

`react` and `react-dom` (with `scheduler`, MIT) are bundled into the built extension in `dist/`; a distributed build therefore carries their MIT notices.

### Transitive dependencies

Pulled in by the packages above. All are permissive:

- `jszip` 3.10.2 (via `docx` and `mammoth`) is dual-licensed "MIT OR GPL-3.0-or-later"; Application Lane uses it under the **MIT** license.
- `pako` 1.0.11 (via `jszip`): MIT AND Zlib.
- `sax` 1.6.1 (via `xml-js`): BlueOak-1.0.0.
- `tslib` 1.14.1: 0BSD.
- `inherits`, `minimalistic-assert`: ISC.
- `dingbat-to-unicode`, `lop`, `option` (via `mammoth`): BSD-2-Clause. `duck`: BSD. `sprintf-js`: BSD-3-Clause.
- `@napi-rs/canvas` (optional, via `pdfjs-dist`), `@pdf-lib/standard-fonts`, `@pdf-lib/upng`, `@xmldom/xmldom`, `argparse`, `base64-js`, `bluebird`, `core-util-is`, `hash.js`, `immediate`, `isarray`, `lie`, `nanoid`, `path-is-absolute`, `process-nextick-args`, `readable-stream`, `safe-buffer`, `setimmediate`, `string_decoder`, `underscore`, `util-deprecate`, `xml`, `xml-js`, `xmlbuilder`: MIT.

Run `npm ls --omit=dev --all` for the exact tree of an installation.
