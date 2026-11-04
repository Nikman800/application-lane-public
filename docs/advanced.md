# Advanced use

This page covers details most people never need: where data lives, the configuration file, LaTeX tailoring, how filling and drafting behave in edge cases, and issue reports. For the basics, start with the [README](../README.md).

## Where your data lives

The backend keeps everything in one **data folder**:

| System | Default data folder |
| --- | --- |
| Linux | `$XDG_DATA_HOME/application-lane`, or `~/.local/share/application-lane` |
| macOS | `~/Library/Application Support/Application Lane` |
| Windows | `%APPDATA%\Application Lane` |

Two exceptions:

- If the folder you start the backend from (or the checkout itself) already has a `.local/` folder containing `config.json`, from an older installation, that `.local/` folder keeps being used.
- `LANE_DATA_DIR=/some/folder` overrides both.

Inside the data folder:

| Path | What it holds |
| --- | --- |
| `config.json` | Settings, the pairing token and any API key. Owner-only permissions (on Linux and macOS; Windows does not honour these modes, so treat it as a secret). |
| `state.json` | Your profile, saved answers and drafting history |
| `artifacts/` | Drafted documents the extension previews and attaches |
| `issues/` | Issue reports you chose to save, and any network capture saved with them |
| `recordings/` | Page-activity recordings you chose to save |
| `search/` | Find jobs settings and a short-lived cache of public job lists |
| `tailoring/` | Your LaTeX tailoring folder, if you use one (see below) |
| `transcripts/` | Your transcript, for forms that ask for one (the newest PDF or DOCX is uploaded) |

Drafted documents are also written as files you can upload by hand, one folder per job, under `~/Documents/Application Lane` (on WSL, your Windows Documents folder). Marking an application submitted moves its folder under `Sent`. **Copy … path** on the side panel and in **Documents** copies a file's location for a site's file chooser; **Open folder** shows it.

Local files are not encrypted at rest. The extension's own state (tracked applications, edit locks, document metadata, settings, theme, the pairing token) is in the browser's `chrome.storage.local`.

**Delete local application data** (Dashboard → Settings → Your data) removes the saved profile, tracker, generated documents and issue reports. It leaves the configuration, the pairing, the files under `~/Documents/Application Lane`, and values already entered on employer pages. To remove everything, also stop the backend, delete the data folder and the documents folder, and remove the extension from `chrome://extensions`.

## Configuration file reference

`config.json` is created on first start. Most settings can be changed in **Dashboard → Settings**; edit the file only for what the page does not offer, while the backend is stopped.

| Key | Meaning |
| --- | --- |
| `token` | The 64-hex pairing token. Treat it as a secret. |
| `extensionId` | The extension this backend is paired with. Remove it (backend stopped) to pair a different extension, or use `npm start -- --pair`. |
| `draftProviders` | Ordered list of drafting providers (see below). |
| `checkProviders` | Ordered list of providers that check drafted claims, skipping the one that wrote the draft. Empty: the Drafting order, then `verifyModel`. |
| `checking` | `"thorough"` (default: another model checks every claim, about half a minute more per application) or `"fast"` (no check). |
| `verifyModel` | The API endpoint model used for checking when no other checker is available. |
| `endpoint`, `model`, `apiKey` | The OpenAI-compatible API endpoint, model and key. `LANE_API_KEY` is read by `npm run setup`. HTTPS is required for remote endpoints; plain HTTP is allowed for loopback. |
| `generationConcurrency` | AI requests at once, 1–4 (default 2). |
| `postingLookup` | `true` (default): read the full posting from the job board's public endpoint so drafts are tailored from it rather than from the form page. |
| `documentsDir` | Where drafted documents are written as files. Default `~/Documents/Application Lane`. |
| `transcriptsDir` | Where your transcript is kept. Default `<data folder>/transcripts`. |
| `tailorDir` | Your LaTeX tailoring folder, if it is not `<data folder>/tailoring`. The older `jobApplierDir` is still read. |
| `resumeLatexDir` | Older, simpler LaTeX mode: compile the best-fitting `.tex` variant unchanged. Replaced by `tailorDir`. |
| `fontPath` | A TTF font for PDF output, for scripts the default font lacks. DejaVu Sans (Linux) or Arial (macOS, Windows) is used when found; otherwise Helvetica, with unsupported characters reported. |
| `provider`, `cliModel`, `cliEffort`, `codexFallback`, `codexFallbackModel` | Legacy single-provider settings, still read when `draftProviders` is empty. |

