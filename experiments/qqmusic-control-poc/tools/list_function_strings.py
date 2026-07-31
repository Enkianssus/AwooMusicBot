"""List PE strings referenced by x86 instructions in an address range.

Usage:
  python list_function_strings.py <dll> <start-va> <end-va>
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pefile
from capstone import CS_ARCH_X86, CS_MODE_32, Cs


def main() -> int:
    sys.stdout.reconfigure(
        encoding="utf-8",
        errors="backslashreplace",
    )
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

    seen: set[tuple[int, str]] = set()
    for instruction in disassembler.disasm(
        data[start_offset:end_offset],
        start_va,
    ):
        for token in re.findall(r"0x[0-9a-f]+", instruction.op_str):
            address = int(token, 16)
            if not image_base <= address < image_base + pe.OPTIONAL_HEADER.SizeOfImage:
                continue
            try:
                offset = pe.get_offset_from_rva(address - image_base)
            except pefile.PEFormatError:
                continue
            value = read_string(data, offset)
            if value is None:
                continue
            key = (address, value)
            if key in seen:
                continue
            seen.add(key)
            print(
                f"0x{instruction.address:08X} -> "
                f"0x{address:08X}: {value}"
            )

    return 0


def read_string(data: bytes, offset: int) -> str | None:
    utf16_chars: list[str] = []
    cursor = offset
    while cursor + 1 < len(data) and len(utf16_chars) < 200:
        codepoint = data[cursor] | (data[cursor + 1] << 8)
        if codepoint == 0:
            break
        character = chr(codepoint)
        if not is_printable(character):
            utf16_chars.clear()
            break
        utf16_chars.append(character)
        cursor += 2
    utf16 = "".join(utf16_chars)

    ascii_chars: list[str] = []
    cursor = offset
    while cursor < len(data) and len(ascii_chars) < 200:
        value = data[cursor]
        if value == 0:
            break
        character = chr(value)
        if not is_printable(character):
            ascii_chars.clear()
            break
        ascii_chars.append(character)
        cursor += 1
    ascii_value = "".join(ascii_chars)

    candidates = [
        value
        for value in (utf16, ascii_value)
        if len(value) >= 2
    ]
    return max(candidates, key=len) if candidates else None


def is_printable(character: str) -> bool:
    return character.isprintable() and character not in "\r\n\t"


if __name__ == "__main__":
    raise SystemExit(main())
