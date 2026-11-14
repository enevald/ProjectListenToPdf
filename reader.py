import re

import pdfplumber


_NUMBERED_HEADING = re.compile(
    r"^(?:(?:chapter|section|part|appendix)\s+[\w.-]+|\([a-z0-9]+\)\s+\S|\d+(?:\.\d+)*(?:[.)])?\s+\S)",
    re.IGNORECASE,
)
_ALL_CAPS_HEADING = re.compile(r"^[A-Z\d][A-Z\d\s:,&'()-]{3,79}$")
_SENTENCE_END = re.compile(r"[.!?][\"')\]]?$")


def _is_heading(line):
    if len(line) > 100 or line.endswith((".", "!", "?")):
        return False
    if _NUMBERED_HEADING.match(line) or _ALL_CAPS_HEADING.match(line):
        return True

    words = line.split()
    if not 1 <= len(words) <= 8 or not line[0].isupper():
        return False
    capitalized = sum(word[0].isupper() for word in words if word[0].isalpha())
    return capitalized >= max(1, len(words) - 1)


def extract_document(path):
    blocks = []
    sections = [{"title": "Introduction", "start": 0}]
    current_section = 0

    def add_text(text):
        nonlocal current_section
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            blocks.append({"text": text, "kind": "text", "section": current_section})

    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if not page_text:
                continue

            paragraph = []
            for raw_line in page_text.splitlines():
                line = re.sub(r"\s+", " ", raw_line).strip()
                if not line:
                    add_text(" ".join(paragraph))
                    paragraph = []
                    continue
                if _is_heading(line):
                    add_text(" ".join(paragraph))
                    paragraph = []
                    if sections[-1]["title"] == "Introduction" and not any(
                        block["kind"] == "text" for block in blocks
                    ):
                        sections[-1]["title"] = line
                        current_section = 0
                        blocks.append({"text": line, "kind": "heading", "section": current_section})
                    else:
                        current_section += 1
                        sections.append({"title": line, "start": len(blocks) + 1})
                        blocks.append({"text": line, "kind": "heading", "section": current_section})
                    continue

                paragraph.append(line)
                combined = " ".join(paragraph)
                if _SENTENCE_END.search(line) or len(combined) >= 500:
                    add_text(combined)
                    paragraph = []

            add_text(" ".join(paragraph))

    return {"blocks": blocks, "sections": sections}
