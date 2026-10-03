"""Cut Markdown into information units.

Block-level things that only make sense whole -- code, display math, tables,
images, raw HTML -- stay one unit each. Prose (paragraphs, list items, quotes)
is cut into sentences. Inside prose, spans whose punctuation must not end a
sentence (inline code, inline math, links, URLs, decimals, file names,
abbreviations) are masked before cutting and restored after.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class Unit:
    kind: str  # heading | sentence | code | math | table | image | html
    text: str  # Markdown source of this unit, renderable on its own
    section: str = ""  # nearest heading above, for context


FENCE = re.compile(r"^(\s*)(`{3,}|~{3,})(.*)$")
HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
HR = re.compile(r"^\s{0,3}([-*_])(\s*\1){2,}\s*$")
LIST_ITEM = re.compile(r"^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$")
TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
IMAGE_LINE = re.compile(r"^\s*!\[[^\]]*\]\([^)]*\)\s*$")
HTML_BLOCK = re.compile(r"^\s*<(div|table|details|figure|svg|img|iframe|video|audio|pre|section|blockquote|p|ul|ol)\b", re.I)
BEGIN_ENV = re.compile(r"^\s*\\begin\{([a-zA-Z*]+)\}")


def split_markdown(text: str) -> list[Unit]:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    units: list[Unit] = []
    section = ""
    i, n = 0, len(lines)

    def add(kind: str, body: str) -> None:
        body = body.strip("\n")
        if body.strip():
            units.append(Unit(kind, body, section))

    while i < n:
        line = lines[i]
        stripped = line.strip()

        if not stripped or HR.match(line):
            i += 1
            continue

        m = FENCE.match(line)
        if m:
            fence = m.group(2)
            j = i + 1
            while j < n and not lines[j].strip().startswith(fence[0] * len(fence)):
                j += 1
            block = "\n".join(lines[i : min(j + 1, n)])
            lang = m.group(3).strip().lower()
            add("math" if lang in ("math", "latex", "tex", "katex") else "code", block)
            i = j + 1
            continue

        if stripped.startswith("$$"):
            j = i
            rest = stripped[2:]
            if "$$" not in rest:
                j = i + 1
                while j < n and "$$" not in lines[j]:
                    j += 1
            add("math", "\n".join(lines[i : min(j + 1, n)]))
            i = j + 1
            continue

        if stripped.startswith("\\["):
            j = i
            if "\\]" not in stripped:
                j = i + 1
                while j < n and "\\]" not in lines[j]:
                    j += 1
            add("math", "\n".join(lines[i : min(j + 1, n)]))
            i = j + 1
            continue

        m = BEGIN_ENV.match(line)
        if m:
            end = "\\end{" + m.group(1) + "}"
            j = i
            while j < n and end not in lines[j]:
                j += 1
            add("math", "\n".join(lines[i : min(j + 1, n)]))
            i = j + 1
            continue

        if TABLE_ROW.match(line) and i + 1 < n and TABLE_SEP.match(lines[i + 1]):
            j = i + 2
            while j < n and lines[j].strip().startswith("|"):
                j += 1
            add("table", "\n".join(lines[i:j]))
            i = j
            continue

        m = HEADING.match(line)
        if m:
            section = m.group(2).strip()
            add("heading", line.strip())
            i += 1
            continue

        if IMAGE_LINE.match(line):
            add("image", stripped)
            i += 1
            continue

        if HTML_BLOCK.match(line):
            j = i
            while j < n and lines[j].strip():
                j += 1
            add("html", "\n".join(lines[i:j]))
            i = j
            continue

        if stripped.startswith(">"):
            j = i
            body = []
            while j < n and lines[j].strip().startswith(">"):
                body.append(re.sub(r"^\s*>\s?", "", lines[j]))
                j += 1
            for s in split_sentences(" ".join(x.strip() for x in body if x.strip())):
                add("sentence", "> " + s)
            i = j
            continue

        m = LIST_ITEM.match(line)
        if m:
            indent = len(m.group(1))
            body = [m.group(4)]
            j = i + 1
            while j < n and lines[j].strip() and not LIST_ITEM.match(lines[j]) \
                    and not FENCE.match(lines[j]) and len(lines[j]) - len(lines[j].lstrip()) > indent:
                body.append(lines[j].strip())
                j += 1
            for s in split_sentences(" ".join(body)):
                add("sentence", s)
            i = j
            continue

        # Paragraph: consecutive lines until something block-level starts.
        j = i
        body = []
        while j < n:
            cur = lines[j]
            if not cur.strip() or FENCE.match(cur) or HEADING.match(cur) or LIST_ITEM.match(cur) \
                    or cur.strip().startswith(("$$", "\\[", ">")) or BEGIN_ENV.match(cur) \
                    or (TABLE_ROW.match(cur) and j + 1 < n and TABLE_SEP.match(lines[j + 1])):
                if j > i:
                    break
            body.append(cur.strip())
            j += 1
        for s in split_sentences(_join_lines(body)):
            add("sentence", s)
        i = max(j, i + 1)

    return units


def _join_lines(lines: list[str]) -> str:
    """Join soft-wrapped lines: no space between CJK characters, one otherwise."""
    out = ""
    for line in lines:
        if not out:
            out = line
        elif _is_cjk(out[-1]) and line and _is_cjk(line[0]):
            out += line
        else:
            out += " " + line
    return out


def _is_cjk(ch: str) -> bool:
    return "　" <= ch <= "鿿" or "＀" <= ch <= "￯"


# Spans masked before cutting. Order matters: code first ($ inside code is
# not math), then math, then links and other dotted things.
PROTECT = [
    re.compile(r"(`+)(?:(?!\1).)+?\1"),                        # inline code
    re.compile(r"(?<![\\$])\$(?!\s)(?:\\.|[^$\n\\])+?(?<!\s)\$(?!\w)"),  # $math$ (not $5, not $PATH)
    re.compile(r"\\\((?:.|\n)+?\\\)"),                         # \( math \)
    re.compile(r"!?\[[^\]\n]*\]\([^)\n]*\)"),                  # [link](url), ![img](url)
    re.compile(r"<https?://[^>\s]+>"),                         # <autolink>
    re.compile(r"https?://[^\s<>，。；！？]*[^\s<>，。；！？.,;:!?)\]'\"]"),  # bare URL, not its trailing period
    re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"),               # email
    re.compile(r"\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|Prof|Fig|No|cf|al|approx|Inc|Ltd)\.", re.I),
    re.compile(r"\b(?:[A-Z]\.){2,}"),                          # U.S.A.
    re.compile(r"\d+\.\d+"),                                    # 3.14
    re.compile(r"\w+(?:\.\w+)+"),                               # models.py, a.b.c
]

# A sentence ends after CJK end punctuation, or after .!? that is followed by
# whitespace; closing quotes/brackets stay with the sentence they close.
_CLOSERS = "\"'”’」』）)】]》"
SENT_END = re.compile(r"([。！？!?]|\.(?=\s)|…{1,2}(?=\s|$))[" + re.escape(_CLOSERS) + r"]*\s*")


def split_sentences(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    masked, spans = _mask(text)
    parts, start = [], 0
    for m in SENT_END.finditer(masked):
        end = m.end()
        parts.append(masked[start:end].strip())
        start = end
    if start < len(masked):
        parts.append(masked[start:].strip())
    parts = [p for p in parts if p]
    # Fold fragments with almost no content ("OK." "是的。") into the previous one.
    merged: list[str] = []
    for p in parts:
        core = re.sub(r"[\W_]", "", _unmask(p, spans))
        if merged and len(core) <= 2:
            merged[-1] = merged[-1] + (" " if not _is_cjk(merged[-1][-1]) else "") + p
        else:
            merged.append(p)
    return [_unmask(p, spans) for p in merged]


def _mask(text: str) -> tuple[str, list[str]]:
    spans: list[str] = []

    def sub(m: re.Match) -> str:
        spans.append(m.group(0))
        return f"\x00{len(spans) - 1}\x00"

    for pattern in PROTECT:
        # Do not re-mask placeholders produced by an earlier pattern.
        pieces = re.split(r"(\x00\d+\x00)", text)
        text = "".join(p if p.startswith("\x00") else pattern.sub(sub, p) for p in pieces)
    return text, spans


def _unmask(text: str, spans: list[str]) -> str:
    while "\x00" in text:
        text = re.sub(r"\x00(\d+)\x00", lambda m: spans[int(m.group(1))], text)
    return text
