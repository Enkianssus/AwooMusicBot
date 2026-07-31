"""Print x86 instructions near direct references to a PE string.

Usage:
  python disassemble_string_refs.py <dll> <string> [ascii|utf16]
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

import pefile
from capstone import CS_ARCH_X86, CS_MODE_32, Cs


def main() -> int:
    if len(sys.argv) not in (3, 4):
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    encoding = sys.argv[3] if len(sys.argv) == 4 else "ascii"
    needle = sys.argv[2].encode(
        "utf-16-le" if encoding == "utf16" else "ascii"
    )
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    image_base = pe.OPTIONAL_HEADER.ImageBase
    disassembler = Cs(CS_ARCH_X86, CS_MODE_32)

    string_offsets: list[int] = []
    start = 0
    while True:
        offset = data.find(needle, start)
        if offset < 0:
            break
        string_offsets.append(offset)
        start = offset + 1

    if not string_offsets:
        print(f"String not found: {sys.argv[2]!r}", file=sys.stderr)
        return 3

    for string_offset in string_offsets:
        string_rva = pe.get_rva_from_offset(string_offset)
        string_va = image_base + string_rva
        encoded_va = struct.pack("<I", string_va)
        print(
            f"STRING file=0x{string_offset:08X} "
            f"rva=0x{string_rva:08X} va=0x{string_va:08X}"
        )

        reference_start = 0
        found_reference = False
        while True:
            reference_offset = data.find(encoded_va, reference_start)
            if reference_offset < 0:
                break
            found_reference = True
            reference_start = reference_offset + 1
            reference_rva = pe.get_rva_from_offset(reference_offset)
            print(
                f"  REF file=0x{reference_offset:08X} "
                f"rva=0x{reference_rva:08X}"
            )
            disassemble_near(
                data,
                pe,
                disassembler,
                reference_offset,
                image_base,
                string_va,
            )

        if not found_reference:
            print("  No direct absolute references found.")

    return 0


def disassemble_near(
    data: bytes,
    pe: pefile.PE,
    disassembler: Cs,
    reference_offset: int,
    image_base: int,
    string_va: int,
) -> None:
    section = next(
        (
            candidate
            for candidate in pe.sections
            if candidate.PointerToRawData
            <= reference_offset
            < candidate.PointerToRawData + candidate.SizeOfRawData
        ),
        None,
    )
    if section is None:
        print("    Reference is outside a PE section.")
        return

    end = min(
        section.PointerToRawData + section.SizeOfRawData,
        reference_offset + 320,
    )

    selected: list | None = None
    for backtrack in range(1, 33):
        start = max(
            section.PointerToRawData,
            reference_offset - backtrack,
        )
        start_rva = (
            section.VirtualAddress
            + start
            - section.PointerToRawData
        )
        start_va = image_base + start_rva
        instructions = list(
            disassembler.disasm(data[start:end], start_va)
        )
        if any(
            f"0x{string_va:x}" in instruction.op_str.lower()
            for instruction in instructions
        ):
            selected = instructions
            break

    if selected is None:
        print(
            "    Could not synchronize disassembly at the reference. "
            f"Raw={data[reference_offset - 8:reference_offset + 12].hex(' ')}"
        )
        return

    for instruction in selected[:80]:
        marker = (
            ">>"
            if f"0x{string_va:x}" in instruction.op_str.lower()
            else "  "
        )
        print(
            f"    {marker} 0x{instruction.address:08X}: "
            f"{instruction.mnemonic:<8} {instruction.op_str}"
        )


if __name__ == "__main__":
    raise SystemExit(main())
