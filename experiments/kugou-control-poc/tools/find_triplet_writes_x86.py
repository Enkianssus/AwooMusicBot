"""Find compact direct x86 writes to a three-dword object field.

Usage: python find_triplet_writes_x86.py <pe> <first-disp>
"""

from __future__ import annotations

import sys
from pathlib import Path

import pefile


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    first = int(sys.argv[2], 0)
    targets = {first, first + 4, first + 8}
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    image_base = pe.OPTIONAL_HEADER.ImageBase
    results: set[tuple[int, int]] = set()

    for section in pe.sections:
        if not section.IMAGE_SCN_MEM_EXECUTE:
            continue
        raw_start = section.PointerToRawData
        raw = data[raw_start:raw_start + section.SizeOfRawData]
        accesses: list[tuple[int, int, int, bool]] = []
        # offset, base register, displacement, is_write
        for offset in range(len(raw) - 2):
            opcode = raw[offset]
            if opcode not in (0x89, 0x8B, 0x8D, 0x83, 0xC6, 0xC7):
                continue
            modrm = raw[offset + 1]
            if modrm >> 6 != 1 or modrm & 7 == 4:
                continue
            displacement = raw[offset + 2]
            if displacement not in targets:
                continue
            is_write = opcode in (0x89, 0x83, 0xC6, 0xC7)
            accesses.append((offset, modrm & 7, displacement, is_write))

        for index, access in enumerate(accesses):
            start_offset, base_register, _, _ = access
            window = [
                item for item in accesses[index:]
                if item[0] <= start_offset + 96 and item[1] == base_register
            ]
            if {item[2] for item in window} != targets:
                continue
            if not all(any(item[2] == displacement and item[3] for item in window) for displacement in targets):
                continue
            results.add((
                image_base + section.VirtualAddress + start_offset,
                image_base + section.VirtualAddress + window[-1][0],
            ))

    for start, end in sorted(results):
        print(f"0x{start:08X}-0x{end:08X}")
    return 0 if results else 3


if __name__ == "__main__":
    raise SystemExit(main())
