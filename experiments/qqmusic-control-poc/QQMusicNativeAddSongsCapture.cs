using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace QQMusicControlPoc;

internal sealed record QQMusicNativeAddSongsCaptureResult(
    bool Attached,
    bool BreakpointArmed,
    bool Captured,
    bool OriginalCodeRestored,
    int ProcessId,
    string ModuleBase,
    string FunctionAddress,
    string ReturnAddress,
    string ReturnRva,
    uint ModeArgument,
    string Ecx,
    string Edx,
    string Esp,
    IReadOnlyList<string> StackWords,
    string EcxMemory,
    string EdxMemory,
    string SongVectorMemory,
    int SongVectorLength,
    QQMusicPlaybackState Before,
    QQMusicPlaybackState After,
    long ElapsedMilliseconds,
    string? Error);

internal static class QQMusicNativeAddSongsCapture
{
    private const byte ExpectedFirstInstruction = 0x55;
    private const byte BreakpointInstruction = 0xCC;
    private const uint ProcessVmOperation = 0x0008;
    private const uint ProcessVmRead = 0x0010;
    private const uint ProcessVmWrite = 0x0020;
    private const uint ProcessQueryInformation = 0x0400;
    private const uint ThreadGetContext = 0x0008;
    private const uint ThreadSetContext = 0x0010;
    private const uint PageExecuteReadWrite = 0x40;
    private const uint ExceptionBreakpoint = 0x80000003;
    private const uint DebugContinue = 0x00010002;
    private const uint DebugExceptionNotHandled = 0x80010001;
    private const uint ContextI386 = 0x00010000;
    private const uint ContextFull = ContextI386 | 0x00000007;

    public static Task<QQMusicNativeAddSongsCaptureResult> CaptureAsync(
        TimeSpan? timeout = null)
    {
        return Task.Run(() => Capture(
            timeout ?? TimeSpan.FromSeconds(90)));
    }

