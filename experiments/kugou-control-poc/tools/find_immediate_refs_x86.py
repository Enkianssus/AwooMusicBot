"""Find x86 instructions whose immediate operand equals a requested value.

Usage: python find_immediate_refs_x86.py <pe> <value|start:end> [...]
"""

from __future__ import annotations

import sys
import struct
from pathlib import Path

import pefile
from capstone import CS_ARCH_X86, CS_MODE_32, CS_OP_IMM, Cs, CsError


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    values: set[int] = set()
    for raw in sys.argv[2:]:
        if ":" not in raw:
            values.add(int(raw, 0) & 0xFFFFFFFF)
            continue

        raw_start, raw_end = raw.split(":", 1)
        range_start = int(raw_start, 0) & 0xFFFFFFFF
        range_end = int(raw_end, 0) & 0xFFFFFFFF
        if range_start > range_end or range_start % 4 or range_end % 4:
            raise ValueError("Ranges must be increasing and dword-aligned")
        values.update(range(range_start, range_end + 1, 4))
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    image_base = pe.OPTIONAL_HEADER.ImageBase
    disassembler = Cs(CS_ARCH_X86, CS_MODE_32)
    disassembler.detail = True
    disassembler.skipdata = False
    found = 0

    for section in pe.sections:
        if not section.IMAGE_SCN_MEM_EXECUTE:
            continue
        start = section.PointerToRawData
        raw = data[start:start + section.SizeOfRawData]
        section_va = image_base + section.VirtualAddress
        for immediate_offset in range(0, len(raw) - 3):
            value = struct.unpack_from("<I", raw, immediate_offset)[0]
            if value not in values:
                continue

            # x86 instructions are at most 15 bytes long. Disassemble each
            # possible start before the literal and retain only an instruction
            # that ends immediately after the four-byte value.
            left = max(0, immediate_offset - 11)
            expected_end = immediate_offset + 4
            for candidate_start in range(left, immediate_offset + 1):
                instructions = list(disassembler.disasm(
                    raw[candidate_start:expected_end],
                    section_va + candidate_start,
                    count=1,
                ))
                if len(instructions) != 1:
                    continue
                instruction = instructions[0]
                if candidate_start + instruction.size != expected_end:
                    continue
                try:
                    matched = {
                        operand.imm & 0xFFFFFFFF
                        for operand in instruction.operands
                        if operand.type == CS_OP_IMM
                    }
                except CsError:
                    continue
                if value not in matched:
                    continue
                found += 1
                byte_text = instruction.bytes.hex(" ").upper()
                print(
                    f"0x{instruction.address:08X}: {byte_text:<30} "
                    f"{instruction.mnemonic:<8} {instruction.op_str} "
                    f"; 0x{value:X}"
                )

    return 0 if found else 3


if __name__ == "__main__":
    raise SystemExit(main())
