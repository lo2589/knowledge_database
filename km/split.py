"""Cut Markdown into information units.

Block-level things that only make sense whole -- code, display math, images,
raw HTML -- stay one unit each. Tables become one unit per populated data
field, labelled with its row and column. Consecutive labelled records in prose
also become separate units; other prose is cut into sentences. Inside prose,
spans whose punctuation must not end a
sentence (inline code, inline math, links, URLs, decimals, file names,
abbreviations) are masked before cutting and restored after.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class Unit:
    kind: str  # heading | sentence | code | math | table_item | image | html
    text: str  # Markdown source of this unit, renderable on its own
    section: str = ""  # nearest heading above, for context


FENCE = re.compile(r"^(\s*)(`{3,}|~{3,})(.*)$")
HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
HR = re.compile(r"^\s{0,3}([-*_])(\s*\1){2,}\s*$")
LIST_ITEM = re.compile(r"^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$")
TABLE_SEP_CELL = re.compile(r":?-{2,}:?")
INLINE_MATH = re.compile(r"(?<![\\$])\$(?!\s)(?:\\.|[^$\n\\])+?(?<!\s)\$(?!\w)")
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

        headers = _table_cells(line)
        separator = _table_cells(lines[i + 1]) if i + 1 < n else None
        if headers and separator and len(headers) == len(separator) \
                and all(TABLE_SEP_CELL.fullmatch(c) for c in separator):
            j = i + 2
            rows = []
            while j < n:
                cells = _table_cells(lines[j])
                if not cells or len(cells) > len(headers):
                    break
                rows.append(cells)
                j += 1
            for item in _table_items(headers, rows):
                add("table_item", item)
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
                    or (_table_cells(cur) and j + 1 < n and _table_separator(lines[j + 1])):
                if j > i:
                    break
            body.append(cur.strip())
            j += 1
        for s in split_sentences(_join_lines(body)):
            add("sentence", s)
        i = max(j, i + 1)

    return units


def _table_cells(line: str) -> list[str] | None:
    """Split GFM cells without treating escaped/code/math pipes as columns."""
    text = line.strip()
    if not text or "|" not in text:
        return None
    cells, cell = [], []
    code, separators = 0, 0
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            cell.extend((ch, text[i + 1]))
            i += 2
            continue
        if ch == "`":
            j = i
            while j < len(text) and text[j] == "`":
                j += 1
            size = j - i
            if not code or code == size:
                code = 0 if code else size
            cell.append(text[i:j])
            i = j
            continue
        if ch == "$" and not code:
            match = INLINE_MATH.match(text, i)
            if match:
                cell.append(match.group())
                i = match.end()
                continue
        if ch == "|" and not code:
            cells.append("".join(cell).strip())
            cell, separators = [], separators + 1
        else:
            cell.append(ch)
        i += 1
    cells.append("".join(cell).strip())
    if not separators:
        return None
    if text.startswith("|"):
        cells.pop(0)
    if text.endswith("|") and not text.endswith("\\|"):
        cells.pop()
    return cells or None


def _table_separator(line: str) -> bool:
    cells = _table_cells(line)
    return bool(cells) and all(TABLE_SEP_CELL.fullmatch(c) for c in cells)


def _table_items(headers: list[str], rows: list[list[str]]) -> list[str]:
    """One selectable datum per field, with enough labels to stand alone."""
    out = []
    width = len(headers)
    for index, row in enumerate(rows, 1):
        cells = row + [""] * (width - len(row))
        if width == 1:
            if cells[0]:
                out.append(cells[0])
            continue
        key = cells[0] or f"第{index}条"
        key_name = headers[0] or "项目"
        for column in range(1, width):
            value = cells[column]
            if not value or value in ("-", "—", "–"):
                continue
            field = headers[column] or f"字段{column + 1}"
            out.append(f"{key_name}：{key} · {field}：{value}")
    return out


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
    INLINE_MATH,                                                   # $math$ (not $5, not $PATH)
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

# Consecutive labelled records sometimes arrive as one paragraph rather than
# Markdown list items (for example, "A：... B：... C：...").
LABELLED_ITEM = re.compile(
    r"(?<!\S)(?:(?:\*\*|__)([A-Z]|\d{1,2})\s*[：:](?:\*\*|__)"
    r"|(?:\*\*|__)([A-Z]|\d{1,2})(?:\*\*|__)\s*[：:]"
    r"|([A-Z]|\d{1,2})\s*[：:])\s*")


def _labelled_items(text: str) -> list[str]:
    matches = list(LABELLED_ITEM.finditer(text))
    if len(matches) < 2 or matches[0].start() != 0:
        return [text]
    labels = [next(group for group in m.groups() if group) for m in matches]
    if not all((ord(b) == ord(a) + 1) if a.isalpha() and b.isalpha()
               else (int(b) == int(a) + 1) if a.isdigit() and b.isdigit()
               else False for a, b in zip(labels, labels[1:])):
        return [text]
    return [text[m.start():matches[i + 1].start() if i + 1 < len(matches) else len(text)].strip()
            for i, m in enumerate(matches)]


# A sentence ends after CJK end punctuation, or after .!? that is followed by
# whitespace; closing quotes/brackets stay with the sentence they close.
_CLOSERS = "\"'”’」』）)】]》"
SENT_END = re.compile(r"([。！？!?]|\.(?=\s)|…{1,2}(?=\s|$))[" + re.escape(_CLOSERS) + r"]*\s*")


def split_sentences(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    masked, spans = _mask(text)
    result: list[str] = []
    for item in _labelled_items(masked):
        parts, start = [], 0
        for m in SENT_END.finditer(item):
            end = m.end()
            parts.append(item[start:end].strip())
            start = end
        if start < len(item):
            parts.append(item[start:].strip())
        # Fold fragments with almost no content ("OK." "是的。") into the
        # previous sentence of the same data item, never into another item.
        merged: list[str] = []
        for p in (p for p in parts if p):
            core = re.sub(r"[\W_]", "", _unmask(p, spans))
            if merged and len(core) <= 2:
                merged[-1] = merged[-1] + (" " if not _is_cjk(merged[-1][-1]) else "") + p
            else:
                merged.append(p)
        result.extend(_unmask(p, spans) for p in merged)
    return result


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
