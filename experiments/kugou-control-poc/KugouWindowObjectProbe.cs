using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace KugouControlPoc;

internal sealed record KugouWindowObjectProbeResult(
    long WindowHandle,
    int ProcessId,
    string ClassName,
    string Title,
    long WindowProcedure,
    long UserData,
    IReadOnlyList<KugouWindowProperty> Properties);

internal sealed record KugouWindowProperty(
    string Name,
    long Value);

internal sealed record KugouPlaybackListenerProbeResult(
    int ProcessId,
    string FileVersion,
    string Sha256,
    long ModuleBase,
    long MainWindowObject,
    long PlayerController,
    long QueueEngine,
    long Holder,
    long Broadcaster,
    long ListenerBegin,
    long ListenerEnd,
    IReadOnlyList<KugouPlaybackListenerEntry> Listeners);

internal sealed record KugouPlaybackListenerEntry(
    int Index,
    long Listener,
    long Vtable,
    long PreviousFunction,
    int? PreviousRva,
    string PreviousBytes,
    long NextFunction,
    int? NextRva,
    string NextBytes,
    bool SameFunction);

internal sealed record KugouPlaybackModeListenerProbeResult(
    int ProcessId,
    string FileVersion,
    string Sha256,
    long ModuleBase,
    long PlayerController,
    long ListenerBegin,
    long ListenerEnd,
    IReadOnlyList<KugouPlaybackModeListenerEntry> Listeners);

internal sealed record KugouPlaybackModeListenerEntry(
    int Index,
    long Listener,
    long Vtable,
    long Callback,
    int? CallbackRva,
    string CallbackBytes);

internal sealed record KugouPlaybackDirectionCandidate(
    int Index,
    long Listener,
    long Vtable,
    int FieldOffset,
    long FieldAddress,
    int Value,
    int PreviousRva,
    int NextRva);

internal sealed record KugouPlaybackDirectionProbeResult(
    int ProcessId,
    string FileVersion,
    string Sha256,
    IReadOnlyList<KugouPlaybackDirectionCandidate> Candidates);

internal sealed record KugouPlaybackDirectionMutationResult(
    int ProcessId,
    string FileVersion,
    string Sha256,
    KugouPlaybackDirectionCandidate Candidate,
    int RequestedValue,
    int ValueAfter,
    bool Written);

/// <summary>
/// Read-only inspection of the native state Win32 associates with KuGou's
/// visible main window. Frameworks commonly keep their C++ window object in
/// GWLP_USERDATA or as a window property, which avoids patching a live handler
/// merely to capture its this pointer.
/// </summary>
internal static class KugouWindowObjectProbe
{
    private const int GwlWndProc = -4;
    private const int GwlpUserData = -21;
    private const string ExpectedFileVersion = "20.0.81.27563";
    private const string ExpectedSha256 =
        "193CEB92AC2281FCDC8A109BC533F3BC54FCCAFDA0CB1C0E61C0D140657F6132";
    private static readonly PlaybackDirectionSpec[] PlaybackDirectionSpecs =
    [
        new(
            41,
            0x24,
            0x006725D2,
            0x006725C8,
            "C7412401000000C20400",
            "C7412402000000C20400"),
        new(
            81,
            0x1C,
            0x0033FA71,
            0x0033FA67,
            "C7411C01000000C20400",
            "C7411C02000000C20400")
    ];

    public static IReadOnlyList<KugouWindowObjectProbeResult> Inspect()
    {
        return KugouNativeController.InspectWindows()
            .Where(window =>
                window.ParentHandle is null
                && window.ProcessId > 0
                && window.ClassName.Equals(
                    "kugou_ui",
                    StringComparison.OrdinalIgnoreCase))
            .Select(window => InspectWindow(window))
            .ToArray();
    }

    public static KugouWindowObjectProbeResult InspectIpcWindow()
    {
        var window = KugouNativeController.InspectIpcEndpoint()
            ?? throw new InvalidOperationException(
                "KuGou IPC endpoint was not found.");
        return InspectWindow(window);
    }

