"""Angle an existing résumé at one posting, without letting a model rewrite it.

The two sources in `resumes/resume-creator/` are hand-tuned LaTeX with no macros: every entry is
written out with raw primitives, escaping is dense (`\\&`, `C\\#`, `$\\sim$`, `\\,|\\,`), and the
one-page fit is held together by `\\linespread` and hand-placed `\\vspace`. There is no seam a
generated document could be assembled through, so nothing here generates one.

Instead the patcher performs four edits, each a whole-line or whole-block replacement anchored on
a string already present in the file:

1. replace the Summary paragraph
2. reorder items within a skills line, and reorder those lines
3. reorder the coursework list
4. reorder whole sections, and drop one complete entry

The summary is the only new prose, and it goes through the same verification and approval gate as
every other generated artifact. Everything else is a permutation of what the user already wrote,
which is checked mechanically rather than trusted: `findings()` rejects any skill or entry title
that does not appear verbatim in the source.
"""

import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path


class ResumeBuildError(RuntimeError):
    """The tailored résumé could not be produced, so the stock one stands."""


SECTION = re.compile(r"^\\section\*\{(?P<title>[^}]*)\}", re.MULTILINE)
SKILL_LINE = re.compile(r"^\\textbf\{(?P<category>[^}]+):\}(?P<items>.*?)(?P<tail>\\\\)?$", re.M)
COURSEWORK = re.compile(r"^(?P<head>.*\\textit\{Coursework:)(?P<items>[^}]*)(?P<tail>\}.*)$", re.M)
ENTRY_TITLE = re.compile(r"^\\textbf\{(?P<title>[^}]*?)\}\s*\\hfill", re.MULTILINE)


@dataclass(frozen=True)
class Finding:
    """Something the brief asked for that the source does not support.

    Blocking findings are matters of fact -- an invented skill, a dropped current role -- and
    refuse the whole brief. A non-blocking one is a judgement about quality: the part it names
    is dropped, the rest is applied, and the user is told. Refusing everything over a weaker
    summary would throw away sound reordering to avoid one paragraph.
    """

    check: str
    message: str
    blocking: bool = True


def source_sections(tex: str) -> list[str]:
    return [match.group("title").strip() for match in SECTION.finditer(tex)]


def source_entries(tex: str) -> list[str]:
    return [match.group("title").strip() for match in ENTRY_TITLE.finditer(tex)]


# Below this, a posting says what the role is called and nothing about what it wants. Tailoring
# against it cannot sharpen anything, and the model fills the gap with generalities -- which is
# how a concrete summary became "experience building Python systems".
MIN_POSTING_WORDS = 40


def posting_is_tailorable(description: str) -> bool:
    return len(re.findall(r"[A-Za-z][\w'-]*", description or "")) >= MIN_POSTING_WORDS


def normalize_latex(value: str) -> str:
    """Compare what the reader sees, not how LaTeX spells it.

    The source writes `C\\#`, `Fan-Out \\& Hotspot`, `EEE598\\_final`. A model naming those
    entries writes them as a person would -- `C#`, `Fan-Out & Hotspot` -- and a literal
    comparison then calls every one of them invented. Eight correct suggestions were rejected
    that way on the first real resume, which gutted the brief before it was applied.
    """
    text = value.replace("\\&", "&").replace("\\#", "#").replace("\\_", "_")
    text = text.replace("\\%", "%").replace("\\$", "$")
    text = text.replace("$\\sim$", "~").replace("---", "-").replace("--", "-")
    text = re.sub(r"\\text(bf|it|sc)\{([^}]*)\}", r"\2", text)
    return re.sub(r"\s+", " ", text).strip()


def split_items(line: str) -> list[str]:
    """Split a skills line on its top-level commas only.

    `Redis (Cluster, Streams, sorted sets)` is one skill. Splitting on every comma turned it
    into three -- "Redis (Cluster", "Streams", "sorted sets)" -- so naming it correctly failed
    the check that is supposed to catch inventions.
    """
    items: list[str] = []
    depth = 0
    current: list[str] = []
    for character in line:
        if character in "([{":
            depth += 1
        elif character in ")]}":
            depth = max(0, depth - 1)
        if character == "," and depth == 0:
            items.append("".join(current))
            current = []
            continue
        current.append(character)
    items.append("".join(current))
    return [item.strip() for item in items if item.strip()]


def source_skills(tex: str) -> dict[str, list[str]]:
    skills: dict[str, list[str]] = {}
    for match in SKILL_LINE.finditer(tex):
        skills[match.group("category").strip()] = split_items(match.group("items"))
    return skills


