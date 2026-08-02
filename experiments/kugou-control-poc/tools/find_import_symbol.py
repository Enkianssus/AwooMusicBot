"""Print PE import-table entries whose symbol contains a substring.

Usage: python find_import_symbol.py <pe> <substring>
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
    for descriptor in getattr(pe, "DIRECTORY_ENTRY_IMPORT", []):
        dll_name = descriptor.dll.decode("ascii", errors="replace")
        for imported in descriptor.imports:
            name = (
                imported.name.decode("ascii", errors="replace")
                if imported.name
                else f"ordinal_{imported.ordinal}"
            )
            if needle not in name.lower():
                continue
            found += 1
            print(
                f"iat=0x{imported.address:08X} "
                f"{dll_name}!{name}"
            )
    return 0 if found else 3


if __name__ == "__main__":
    raise SystemExit(main())
