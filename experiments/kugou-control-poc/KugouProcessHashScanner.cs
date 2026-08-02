using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace KugouControlPoc;

internal sealed record KugouHashMemoryMatch(
    string Kind,
    long Address,
    string ContextHex,
    int? Int32Minus48,
    int? Int32Minus16,
    int? Int32Minus12,
    int? Int32Minus8,
    int? Int32Minus4,
    int? Int32Plus4,
    int? Int32Plus8,
    int? Int32Plus12,
    int? Int32Plus16,
    int? Int32Plus20);

internal sealed record KugouHashMemoryScanResult(
    int ProcessId,
    string Hash,
    IReadOnlyList<KugouHashMemoryMatch> Matches);

internal sealed record KugouSongItemMemoryCandidate(
    int SongItemId,
    IReadOnlyList<long> HashAddresses,
    int MatchCount);

internal static class KugouProcessHashScanner
{
    private const uint ProcessVmRead = 0x0010;
    private const uint ProcessQueryInformation = 0x0400;
    private const uint MemCommit = 0x1000;
    private const uint PageNoAccess = 0x01;
    private const uint PageGuard = 0x100;
    private const int MaximumMatches = 2000;

    public static KugouHashMemoryScanResult Scan(string hash)
    {
        hash = hash.Trim().ToUpperInvariant();
        if (hash.Length != 32)
        {
            throw new ArgumentException(
                "酷狗歌曲 hash 必须是 32 位十六进制字符串。",
                nameof(hash));
        }

        var direct = Convert.FromHexString(hash);
        var reversedWords = direct
            .Chunk(4)
            .SelectMany(chunk => chunk.Reverse())
            .ToArray();
        var patterns = new Dictionary<string, byte[]>
        {
            ["AsciiUpper"] = Encoding.ASCII.GetBytes(hash),
            ["AsciiLower"] = Encoding.ASCII.GetBytes(hash.ToLowerInvariant()),
            ["Utf16Upper"] = Encoding.Unicode.GetBytes(hash),
            ["RawDirect"] = direct,
            ["RawReverseAll"] = direct.Reverse().ToArray(),
            ["RawReverseDwords"] = reversedWords
        };

        return ScanPatterns(hash, patterns);
    }

    public static IReadOnlyList<KugouSongItemMemoryCandidate>
        FindSongItemCandidates(string hash, long expectedDurationMilliseconds)
    {
        hash = hash.Trim().ToUpperInvariant();
        if (hash.Length != 32)
        {
            throw new ArgumentException(
                "KuGou hash must contain exactly 32 hexadecimal characters.",
                nameof(hash));
        }

        var scan = ScanPatterns(
            hash,
            new Dictionary<string, byte[]>
            {
                ["RawDirect"] = Convert.FromHexString(hash)
            });
        return scan.Matches
            .Where(match =>
                match.Kind == "RawDirect"
                && match.Int32Minus48 is > 0 and < 10_000_000
                && match.Int32Minus8 == 2_834_445
                && match.Int32Plus16 == 100
                && DurationMatches(
                    match.Int32Plus20,
                    expectedDurationMilliseconds))
            .GroupBy(match => match.Int32Minus48!.Value)
            .Select(group => new KugouSongItemMemoryCandidate(
                group.Key,
                group.Select(match => match.Address)
                    .Distinct()
                    .Order()
                    .ToArray(),
                group.Select(match => match.Address).Distinct().Count()))
            .OrderByDescending(candidate => candidate.MatchCount)
            .ThenByDescending(candidate => candidate.SongItemId)
            .ToArray();
    }

    private static bool DurationMatches(
        int? observedDuration,
        long expectedDurationMilliseconds)
    {
        if (observedDuration is null || observedDuration <= 0)
        {
            return false;
        }

        if (expectedDurationMilliseconds <= 0)
        {
            return observedDuration < 24 * 60 * 60 * 1000;
        }

        return Math.Abs(observedDuration.Value - expectedDurationMilliseconds)
            <= 2_000;
    }

    public static KugouHashMemoryScanResult ScanPointer(long address)
    {
        if (address is <= 0 or > int.MaxValue)
        {
            throw new ArgumentOutOfRangeException(
                nameof(address),
                "x86 酷狗进程指针必须位于正的 32 位地址空间。");
        }

        var patterns = new Dictionary<string, byte[]>
        {
            ["Pointer"] = BitConverter.GetBytes(checked((int)address))
        };
        return ScanPatterns($"0x{address:X8}", patterns);
    }

