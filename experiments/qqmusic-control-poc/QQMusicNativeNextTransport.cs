using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace QQMusicControlPoc;

internal sealed record QQMusicNativeNextResult(
    QQMusicSongReference RequestedSong,
    bool CommandSent,
    bool HelperExited,
    bool PatchApplied,
    bool OriginalCodeRestored,
    bool ForegroundUnchanged,
    bool CurrentWindowTrackUnchanged,
    QQMusicPlaybackState Before,
    QQMusicPlaybackState After,
    int TargetProcessId,
    string ModulePath,
    string FileVersion,
    string Sha256,
    string OriginalBytes,
    int NativeStage,
    int GetCatManagerHresult,
    int GetSongInfoHresult,
    uint ResolvedSongId,
    int HiddenCategoryId,
    int HiddenCategoryCount,
    bool RemoteMemoryReleased,
    string Verification,
    long ElapsedMilliseconds,
    string Transport,
    string? Error);

/// <summary>
/// Executes the same AddSongs(mode=0) operation as a calibrated QQ Music
/// context-menu "play next" command.
///
/// /playbysongid already performs the network query and creates a native
/// SongItem, but normally ends by playing it immediately. This transport
/// temporarily redirects that final UI-thread call to a version-locked x86
/// trampoline. The trampoline reads the just-resolved item from QQ Music's
/// private command category and invokes AddSongs(mode=0) on the original UI
/// thread, then returns without running the immediate-play dispatcher.
///
/// No remote worker thread calls QQ Music objects. That older experiment was
/// removed because AddSongs synchronously depends on the UI thread.
/// </summary>
internal static class QQMusicNativeNextTransport
{
    private const int DataOffset = 0x300;
    private const int DataSize = 0x100;
    private const int VectorOffset = 0xB8;
    private const int ResolvedSongIdOffset = 0xC4;
    private const int HiddenCategoryIdOffset = 0xC8;
    private const int HiddenCategoryCountOffset = 0xCC;
    private const int HiddenCategoryIndexOffset = 0xD0;

    private const uint ProcessVmOperation = 0x0008;
    private const uint ProcessVmRead = 0x0010;
    private const uint ProcessVmWrite = 0x0020;
    private const uint ProcessQueryInformation = 0x0400;
    private const uint MemCommit = 0x1000;
    private const uint MemReserve = 0x2000;
    private const uint MemRelease = 0x8000;
    private const uint PageExecuteReadWrite = 0x40;
    private const string OperationMutexName =
        @"Local\QQMusicControlPoc.NativeNextUiTrampoline";

    private static readonly SemaphoreSlim OperationGate = new(1, 1);

    public static async Task<QQMusicNativeNextResult> InsertAsync(
        QQMusicSongReference song,
        TimeSpan? responseWindow = null)
    {
        if (song.SongId is <= 0 or > uint.MaxValue)
        {
            throw new ArgumentOutOfRangeException(
                nameof(song),
                "底层下一首播放只接受 32 位正 songID。");
        }

        await OperationGate.WaitAsync().ConfigureAwait(false);
        try
        {
            return await Task.Run(
                    () => Insert(
                        song,
                        responseWindow ?? TimeSpan.FromSeconds(8)))
                .ConfigureAwait(false);
        }
        finally
        {
            OperationGate.Release();
        }
    }

