"""Extract matching printable ASCII and UTF-16LE strings from binaries.

Usage:
  python extract_matching_strings.py <regex> <file> [<file> ...]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pefile


def extract_ascii(data: bytes) -> list[tuple[int, str]]:
    return [
        (
            match.start(),
            match.group().decode("ascii", errors="ignore"),
        )
        for match in re.finditer(rb"[\x20-\x7e]{4,}", data)
    ]


def extract_utf16(data: bytes) -> list[tuple[int, str]]:
    values: list[tuple[int, str]] = []
    for match in re.finditer(rb"(?:[\x20-\x7e]\x00){4,}", data):
        values.append(
            (
                match.start(),
                match.group().decode("utf-16-le", errors="ignore"),
            )
        )
    return values


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    pattern = re.compile(sys.argv[1], re.IGNORECASE)
    for raw_path in sys.argv[2:]:
        path = Path(raw_path)
        data = path.read_bytes()
        pe = pefile.PE(str(path), fast_load=True)
        seen: set[str] = set()
        print(f"FILE {path}")
        for offset, value in [*extract_ascii(data), *extract_utf16(data)]:
            if value in seen or pattern.search(value) is None:
                continue
            seen.add(value)
            try:
                rva = pe.get_rva_from_offset(offset)
                va = pe.OPTIONAL_HEADER.ImageBase + rva
                location = f"VA 0x{va:08X}, file 0x{offset:X}"
            except pefile.PEFormatError:
                location = f"file 0x{offset:X}"
            print(f"{location}: {value}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
