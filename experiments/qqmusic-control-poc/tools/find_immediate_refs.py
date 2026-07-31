"""Print x86 instructions that reference an immediate value.

Usage:
  python find_immediate_refs.py <dll> <value>
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pefile
from capstone import CS_ARCH_X86, CS_MODE_32, Cs


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    target = int(sys.argv[2], 0)
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    image_base = pe.OPTIONAL_HEADER.ImageBase
    disassembler = Cs(CS_ARCH_X86, CS_MODE_32)
    disassembler.skipdata = True
    found = 0

    for section in pe.sections:
        if not section.IMAGE_SCN_MEM_EXECUTE:
            continue

        start = section.PointerToRawData
        end = start + section.SizeOfRawData
        start_va = image_base + section.VirtualAddress
        for instruction in disassembler.disasm(data[start:end], start_va):
            values = {
                int(token, 16)
                for token in re.findall(
                    r"(?<![a-z0-9_])0x[0-9a-f]+",
                    instruction.op_str.lower(),
                )
            }
            if target not in values:
                continue
            found += 1
            print(
                f"0x{instruction.address:08X}: "
                f"{instruction.mnemonic:<8} {instruction.op_str}"
            )

    if found == 0:
        print(f"No immediate references found for 0x{target:X}.")
        return 3

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