    private static QQMusicNativeNextResult Insert(
        QQMusicSongReference song,
        TimeSpan responseWindow)
    {
        var stopwatch = Stopwatch.StartNew();
        var before = QQMusicNativeController.ReadPlaybackState();
        var foregroundBefore = GetForegroundWindow();
        var commandSent = false;
        var helperExited = false;
        var patchApplied = false;
        var patchWriteAttempted = false;
        var originalCodeRestored = false;
        var remoteMemoryReleased = false;
        var targetProcessId = 0;
        var modulePath = string.Empty;
        var fileVersion = string.Empty;
        var sha256 = string.Empty;
        var observedOriginalBytes = string.Empty;
        var stage = 0;
        var getCatManagerHresult = unchecked((int)0x80004005);
        var getSongInfoHresult = unchecked((int)0x80004005);
        uint resolvedSongId = 0;
        var hiddenCategoryId = 0;
        var hiddenCategoryCount = 0;
        string? error = null;
        TargetModules? target = null;
        QQMusicNativeNextProfile? profile = null;
        SafeProcessHandle? processHandle = null;
        Mutex? operationMutex = null;
        var mutexAcquired = false;
        nint patchAddress = 0;
        nint remoteBlock = 0;

        try
        {
            if (responseWindow < TimeSpan.FromSeconds(2)
                || responseWindow > TimeSpan.FromSeconds(12))
            {
                throw new ArgumentOutOfRangeException(
                    nameof(responseWindow),
                    "响应等待窗口必须在 2 到 12 秒之间。");
            }

            operationMutex = new Mutex(false, OperationMutexName);
            try
            {
                mutexAcquired = operationMutex.WaitOne(
                    TimeSpan.FromSeconds(2));
            }
            catch (AbandonedMutexException)
            {
                mutexAcquired = true;
            }

            if (!mutexAcquired)
            {
                throw new TimeoutException(
                    "另一个原生下一首播放操作仍在进行。");
            }

            if (!before.IsRunning
                || string.IsNullOrWhiteSpace(before.Title))
            {
                throw new InvalidOperationException(
                    "没有读取到正在播放的 QQ 音乐歌曲。");
            }

            target = FindTarget();
            targetProcessId = target.Process.Id;
            modulePath = target.ClientModulePath;
            var analysis = QQMusicNativeNextAnalyzer.AnalyzeFiles(
                target.ClientModulePath,
                target.CommonModulePath,
                target.ExecutablePath,
                target.Process.Id);
            fileVersion = analysis.FileVersion;
            sha256 = analysis.ClientSha256;
            profile = analysis.Profile;
            if (!analysis.ExecutionAllowed || profile is null)
            {
                var failedChecks = string.Join(
                    "; ",
                    analysis.Checks
                        .Where(check =>
                            check.Required && !check.Passed)
                        .Select(check =>
                            $"{check.Name}: {check.Detail}"));
                throw new InvalidOperationException(
                    analysis.Summary
                    + (string.IsNullOrWhiteSpace(failedChecks)
                        ? string.Empty
                        : " " + failedChecks));
            }

            processHandle = OpenProcess(
                ProcessVmOperation
                    | ProcessVmRead
                    | ProcessVmWrite
                    | ProcessQueryInformation,
                false,
                target.Process.Id);
            if (processHandle.IsInvalid)
            {
                throw CreateWin32Exception("OpenProcess");
            }

            patchAddress = nint.Add(
                target.ClientModuleBase,
                profile.SingleSongPlayDispatchRva);
            var currentBytes = ReadBytes(
                processHandle,
                patchAddress,
                profile.ExpectedPlayDispatchBytes.Length);
            observedOriginalBytes = FormatBytes(currentBytes);
            if (!currentBytes.SequenceEqual(
                    profile.ExpectedPlayDispatchBytes))
            {
                throw new InvalidOperationException(
                    "单曲播放分发指令不匹配，已拒绝写入。"
                    + $" 实际={observedOriginalBytes}，"
                    + "预期="
                    + FormatBytes(
                        profile.ExpectedPlayDispatchBytes));
            }

            remoteBlock = VirtualAllocEx(
                processHandle,
                0,
                0x1000,
                MemCommit | MemReserve,
                PageExecuteReadWrite);
            if (remoteBlock == 0)
            {
                throw CreateWin32Exception("VirtualAllocEx");
            }

            var dataAddress = nint.Add(remoteBlock, DataOffset);
            var trampoline = BuildUiTrampoline(
                dataAddress,
                target.ClientModuleBase,
                target.CommonModuleBase,
                profile);
            WriteBytes(processHandle, remoteBlock, trampoline);
            WriteBytes(
                processHandle,
                dataAddress,
                new byte[DataSize]);

            var redirectBytes = CreateRelativeCall(
                patchAddress,
                remoteBlock);
            patchWriteAttempted = true;
            WriteCodeBytes(
                processHandle,
                patchAddress,
                redirectBytes);
            patchApplied = true;

            using var helper = StartSingleSongHelper(
                target.ExecutablePath,
                song);
            commandSent = true;
            helperExited = helper.WaitForExit(3500);
            if (!helperExited)
            {
                TryStopUnexpectedHelper(helper);
                throw new TimeoutException(
                    "QQMusic.exe 单实例命令进程未按时退出。");
            }

            var deadline = DateTime.UtcNow + responseWindow;
            while (DateTime.UtcNow < deadline)
            {
                var stageBytes = ReadBytes(
                    processHandle,
                    dataAddress,
                    sizeof(int));
                stage = BitConverter.ToInt32(stageBytes, 0);
                if (stage == 5)
                {
                    break;
                }

                Thread.Sleep(50);
            }

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
            hiddenCategoryId =
                BitConverter.ToInt32(
                    data,
                    HiddenCategoryIdOffset);
            hiddenCategoryCount =
                BitConverter.ToInt32(
                    data,
                    HiddenCategoryCountOffset);

            if (stage != 5)
            {
                throw new TimeoutException(
                    "QQ 音乐解析回调没有完成 UI 线程下一首跳板。"
                    + $" 当前阶段={stage}。");
            }

            if (getCatManagerHresult < 0)
            {
                throw new COMException(
                    "GetICatMgr 失败。",
                    getCatManagerHresult);
            }

            if (getSongInfoHresult < 0)
            {
                throw new COMException(
                    "GetSongInfo 失败。",
                    getSongInfoHresult);
            }

            if (resolvedSongId != (uint)song.SongId)
            {
                throw new InvalidOperationException(
                    "UI 跳板解析到的 SongItem 与目标 songID 不一致："
                    + $"目标={song.SongId}，实际={resolvedSongId}。");
            }
        }
        catch (Exception exception)
        {
            error = $"{exception.GetType().Name}: {exception.Message}";
        }
        finally
        {
            if (patchWriteAttempted
                && processHandle is not null
                && !processHandle.IsInvalid
                && patchAddress != 0)
            {
                try
                {
                    WriteCodeBytes(
                        processHandle,
                        patchAddress,
                        profile!.ExpectedPlayDispatchBytes);
                    originalCodeRestored = ReadBytes(
                            processHandle,
                            patchAddress,
                            profile.ExpectedPlayDispatchBytes.Length)
                        .SequenceEqual(
                            profile.ExpectedPlayDispatchBytes);
                    if (!originalCodeRestored)
                    {
                        AppendError(
                            ref error,
                            "恢复单曲播放分发指令后的复检失败。");
                    }
                }
                catch (Exception restoreException)
                {
                    AppendError(
                        ref error,
                        "恢复单曲播放分发指令失败："
                        + restoreException.Message);
                }
            }
            else
            {
                originalCodeRestored = true;
            }

            // The block is safe to release only after the trampoline reached
            // its final stage. On any timeout it is deliberately leaked
            // (4 KiB inside QQMusic.exe) instead of risking a return into
            // freed executable memory.
            if (remoteBlock != 0
                && processHandle is not null
                && !processHandle.IsInvalid
                && stage == 5)
            {
                try
                {
                    remoteMemoryReleased = VirtualFreeEx(
                        processHandle,
                        remoteBlock,
                        0,
                        MemRelease);
                    if (!remoteMemoryReleased)
                    {
                        AppendError(
                            ref error,
                            CreateWin32Exception(
                                "VirtualFreeEx").Message);
                    }
                }
                catch (Exception releaseException)
                {
                    AppendError(
                        ref error,
                        "释放 UI 跳板内存失败："
                        + releaseException.Message);
                }
            }

            processHandle?.Dispose();
            target?.Process.Dispose();
            if (mutexAcquired)
            {
                operationMutex?.ReleaseMutex();
            }

            operationMutex?.Dispose();
        }

        var after = QQMusicNativeController.ReadPlaybackState();
        stopwatch.Stop();
        var foregroundUnchanged =
            foregroundBefore == GetForegroundWindow();
        var currentWindowTrackUnchanged =
            !string.IsNullOrWhiteSpace(before.WindowTitle)
            && string.Equals(
                before.WindowTitle?.Trim(),
                after.WindowTitle?.Trim(),
                StringComparison.OrdinalIgnoreCase);
        var verification = DescribeVerification(
            commandSent,
            patchApplied,
            originalCodeRestored,
            remoteMemoryReleased,
            stage,
            getCatManagerHresult,
            getSongInfoHresult,
            resolvedSongId,
            checked((uint)song.SongId),
            foregroundUnchanged,
            currentWindowTrackUnchanged,
            error);

        return new QQMusicNativeNextResult(
            song,
            commandSent,
            helperExited,
            patchApplied,
            originalCodeRestored,
            foregroundUnchanged,
            currentWindowTrackUnchanged,
            before,
            after,
            targetProcessId,
            modulePath,
            fileVersion,
            sha256,
            observedOriginalBytes,
            stage,
            getCatManagerHresult,
            getSongInfoHresult,
            resolvedSongId,
            hiddenCategoryId,
            hiddenCategoryCount,
            remoteMemoryReleased,
            verification,
            stopwatch.ElapsedMilliseconds,
            $"QQMusic {profile?.FileVersion ?? fileVersion} "
                + "validated UI callback trampoline "
                + "-> GetSongInfo(last resolved item) "
                + "-> AddSongs(mode=0)",
            error);
    }