Use absolute paths for folders. (A relative `tailorDir` or `resumeLatexDir` is resolved against the Application Lane installation folder, which suits a source checkout with your résumé beside it, such as `"../my-resume"`.)

### Drafting providers in detail

Each `draftProviders` entry has a stable `id` (lowercase letters, digits and dashes), `provider` (`"claude-cli"`, `"codex-cli"` or `"http"`), `model`, and optionally `name`, `effort` (`minimal` … `xhigh`), `timeoutMs` (1000–180000), `command` (full path to the CLI) and `home` (a separate authentication home). A Codex model of `"default"` uses whatever model the Codex CLI is configured with. This policy drafts with Codex first, falls back to Claude, and keeps an API endpoint last:

```json
"draftProviders": [
  { "id": "codex", "name": "Codex", "provider": "codex-cli", "model": "default", "effort": "low", "timeoutMs": 45000 },
  { "id": "claude", "name": "Claude Sonnet", "provider": "claude-cli", "model": "sonnet", "timeoutMs": 55000 },
  { "id": "local-endpoint", "name": "Local model", "provider": "http", "model": "your-model-name", "timeoutMs": 30000 }
]
```

To use two logins of the same CLI, give each entry its own `home`, so switching your interactive account does not switch the backend. `LANE_CLAUDE_BIN` and `LANE_CODEX_BIN` name the CLI executables when they are not on the PATH.

Calls are sequential and stop at the first valid response. Usage limits, expired sign-ins, unavailable models, timeouts, HTTP failures and invalid responses move on to the next entry and produce one readable notice. Each CLI call is a locked-down single turn with no tools, settings, hooks, MCP servers, project files or web search, run from an empty temporary folder. Cancelling stops the chain. Provider logs record only names, timings, status and recovery categories, never prompts, responses or credentials.

If every provider fails, a local keyword-ranked draft is prepared instead (written questions are left unanswered), with a warning on the application.

## Résumés and cover letters

The model selects and orders your confirmed facts for each job and writes the cover letter from the facts it cites. Résumé bullets and narrative answers keep your original confirmed wording. The letter's greeting and closing are always the extension's own. Every employer, product, technology, number and date in a written letter is checked against your confirmed facts and the posting; anything else is named in a review warning on the application and in the **Documents** preview, before the letter is attached.

Without LaTeX, the résumé PDF uses the built-in single-column layout, and the DOCX is always generated, for forms that accept nothing else.

### LaTeX tailoring

If you keep your résumé in LaTeX, the tailoring engine in `tailor/` can angle your own `.tex` sources at each job. It needs Python 3 and `pdflatex` on the PATH; **Settings → Drafting** shows whether they were found.

Give it a tailoring folder:

- `resumes/*.tex`: every file is a variant
- `profile.md` and `preferences.md`: what answers are written from
- `references/common-questions.md` and `references/anti-fabrication.md`: your own guidance for answers (defaults ship with the backend)
- optionally `cover-letter-example.md`: a letter you like; drafts follow its tone and structure, never its content

Put it at `<data folder>/tailoring` and it is found without any setting, or copy an existing set in with:

```bash
npm run tailoring:import -- <folder>
```

Set `tailorDir` only to keep it somewhere else.

For each application the drafting model writes a tailoring brief: pick the résumé variant, rewrite the Summary line, reorder skills and sections, and drop at most one entry that is not a current role. The engine applies it to your unedited sources. It skips anything the source does not contain, keeps the original summary when the new one has fewer specifics or names something the résumé does not, and refuses a build that runs to two pages. A posting under 40 words gets the stock résumé. The cover letter is typeset under the résumé's own letterhead: it is planned first (the posting's two or three main requirements, each matched to the fact that answers it), two drafts are written, and the one with the fewest unsupported claims goes out. **Documents** shows the summary, what was reordered or dropped, and requirements the résumé has no evidence for. Any failure falls back to the stock résumé, or the built-in layout, with a warning.

