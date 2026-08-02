"""Read little-endian values at PE virtual addresses.

Usage:
  python read_pe_values.py <pe> <va> [<va> ...]
"""

from __future__ import annotations

import sys
from pathlib import Path

import pefile


def main() -> int:
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
        raw = data[offset : offset + 16]
        print(
            f"va=0x{address:08X} file=0x{offset:08X} "
            f"u32=0x{int.from_bytes(raw[:4], 'little'):08X} "
            f"bytes={raw.hex(' ')}"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