    private static byte[] BuildUiTrampoline(
        nint dataAddress,
        nint clientModuleBase,
        nint commonModuleBase,
        QQMusicNativeNextProfile profile)
    {
        var emitter = new X86Emitter();
        var data = checked((uint)dataAddress.ToInt64());
        var getCatManager = Address(
            commonModuleBase,
            profile.GetCatManagerRva);
        var getQqUinEx = Address(
            commonModuleBase,
            profile.GetQqUinExRva);
        var songItemConstructor = Address(
            clientModuleBase,
            profile.SongItemConstructorRva);
        var songItemDestructor = Address(
            clientModuleBase,
            profile.SongItemDestructorRva);
        var addSongs = Address(
            clientModuleBase,
            profile.AddSongsRva);
        var hiddenCategoryIdAddress = Address(
            clientModuleBase,
            profile.HiddenCategoryIdRva);
        var getListRoot = Address(
            clientModuleBase,
            profile.GetListRootRva);
        var getListHelper = Address(
            clientModuleBase,
            profile.GetListHelperRva);
        var getCategoryCount = Address(
            clientModuleBase,
            profile.GetCategoryCountRva);

        // Preserve the original query callback's complete register/flag state.
        emitter.Bytes(0x9C, 0x60, 0xBF);
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

        // Resolve the last item added by /playbysongid.
        emitter.Byte(0xA1);
        emitter.UInt32(hiddenCategoryIdAddress);
        emitter.Bytes(0x89, 0x87);
        emitter.UInt32(HiddenCategoryIdOffset);
        emitter.Bytes(0x8B, 0xD8);

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
        emitter.Jump32(0x0F, 0x89, "indexReady");
        emitter.Bytes(0x33, 0xC0);
        emitter.Label("indexReady");
        emitter.Bytes(0x89, 0x87);
        emitter.UInt32(HiddenCategoryIndexOffset);

        emitter.Byte(0xB8);
        emitter.UInt32(getQqUinEx);
        emitter.Bytes(0xFF, 0xD0, 0x6A, 0x00);
        emitter.Bytes(0x8D, 0x4F, 0x18, 0x51);
        emitter.Bytes(0xFF, 0xB7);
        emitter.UInt32(HiddenCategoryIndexOffset);
        emitter.Bytes(0xFF, 0xB7);
        emitter.UInt32(HiddenCategoryIdOffset);
        emitter.Bytes(0x52, 0x50, 0x56, 0x8B, 0x0E);
        emitter.Bytes(0xFF, 0x51, 0x34);
        emitter.Bytes(0x89, 0x47, 0x0C, 0x85, 0xC0);
        emitter.Jump32(0x0F, 0x88, "cleanup");
        emitter.MovDwordAtEdi(0x00, 3);
        emitter.Bytes(0x8B, 0x47, 0x18);
        emitter.Bytes(0x89, 0x87);
        emitter.UInt32(ResolvedSongIdOffset);

        // std::vector<SongItem> with one already-constructed element.
        emitter.Bytes(0x8D, 0x47, 0x18);
        emitter.Bytes(0x89, 0x87);
        emitter.UInt32(VectorOffset);
        emitter.Bytes(0x05);
        emitter.UInt32(checked((uint)profile.SongItemSize));
        emitter.Bytes(0x89, 0x87);
        emitter.UInt32(VectorOffset + 4);
        emitter.Bytes(0x89, 0x87);
        emitter.UInt32(VectorOffset + 8);

        // Same call shape captured from the real context-menu action.
        emitter.Bytes(0x8B, 0xCE, 0x8D, 0x97);
        emitter.UInt32(VectorOffset);
        emitter.Bytes(0x6A, 0x00, 0xB8);
        emitter.UInt32(addSongs);
        emitter.Bytes(0xFF, 0xD0, 0x83, 0xC4, 0x04);
        emitter.Bytes(0x89, 0x47, 0x10);
        emitter.MovDwordAtEdi(0x00, 4);

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
        emitter.Bytes(0x61, 0x9D, 0xC3);
        return emitter.Build();
    }

