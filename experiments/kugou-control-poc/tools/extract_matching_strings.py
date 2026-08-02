"""List printable ASCII and UTF-16LE strings matching a regex in a PE file.

Usage: python extract_matching_strings.py <pe> <regex>
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pefile


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    if len(sys.argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    pattern = re.compile(sys.argv[2], re.IGNORECASE)
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    base = pe.OPTIONAL_HEADER.ImageBase
    seen: set[tuple[int, str]] = set()

    candidates: list[tuple[int, str, str]] = []
    candidates.extend(
        (match.start(), match.group().decode("ascii", errors="ignore"), "ascii")
        for match in re.finditer(rb"[\x20-\x7e]{4,}", data)
    )
    # Pull complete UTF-16LE strings around literal matches as the common
    # ASCII-style regex misses CJK code units whose high byte is non-zero.
    literal_terms = [
        term
        for term in re.split(r"[|()]", sys.argv[2])
        if term and not any(char in term for char in ".*+?[]{}\\")
    ]
    for term in literal_terms:
        encoded = term.encode("utf-16-le")
        cursor = 0
        while True:
            hit = data.find(encoded, cursor)
            if hit < 0:
                break
            cursor = hit + 2
            start = hit
            while start >= 2 and data[start - 2 : start] != b"\x00\x00":
                start -= 2
            end = hit + len(encoded)
            while end + 2 <= len(data) and data[end : end + 2] != b"\x00\x00":
                end += 2
            candidates.append(
                (start, data[start:end].decode("utf-16-le", errors="ignore"), "utf16")
            )

    for offset, value, encoding in candidates:
        if pattern.search(value) is None or (offset, value) in seen:
            continue
        seen.add((offset, value))
        try:
            va = base + pe.get_rva_from_offset(offset)
            location = f"va=0x{va:08X} file=0x{offset:08X}"
        except pefile.PEFormatError:
            location = f"file=0x{offset:08X}"
        print(f"{location} {encoding}: {value}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
