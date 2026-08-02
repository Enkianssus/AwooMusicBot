"""Dump PE vtable slots and the first instructions of each target.

Usage: python dump_pe_vtable.py <pe> <vtable-va> <start-offset> <end-offset>
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

import pefile
from capstone import CS_ARCH_X86, CS_MODE_32, Cs


def main() -> int:
    if len(sys.argv) != 5:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    vtable_va = int(sys.argv[2], 0)
    start_offset = int(sys.argv[3], 0)
    end_offset = int(sys.argv[4], 0)
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    image_base = pe.OPTIONAL_HEADER.ImageBase
    disassembler = Cs(CS_ARCH_X86, CS_MODE_32)
    disassembler.skipdata = True

    for offset in range(start_offset, end_offset + 1, 4):
        slot_va = vtable_va + offset
        slot_file = pe.get_offset_from_rva(slot_va - image_base)
        target = struct.unpack_from("<I", data, slot_file)[0]
        try:
            target_file = pe.get_offset_from_rva(target - image_base)
        except pefile.PEFormatError:
            print(f"+0x{offset:03X} -> 0x{target:08X} <outside image>")
            continue

        instructions = list(disassembler.disasm(
            data[target_file:target_file + 36], target
        ))[:7]
        rendered = "; ".join(
            f"{instruction.mnemonic} {instruction.op_str}".strip()
            for instruction in instructions
        )
        print(f"+0x{offset:03X} -> 0x{target:08X}: {rendered}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