# A role with no end date is the one the reader checks first. Dropping it leaves an
# unexplained gap that no amount of reordering makes up for.
CURRENT_ROLE = re.compile(r"\\hfill\s*\\textit\{[^}]*\b(present|current|now)\b", re.IGNORECASE)
# Something a reader can check: a figure, a named system, a product. A capitalised word that
# opens the sentence does not count -- "Software engineer..." names nothing.
CONCRETE_NUMBER = re.compile(r"\d")
CONCRETE_DOMAIN = re.compile(r"\b[A-Za-z][\w-]*\.[A-Za-z]{2,}\b")
CONCRETE_NAME = re.compile(r"(?<!^)(?<![.!?]\s)\b[A-Z][\w.+#/-]*\b")


def concrete_tokens(text: str) -> set[str]:
    """The checkable specifics in a line: figures, domains, and named things."""
    found = {match.group(0) for match in CONCRETE_DOMAIN.finditer(text)}
    found |= {match.group(0) for match in CONCRETE_NUMBER.finditer(text)}
    found |= {match.group(0) for match in CONCRETE_NAME.finditer(text)}
    return found


def current_entries(tex: str) -> set[str]:
    """Entry titles whose date range has no end."""
    current: set[str] = set()
    for match in ENTRY_TITLE.finditer(tex):
        line_end = tex.find("\n", match.start())
        line = tex[match.start() : line_end if line_end != -1 else len(tex)]
        if CURRENT_ROLE.search(line):
            current.add(normalize_latex(match.group("title")).casefold())
    return current


def summary_line(tex: str) -> str:
    match = re.search(r"\\section\*\{Summary\}\s*\n([^\n]*)", tex)
    return match.group(1).strip() if match else ""


def findings(tex: str, brief: dict) -> list[Finding]:
    """Everything in the brief that the source does not already contain.

    Deterministic and in Python rather than asked of the model, for the same reason the rest of
    this repo checks generated material instead of trusting it: a prompt cannot be relied on to
    refuse itself. A skill or entry that fails here is not written.
    """
    problems: list[Finding] = []

    def key(value: str) -> str:
        return normalize_latex(value).casefold()

    sections = {key(item) for item in source_sections(tex)}
    entries = {key(item) for item in source_entries(tex)}
    skills = {
        key(category): {key(item) for item in items}
        for category, items in source_skills(tex).items()
    }

    for heading in brief.get("lead_sections") or []:
        if key(heading) not in sections:
            problems.append(
                Finding("unknown_section", f"{heading!r} is not a section of this résumé")
            )

    for field_name in ("promote_entries", "drop_entries"):
        for title in brief.get(field_name) or []:
            if key(title) not in entries:
                problems.append(
                    Finding("unknown_entry", f"{title!r} is not an entry in this résumé")
                )

    current = current_entries(tex)
    for title in brief.get("drop_entries") or []:
        if key(title) in current:
            problems.append(
                Finding(
                    "drops_current_role",
                    f"{title!r} is the current role and is never dropped; a résumé that ends "
                    "at an older job reads as a gap",
                )
            )

    replacement = str(brief.get("summary_line") or "")
    original = summary_line(tex)
    if replacement and original:
        # Comparative rather than absolute: the bad summary kept one named thing out of four,
        # which "does it name anything at all" would have waved through. Tailoring may change
        # which evidence leads; it may not quietly trade evidence for adjectives.
        kept, had = len(concrete_tokens(replacement)), len(concrete_tokens(original))
        if had >= 2 and kept * 2 < had:
            problems.append(
                Finding(
                    "summary_lost_evidence",
                    f"the replacement summary names {kept} specific thing(s) where the original "
                    f"names {had}, so the original summary was kept; tailoring may change which "
                    "evidence leads, not trade evidence for adjectives",
                    blocking=False,
                )
            )

    for group in brief.get("skills_order") or []:
        category = str(group.get("category", "")).strip()
        known = skills.get(key(category))
        if known is None:
            problems.append(
                Finding("unknown_skill_category", f"{category!r} is not a skills line here")
            )
            continue
        for item in group.get("items") or []:
            if key(item) not in known:
                problems.append(
                    Finding(
                        "invented_skill",
                        f"{item!r} is not listed under {category!r}; reordering may not add to it",
                    )
                )
    return problems


