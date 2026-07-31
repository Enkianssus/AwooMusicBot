using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace QQMusicControlPoc;

internal sealed record QQMusicNativeSongItemProbeResult(
    QQMusicSongReference RequestedSong,
    bool InvokeAddSongs,
    bool UseQqSongId,
    bool UseHiddenQueueLastItem,
    int Stage,
    int GetCatManagerHresult,
    int GetSongInfoHresult,
    uint ResolvedSongId,
    int HiddenCategoryId,
    int HiddenCategoryCount,
    string SongItemBytes,
    bool NativeThreadCompleted,
    bool ForegroundUnchanged,
    bool CurrentTrackUnchanged,
    QQMusicPlaybackState Before,
    QQMusicPlaybackState After,
    int ProcessId,
    string Verification,
    long ElapsedMilliseconds,
    string? Error);

/// <summary>
/// Version-locked x86 probe for the exact native path used by
/// CQMListViewMenu::OnNextPlay in QQ Music 22.22:
///
///   GetICatMgr -> IQMCatMgr::GetSongInfoByID -> AddSongs(mode=0)
///
/// The resolver-only mode stops before AddSongs so object construction can be
/// verified without altering playback or the queue.
/// </summary>
internal static class QQMusicNativeSongItemProbe
{
    private const string ExpectedModulePath =
        @"F:\Program Files\QQMusic\QQMusic.dll";
    private const string ExpectedCommonModulePath =
        @"F:\Program Files\QQMusic\QQMusicCommon.dll";
    private const string ExpectedFileVersion = "22.22";

    private const int GetCatManagerRva = 0x0000F0ED;
    private const int GetQqUinExRva = 0x0002E089;
    private const int SongItemConstructorRva = 0x0004A2A0;
    private const int SongItemDestructorRva = 0x00049DE0;
    private const int AddSongsRva = 0x0042C010;
    private const int HiddenCategoryIdRva = 0x00C141A0;
    private const int GetListRootRva = 0x00602430;
    private const int GetListHelperRva = 0x00602590;
    private const int GetCategoryCountRva = 0x004DBBC0;
    private const int SongItemSize = 0xA0;
    private const int DataOffset = 0x200;
    private const int DataSize = 0x100;
    private const int VectorOffset = 0xB8;
    private const int ResolvedSongIdOffset = 0xC4;
    private const int HiddenCategoryIdOffset = 0xC8;
    private const int HiddenCategoryCountOffset = 0xCC;

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

    private static readonly SemaphoreSlim Gate = new(1, 1);

    public static async Task<QQMusicNativeSongItemProbeResult> RunAsync(
        QQMusicSongReference song,
        bool invokeAddSongs,
        bool useQqSongId = true,
        bool useHiddenQueueLastItem = false)
    {
        if (invokeAddSongs)
        {
            throw new NotSupportedException(
                "已禁用远程工作线程调用 AddSongs；"
                + "该函数必须由 QQ 音乐自己的 UI 回调执行。");
        }

        if (song.SongId is <= 0 or > uint.MaxValue)
        {
            throw new ArgumentOutOfRangeException(
                nameof(song),
                "底层 SongItem 查询只接受 32 位正 songID。");
        }

        await Gate.WaitAsync().ConfigureAwait(false);
        try
        {
            return await Task.Run(
                    () => Run(
                        song,
                        invokeAddSongs,
                        useQqSongId,
                        useHiddenQueueLastItem))
                .ConfigureAwait(false);
        }
        finally
        {
            Gate.Release();
        }
    }

