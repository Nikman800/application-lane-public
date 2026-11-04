# Running Application Lane on macOS

## 1. Install Node 22

Use either:

- the macOS installer for Node 22 from [nodejs.org](https://nodejs.org/), or
- [Homebrew](https://brew.sh/): `brew install node@22`, then follow Homebrew's note about adding it to your PATH.

Check with `node --version` (expect v22). If you use nvm, `nvm install 22` works too.

## 2. Get Application Lane and start the backend

From a clone, in Terminal:

```bash
git clone https://github.com/Nikman800/application-lane-public.git application-lane
cd application-lane
npm ci
npm run build
npm start
```

From a release: unzip `application-lane-extension-<version>.zip` into a folder you will keep (not Downloads, if you tidy it), then:

```bash
npm i -g ./application-lane-backend-<version>.tgz
application-lane
```

The first start prints the address and a **6-digit pairing code**. Leave the Terminal window open while you apply.

## 3. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Choose **Load unpacked** and select `dist/extension` (or the folder you unzipped). In the file picker, press **⌘⇧G** to type a path, or **⌘⇧.** to show hidden folders.
4. Pin Application Lane from the puzzle-piece menu if you like.

Open the Application Lane **Dashboard**, choose **Connect to Application Lane on this computer**, and type the pairing code. Edge, Brave and other Chromium browsers work the same way (version 120 or newer).

## Where things are kept

- **Settings and profile:** `~/Library/Application Support/Application Lane` (the Library folder is hidden in Finder; use **Go → Go to Folder…** and paste the path).
- **Drafted documents:** `~/Documents/Application Lane`, one folder per job.

To delete everything, stop the backend and remove both folders, then remove the extension in `chrome://extensions`.

## Drafting with Claude Code or Codex

If you use the Claude Code CLI or the Codex CLI, install it and sign in once in Terminal (`claude` or `codex`). The backend runs the CLI from your PATH; **Settings → Drafting** shows whether it was found.

If you installed the CLI with a tool that changes your PATH only in interactive shells (Homebrew in a non-default location, nvm, or a version manager), the backend might not find it. Either start the backend from the same Terminal where `claude --version` works, or give the CLI's full path on the Drafting page (find it with `which claude` or `which codex`).

## Optional: LaTeX résumé tailoring

Install Python 3 and a TeX distribution such as [MacTeX](https://www.tug.org/mactex/) (or BasicTeX: `brew install --cask basictex`) so `python3` and `pdflatex` are on your PATH. **Settings → Drafting** shows whether they were found. See [LaTeX tailoring](advanced.md#latex-tailoring).

## Fonts

PDFs use Arial from the system fonts when available. Set `fontPath` in `config.json` to use another TTF font.

## Troubleshooting

See the [README's troubleshooting section](../README.md#troubleshooting). On macOS, find a program using the port with `lsof -i :4318`.
