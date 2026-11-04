# Running Application Lane on Linux

## 1. Install Node 22

Use your distribution's Node 22 package if it has one, the installers at [nodejs.org](https://nodejs.org/), or [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install 22
node --version     # expect v22
```

## 2. Get Application Lane and start the backend

```bash
git clone https://github.com/Nikman800/application-lane-public.git application-lane
cd application-lane
npm ci
npm run build
npm start
```

From a release instead: unzip `application-lane-extension-<version>.zip` into a folder you will keep, then `npm i -g ./application-lane-backend-<version>.tgz` and run `application-lane`.

The first start prints the address and a **6-digit pairing code**. Leave the terminal open while you apply.

## 3. Load the extension

Open `chrome://extensions` in Chrome or Chromium (120 or newer), turn on **Developer mode**, choose **Load unpacked**, and select `dist/extension` (or the unzipped folder). Then open the **Dashboard**, choose **Connect to Application Lane on this computer**, and type the code.

Snap and Flatpak browsers may not be able to open folders outside your home directory; keep the extension folder under your home.

## Where things are kept

- **Settings and profile:** `$XDG_DATA_HOME/application-lane`, usually `~/.local/share/application-lane`.
- **Drafted documents:** `~/Documents/Application Lane`.

## Optional extras

- **Claude Code or Codex CLI:** install and sign in once; the backend runs it from your PATH, or from the full path you give in **Settings → Drafting**.
- **LaTeX tailoring:** install `python3` and `pdflatex` (for example `texlive-latex-extra` on Debian/Ubuntu). See [LaTeX tailoring](advanced.md#latex-tailoring).
- **Fonts:** PDFs use DejaVu Sans when installed (`fonts-dejavu-core`). Set `fontPath` in `config.json` for another TTF.
