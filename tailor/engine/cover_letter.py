"""The cover letter's LaTeX: the résumé's own letterhead above the letter's paragraphs.

Taken from job-applier's backend/scripts/build_cover_letter.py (commit 4487372), without its
command line and settings: the résumé source is passed in rather than looked up by a name.
"""

from __future__ import annotations

import re
from pathlib import Path

from resume_tailor import ResumeBuildError

ESCAPES = {
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}
SPECIAL = re.compile("|".join(re.escape(character) for character in ESCAPES))


def escape_latex(text: str) -> str:
    """Escape in one pass, so a replacement is never itself escaped.

    Replacing character by character instead looks like it only needs the backslash handled
    first, and it is not enough: `\\textbackslash{}` is inserted by that first pass and then the
    `{` and `}` rules escape its braces, so a literal backslash came out as
    `\\textbackslash\\{\\}` -- printed verbatim in the letter.
    """
    escaped = SPECIAL.sub(lambda match: ESCAPES[match.group(0)], text)
    # Written as an em or en dash, these are meant to be read, not typeset as TeX ligatures.
    return escaped.replace("—", "---").replace("–", "--")


def letterhead(source: Path) -> str:
    """The `\\begin{center}` block from the résumé: name, location, email, phone, links.

    Taken from the résumé rather than duplicated so the two documents cannot disagree about how
    to reach him -- the phone number and the LinkedIn URL have both been corrected there before.
    """
    if not source.exists():
        raise ResumeBuildError(f"{source.name} is missing, so the letterhead cannot be read")
    match = re.search(
        r"\\begin\{center\}.*?\\end\{center\}", source.read_text(encoding="utf-8"), re.S
    )
    if match is None:
        raise ResumeBuildError(f"no centred header block found in {source.name}")
    return match.group(0)


PREAMBLE = r"""\documentclass[11pt]{article}

\usepackage[margin=1in]{geometry}
\usepackage{lmodern}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage[hidelinks]{hyperref}
\usepackage{cmap}
\usepackage[none]{hyphenat}

\input{glyphtounicode}
\pdfgentounicode=1
\hyphenpenalty=10000
\exhyphenpenalty=10000

\pagenumbering{gobble}
\setlength{\parindent}{0pt}
\setlength{\parskip}{9pt}
\linespread{1.03}

\begin{document}
"""


def render(body: str, source: Path, when: str) -> str:
    paragraphs = [
        escape_latex(block.strip()) for block in re.split(r"\n\s*\n", body.strip()) if block.strip()
    ]
    # A line break inside a paragraph is wrapping in the source file, not an intended break.
    paragraphs = [re.sub(r"\s*\n\s*", " ", block) for block in paragraphs]
    return "\n".join(
        [
            PREAMBLE,
            letterhead(source),
            r"\vspace{10pt}",
            "",
            escape_latex(when),
            "",
            *[f"{block}\n" for block in paragraphs],
            r"\end{document}",
            "",
        ]
    )
