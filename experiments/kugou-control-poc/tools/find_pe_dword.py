"""Find a little-endian dword in a PE and print file/RVA/VA locations.

Usage:
  python find_pe_dword.py <pe> <value>
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
    value = int(sys.argv[2], 0)
    needle = struct.pack("<I", value)
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    found = 0
    start = 0
    while True:
        offset = data.find(needle, start)
        if offset < 0:
            break
        start = offset + 1
        try:
            rva = pe.get_rva_from_offset(offset)
        except pefile.PEFormatError:
            continue
        found += 1
        print(
            f"file=0x{offset:08X} rva=0x{rva:08X} "
            f"va=0x{pe.OPTIONAL_HEADER.ImageBase + rva:08X}"
        )

    return 0 if found else 3


if __name__ == "__main__":
    raise SystemExit(main())
