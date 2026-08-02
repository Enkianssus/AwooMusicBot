using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace KugouControlPoc;

internal sealed record KugouAnchorHistoryResetResult(
    int ProcessId,
    string FileVersion,
    string Sha256,
    long ModuleBase,
    long Controller,
    long AnchorTracker,
    long ResetFunction,
    long HistoryBeginBefore,
    long HistoryEndBefore,
    long HistoryCapacityBefore,
    int HistoryCountBefore,
    long HistoryBeginAfter,
    long HistoryEndAfter,
    long HistoryCapacityAfter,
    int HistoryCountAfter,
    uint RemoteExitCode,
    bool ResetToCurrentAnchor,
    bool TrackUnchanged,
    KugouPlaybackState Before,
    KugouPlaybackState After);

/// <summary>
/// Experimental, exact-build-only invocation of the anchor tracker's native
/// history reset. This is intentionally separate from the production KuGou
/// connector until two clean queue-order tests pass.
/// </summary>
internal static class KugouAnchorHistoryResetProbe
{
    private const string ExpectedFileVersion = "20.0.81.27563";
    private const string ExpectedSha256 =
        "193CEB92AC2281FCDC8A109BC533F3BC54FCCAFDA0CB1C0E61C0D140657F6132";
    private const int QueueControllerVtableRva = 0x01548AFC;
    private const int AnchorTrackerVtableRva = 0x01546414;
    private const int AnchorTrackerSecondVtableRva = 0x0154643C;
    private const int AnchorTrackerThirdVtableRva = 0x01546444;
    private const int ResetAnchorHistoryRva = 0x00905251;

    private const uint ProcessCreateThread = 0x0002;
    private const uint ProcessVmOperation = 0x0008;
    private const uint ProcessVmRead = 0x0010;
    private const uint ProcessVmWrite = 0x0020;
    private const uint ProcessQueryInformation = 0x0400;
    private const uint MemCommit = 0x1000;
    private const uint MemReserve = 0x2000;
    private const uint MemRelease = 0x8000;
    private const uint PageExecuteReadWrite = 0x40;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 0x102;

