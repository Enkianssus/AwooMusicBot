from __future__ import annotations

import argparse
import os
import sys

import pefile
from capstone import CS_ARCH_X86, CS_MODE_64, CS_OP_IMM, CS_OP_MEM, Cs
from capstone.x86 import X86_REG_RIP


def file_offset_to_va(pe: pefile.PE, file_offset: int) -> int:
    return pe.OPTIONAL_HEADER.ImageBase + pe.get_rva_from_offset(file_offset)


def find_string_addresses(pe: pefile.PE, data: bytes, text: str) -> list[int]:
    addresses: list[int] = []
    for needle in (text.encode("ascii"), text.encode("utf-16-le")):
        start = 0
        while True:
            offset = data.find(needle, start)
            if offset < 0:
                break
            addresses.append(file_offset_to_va(pe, offset))
            start = offset + 1
    return sorted(set(addresses))


def find_pointer_addresses(
    pe: pefile.PE,
    data: bytes,
    target: int,
) -> list[int]:
    image_base = pe.OPTIONAL_HEADER.ImageBase
    needles = [target.to_bytes(8, "little")]
    rva = target - image_base
    if 0 <= rva <= 0xFFFFFFFF:
        needles.append(rva.to_bytes(4, "little"))

    addresses: list[int] = []
    for needle in needles:
        start = 0
        while True:
            offset = data.find(needle, start)
            if offset < 0:
                break
            try:
                addresses.append(file_offset_to_va(pe, offset))
            except pefile.PEFormatError:
                pass
            start = offset + 1
    return sorted(set(addresses))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("binary")
    parser.add_argument("strings", nargs="+")
    parser.add_argument("--context", type=int, default=24)
    parser.add_argument("--near", type=lambda value: int(value, 0), default=0)
    parser.add_argument("--max-xrefs", type=int, default=100)
    args = parser.parse_args()

    binary_path = os.path.abspath(args.binary)
    with open(binary_path, "rb") as binary:
        data = binary.read()
    pe = pefile.PE(data=data, fast_load=False)
    if pe.FILE_HEADER.Machine != pefile.MACHINE_TYPE["IMAGE_FILE_MACHINE_AMD64"]:
        print(f"Unsupported machine: 0x{pe.FILE_HEADER.Machine:04X}")
        return 2

    text_section = next(
        section
        for section in pe.sections
        if section.Name.rstrip(b"\0") == b".text"
    )
    text_bytes = text_section.get_data()
    text_va = pe.OPTIONAL_HEADER.ImageBase + text_section.VirtualAddress

    disassembler = Cs(CS_ARCH_X86, CS_MODE_64)
    disassembler.detail = True
    instructions = list(disassembler.disasm(text_bytes, text_va))
    address_to_index = {
        instruction.address: index
        for index, instruction in enumerate(instructions)
    }

    for search_text in args.strings:
        targets = find_string_addresses(pe, data, search_text)
        print(f"\n=== {search_text!r} targets ===")
        for target in targets:
            target_rva = target - pe.OPTIONAL_HEADER.ImageBase
            section = pe.get_section_by_rva(target_rva)
            section_name = (
                section.Name.rstrip(b"\0").decode("ascii", errors="replace")
                if section is not None
                else "<none>"
            )
            print(f"string VA 0x{target:X} section={section_name}")
            candidate_targets = {target}
            frontier = {target}
            for depth in range(1, 4):
                pointer_addresses: set[int] = set()
                for pointer_target in frontier:
                    pointer_addresses.update(
                        find_pointer_addresses(pe, data, pointer_target)
                    )
                pointer_addresses -= candidate_targets
                if not pointer_addresses:
                    break
                print(
                    f"  pointer depth {depth}: "
                    + ", ".join(
                        f"0x{address:X}"
                        for address in sorted(pointer_addresses)[:32]
                    )
                )
                candidate_targets.update(pointer_addresses)
                frontier = pointer_addresses

            xrefs: list[tuple[int, int]] = []
            for instruction in instructions:
                for operand in instruction.operands:
                    if (
                        operand.type == CS_OP_IMM
                        and (
                            operand.imm in candidate_targets
                            or (
                                args.near > 0
                                and abs(operand.imm - target) <= args.near
                            )
                        )
                    ):
                        xrefs.append(
                            (instruction.address, operand.imm)
                        )
                        break
                    if (
                        operand.type == CS_OP_MEM
                        and operand.mem.base == X86_REG_RIP
                        and (
                            instruction.address
                            + instruction.size
                            + operand.mem.disp
                            in candidate_targets
                            or (
                                args.near > 0
                                and abs(
                                    instruction.address
                                    + instruction.size
                                    + operand.mem.disp
                                    - target
                                )
                                <= args.near
                            )
                        )
                    ):
                        resolved_target = (
                            instruction.address
                            + instruction.size
                            + operand.mem.disp
                        )
                        xrefs.append(
                            (instruction.address, resolved_target)
                        )
                        break

            if not xrefs:
                print("  no RIP-relative xrefs")
                continue

            for xref, resolved_target in xrefs[: args.max_xrefs]:
                print(
                    f"\n  xref 0x{xref:X} "
                    f"-> 0x{resolved_target:X}"
                )
                index = address_to_index[xref]
                first = max(0, index - args.context)
                last = min(len(instructions), index + args.context + 1)
                for instruction in instructions[first:last]:
                    marker = "=>" if instruction.address == xref else "  "
                    print(
                        f"{marker} {instruction.address:016X}  "
                        f"{instruction.mnemonic:<8} {instruction.op_str}"
                    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
