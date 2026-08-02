"""Find x86 indirect calls through a selected vtable byte offset.

Usage: python find_indirect_vtable_calls_x86.py <pe> <offset> [start-va] [end-va]
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

import pefile
from capstone import CS_ARCH_X86, CS_MODE_32, Cs


def main() -> int:
    if len(sys.argv) not in (3, 5):
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    target_offset = int(sys.argv[2], 0)
    minimum_va = int(sys.argv[3], 0) if len(sys.argv) == 5 else 0
    maximum_va = int(sys.argv[4], 0) if len(sys.argv) == 5 else (1 << 64) - 1
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    image_base = pe.OPTIONAL_HEADER.ImageBase
    disassembler = Cs(CS_ARCH_X86, CS_MODE_32)
    disassembler.skipdata = True
    found = 0

    for section in pe.sections:
        if not section.IMAGE_SCN_MEM_EXECUTE:
            continue

        raw_start = section.PointerToRawData
        raw = data[raw_start:raw_start + section.SizeOfRawData]
        section_va = image_base + section.VirtualAddress
        candidates: list[int] = []

        if -128 <= target_offset <= 127:
            displacement = target_offset & 0xFF
            for modrm in range(0x50, 0x58):
                needle = bytes((0xFF, modrm, displacement))
                start = 0
                while True:
                    index = raw.find(needle, start)
                    if index < 0:
                        break
                    candidates.append(index)
                    start = index + 1

        displacement_bytes = struct.pack("<i", target_offset)
        for modrm in range(0x90, 0x98):
            needle = bytes((0xFF, modrm)) + displacement_bytes
            start = 0
            while True:
                index = raw.find(needle, start)
                if index < 0:
                    break
                candidates.append(index)
                start = index + 1

        for index in sorted(set(candidates)):
            instruction_va = section_va + index
            if not minimum_va <= instruction_va < maximum_va:
                continue
            context_start = max(0, index - 48)
            context_end = min(len(raw), index + 80)
            context_va = section_va + context_start
            instructions = list(disassembler.disasm(
                raw[context_start:context_end], context_va
            ))
            if not any(
                instruction.address == instruction_va
                and instruction.mnemonic == "call"
                for instruction in instructions
            ):
                continue

            found += 1
            print(f"CALL 0x{instruction_va:08X}")
            for instruction in instructions:
                marker = ">>" if instruction.address == instruction_va else "  "
                byte_text = instruction.bytes.hex(" ").upper()
                print(
                    f"  {marker} 0x{instruction.address:08X}: "
                    f"{byte_text:<24} {instruction.mnemonic:<8} "
                    f"{instruction.op_str}"
                )

    return 0 if found else 3


if __name__ == "__main__":
    raise SystemExit(main())
