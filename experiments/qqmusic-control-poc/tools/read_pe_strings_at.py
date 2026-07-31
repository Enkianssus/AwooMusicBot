"""Read ASCII and UTF-16LE strings at PE virtual addresses.

Usage:
  python read_pe_strings_at.py <file> <va> [<va> ...]
"""

from __future__ import annotations

import sys
from pathlib import Path

import pefile


def read_terminated(data: bytes, offset: int, unit: int) -> str:
    cursor = offset
    while cursor + unit <= len(data):
        if all(value == 0 for value in data[cursor : cursor + unit]):
            break
        cursor += unit
    encoding = "utf-16-le" if unit == 2 else "ascii"
    return data[offset:cursor].decode(encoding, errors="replace")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    if len(sys.argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    image_base = pe.OPTIONAL_HEADER.ImageBase
    for raw_address in sys.argv[2:]:
        address = int(raw_address, 0)
        offset = pe.get_offset_from_rva(address - image_base)
        print(
            f"0x{address:08X} "
            f"ascii={read_terminated(data, offset, 1)!r} "
            f"utf16={read_terminated(data, offset, 2)!r}"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
