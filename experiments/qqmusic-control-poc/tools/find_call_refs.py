"""Print x86 direct-call references to a virtual address in a PE image.

Usage:
  python find_call_refs.py <dll> <target-va>
"""

from __future__ import annotations

import sys
from pathlib import Path

import pefile
from capstone import CS_ARCH_X86, CS_MODE_32, Cs
from capstone.x86_const import X86_INS_CALL


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    target_va = int(sys.argv[2], 0)
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
            if instruction.id != X86_INS_CALL:
                continue
            if instruction.op_str.lower() != f"0x{target_va:x}":
                continue
            found += 1
            print(f"0x{instruction.address:08X}: call 0x{target_va:08X}")

    if found == 0:
        print(f"No direct calls found for 0x{target_va:08X}.")
        return 3

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
