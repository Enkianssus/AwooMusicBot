using System.Text.Json;
using System.Text.Json.Serialization;
using System.Diagnostics;
using Windows.Media.Control;

namespace KugouControlPoc;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public static async Task<int> Main(string[] args)
    {
        var command = args.FirstOrDefault()?.ToLowerInvariant() ?? "status";
        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };

        GlobalSystemMediaTransportControlsSessionManager? manager = null;
        try
        {
            manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"Windows 系统媒体会话不可用，将使用酷狗原生控制：{exception.Message}");
        }

        if (command == "sessions")
        {
            if (manager is null)
            {
                WriteJson(Array.Empty<MediaSnapshot>());
                return 0;
            }

            var snapshots = new List<MediaSnapshot>();
            foreach (var session in manager.GetSessions())
            {
                snapshots.Add(await ReadSnapshotAsync(session));
            }

            WriteJson(snapshots);
            return 0;
        }

        if (command == "inspect-windows")
        {
            WriteJson(KugouNativeController.InspectWindows());
            return 0;
        }

        if (command == "inspect-ipc")
        {
            WriteJson(KugouNativeController.InspectIpcEndpoint());
            return 0;
        }

        if (command == "close-vip-popup")
        {
            var result = KugouNativeController.TryCloseVipTrialPopup();
            WriteJson(result);
            return !result.Found || result.CloseSucceeded ? 0 : 5;
        }

        if (command == "popup-status")
        {
            WriteJson(KugouNativeController.DetectVipTrialPopup());
            return 0;
        }

        if (command == "analyze-hotkey-import")
        {
            var path = string.Join(' ', args.Skip(1)).Trim();
            if (string.IsNullOrWhiteSpace(path))
            {
                Console.Error.WriteLine("请传入 32 位 PE 文件路径");
                return 1;
            }

            WriteJson(PeHotkeyAnalyzer.FindRegisterHotKeyCalls(path));
            return 0;
        }

        if (command == "watch")
        {
            var watchSession = manager is null ? null : FindKugouSession(manager);
            if (watchSession is not null)
            {
                await WatchMediaSessionAsync(manager!, cancellation.Token);
            }
            else
            {
                await WatchNativeStateAsync(cancellation.Token);
            }

            return 0;
        }

        var kugouSession = manager is null ? null : FindKugouSession(manager);
        if (command == "status")
        {
            if (kugouSession is not null)
            {
                WriteJson(await ReadSnapshotAsync(kugouSession));
            }
            else
            {
                WriteJson(
                    await KugouNativeController.ReadPlaybackStateWithIdentityAsync());
            }

            return 0;
        }

        if (command == "search-play")
        {
            var query = string.Join(' ', args.Skip(1)).Trim();
            var searchResult = KugouNativeController.SearchAndPlay(query);
            WriteJson(searchResult);
            return searchResult.Sent ? 0 : 5;
        }

        if (command == "background-search-play")
        {
            var query = string.Join(' ', args.Skip(1)).Trim();
            var searchResult =
                await KugouNativeController.SearchAndPlayBackgroundAsync(query);
            WriteJson(searchResult);
            return searchResult.Sent
                && searchResult.TrackChanged
                && searchResult.ForegroundUnchanged
                && searchResult.CursorUnchanged
                ? 0
                : 5;
        }

        if (command == "force-search-play")
        {
            var query = string.Join(' ', args.Skip(1)).Trim();
            var searchResult =
                await KugouNativeController.SearchAndPlayForcedRecoveryAsync(query);
            WriteJson(searchResult);
            return searchResult.Sent
                && searchResult.TrackChanged
                && searchResult.ForegroundUnchanged
                ? 0
                : 5;
        }

        if (command == "background-search-next")
        {
            var query = string.Join(' ', args.Skip(1)).Trim();
            var searchResult =
                await KugouNativeController.SearchAsNextBackgroundAsync(query);
            WriteJson(searchResult);
            return searchResult.Sent
                && searchResult.ForegroundUnchanged
                ? 0
                : 5;
        }

        if (command == "background-open-file")
        {
            var handleIndex = Array.FindIndex(
                args,
                argument => argument.Equals("--handle", StringComparison.OrdinalIgnoreCase));
            long? targetHandle = null;
            if (handleIndex >= 0
                && handleIndex + 1 < args.Length
                && long.TryParse(args[handleIndex + 1], out var parsedHandle))
            {
                targetHandle = parsedHandle;
            }

            var pathArguments = handleIndex < 0
                ? args.Skip(1)
                : args.Skip(1).Take(handleIndex - 1);
            var path = string.Join(' ', pathArguments).Trim();
            var openResult = KugouNativeController.SendBackgroundOpenFile(path, targetHandle);
            WriteJson(openResult);
            return openResult.Sent
                && openResult.TrackChanged
                && openResult.ForegroundUnchanged
                && openResult.CursorUnchanged
                ? 0
                : 5;
        }

        if (command == "probe-next")
        {
            var before = KugouNativeController.ReadPlaybackState();
            var stopwatch = Stopwatch.StartNew();
            var control = KugouNativeController.Send(KugouAppCommand.NextTrack);
            var after = KugouNativeController.ReadPlaybackState();

            while (control.Sent
                && stopwatch.Elapsed < TimeSpan.FromSeconds(6)
                && SameTrack(before, after))
            {
                await Task.Delay(50);
                after = KugouNativeController.ReadPlaybackState();
            }

            stopwatch.Stop();
            var changed = !SameTrack(before, after);
            WriteJson(new NativeTrackChangeProbe(
                control,
                changed,
                stopwatch.Elapsed.TotalMilliseconds,
                before,
                after,
                changed ? null : "等待 6 秒后仍未检测到歌曲标题变化"));
            return control.Sent && changed ? 0 : 5;
        }

        if (command == "background-next")
        {
            var result = KugouNativeController.SendBackgroundAppCommand(
                KugouAppCommand.NextTrack);
            WriteJson(result);
            return result.Sent
                && result.TrackChanged
                && result.ForegroundUnchanged
                && result.CursorUnchanged
                ? 0
                : 5;
        }

        if (command == "background-hotkey-next")
        {
            var result = KugouNativeController.SendBackgroundHotkey(
                KugouAppCommand.NextTrack);
            WriteJson(result);
            return result.Sent
                && result.TrackChanged
                && result.ForegroundUnchanged
                && result.CursorUnchanged
                ? 0
                : 5;
        }

        var directCommand = command switch
        {
            "direct-next" => KugouAppCommand.NextTrack,
            "direct-previous" or "direct-prev" => KugouAppCommand.PreviousTrack,
            "direct-toggle" => KugouAppCommand.PlayPause,
            "direct-stop" => KugouAppCommand.Stop,
            _ => (KugouAppCommand?)null
        };
        if (directCommand is not null)
        {
            var result = KugouNativeController.SendResilientKugouCommand(
                directCommand.Value);
            WriteJson(result);
            return result.Sent
                && result.ForegroundUnchanged
                && result.CursorUnchanged
                && (directCommand is not (
                        KugouAppCommand.NextTrack
                        or KugouAppCommand.PreviousTrack)
                    || result.TrackChanged)
                ? 0
                : 5;
        }

        KugouAppCommand? appCommand = command switch
        {
            "next" => KugouAppCommand.NextTrack,
            "previous" or "prev" => KugouAppCommand.PreviousTrack,
            "play" => KugouAppCommand.Play,
            "pause" => KugouAppCommand.Pause,
            "toggle" => KugouAppCommand.PlayPause,
            "stop" => KugouAppCommand.Stop,
            _ => null
        };

        if (appCommand is null)
        {
            PrintUsage();
            return 1;
        }

        if (kugouSession is not null)
        {
            return command switch
            {
                "next" => await RunControlAsync("next", kugouSession.TrySkipNextAsync),
                "previous" or "prev" => await RunControlAsync("previous", kugouSession.TrySkipPreviousAsync),
                "play" => await RunControlAsync("play", kugouSession.TryPlayAsync),
                "pause" => await RunControlAsync("pause", kugouSession.TryPauseAsync),
                "toggle" => await RunControlAsync("toggle", kugouSession.TryTogglePlayPauseAsync),
                "stop" => await RunControlAsync("stop", kugouSession.TryStopAsync),
                _ => 1
            };
        }

        var nativeResult = KugouNativeController.Send(appCommand.Value);
        WriteJson(nativeResult);
        return nativeResult.Sent ? 0 : 5;
    }

    private static GlobalSystemMediaTransportControlsSession? FindKugouSession(
        GlobalSystemMediaTransportControlsSessionManager manager)
    {
        return manager.GetSessions().FirstOrDefault(session =>
            session.SourceAppUserModelId.Contains("kugou", StringComparison.OrdinalIgnoreCase)
            || session.SourceAppUserModelId.Contains("kgmusic", StringComparison.OrdinalIgnoreCase));
    }

    private static async Task WatchMediaSessionAsync(
        GlobalSystemMediaTransportControlsSessionManager manager,
        CancellationToken cancellationToken)
    {
        Console.WriteLine("正在监听酷狗媒体状态；按 Ctrl+C 结束。");
        string? lastFingerprint = null;

        while (!cancellationToken.IsCancellationRequested)
        {
            var session = FindKugouSession(manager);
            if (session is null)
            {
                const string missingFingerprint = "missing";
                if (!string.Equals(lastFingerprint, missingFingerprint, StringComparison.Ordinal))
                {
                    WriteJson(new MediaEvent("session-missing", DateTimeOffset.Now, null));
                    lastFingerprint = missingFingerprint;
                }
            }
            else
            {
                var snapshot = await ReadSnapshotAsync(session);
                var fingerprint = JsonSerializer.Serialize(snapshot, JsonOptions);
                if (!string.Equals(lastFingerprint, fingerprint, StringComparison.Ordinal))
                {
                    WriteJson(new MediaEvent("state-changed", DateTimeOffset.Now, snapshot));
                    lastFingerprint = fingerprint;
                }
            }

            try
            {
                await Task.Delay(250, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private static async Task WatchNativeStateAsync(CancellationToken cancellationToken)
    {
        Console.WriteLine("酷狗未暴露系统媒体会话，正在监听主窗口标题；按 Ctrl+C 结束。");
        string? lastFingerprint = null;

        while (!cancellationToken.IsCancellationRequested)
        {
            var popup = KugouNativeController.TryCloseVipTrialPopup();
            if (popup.CloseSent)
            {
                WriteJson(new
                {
                    Type = "vip-popup-closed",
                    popup.Timestamp,
                    popup.WindowHandle,
                    popup.Width,
                    popup.Height
                });
            }

            var snapshot =
                await KugouNativeController.ReadPlaybackStateWithIdentityAsync(
                    cancellationToken);
            var fingerprint = snapshot.AudioId > 0
                ? $"audio:{snapshot.AudioId}"
                : !string.IsNullOrWhiteSpace(snapshot.Hash)
                    ? $"hash:{snapshot.Hash}"
                    : $"title:{snapshot.Artist}\0{snapshot.Title}";
            if (!string.Equals(lastFingerprint, fingerprint, StringComparison.Ordinal))
            {
                WriteJson(new NativeMediaEvent("track-changed", DateTimeOffset.Now, snapshot));
                lastFingerprint = fingerprint;
            }

            try
            {
                await Task.Delay(250, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private static async Task<MediaSnapshot> ReadSnapshotAsync(
        GlobalSystemMediaTransportControlsSession session)
    {
        var media = await session.TryGetMediaPropertiesAsync();
        var playback = session.GetPlaybackInfo();
        var timeline = session.GetTimelineProperties();

        return new MediaSnapshot(
            session.SourceAppUserModelId,
            media.Title,
            media.Artist,
            media.AlbumTitle,
            media.AlbumArtist,
            media.Subtitle,
            media.TrackNumber,
            playback.PlaybackStatus.ToString(),
            timeline.Position,
            timeline.StartTime,
            timeline.EndTime,
            playback.Controls.IsNextEnabled,
            playback.Controls.IsPreviousEnabled,
            playback.Controls.IsPlayEnabled,
            playback.Controls.IsPauseEnabled);
    }

    private static async Task<int> RunControlAsync(
        string action,
        Func<Windows.Foundation.IAsyncOperation<bool>> control)
    {
        bool accepted;
        try
        {
            accepted = await control();
        }
        catch (Exception exception)
        {
            WriteError($"酷狗控制失败：{action}", exception);
            return 4;
        }

        WriteJson(new ControlResult(action, accepted, DateTimeOffset.Now));
        return accepted ? 0 : 5;
    }

    private static void WriteJson<T>(T value)
    {
        Console.WriteLine(JsonSerializer.Serialize(value, JsonOptions));
    }

    private static void WriteError(string message, Exception exception)
    {
        WriteJson(new
        {
            error = message,
            exception = exception.GetType().FullName,
            exception.Message
        });
    }

    private static void PrintUsage()
    {
        Console.WriteLine(
            """
            用法：
              KugouControlPoc sessions
              KugouControlPoc status
              KugouControlPoc watch
              KugouControlPoc inspect-windows
              KugouControlPoc inspect-ipc
              KugouControlPoc popup-status
              KugouControlPoc close-vip-popup
              KugouControlPoc analyze-hotkey-import <32 位 PE 文件路径>
              KugouControlPoc next
              KugouControlPoc previous
              KugouControlPoc play
              KugouControlPoc pause
              KugouControlPoc toggle
              KugouControlPoc stop
              KugouControlPoc search-play <歌手或歌曲关键词>
              KugouControlPoc background-search-play <歌手或歌曲关键词>
              KugouControlPoc force-search-play <歌手或歌曲关键词>
              KugouControlPoc background-search-next <歌手或歌曲关键词>
              KugouControlPoc background-open-file <本地音频文件路径>
              KugouControlPoc probe-next
              KugouControlPoc background-next
              KugouControlPoc background-hotkey-next
              KugouControlPoc direct-next
              KugouControlPoc direct-previous
              KugouControlPoc direct-toggle
              KugouControlPoc direct-stop
            """);
    }

    private static bool SameTrack(KugouPlaybackState left, KugouPlaybackState right)
    {
        return KugouNativeController.SamePlaybackIdentity(left, right);
    }

    private sealed record MediaSnapshot(
        string SourceAppUserModelId,
        string Title,
        string Artist,
        string AlbumTitle,
        string AlbumArtist,
        string Subtitle,
        int TrackNumber,
        string PlaybackStatus,
        TimeSpan Position,
        TimeSpan StartTime,
        TimeSpan EndTime,
        bool IsNextEnabled,
        bool IsPreviousEnabled,
        bool IsPlayEnabled,
        bool IsPauseEnabled);

    private sealed record MediaEvent(
        string Type,
        DateTimeOffset Timestamp,
        MediaSnapshot? State);

    private sealed record NativeMediaEvent(
        string Type,
        DateTimeOffset Timestamp,
        KugouPlaybackState State);

    private sealed record ControlResult(
        string Action,
        bool Accepted,
        DateTimeOffset Timestamp);

    private sealed record NativeTrackChangeProbe(
        NativeControlResult Control,
        bool TrackChanged,
        double DetectionLatencyMilliseconds,
        KugouPlaybackState Before,
        KugouPlaybackState After,
        string? Error);
}
