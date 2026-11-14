# Running Application Lane on Windows

You can run Application Lane on Windows in two ways:

- **Natively** (simplest): Node and the backend run in Windows, in PowerShell.
- **In WSL** (Windows Subsystem for Linux): the backend runs in Linux, and the extension runs in your Windows Chrome or Edge. Pick this if you already work in WSL or use the Claude Code or Codex CLI there.

Either way, the extension runs in your normal Windows browser.

## 1. Install Node 22

Natively, in PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
node --version          # expect v22 or newer
```

Or download the Node 22 installer from [nodejs.org](https://nodejs.org/). Install Git too if you want to clone the repository (`winget install Git.Git`).

In WSL, install Node 22 inside Linux, for example with [nvm](https://github.com/nvm-sh/nvm): `nvm install 22`.

## 2. Get Application Lane and start the backend

From a clone:

```powershell
git clone https://github.com/Nikman800/application-lane.git application-lane
cd application-lane
npm ci
npm run build
npm start
```

From a release: unzip `application-lane-extension-<version>.zip` into a folder you will keep, then install and start the backend:

```powershell
npm i -g .\application-lane-backend-<version>.tgz
application-lane
```

The first start prints the address and a **6-digit pairing code**. Leave the window open while you apply.

In WSL, run the same commands in your Linux shell. Keep the clone in the Linux file system (for example `~/application-lane`), not under `/mnt/c`, so installs and builds stay fast.

## 3. Load the extension

1. Open `chrome://extensions` (or `edge://extensions` in Edge).
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select the `dist\extension` folder (or the folder you unzipped).

With the backend in WSL, the built extension is at `\\wsl$\<distro>\home\<you>\application-lane\dist\extension`; you can paste that path into the folder picker. Chrome 120 or newer is required.

Then open the Application Lane **Dashboard**, choose **Connect to Application Lane on this computer**, and type the pairing code.

## Where things are kept

- **Settings and profile** (the data folder): `%APPDATA%\Application Lane` natively; `~/.local/share/application-lane` inside WSL.
- **Drafted documents:** your Windows **Documents\Application Lane** folder, in both cases. On WSL the backend writes them to the Windows Documents folder so you can pick them in Chrome's file chooser.

Windows does not enforce the owner-only file permissions the backend sets on Linux and macOS, so `config.json` is readable by any program running as you. Treat it like a password file and do not share it.

## Firewall

No firewall rule is needed. The backend listens only on `127.0.0.1` (this computer), and the extension connects to it there. With WSL, Windows forwards `127.0.0.1` to WSL automatically. If you are asked to allow Node through the firewall, you can decline: nothing outside your computer needs to reach it.

## Optional: LaTeX résumé tailoring

To tailor your own LaTeX résumé, install Python 3 and a TeX distribution so `python` and `pdflatex` are on the PATH:

```powershell
winget install Python.Python.3.12
winget install MiKTeX.MiKTeX
pdflatex --version
```

**Settings → Drafting** shows whether they were found. See [LaTeX tailoring](advanced.md#latex-tailoring).

## Fonts

PDFs use Arial (`C:\Windows\Fonts\arial.ttf`) when available. Set `fontPath` in `config.json` to use another TTF font.

## Moving from another computer

Your profile does not travel with the code. On the old computer, open **Your profile** and choose **Export profile**; on Windows, choose **Import profile…** and confirm. The file holds your profile, saved answers and tailoring files, but no pairing token, API key or applications. Each computer pairs with its own code.

## Troubleshooting

- **The extension cannot connect with the backend in WSL.** Check that `curl http://127.0.0.1:4318` inside WSL gets a response (an error message about authentication is fine). If Windows cannot reach it, make sure WSL's localhost forwarding is on (the default; `localhostForwarding=true` in `%USERPROFILE%\.wslconfig`), then restart WSL with `wsl --shutdown`.
- See the [README's troubleshooting section](../README.md#troubleshooting) for pairing and port problems.
