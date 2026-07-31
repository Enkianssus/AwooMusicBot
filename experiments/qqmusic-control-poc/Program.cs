using System.Text.Json;

namespace QQMusicControlPoc;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true
    };

    [STAThread]
    private static int Main(string[] args)
    {
        var command = args.FirstOrDefault()?.ToLowerInvariant() ?? "ui";

        try
        {
            if (command == "ui")
            {
                ApplicationConfiguration.Initialize();
                Application.Run(new MainForm());
                return 0;
            }

            if (command == "status")
            {
                WriteJson(QQMusicNativeController.ReadPlaybackState());
                return 0;
            }

            if (command == "analyze-native-next")
            {
                if (args.Length != 2 || args[1] != "--read-only")
                {
                    Console.Error.WriteLine(
                        "用法：analyze-native-next --read-only");
                    return 2;
                }

                var analysis =
                    QQMusicNativeNextAnalyzer.AnalyzeCurrent();
                WriteJson(analysis);
                return analysis.ExecutionAllowed ? 0 : 7;
            }

            if (command == "verify-next")
            {
                if (args.Length != 5
                    || !int.TryParse(args[3], out var timeoutSeconds)
                    || timeoutSeconds is < 2 or > 180
                    || args[4] != "--read-only")
                {
                    Console.Error.WriteLine(
                        "用法：verify-next \"expected-title\" "
                        + "\"expected-artist\" <2-180秒> --read-only");
                    return 2;
                }

                var result = QQMusicNextVerification.WaitAsync(
                        args[1],
                        args[2],
                        TimeSpan.FromSeconds(timeoutSeconds))
                    .GetAwaiter()
                    .GetResult();
                WriteJson(result);
                return result.ExpectedTrackConfirmed ? 0 : 7;
            }

            if (command == "inspect-windows")
            {
                WriteJson(QQMusicNativeController.InspectWindows());
                return 0;
            }

            if (command is "next" or "previous" or "toggle")
            {
                WriteJson(new
                {
                    Sent = false,
                    Transport = "Disabled",
                    Error = "已禁用 WM_APPCOMMAND/系统媒体键路径：它可能被浏览器或其他播放器接收。"
                });
                return 6;
            }

            if (command == "api-info")
            {
                using var client = QQMusicApiClient.Open();
                var version = client.GetVersion();
                var connected = client.GetQqUinForConnectionCheck() != 0;
                WriteJson(new
                {
                    Api = "QQMusicApi.QMApiCli",
                    Version = version,
                    ConnectedToLoggedInClient = connected
                });
                return 0;
            }

            if (command == "play-status-raw")
            {
                using var client = QQMusicApiClient.Open();
                WriteJson(new
                {
                    Transport = "QQMusicApi.WebPerform3",
                    Result = client.WebPerform3(
                        QQMusicWebProtocol.QueryPlayStatus())
                });
                return 0;
            }

            if (command == "list-info-raw")
            {
                using var client = QQMusicApiClient.Open();
                WriteJson(new
                {
                    Transport = "QQMusicApi.WebPerform3",
                    Result = client.WebPerform3(
                        QQMusicWebProtocol.QueryListInfo())
                });
                return 0;
            }

            if (command == "play-status")
            {
                using var reader =
                    new QQMusicPrivatePlaybackReader();
                WriteJson(reader.Read());
                return 0;
            }

            if (command == "session-status")
            {
                using var session = new QQMusicIpcSession();
                QQMusicPrivatePlaybackState? first = null;
                QQMusicPrivatePlaybackState? second = null;
                string? firstError = null;
                string? secondError = null;
                try
                {
                    first = session.ReadAsync()
                        .GetAwaiter()
                        .GetResult();
                }
                catch (Exception exception)
                {
                    firstError = $"{exception.GetType().Name}: "
                        + exception.Message;
                }

                try
                {
                    second = session.ReadAsync()
                        .GetAwaiter()
                        .GetResult();
                }
                catch (Exception exception)
                {
                    secondError = $"{exception.GetType().Name}: "
                        + exception.Message;
                }

                WriteJson(new
                {
                    Transport = "SingleStaQQMusicApiSession",
                    session.EndpointHandle,
                    First = first,
                    Second = second,
                    FirstError = firstError,
                    SecondError = secondError,
                    StableIdentityUnchanged =
                        first is not null
                        && second is not null
                        && first.StableIdentity == second.StableIdentity
                });
                return first is not null && second is not null ? 0 : 7;
            }

            if (command == "endpoint")
            {
                using var bridge = QQMusicPrivateBridge.Open();
                WriteJson(new
                {
                    Transport = "QQMusicApi.CQMApiSvr",
                    WindowHandle = bridge.FindPrivateEndpoint()
                });
                return 0;
            }

            if (command == "endpoint-debug")
            {
                var probes = new List<object>();
                foreach (var classId in new[]
                         {
                             QQMusicPrivateBridge.ClsidApiServer,
                             QQMusicPrivateBridge.ClsidApiAlias
                         })
                {
                    try
                    {
                        using var bridge =
                            QQMusicPrivateBridge.Open(classId: classId);
                        probes.Add(new
                        {
                            ClassId = classId,
                            ReportedWindowHandle =
                                bridge.FindReportedEndpoint(),
                            VerifiedWindowHandle =
                                bridge.FindPrivateEndpoint(),
                            Error = (string?)null
                        });
                    }
                    catch (Exception exception)
                    {
                        probes.Add(new
                        {
                            ClassId = classId,
                            ReportedWindowHandle = 0L,
                            VerifiedWindowHandle = 0L,
                            Error = $"{exception.GetType().Name}: "
                                + exception.Message
                        });
                    }
                }

                WriteJson(probes);
                return 0;
            }

            if (command == "endpoint-vtable")
            {
                using var bridge = QQMusicPrivateBridge.Open();
                using var process =
                    System.Diagnostics.Process.GetCurrentProcess();
                var modules = process.Modules
                    .Cast<System.Diagnostics.ProcessModule>()
                    .ToArray();
                WriteJson(bridge.ReadInterfaceVtable()
                    .Select((address, index) =>
                    {
                        var module = modules.FirstOrDefault(candidate =>
                            address >= candidate.BaseAddress
                            && address
                                < candidate.BaseAddress
                                + candidate.ModuleMemorySize);
                        return new
                        {
                            Index = index,
                            Address = $"0x{address:X8}",
                            Module = module?.ModuleName,
                            ModuleBase = module is null
                                ? null
                                : $"0x{module.BaseAddress:X8}",
                            RelativeAddress = module is null
                                ? null
                                : $"0x{address
                                    - module.BaseAddress:X8}"
                        };
                    }));
                return 0;
            }

            if (command == "bridge-init")
            {
                using var bridge = QQMusicPrivateBridge.Open();
                var before = bridge.FindReportedEndpoint();
                bridge.Initialize();
                WriteJson(new
                {
                    Transport = "QQMusicApi.CQMApiSvr.Init",
                    BeforeWindowHandle = before,
                    AfterWindowHandle = bridge.FindReportedEndpoint(),
                    Initialized = true
                });
                return 0;
            }

            if (command == "search")
            {
                var query = string.Join(' ', args.Skip(1)).Trim();
                using var catalog = new QQMusicCatalogClient();
                var result = catalog
                    .SearchAsync(query)
                    .GetAwaiter()
                    .GetResult();
                WriteJson(result);
                return 0;
            }

            if (command == "search-raw")
            {
                var query = string.Join(' ', args.Skip(1)).Trim();
                using var catalog = new QQMusicCatalogClient();
                Console.WriteLine(
                    catalog.SearchRawAsync(query)
                        .GetAwaiter()
                        .GetResult());
                return 0;
            }

            if (command == "search-legacy-raw")
            {
                var query = string.Join(' ', args.Skip(1)).Trim();
                using var catalog = new QQMusicCatalogClient();
                Console.WriteLine(
                    catalog.SearchLegacyRawAsync(query)
                        .GetAwaiter()
                        .GetResult());
                return 0;
            }

            if (command == "play-id-internal")
            {
                if (args.Length != 4
                    || !long.TryParse(args[1], out var songId)
                    || !int.TryParse(args[2], out var songType)
                    || args[3] != "--confirm-live-test")
                {
                    Console.Error.WriteLine(
                        "用法：play-id-internal <songid> "
                        + "<songtype> --confirm-live-test");
                    return 2;
                }

                var result =
                    QQMusicInternalCommandTransport.SendSongAsync(
                            QQMusicSongCommand.PlaySong,
                            songId,
                            songType)
                        .GetAwaiter()
                        .GetResult();
                WriteJson(result);
                return result.RequestedSongConfirmed ? 0 : 7;
            }

            if (command == "session-play-id")
            {
                if (args.Length != 4
                    || !long.TryParse(args[1], out var songId)
                    || !int.TryParse(args[2], out var songType)
                    || args[3] != "--confirm-live-test")
                {
                    Console.Error.WriteLine(
                        "用法：session-play-id <songid> "
                        + "<songtype> --confirm-live-test");
                    return 2;
                }

                using var session = new QQMusicIpcSession();
                var result = session.SendSongAsync(
                        QQMusicSongCommand.PlaySong,
                        songId,
                        songType)
                    .GetAwaiter()
                    .GetResult();
                WriteJson(result);
                return result.RequestedSongConfirmed ? 0 : 7;
            }

            if (command == "single-play")
            {
                if (args.Length != 6
                    || !long.TryParse(args[1], out var songId)
                    || !int.TryParse(args[2], out var songType)
                    || args[5] != "--confirm-live-test")
                {
                    Console.Error.WriteLine(
                        "用法：single-play <songid> <songtype> "
                        + "\"expected-title\" \"expected-artist\" "
                        + "--confirm-live-test");
                    return 2;
                }

                var result =
                    QQMusicSingleInstanceTransport.SendSongAsync(
                            songId,
                            songType,
                            args[3],
                            args[4])
                        .GetAwaiter()
                        .GetResult();
                WriteJson(result);
                return result.ExpectedTrackConfirmed ? 0 : 7;
            }

            if (command == "single-insert-next")
            {
                if (args.Length != 4
                    || !long.TryParse(args[1], out var songId)
                    || !int.TryParse(args[2], out var songType)
                    || args[3] != "--confirm-live-test")
                {
                    Console.Error.WriteLine(
                        "用法：single-insert-next <songid> "
                        + "<songtype> --confirm-live-test");
                    return 2;
                }

                var result =
                    QQMusicNativeNextTransport.InsertAsync(
                            new QQMusicSongReference(
                                songId,
                                songType))
                        .GetAwaiter()
                        .GetResult();
                WriteJson(result);
                return result.CommandSent
                    && result.PatchApplied
                    && result.OriginalCodeRestored
                    && result.ForegroundUnchanged
                        ? 0
                        : 7;
            }

            if (command == "capture-addsongs")
            {
                if (args.Length != 3
                    || !int.TryParse(
                        args[1],
                        out var timeoutSeconds)
                    || timeoutSeconds is < 5 or > 180
                    || args[2] != "--confirm-live-capture")
                {
                    Console.Error.WriteLine(
                        "用法：capture-addsongs <5-180秒> "
                        + "--confirm-live-capture");
                    return 2;
                }

                var result =
                    QQMusicNativeAddSongsCapture.CaptureAsync(
                            TimeSpan.FromSeconds(
                                timeoutSeconds))
                        .GetAwaiter()
                        .GetResult();
                WriteJson(result);
                return result.Captured
                    && result.OriginalCodeRestored
                        ? 0
                        : 7;
            }

            if (command is
                "probe-songitem"
                or "probe-songitem-internal"
                or "probe-songitem-hidden"
                )
            {
                if (args.Length != 4
                    || !long.TryParse(args[1], out var songId)
                    || !int.TryParse(args[2], out var songType)
                    || args[3] != "--confirm-live-test")
                {
                    Console.Error.WriteLine(
                        $"用法：{command} <songid> <songtype> "
                        + "--confirm-live-test");
                    return 2;
                }

                var result =
                    QQMusicNativeSongItemProbe.RunAsync(
                            new QQMusicSongReference(
                                songId,
                                songType),
                            false,
                            command != "probe-songitem-internal",
                            command == "probe-songitem-hidden")
                        .GetAwaiter()
                        .GetResult();
                WriteJson(result);
                return result.Verification is
                    "NativeSongItemResolvedCurrentTrackUnchanged"
                    or "ExactNativeAddSongsReturnedCurrentTrackUnchanged"
                        ? 0
                        : 7;
            }

            if (command == "single-queue")
            {
                if (args.Length != 8
                    || !long.TryParse(args[1], out var firstSongId)
                    || !int.TryParse(args[2], out var firstSongType)
                    || !long.TryParse(args[3], out var secondSongId)
                    || !int.TryParse(args[4], out var secondSongType)
                    || args[7] != "--confirm-live-test")
                {
                    Console.Error.WriteLine(
                        "用法：single-queue "
                        + "<first-id> <first-type> "
                        + "<second-id> <second-type> "
                        + "\"first-title\" \"first-artist\" "
                        + "--confirm-live-test");
                    return 2;
                }

                var result =
                    QQMusicSingleInstanceTransport.SendQueueAsync(
                            [
                                new QQMusicSongReference(
                                    firstSongId,
                                    firstSongType),
                                new QQMusicSongReference(
                                    secondSongId,
                                    secondSongType)
                            ],
                            args[5],
                            args[6])
                        .GetAwaiter()
                        .GetResult();
                WriteJson(result);
                return result.ExpectedTrackConfirmed ? 0 : 7;
            }

            if (command == "prepare-test-queue")
            {
                if (args.Length != 6
                    || !long.TryParse(args[1], out var firstSongId)
                    || !int.TryParse(args[2], out var firstSongType)
                    || !long.TryParse(args[3], out var secondSongId)
                    || !int.TryParse(args[4], out var secondSongType)
                    || args[5] != "--confirm-live-test")
                {
                    Console.Error.WriteLine(
                        "用法：prepare-test-queue "
                        + "<first-songid> <first-songtype> "
                        + "<second-songid> <second-songtype> "
                        + "--confirm-live-test");
                    return 2;
                }

                var result =
                    QQMusicInternalCommandTransport.SendQueueAsync(
                            [
                                new QQMusicSongReference(
                                    firstSongId,
                                    firstSongType),
                                new QQMusicSongReference(
                                    secondSongId,
                                    secondSongType)
                            ])
                        .GetAwaiter()
                        .GetResult();
                WriteJson(result);
                return result.FirstSongTransitionConfirmed ? 0 : 7;
            }

            if (command == "control-internal")
            {
                var validShape = args.Length is 3 or 5
                    && args[^1] == "--confirm-live-test";
                var expectedSong =
                    args.Length == 5
                    && long.TryParse(args[2], out var expectedSongId)
                    && int.TryParse(args[3], out var expectedSongType)
                        ? new QQMusicSongReference(
                            expectedSongId,
                            expectedSongType)
                        : null;
                if (!validShape
                    || (args.Length == 5 && expectedSong is null)
                    || !TryParsePlaybackControl(
                        args.ElementAtOrDefault(1),
                        out var playbackControl))
                {
                    Console.Error.WriteLine(
                        "用法：control-internal "
                        + "<prev|next|pause|play> "
                        + "[expected-songid expected-songtype] "
                        + "--confirm-live-test");
                    return 2;
                }

                var result =
                    QQMusicPlaybackControlTransport.SendAsync(
                            playbackControl,
                            expectedSong)
                        .GetAwaiter()
                        .GetResult();
                WriteJson(result);
                return expectedSong is null
                    ? result.Sent ? 0 : 7
                    : result.ExpectedSongConfirmed ? 0 : 7;
            }

            if (command == "session-control")
            {
                var validShape = args.Length is 3 or 5
                    && args[^1] == "--confirm-live-test";
                var expectedSong =
                    args.Length == 5
                    && long.TryParse(args[2], out var expectedSongId)
                    && int.TryParse(args[3], out var expectedSongType)
                        ? new QQMusicSongReference(
                            expectedSongId,
                            expectedSongType)
                        : null;
                if (!validShape
                    || (args.Length == 5 && expectedSong is null)
                    || !TryParsePlaybackControl(
                        args.ElementAtOrDefault(1),
                        out var playbackControl))
                {
                    Console.Error.WriteLine(
                        "用法：session-control "
                        + "<prev|next|pause|play> "
                        + "[expected-songid expected-songtype] "
                        + "--confirm-live-test");
                    return 2;
                }

                using var session = new QQMusicIpcSession();
                var result = session.SendControlAsync(
                        playbackControl,
                        expectedSong)
                    .GetAwaiter()
                    .GetResult();
                WriteJson(result);
                return expectedSong is null
                    ? result.Sent && result.Error is null ? 0 : 7
                    : result.ExpectedSongConfirmed ? 0 : 7;
            }

            if (command == "single-control")
            {
                var validShape = args.Length is 3 or 5
                    && args[^1] == "--confirm-live-test";
                if (!validShape
                    || !TryParsePlaybackControl(
                        args.ElementAtOrDefault(1),
                        out var playbackControl))
                {
                    Console.Error.WriteLine(
                        "用法：single-control "
                        + "<prev|next|pause|play> "
                        + "[\"expected-title\" \"expected-artist\"] "
                        + "--confirm-live-test");
                    return 2;
                }

                var result =
                    QQMusicSingleInstanceTransport.SendControlAsync(
                            playbackControl,
                            args.Length == 5 ? args[2] : null,
                            args.Length == 5 ? args[3] : null)
                        .GetAwaiter()
                        .GetResult();
                WriteJson(result);
                return args.Length == 5
                    ? result.ExpectedTrackConfirmed ? 0 : 7
                    : result.Sent && result.Error is null ? 0 : 7;
            }

            Console.Error.WriteLine($"未知命令：{command}");
            return 2;
        }
        catch (Exception exception)
        {
            WriteJson(new
            {
                Error = exception.Message,
                Type = exception.GetType().FullName,
                HResult = $"0x{exception.HResult:X8}"
            });
            return 1;
        }
    }

    private static void WriteJson<T>(T value)
    {
        Console.WriteLine(JsonSerializer.Serialize(value, JsonOptions));
    }

    private static bool TryParsePlaybackControl(
        string? value,
        out QQMusicPlaybackControl control)
    {
        control = value?.ToLowerInvariant() switch
        {
            "prev" => QQMusicPlaybackControl.Previous,
            "next" => QQMusicPlaybackControl.Next,
            "pause" => QQMusicPlaybackControl.Pause,
            "play" => QQMusicPlaybackControl.Play,
            _ => default
        };
        return value?.ToLowerInvariant()
            is "prev" or "next" or "pause" or "play";
    }
}