    public static KugouAnchorHistoryResetResult Reset()
    {
        if (IntPtr.Size != 4)
        {
            throw new PlatformNotSupportedException(
                "The KuGou anchor-history reset probe must run as x86.");
        }

        var resolved = KugouQueueNativeProbe.InspectController();
        using var target = Process.GetProcessById(resolved.ProcessId);
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var modulePath = module.FileName;
        var fileVersion = FileVersionInfo.GetVersionInfo(modulePath).FileVersion
            ?? string.Empty;
        var sha256 = Convert.ToHexString(
            SHA256.HashData(File.ReadAllBytes(modulePath)));
        if (!string.Equals(fileVersion, ExpectedFileVersion, StringComparison.Ordinal)
            || !string.Equals(sha256, ExpectedSha256, StringComparison.OrdinalIgnoreCase)
            || module.BaseAddress.ToInt64() != resolved.ModuleBase)
        {
            throw new InvalidOperationException(
                $"KuGou changed while preparing the anchor-history reset: version={fileVersion}, sha256={sha256}, moduleBase=0x{module.BaseAddress:X}.");
        }

        using var processHandle = OpenProcess(
            ProcessCreateThread
                | ProcessVmOperation
                | ProcessVmRead
                | ProcessVmWrite
                | ProcessQueryInformation,
            false,
            target.Id);
        if (processHandle.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        var moduleBase = module.BaseAddress;
        var controller = (nint)resolved.Controller;
        VerifyPointer(
            processHandle,
            controller,
            nint.Add(moduleBase, QueueControllerVtableRva),
            "QueueController vtable");

        var tracker = ReadPointer(
            processHandle,
            nint.Add(controller, 0x60));
        if (tracker == 0)
        {
            throw new InvalidOperationException(
                "QueueController+0x60 did not contain an anchor tracker.");
        }

        VerifyPointer(
            processHandle,
            tracker,
            nint.Add(moduleBase, AnchorTrackerVtableRva),
            "AnchorTracker primary vtable");
        VerifyPointer(
            processHandle,
            nint.Add(tracker, 4),
            nint.Add(moduleBase, AnchorTrackerSecondVtableRva),
            "AnchorTracker secondary vtable");
        VerifyPointer(
            processHandle,
            nint.Add(tracker, 8),
            nint.Add(moduleBase, AnchorTrackerThirdVtableRva),
            "AnchorTracker tertiary vtable");

        var resetFunction = nint.Add(moduleBase, ResetAnchorHistoryRva);
        VerifyBytes(
            processHandle,
            resetFunction,
            Convert.FromHexString(
                "6A1CB861590A11E8DBD471008BF18D7E10578D4DE8E8C4FF7BFF"),
            "AnchorTracker reset function");

        var beforeVector = ReadAndValidateVector(processHandle, tracker);
        var before = KugouNativeController.ReadPlaybackState();
        var stub = BuildResetStub(tracker, resetFunction);
        var remoteBlock = VirtualAllocEx(
            processHandle,
            0,
            (nuint)stub.Length,
            MemCommit | MemReserve,
            PageExecuteReadWrite);
        if (remoteBlock == 0)
        {
            throw CreateWin32Exception("VirtualAllocEx");
        }

        uint exitCode;
        try
        {
            WriteBytes(processHandle, remoteBlock, stub);
            if (!ReadBytes(processHandle, remoteBlock, stub.Length)
                    .SequenceEqual(stub))
            {
                throw new InvalidOperationException(
                    "The anchor-history reset stub failed verification.");
            }

            if (!FlushInstructionCache(
                    processHandle,
                    remoteBlock,
                    (nuint)stub.Length))
            {
                throw CreateWin32Exception("FlushInstructionCache");
            }

            using var thread = CreateRemoteThread(
                processHandle,
                0,
                0,
                remoteBlock,
                0,
                0,
                out _);
            if (thread.IsInvalid)
            {
                throw CreateWin32Exception("CreateRemoteThread");
            }

            var waitResult = WaitForSingleObject(thread, 3000);
            if (waitResult == WaitTimeout)
            {
                throw new TimeoutException(
                    "The anchor-history reset did not return within three seconds.");
            }

            if (waitResult != WaitObject0)
            {
                throw CreateWin32Exception("WaitForSingleObject");
            }

            if (!GetExitCodeThread(thread, out exitCode))
            {
                throw CreateWin32Exception("GetExitCodeThread");
            }
        }
        finally
        {
            if (!VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease))
            {
                throw CreateWin32Exception("VirtualFreeEx");
            }
        }

        var afterVector = ReadAndValidateVector(processHandle, tracker);
        var after = KugouNativeController.ReadPlaybackState();
        var trackUnchanged = string.Equals(
                before.RawTitle,
                after.RawTitle,
                StringComparison.Ordinal)
            && before.SongItem == after.SongItem
            && before.SongList == after.SongList
            && before.SongTable == after.SongTable;

        return new KugouAnchorHistoryResetResult(
            target.Id,
            fileVersion,
            sha256,
            moduleBase.ToInt64(),
            controller.ToInt64(),
            tracker.ToInt64(),
            resetFunction.ToInt64(),
            beforeVector.Begin.ToInt64(),
            beforeVector.End.ToInt64(),
            beforeVector.Capacity.ToInt64(),
            beforeVector.Count,
            afterVector.Begin.ToInt64(),
            afterVector.End.ToInt64(),
            afterVector.Capacity.ToInt64(),
            afterVector.Count,
            exitCode,
            afterVector.End == afterVector.Begin,
            trackUnchanged,
            before,
            after);
    }

    private static byte[] BuildResetStub(nint tracker, nint resetFunction)
    {
        var code = new List<byte>(32)
        {
            0x55, 0x8B, 0xEC,
            0x53, 0x56, 0x57,
            0xB9
        };
        code.AddRange(BitConverter.GetBytes(tracker.ToInt32()));
        code.Add(0xB8);
        code.AddRange(BitConverter.GetBytes(resetFunction.ToInt32()));
        code.AddRange([
            0xFF, 0xD0,
            0xB8, 0x01, 0x00, 0x00, 0x00,
            0x5F, 0x5E, 0x5B, 0x5D,
            0xC2, 0x04, 0x00
        ]);
        return code.ToArray();
    }

