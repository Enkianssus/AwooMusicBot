"""Find compact direct copies between three-dword x86 object fields.

Usage: python find_triplet_copies_x86.py <pe> <source-disp> <destination-disp>
"""

from __future__ import annotations

import sys
import traceback
from pathlib import Path

import pefile
from capstone import CS_ARCH_X86, CS_MODE_32, Cs


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    source = int(sys.argv[2], 0)
    destination = int(sys.argv[3], 0)
    data = path.read_bytes()
    pe = pefile.PE(str(path), fast_load=True)
    image_base = pe.OPTIONAL_HEADER.ImageBase
    disassembler = Cs(CS_ARCH_X86, CS_MODE_32)
    disassembler.skipdata = True
    found: set[int] = set()

    for section in pe.sections:
        if not section.IMAGE_SCN_MEM_EXECUTE:
            continue
        raw_start = section.PointerToRawData
        raw = data[raw_start:raw_start + section.SizeOfRawData]
        accesses: list[tuple[int, int, int, int, bool]] = []
        # offset, base register, value register, displacement, is_load
        for offset in range(len(raw) - 2):
            opcode = raw[offset]
            if opcode not in (0x8B, 0x89):
                continue
            modrm = raw[offset + 1]
            if modrm >> 6 != 1 or modrm & 7 == 4:
                continue
            displacement = raw[offset + 2]
            if displacement not in {
                source, source + 4, source + 8,
                destination, destination + 4, destination + 8,
            }:
                continue
            accesses.append((
                offset,
                modrm & 7,
                (modrm >> 3) & 7,
                displacement,
                opcode == 0x8B,
            ))

        for index, load in enumerate(accesses):
            load_offset, load_base, value_reg, load_disp, is_load = load
            if not is_load or load_disp not in {source, source + 4, source + 8}:
                continue
            mapping = {load_disp: None}
            end = load_offset + 80
            for other in accesses[index + 1:]:
                other_offset, other_base, other_reg, other_disp, other_is_load = other
                if other_offset > end:
                    break
                if (
                    not other_is_load
                    and other_base == load_base
                    and other_reg == value_reg
                    and other_disp == destination + (load_disp - source)
                ):
                    mapping[load_disp] = other_offset
                    break
            if mapping[load_disp] is None:
                continue

            window_end = mapping[load_disp] + 80
            pairs = 1
            for next_source in (source, source + 4, source + 8):
                if next_source == load_disp:
                    continue
                for candidate_index, candidate in enumerate(accesses):
                    candidate_offset, candidate_base, candidate_reg, candidate_disp, candidate_is_load = candidate
                    if not (load_offset <= candidate_offset <= window_end):
                        continue
                    if not candidate_is_load or candidate_base != load_base or candidate_disp != next_source:
                        continue
                    for store in accesses[candidate_index + 1:]:
                        store_offset, store_base, store_reg, store_disp, store_is_load = store
                        if store_offset > candidate_offset + 32:
                            break
                        if (
                            not store_is_load
                            and store_base == load_base
                            and store_reg == candidate_reg
                            and store_disp == destination + (next_source - source)
                        ):
                            pairs += 1
                            break
                    break
            if pairs < 3:
                continue

            start = max(0, load_offset - 24)
            key = section.VirtualAddress + start
            if key in found:
                continue
            found.add(key)
            code = raw[start:min(len(raw), window_end + 24)]
            virtual_address = image_base + section.VirtualAddress + start
            print(f"--- candidate 0x{virtual_address:08X} ---")
            for instruction in disassembler.disasm(code, virtual_address):
                byte_text = instruction.bytes.hex(" ").upper()
                print(
                    f"0x{instruction.address:08X}: {byte_text:<30} "
                    f"{instruction.mnemonic:<8} {instruction.op_str}"
                )

    return 0 if found else 3


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        traceback.print_exc(file=sys.stdout)
        raise
