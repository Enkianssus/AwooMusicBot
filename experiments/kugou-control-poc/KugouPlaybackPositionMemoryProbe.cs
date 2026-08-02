using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace KugouControlPoc;

internal sealed record KugouPlaybackPositionCandidate(
    long Address,
    int InitialValue,
    int NextValue,
    int RestoredValue,
    IReadOnlyList<int> NearbyDwords);

internal sealed record KugouPlaybackPositionProbeResult(
    int ProcessId,
    KugouPlaybackState Before,
    KugouPlaybackState AfterNext,
    KugouPlaybackState AfterRestore,
    int InitialCandidateCount,
    int AfterNextCandidateCount,
    int AfterRestoreCandidateCount,
    BackgroundControlResult NextControl,
    BackgroundControlResult RestoreControl,
    IReadOnlyList<KugouPlaybackPositionCandidate> Candidates);

/// <summary>
/// Cheat-Engine-style read-only value filtering around one controlled
/// next/previous round trip. The only mutation is the temporary track change,
/// which is restored before returning.
/// </summary>
internal static class KugouPlaybackPositionMemoryProbe
{
    private const uint ProcessVmRead = 0x0010;
    private const uint ProcessQueryInformation = 0x0400;
    private const uint MemCommit = 0x1000;
    private const uint PageNoAccess = 0x01;
    private const uint PageReadWrite = 0x04;
    private const uint PageWriteCopy = 0x08;
    private const uint PageExecuteReadWrite = 0x40;
    private const uint PageExecuteWriteCopy = 0x80;
    private const uint PageGuard = 0x100;

    public static KugouPlaybackPositionProbeResult Run()
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

        var before = KugouNativeController.ReadPlaybackState();
        var initial = ScanInitialCandidates(process);
        var next = KugouNativeController.SendDirectKugouCommand(
            KugouAppCommand.NextTrack,
            TimeSpan.FromSeconds(6));
        var afterNext = KugouNativeController.ReadPlaybackState();
        BackgroundControlResult? restore = null;
        Dictionary<long, int> afterNextCandidates = [];
        try
        {
            if (!next.Sent || !next.TrackChanged)
            {
                throw new InvalidOperationException(
                    "酷狗没有完成临时下一首，无法进行位置内存筛选。");
            }

            Thread.Sleep(150);
            afterNextCandidates = FilterCandidates(
                process,
                initial,
                address => initial[address] + 1);
        }
        finally
        {
            if (next.Sent && next.TrackChanged)
            {
                restore = KugouNativeController.SendDirectKugouCommand(
                    KugouAppCommand.PreviousTrack,
                    TimeSpan.FromSeconds(6));
            }
        }

        var restoreResult = restore
            ?? throw new InvalidOperationException("没有执行返回上一首。");
        Thread.Sleep(150);
        var afterRestore = KugouNativeController.ReadPlaybackState();
        var restoredCandidates = FilterCandidates(
            process,
            afterNextCandidates,
            addressValue => initial[addressValue]);

        var candidates = restoredCandidates
            .OrderBy(pair => pair.Key)
            .Take(200)
            .Select(pair => new KugouPlaybackPositionCandidate(
                pair.Key,
                initial[pair.Key],
                afterNextCandidates[pair.Key],
                pair.Value,
                ReadNearbyDwords(process, pair.Key)))
            .ToArray();

        return new KugouPlaybackPositionProbeResult(
            target.Id,
            before,
            afterNext,
            afterRestore,
            initial.Count,
            afterNextCandidates.Count,
            restoredCandidates.Count,
            next,
            restoreResult,
            candidates);
    }

    private static Dictionary<long, int> ScanInitialCandidates(
        SafeProcessHandle process)
    {
        var candidates = new Dictionary<long, int>();
        long address = 0x10000;
        while (address < 0x7FFF0000)
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
            if (information.State == MemCommit && IsWritable(information.Protect))
            {
                ScanInitialRegion(
                    process,
                    regionBase,
                    regionSize,
                    candidates);
            }

            if (nextAddress <= address)
            {
                break;
            }

            address = nextAddress;
        }

        return candidates;
    }

    private static void ScanInitialRegion(
        SafeProcessHandle process,
        long regionBase,
        long regionSize,
        IDictionary<long, int> candidates)
    {
        const int chunkSize = 1024 * 1024;
        for (long offset = 0; offset < regionSize; offset += chunkSize)
        {
            var length = checked((int)Math.Min(chunkSize, regionSize - offset));
            var buffer = new byte[length];
            if (!ReadProcessMemory(
                    process,
                    (nint)(regionBase + offset),
                    buffer,
                    (nuint)buffer.Length,
                    out var read)
                || read < 4)
            {
                continue;
            }

            var actual = checked((int)read);
            for (var index = 0; index <= actual - 4; index += 4)
            {
                var value = BitConverter.ToInt32(buffer, index);
                if (value is 3 or 4)
                {
                    candidates[regionBase + offset + index] = value;
                }
            }
        }
    }

    private static Dictionary<long, int> FilterCandidates(
        SafeProcessHandle process,
        IReadOnlyDictionary<long, int> candidates,
        Func<long, int> expectedValue)
    {
        var result = new Dictionary<long, int>();
        foreach (var page in candidates.Keys.GroupBy(address => address & ~0xFFFL))
        {
            var buffer = new byte[0x1000];
            if (!ReadProcessMemory(
                    process,
                    (nint)page.Key,
                    buffer,
                    (nuint)buffer.Length,
                    out var read)
                || read < 4)
            {
                continue;
            }

            var actual = checked((int)read);
            foreach (var address in page)
            {
                var offset = checked((int)(address - page.Key));
                if (offset < 0 || offset + 4 > actual)
                {
                    continue;
                }

                var value = BitConverter.ToInt32(buffer, offset);
                if (value == expectedValue(address))
                {
                    result[address] = value;
                }
            }
        }

        return result;
    }

    private static IReadOnlyList<int> ReadNearbyDwords(
        SafeProcessHandle process,
        long address)
    {
        var buffer = new byte[36];
        if (!ReadProcessMemory(
                process,
                (nint)(address - 16),
                buffer,
                (nuint)buffer.Length,
                out var read)
            || read != (nuint)buffer.Length)
        {
            return [];
        }

        return Enumerable.Range(0, 9)
            .Select(index => BitConverter.ToInt32(buffer, index * 4))
            .ToArray();
    }

    private static bool IsWritable(uint protection)
    {
        if ((protection & (PageNoAccess | PageGuard)) != 0)
        {
            return false;
        }

        return (protection & 0xFF) is PageReadWrite
            or PageWriteCopy
            or PageExecuteReadWrite
            or PageExecuteWriteCopy;
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
                when (exception is Win32Exception or InvalidOperationException)
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
