"""Find direct x86 E9 jump references to a PE virtual address.

Usage: python find_jump_refs_x86.py <pe> <target-va>
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
    target_va = int(sys.argv[2], 0)
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    image_base = pe.OPTIONAL_HEADER.ImageBase
    found = 0

    for section in pe.sections:
        if not section.IMAGE_SCN_MEM_EXECUTE:
            continue

        raw_start = section.PointerToRawData
        raw = data[raw_start:raw_start + section.SizeOfRawData]
        section_va = image_base + section.VirtualAddress
        cursor = 0
        while True:
            index = raw.find(b"\xE9", cursor)
            if index < 0 or index + 5 > len(raw):
                break
            cursor = index + 1
            displacement = struct.unpack_from("<i", raw, index + 1)[0]
            jump_va = section_va + index
            if jump_va + 5 + displacement != target_va:
                continue

            found += 1
            print(f"jump=0x{jump_va:08X} target=0x{target_va:08X}")

    return 0 if found else 3


if __name__ == "__main__":
    raise SystemExit(main())
