"""Print PE exports whose symbol contains a substring.

Usage: python find_export_symbol.py <pe> <substring>
"""

from __future__ import annotations

import sys

import pefile


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    pe = pefile.PE(sys.argv[1], fast_load=False)
    needle = sys.argv[2].lower()
    found = 0
    for exported in getattr(pe, "DIRECTORY_ENTRY_EXPORT", []).symbols:
        name = (
            exported.name.decode("ascii", errors="replace")
            if exported.name
            else f"ordinal_{exported.ordinal}"
        )
        if needle not in name.lower():
            continue
        found += 1
        print(
            f"va=0x{pe.OPTIONAL_HEADER.ImageBase + exported.address:08X} "
            f"rva=0x{exported.address:08X} ordinal={exported.ordinal} {name}"
        )
    return 0 if found else 3


if __name__ == "__main__":
    raise SystemExit(main())
