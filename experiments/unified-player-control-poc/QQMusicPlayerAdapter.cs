using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using QQMusicControlPoc;

namespace UnifiedPlayerControlPoc;

internal sealed class QQMusicPlayerAdapter : IPlayerAdapter
{
    private const string NativeNextLockedExecutable =
        @"F:\Program Files\QQMusic\QQMusic.exe";

    private readonly QQMusicCatalogClient _catalogClient = new();
    private readonly SemaphoreSlim _operationGate = new(1, 1);
    private readonly object _trackSync = new();
    private readonly object _softwareNextSync = new();
    private readonly Dictionary<(long SongId, int SongType), PlayerTrack>
        _knownTracks = [];
    private CancellationTokenSource? _softwareNextCancellation;
    private Task? _softwareNextTask;
    private volatile string _softwareNextStatus = string.Empty;
    private int _cachedVersionProcessId;
    private string _cachedVersion = string.Empty;

    public string Key => "qqmusic";

    public string DisplayName => "QQ 音乐";

    public string TestedVersion => "22.22";

    public bool AllowUnsafeNativeNext { get; set; }

    public PlayerCapabilities Capabilities { get; } = new(
        Search: true,
        PlaySelected: true,
        Previous: true,
        Pause: true,
        Resume: true,
        Toggle: false,
        Next: true,
        InsertNext: true,
        InsertNextLevel: "默认静音+暂停防漏音守卫；可叠加 QQ 22.22 原生插队");

    public Task<PlayerSnapshot> ProbeAsync(
        CancellationToken cancellationToken)
    {
        return Task.Run(() =>
        {
            var state = QQMusicNativeController.ReadPlaybackState();
            if (!state.IsRunning)
            {
                return new PlayerSnapshot(
                    false,
                    DisplayName,
                    null,
                    string.Empty,
                    "未连接：没有发现可见 QQ 音乐窗口",
                    null,
                    DateTimeOffset.Now);
            }

            var processId = state.WindowHandle is null
                ? null
                : FindProcessId(state.WindowHandle.Value);
            var version = processId is null
                ? string.Empty
                : GetCachedVersion(processId.Value);
            var current = ResolveKnownTrack(
                state.Title,
                state.Artist)
                ?? (!string.IsNullOrWhiteSpace(state.Title)
                    ? new PlayerTrack(
                        string.Empty,
                        state.Title,
                        state.Artist ?? string.Empty,
                        string.Empty)
                    : null);
            return new PlayerSnapshot(
                true,
                DisplayName,
                processId,
                version,
                "QQMusic.exe 单实例控制可用；状态来自窗口标题"
                + (string.IsNullOrWhiteSpace(_softwareNextStatus)
                    ? string.Empty
                    : $"；{_softwareNextStatus}"),
                current,
                DateTimeOffset.Now);
        }, cancellationToken);
    }

    public async Task<IReadOnlyList<PlayerTrack>> SearchAsync(
        string query,
        CancellationToken cancellationToken)
    {
        var songs = await _catalogClient.SearchAsync(
            query,
            cancellationToken: cancellationToken).ConfigureAwait(false);
        var tracks = songs.Select(song =>
        {
            var nativeData = JsonSerializer.Serialize(new QqTrackPayload(
                song.SongId,
                song.SongType,
                song.SongMid,
                song.IsPlayable));
            return new PlayerTrack(
                song.SongId.ToString(),
                song.Title,
                song.Artist,
                song.Album,
                nativeData);
        }).ToArray();
        lock (_trackSync)
        {
            foreach (var track in tracks)
            {
                var payload = ParsePayload(track);
                _knownTracks[(payload.SongId, payload.SongType)] = track;
            }
        }

        return tracks;
    }

