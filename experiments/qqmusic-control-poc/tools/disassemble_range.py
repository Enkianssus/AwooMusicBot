"""Disassemble an x86 PE virtual-address range.

Usage:
  python disassemble_range.py <dll> <start-va> <end-va>
"""

from __future__ import annotations

import sys
from pathlib import Path

import pefile
from capstone import CS_ARCH_X86, CS_MODE_32, Cs


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    start_va = int(sys.argv[2], 0)
    end_va = int(sys.argv[3], 0)
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    image_base = pe.OPTIONAL_HEADER.ImageBase
    start_offset = pe.get_offset_from_rva(start_va - image_base)
    end_offset = pe.get_offset_from_rva(end_va - image_base)
    disassembler = Cs(CS_ARCH_X86, CS_MODE_32)

    for instruction in disassembler.disasm(
        data[start_offset:end_offset],
        start_va,
    ):
        byte_text = instruction.bytes.hex(" ").upper()
        print(
            f"0x{instruction.address:08X}: "
            f"{byte_text:<24} "
            f"{instruction.mnemonic:<8} {instruction.op_str}"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
