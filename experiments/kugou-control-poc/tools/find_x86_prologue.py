"""Find likely x86 function prologues before a PE virtual address.

Usage: python find_x86_prologue.py <pe> <va>
"""

from __future__ import annotations

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
    base = pe.OPTIONAL_HEADER.ImageBase
    target_offset = pe.get_offset_from_rva(target_va - base)
    window_start = max(0, target_offset - 0x5000)
    window = data[window_start:target_offset]
    patterns = (b"\x55\x8b\xec", b"\x53\x8b\xdc")
    matches: list[int] = []
    for pattern in patterns:
        cursor = 0
        while True:
            hit = window.find(pattern, cursor)
            if hit < 0:
                break
            cursor = hit + 1
            matches.append(window_start + hit)
    for offset in sorted(matches)[-12:]:
        rva = pe.get_rva_from_offset(offset)
        print(f"file=0x{offset:08X} va=0x{base + rva:08X}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