def apply_brief(tex: str, brief: dict) -> str:
    """Apply the permitted edits. Raises when the brief does not survive `findings`.

    Never inserts text except the summary line, and never rewrites a bullet.
    """
    problems = findings(tex, brief)
    blocking = [item for item in problems if item.blocking]
    if blocking:
        raise ValueError("; ".join(item.message for item in blocking))

    # A summary judged weaker than the one it would replace is simply not applied, so the
    # reordering still lands and the résumé does not come out worse than it went in.
    weaker = any(item.check == "summary_lost_evidence" for item in problems)
    result = tex if weaker else _replace_summary(tex, brief.get("summary_line", ""))
    result = _reorder_skills(result, brief.get("skills_order") or [])
    result = _drop_entries(result, brief.get("drop_entries") or [])
    result = _reorder_sections(result, brief.get("lead_sections") or [])
    _assert_intact(tex, result)
    return result


def _assert_intact(source: str, result: str) -> None:
    """The edits move text; they never remove the scaffolding that makes it a document.

    Checked here rather than left to the compiler: a structural mistake shows up there as
    "Emergency stop" with no PDF, which no output check can inspect, and the cause is a long
    way from the symptom.
    """
    for marker in ("\\documentclass", "\\begin{document}", "\\end{document}"):
        if source.count(marker) and result.count(marker) != source.count(marker):
            raise ValueError(
                f"the tailored résumé lost {marker!r}; the edit damaged the document structure"
            )


def _replace_summary(tex: str, summary: str) -> str:
    if not summary.strip():
        return tex
    match = re.search(r"(\\section\*\{Summary\}\s*\n)(?P<body>[^\n]*)", tex)
    if not match:
        return tex
    return tex[: match.start("body")] + summary.strip() + tex[match.end("body") :]


def _reorder_skills(tex: str, groups: list[dict]) -> str:
    wanted = {str(group.get("category", "")).strip().casefold(): group for group in groups}

    def rewrite(match: re.Match[str]) -> str:
        group = wanted.get(match.group("category").strip().casefold())
        if not group:
            return match.group(0)
        # Reorder only: the set must be identical, which `findings` has already established in
        # one direction and this check completes in the other. Split the same way `findings`
        # did -- on top-level commas. Splitting on every comma here instead read
        # `Redis (Cluster, Streams, sorted sets)` as three items, so the set never matched the
        # one item the brief had correctly named, and the line was returned unchanged. The
        # brief passed every check and reported success while four of the six skills lines in
        # the software résumé silently refused to reorder.
        current = split_items(match.group("items"))
        ordered = [item.strip() for item in group.get("items") or []]
        if sorted(item.casefold() for item in current) != sorted(
            item.casefold() for item in ordered
        ):
            return match.group(0)
        category = match.group("category")
        tail = match.group("tail") or ""
        return f"\\textbf{{{category}:}} {', '.join(ordered)}{tail}"

    return SKILL_LINE.sub(rewrite, tex)


def _entry_blocks(tex: str) -> list[tuple[str, int, int]]:
    """Each entry's title and its bounds, ending where the next entry or section begins.

    `\\end{document}` is a boundary too. Without it, dropping the last entry in the file took
    the document terminator with it, and the build died with "Emergency stop" and no PDF at all
    -- which the page-count guard cannot catch, because there is nothing to count.
    """
    starts = [(match.group("title").strip(), match.start()) for match in ENTRY_TITLE.finditer(tex)]
    closing = tex.find("\\end{document}")
    boundaries = sorted(
        [match.start() for match in SECTION.finditer(tex)]
        + [start for _, start in starts]
        + ([closing] if closing != -1 else [])
    )
    blocks: list[tuple[str, int, int]] = []
    for title, start in starts:
        following = [item for item in boundaries if item > start]
        blocks.append((title, start, following[0] if following else len(tex)))
    return blocks


def _drop_entries(tex: str, titles: list[str]) -> str:
    # Matched through `normalize_latex`, the same way `findings` accepted these titles. Comparing
    # the raw strings instead meant `Distributed Fan-Out & Hotspot Backend System` -- written the
    # way a person writes it, and passed by `findings` for exactly that reason -- matched nothing
    # in a source that spells it `Fan-Out \&`. The entry stayed, and the brief reported success.
    wanted = {normalize_latex(title).casefold() for title in titles if title.strip()}
    if not wanted:
        return tex
    for title, start, end in reversed(_entry_blocks(tex)):
        if normalize_latex(title).casefold() in wanted:
            tex = tex[:start].rstrip() + "\n\n" + tex[end:].lstrip("\n")
    return tex


