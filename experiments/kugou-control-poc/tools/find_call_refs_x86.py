"""Find direct x86 E8 call references to a PE virtual address.

Usage: python find_call_refs_x86.py <pe> <target-va>
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
    raw_target = sys.argv[2]
    if "-" in raw_target:
        start_text, end_text = raw_target.split("-", 1)
        target_start = int(start_text, 0)
        target_end = int(end_text, 0)
    else:
        target_start = int(raw_target, 0)
        target_end = target_start
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    base = pe.OPTIONAL_HEADER.ImageBase
    found = 0
    for section in pe.sections:
        if not section.IMAGE_SCN_MEM_EXECUTE:
            continue
        start = section.PointerToRawData
        raw = data[start:start + section.SizeOfRawData]
        section_va = base + section.VirtualAddress
        cursor = 0
        while True:
            hit = raw.find(b"\xE8", cursor)
            if hit < 0 or hit + 5 > len(raw):
                break
            cursor = hit + 1
            displacement = struct.unpack_from("<i", raw, hit + 1)[0]
            call_va = section_va + hit
            target_va = call_va + 5 + displacement
            if target_start <= target_va <= target_end:
                found += 1
                print(f"call=0x{call_va:08X} target=0x{target_va:08X}")
    return 0 if found else 3


if __name__ == "__main__":
    raise SystemExit(main())