    public static IReadOnlyList<int> ReadDwords(long address, int count)
    {
        if (address is <= 0 or > int.MaxValue)
        {
            throw new ArgumentOutOfRangeException(nameof(address));
        }

        if (count is <= 0 or > 4096)
        {
            throw new ArgumentOutOfRangeException(nameof(count));
        }

        using var target = FindTarget();
        using var process = OpenProcess(
            ProcessVmRead | ProcessQueryInformation,
            false,
            target.Id);
        if (process.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        var buffer = new byte[checked(count * 4)];
        if (!ReadProcessMemory(
                process,
                (nint)address,
                buffer,
                (nuint)buffer.Length,
                out var read)
            || read != (nuint)buffer.Length)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        return Enumerable.Range(0, count)
            .Select(index => BitConverter.ToInt32(buffer, index * 4))
            .ToArray();
    }

    public static IReadOnlyList<long> FindDwordAddresses(int value) =>
        ScanPatterns(
                value.ToString(),
                new Dictionary<string, byte[]>
                {
                    ["Dword"] = BitConverter.GetBytes(value)
                })
            .Matches
            .Select(match => match.Address)
            .Distinct()
            .Order()
            .ToArray();

    public static IReadOnlyDictionary<long, int?> ReadDwordValues(
        IEnumerable<long> addresses)
    {
        using var target = FindTarget();
        using var process = OpenProcess(
            ProcessVmRead | ProcessQueryInformation,
            false,
            target.Id);
        if (process.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        var result = new Dictionary<long, int?>();
        foreach (var address in addresses.Distinct())
        {
            var buffer = new byte[4];
            result[address] = ReadProcessMemory(
                    process,
                    (nint)address,
                    buffer,
                    4,
                    out var read)
                && read == 4
                    ? BitConverter.ToInt32(buffer, 0)
                    : null;
        }

        return result;
    }

    public static IReadOnlyDictionary<long, int> CaptureDwordsNear(
        IEnumerable<long> seedAddresses,
        int radius)
    {
        if (radius is <= 0 or > 8 * 1024 * 1024)
        {
            throw new ArgumentOutOfRangeException(nameof(radius));
        }

        using var target = FindTarget();
        using var process = OpenProcess(
            ProcessVmRead | ProcessQueryInformation,
            false,
            target.Id);
        if (process.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        var values = new Dictionary<long, int>();
        foreach (var seed in seedAddresses
                     .Where(address => address is > 0x10000 and < 0x7FFF0000)
                     .Distinct())
        {
            var start = Math.Max(0x10000, seed - radius);
            var end = Math.Min(0x7FFF0000, seed + radius);
            var cursor = start;
            while (cursor < end)
            {
                var queried = VirtualQueryEx(
                    process,
                    (nint)cursor,
                    out var information,
                    (nuint)Marshal.SizeOf<MemoryBasicInformation>());
                if (queried == 0 || information.RegionSize == 0)
                {
                    break;
                }

                var regionStart = information.BaseAddress.ToInt64();
                var regionEnd = regionStart + checked((long)information.RegionSize);
                var readStart = Math.Max(cursor, regionStart);
                var readEnd = Math.Min(end, regionEnd);
                if (information.State == MemCommit
                    && (information.Protect & (PageNoAccess | PageGuard)) == 0)
                {
                    CaptureRange(
                        process,
                        readStart,
                        readEnd,
                        values);
                }

                if (regionEnd <= cursor)
                {
                    break;
                }

                cursor = regionEnd;
            }
        }

        return values;
    }

    private static void CaptureRange(
        SafeProcessHandle process,
        long start,
        long end,
        IDictionary<long, int> values)
    {
        const int chunkSize = 64 * 1024;
        var alignedStart = (start + 3) & ~3L;
        for (var address = alignedStart; address + 4 <= end; address += chunkSize)
        {
            var length = checked((int)Math.Min(chunkSize, end - address));
            length &= ~3;
            if (length <= 0)
            {
                continue;
            }

            var buffer = new byte[length];
            if (!ReadProcessMemory(
                    process,
                    (nint)address,
                    buffer,
                    (nuint)buffer.Length,
                    out var read)
                || read < 4)
            {
                continue;
            }

            var actual = checked((int)read) & ~3;
            for (var offset = 0; offset < actual; offset += 4)
            {
                values[address + offset] = BitConverter.ToInt32(buffer, offset);
            }
        }
    }

    private static KugouHashMemoryScanResult ScanPatterns(
        string identity,
        IReadOnlyDictionary<string, byte[]> patterns)
    {
        using var target = FindTarget();
        using var process = OpenProcess(
            ProcessVmRead | ProcessQueryInformation,
            false,
            target.Id);
        if (process.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        var matches = new List<KugouHashMemoryMatch>();
        long address = 0x10000;
        while (address < 0x7FFF0000 && matches.Count < MaximumMatches)
        {
            var queried = VirtualQueryEx(
                process,
                (nint)address,
                out var information,
                (nuint)Marshal.SizeOf<MemoryBasicInformation>());
            if (queried == 0 || information.RegionSize == 0)
            {
                break;
            }

            var regionBase = information.BaseAddress.ToInt64();
            var regionSize = checked((long)information.RegionSize);
            var nextAddress = regionBase + regionSize;
            if (information.State == MemCommit
                && (information.Protect & (PageNoAccess | PageGuard)) == 0)
            {
                ScanRegion(
                    process,
                    regionBase,
                    regionSize,
                    patterns,
                    matches);
            }

            if (nextAddress <= address)
            {
                break;
            }

            address = nextAddress;
        }

        return new KugouHashMemoryScanResult(target.Id, identity, matches);
    }

    private static void ScanRegion(
        SafeProcessHandle process,
        long regionBase,
        long regionSize,
        IReadOnlyDictionary<string, byte[]> patterns,
        ICollection<KugouHashMemoryMatch> matches)
    {
        const int chunkSize = 1024 * 1024;
        const int overlap = 80;
        for (long offset = 0;
             offset < regionSize && matches.Count < MaximumMatches;
             offset += chunkSize - overlap)
        {
            var length = checked((int)Math.Min(chunkSize, regionSize - offset));
            var buffer = new byte[length];
            if (!ReadProcessMemory(
                    process,
                    (nint)(regionBase + offset),
                    buffer,
                    (nuint)buffer.Length,
                    out var read)
                || read == 0)
            {
                continue;
            }

            var actual = checked((int)read);
            foreach (var (kind, pattern) in patterns)
            {
                var searchAt = 0;
                while (searchAt <= actual - pattern.Length
                       && matches.Count < MaximumMatches)
                {
                    var index = buffer.AsSpan(searchAt, actual - searchAt)
                        .IndexOf(pattern);
                    if (index < 0)
                    {
                        break;
                    }

                    index += searchAt;
                    var contextStart = Math.Max(0, index - 256);
                    var contextLength = Math.Min(
                        actual - contextStart,
                        pattern.Length + 512);
                    matches.Add(new KugouHashMemoryMatch(
                        kind,
                        regionBase + offset + index,
                        Convert.ToHexString(
                            buffer,
                            contextStart,
                            contextLength),
                        ReadInt32(buffer, actual, index - 48),
                        ReadInt32(buffer, actual, index - 16),
                        ReadInt32(buffer, actual, index - 12),
                        ReadInt32(buffer, actual, index - 8),
                        ReadInt32(buffer, actual, index - 4),
                        ReadInt32(buffer, actual, index + 4),
                        ReadInt32(buffer, actual, index + 8),
                        ReadInt32(buffer, actual, index + 12),
                        ReadInt32(buffer, actual, index + 16),
                        ReadInt32(buffer, actual, index + 20)));
                    searchAt = index + 1;
                }
            }
        }
    }

    private static int? ReadInt32(
        byte[] buffer,
        int actualLength,
        int offset)
    {
        return offset >= 0 && offset + 4 <= actualLength
            ? BitConverter.ToInt32(buffer, offset)
            : null;
    }

    private static Process FindTarget()
    {
        foreach (var process in Process.GetProcessesByName("KuGou")
                     .OrderByDescending(item => item.MainWindowHandle != 0))
        {
            try
            {
                if (process.Modules.Cast<ProcessModule>().Any(module =>
                        module.ModuleName.Equals(
                            "kugou.dll",
                            StringComparison.OrdinalIgnoreCase)))
                {
                    return process;
                }
            }
            catch (Exception exception)
                when (exception is Win32Exception
                    or InvalidOperationException)
            {
                // Try the next KuGou helper process.
            }

            process.Dispose();
        }

        throw new InvalidOperationException(
            "没有找到已加载 kugou.dll 的酷狗主进程。");
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryBasicInformation
    {
        public nint BaseAddress;
        public nint AllocationBase;
        public uint AllocationProtect;
        public nuint RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nuint VirtualQueryEx(
        SafeProcessHandle process,
        nint address,
        out MemoryBasicInformation information,
        nuint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadProcessMemory(
        SafeProcessHandle process,
        nint baseAddress,
        [Out] byte[] buffer,
        nuint size,
        out nuint bytesRead);
}
