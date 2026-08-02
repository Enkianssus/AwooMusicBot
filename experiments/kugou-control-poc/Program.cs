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

        if (command == "inspect-window-objects")
        {
            WriteJson(KugouWindowObjectProbe.Inspect());
            return 0;
        }

        if (command == "inspect-ipc-window-object")
        {
            WriteJson(KugouWindowObjectProbe.InspectIpcWindow());
            return 0;
        }

        if (command == "inspect-playback-listeners")
        {
            WriteJson(KugouWindowObjectProbe.InspectPlaybackListeners());
            return 0;
        }

        if (command == "inspect-playback-directions")
        {
            WriteJson(
                KugouWindowObjectProbe.InspectPlaybackDirectionCandidates());
            return 0;
        }

        if (command == "inspect-playback-mode-listeners")
        {
            WriteJson(
                KugouWindowObjectProbe.InspectPlaybackModeListeners());
            return 0;
        }

        if (command == "inspect-playback-insertion-anchor")
        {
            WriteJson(KugouPlaybackAnchorResetProbe.Inspect());
            return 0;
        }

        if (command == "reset-playback-insertion-anchor")
        {
            if (args.Length != 2
                || !int.TryParse(args[1], out var expectedCurrentItem)
                || expectedCurrentItem <= 0)
            {
                Console.Error.WriteLine(
                    "Usage: reset-playback-insertion-anchor <expected-current-item-id>");
                return 2;
            }

            var result = KugouPlaybackAnchorResetProbe.ResetToCurrent(
                expectedCurrentItem);
            WriteJson(result);
            return result.Applied ? 0 : 5;
        }

        if (command == "set-playback-insertion-anchor-id")
        {
            if (args.Length != 3
                || !int.TryParse(args[1], out var expectedAnchorItem)
                || !int.TryParse(args[2], out var requestedAnchorItem)
                || expectedAnchorItem <= 0
                || requestedAnchorItem <= 0)
            {
                Console.Error.WriteLine(
                    "Usage: set-playback-insertion-anchor-id <expected-anchor-item-id> <requested-anchor-item-id>");
                return 2;
            }

            var result = KugouPlaybackAnchorResetProbe.SetForExperiment(
                expectedAnchorItem,
                requestedAnchorItem);
            WriteJson(result);
            return result.Applied ? 0 : 5;
        }

        if (command == "set-playback-direction")
        {
            if (args.Length != 3
                || !int.TryParse(args[1], out var listenerIndex)
                || !int.TryParse(args[2], out var direction))
            {
                Console.Error.WriteLine(
                    "Usage: set-playback-direction <41|81> <0|1|2>");
                return 2;
            }

            var result = KugouWindowObjectProbe.SetPlaybackDirection(
                listenerIndex,
                direction);
            WriteJson(result);
            return result.Written ? 0 : 5;
        }

        if (command == "inspect-ipc")
        {
            WriteJson(KugouNativeController.InspectIpcEndpoint());
            return 0;
        }

        if (command == "inspect-modules")
        {
            var processes = Process.GetProcessesByName("KuGou")
                .Select(process =>
                {
                    try
                    {
                        return new
                        {
                            process.Id,
                            MainWindowHandle = process.MainWindowHandle.ToInt64(),
                            process.MainWindowTitle,
                            Modules = process.Modules
                                .Cast<ProcessModule>()
                                .Select(module => new
                                {
                                    module.ModuleName,
                                    module.FileName,
                                    BaseAddress = module.BaseAddress.ToInt64(),
                                    module.ModuleMemorySize
                                })
                                .ToArray()
                        };
                    }
                    catch (Exception exception)
                    {
                        return new
                        {
                            process.Id,
                            MainWindowHandle = process.MainWindowHandle.ToInt64(),
                            process.MainWindowTitle,
                            Modules = new[]
                            {
                                new
                                {
                                    ModuleName = "<error>",
                                    FileName = $"{exception.GetType().Name}: {exception.Message}",
                                    BaseAddress = 0L,
                                    ModuleMemorySize = 0
                                }
                            }
                        };
                    }
                })
                .ToArray();
            WriteJson(processes);
            return 0;
        }

        if (command == "inspect-queue-controller")
        {
            WriteJson(KugouQueueNativeProbe.InspectController());
            return 0;
        }

        if (command == "inspect-queue-insertion-state")
        {
            WriteJson(KugouQueueNativeProbe.InspectInsertionState());
            return 0;
        }

        if (command == "inspect-insertion-cursor-resolution")
        {
            WriteJson(KugouQueueNativeProbe.InspectInsertionCursorResolution());
            return 0;
        }

        if (command == "capture-queue-insert-args")
        {
            if (args.Length < 9)
            {
                Console.Error.WriteLine(
                    "Usage: capture-queue-insert-args <Play> <Insert> <Force> <Clear> <Index> <AddPlayQueue> <AddToDefaultList> <query>");
                return 2;
            }

            var query = string.Join(' ', args.Skip(8)).Trim();
            var result = await KugouQueueNativeProbe.CaptureInsertArgumentsAsync(
                query,
                args[1],
                args[2],
                args[3],
                args[4],
                args[5],
                args[6],
                args[7]);
            WriteJson(result);
            return result.OriginalSlotRestored
                && result.InvocationCount > 0
                ? 0
                : 5;
        }

        if (command == "capture-insertion-cursor")
        {
            var query = string.Join(' ', args.Skip(1)).Trim();
            if (string.IsNullOrWhiteSpace(query))
            {
                Console.Error.WriteLine(
                    "Usage: capture-insertion-cursor <search query>");
                return 2;
            }

            var result = await KugouQueueNativeProbe
                .CaptureInsertionCursorDuringInsertAsync(query);
            WriteJson(result);
            return result.OriginalSlotRestored
                && result.InvocationCount > 0
                ? 0
                : 5;
        }

        if (command == "capture-model-record-insert")
        {
            var query = string.Join(' ', args.Skip(1)).Trim();
            if (string.IsNullOrWhiteSpace(query))
            {
                Console.Error.WriteLine(
                    "Usage: capture-model-record-insert <search query>");
                return 2;
            }

            var result = await KugouQueueNativeProbe
                .CaptureModelRecordInsertionAsync(query);
            WriteJson(result);
            return result.OriginalCallRestored
                && result.InvocationCount > 0
                && result.CompletionCount > 0
                ? 0
                : 5;
        }

        if (command == "reset-anchor-history")
        {
            var result = KugouAnchorHistoryResetProbe.Reset();
            WriteJson(result);
            return result.RemoteExitCode == 1
                && result.ResetToCurrentAnchor
                && result.TrackUnchanged
                    ? 0
                    : 5;
        }

        if (command == "inspect-ui-queue-controller")
        {
            WriteJson(KugouQueueNativeProbe.InspectUiController());
            return 0;
        }

        if (command == "read-ui-queue-position")
        {
            WriteJson(KugouQueueNativeProbe.ReadUiQueuePosition());
            return 0;
        }

        if (command == "probe-playback-position-memory")
        {
            WriteJson(KugouPlaybackPositionMemoryProbe.Run());
            return 0;
        }

        if (command == "probe-true-insert-next")
        {
            var query = string.Join(' ', args.Skip(1)).Trim();
            if (string.IsNullOrWhiteSpace(query))
            {
                Console.Error.WriteLine(
                    "Usage: probe-true-insert-next <search query>");
                return 2;
            }

            var result = await KugouTrueNextProbe.RunAsync(query);
            WriteJson(result);
            return result.TargetBecameCurrent ? 0 : 5;
        }

        if (command == "resolve-search-track")
        {
            var query = string.Join(' ', args.Skip(1)).Trim();
            if (string.IsNullOrWhiteSpace(query))
            {
                Console.Error.WriteLine("Usage: resolve-search-track <search query>");
                return 2;
            }

            WriteJson(await KugouNativeController.ResolveSearchTrackAsync(query));
            return 0;
        }

        if (command == "probe-insertion-anchor")
        {
            var separator = Array.IndexOf(args, "--then");
            if (separator <= 1 || separator >= args.Length - 1)
            {
                Console.Error.WriteLine(
                    "Usage: probe-insertion-anchor <first query> --then <second query>");
                return 2;
            }

            var firstQuery = string.Join(' ', args.Skip(1).Take(separator - 1));
            var secondQuery = string.Join(' ', args.Skip(separator + 1));
            var result = await KugouInsertionAnchorProbe.RunAsync(
                firstQuery,
                secondQuery);
            WriteJson(result);
            return result.Candidates.Count == 1 ? 0 : 5;
        }

        if (command == "probe-insertion-anchor-values")
        {
            var separator = Array.IndexOf(args, "--then");
            if (separator <= 1 || separator >= args.Length - 1)
            {
                Console.Error.WriteLine(
                    "Usage: probe-insertion-anchor-values <first query> --then <second query>");
                return 2;
            }

            var firstQuery = string.Join(' ', args.Skip(1).Take(separator - 1));
            var secondQuery = string.Join(' ', args.Skip(separator + 1));
            var result = await KugouInsertionAnchorValueProbe.RunAsync(
                firstQuery,
                secondQuery);
            WriteJson(result);
            return result.Candidates.Count == 1 ? 0 : 5;
        }

        if (command == "reset-insertion-anchor")
        {
            var result = KugouQueueNativeProbe.ResetInsertionAnchor();
            WriteJson(result);
            return result.Reset ? 0 : 5;
        }

        if (command == "inspect-insertion-anchors")
        {
            WriteJson(KugouQueueNativeProbe.CaptureInsertionAnchors());
            return 0;
        }

        if (command == "probe-reset-anchor-insert-next")
        {
            var separator = Array.IndexOf(args, "--then");
            if (separator <= 1 || separator >= args.Length - 1)
            {
                Console.Error.WriteLine(
                    "Usage: probe-reset-anchor-insert-next <dirty query> --then <expected next query>");
                return 2;
            }

            var dirtyQuery = string.Join(' ', args.Skip(1).Take(separator - 1));
            var expectedQuery = string.Join(' ', args.Skip(separator + 1));
            var result = await KugouResetAnchorInsertProbe.RunAsync(
                dirtyQuery,
                expectedQuery);
            WriteJson(result);
            return result.ExpectedTrackPlayed ? 0 : 5;
        }

        if (command == "query-queue-ids-by-hash")
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine(
                    "用法：query-queue-ids-by-hash <32位歌曲hash> [modelType]。");
                return 2;
            }

            var modelType = args.Length >= 3
                && int.TryParse(args[2], out var parsedModelType)
                    ? parsedModelType
                    : 6;
            var vtableOffset = args.Length >= 4
                ? Convert.ToInt32(args[3], 16)
                : 0xA8;
            WriteJson(KugouQueueNativeProbe.QueryQueueIdsByHash(
                args[1],
                modelType,
                vtableOffset));
            return 0;
        }

        if (command == "scan-hash-memory")
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine(
                    "用法：scan-hash-memory <32位歌曲hash>。");
                return 2;
            }

            WriteJson(KugouProcessHashScanner.Scan(args[1]));
            return 0;
        }

        if (command == "scan-pointer-memory")
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine(
                    "用法：scan-pointer-memory <十进制或 0x 十六进制地址>。");
                return 2;
            }

            var address = args[1].StartsWith(
                "0x",
                StringComparison.OrdinalIgnoreCase)
                    ? Convert.ToInt64(args[1][2..], 16)
                    : Convert.ToInt64(args[1]);
            WriteJson(KugouProcessHashScanner.ScanPointer(address));
            return 0;
        }

        if (command == "read-memory-dwords")
        {
            if (args.Length < 3)
            {
                Console.Error.WriteLine(
                    "用法：read-memory-dwords <地址> <数量>。");
                return 2;
            }

            var address = args[1].StartsWith(
                "0x",
                StringComparison.OrdinalIgnoreCase)
                    ? Convert.ToInt64(args[1][2..], 16)
                    : Convert.ToInt64(args[1]);
            var count = Convert.ToInt32(args[2]);
            WriteJson(new
            {
                Address = address,
                Values = KugouProcessHashScanner.ReadDwords(address, count)
            });
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

        if (command == "background-search-fresh-next")
        {
            var query = string.Join(' ', args.Skip(1)).Trim();
            var searchResult =
                await KugouNativeController.SearchAsNextWithFreshContextAsync(query);
            WriteJson(searchResult);
            return searchResult.Sent
                && searchResult.ForegroundUnchanged
                ? 0
                : 5;
        }

        if (command == "background-search-anchor-next")
        {
            var query = string.Join(' ', args.Skip(1)).Trim();
            var anchor = KugouNativeController.ReadPlaybackState();
            var searchResult =
                await KugouNativeController.SearchAsAnchoredNextBackgroundAsync(
                    query,
                    anchor);
            WriteJson(new { Anchor = anchor, Result = searchResult });
            return searchResult.Sent
                && searchResult.ForegroundUnchanged
                ? 0
                : 5;
        }

        if (command == "background-search-custom")
        {
            if (args.Length < 9)
            {
                Console.Error.WriteLine(
                    "用法：background-search-custom <Play> <Insert> <Force> <Clear> <Index> <AddPlayQueue> <AddToDefaultList> <关键词>");
                return 2;
            }

            var query = string.Join(' ', args.Skip(8)).Trim();
            var result = await KugouNativeController.SearchWithQueueInfoAsync(
                query,
                args[1],
                args[2],
                args[3],
                args[4],
                args[5],
                args[6],
                args[7]);
            WriteJson(result);
            return result.Sent ? 0 : 5;
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
              KugouControlPoc reset-anchor-history
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