    private static QQMusicNativeSongItemProbeResult Run(
        QQMusicSongReference song,
        bool invokeAddSongs,
        bool useQqSongId,
        bool useHiddenQueueLastItem)
    {
        var stopwatch = Stopwatch.StartNew();
        var before = QQMusicNativeController.ReadPlaybackState();
        var foregroundBefore = GetForegroundWindow();
        var stage = 0;
        var getCatManagerHresult = unchecked((int)0x80004005);
        var getSongInfoHresult = unchecked((int)0x80004005);
        uint resolvedSongId = 0;
        var hiddenCategoryId = 0;
        var hiddenCategoryCount = 0;
        var songItemBytes = string.Empty;
        var threadCompleted = false;
        var processId = 0;
        string? error = null;

        try
        {
            if (IntPtr.Size != 4)
            {
                throw new PlatformNotSupportedException(
                    "该探针必须由 x86 POC 运行。");
            }

            var target = FindTarget();
            using var process = target.Process;
            processId = process.Id;
            VerifyModule(target.ClientModulePath);
            VerifyCommonModule(target.CommonModulePath);

            using var processHandle = OpenProcess(
                ProcessCreateThread
                    | ProcessVmOperation
                    | ProcessVmRead
                    | ProcessVmWrite
                    | ProcessQueryInformation,
                false,
                process.Id);
            if (processHandle.IsInvalid)
            {
                throw CreateWin32Exception("OpenProcess");
            }

            var remoteBlock = VirtualAllocEx(
                processHandle,
                0,
                0x1000,
                MemCommit | MemReserve,
                PageExecuteReadWrite);
            if (remoteBlock == 0)
            {
                throw CreateWin32Exception("VirtualAllocEx");
            }

            try
            {
                var dataAddress = nint.Add(remoteBlock, DataOffset);
                var code = BuildStub(
                    dataAddress,
                    target.ClientModuleBase,
                    target.CommonModuleBase,
                    checked((uint)song.SongId),
                    invokeAddSongs,
                    useQqSongId,
                    useHiddenQueueLastItem);
                WriteBytes(processHandle, remoteBlock, code);
                WriteBytes(
                    processHandle,
                    dataAddress,
                    new byte[DataSize]);

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

                var waitResult = WaitForSingleObject(thread, 5000);
                if (waitResult == WaitTimeout)
                {
                    throw new TimeoutException(
                        "QQ 音乐底层 SongItem 探针 5 秒内没有返回。");
                }

                if (waitResult != WaitObject0)
                {
                    throw CreateWin32Exception("WaitForSingleObject");
                }

                threadCompleted = true;
                var data = ReadBytes(
                    processHandle,
                    dataAddress,
                    DataSize);
                stage = BitConverter.ToInt32(data, 0);
                getCatManagerHresult =
                    BitConverter.ToInt32(data, 4);
                getSongInfoHresult =
                    BitConverter.ToInt32(data, 12);
                resolvedSongId =
                    BitConverter.ToUInt32(
                        data,
                        ResolvedSongIdOffset);
                songItemBytes = Convert.ToHexString(
                    data.AsSpan(0x18, SongItemSize));
                hiddenCategoryId = BitConverter.ToInt32(
                    data,
                    HiddenCategoryIdOffset);
                hiddenCategoryCount = BitConverter.ToInt32(
                    data,
                    HiddenCategoryCountOffset);
            }
            finally
            {
                if (!VirtualFreeEx(
                        processHandle,
                        remoteBlock,
                        0,
                        MemRelease))
                {
                    throw CreateWin32Exception("VirtualFreeEx");
                }
            }
        }
        catch (Exception exception)
        {
            error = $"{exception.GetType().Name}: {exception.Message}";
        }

        var after = QQMusicNativeController.ReadPlaybackState();
        stopwatch.Stop();
        var foregroundUnchanged =
            foregroundBefore == GetForegroundWindow();
        var currentTrackUnchanged = string.Equals(
            before.WindowTitle?.Trim(),
            after.WindowTitle?.Trim(),
            StringComparison.OrdinalIgnoreCase);
        var expectedStage = invokeAddSongs ? 5 : 5;
        var verification =
            threadCompleted
            && stage == expectedStage
            && getCatManagerHresult >= 0
            && getSongInfoHresult >= 0
            && foregroundUnchanged
            && currentTrackUnchanged
                ? invokeAddSongs
                    ? "ExactNativeAddSongsReturnedCurrentTrackUnchanged"
                    : "NativeSongItemResolvedCurrentTrackUnchanged"
                : "NativeSongItemProbeNotVerified";

        return new QQMusicNativeSongItemProbeResult(
            song,
            invokeAddSongs,
            useQqSongId,
            useHiddenQueueLastItem,
            stage,
            getCatManagerHresult,
            getSongInfoHresult,
            resolvedSongId,
            hiddenCategoryId,
            hiddenCategoryCount,
            songItemBytes,
            threadCompleted,
            foregroundUnchanged,
            currentTrackUnchanged,
            before,
            after,
            processId,
            verification,
            stopwatch.ElapsedMilliseconds,
            error);
    }