    public async Task<PlayerOperationResult> ExecuteAsync(
        PlayerCommand command,
        PlayerTrack? track,
        CancellationToken cancellationToken)
    {
        await _operationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        var stopwatch = Stopwatch.StartNew();
        try
        {
            var before = await ProbeAsync(cancellationToken).ConfigureAwait(false);
            if (!before.Connected)
            {
                return new PlayerOperationResult(
                    OperationOutcome.Rejected,
                    "QQ 音乐未连接。",
                    before);
            }

            if (command == PlayerCommand.InsertNext)
            {
                return await ExecuteInsertNextAsync(
                    before,
                    track,
                    cancellationToken).ConfigureAwait(false);
            }

            var executable = FindExecutablePath();
            if (string.IsNullOrWhiteSpace(executable))
            {
                return new PlayerOperationResult(
                    OperationOutcome.Rejected,
                    "无法从运行进程或常见安装目录定位 QQMusic.exe。",
                    before);
            }

            string switchName;
            string argument;
            switch (command)
            {
                case PlayerCommand.Previous:
                    switchName = "/playcontrol";
                    argument = "'prev'";
                    break;
                case PlayerCommand.Next:
                    switchName = "/playcontrol";
                    argument = "'next'";
                    break;
                case PlayerCommand.Pause:
                    switchName = "/playcontrol";
                    argument = "'pause'";
                    break;
                case PlayerCommand.Resume:
                    switchName = "/playcontrol";
                    argument = "'play'";
                    break;
                case PlayerCommand.PlaySelected when track is not null:
                {
                    var payload = ParsePayload(track);
                    if (!payload.IsPlayable)
                    {
                        return new PlayerOperationResult(
                            OperationOutcome.Rejected,
                            "QQ 目录接口把该结果标记为不可播放。",
                            before);
                    }

                    CancelSoftwareNext(
                        "软件下一首已因立即播放其他歌曲而取消。");
                    switchName = "/playbysongid";
                    argument =
                        $"cmd_count==1&&id_0=={payload.SongId}"
                        + $"&&songtype_0=={payload.SongType}";
                    break;
                }
                default:
                    return new PlayerOperationResult(
                        OperationOutcome.Unsupported,
                        "QQ 音乐适配器不支持该命令。",
                        before);
            }

            var foregroundBefore = GetForegroundWindow();
            var send = await Task.Run(
                () => SendSingleInstanceCommand(
                    executable,
                    switchName,
                    argument),
                cancellationToken).ConfigureAwait(false);
            if (!send.Sent)
            {
                return new PlayerOperationResult(
                    OperationOutcome.Rejected,
                    send.Message,
                    await ProbeAsync(cancellationToken).ConfigureAwait(false));
            }

            if (command is PlayerCommand.Pause or PlayerCommand.Resume)
            {
                return new PlayerOperationResult(
                    OperationOutcome.Accepted,
                    $"{send.Message}（{stopwatch.ElapsedMilliseconds} ms）。"
                    + $"命令为明确的 {command}，但标题状态不能验证暂停位。",
                    before);
            }

            var verificationWindow =
                command == PlayerCommand.PlaySelected
                    ? TimeSpan.FromMilliseconds(2200)
                    : TimeSpan.FromMilliseconds(1400);
            var deadline = DateTimeOffset.UtcNow + verificationWindow;
            var after = before;
            while (DateTimeOffset.UtcNow < deadline)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await Task.Delay(80, cancellationToken).ConfigureAwait(false);
                after = await ProbeAsync(cancellationToken).ConfigureAwait(false);
                if (command == PlayerCommand.PlaySelected && track is not null)
                {
                    if (TrackMatches(after.Current, track))
                    {
                        return new PlayerOperationResult(
                            OperationOutcome.Verified,
                            $"已观察到 QQ 音乐播放目标：{track.DisplayName}；"
                            + $"耗时={stopwatch.ElapsedMilliseconds} ms；"
                            + $"前台未变={foregroundBefore == GetForegroundWindow()}。",
                            after);
                    }
                }
                else if (HasTrackChanged(before.Current, after.Current))
                {
                    return new PlayerOperationResult(
                        OperationOutcome.Applied,
                        $"已观察到 QQ 音乐切歌：{after.Current?.DisplayName ?? "未知歌曲"}；"
                        + $"耗时={stopwatch.ElapsedMilliseconds} ms；"
                        + $"前台未变={foregroundBefore == GetForegroundWindow()}。",
                        after);
                }
            }

            return new PlayerOperationResult(
                OperationOutcome.Accepted,
                $"{send.Message}（{stopwatch.ElapsedMilliseconds} ms）。"
                + "快速验证窗口内未观察到标题变化；后台轮询仍会继续更新状态。",
                after);
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public ValueTask DisposeAsync()
    {
        CancelSoftwareNext(string.Empty);
        _catalogClient.Dispose();
        _operationGate.Dispose();
        return ValueTask.CompletedTask;
    }

    private async Task<PlayerOperationResult> ExecuteInsertNextAsync(
        PlayerSnapshot before,
        PlayerTrack? track,
        CancellationToken cancellationToken)
    {
        if (!AllowUnsafeNativeNext)
        {
            return ArmSoftwareNext(before, track, cancellationToken);
        }

        if (track is null)
        {
            return new PlayerOperationResult(
                OperationOutcome.Rejected,
                "请先选择一条 QQ 搜索结果。",
                before);
        }

        var guardResult =
            ArmSoftwareNext(before, track, cancellationToken);
        var executable = FindExecutablePath();
        if (!string.Equals(
                executable,
                NativeNextLockedExecutable,
                StringComparison.OrdinalIgnoreCase))
        {
            return new PlayerOperationResult(
                guardResult.IsSuccess
                    ? OperationOutcome.Accepted
                    : OperationOutcome.Rejected,
                "当前原生下一首传输仍锁定 F:\\Program Files\\QQMusic；"
                + $"检测到路径为 {executable ?? "未知"}，已安全拒绝。"
                + (guardResult.IsSuccess
                    ? $" 已回退到静音防漏音守卫：{guardResult.Message}"
                    : string.Empty),
                before);
        }

        var payload = ParsePayload(track);
        if (!payload.IsPlayable)
        {
            return new PlayerOperationResult(
                OperationOutcome.Rejected,
                "QQ 目录接口把该结果标记为不可播放。",
                before);
        }

        var result = await QQMusicNativeNextTransport.InsertAsync(
            new QQMusicSongReference(payload.SongId, payload.SongType),
            TimeSpan.FromSeconds(6)).WaitAsync(cancellationToken)
            .ConfigureAwait(false);
        var after = await ProbeAsync(cancellationToken).ConfigureAwait(false);
        var accepted =
            result.Verification
                == "NativeNextInsertedCurrentTrackUnchangedPendingNextVerification"
            && result.NativeStage == 5
            && result.GetCatManagerHresult >= 0
            && result.GetSongInfoHresult >= 0
            && result.ResolvedSongId == payload.SongId;
        return new PlayerOperationResult(
            accepted || guardResult.IsSuccess
                ? OperationOutcome.Accepted
                : OperationOutcome.Rejected,
            accepted
                ? $"QQ 22.22 已提交原生下一首，songID={result.ResolvedSongId}；"
                  + "当前歌曲未变化；静音防漏音守卫同时待命。"
                : $"QQ 原生下一首被拒绝：{result.Verification}；"
                  + (result.Error ?? "底层校验未通过。")
                  + (guardResult.IsSuccess
                      ? " 已保留静音防漏音守卫。"
                      : string.Empty),
            after);
    }

    private PlayerOperationResult ArmSoftwareNext(
        PlayerSnapshot before,
        PlayerTrack? track,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (track is null)
        {
            return new PlayerOperationResult(
                OperationOutcome.Rejected,
                "请先选择一条 QQ 搜索结果。",
                before);
        }

        var payload = ParsePayload(track);
        if (!payload.IsPlayable)
        {
            return new PlayerOperationResult(
                OperationOutcome.Rejected,
                "QQ 目录接口把该结果标记为不可播放。",
                before);
        }

        var currentState = QQMusicNativeController.ReadPlaybackState();
        var currentKey = BuildPlaybackKey(currentState);
        if (string.IsNullOrWhiteSpace(currentKey)
            || currentState.WindowHandle is null
            || string.IsNullOrWhiteSpace(currentState.WindowTitle))
        {
            return new PlayerOperationResult(
                OperationOutcome.Rejected,
                "当前 QQ 窗口标题没有可识别歌曲，无法可靠监测下一次切歌。",
                before);
        }

        var pendingCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        CancellationTokenSource? previousCancellation;
        lock (_softwareNextSync)
        {
            previousCancellation = _softwareNextCancellation;
            _softwareNextCancellation = pendingCancellation;
            _softwareNextStatus = $"下一首静音防漏音守卫待命：{track.DisplayName}";
            _softwareNextTask = Task.Run(
                () => MonitorSoftwareNextAsync(
                    pendingCancellation,
                    (nint)currentState.WindowHandle.Value,
                    currentState.WindowTitle,
                    currentKey,
                    track,
                    payload));
        }

        if (previousCancellation is not null)
        {
            previousCancellation.Cancel();
        }

        return new PlayerOperationResult(
            OperationOutcome.Accepted,
            $"已登记静音防漏音下一首：{track.DisplayName}。"
            + "已开始直接高频监测 QQ 主窗口标题；发生切换时会先静音 QQ，"
            + "若歌曲错误再暂停并用 /playbysongid 接管。",
            before);
    }

    private async Task MonitorSoftwareNextAsync(
        CancellationTokenSource owner,
        nint initialWindowHandle,
        string initialWindowTitle,
        string initialPlaybackKey,
        PlayerTrack track,
        QqTrackPayload payload)
    {
        var cancellationToken = owner.Token;
        using var audioMute = QQMusicAudioMuteScope.Capture();
        var timelineProbeTask =
            QQMusicTimelineProbe.TryCreateAsync();
        try
        {
            var expiresAt =
                DateTimeOffset.UtcNow + TimeSpan.FromHours(12);
            var windowHandle = initialWindowHandle;
            var baselineWindowTitle = initialWindowTitle;
            var transitionDetected = false;
            var emptyTitleReads = 0;
            QQMusicTimelineProbe? timelineProbe = null;
            DateTimeOffset? preMutedAt = null;
            var timelineCheckAt = DateTimeOffset.UtcNow;
            var preMuteSuppressedUntil = DateTimeOffset.MinValue;
            while (DateTimeOffset.UtcNow < expiresAt)
            {
                await Task.Delay(2, cancellationToken)
                    .ConfigureAwait(false);

                var observedWindowTitle = ReadWindowTitle(windowHandle);
                if (string.IsNullOrWhiteSpace(observedWindowTitle))
                {
                    emptyTitleReads++;
                    if (emptyTitleReads >= 25)
                    {
                        var refreshed =
                            QQMusicNativeController.ReadPlaybackState();
                        if (refreshed.WindowHandle is not null
                            && !string.IsNullOrWhiteSpace(
                                refreshed.WindowTitle))
                        {
                            windowHandle =
                                (nint)refreshed.WindowHandle.Value;
                            observedWindowTitle =
                                refreshed.WindowTitle;
                        }

                        emptyTitleReads = 0;
                    }
                }
                else
                {
                    emptyTitleReads = 0;
                }

                if (!transitionDetected)
                {
                    if (string.Equals(
                            observedWindowTitle,
                            baselineWindowTitle,
                            StringComparison.Ordinal))
                    {
                        var now = DateTimeOffset.UtcNow;
                        if (preMutedAt is not null)
                        {
                            if (now - preMutedAt.Value
                                >= TimeSpan.FromSeconds(2))
                            {
                                audioMute.Restore();
                                preMutedAt = null;
                                preMuteSuppressedUntil =
                                    now + TimeSpan.FromSeconds(3);
                                SetSoftwareNextStatus(
                                    owner,
                                    "QQ 时间线预静音后 2 秒内未发生切歌，"
                                    + "已恢复原静音状态并继续守卫。");
                            }

                            continue;
                        }

                        if (now >= timelineCheckAt
                            && now >= preMuteSuppressedUntil)
                        {
                            timelineCheckAt =
                                now + TimeSpan.FromMilliseconds(20);
                            if (timelineProbe is null
                                && timelineProbeTask
                                    .IsCompletedSuccessfully)
                            {
                                timelineProbe =
                                    timelineProbeTask.Result;
                            }

                            if (timelineProbe?.IsPlayingNearNaturalEnd(
                                    TimeSpan.FromMilliseconds(180),
                                    out var remaining) == true
                                && audioMute.Mute())
                            {
                                preMutedAt = now;
                                SetSoftwareNextStatus(
                                    owner,
                                    "QQ 即将自然切歌，已提前静音防止错误歌曲首帧漏音"
                                    + $"（预计剩余 {Math.Max(0, remaining.TotalMilliseconds):F0} ms）。");
                            }
                        }

                        continue;
                    }

                    transitionDetected = true;
                    var muted = audioMute.Mute();
                    SetSoftwareNextStatus(
                        owner,
                        muted
                            ? $"检测到 QQ 标题切换，已立即静音 "
                              + $"{audioMute.CapturedSessionCount} 个音频会话。"
                            : "检测到 QQ 标题切换，但没有捕获到可静音的 QQ 音频会话；"
                              + "将继续用 pause 接管。");
                }

                if (string.Equals(
                        observedWindowTitle,
                        baselineWindowTitle,
                        StringComparison.Ordinal))
                {
                    // A transient read failure is not a real track transition.
                    // Restore promptly so the current song is not left muted.
                    audioMute.Restore();
                    preMutedAt = null;
                    transitionDetected = false;
                    continue;
                }

                var observedTrack =
                    ParseQqWindowTrack(observedWindowTitle);
                if (observedTrack is null)
                {
                    continue;
                }

                var observedKey = BuildPlaybackKey(observedTrack);
                if (observedKey == initialPlaybackKey)
                {
                    baselineWindowTitle = observedWindowTitle;
                    audioMute.Restore();
                    transitionDetected = false;
                    continue;
                }

                if (TrackMatches(observedTrack, track))
                {
                    audioMute.Restore();
                    SetSoftwareNextStatus(
                        owner,
                        $"下一首已正确命中：{track.DisplayName}");
                    return;
                }

                var executable = FindExecutablePath();
                if (string.IsNullOrWhiteSpace(executable))
                {
                    SetSoftwareNextStatus(
                        owner,
                        "软件下一首失败：未找到 QQMusic.exe");
                    return;
                }

                SetSoftwareNextStatus(
                    owner,
                    $"检测到错误下一首：{observedTrack.DisplayName}；"
                    + "QQ 音频已静音，正在暂停并接管");
                var pause = await Task.Run(
                    () => SendSingleInstanceCommand(
                        executable,
                        "/playcontrol",
                        "'pause'",
                        helperWaitMilliseconds: 100),
                    cancellationToken).ConfigureAwait(false);
                await Task.Delay(20, cancellationToken)
                    .ConfigureAwait(false);
                var play = await Task.Run(
                    () => SendSingleInstanceCommand(
                        executable,
                        "/playbysongid",
                        $"cmd_count==1&&id_0=={payload.SongId}"
                        + $"&&songtype_0=={payload.SongType}",
                        helperWaitMilliseconds: 100),
                    cancellationToken).ConfigureAwait(false);

                if (!play.Sent)
                {
                    audioMute.Restore();
                    SetSoftwareNextStatus(
                        owner,
                        $"下一首目标发送失败：{play.Message}；"
                        + "已恢复 QQ 原静音状态。");
                    return;
                }

                var targetDeadline =
                    DateTimeOffset.UtcNow + TimeSpan.FromSeconds(3);
                while (DateTimeOffset.UtcNow < targetDeadline)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    await Task.Delay(5, cancellationToken)
                        .ConfigureAwait(false);
                    var targetWindowTitle =
                        ReadWindowTitle(windowHandle);
                    var targetTrack =
                        ParseQqWindowTrack(targetWindowTitle);
                    if (targetTrack is not null
                        && TrackMatches(targetTrack, track))
                    {
                        audioMute.Restore();
                        SetSoftwareNextStatus(
                            owner,
                            pause.Sent
                                ? "已在静音中暂停错误歌曲，确认目标后恢复声音："
                                  + track.DisplayName
                                : "暂停未确认，但已在静音中切到目标并恢复声音："
                                  + track.DisplayName);
                        return;
                    }
                }

                audioMute.Restore();
                SetSoftwareNextStatus(
                    owner,
                    $"已发送目标但 3 秒内未能确认：{track.DisplayName}；"
                    + "为避免 QQ 一直静音，已恢复原静音状态。");
                return;
            }

            SetSoftwareNextStatus(
                owner,
                "软件下一首已过期（12 小时未发生切歌）");
        }
        catch (OperationCanceledException)
        {
            // Replaced, manually cancelled, or the application is closing.
        }
        catch (Exception exception)
        {
            SetSoftwareNextStatus(
                owner,
                $"软件下一首异常：{exception.Message}");
        }
        finally
        {
            lock (_softwareNextSync)
            {
                if (ReferenceEquals(_softwareNextCancellation, owner))
                {
                    _softwareNextCancellation = null;
                    _softwareNextTask = null;
                }
            }

            owner.Dispose();
        }
    }