    public static KugouPlaybackListenerProbeResult InspectPlaybackListeners()
    {
        var mainWindow = KugouNativeController.InspectWindows()
            .Where(window =>
                window.ParentHandle is null
                && window.IsVisible
                && window.ClassName.Equals(
                    "kugou_ui",
                    StringComparison.OrdinalIgnoreCase)
                && window.Title.Contains(
                    "酷狗音乐",
                    StringComparison.OrdinalIgnoreCase))
            .Single();
        using var target = Process.GetProcessById(mainWindow.ProcessId);
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var modulePath = module.FileName;
        var version = FileVersionInfo.GetVersionInfo(modulePath).FileVersion
            ?? string.Empty;
        var sha256 = Convert.ToHexString(
            SHA256.HashData(File.ReadAllBytes(modulePath)));

        using var process = OpenProcess(
            ProcessVmRead | ProcessQueryInformation,
            false,
            target.Id);
        if (process.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        var mainObject = GetWindowLong(
            (nint)mainWindow.Handle,
            GwlpUserData);
        var playerController = ReadPointer(
            process,
            nint.Add(mainObject, 0x28A8));
        var queueEngine = ReadPointer(
            process,
            nint.Add(playerController, 0x20));
        var holder = ReadPointer(
            process,
            nint.Add(queueEngine, 0x0C));
        var holderTarget = ReadPointer(process, holder);
        var broadcaster = ReadPointer(
            process,
            nint.Add(holderTarget, 0xF4));
        var listenerBegin = ReadPointer(
            process,
            nint.Add(broadcaster, 0x2C));
        var listenerEnd = ReadPointer(
            process,
            nint.Add(broadcaster, 0x30));
        var listenerBytes = listenerEnd.ToInt64() - listenerBegin.ToInt64();
        if (listenerBytes is < 0 or > 64 * 1024
            || listenerBytes % 4 != 0)
        {
            throw new InvalidOperationException(
                $"Invalid KuGou playback listener range: "
                + $"0x{listenerBegin:X}-0x{listenerEnd:X}.");
        }

        var moduleBase = module.BaseAddress;
        var listeners = new List<KugouPlaybackListenerEntry>();
        var count = checked((int)(listenerBytes / 4));
        for (var index = 0; index < count; index++)
        {
            var listener = ReadPointer(
                process,
                nint.Add(listenerBegin, index * 4));
            var vtable = ReadPointer(process, listener);
            var previous = ReadPointer(process, nint.Add(vtable, 0x60));
            var next = ReadPointer(process, nint.Add(vtable, 0x64));
            listeners.Add(new KugouPlaybackListenerEntry(
                index,
                listener.ToInt64(),
                vtable.ToInt64(),
                previous.ToInt64(),
                GetRva(moduleBase, previous),
                ReadCodeBytes(process, previous),
                next.ToInt64(),
                GetRva(moduleBase, next),
                ReadCodeBytes(process, next),
                previous == next));
        }

        return new KugouPlaybackListenerProbeResult(
            target.Id,
            version,
            sha256,
            moduleBase.ToInt64(),
            mainObject.ToInt64(),
            playerController.ToInt64(),
            queueEngine.ToInt64(),
            holder.ToInt64(),
            broadcaster.ToInt64(),
            listenerBegin.ToInt64(),
            listenerEnd.ToInt64(),
            listeners);
    }

    public static KugouPlaybackDirectionProbeResult
        InspectPlaybackDirectionCandidates()
    {
        var snapshot = InspectPlaybackListeners();
        VerifySupportedVersion(snapshot);
        using var target = Process.GetProcessById(snapshot.ProcessId);
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        VerifyModuleBase(snapshot, module);

        using var process = OpenProcess(
            ProcessVmRead | ProcessQueryInformation,
            false,
            target.Id);
        if (process.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        return new KugouPlaybackDirectionProbeResult(
            snapshot.ProcessId,
            snapshot.FileVersion,
            snapshot.Sha256,
            PlaybackDirectionSpecs
                .Select(spec => ReadDirectionCandidate(
                    process,
                    snapshot,
                    spec))
                .ToArray());
    }

    public static KugouPlaybackModeListenerProbeResult
        InspectPlaybackModeListeners()
    {
        var snapshot = InspectPlaybackListeners();
        VerifySupportedVersion(snapshot);
        using var target = Process.GetProcessById(snapshot.ProcessId);
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        VerifyModuleBase(snapshot, module);

        using var process = OpenProcess(
            ProcessVmRead | ProcessQueryInformation,
            false,
            target.Id);
        if (process.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        var playerController = (nint)snapshot.PlayerController;
        var listenerBegin = ReadPointer(
            process,
            nint.Add(playerController, 0x08));
        var listenerEnd = ReadPointer(
            process,
            nint.Add(playerController, 0x0C));
        var listenerBytes = listenerEnd.ToInt64() - listenerBegin.ToInt64();
        if (listenerBytes is < 0 or > 4 * 1024
            || listenerBytes % 4 != 0)
        {
            throw new InvalidOperationException(
                $"Invalid KuGou playback-mode listener range: "
                + $"0x{listenerBegin:X}-0x{listenerEnd:X}.");
        }

        var listeners = new List<KugouPlaybackModeListenerEntry>();
        var count = checked((int)(listenerBytes / 4));
        for (var index = 0; index < count; index++)
        {
            var listener = ReadPointer(
                process,
                nint.Add(listenerBegin, index * 4));
            var vtable = ReadPointer(process, listener);
            var callback = ReadPointer(process, vtable);
            listeners.Add(new KugouPlaybackModeListenerEntry(
                index,
                listener.ToInt64(),
                vtable.ToInt64(),
                callback.ToInt64(),
                GetRva(module.BaseAddress, callback),
                ReadCodeBytes(process, callback)));
        }

        return new KugouPlaybackModeListenerProbeResult(
            snapshot.ProcessId,
            snapshot.FileVersion,
            snapshot.Sha256,
            snapshot.ModuleBase,
            snapshot.PlayerController,
            listenerBegin.ToInt64(),
            listenerEnd.ToInt64(),
            listeners);
    }

    public static KugouPlaybackDirectionMutationResult SetPlaybackDirection(
        int listenerIndex,
        int value)
    {
        if (value is < 0 or > 2)
        {
            throw new ArgumentOutOfRangeException(
                nameof(value),
                "KuGou playback direction must be 0 (neutral), 1 (previous), or 2 (next).");
        }

        var spec = PlaybackDirectionSpecs.SingleOrDefault(candidate =>
            candidate.Index == listenerIndex)
            ?? throw new ArgumentOutOfRangeException(
                nameof(listenerIndex),
                "Only validated KuGou playback listeners 41 and 81 are supported.");
        var snapshot = InspectPlaybackListeners();
        VerifySupportedVersion(snapshot);
        using var target = Process.GetProcessById(snapshot.ProcessId);
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        VerifyModuleBase(snapshot, module);

        using var process = OpenProcess(
            ProcessVmOperation
                | ProcessVmRead
                | ProcessVmWrite
                | ProcessQueryInformation,
            false,
            target.Id);
        if (process.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        var before = ReadDirectionCandidate(process, snapshot, spec);
        if (before.Value is < 0 or > 2)
        {
            throw new InvalidOperationException(
                $"Unexpected KuGou direction value {before.Value} at "
                + $"listener {before.Index} field 0x{before.FieldOffset:X}.");
        }

        WriteBytes(
            process,
            (nint)before.FieldAddress,
            BitConverter.GetBytes(value));
        var after = BitConverter.ToInt32(
            ReadBytes(process, (nint)before.FieldAddress, 4),
            0);
        return new KugouPlaybackDirectionMutationResult(
            snapshot.ProcessId,
            snapshot.FileVersion,
            snapshot.Sha256,
            before,
            value,
            after,
            after == value);
    }

    private static KugouWindowObjectProbeResult InspectWindow(
        WindowInfo window)
    {
        var properties = new List<KugouWindowProperty>();
        _ = EnumPropsEx(
            (nint)window.Handle,
            (handle, name, data, parameter) =>
            {
                _ = handle;
                _ = parameter;
                properties.Add(new KugouWindowProperty(
                    ReadPropertyName(name),
                    data.ToInt64()));
                return 1;
            },
            nint.Zero);

        return new KugouWindowObjectProbeResult(
            window.Handle,
            window.ProcessId,
            window.ClassName,
            window.Title,
            GetWindowLong((nint)window.Handle, GwlWndProc).ToInt64(),
            GetWindowLong((nint)window.Handle, GwlpUserData).ToInt64(),
            properties);
    }

    private static string ReadPropertyName(nint name)
    {
        var raw = unchecked((nuint)name.ToInt64());
        return raw <= ushort.MaxValue
            ? $"ATOM:{raw}"
            : Marshal.PtrToStringUni(name) ?? string.Empty;
    }

    private static int? GetRva(nint moduleBase, nint address)
    {
        var value = address.ToInt64() - moduleBase.ToInt64();
        return value is >= 0 and <= int.MaxValue ? (int)value : null;
    }

    private static KugouPlaybackDirectionCandidate ReadDirectionCandidate(
        SafeProcessHandle process,
        KugouPlaybackListenerProbeResult snapshot,
        PlaybackDirectionSpec spec)
    {
        var listener = snapshot.Listeners.Single(candidate =>
            candidate.Index == spec.Index);
        if (listener.PreviousRva != spec.PreviousRva
            || listener.NextRva != spec.NextRva
            || !listener.PreviousBytes.StartsWith(
                spec.PreviousPrefix,
                StringComparison.OrdinalIgnoreCase)
            || !listener.NextBytes.StartsWith(
                spec.NextPrefix,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"KuGou listener {spec.Index} callback validation failed.");
        }

        var listenerAddress = (nint)listener.Listener;
        var vtable = ReadPointer(process, listenerAddress);
        var previous = ReadPointer(process, nint.Add(vtable, 0x60));
        var next = ReadPointer(process, nint.Add(vtable, 0x64));
        if (vtable.ToInt64() != listener.Vtable
            || previous.ToInt64() != listener.PreviousFunction
            || next.ToInt64() != listener.NextFunction)
        {
            throw new InvalidOperationException(
                $"KuGou listener {spec.Index} changed after the snapshot.");
        }

        var fieldAddress = nint.Add(listenerAddress, spec.FieldOffset);
        var value = BitConverter.ToInt32(
            ReadBytes(process, fieldAddress, 4),
            0);
        return new KugouPlaybackDirectionCandidate(
            spec.Index,
            listener.Listener,
            listener.Vtable,
            spec.FieldOffset,
            fieldAddress.ToInt64(),
            value,
            spec.PreviousRva,
            spec.NextRva);
    }

    private static void VerifySupportedVersion(
        KugouPlaybackListenerProbeResult snapshot)
    {
        if (!snapshot.FileVersion.Equals(
                ExpectedFileVersion,
                StringComparison.Ordinal)
            || !snapshot.Sha256.Equals(
                ExpectedSha256,
                StringComparison.OrdinalIgnoreCase)
            || snapshot.Listeners.Count is < 82 or > 128)
        {
            throw new InvalidOperationException(
                $"Unsupported KuGou DLL/listener layout: "
                + $"version={snapshot.FileVersion}, "
                + $"sha256={snapshot.Sha256}, "
                + $"listeners={snapshot.Listeners.Count}.");
        }
    }

    private static void VerifyModuleBase(
        KugouPlaybackListenerProbeResult snapshot,
        ProcessModule module)
    {
        if (module.BaseAddress.ToInt64() != snapshot.ModuleBase)
        {
            throw new InvalidOperationException(
                "KuGou restarted while the direction fields were inspected.");
        }
    }

    private static string ReadCodeBytes(
        SafeProcessHandle process,
        nint address)
    {
        try
        {
            return Convert.ToHexString(ReadBytes(process, address, 24));
        }
        catch (Win32Exception)
        {
            return string.Empty;
        }
    }

    private static nint ReadPointer(
        SafeProcessHandle process,
        nint address) =>
        (nint)BitConverter.ToInt32(ReadBytes(process, address, 4), 0);

    private static byte[] ReadBytes(
        SafeProcessHandle process,
        nint address,
        int length)
    {
        var buffer = new byte[length];
        if (!ReadProcessMemory(
                process,
                address,
                buffer,
                (nuint)buffer.Length,
                out var read)
            || read != (nuint)buffer.Length)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        return buffer;
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
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    private sealed record PlaybackDirectionSpec(
        int Index,
        int FieldOffset,
        int PreviousRva,
        int NextRva,
        string PreviousPrefix,
        string NextPrefix);

    private delegate int EnumPropsExProc(
        nint window,
        nint propertyName,
        nint data,
        nint parameter);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern nint GetWindowLong(nint window, int index);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int EnumPropsEx(
        nint window,
        EnumPropsExProc callback,
        nint parameter);

    private const uint ProcessVmRead = 0x0010;
    private const uint ProcessVmWrite = 0x0020;
    private const uint ProcessVmOperation = 0x0008;
    private const uint ProcessQueryInformation = 0x0400;

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
        [Out] byte[] buffer,
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
}