    private static byte[] BuildStub(
        nint dataAddress,
        nint clientModuleBase,
        nint commonModuleBase,
        uint songId,
        bool invokeAddSongs,
        bool useQqSongId,
        bool useHiddenQueueLastItem)
    {
        var emitter = new X86Emitter();
        var data = checked((uint)dataAddress.ToInt64());
        var getCatManager = Address(
            commonModuleBase,
            GetCatManagerRva);
        var getQqUinEx = Address(
            commonModuleBase,
            GetQqUinExRva);
        var songItemConstructor = Address(
            clientModuleBase,
            SongItemConstructorRva);
        var songItemDestructor = Address(
            clientModuleBase,
            SongItemDestructorRva);
        var addSongs = Address(
            clientModuleBase,
            AddSongsRva);
        var hiddenCategoryIdAddress = Address(
            clientModuleBase,
            HiddenCategoryIdRva);
        var getListRoot = Address(
            clientModuleBase,
            GetListRootRva);
        var getListHelper = Address(
            clientModuleBase,
            GetListHelperRva);
        var getCategoryCount = Address(
            clientModuleBase,
            GetCategoryCountRva);

        emitter.Bytes(0x55, 0x8B, 0xEC, 0x53, 0x56, 0x57);
        emitter.Byte(0xBF);
        emitter.UInt32(data);
        emitter.Bytes(0x33, 0xF6);
        emitter.MovDwordAtEdi(0x00, 1);

        // GetICatMgr(&data.catManager)
        emitter.Bytes(0x8D, 0x47, 0x08, 0x50, 0xB8);
        emitter.UInt32(getCatManager);
        emitter.Bytes(0xFF, 0xD0, 0x83, 0xC4, 0x04);
        emitter.Bytes(0x89, 0x47, 0x04, 0x85, 0xC0);
        emitter.Jump32(0x0F, 0x88, "cleanup");
        emitter.Bytes(0x8B, 0x77, 0x08, 0x85, 0xF6);
        emitter.Jump32(0x0F, 0x84, "cleanup");
        emitter.MovDwordAtEdi(0x00, 2);

        // SongItem songItem;
        emitter.Bytes(0x8D, 0x4F, 0x18, 0xB8);
        emitter.UInt32(songItemConstructor);
        emitter.Bytes(0xFF, 0xD0);
        emitter.MovDwordAtEdi(0x14, 1);

        if (useHiddenQueueLastItem)
        {
            // category = g_playBySongIdCategory;
            emitter.Byte(0xA1);
            emitter.UInt32(hiddenCategoryIdAddress);
            emitter.Bytes(0x89, 0x87);
            emitter.UInt32(HiddenCategoryIdOffset);
            emitter.Bytes(0x8B, 0xD8);

            // count = GetListHelper()->GetSongCount(category);
            emitter.Bytes(0x6A, 0x00, 0x6A, 0x00, 0xB8);
            emitter.UInt32(getListRoot);
            emitter.Bytes(0xFF, 0xD0, 0x8B, 0xC8, 0xB8);
            emitter.UInt32(getListHelper);
            emitter.Bytes(0xFF, 0xD0, 0x8B, 0xC8, 0x53, 0xB8);
            emitter.UInt32(getCategoryCount);
            emitter.Bytes(0xFF, 0xD0);
            emitter.Bytes(0x89, 0x87);
            emitter.UInt32(HiddenCategoryCountOffset);
            emitter.Bytes(0x48);
            emitter.Jump32(0x0F, 0x89, "hiddenIndexReady");
            emitter.Bytes(0x33, 0xC0);
            emitter.Label("hiddenIndexReady");
            emitter.Bytes(0x89, 0x87);
            emitter.UInt32(HiddenCategoryCountOffset + 4);

            // catMgr->GetSongInfo(
            //   GetQQUinEx(), category, count - 1, &songItem, 0)
            emitter.Byte(0xB8);
            emitter.UInt32(getQqUinEx);
            emitter.Bytes(0xFF, 0xD0, 0x6A, 0x00);
            emitter.Bytes(0x8D, 0x4F, 0x18, 0x51);
            emitter.Bytes(0xFF, 0xB7);
            emitter.UInt32(HiddenCategoryCountOffset + 4);
            emitter.Bytes(0xFF, 0xB7);
            emitter.UInt32(HiddenCategoryIdOffset);
            emitter.Bytes(0x52, 0x50, 0x56, 0x8B, 0x0E);
            emitter.Bytes(0xFF, 0x51, 0x34);
        }
        else if (useQqSongId)
        {
            // catMgr->GetSongInfoByQQSongID(songId, &songItem, 0)
            emitter.Bytes(0x6A, 0x00);
            emitter.Bytes(0x8D, 0x4F, 0x18, 0x51, 0x68);
            emitter.UInt32(0);
            emitter.Byte(0x68);
            emitter.UInt32(songId);
            emitter.Bytes(0x56, 0x8B, 0x0E);
            emitter.Bytes(0xFF, 0x51, 0x4C);
        }
        else
        {
            // catMgr->GetSongInfoByID(GetQQUinEx(), songId, &songItem, 0)
            emitter.Byte(0xB8);
            emitter.UInt32(getQqUinEx);
            emitter.Bytes(0xFF, 0xD0, 0x6A, 0x00);
            emitter.Bytes(0x8D, 0x4F, 0x18, 0x51, 0x68);
            emitter.UInt32(songId);
            emitter.Bytes(0x52, 0x50, 0x56, 0x8B, 0x0E);
            emitter.Bytes(0xFF, 0x51, 0x44);
        }
        emitter.Bytes(0x89, 0x47, 0x0C, 0x85, 0xC0);
        emitter.Jump32(0x0F, 0x88, "cleanup");
        emitter.MovDwordAtEdi(0x00, 3);
        emitter.Bytes(0x8B, 0x47, 0x18);
        emitter.Bytes(0x89, 0x87);
        emitter.UInt32(ResolvedSongIdOffset);

        if (invokeAddSongs)
        {
            // std::vector<SongItem> { &songItem, &songItem + 0xA0 }
            emitter.Bytes(0x8D, 0x47, 0x18);
            emitter.Bytes(0x89, 0x87);
            emitter.UInt32(VectorOffset);
            emitter.Bytes(0x05);
            emitter.UInt32(SongItemSize);
            emitter.Bytes(0x89, 0x87);
            emitter.UInt32(VectorOffset + 4);
            emitter.Bytes(0x89, 0x87);
            emitter.UInt32(VectorOffset + 8);

            // catMgr->AddSongs(vector, Next)
            emitter.Bytes(0x8B, 0xCE, 0x8D, 0x97);
            emitter.UInt32(VectorOffset);
            emitter.Bytes(0x6A, 0x00, 0xB8);
            emitter.UInt32(addSongs);
            emitter.Bytes(0xFF, 0xD0, 0x83, 0xC4, 0x04);
            emitter.Bytes(0x89, 0x47, 0x10);
            emitter.MovDwordAtEdi(0x00, 4);
        }

        emitter.Label("cleanup");
        emitter.Bytes(0x83, 0x7F, 0x14, 0x00);
        emitter.Jump32(0x0F, 0x84, "release");
        emitter.Bytes(0x8D, 0x4F, 0x18, 0xB8);
        emitter.UInt32(songItemDestructor);
        emitter.Bytes(0xFF, 0xD0);

        emitter.Label("release");
        emitter.Bytes(0x85, 0xF6);
        emitter.Jump32(0x0F, 0x84, "done");
        emitter.Bytes(0x8B, 0x06, 0x56, 0xFF, 0x50, 0x08);

        emitter.Label("done");
        emitter.MovDwordAtEdi(0x00, 5);
        emitter.Bytes(
            0x33, 0xC0,
            0x5F, 0x5E, 0x5B,
            0x8B, 0xE5, 0x5D,
            0xC2, 0x04, 0x00);
        return emitter.Build();
    }