    private static PlayerTrack? ParseQqWindowTrack(
        string? windowTitle)
    {
        if (string.IsNullOrWhiteSpace(windowTitle)
            || windowTitle.Equals(
                "QQ\u97F3\u4E50",
                StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var separator = windowTitle.IndexOf(
            " - ",
            StringComparison.Ordinal);
        if (separator <= 0)
        {
            return null;
        }

        return new PlayerTrack(
            string.Empty,
            windowTitle[..separator].Trim(),
            windowTitle[(separator + 3)..].Trim(),
            string.Empty);
    }

    private static string BuildPlaybackKey(PlayerTrack track)
    {
        return $"{Normalize(track.Title)}|{Normalize(track.Artist)}";
    }

    private static string ReadWindowTitle(nint windowHandle)
    {
        var length = GetWindowTextLength(windowHandle);
        if (length <= 0)
        {
            return string.Empty;
        }

        var text = new StringBuilder(length + 1);
        _ = GetWindowText(windowHandle, text, text.Capacity);
        return text.ToString().Trim();
    }

    private void SetSoftwareNextStatus(
        CancellationTokenSource owner,
        string status)
    {
        lock (_softwareNextSync)
        {
            if (ReferenceEquals(_softwareNextCancellation, owner))
            {
                _softwareNextStatus = status;
            }
        }
    }

    private void CancelSoftwareNext(string status)
    {
        CancellationTokenSource? cancellation;
        lock (_softwareNextSync)
        {
            cancellation = _softwareNextCancellation;
            _softwareNextCancellation = null;
            _softwareNextTask = null;
            _softwareNextStatus = status;
        }

        if (cancellation is not null)
        {
            cancellation.Cancel();
        }
    }

    private static string BuildPlaybackKey(QQMusicPlaybackState state)
    {
        if (!state.IsRunning || string.IsNullOrWhiteSpace(state.Title))
        {
            return string.Empty;
        }

        return $"{Normalize(state.Title)}|{Normalize(state.Artist ?? string.Empty)}";
    }

    private PlayerTrack? ResolveKnownTrack(
        string? title,
        string? artist)
    {
        if (string.IsNullOrWhiteSpace(title))
        {
            return null;
        }

        lock (_trackSync)
        {
            var matches = _knownTracks.Values
                .Where(track =>
                    Normalize(track.Title) == Normalize(title)
                    && (string.IsNullOrWhiteSpace(artist)
                        || Normalize(track.Artist) == Normalize(artist)))
                .ToArray();
            return matches.Length == 1 ? matches[0] : null;
        }
    }

    private static QqTrackPayload ParsePayload(PlayerTrack track)
    {
        return JsonSerializer.Deserialize<QqTrackPayload>(track.NativeData)
            ?? throw new InvalidDataException("QQ 搜索结果缺少原生 songID 数据。");
    }

    private static string? FindExecutablePath()
    {
        foreach (var process in Process.GetProcessesByName("QQMusic"))
        {
            using (process)
            {
                try
                {
                    var path = process.MainModule?.FileName;
                    if (!string.IsNullOrWhiteSpace(path)
                        && File.Exists(path))
                    {
                        return Path.GetFullPath(path);
                    }
                }
                catch
                {
                    // Try the next process or known install locations.
                }
            }
        }

        var candidates = new[]
        {
            NativeNextLockedExecutable,
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "QQMusic",
                "QQMusic.exe"),
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                "Tencent",
                "QQMusic",
                "QQMusic.exe"),
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "QQMusic",
                "QQMusic.exe")
        };
        return candidates.FirstOrDefault(File.Exists);
    }

    private static SingleInstanceSendResult SendSingleInstanceCommand(
        string executable,
        string switchName,
        string argument,
        int helperWaitMilliseconds = 400)
    {
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = executable,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            startInfo.ArgumentList.Add(switchName);
            startInfo.ArgumentList.Add(argument);
            using var helper = Process.Start(startInfo)
                ?? throw new InvalidOperationException(
                    "QQMusic.exe 单实例命令进程未启动。");
            var exited = helper.WaitForExit(
                Math.Clamp(helperWaitMilliseconds, 0, 5000));

            return new SingleInstanceSendResult(
                true,
                exited
                    ? $"QQ 单实例命令已发送：{switchName} {argument}"
                    : "QQ 单实例命令已启动；不再等待辅助进程退出。");
        }
        catch (Exception exception)
        {
            return new SingleInstanceSendResult(
                false,
                $"{exception.GetType().Name}: {exception.Message}");
        }
    }

    private static int? FindProcessId(long windowHandle)
    {
        _ = GetWindowThreadProcessId(
            (nint)windowHandle,
            out var processId);
        return processId == 0 ? null : checked((int)processId);
    }

    private string GetCachedVersion(int processId)
    {
        if (_cachedVersionProcessId == processId)
        {
            return _cachedVersion;
        }

        _cachedVersion = TryGetVersion(processId);
        _cachedVersionProcessId = processId;
        return _cachedVersion;
    }

    private static string TryGetVersion(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            var path = process.MainModule?.FileName;
            return string.IsNullOrWhiteSpace(path)
                ? string.Empty
                : FileVersionInfo.GetVersionInfo(path).FileVersion
                  ?? string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    private static bool TrackMatches(PlayerTrack? actual, PlayerTrack expected)
    {
        return actual is not null
            && (actual.Id == expected.Id
                && !string.IsNullOrWhiteSpace(actual.Id)
                || (Normalize(actual.Title) == Normalize(expected.Title)
                    && (string.IsNullOrWhiteSpace(expected.Artist)
                        || Normalize(actual.Artist)
                        == Normalize(expected.Artist))));
    }

    private static bool HasTrackChanged(
        PlayerTrack? before,
        PlayerTrack? after)
    {
        if (after is null)
        {
            return false;
        }

        if (before is null)
        {
            return true;
        }

        if (!string.IsNullOrWhiteSpace(before.Id)
            && !string.IsNullOrWhiteSpace(after.Id))
        {
            return before.Id != after.Id;
        }

        return Normalize(before.DisplayName) != Normalize(after.DisplayName);
    }

    private static string Normalize(string value)
    {
        return value.Trim().ToUpperInvariant();
    }

    private sealed record QqTrackPayload(
        long SongId,
        int SongType,
        string SongMid,
        bool IsPlayable);

    private sealed record SingleInstanceSendResult(
        bool Sent,
        string Message);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(
        nint window,
        out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(nint window);

    [DllImport(
        "user32.dll",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern int GetWindowText(
        nint window,
        StringBuilder text,
        int maximum);
}
