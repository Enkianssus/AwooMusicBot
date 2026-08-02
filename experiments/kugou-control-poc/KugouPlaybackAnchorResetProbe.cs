using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace KugouControlPoc;

internal sealed record KugouPlaybackAnchorState(
    int SongItemId,
    int SubIndex,
    long QueueContext);

internal sealed record KugouPlaybackAnchorResetProbeResult(
    int ProcessId,
    string FileVersion,
    string Sha256,
    long ModuleBase,
    long PlayerController,
    long PlayerControllerVtable,
    long Setter,
    int SetterRva,
    bool MutationRequested,
    bool SetterCalled,
    bool AlreadyAligned,
    bool Applied,
    int? RequestedAnchorId,
    KugouPlaybackAnchorState AnchorBefore,
    KugouPlaybackAnchorState CurrentBefore,
    KugouPlaybackAnchorState AnchorAfter,
    KugouPlaybackAnchorState CurrentAfter);

/// <summary>
/// Version-locked experiment for the PlayerController playback-anchor token.
/// The read-only command validates the complete object/function chain. The
/// mutating command calls only the verified one-argument ID setter at C2CE01;
/// it does not invoke Previous, playback, pause, or volume methods.
/// </summary>
internal static class KugouPlaybackAnchorResetProbe
{
    private const string ExpectedFileVersion = "20.0.81.27563";
    private const string ExpectedSha256 =
        "193CEB92AC2281FCDC8A109BC533F3BC54FCCAFDA0CB1C0E61C0D140657F6132";
    private const int PlayerControllerVtableRva = 0x015CBF38;
    private const int NextRva = 0x00C27593;
    private const int PreviousRva = 0x00C2787E;
    private const int AnchorIdSetterRva = 0x00C2CE01;
    private const int AnchorIdSetterCallerRva = 0x0092CB28;
    private const int AnchorOffset = 0x38;
    private const int CurrentOffset = 0x44;

    private static readonly byte[] ExpectedAnchorIdSetter =
    [
        0x55, 0x8B, 0xEC,
        0x8B, 0x41, 0x40,
        0x8B, 0x51, 0x3C,
        0x89, 0x41, 0x40,
        0x8B, 0x45, 0x08,
        0x89, 0x51, 0x3C,
        0x89, 0x41, 0x38,
        0x5D, 0xC2, 0x04, 0x00
    ];
    private static readonly byte[] ExpectedNext =
    [
        0x6A, 0x08, 0xB8, 0xE5, 0xC7, 0x09, 0x11, 0xE8,
        0x99, 0xB1, 0x3F, 0x00, 0x8B, 0xF1, 0x8B, 0x4E,
        0x60, 0x6A, 0x02, 0xE8, 0x92, 0x8C, 0x00, 0x00
    ];
    private static readonly byte[] ExpectedPrevious =
    [
        0x6A, 0x08, 0xB8, 0xE5, 0xC7, 0x09, 0x11, 0xE8,
        0xAE, 0xAE, 0x3F, 0x00, 0x8B, 0xF1, 0x8B, 0x4E,
        0x60, 0x6A, 0x03, 0xE8, 0xA7, 0x89, 0x00, 0x00
    ];
    private static readonly byte[] ExpectedAnchorIdSetterCaller =
    [
        0x8B, 0x4E, 0x58, 0x8B, 0x01, 0xFF, 0x50, 0x48,
        0xFF, 0xB5, 0x80, 0xFA, 0xFF, 0xFF, 0x8B, 0xC8,
        0xE8, 0xC4, 0x02, 0x30, 0x00, 0x8D, 0x8D, 0x80,
        0xFA, 0xFF
    ];

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

    public static KugouPlaybackAnchorResetProbeResult Inspect() =>
        Run(
            mutate: false,
            expectedCurrentSongItemId: null,
            expectedAnchorSongItemId: null,
            requestedAnchorSongItemId: null);

    public static KugouPlaybackAnchorResetProbeResult ResetToCurrent(
        int expectedCurrentSongItemId) =>
        Run(
            mutate: true,
            expectedCurrentSongItemId,
            expectedAnchorSongItemId: null,
            requestedAnchorSongItemId: null);