## Saved answers and written questions

Answer a custom question yourself, then choose **Save answers I entered**: Application Lane lists the answers you typed or picked that your profile cannot already give, and the ones you keep fill the same question on future applications. Nothing is saved without your confirmation.

Written questions can be drafted on their own: open **Application questions** on a tracked application and choose **Draft this question** or **Draft all written responses**. Review and edit each draft, check its length and sources, then choose **Fill this answer** or **Fill selected answers**. Questions that already have answers, history rows, identity fields and sensitive declarations are left out. A changed profile, page or field prevents a stale draft from filling.

Answers are written from your profile, `profile.md` and `preferences.md` (when you tailor with LaTeX), following the question guide and anti-fabrication rules in `references/`. Default guidance ships with the backend.

After **Fill this step**, **Unfilled structured fields** lists empty fields your profile could not resolve. **Ask AI for suggestions** proposes values from your saved details, each with its source, for you to accept before **Fill selected suggestions**. Passwords, financial identifiers, legal attestations, files and written questions are excluded.

## AI filling settings

**Settings → AI filling** decides what **Fill this step** lets the model do:

- *Fill automatically* (default): writes long answers and, for fields the rules did not recognise, values mapped from your saved details; the card lists them under "Filled by AI: check these".
- *Review first*: fills only what the rules match and leaves drafts in the panel for approval.
- *Profile only*: never calls the model during a fill.

**Legal and eligibility questions** (a conviction, a clearance, a relative at the company) are left for you unless **Your profile → Legal and eligibility details** answers them. Signatures, initials, consent boxes and the final Submit are always yours.

## What happens when you edit

You can scroll and read the page while it fills. Typing, clicking or tapping a form control pauses that application's current fill; scrolling and clicks on empty space do not. Other applications keep filling. Choose **Fill this step** again when ready. Existing values and fields you edited, including fields you cleared, are protected. Fields whose identity becomes uncertain after the page re-renders are left for you.

After navigation to another URL or an extension restart, in-flight applications pause and wait for **Fill this step**. There is no blind replay of field writes, clicks or uploads. The extension never brings a background tab to the front; **Open** is the explicit exception.

Login and emailed-link tabs can be attached to the same application. Application Lane suggests likely matches but never attaches a tab without confirmation.

Default limits are four active fill requests and two AI requests at once (Settings → Processing), and two lanes per site.

## Issue reports and recordings

**Report issue** saves a local snapshot of the application state, field observations and the form markup, after you confirm. Passwords, tokens, one-time codes and file contents are redacted; ordinary entered values are included so the problem can be reproduced. Reports stay under **Issues** until you export or delete them.

**Network capture for reports** (Settings → Processing, off by default) records the tracked application tab's network requests in memory, without cookie and authorization headers, so a saved report can be replayed. It uses Chrome's `debugger` permission, so Chrome shows its "started debugging this browser" bar while it is on. It is saved only with a report you choose to save.

The `debugger` permission is also used to type real keystrokes into date fields that ignore ordinary input (Workday's month/year sections): only in a tab you are not looking at, only the characters of the value plus as many Backspaces as the field holds, with no mouse events, Enter or clicks. The Chrome Web Store build leaves out this permission, so you type those dates yourself and network capture is unavailable.

**Record page activity** captures what happens while you, or another autofill tool, fill a form (clicks, keys, inputs, dropdowns, network requests, field values before and after) and saves it under **Issues**. Password values and token-like URL parameters are redacted.

## Pairing details

The unpacked build carries a manifest `key`, so its extension ID stays the same across browser profiles and folders, and one pairing covers them all. To pair a different browser or extension, run `npm start -- --pair` (or `lane pair`) and type the new code within 10 minutes. The fallback is to paste the 64-hex `token` from `config.json` under **Settings → Backend connection**.

## Running the backend

`npm start` runs the backend without watching files, so code edits never interrupt an application being drafted. `npm run dev` restarts the backend whenever a file under `src` changes; a restart cancels drafting in flight, and the extension starts that application's documents again on its own.
