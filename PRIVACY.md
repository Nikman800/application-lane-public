# Privacy policy

_Last updated: 2026-11-03_

Application Lane is a browser extension plus a backend program that runs on your own computer. It is open source and has no server, no account and no company collecting your data. This policy explains what data it handles, where that data goes, and how to delete it.

## Summary

- Your data is stored **only on your computer**.
- There is **no telemetry, analytics, advertising or tracking**.
- Your profile and job text are sent **only to the drafting provider you choose**, and only when it drafts something for you.
- The extension reads and fills **job application pages you open**.
- Nothing is sold or shared with anyone else.

## What data is handled

To fill applications and draft documents, Application Lane works with:

- **Your profile:** contact details, work and education history, skills, résumé facts you confirm, saved answers, legal and eligibility details you choose to enter, and preferences.
- **Résumé files** you import (PDF or DOCX). Text is extracted on your computer.
- **Application data:** the job postings and application pages you track, the form fields on them, what was filled, and the documents drafted for each job.
- **Settings:** your drafting provider choice, pairing token, and any API key you enter.
- **Issue reports and recordings,** only when you choose to save one. These include the page's form markup and the values entered (passwords, tokens, one-time codes and file contents are removed).

Application Lane does not collect your browsing history, passwords or payment details.

## Where it is stored

- **In your browser:** the extension keeps tracked applications, settings, theme and the pairing token in the browser's local extension storage (`chrome.storage.local`). This is not synced to your Google account.
- **On your computer:** the backend keeps your profile, documents, saved reports and settings in a local data folder (`~/.local/share/application-lane` on Linux, `~/Library/Application Support/Application Lane` on macOS, `%APPDATA%\Application Lane` on Windows, or the folder you chose). Drafted documents are also saved as files under `Documents/Application Lane`.
- The backend accepts connections only from your own computer and only from the paired extension. See [SECURITY.md](SECURITY.md).

Local files are not encrypted by Application Lane; they are protected by your computer's account and file permissions.

## What leaves your computer, and when

**Your drafting provider.** When Application Lane drafts a résumé, cover letter, answer, fit check or field suggestion, it sends the relevant profile facts and job text to the provider you chose in **Settings → Drafting**:

- Claude Code CLI (Anthropic), or
- Codex CLI (OpenAI), or
- an OpenAI-compatible API endpoint you configure (which may be a model running on your own computer).

That provider's own privacy policy and terms apply to what it receives. If you choose no provider, nothing is sent for drafting; filling from your profile still works.

**Job sites you open.** The extension reads and fills the application pages you track, in your browser, the same as if you typed into them. Values it fills become part of the application you submit to that employer. It asks for access to a site only when you grant it.

**Public job-board endpoints.** To tailor documents to the actual posting, the backend reads the posting from the job board's public, login-free endpoint (Greenhouse, Lever, Ashby, Workday, Oracle, Workable or SmartRecruiters), or from a posting link you provide. Only the posting's address is sent. You can turn this off with `postingLookup: false` in the configuration.

**Find jobs.** When you search on the **Find jobs** page, the backend downloads public job lists: SimplifyJobs' new-grad and internship lists from GitHub (`raw.githubusercontent.com`), and the public Greenhouse, Lever and Ashby job boards of companies you name. It sends only what is needed to fetch those lists, never your profile.

Nothing else is sent anywhere. There is no update check, crash reporting or usage tracking.

## Network capture for issue reports

**Network capture for reports** is off by default. If you turn it on in Settings, the extension records the network requests of tracked application tabs in memory (cookie and authorization headers are dropped) so a report you save can be replayed for debugging. It stays on your computer and is saved only with a report you choose to save. Issue reports are never uploaded automatically; if you share one (for example on GitHub), check it first, since it contains the values you entered.

## Permissions the extension uses

- **storage:** to keep your applications and settings in the browser.
- **tabs, webNavigation, scripting:** to find and fill forms in the tabs you track, and to follow multi-step applications.
- **sidePanel:** to show the side panel.
- **alarms:** to resume queued work reliably.
- **Access to `127.0.0.1`:** to talk to the backend on your computer.
- **Optional site access:** requested per site, only when you track an application there.
- **debugger** (not in the Chrome Web Store build): to type real keystrokes into certain date fields, and for opt-in network capture. Chrome shows a notice while it is in use.

## Deleting your data

- **From the dashboard:** **Settings → Your data → Delete local application data** deletes your saved profile, application tracker, generated documents and issue reports.
- **Everything:** stop the backend, delete the data folder listed above and the `Documents/Application Lane` folder, and remove the extension in `chrome://extensions` (which clears its browser storage).

Data already sent to an employer's site or to your drafting provider cannot be recalled by Application Lane; contact them directly.

## Children

Application Lane is not directed at children under 13.

## Changes

Changes to this policy are recorded in this file's history in the project repository.

## Contact

Questions about privacy: open an issue in the project's GitHub repository (without personal data). For security issues, see [SECURITY.md](SECURITY.md).