    public static KugouPlaybackAnchorResetProbeResult SetForExperiment(
        int expectedAnchorSongItemId,
        int requestedAnchorSongItemId) =>
        Run(
            mutate: true,
            expectedCurrentSongItemId: null,
            expectedAnchorSongItemId,
            requestedAnchorSongItemId);

    private static KugouPlaybackAnchorResetProbeResult Run(
        bool mutate,
        int? expectedCurrentSongItemId,
        int? expectedAnchorSongItemId,
        int? requestedAnchorSongItemId)
    {
        if (IntPtr.Size != 4)
        {
            throw new PlatformNotSupportedException(
                "The KuGou playback-anchor probe must run as x86.");
        }

        var snapshot = KugouWindowObjectProbe.InspectPlaybackListeners();
        if (!string.Equals(
                snapshot.FileVersion,
                ExpectedFileVersion,
                StringComparison.Ordinal)
            || !string.Equals(
                snapshot.Sha256,
                ExpectedSha256,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Unsupported KuGou DLL: version={snapshot.FileVersion}, "
                + $"sha256={snapshot.Sha256}.");
        }

        using var target = Process.GetProcessById(snapshot.ProcessId);
        var startedAt = target.StartTime.ToFileTimeUtc();
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        if (module.BaseAddress.ToInt64() != snapshot.ModuleBase)
        {
            throw new InvalidOperationException(
                "KuGou module base changed during anchor validation.");
        }

        var access = ProcessVmRead | ProcessQueryInformation;
        if (mutate)
        {
            access |= ProcessCreateThread | ProcessVmOperation | ProcessVmWrite;
        }

        using var process = OpenProcess(access, false, target.Id);
        if (process.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        var moduleBase = module.BaseAddress;
        var playerController = (nint)snapshot.PlayerController;
        var expectedVtable = nint.Add(moduleBase, PlayerControllerVtableRva);
        var vtable = ReadPointer(process, playerController);
        if (vtable != expectedVtable)
        {
            throw new InvalidOperationException(
                $"Unexpected PlayerController vtable 0x{vtable:X}; "
                + $"expected 0x{expectedVtable:X}.");
        }

        VerifyPointer(
            process,
            nint.Add(vtable, 0x44),
            nint.Add(moduleBase, NextRva),
            "PlayerController.Next");
        VerifyPointer(
            process,
            nint.Add(vtable, 0x4C),
            nint.Add(moduleBase, PreviousRva),
            "PlayerController.Previous");
        VerifyBytes(
            process,
            nint.Add(moduleBase, NextRva),
            ExpectedNext,
            "PlayerController.Next");
        VerifyBytes(
            process,
            nint.Add(moduleBase, PreviousRva),
            ExpectedPrevious,
            "PlayerController.Previous");

        var setter = nint.Add(moduleBase, AnchorIdSetterRva);
        VerifyBytes(
            process,
            setter,
            ExpectedAnchorIdSetter,
            "PlayerController anchor-ID setter");
        VerifyBytes(
            process,
            nint.Add(moduleBase, AnchorIdSetterCallerRva),
            ExpectedAnchorIdSetterCaller,
            "Anchor-ID setter caller");

        var before = ReadStableStates(process, playerController);
        var anchorBefore = before.Anchor;
        var currentBefore = before.Current;
        ValidateStates(anchorBefore, currentBefore);
        if (mutate
            && expectedCurrentSongItemId != currentBefore.SongItemId)
        {
            if (expectedCurrentSongItemId.HasValue)
            {
                throw new InvalidOperationException(
                    $"Expected current KuGou item {expectedCurrentSongItemId}, "
                    + $"but the validated PlayerController token is {currentBefore.SongItemId}; refusing mutation.");
            }
        }

        if (mutate
            && expectedAnchorSongItemId.HasValue
            && expectedAnchorSongItemId != anchorBefore.SongItemId)
        {
            throw new InvalidOperationException(
                $"Expected anchor item {expectedAnchorSongItemId}, "
                + $"but found {anchorBefore.SongItemId}; refusing mutation.");
        }

        var targetAnchorId = requestedAnchorSongItemId
            ?? currentBefore.SongItemId;
        if (mutate && targetAnchorId <= 0)
        {
            throw new InvalidOperationException(
                $"Invalid requested KuGou anchor ID {targetAnchorId}.");
        }

        var setterCalled = false;
        var alreadyAligned = anchorBefore.SongItemId
            == targetAnchorId;
        if (mutate && !alreadyAligned)
        {
            // Re-read the entire state immediately before mutation so a user
            // track change cannot silently redirect the experiment.
            var immediate = ReadStableStates(process, playerController);
            if (immediate.Anchor != anchorBefore
                || immediate.Current != currentBefore
                || ReadPointer(process, playerController) != expectedVtable
                || target.StartTime.ToFileTimeUtc() != startedAt)
            {
                throw new InvalidOperationException(
                    "KuGou playback state changed during anchor validation; refusing to call the setter.");
            }

            CallAnchorIdSetter(
                process,
                setter,
                playerController,
                targetAnchorId);
            setterCalled = true;
        }

        var after = ReadStableStates(process, playerController);
        var anchorAfter = after.Anchor;
        var currentAfter = after.Current;
        if (ReadPointer(process, playerController) != expectedVtable
            || target.StartTime.ToFileTimeUtc() != startedAt)
        {
            throw new InvalidOperationException(
                "KuGou process identity changed while applying the anchor reset.");
        }
        var applied = mutate
            && anchorAfter.SongItemId == targetAnchorId
            && anchorAfter.SubIndex == anchorBefore.SubIndex
            && anchorAfter.QueueContext == anchorBefore.QueueContext
            && currentAfter == currentBefore;

        return new KugouPlaybackAnchorResetProbeResult(
            target.Id,
            snapshot.FileVersion,
            snapshot.Sha256,
            moduleBase.ToInt64(),
            playerController.ToInt64(),
            vtable.ToInt64(),
            setter.ToInt64(),
            AnchorIdSetterRva,
            mutate,
            setterCalled,
            alreadyAligned,
            applied,
            mutate ? targetAnchorId : null,
            anchorBefore,
            currentBefore,
            anchorAfter,
            currentAfter);
    }

    private static void ValidateStates(
        KugouPlaybackAnchorState anchor,
        KugouPlaybackAnchorState current)
    {
        if (anchor.SongItemId <= 0 || current.SongItemId <= 0)
        {
            throw new InvalidOperationException(
                $"Invalid KuGou anchor/current IDs: {anchor.SongItemId}/{current.SongItemId}.");
        }

        if (anchor.SubIndex != current.SubIndex
            || anchor.QueueContext != current.QueueContext
            || anchor.QueueContext is < 0x10000 or > int.MaxValue)
        {
            throw new InvalidOperationException(
                "KuGou anchor and current tokens do not share the same validated queue context.");
        }
    }

    private static KugouPlaybackAnchorState ReadState(
        SafeProcessHandle process,
        nint address)
    {
        var bytes = ReadBytes(process, address, 12);
        return new KugouPlaybackAnchorState(
            BitConverter.ToInt32(bytes, 0),
            BitConverter.ToInt32(bytes, 4),
            BitConverter.ToInt32(bytes, 8));
    }

    private static PlaybackStates ReadStableStates(
        SafeProcessHandle process,
        nint playerController)
    {
        PlaybackStates? previous = null;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var bytes = ReadBytes(
                process,
                nint.Add(playerController, AnchorOffset),
                CurrentOffset - AnchorOffset + 12);
            var current = new PlaybackStates(
                ReadState(bytes, 0),
                ReadState(bytes, CurrentOffset - AnchorOffset));
            if (current == previous)
            {
                return current;
            }

            previous = current;
        }

        throw new InvalidOperationException(
            "KuGou playback anchor/current tokens were not stable across consecutive reads.");
    }