    private static uint Address(nint moduleBase, int rva)
    {
        return checked((uint)nint.Add(moduleBase, rva).ToInt64());
    }

    private static TargetModules FindTarget()
    {
        var matches = new List<TargetModules>();
        foreach (var process in Process.GetProcessesByName("QQMusic"))
        {
            var retained = false;
            try
            {
                ProcessModule? client = null;
                ProcessModule? common = null;
                foreach (ProcessModule module in process.Modules)
                {
                    if (module.ModuleName.Equals(
                            "QQMusic.dll",
                            StringComparison.OrdinalIgnoreCase))
                    {
                        client = module;
                    }
                    else if (module.ModuleName.Equals(
                                 "QQMusicCommon.dll",
                                 StringComparison.OrdinalIgnoreCase))
                    {
                        common = module;
                    }
                }

                if (client is null || common is null)
                {
                    continue;
                }

                matches.Add(new TargetModules(
                    process,
                    client.BaseAddress,
                    client.FileName,
                    common.BaseAddress,
                    common.FileName,
                    TryGetWorkingSet(process)));
                retained = true;
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
                "没有找到同时加载 QQMusic.dll 和 QQMusicCommon.dll "
                + "的 QQ 音乐主进程。");
        }

        var selected = matches
            .OrderByDescending(match => match.WorkingSet)
            .First();
        foreach (var match in matches)
        {
            if (!ReferenceEquals(match, selected))
            {
                match.Process.Dispose();
            }
        }

        return selected;
    }

