# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. This creates a private advisory that only the maintainers can see.

Please do not open a public issue for a vulnerability, and do not include real personal data (résumés, profiles, tokens, API keys) in your report; synthetic data is enough to show the problem.

Include what you can of: the affected version or commit, your OS, browser and Node version, steps to reproduce, and the impact you expect. We aim to acknowledge reports within a week. This is a volunteer project, so there is no bug bounty.

## Supported versions

Security fixes go into the latest release and the `main` branch.

## Security model

Application Lane has two parts that hold sensitive data: the browser extension and a backend that runs on the user's own computer. There is no remote server.

### The local backend

- It listens on **`127.0.0.1:4318` only**, never on other network interfaces.
- The **Host header** must be `127.0.0.1:<port>`. Requests addressed to any other name are rejected, which defeats DNS-rebinding attacks from web pages.
- Only **`chrome-extension://` origins** are accepted, and once paired, only the **paired extension's ID**. Ordinary web pages can never call the backend. Requests with no Origin header (the local `lane` command line) must still carry the token.
- Every request needs a **bearer token** (64 hex characters), compared in constant time.
- The configuration file holding the token and any API key is written with **owner-only permissions** (mode `0600`; the data folder `0700`). Windows does not enforce these modes, so there the file is protected only by the user account.
- Provider API keys stay in the backend; they never reach page scripts or extension storage.
- Drafting CLIs (Claude Code, Codex) are run as single locked-down turns with no tools, hooks, MCP servers or web search, from an empty temporary folder.
- Logs record provider names, timings and status, never prompts, responses, profile data or credentials.

### Pairing

On first start the backend creates the token and prints a **6-digit pairing code**. The extension's dashboard exchanges that code for the token:

- The code is accepted **only from an extension origin**.
- It is accepted **only while the backend is unpaired**, or within **10 minutes** after `npm start -- --pair` / `lane pair` printed a new code (to move to another browser or extension).
- **Five wrong codes** rotate the code and lock pairing for one minute.
- Once paired, the backend records the extension ID and refuses other extensions.

The fallback is to paste the token from `config.json` into **Settings → Backend connection**, which requires access to the user's files.

### The extension

- Fills happen only after an explicit **Fill this step** (or the equivalent `lane fill`). The extension never submits forms, never clicks Next, and never sends Enter or keyboard submission events.
- Every field write is checked against the document, operation, field revision and expected value immediately before it happens; fields the user edited are protected.
- Site access is requested per site through optional host permissions.
- The `debugger` permission (absent from the Chrome Web Store build) is attached only to type into specific date fields in an unfocused tab, and for opt-in network capture of tracked tabs.

See [docs/architecture.md](docs/architecture.md) for details.

## Scope

In scope:

- The extension, the backend, the command line and the tailoring engine in this repository.
- Ways a web page, another extension, or another local user could read data from or send commands to the backend.
- Ways the extension could act on a page without the user's request (submitting, advancing a step, overwriting the user's edits).
- Leaks of profile data, tokens or API keys to logs, pages or third parties.

Out of scope:

- Malware or another program already running as the same user on the same computer (it can read the user's files anyway).
- The security of third-party drafting providers and job sites.
- Attacks that require the user to paste their token into an untrusted extension.
- Missing hardening without a practical exploit.
