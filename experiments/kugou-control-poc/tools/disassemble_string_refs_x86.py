"""Find x86 instructions that reference a string in a PE image.

Usage: python disassemble_string_refs_x86.py <pe> <string> [ascii|utf16]
"""

from __future__ import annotations

import sys
import struct
from pathlib import Path

import pefile
from capstone import CS_ARCH_X86, CS_MODE_32, CS_OP_IMM, Cs, CsError


def main() -> int:
    if len(sys.argv) not in (3, 4):
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    encoding = sys.argv[3].lower() if len(sys.argv) == 4 else "ascii"
    if encoding not in {"ascii", "utf16"}:
        print("encoding must be ascii or utf16", file=sys.stderr)
        return 2
    needle = sys.argv[2].encode(
        "utf-16-le" if encoding == "utf16" else "ascii"
    )
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    image_base = pe.OPTIONAL_HEADER.ImageBase
    targets: dict[int, int] = {}
    cursor = 0
    while True:
        offset = data.find(needle, cursor)
        if offset < 0:
            break
        cursor = offset + 1
        try:
            targets[image_base + pe.get_rva_from_offset(offset)] = offset
        except pefile.PEFormatError:
            pass

    if not targets:
        print(f"String not found: {sys.argv[2]!r}", file=sys.stderr)
        return 3

    disassembler = Cs(CS_ARCH_X86, CS_MODE_32)
    disassembler.detail = True
    disassembler.skipdata = True
    reference_windows: list[tuple[int, bytes, int, int]] = []
    for section in pe.sections:
        if not section.IMAGE_SCN_MEM_EXECUTE:
            continue
        start = section.PointerToRawData
        end = start + section.SizeOfRawData
        start_va = image_base + section.VirtualAddress
        raw = data[start:end]
        for target in targets:
            encoded = struct.pack("<I", target)
            cursor = 0
            while True:
                hit = raw.find(encoded, cursor)
                if hit < 0:
                    break
                cursor = hit + 1
                reference_windows.append((start_va, raw, hit, target))

    for target, offset in targets.items():
        print(f"STRING file=0x{offset:08X} va=0x{target:08X}")
    if not reference_windows:
        print("No immediate references found.")
        return 4

    emitted: set[int] = set()
    for section_va, raw, hit, target in reference_windows:
        reference = None
        context = None
        for lookbehind in range(0, 16):
            candidate_start = max(0, hit - lookbehind)
            instructions = list(disassembler.disasm(
                raw[candidate_start:min(len(raw), hit + 96)],
                section_va + candidate_start,
            ))
            for instruction in instructions:
                try:
                    has_target = any(
                        operand.type == CS_OP_IMM and operand.imm == target
                        for operand in instruction.operands
                    )
                except CsError:
                    has_target = False
                if has_target:
                    reference = instruction
                    context_start = max(0, candidate_start - 64)
                    context = list(disassembler.disasm(
                        raw[context_start:min(len(raw), hit + 160)],
                        section_va + context_start,
                    ))
                    break
            if reference is not None:
                break

        reference_va = section_va + hit
        if reference is None:
            print(f"RAW-REF va=0x{reference_va:08X}")
            continue
        if reference.address in emitted:
            continue
        emitted.add(reference.address)
        print(f"REF va=0x{reference.address:08X}")
        for instruction in context or [reference]:
            marker = ">>" if instruction.address == reference.address else "  "
            byte_text = instruction.bytes.hex(" ").upper()
            print(
                f"  {marker} 0x{instruction.address:08X}: "
                f"{byte_text:<28} {instruction.mnemonic:<8} {instruction.op_str}"
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
