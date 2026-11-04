"""The lane backend's way into the résumé and cover-letter builders in tailor/engine.

The engine tailors a résumé by reordering the applicant's own LaTeX and rewriting one summary
line, and checks every name a brief uses against the source. It was taken from job-applier's
`/job-apply` skill (commit 4487372) so the lane needs no second checkout; resume_tailor.py is
that file unchanged, so the two can be compared when either moves. This script speaks JSON
over stdin/stdout.

    python bridge.py <folder of the applicant's .tex résumés>   (request JSON on stdin)

Every `.tex` file in the folder is a variant, named by its file name without the extension.

Requests:
    {"command": "inspect"}
        -> every variant's summary, sections, entries and skills lines, and its visible prose
    {"command": "resume", "variant": "<stem>", "brief": {...}, "out": "/dir", "stem": "...",
     "graduation": "2027-05"}
        -> {"path", "summary", "changes", "rejected", "notes"}; a brief naming something the
           source does not contain is salvaged (that part dropped). "graduation" (optional,
           YYYY-MM) is the date this application states for the degree still in progress
           (preferences.md, graduation by role); only that date changes
    {"command": "cover", "variant": "<stem>", "body": "...", "date": "...", "out": "/dir",
     "stem": "..."}
        -> {"path"}

Failures print {"error": "..."} and exit 1.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date
from pathlib import Path


def _load():
    sys.path.insert(0, str(Path(__file__).resolve().parent / "engine"))
    import cover_letter  # noqa: PLC0415
    import resume_tailor  # noqa: PLC0415

    return resume_tailor, cover_letter


def _stems(source_dir: Path) -> dict:
    """Variant name -> file stem: every .tex résumé in the folder, by its own name."""
    return {path.stem: path.stem for path in sorted(source_dir.glob("*.tex"))}


def _prose(tex: str) -> str:
    """What a reader sees, for checking that a summary names only things the résumé names."""
    body = tex.split("\\begin{document}", 1)[-1]
    body = re.sub(r"%.*$", " ", body, flags=re.M)
    body = re.sub(r"\\[a-zA-Z@]+\*?(\[[^\]]*\])?", " ", body)
    return re.sub(r"\s+", " ", re.sub(r"[{}$~^\\]", " ", body)).strip()


def inspect(engine, stems, source_dir: Path) -> dict:
    variants = {}
    for variant, stem in stems.items():
        source = source_dir / f"{stem}.tex"
        if not source.exists():
            continue
        tex = source.read_text(encoding="utf-8")
        current = engine.current_entries(tex)
        variants[variant] = {
            "file": source.name,
            "summary": engine.summary_line(tex),
            "sections": engine.source_sections(tex),
            "entries": [
                {
                    "title": title,
                    "current": engine.normalize_latex(title).casefold() in current,
                }
                for title in engine.source_entries(tex)
            ],
            "skills": engine.source_skills(tex),
            "prose": _prose(tex),
        }
    return {"variants": variants}


def _salvage(engine, tex: str, brief: dict) -> dict:
    """Keep what the source supports and drop the rest, as the job-applier queue does.

    Unattended, a partial tailoring beats none. Matched through `normalize_latex` so a title
    written as a person writes it (`Fan-Out & Hotspot`) is kept, the way `findings` accepts it,
    and a current role is taken out of `drop_entries` rather than refusing the brief.
    """

    def key(value: str) -> str:
        return engine.normalize_latex(str(value)).casefold()

    sections = {key(item) for item in engine.source_sections(tex)}
    entries = {key(item) for item in engine.source_entries(tex)}
    current = engine.current_entries(tex)
    skills = {
        key(category): {key(item) for item in items}
        for category, items in engine.source_skills(tex).items()
    }
    cleaned = dict(brief)
    cleaned["lead_sections"] = [
        item for item in brief.get("lead_sections") or [] if key(item) in sections
    ]
    cleaned["drop_entries"] = [
        item
        for item in brief.get("drop_entries") or []
        if key(item) in entries and key(item) not in current
    ]
    cleaned["promote_entries"] = []
    cleaned["skills_order"] = [
        group
        for group in brief.get("skills_order") or []
        if key(group.get("category", "")) in skills
        and {key(item) for item in group.get("items") or []}
        == skills[key(group.get("category", ""))]
    ]
    return cleaned


MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
_RANGE_END = re.compile(
    r"(?:--+|–|—)\s*((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?)\s+(\d{4})"
)


def set_graduation(tex: str, month: str) -> tuple[str, str | None]:
    """Show `month` (YYYY-MM) as the end of the degree still in progress.

    Some applicants state a different graduation date by role (a later one for internships, so a
    term remains after a summer program). Only the Education section's latest date-range end, and
    only one not yet past, is rewritten, in the source's own "Mon YYYY" style; completed degrees
    and every other line stay as the source has them. Returns the text and a change note, or the
    text unchanged and None.
    """
    start = re.search(r"\\section\*?\{Education\}", tex)
    if not start:
        return tex, None
    following = re.search(r"\\section\*?\{", tex[start.end():])
    stop = start.end() + following.start() if following else len(tex)
    section = tex[start.end():stop]
    ends = list(_RANGE_END.finditer(section))
    if not ends:
        return tex, None
    key = lambda m: (int(m.group(3)), MONTHS.index(m.group(2)))  # noqa: E731
    latest = max(ends, key=key)
    today = date.today()
    if key(latest) < (today.year, today.month - 1):
        return tex, None
    year, number = month.split("-")
    shown = f"{MONTHS[int(number) - 1]} {year}"
    if f"{latest.group(2)} {latest.group(3)}" == shown:
        return tex, None
    section = section[: latest.start(1)] + shown + section[latest.end(3):]
    return tex[: start.end()] + section + tex[stop:], f"graduation shown as {shown} for this role"


_SPECIAL = re.compile(r"(?<!\\)([#$%&_])")


def _latex_safe(brief: dict) -> dict:
    """The brief's text as LaTeX: a model writes "C#" where the source has "C\\#".

    Escaped only after the engine's checks, which compare names the way the
    source spells them, so those checks are unchanged. Already-escaped
    characters are left alone.
    """
    escape = lambda text: _SPECIAL.sub(r"\\\1", text) if isinstance(text, str) else text  # noqa: E731
    safe = dict(brief)
    if "summary_line" in safe:
        safe["summary_line"] = escape(safe["summary_line"])
    if isinstance(safe.get("skills_order"), list):
        safe["skills_order"] = [
            {**group, "items": [escape(item) for item in group.get("items") or []]}
            if isinstance(group, dict)
            else group
            for group in safe["skills_order"]
        ]
    return safe


def resume(engine, stems, source_dir: Path, request: dict) -> dict:
    variant = request["variant"]
    tex = (source_dir / f"{stems[variant]}.tex").read_text(encoding="utf-8")
    brief = dict(request.get("brief") or {})
    problems = engine.findings(tex, brief)
    rejected = [item.message for item in problems if item.blocking]
    if rejected:
        brief = _salvage(engine, tex, brief)
        problems = engine.findings(tex, brief)
    patched = engine.apply_brief(tex, _latex_safe(brief))
    graduation_note = None
    if request.get("graduation"):
        patched, graduation_note = set_graduation(patched, str(request["graduation"]))
    built = engine.compile_pdf(patched, Path(request["out"]), request["stem"])

    changes = [graduation_note] if graduation_note else []
    for group in brief.get("skills_order") or []:
        category = str(group.get("category", ""))
        pattern = re.compile(rf"^\\textbf\{{{re.escape(category)}:\}}.*$", re.MULTILINE)
        was, now = pattern.search(tex), pattern.search(patched)
        if was and now and was.group(0) != now.group(0):
            changes.append(f"reordered {category} skills")
    if brief.get("lead_sections") and engine.source_sections(
        patched
    ) != engine.source_sections(tex):
        changes.append("sections: " + ", ".join(engine.source_sections(patched)))
    for title in brief.get("drop_entries") or []:
        changes.append(f"dropped {engine.normalize_latex(title)}")
    return {
        "path": str(built),
        "summary": engine.summary_line(patched),
        "summaryReplaced": engine.summary_line(patched) != engine.summary_line(tex),
        "changes": changes,
        "rejected": rejected,
        "notes": [item.message for item in problems if not item.blocking],
    }


def cover(engine, letters, stems, source_dir: Path, request: dict) -> dict:
    built = engine.compile_pdf(
        letters.render(
            request["body"], source_dir / f"{stems[request['variant']]}.tex", request["date"]
        ),
        Path(request["out"]),
        request["stem"],
    )
    return {"path": str(built)}


def main() -> int:
    try:
        source_dir = Path(sys.argv[1])
        request = json.loads(sys.stdin.read())
        engine, letters = _load()
        stems = _stems(source_dir)
        command = request.get("command")
        if command == "inspect":
            result = inspect(engine, stems, source_dir)
        elif command == "resume":
            result = resume(engine, stems, source_dir, request)
        elif command == "cover":
            result = cover(engine, letters, stems, source_dir, request)
        else:
            raise ValueError(f"unknown command {command!r}")
    except Exception as exc:  # noqa: BLE001 -- every failure is reported to the lane as JSON
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"[:600]}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
