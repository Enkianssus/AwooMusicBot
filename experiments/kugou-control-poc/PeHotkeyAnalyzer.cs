using System.Buffers.Binary;

namespace KugouControlPoc;

internal sealed record ImportCallSite(
    string ImportName,
    uint ImportAddressTableRva,
    uint ImportAddress,
    uint CallVirtualAddress,
    int FileOffset,
    string ContextHex);

internal static class PeHotkeyAnalyzer
{
    public static IReadOnlyList<ImportCallSite> FindRegisterHotKeyCalls(string path)
    {
        var bytes = File.ReadAllBytes(path);
        var peOffset = ReadInt32(bytes, 0x3c);
        if (ReadUInt32(bytes, peOffset) != 0x00004550)
        {
            throw new InvalidDataException("不是有效的 PE 文件");
        }

        var numberOfSections = ReadUInt16(bytes, peOffset + 6);
        var optionalHeaderSize = ReadUInt16(bytes, peOffset + 20);
        var optionalHeaderOffset = peOffset + 24;
        var magic = ReadUInt16(bytes, optionalHeaderOffset);
        if (magic != 0x10b)
        {
            throw new NotSupportedException("当前分析器只支持 32 位 PE32");
        }

        var imageBase = ReadUInt32(bytes, optionalHeaderOffset + 28);
        var importDirectoryRva = ReadUInt32(bytes, optionalHeaderOffset + 104);
        var sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
        var sections = new List<PeSection>();
        for (var index = 0; index < numberOfSections; index++)
        {
            var offset = sectionTableOffset + index * 40;
            sections.Add(new PeSection(
                ReadAscii(bytes, offset, 8).TrimEnd('\0'),
                ReadUInt32(bytes, offset + 8),
                ReadUInt32(bytes, offset + 12),
                ReadUInt32(bytes, offset + 16),
                ReadUInt32(bytes, offset + 20)));
        }

        var importOffset = RvaToOffset(importDirectoryRva, sections);
        uint? targetIatRva = null;
        for (var descriptorOffset = importOffset;
             ReadUInt32(bytes, descriptorOffset) != 0
             || ReadUInt32(bytes, descriptorOffset + 12) != 0;
             descriptorOffset += 20)
        {
            var originalFirstThunk = ReadUInt32(bytes, descriptorOffset);
            var firstThunk = ReadUInt32(bytes, descriptorOffset + 16);
            var thunkRva = originalFirstThunk == 0 ? firstThunk : originalFirstThunk;
            var thunkOffset = RvaToOffset(thunkRva, sections);
            for (var index = 0; ; index++)
            {
                var thunk = ReadUInt32(bytes, thunkOffset + index * 4);
                if (thunk == 0)
                {
                    break;
                }

                if ((thunk & 0x80000000) != 0)
                {
                    continue;
                }

                var nameOffset = RvaToOffset(thunk, sections) + 2;
                var name = ReadNullTerminatedAscii(bytes, nameOffset);
                if (string.Equals(name, "RegisterHotKey", StringComparison.Ordinal))
                {
                    targetIatRva = firstThunk + (uint)(index * 4);
                    break;
                }
            }

            if (targetIatRva is not null)
            {
                break;
            }
        }

        if (targetIatRva is null)
        {
            return [];
        }

        var targetAddress = imageBase + targetIatRva.Value;
        Span<byte> pattern = stackalloc byte[6];
        pattern[0] = 0xff;
        pattern[1] = 0x15;
        BinaryPrimitives.WriteUInt32LittleEndian(pattern[2..], targetAddress);

        var text = sections.FirstOrDefault(section =>
            string.Equals(section.Name, ".text", StringComparison.Ordinal));
        if (text is null)
        {
            throw new InvalidDataException("PE 文件没有 .text 节");
        }

        var results = new List<ImportCallSite>();
        var textStart = checked((int)text.RawDataPointer);
        var textEnd = checked(textStart + (int)text.RawDataSize);
        for (var offset = textStart; offset <= textEnd - pattern.Length; offset++)
        {
            if (!bytes.AsSpan(offset, pattern.Length).SequenceEqual(pattern))
            {
                continue;
            }

            var contextStart = Math.Max(textStart, offset - 64);
            var contextEnd = Math.Min(textEnd, offset + 24);
            var context = Convert.ToHexString(bytes, contextStart, contextEnd - contextStart);
            var callRva = text.VirtualAddress + (uint)(offset - textStart);
            results.Add(new ImportCallSite(
                "RegisterHotKey",
                targetIatRva.Value,
                targetAddress,
                imageBase + callRva,
                offset,
                context));
        }

        return results;
    }

    private static int RvaToOffset(uint rva, IEnumerable<PeSection> sections)
    {
        foreach (var section in sections)
        {
            var length = Math.Max(section.VirtualSize, section.RawDataSize);
            if (rva >= section.VirtualAddress && rva < section.VirtualAddress + length)
            {
                return checked((int)(section.RawDataPointer + rva - section.VirtualAddress));
            }
        }

        throw new InvalidDataException($"无法把 RVA 0x{rva:X8} 映射到文件偏移");
    }

    private static ushort ReadUInt16(byte[] bytes, int offset)
    {
        return BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(offset, 2));
    }

    private static uint ReadUInt32(byte[] bytes, int offset)
    {
        return BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(offset, 4));
    }

    private static int ReadInt32(byte[] bytes, int offset)
    {
        return BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(offset, 4));
    }

    private static string ReadAscii(byte[] bytes, int offset, int length)
    {
        return System.Text.Encoding.ASCII.GetString(bytes, offset, length);
    }

    private static string ReadNullTerminatedAscii(byte[] bytes, int offset)
    {
        var end = offset;
        while (end < bytes.Length && bytes[end] != 0)
        {
            end++;
        }

        return ReadAscii(bytes, offset, end - offset);
    }

    private sealed record PeSection(
        string Name,
        uint VirtualSize,
        uint VirtualAddress,
        uint RawDataSize,
        uint RawDataPointer);
}