    private static KugouPlaybackAnchorState ReadState(byte[] bytes, int offset) =>
        new(
            BitConverter.ToInt32(bytes, offset),
            BitConverter.ToInt32(bytes, offset + 4),
            BitConverter.ToInt32(bytes, offset + 8));

    private static void CallAnchorIdSetter(
        SafeProcessHandle process,
        nint setter,
        nint playerController,
        int songItemId)
    {
        var remoteBlock = VirtualAllocEx(
            process,
            0,
            0x1000,
            MemCommit | MemReserve,
            PageExecuteReadWrite);
        if (remoteBlock == 0)
        {
            throw CreateWin32Exception("VirtualAllocEx");
        }

        var safeToFree = true;
        try
        {
            WriteBytes(
                process,
                remoteBlock,
                BuildSetterStub(setter, playerController, songItemId));
            using var thread = CreateRemoteThread(
                process,
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

            var wait = WaitForSingleObject(thread, 3000);
            if (wait == WaitTimeout)
            {
                safeToFree = false;
                throw new TimeoutException(
                    "KuGou anchor-ID setter did not return within 3 seconds; the remote page was intentionally left allocated.");
            }

            if (wait != WaitObject0)
            {
                throw CreateWin32Exception("WaitForSingleObject");
            }
        }
        finally
        {
            if (safeToFree
                && !VirtualFreeEx(process, remoteBlock, 0, MemRelease))
            {
                throw CreateWin32Exception("VirtualFreeEx");
            }
        }
    }

    private static byte[] BuildSetterStub(
        nint setter,
        nint playerController,
        int songItemId)
    {
        var code = new List<byte>(24);
        code.Add(0x68); // push current song ID
        code.AddRange(BitConverter.GetBytes(songItemId));
        code.Add(0xB9); // mov ecx, PlayerController
        code.AddRange(BitConverter.GetBytes(checked((int)playerController)));
        code.Add(0xB8); // mov eax, verified setter
        code.AddRange(BitConverter.GetBytes(checked((int)setter)));
        code.AddRange([0xFF, 0xD0]); // call eax
        code.AddRange([0x33, 0xC0]); // xor eax,eax
        code.AddRange([0xC2, 0x04, 0x00]); // ret 4 (thread parameter)
        return code.ToArray();
    }

    private static void VerifyPointer(
        SafeProcessHandle process,
        nint address,
        nint expected,
        string label)
    {
        var actual = ReadPointer(process, address);
        if (actual != expected)
        {
            throw new InvalidOperationException(
                $"{label} pointer mismatch: 0x{actual:X} != 0x{expected:X}.");
        }
    }

    private static void VerifyBytes(
        SafeProcessHandle process,
        nint address,
        byte[] expected,
        string label)
    {
        var actual = ReadBytes(process, address, expected.Length);
        if (!actual.AsSpan().SequenceEqual(expected))
        {
            throw new InvalidOperationException(
                $"{label} machine-code mismatch at 0x{address:X}: "
                + $"{Convert.ToHexString(actual)}.");
        }
    }

    private static nint ReadPointer(SafeProcessHandle process, nint address) =>
        (nint)BitConverter.ToInt32(ReadBytes(process, address, 4), 0);

    private static byte[] ReadBytes(
        SafeProcessHandle process,
        nint address,
        int length)
    {
        var bytes = new byte[length];
        if (!ReadProcessMemory(
                process,
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
        SafeProcessHandle process,
        nint address,
        byte[] bytes)
    {
        if (!WriteProcessMemory(
                process,
                address,
                bytes,
                (nuint)bytes.Length,
                out var written)
            || written != (nuint)bytes.Length)
        {
            throw CreateWin32Exception("WriteProcessMemory");
        }
    }

    private static Win32Exception CreateWin32Exception(string operation)
    {
        var code = Marshal.GetLastWin32Error();
        return new Win32Exception(
            code,
            $"{operation} failed: {new Win32Exception(code).Message} (Win32={code})");
    }

    private sealed record PlaybackStates(
        KugouPlaybackAnchorState Anchor,
        KugouPlaybackAnchorState Current);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint VirtualAllocEx(
        SafeProcessHandle process,
        nint address,
        nuint size,
        uint allocationType,
        uint protection);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool VirtualFreeEx(
        SafeProcessHandle process,
        nint address,
        nuint size,
        uint freeType);

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
    private static extern bool ReadProcessMemory(
        SafeProcessHandle process,
        nint address,
        [Out] byte[] buffer,
        nuint size,
        out nuint bytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteProcessMemory(
        SafeProcessHandle process,
        nint address,
        byte[] buffer,
        nuint size,
        out nuint bytesWritten);
}
