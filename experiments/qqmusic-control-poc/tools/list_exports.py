"""List PE exports whose names match a regular expression.

Usage:
  python list_exports.py <regex> <file> [<file> ...]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pefile


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    pattern = re.compile(sys.argv[1], re.IGNORECASE)
    for raw_path in sys.argv[2:]:
        path = Path(raw_path)
        pe = pefile.PE(str(path))
        print(f"FILE {path}")
        directory = getattr(pe, "DIRECTORY_ENTRY_EXPORT", None)
        if directory is None:
            continue
        for symbol in directory.symbols:
            name = (
                symbol.name.decode("ascii", errors="replace")
                if symbol.name is not None
                else f"ordinal:{symbol.ordinal}"
            )
            if pattern.search(name) is not None:
                print(
                    f"0x{pe.OPTIONAL_HEADER.ImageBase + symbol.address:08X} "
                    f"{name}"
                )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
