"""Find clustered x86 accesses to several object-field displacements.

Usage: python find_triplet_accesses_x86.py <pe> <disp[,disp...]> [radius]
"""

from __future__ import annotations

import sys
from pathlib import Path

import pefile
from capstone import CS_ARCH_X86, CS_MODE_32, CS_OP_MEM, Cs


def main() -> int:
    if len(sys.argv) not in (3, 4):
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    displacements = {int(value, 0) for value in sys.argv[2].split(",")}
    radius = int(sys.argv[3], 0) if len(sys.argv) == 4 else 8
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    base = pe.OPTIONAL_HEADER.ImageBase
    disassembler = Cs(CS_ARCH_X86, CS_MODE_32)
    disassembler.detail = True
    disassembler.skipdata = True

    for section in pe.sections:
        if not section.IMAGE_SCN_MEM_EXECUTE:
            continue
        raw_start = section.PointerToRawData
        raw = data[raw_start:raw_start + section.SizeOfRawData]
        instructions = list(disassembler.disasm(raw, base + section.VirtualAddress))
        matching: list[tuple[int, set[int]]] = []
        for index, instruction in enumerate(instructions):
            if instruction.id == 0:
                continue
            hits = {
                operand.mem.disp
                for operand in instruction.operands
                if operand.type == CS_OP_MEM
                and operand.mem.base != 0
                and operand.mem.disp in displacements
            }
            if hits:
                matching.append((index, hits))

        windows: list[tuple[int, int]] = []
        clusters: list[list[tuple[int, set[int]]]] = []
        for item in matching:
            if clusters and item[0] - clusters[-1][-1][0] <= radius * 2 + 1:
                clusters[-1].append(item)
            else:
                clusters.append([item])
        for cluster in clusters:
            if len(set().union(*(hits for _, hits in cluster))) < 2:
                continue
            index = cluster[0][0]
            start = max(0, index - radius)
            end = min(len(instructions), cluster[-1][0] + radius + 1)
            if windows and start <= windows[-1][1]:
                windows[-1] = (windows[-1][0], max(windows[-1][1], end))
            else:
                windows.append((start, end))

        for start, end in windows:
            print(f"--- 0x{instructions[start].address:08X}-0x{instructions[end - 1].address:08X} ---")
            for instruction in instructions[start:end]:
                marker = "*" if any(
                    operand.type == CS_OP_MEM
                    and operand.mem.base != 0
                    and operand.mem.disp in displacements
                    for operand in instruction.operands
                ) else " "
                byte_text = instruction.bytes.hex(" ").upper()
                print(
                    f"{marker} 0x{instruction.address:08X}: {byte_text:<30} "
                    f"{instruction.mnemonic:<8} {instruction.op_str}"
                )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
