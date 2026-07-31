"""Find raw 32-bit little-endian pointer references in a PE image.

Usage:
  python find_pointer_refs.py <file> <virtual-address>
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

import pefile


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    target = int(sys.argv[2], 0)
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    needle = struct.pack("<I", target)
    cursor = 0
    found = False
    while True:
        offset = data.find(needle, cursor)
        if offset < 0:
            break
        found = True
        try:
            rva = pe.get_rva_from_offset(offset)
            location = pe.OPTIONAL_HEADER.ImageBase + rva
            print(f"VA 0x{location:08X}, file 0x{offset:X}")
        except pefile.PEFormatError:
            print(f"file 0x{offset:X}")
        cursor = offset + 1

    if not found:
        print(f"No pointer references found for 0x{target:08X}.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
