# Changelog

All notable changes to Application Lane are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

## 0.1.0 — initial public release

### Filling applications

- Parallel application lanes: track many applications and fill several at once, with limits per site and on active fills (adjustable in Settings).
- Side panel listing every tracked application with its stage, related tabs, current fill target, fill history and saved issues; login and emailed-link tabs can be grouped with an application after you confirm.
- **Fill this step** fills the current step only. The extension never clicks Next, Continue or Submit, never signs or ticks consent boxes, and never submits.
- Edit locks: typing, clicking or picking in a form pauses that application's fill, and fields you edited or cleared are never overwritten. Every write is checked against the field's revision and expected value just before it happens.
- Site rules for Workday, Greenhouse, Lever, Ashby, iCIMS, SmartRecruiters, Workable, Oracle, Paylocity, JazzHR and Rippling (plus a few employer-specific sites), and general form matching for everything else.
- Queue links in bulk with **Track application links** or the command line.
- **Save answers I entered** keeps answers you gave by hand for the same question on future applications.
- Unfilled structured fields listed after each fill, with optional AI suggestions you approve first.
- AI filling modes: fill automatically, review first, or profile only. Legal and eligibility questions are answered only from details you wrote yourself.

### Profile

- Import résumés from PDF and DOCX, processed on your computer; facts are merged into a cumulative list and confirmed by you before use.
- Confirmed profile with contact details, work and education history, legal and eligibility details, and saved answers.
- Export and import a profile to move it to another computer (without tokens, keys or applications).

### Drafting

- Drafting providers: Claude Code CLI, Codex CLI, or any OpenAI-compatible API, in an ordered fallback list set in **Settings → Drafting**. With no provider, filling still works and drafting points you to Settings.
- Tailored résumé and cover letter as PDF and DOCX, plus drafted answers to written questions, all shown for review. Résumé bullets keep your confirmed wording; claims in drafted text that your profile does not support are flagged, and an optional second model checks them.
- Built-in ATS-friendly single-column résumé layout, with optional LaTeX tailoring of your own résumé sources (Python 3 and `pdflatex`).
- Full postings read from job boards' public endpoints (Greenhouse, Lever, Ashby, Workday, Oracle, Workable, SmartRecruiters) so drafts are tailored to the real posting.
- Documents also saved as files under `Documents/Application Lane`, one folder per job, with copy-path buttons for manual uploads.
- **Check fit** compares a posting with your background, requirement by requirement.

### Finding jobs and progress

- **Find jobs** searches SimplifyJobs' new-grad and internship lists and the Greenhouse, Lever and Ashby boards of companies you name, filtered by role, place, country, recency and seniority.
- Momentum card in the side panel and a progress board on the dashboard: daily streak, daily goal, levels, a 12-week heatmap and badges.
- Themes: System, Sage, Midnight, Ember, Aurora, Velocity and High contrast.

### Command line

- `lane add`, `status`, `failures`, `watch`, `fill`, `switch`, `search` and a full-screen `ui`, sharing the extension's themes (`--theme`, `LANE_THEME`, `NO_COLOR`).

### Setup and security

- Zero-config start: the first `npm start` (or `application-lane`) creates settings and prints a pairing code.
- One-click pairing from the dashboard with a 6-digit code, limited to extension origins, the unpaired state or a 10-minute window, and locked after five wrong codes.
- Dashboard onboarding checklist.
- Data kept in the per-user app-data folder; `LANE_DATA_DIR` overrides it.
- Backend bound to `127.0.0.1` with Host and Origin checks, a constant-time token check, and owner-only config permissions.
- Local issue reports and page-activity recordings for debugging; network capture is opt-in.
- Packaging: `npm run package` builds a release zip of the extension and an npm package of the backend (`application-lane` and `lane` commands); `npm run build -- --store` builds a Chrome Web Store variant without the `debugger` permission.