    private static AnchorVector ReadAndValidateVector(
        SafeProcessHandle processHandle,
        nint tracker)
    {
        var begin = ReadPointer(processHandle, nint.Add(tracker, 0x10));
        var end = ReadPointer(processHandle, nint.Add(tracker, 0x14));
        var capacity = ReadPointer(processHandle, nint.Add(tracker, 0x18));
        var allNull = begin == 0 && end == 0 && capacity == 0;
        if (!allNull
            && (begin == 0
                || begin > end
                || end > capacity
                || (begin.ToInt64() & 3) != 0
                || (end.ToInt64() & 3) != 0
                || (capacity.ToInt64() & 3) != 0))
        {
            throw new InvalidOperationException(
                $"Invalid anchor-history vector: begin=0x{begin:X}, end=0x{end:X}, capacity=0x{capacity:X}.");
        }

        var count = allNull
            ? 0
            : checked((end - begin).ToInt32() / 4);
        return new AnchorVector(begin, end, capacity, count);
    }

    private static void VerifyPointer(
        SafeProcessHandle processHandle,
        nint address,
        nint expected,
        string label)
    {
        var actual = ReadPointer(processHandle, address);
        if (actual != expected)
        {
            throw new InvalidOperationException(
                $"Unexpected {label}: expected=0x{expected:X}, actual=0x{actual:X}.");
        }
    }

    private static void VerifyBytes(
        SafeProcessHandle processHandle,
        nint address,
        byte[] expected,
        string label)
    {
        var actual = ReadBytes(processHandle, address, expected.Length);
        if (!actual.SequenceEqual(expected))
        {
            throw new InvalidOperationException(
                $"Unexpected {label} bytes at 0x{address:X}: {Convert.ToHexString(actual)}.");
        }
    }

    private static nint ReadPointer(
        SafeProcessHandle processHandle,
        nint address) =>
        (nint)BitConverter.ToUInt32(ReadBytes(processHandle, address, 4));

    private static byte[] ReadBytes(
        SafeProcessHandle processHandle,
        nint address,
        int count)
    {
        var bytes = new byte[count];
        if (!ReadProcessMemory(
                processHandle,
                address,
                bytes,
                (nuint)bytes.Length,
                out var read)
            || read != (nuint)bytes.Length)
        {
            throw CreateWin32Exception("ReadProcessMemory");
        }

        return bytes;
    }

    private static void WriteBytes(
        SafeProcessHandle processHandle,
        nint address,
        byte[] bytes)
    {
        if (!WriteProcessMemory(
                processHandle,
                address,
                bytes,
                (nuint)bytes.Length,
                out var written)
            || written != (nuint)bytes.Length)
        {
            throw CreateWin32Exception("WriteProcessMemory");
        }
    }

    private static Win32Exception CreateWin32Exception(string operation) =>
        new(Marshal.GetLastWin32Error(), $"{operation} failed");

    private sealed record AnchorVector(
        nint Begin,
        nint End,
        nint Capacity,
        int Count);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadProcessMemory(
        SafeProcessHandle process,
        nint baseAddress,
        byte[] buffer,
        nuint size,
        out nuint bytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteProcessMemory(
        SafeProcessHandle process,
        nint baseAddress,
        byte[] buffer,
        nuint size,
        out nuint bytesWritten);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint VirtualAllocEx(
        SafeProcessHandle process,
        nint address,
        nuint size,
        uint allocationType,
        uint protect);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool VirtualFreeEx(
        SafeProcessHandle process,
        nint address,
        nuint size,
        uint freeType);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlushInstructionCache(
        SafeProcessHandle process,
        nint baseAddress,
        nuint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeWaitHandle CreateRemoteThread(
        SafeProcessHandle process,
        nint threadAttributes,
        nuint stackSize,
        nint startAddress,
        nint parameter,
        uint creationFlags,
        out uint threadId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(
        SafeWaitHandle handle,
        uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeThread(
        SafeWaitHandle thread,
        out uint exitCode);
}