    private static byte[] CreateRelativeCall(
        nint instructionAddress,
        nint targetAddress)
    {
        var nextInstruction = instructionAddress.ToInt64() + 5;
        var displacement = checked(
            (int)(targetAddress.ToInt64() - nextInstruction));
        return [0xE8, .. BitConverter.GetBytes(displacement)];
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
                var executable = process.MainModule;
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

                if (executable is null
                    || client is null
                    || common is null)
                {
                    continue;
                }

                matches.Add(new TargetModules(
                    process,
                    executable.FileName,
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

    private static Process StartSingleSongHelper(
        string executablePath,
        QQMusicSongReference song)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executablePath,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        startInfo.ArgumentList.Add("/playbysongid");
        startInfo.ArgumentList.Add(
            $"cmd_count==1&&id_0=={song.SongId}"
            + $"&&songtype_0=={song.SongType}");
        return Process.Start(startInfo)
            ?? throw new InvalidOperationException(
                "QQMusic.exe 单实例命令进程未启动。");
    }

    private static void TryStopUnexpectedHelper(Process helper)
    {
        try
        {
            if (!helper.HasExited)
            {
                helper.Kill(false);
                helper.WaitForExit(1000);
            }
        }
        catch (Exception exception)
            when (exception is InvalidOperationException
                or Win32Exception)
        {
            // The helper may have exited between checks.
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
                out var bytesRead)
            || bytesRead != (nuint)buffer.Length)
        {
            throw CreateWin32Exception("ReadProcessMemory");
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
            throw CreateWin32Exception("WriteProcessMemory");
        }
    }

    private static void WriteCodeBytes(
        SafeProcessHandle process,
        nint address,
        byte[] bytes)
    {
        if (!VirtualProtectEx(
                process,
                address,
                (nuint)bytes.Length,
                PageExecuteReadWrite,
                out var originalProtection))
        {
            throw CreateWin32Exception("VirtualProtectEx");
        }

        Exception? failure = null;
        try
        {
            WriteBytes(process, address, bytes);
            if (!FlushInstructionCache(
                    process,
                    address,
                    (nuint)bytes.Length))
            {
                throw CreateWin32Exception("FlushInstructionCache");
            }

            var verified = ReadBytes(process, address, bytes.Length);
            if (!verified.SequenceEqual(bytes))
            {
                throw new InvalidOperationException(
                    "目标进程代码写入后的复检失败。");
            }
        }
        catch (Exception exception)
        {
            failure = exception;
            throw;
        }
        finally
        {
            if (!VirtualProtectEx(
                    process,
                    address,
                    (nuint)bytes.Length,
                    originalProtection,
                    out _)
                && failure is null)
            {
                throw CreateWin32Exception(
                    "VirtualProtectEx(restore protection)");
            }
        }
    }

    private static string DescribeVerification(
        bool commandSent,
        bool patchApplied,
        bool originalCodeRestored,
        bool remoteMemoryReleased,
        int stage,
        int getCatManagerHresult,
        int getSongInfoHresult,
        uint resolvedSongId,
        uint requestedSongId,
        bool foregroundUnchanged,
        bool currentTrackUnchanged,
        string? error)
    {
        if (!string.IsNullOrWhiteSpace(error))
        {
            return "NativeNextRequestFailed";
        }

        if (!commandSent || !patchApplied)
        {
            return "NativeNextRequestRejected";
        }

        if (!originalCodeRestored || !remoteMemoryReleased)
        {
            return "NativeNextCleanupFailed";
        }

        if (stage != 5
            || getCatManagerHresult < 0
            || getSongInfoHresult < 0
            || resolvedSongId != requestedSongId)
        {
            return "NativeNextTrampolineNotVerified";
        }

        if (!foregroundUnchanged)
        {
            return "ForegroundChangedUnexpectedly";
        }

        return currentTrackUnchanged
            ? "NativeNextInsertedCurrentTrackUnchangedPendingNextVerification"
            : "NativeNextUnexpectedlyChangedCurrentTrack";
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

    private static string FormatBytes(IEnumerable<byte> bytes)
    {
        return string.Join(
            ' ',
            bytes.Select(value => value.ToString("X2")));
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
        string operation)
    {
        var errorCode = Marshal.GetLastWin32Error();
        var nativeMessage = new Win32Exception(errorCode).Message;
        var elevationHint = errorCode == 5
            ? "；请以管理员身份运行此测试 POC"
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

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    private sealed record TargetModules(
        Process Process,
        string ExecutablePath,
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
                    "x86 UI 跳板代码超过预留的数据偏移。");
            }

            return [.. _bytes];
        }
    }
}