    private static QQMusicNativeAddSongsCaptureResult Capture(
        TimeSpan timeout)
    {
        if (timeout < TimeSpan.FromSeconds(5)
            || timeout > TimeSpan.FromMinutes(3))
        {
            throw new ArgumentOutOfRangeException(
                nameof(timeout),
                "捕捉等待时间必须在 5 秒到 3 分钟之间。");
        }

        var stopwatch = Stopwatch.StartNew();
        var before = QQMusicNativeController.ReadPlaybackState();
        var after = before;
        var attached = false;
        var breakpointArmed = false;
        var captured = false;
        var originalCodeRestored = false;
        var processId = 0;
        var moduleBase = 0u;
        var functionAddress = 0u;
        var returnAddress = 0u;
        var modeArgument = 0u;
        var ecx = 0u;
        var edx = 0u;
        var esp = 0u;
        var stackWords = new List<string>();
        var ecxMemory = string.Empty;
        var edxMemory = string.Empty;
        var songVectorMemory = string.Empty;
        var songVectorLength = 0;
        string? error = null;
        Process? process = null;
        SafeProcessHandle? processHandle = null;
        var debugEventPending = false;
        DebugEvent pendingEvent = default;

        try
        {
            if (!before.IsRunning
                || string.IsNullOrWhiteSpace(before.Title))
            {
                throw new InvalidOperationException(
                    "没有读取到正在播放的 QQ 音乐歌曲。");
            }

            var analysis = QQMusicNativeNextAnalyzer.AnalyzeCurrent();
            var profile = analysis.Profile;
            if (!analysis.ExecutionAllowed || profile is null)
            {
                throw new InvalidOperationException(
                    "当前 QQ 音乐没有通过完整画像校验："
                    + analysis.Summary);
            }

            (process, moduleBase) = FindLoadedClientCore(
                analysis.ClientModulePath,
                analysis.FileVersion);
            processId = process.Id;
            functionAddress = checked(
                moduleBase + (uint)profile.AddSongsRva);
            processHandle = OpenProcess(
                ProcessVmOperation
                    | ProcessVmRead
                    | ProcessVmWrite
                    | ProcessQueryInformation,
                false,
                processId);
            if (processHandle.IsInvalid)
            {
                throw CreateWin32Exception("OpenProcess");
            }

            var originalByte = ReadBytes(
                processHandle,
                functionAddress,
                1)[0];
            if (originalByte != ExpectedFirstInstruction)
            {
                throw new InvalidOperationException(
                    "AddSongs 入口原始指令不匹配，拒绝设置断点："
                    + $"实际=0x{originalByte:X2}，"
                    + $"预期=0x{ExpectedFirstInstruction:X2}");
            }

            if (!DebugActiveProcess((uint)processId))
            {
                throw CreateWin32Exception("DebugActiveProcess");
            }

            attached = true;
            if (!DebugSetProcessKillOnExit(false))
            {
                throw CreateWin32Exception(
                    "DebugSetProcessKillOnExit");
            }

            WriteCodeByte(
                processHandle,
                functionAddress,
                BreakpointInstruction);
            breakpointArmed = true;
            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                var debugEvent = default(DebugEvent);
                if (!WaitForDebugEvent(ref debugEvent, 250))
                {
                    var waitError = Marshal.GetLastWin32Error();
                    if (waitError == 121)
                    {
                        continue;
                    }

                    throw CreateWin32Exception(
                        "WaitForDebugEvent",
                        waitError);
                }

                pendingEvent = debugEvent;
                debugEventPending = true;
                var continueStatus = DebugContinue;
                if (debugEvent.DebugEventCode
                        == DebugEventCode.Exception)
                {
                    var exception = debugEvent.Data.Exception;
                    var exceptionAddress = unchecked(
                        (uint)exception.ExceptionRecord
                            .ExceptionAddress.ToInt64());
                    if (exception.ExceptionRecord.ExceptionCode
                            == ExceptionBreakpoint
                        && exceptionAddress == functionAddress)
                    {
                        using var thread = OpenThread(
                            ThreadGetContext | ThreadSetContext,
                            false,
                            debugEvent.ThreadId);
                        if (thread.IsInvalid)
                        {
                            throw CreateWin32Exception(
                                "OpenThread");
                        }

                        var context = CreateContext();
                        if (!GetThreadContext(
                                thread,
                                ref context))
                        {
                            throw CreateWin32Exception(
                                "GetThreadContext");
                        }

                        ecx = context.Ecx;
                        edx = context.Edx;
                        esp = context.Esp;
                        var stackBytes = ReadBytes(
                            processHandle,
                            esp,
                            64);
                        for (var offset = 0;
                             offset < stackBytes.Length;
                             offset += sizeof(uint))
                        {
                            stackWords.Add(
                                $"0x{BitConverter.ToUInt32(
                                    stackBytes,
                                    offset):X8}");
                        }

                        returnAddress = BitConverter.ToUInt32(
                            stackBytes,
                            0);
                        modeArgument = BitConverter.ToUInt32(
                            stackBytes,
                            sizeof(uint));
                        ecxMemory = TryReadHex(
                            processHandle,
                            ecx,
                            128);
                        edxMemory = TryReadHex(
                            processHandle,
                            edx,
                            32);
                        CaptureSongVector(
                            processHandle,
                            edx,
                            out songVectorMemory,
                            out songVectorLength);

                        WriteCodeByte(
                            processHandle,
                            functionAddress,
                            ExpectedFirstInstruction);
                        originalCodeRestored = true;
                        breakpointArmed = false;
                        context.Eip = functionAddress;
                        if (!SetThreadContext(
                                thread,
                                ref context))
                        {
                            throw CreateWin32Exception(
                                "SetThreadContext");
                        }

                        captured = true;
                    }
                    else if (exception.ExceptionRecord
                                 .ExceptionCode
                             != ExceptionBreakpoint)
                    {
                        continueStatus =
                            DebugExceptionNotHandled;
                    }
                }

                if (!ContinueDebugEvent(
                        debugEvent.ProcessId,
                        debugEvent.ThreadId,
                        continueStatus))
                {
                    throw CreateWin32Exception(
                        "ContinueDebugEvent");
                }

                debugEventPending = false;
                if (captured)
                {
                    break;
                }
            }