def _reorder_sections(tex: str, order: list[str]) -> str:
    if not order:
        return tex
    matches = list(SECTION.finditer(tex))
    if not matches:
        return tex
    first = matches[0].start()
    end_of_document = tex.find("\\end{document}")
    tail_start = end_of_document if end_of_document != -1 else len(tex)

    blocks: dict[str, str] = {}
    sequence: list[str] = []
    for index, match in enumerate(matches):
        stop = matches[index + 1].start() if index + 1 < len(matches) else tail_start
        title = normalize_latex(match.group("title")).casefold()
        blocks[title] = tex[match.start() : stop]
        sequence.append(title)

    # Keyed through `normalize_latex` for the same reason as `_drop_entries`: `findings` accepts
    # a heading written the way a person writes it, so matching must too, or the brief passes
    # every check and the sections come out in their original order.
    wanted = [
        heading for title in order if (heading := normalize_latex(title).casefold()) in blocks
    ]
    # Anything the brief did not name keeps its original relative position, after those it did.
    remaining = [title for title in sequence if title not in wanted]
    body = "".join(blocks[title] for title in [*wanted, *remaining])
    return tex[:first] + body + tex[tail_start:]


def compile_pdf(tex: str, workdir: Path, stem: str) -> Path:
    """Build the tailored résumé, and refuse anything that does not fit on one page.

    pdflatex specifically: the sources use `\\input{glyphtounicode}` and `\\pdfgentounicode`,
    which are pdfTeX primitives. XeTeX cannot build them at all, and once patched past that it
    emits ligature codepoints where pdfTeX emits ASCII — degrading exactly the text extraction
    those two lines exist to protect.

    The page count is the check that a text diff cannot do. Density here is held by hand, so a
    slightly longer summary can push the document onto a second page, and a résumé that silently
    became two pages is worse than one that was never tailored.

    pdflatex runs in a throwaway directory and only the finished PDF is copied into `workdir`.
    Building in place left five files per document (`.tex`, `.aux`, `.log`, `.out`, `.pdf`) in
    the folder the user opens to find what to upload, and a refused two-page build left its PDF
    there too, looking exactly like one that passed.
    """
    engine = shutil.which("pdflatex")
    if engine is None:
        raise ResumeBuildError(
            "pdflatex is not installed, so a tailored résumé cannot be built. The brief is "
            "still usable by hand."
        )
    with tempfile.TemporaryDirectory(prefix="latex-") as scratch:
        build_dir = Path(scratch)
        source = build_dir / f"{stem}.tex"
        source.write_text(tex, encoding="utf-8")

        for _ in range(2):
            # Twice: hyperref and titlesec settle their references on the second pass.
            result = subprocess.run(  # noqa: S603
                [engine, "-interaction=nonstopmode", "-halt-on-error", source.name],
                cwd=build_dir,
                capture_output=True,
                text=True,
                timeout=120,
            )
            if result.returncode != 0:
                detail = _first_error(result.stdout) or "see the LaTeX log"
                raise ResumeBuildError(f"The tailored résumé did not compile: {detail}")

        pages = _page_count(build_dir / f"{stem}.log")
        if pages != 1:
            raise ResumeBuildError(
                f"The tailored résumé came to {pages} pages. It is not used; the stock résumé "
                "stands. Drop an entry and try again."
            )
        workdir.mkdir(parents=True, exist_ok=True)
        built = workdir / f"{stem}.pdf"
        shutil.copyfile(build_dir / f"{stem}.pdf", built)
    return built


# Tolerant of where pdflatex wrapped its log: the break can fall inside the filename or between
# the count and the comma after it, and requiring the comma missed the second case.
PAGE_REPORT = re.compile(r"Output written on .*?\(\s*(?P<pages>\d+)\s+pages?\b")


def _page_count(log: Path) -> int:
    """How many pages pdflatex says it wrote.

    Read from the log rather than the PDF: pdflatex compresses its object streams, so counting
    `/Type /Page` in the bytes finds nothing at all. The first version of this did exactly that
    and fell back to 1 when it found none, which made the guard pass everything — including a
    résumé that had genuinely spilled onto a second page.
    """
    # pdflatex hard-wraps its log at ~79 columns, so a long filename splits this line in two.
    # Collapse the whitespace before matching; anchoring on the unwrapped text worked in tests
    # only because the fixtures had short names.
    report = re.sub(r"\s+", " ", log.read_text(encoding="utf-8", errors="replace"))
    match = PAGE_REPORT.search(report)
    if match is None:
        raise ResumeBuildError("pdflatex did not report a page count; the résumé was not used")
    return int(match.group("pages"))


def _first_error(log: str) -> str:
    for line in log.splitlines():
        if line.startswith("!"):
            return line.lstrip("! ").strip()[:200]
    return ""