    private static void VerifyModule(string path)
    {
        if (!PathEquals(path, ExpectedModulePath))
        {
            throw new InvalidOperationException(
                $"QQMusic.dll 路径不匹配：{path}");
        }

        var version = FileVersionInfo.GetVersionInfo(path).FileVersion;
        if (!string.Equals(
                version,
                ExpectedFileVersion,
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"QQMusic.dll 版本不匹配：{version}");
        }
    }

    private static void VerifyCommonModule(string path)
    {
        if (!PathEquals(path, ExpectedCommonModulePath))
        {
            throw new InvalidOperationException(
                $"QQMusicCommon.dll 路径不匹配：{path}");
        }
    }

    private static bool PathEquals(string left, string right)
    {
        return string.Equals(
            Path.GetFullPath(left).TrimEnd('\\'),
            Path.GetFullPath(right).TrimEnd('\\'),
            StringComparison.OrdinalIgnoreCase);
    }

    private static long TryGetWorkingSet(Process process)
    {
        try
        {
            return process.WorkingSet64;
        }
        catch (InvalidOperationException)
        {
            return 0;
        }
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
            throw CreateWin32Exception("ReadProcessMemory");
        }

        return buffer;
    }

    private static Win32Exception CreateWin32Exception(
        string operation)
    {
        var code = Marshal.GetLastWin32Error();
        return new Win32Exception(
            code,
            $"{operation} 失败：{new Win32Exception(code).Message} "
            + $"(Win32={code})");
    }

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
    private static extern bool WriteProcessMemory(
        SafeProcessHandle process,
        nint baseAddress,
        byte[] buffer,
        nuint size,
        out nuint bytesWritten);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadProcessMemory(
        SafeProcessHandle process,
        nint baseAddress,
        [Out] byte[] buffer,
        nuint size,
        out nuint bytesRead);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    private sealed record TargetModules(
        Process Process,
        nint ClientModuleBase,
        string ClientModulePath,
        nint CommonModuleBase,
        string CommonModulePath,
        long WorkingSet);

    private sealed class X86Emitter
    {
        private readonly List<byte> _bytes = [];
        private readonly Dictionary<string, int> _labels =
            new(StringComparer.Ordinal);
        private readonly List<(int Offset, string Label)> _fixups = [];

        public void Byte(byte value)
        {
            _bytes.Add(value);
        }

        public void Bytes(params byte[] values)
        {
            _bytes.AddRange(values);
        }

        public void UInt32(uint value)
        {
            _bytes.AddRange(BitConverter.GetBytes(value));
        }

        public void MovDwordAtEdi(byte offset, uint value)
        {
            Bytes(0xC7, 0x47, offset);
            UInt32(value);
        }

        public void Label(string name)
        {
            _labels.Add(name, _bytes.Count);
        }

        public void Jump32(
            byte firstOpcode,
            byte secondOpcode,
            string label)
        {
            Bytes(firstOpcode, secondOpcode);
            _fixups.Add((_bytes.Count, label));
            UInt32(0);
        }

        public byte[] Build()
        {
            foreach (var (offset, label) in _fixups)
            {
                if (!_labels.TryGetValue(label, out var target))
                {
                    throw new InvalidOperationException(
                        $"未定义 x86 标签：{label}");
                }

                var displacement = target - (offset + 4);
                var encoded = BitConverter.GetBytes(displacement);
                for (var index = 0; index < encoded.Length; index++)
                {
                    _bytes[offset + index] = encoded[index];
                }
            }

            if (_bytes.Count >= DataOffset)
            {
                throw new InvalidOperationException(
                    "x86 探针代码超过预留的数据偏移。");
            }

            return [.. _bytes];
        }
    }
}