            if (!captured)
            {
                throw new TimeoutException(
                    "等待期间没有捕捉到 AddSongs 调用。");
            }
        }
        catch (Exception exception)
        {
            error = $"{exception.GetType().Name}: "
                + exception.Message;
        }
        finally
        {
            if (debugEventPending)
            {
                _ = ContinueDebugEvent(
                    pendingEvent.ProcessId,
                    pendingEvent.ThreadId,
                    DebugExceptionNotHandled);
            }

            if (breakpointArmed
                && processHandle is not null
                && !processHandle.IsInvalid
                && functionAddress != 0)
            {
                try
                {
                    WriteCodeByte(
                        processHandle,
                        functionAddress,
                        ExpectedFirstInstruction);
                    originalCodeRestored = true;
                }
                catch (Exception restoreException)
                {
                    AppendError(
                        ref error,
                        "恢复断点原指令失败："
                        + restoreException.Message);
                }
            }

            if (attached
                && !DebugActiveProcessStop(
                    (uint)processId))
            {
                AppendError(
                    ref error,
                    CreateWin32Exception(
                        "DebugActiveProcessStop").Message);
            }

            processHandle?.Dispose();
            process?.Dispose();
        }

        after = QQMusicNativeController.ReadPlaybackState();
        stopwatch.Stop();
        return new QQMusicNativeAddSongsCaptureResult(
            attached,
            captured || breakpointArmed,
            captured,
            originalCodeRestored,
            processId,
            $"0x{moduleBase:X8}",
            $"0x{functionAddress:X8}",
            $"0x{returnAddress:X8}",
            IsInsideModule(returnAddress, moduleBase)
                ? $"0x{returnAddress - moduleBase:X8}"
                : "outside QQMusic.dll",
            modeArgument,
            $"0x{ecx:X8}",
            $"0x{edx:X8}",
            $"0x{esp:X8}",
            stackWords,
            ecxMemory,
            edxMemory,
            songVectorMemory,
            songVectorLength,
            before,
            after,
            stopwatch.ElapsedMilliseconds,
            error);
    }

    private static (Process Process, uint ModuleBase)
        FindLoadedClientCore(
            string expectedModulePath,
            string expectedFileVersion)
    {
        var matches = new List<(Process Process, uint Base, long Memory)>();
        foreach (var process in Process.GetProcessesByName("QQMusic"))
        {
            var retained = false;
            try
            {
                foreach (ProcessModule module in process.Modules)
                {
                    if (!PathEquals(
                            module.FileName,
                            expectedModulePath))
                    {
                        continue;
                    }

                    var version = FileVersionInfo
                        .GetVersionInfo(module.FileName)
                        .FileVersion;
                    if (!string.Equals(
                            version,
                            expectedFileVersion,
                            StringComparison.Ordinal))
                    {
                        continue;
                    }

                    matches.Add((
                        process,
                        unchecked(
                            (uint)module.BaseAddress.ToInt64()),
                        process.WorkingSet64));
                    retained = true;
                    break;
                }
            }
            catch (Exception exception)
                when (exception is Win32Exception
                    or InvalidOperationException)
            {
                // Ignore stale helper processes.
            }
            finally
            {
                if (!retained)
                {
                    process.Dispose();
                }
            }
        }

        if (matches.Count == 0)
        {
            throw new InvalidOperationException(
                $"没有找到已加载 QQMusic.dll {expectedFileVersion} 的客户端进程。");
        }

        var selected = matches
            .OrderByDescending(match => match.Memory)
            .First();
        foreach (var match in matches)
        {
            if (!ReferenceEquals(
                    match.Process,
                    selected.Process))
            {
                match.Process.Dispose();
            }
        }

        return (selected.Process, selected.Base);
    }

    private static Context32 CreateContext()
    {
        return new Context32
        {
            ContextFlags = ContextFull,
            FloatSave = new FloatingSaveArea
            {
                RegisterArea = new byte[80]
            },
            ExtendedRegisters = new byte[512]
        };
    }

    private static void CaptureSongVector(
        SafeProcessHandle process,
        uint vectorAddress,
        out string memory,
        out int length)
    {
        memory = string.Empty;
        length = 0;
        if (vectorAddress == 0)
        {
            return;
        }

        try
        {
            var header = ReadBytes(process, vectorAddress, 8);
            var start = BitConverter.ToUInt32(header, 0);
            var end = BitConverter.ToUInt32(header, 4);
            if (start == 0 || end <= start)
            {
                return;
            }

            var rawLength = checked((int)(end - start));
            length = rawLength;
            memory = FormatBytes(ReadBytes(
                process,
                start,
                Math.Min(rawLength, 1024)));
        }
        catch (Exception exception)
            when (exception is Win32Exception
                or OverflowException)
        {
            memory = $"unreadable: {exception.Message}";
        }
    }

    private static string TryReadHex(
        SafeProcessHandle process,
        uint address,
        int length)
    {
        if (address == 0)
        {
            return string.Empty;
        }

        try
        {
            return FormatBytes(
                ReadBytes(process, address, length));
        }
        catch (Win32Exception exception)
        {
            return $"unreadable: {exception.Message}";
        }
    }

    private static byte[] ReadBytes(
        SafeProcessHandle process,
        uint address,
        int length)
    {
        var buffer = new byte[length];
        if (!ReadProcessMemory(
                process,
                (nint)address,
                buffer,
                (nuint)buffer.Length,
                out var read)
            || read != (nuint)buffer.Length)
        {
            throw CreateWin32Exception("ReadProcessMemory");
        }

        return buffer;
    }

    private static void WriteCodeByte(
        SafeProcessHandle process,
        uint address,
        byte value)
    {
        if (!VirtualProtectEx(
                process,
                (nint)address,
                1,
                PageExecuteReadWrite,
                out var oldProtection))
        {
            throw CreateWin32Exception("VirtualProtectEx");
        }

        try
        {
            var buffer = new[] { value };
            if (!WriteProcessMemory(
                    process,
                    (nint)address,
                    buffer,
                    1,
                    out var written)
                || written != 1)
            {
                throw CreateWin32Exception(
                    "WriteProcessMemory");
            }

            if (!FlushInstructionCache(
                    process,
                    (nint)address,
                    1))
            {
                throw CreateWin32Exception(
                    "FlushInstructionCache");
            }
        }
        finally
        {
            _ = VirtualProtectEx(
                process,
                (nint)address,
                1,
                oldProtection,
                out _);
        }
    }

    private static bool IsInsideModule(
        uint address,
        uint moduleBase)
    {
        return address >= moduleBase
            && address < moduleBase + 0x01000000;
    }

    private static string FormatBytes(
        IEnumerable<byte> bytes)
    {
        return string.Join(
            ' ',
            bytes.Select(value => value.ToString("X2")));
    }

    private static bool PathEquals(
        string left,
        string right)
    {
        return string.Equals(
            Path.GetFullPath(left).TrimEnd('\\'),
            Path.GetFullPath(right).TrimEnd('\\'),
            StringComparison.OrdinalIgnoreCase);
    }

    private static void AppendError(
        ref string? current,
        string message)
    {
        current = string.IsNullOrWhiteSpace(current)
            ? message
            : current + " | " + message;
    }

    private static Win32Exception CreateWin32Exception(
        string operation,
        int? suppliedError = null)
    {
        var errorCode = suppliedError
            ?? Marshal.GetLastWin32Error();
        var nativeMessage = new Win32Exception(errorCode).Message;
        var elevationHint = errorCode == 5
            ? "；请以管理员身份运行捕捉器"
            : string.Empty;
        return new Win32Exception(
            errorCode,
            $"{operation} 失败：{nativeMessage} "
            + $"(Win32={errorCode}){elevationHint}");
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeWaitHandle OpenThread(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        uint threadId);

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

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool VirtualProtectEx(
        SafeProcessHandle process,
        nint address,
        nuint size,
        uint newProtection,
        out uint oldProtection);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlushInstructionCache(
        SafeProcessHandle process,
        nint baseAddress,
        nuint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DebugActiveProcess(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DebugActiveProcessStop(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DebugSetProcessKillOnExit(
        [MarshalAs(UnmanagedType.Bool)] bool killOnExit);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WaitForDebugEvent(
        ref DebugEvent debugEvent,
        uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ContinueDebugEvent(
        uint processId,
        uint threadId,
        uint continueStatus);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetThreadContext(
        SafeWaitHandle thread,
        ref Context32 context);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetThreadContext(
        SafeWaitHandle thread,
        ref Context32 context);

    private enum DebugEventCode : uint
    {
        Exception = 1
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DebugEvent
    {
        public DebugEventCode DebugEventCode;
        public uint ProcessId;
        public uint ThreadId;
        public DebugEventData Data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct DebugEventData
    {
        [FieldOffset(0)]
        public ExceptionDebugInfo Exception;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExceptionDebugInfo
    {
        public ExceptionRecord ExceptionRecord;
        public uint FirstChance;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExceptionRecord
    {
        public uint ExceptionCode;
        public uint ExceptionFlags;
        public nint NestedExceptionRecord;
        public nint ExceptionAddress;
        public uint NumberParameters;
        public nuint ExceptionInformation0;
        public nuint ExceptionInformation1;
        public nuint ExceptionInformation2;
        public nuint ExceptionInformation3;
        public nuint ExceptionInformation4;
        public nuint ExceptionInformation5;
        public nuint ExceptionInformation6;
        public nuint ExceptionInformation7;
        public nuint ExceptionInformation8;
        public nuint ExceptionInformation9;
        public nuint ExceptionInformation10;
        public nuint ExceptionInformation11;
        public nuint ExceptionInformation12;
        public nuint ExceptionInformation13;
        public nuint ExceptionInformation14;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FloatingSaveArea
    {
        public uint ControlWord;
        public uint StatusWord;
        public uint TagWord;
        public uint ErrorOffset;
        public uint ErrorSelector;
        public uint DataOffset;
        public uint DataSelector;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 80)]
        public byte[] RegisterArea;

        public uint Cr0NpxState;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Context32
    {
        public uint ContextFlags;
        public uint Dr0;
        public uint Dr1;
        public uint Dr2;
        public uint Dr3;
        public uint Dr6;
        public uint Dr7;
        public FloatingSaveArea FloatSave;
        public uint SegGs;
        public uint SegFs;
        public uint SegEs;
        public uint SegDs;
        public uint Edi;
        public uint Esi;
        public uint Ebx;
        public uint Edx;
        public uint Ecx;
        public uint Eax;
        public uint Ebp;
        public uint Eip;
        public uint SegCs;
        public uint EFlags;
        public uint Esp;
        public uint SegSs;

        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 512)]
        public byte[] ExtendedRegisters;
    }
}
