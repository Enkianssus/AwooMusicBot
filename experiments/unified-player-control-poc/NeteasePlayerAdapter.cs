using System.Diagnostics;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace UnifiedPlayerControlPoc;

internal sealed class NeteasePlayerAdapter : IPlayerAdapter
{
    private readonly HttpClient _httpClient = new()
    {
        Timeout = TimeSpan.FromSeconds(12)
    };
    private readonly SemaphoreSlim _operationGate = new(1, 1);
    private readonly GuardedNextMonitor _nextGuard = new();
    private readonly object _trackSync = new();
    private readonly Dictionary<string, PlayerTrack> _knownTracks = [];
    private DateTime _playingListWriteTimeUtc;
    private IReadOnlyList<PlayerTrack> _playingList = [];

    private static readonly string PlayingListPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "NetEase",
        "CloudMusic",
        "webdata",
        "file",
        "playingList");

    public NeteasePlayerAdapter()
    {
        _httpClient.DefaultRequestHeaders.UserAgent.ParseAdd(
            "Mozilla/5.0 UnifiedPlayerControlPoc/1.0");
        _httpClient.DefaultRequestHeaders.Add(
            "Cookie",
            "os=pc; appver=3.1.37;");
        _httpClient.DefaultRequestHeaders.Accept.Add(
            new MediaTypeWithQualityHeaderValue("application/json"));
    }

    public string Key => "netease";

    public string DisplayName => "网易云音乐";

    public string TestedVersion => "3.1.37.205354";

    public PlayerCapabilities Capabilities { get; } = new(
        Search: true,
        PlaySelected: true,
        Previous: true,
        Pause: true,
        Resume: true,
        Toggle: false,
        Next: true,
        InsertNext: true,
        InsertNextLevel: "原生插入 + 错误下一首暂停接管守卫");

    public Task<PlayerSnapshot> ProbeAsync(CancellationToken cancellationToken)
    {
        return Task.Run(ReadSnapshot, cancellationToken);
    }

    public async Task<IReadOnlyList<PlayerTrack>> SearchAsync(
        string query,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(query);
        using var content = new FormUrlEncodedContent(
        [
            new KeyValuePair<string, string>("s", query.Trim()),
            new KeyValuePair<string, string>("type", "1"),
            new KeyValuePair<string, string>("limit", "20"),
            new KeyValuePair<string, string>("offset", "0")
        ]);
        using var response = await _httpClient.PostAsync(
            "https://music.163.com/api/search/get/web",
            content,
            cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(
            cancellationToken).ConfigureAwait(false);
        using var document = await JsonDocument.ParseAsync(
            stream,
            cancellationToken: cancellationToken).ConfigureAwait(false);

        if (!document.RootElement.TryGetProperty("result", out var result)
            || !result.TryGetProperty("songs", out var songs)
            || songs.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var tracks = songs
            .EnumerateArray()
            .Select(ParseSearchTrack)
            .Where(track => !string.IsNullOrWhiteSpace(track.Id))
            .ToArray();
        lock (_trackSync)
        {
            foreach (var track in tracks)
            {
                _knownTracks[track.Id] = track;
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
        try
        {
            var before = await ProbeAsync(cancellationToken).ConfigureAwait(false);
            if (!before.Connected)
            {
                return new PlayerOperationResult(
                    OperationOutcome.Rejected,
                    "网易云未连接；没有发现网易云原生播放器窗口。",
                    before);
            }

            NeteaseIpcSendResult sent;
            switch (command)
            {
                case PlayerCommand.Previous:
                    sent = await Task.Run(
                        () => NeteaseNativeIpc.SendNativeCommand(
                            NeteaseNativeCommand.Previous),
                        cancellationToken).ConfigureAwait(false);
                    break;
                case PlayerCommand.Next:
                    sent = await Task.Run(
                        () => NeteaseNativeIpc.SendNativeCommand(
                            NeteaseNativeCommand.Next),
                        cancellationToken).ConfigureAwait(false);
                    break;
                case PlayerCommand.Pause:
                    sent = await Task.Run(
                        () => NeteaseNativeIpc.SendNativeCommand(
                            NeteaseNativeCommand.PlayPause),
                        cancellationToken).ConfigureAwait(false);
                    break;
                case PlayerCommand.Resume:
                    sent = await Task.Run(
                        () => NeteaseNativeIpc.SendNativeCommand(
                            NeteaseNativeCommand.PlayPause),
                        cancellationToken).ConfigureAwait(false);
                    break;
                case PlayerCommand.PlaySelected when track is not null:
                    RegisterKnownTrack(track);
                    _nextGuard.Cancel(
                        "下一首守卫已因立即播放其他歌曲而取消");
                    sent = await Task.Run(
                        () => NeteaseNativeIpc.SendWebCommand(new
                        {
                            cmd = "play",
                            type = "song",
                            id = track.Id
                        }),
                        cancellationToken).ConfigureAwait(false);
                    break;
                case PlayerCommand.InsertNext when track is not null:
                    RegisterKnownTrack(track);
                    sent = await Task.Run(
                        () => NeteaseNativeIpc.SendWebCommand(new
                        {
                            cmd = "playingList",
                            type = "addToNext",
                            value = track.Id
                        }),
                        cancellationToken).ConfigureAwait(false);
                    break;
                default:
                    return new PlayerOperationResult(
                        OperationOutcome.Unsupported,
                        "网易云适配器不支持该命令。",
                        before);
            }

            if (!sent.Delivered)
            {
                if (command == PlayerCommand.InsertNext
                    && track is not null
                    && ArmNextGuard(
                        before,
                        track,
                        cancellationToken,
                        out var guardMessage))
                {
                    return new PlayerOperationResult(
                        OperationOutcome.Accepted,
                        $"{sent.Message} 原生插入失败，但{guardMessage}",
                        before);
                }

                return new PlayerOperationResult(
                    OperationOutcome.Rejected,
                    sent.Message,
                    await ProbeAsync(cancellationToken).ConfigureAwait(false));
            }

            if (command is PlayerCommand.Pause or PlayerCommand.Resume)
            {
                return new PlayerOperationResult(
                    OperationOutcome.Accepted,
                    $"{sent.Message} 当前 PoC 没有可靠播放状态字段，未把投递误报为状态验证。",
                    await ProbeAsync(cancellationToken).ConfigureAwait(false));
            }

            if (command == PlayerCommand.InsertNext)
            {
                var insertGuardMessage = string.Empty;
                var armed = track is not null
                    && ArmNextGuard(
                        before,
                        track,
                        cancellationToken,
                        out insertGuardMessage);
                return new PlayerOperationResult(
                    armed
                        ? OperationOutcome.Accepted
                        : OperationOutcome.Indeterminate,
                    $"{sent.Message} 网易云已接收原生插入。"
                    + (armed
                        ? $" {insertGuardMessage}"
                        : " 下一曲守卫未能启动。"),
                    await ProbeAsync(cancellationToken).ConfigureAwait(false));
            }

            var deadline = DateTimeOffset.UtcNow
                + (command is PlayerCommand.Next or PlayerCommand.Previous
                    ? TimeSpan.FromSeconds(4)
                    : TimeSpan.FromSeconds(8));
            var after = before;
            while (DateTimeOffset.UtcNow < deadline)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await Task.Delay(100, cancellationToken).ConfigureAwait(false);
                after = await ProbeAsync(cancellationToken).ConfigureAwait(false);
                if (command == PlayerCommand.PlaySelected && track is not null)
                {
                    if (TrackMatches(after.Current, track))
                    {
                        return new PlayerOperationResult(
                            OperationOutcome.Verified,
                            $"已精确观察到目标歌曲：{track.DisplayName}",
                            after);
                    }
                }
                else if (HasTrackChanged(before.Current, after.Current))
                {
                    return new PlayerOperationResult(
                        OperationOutcome.Applied,
                        $"已观察到切歌：{after.Current?.DisplayName ?? "未知歌曲"}",
                        after);
                }
            }

            return new PlayerOperationResult(
                OperationOutcome.Indeterminate,
                $"{sent.Message} 等待期间未观察到可确认的歌曲变化。",
                after);
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public ValueTask DisposeAsync()
    {
        _nextGuard.Dispose();
        _httpClient.Dispose();
        _operationGate.Dispose();
        return ValueTask.CompletedTask;
    }

    private PlayerSnapshot ReadSnapshot()
    {
        var endpoint = NeteaseNativeIpc.FindEndpoint();
        if (endpoint is null)
        {
            return new PlayerSnapshot(
                false,
                DisplayName,
                null,
                string.Empty,
                "未连接：没有发现网易云原生播放器窗口",
                null,
                DateTimeOffset.Now);
        }

        RefreshPlayingListIfNeeded();
        var windowTitle = NeteaseNativeIpc.FindPlayerWindowTitle(
            endpoint.ProcessId);
        var current = MatchWindowTitle(windowTitle);
        var version = NeteaseNativeIpc.TryGetProcessVersion(
            endpoint.ProcessId);
        var status = string.IsNullOrWhiteSpace(windowTitle)
            ? "原生控制已连接，等待歌曲窗口标题"
            : current is null
                ? "原生控制已连接，歌曲 ID 暂未精确解析"
                : "原生控制已连接，当前歌曲 ID 已解析";
        if (!string.IsNullOrWhiteSpace(_nextGuard.Status))
        {
            status += $"；{_nextGuard.Status}";
        }

        return new PlayerSnapshot(
            true,
            DisplayName,
            endpoint.ProcessId,
            version,
            status,
            current ?? CreateTitleFallback(windowTitle),
            DateTimeOffset.Now);
    }

    private bool ArmNextGuard(
        PlayerSnapshot before,
        PlayerTrack target,
        CancellationToken cancellationToken,
        out string message)
    {
        RegisterKnownTrack(target);
        return _nextGuard.Arm(
            before.Current,
            target,
            ReadCurrentForGuardAsync,
            TakeOverGuardedNextAsync,
            cancellationToken,
            out message);
    }

    private Task<PlayerTrack?> ReadCurrentForGuardAsync(
        CancellationToken cancellationToken)
    {
        return Task.Run(() =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            var endpoint = NeteaseNativeIpc.FindEndpoint();
            if (endpoint is null)
            {
                return null;
            }

            RefreshPlayingListIfNeeded();
            var title = NeteaseNativeIpc.FindPlayerWindowTitle(
                endpoint.ProcessId);
            return MatchWindowTitle(title) ?? CreateTitleFallback(title);
        }, cancellationToken);
    }

    private async Task<string> TakeOverGuardedNextAsync(
        PlayerTrack target,
        CancellationToken cancellationToken)
    {
        var pause = await Task.Run(
            () => NeteaseNativeIpc.SendWebCommand(
                new { cmd = "pause" }),
            cancellationToken).ConfigureAwait(false);
        if (!pause.Delivered)
        {
            return $"下一首接管失败：暂停错误歌曲失败；{pause.Message}";
        }

        var play = await Task.Run(
            () => NeteaseNativeIpc.SendWebCommand(new
            {
                cmd = "play",
                type = "song",
                id = target.Id
            }),
            cancellationToken).ConfigureAwait(false);
        return play.Delivered
            ? $"已暂停错误歌曲并切换目标：{target.DisplayName}"
            : $"已暂停错误歌曲，但目标播放失败：{play.Message}";
    }

    private void RegisterKnownTrack(PlayerTrack track)
    {
        lock (_trackSync)
        {
            _knownTracks[track.Id] = track;
        }
    }

    private void RefreshPlayingListIfNeeded()
    {
        try
        {
            if (!File.Exists(PlayingListPath))
            {
                return;
            }

            var writeTime = File.GetLastWriteTimeUtc(PlayingListPath);
            lock (_trackSync)
            {
                if (_playingList.Count > 0
                    && writeTime == _playingListWriteTimeUtc)
                {
                    return;
                }
            }

            IReadOnlyList<PlayerTrack>? parsed = null;
            for (var attempt = 0; attempt < 3 && parsed is null; attempt++)
            {
                try
                {
                    using var stream = new FileStream(
                        PlayingListPath,
                        FileMode.Open,
                        FileAccess.Read,
                        FileShare.ReadWrite | FileShare.Delete);
                    using var document = JsonDocument.Parse(stream);
                    parsed = ParsePlayingList(document.RootElement);
                }
                catch (Exception exception)
                    when (attempt < 2
                          && exception is IOException or JsonException)
                {
                    Thread.Sleep(20);
                }
            }

            if (parsed is not null)
            {
                lock (_trackSync)
                {
                    _playingList = parsed;
                    _playingListWriteTimeUtc = writeTime;
                }
            }
        }
        catch
        {
            // Keep the last good list. CloudMusic rewrites this file in place.
        }
    }

    private PlayerTrack? MatchWindowTitle(string title)
    {
        if (string.IsNullOrWhiteSpace(title)
            || title.Equals("网易云音乐", StringComparison.OrdinalIgnoreCase)
            || title.Equals(
                "NetEase Cloud Music",
                StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        List<PlayerTrack> candidates;
        lock (_trackSync)
        {
            candidates = _knownTracks.Values
                .Concat(_playingList)
                .GroupBy(track => track.Id, StringComparer.Ordinal)
                .Select(group => group.First())
                .ToList();
        }

        var normalizedTitle = NormalizeTitle(title);
        var exact = candidates
            .Where(track =>
                NormalizeTitle($"{track.Title} - {track.Artist}")
                == normalizedTitle)
            .ToArray();
        if (exact.Length == 1)
        {
            return exact[0];
        }

        var nameOnly = candidates
            .Where(track => NormalizeTitle(track.Title) == normalizedTitle)
            .ToArray();
        return nameOnly.Length == 1 ? nameOnly[0] : null;
    }

    private static PlayerTrack? CreateTitleFallback(string title)
    {
        if (string.IsNullOrWhiteSpace(title)
            || title.Equals("网易云音乐", StringComparison.OrdinalIgnoreCase)
            || title.Equals(
                "NetEase Cloud Music",
                StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var separator = title.IndexOf(" - ", StringComparison.Ordinal);
        return separator > 0
            ? new PlayerTrack(
                string.Empty,
                title[..separator].Trim(),
                title[(separator + 3)..].Trim(),
                string.Empty)
            : new PlayerTrack(string.Empty, title.Trim(), string.Empty, string.Empty);
    }

    private static IReadOnlyList<PlayerTrack> ParsePlayingList(
        JsonElement root)
    {
        if (!root.TryGetProperty("list", out var list)
            || list.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var tracks = new List<PlayerTrack>();
        foreach (var item in list.EnumerateArray())
        {
            var track = item.TryGetProperty("track", out var nested)
                        && nested.ValueKind == JsonValueKind.Object
                ? nested
                : item;
            var id = ReadJsonText(track, "id");
            var name = ReadJsonText(track, "name");
            if (string.IsNullOrWhiteSpace(id)
                || string.IsNullOrWhiteSpace(name))
            {
                continue;
            }

            tracks.Add(new PlayerTrack(
                id,
                name,
                ReadArtists(track),
                ReadAlbum(track)));
        }

        return tracks;
    }

    private static PlayerTrack ParseSearchTrack(JsonElement song)
    {
        return new PlayerTrack(
            ReadJsonText(song, "id"),
            ReadJsonText(song, "name"),
            ReadArtists(song),
            ReadAlbum(song));
    }

    private static string ReadArtists(JsonElement track)
    {
        JsonElement artists;
        if ((!track.TryGetProperty("artists", out artists)
             || artists.ValueKind != JsonValueKind.Array)
            && (!track.TryGetProperty("ar", out artists)
                || artists.ValueKind != JsonValueKind.Array))
        {
            return string.Empty;
        }

        return string.Join(
            "/",
            artists.EnumerateArray()
                .Select(artist => ReadJsonText(artist, "name"))
                .Where(name => !string.IsNullOrWhiteSpace(name)));
    }

    private static string ReadAlbum(JsonElement track)
    {
        JsonElement album;
        return ((track.TryGetProperty("album", out album)
                 && album.ValueKind == JsonValueKind.Object)
                || (track.TryGetProperty("al", out album)
                    && album.ValueKind == JsonValueKind.Object))
            ? ReadJsonText(album, "name")
            : string.Empty;
    }

    private static string ReadJsonText(
        JsonElement element,
        string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
        {
            return string.Empty;
        }

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? string.Empty,
            JsonValueKind.Number => value.GetRawText(),
            _ => string.Empty
        };
    }

    private static string NormalizeTitle(string value)
    {
        return string.Join(
            " ",
            value.Trim()
                .ToUpperInvariant()
                .Replace('–', '-')
                .Replace('—', '-')
                .Split(
                    (char[]?)null,
                    StringSplitOptions.TrimEntries
                    | StringSplitOptions.RemoveEmptyEntries));
    }

    private static bool TrackMatches(
        PlayerTrack? actual,
        PlayerTrack expected)
    {
        if (actual is null)
        {
            return false;
        }

        return !string.IsNullOrWhiteSpace(actual.Id)
            && actual.Id == expected.Id
            || (NormalizeTitle(actual.Title) == NormalizeTitle(expected.Title)
                && (string.IsNullOrWhiteSpace(expected.Artist)
                    || NormalizeTitle(actual.Artist)
                    == NormalizeTitle(expected.Artist)));
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

        return NormalizeTitle(before.DisplayName)
            != NormalizeTitle(after.DisplayName);
    }
}

internal sealed record NeteaseIpcEndpoint(int ProcessId, nint WindowHandle);

internal sealed record NeteaseIpcSendResult(
    bool Delivered,
    nuint ReceiverResult,
    string Message);

internal enum NeteaseNativeCommand
{
    Previous,
    Next,
    PlayPause
}

internal sealed record NeteaseWindowState(
    nint WindowHandle,
    int ProcessId,
    nint ForegroundWindow,
    bool WasVisible,
    bool WasMinimized,
    bool IsAuxiliaryOverlay,
    NeteaseWindowPlacement Placement);

internal sealed record NeteaseWindowDiagnostic(
    long Handle,
    int ProcessId,
    string ClassName,
    string Title,
    bool Visible,
    bool Minimized,
    bool Enabled,
    int Left,
    int Top,
    int Width,
    int Height);

[StructLayout(LayoutKind.Sequential)]
internal struct NeteaseWindowPoint
{
    public int X;
    public int Y;
}

[StructLayout(LayoutKind.Sequential)]
internal struct NeteaseWindowRect
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

[StructLayout(LayoutKind.Sequential)]
internal struct NeteaseWindowPlacement
{
    public int Length;
    public int Flags;
    public int ShowCommand;
    public NeteaseWindowPoint MinPosition;
    public NeteaseWindowPoint MaxPosition;
    public NeteaseWindowRect NormalPosition;
}

internal static class NeteaseNativeIpc
{
    private const uint IpcMessage = 0x8001;
    private const uint WindowMessageHotkey = 0x0312;
    private const uint HotkeyModifierControl = 0x0002;
    private const ushort VirtualKeyLeft = 0x25;
    private const ushort VirtualKeyRight = 0x27;
    private const ushort VirtualKeyP = 0x50;
    private const uint PageReadWrite = 0x04;
    private const uint FileMapWrite = 0x0002;
    private const int ErrorAlreadyExists = 183;
    private static readonly nint InvalidHandleValue = new(-1);
    private static readonly nint MessageOnlyWindow = new(-3);
    private static readonly object SendSync = new();
    private static uint _lastTick;

    public static NeteaseIpcEndpoint? FindEndpoint()
    {
        foreach (var process in Process.GetProcessesByName("cloudmusic")
                     .OrderByDescending(process => process.Id))
        {
            using (process)
            {
                var handle = FindNativeCommandWindow(process.Id);
                if (handle != nint.Zero)
                {
                    return new NeteaseIpcEndpoint(process.Id, handle);
                }
            }
        }

        return null;
    }

    public static string TryGetProcessVersion(int processId)
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

    public static string FindPlayerWindowTitle(int processId)
    {
        return FindPlayerWindow(processId).Title;
    }

    public static IReadOnlyList<NeteaseWindowDiagnostic> ListWindows()
    {
        var processIds = Process.GetProcessesByName("cloudmusic")
            .Select(process =>
            {
                using (process)
                {
                    return process.Id;
                }
            })
            .ToHashSet();
        var windows = new List<NeteaseWindowDiagnostic>();
        _ = EnumWindows(
            (window, unused) =>
            {
                _ = unused;
                GetWindowThreadProcessId(window, out var ownerProcessId);
                if (!processIds.Contains(ownerProcessId))
                {
                    return true;
                }

                _ = GetWindowRect(window, out var rectangle);
                windows.Add(new NeteaseWindowDiagnostic(
                    window.ToInt64(),
                    ownerProcessId,
                    ReadWindowClass(window),
                    ReadWindowTitle(window),
                    IsWindowVisible(window),
                    IsIconic(window),
                    IsWindowEnabled(window),
                    rectangle.Left,
                    rectangle.Top,
                    Math.Max(0, rectangle.Right - rectangle.Left),
                    Math.Max(0, rectangle.Bottom - rectangle.Top)));
                return true;
            },
            nint.Zero);
        return windows
            .OrderByDescending(window => window.Visible)
            .ThenByDescending(window => window.Width * window.Height)
            .ThenBy(window => window.ProcessId)
            .ToArray();
    }

    public static NeteaseIpcSendResult SendNativeCommand(
        NeteaseNativeCommand command)
    {
        var endpoint = FindEndpoint();
        if (endpoint is null)
        {
            return new NeteaseIpcSendResult(
                false,
                0,
                "没有发现网易云音乐主进程。");
        }

        var target = FindNativeCommandWindow(endpoint.ProcessId);
        if (target == nint.Zero)
        {
            return new NeteaseIpcSendResult(
                false,
                0,
                "没有发现属于网易云主进程的大尺寸 OrpheusBrowserHost。");
        }

        GetWindowThreadProcessId(target, out var targetProcessId);
        if (targetProcessId != endpoint.ProcessId
            || !IsCloudMusicProcess(targetProcessId))
        {
            return new NeteaseIpcSendResult(
                false,
                0,
                "目标窗口归属校验失败，已拒绝发送，避免误控其他播放器。");
        }

        var descriptor = command switch
        {
            NeteaseNativeCommand.Previous =>
                ("prev_local", VirtualKeyLeft),
            NeteaseNativeCommand.Next =>
                ("next_local", VirtualKeyRight),
            NeteaseNativeCommand.PlayPause =>
                ("play_pause_local", VirtualKeyP),
            _ => throw new ArgumentOutOfRangeException(nameof(command))
        };
        var commandAtom = GlobalFindAtom(descriptor.Item1);
        if (commandAtom == 0)
        {
            return new NeteaseIpcSendResult(
                false,
                0,
                $"网易云未注册内部命令 {descriptor.Item1}，当前版本可能不支持。");
        }

        var lParam = (nint)(
            ((uint)descriptor.Item2 << 16)
            | HotkeyModifierControl);
        if (!PostMessage(
                target,
                WindowMessageHotkey,
                commandAtom,
                lParam))
        {
            return new NeteaseIpcSendResult(
                false,
                0,
                $"网易云内部命令投递失败，Win32={Marshal.GetLastWin32Error()}。");
        }

        return new NeteaseIpcSendResult(
            true,
            commandAtom,
            $"已直接投递网易云内部命令 {descriptor.Item1}；"
            + "未生成键盘输入，不会交给 QQ 或其他媒体会话。");
    }

    private static nint FindNativeCommandWindow(int processId)
    {
        var bestHandle = nint.Zero;
        var bestRank = 0;
        long bestArea = 0;
        _ = EnumWindows(
            (window, unused) =>
            {
                _ = unused;
                GetWindowThreadProcessId(window, out var ownerProcessId);
                if (ownerProcessId != processId
                    || !ReadWindowClass(window).Equals(
                        "OrpheusBrowserHost",
                        StringComparison.OrdinalIgnoreCase)
                    || !GetWindowRect(window, out var rectangle))
                {
                    return true;
                }

                var width = Math.Max(0, rectangle.Right - rectangle.Left);
                var height = Math.Max(0, rectangle.Bottom - rectangle.Top);
                var area = (long)width * height;
                var isLargePlayerWindow = width >= 400 && height >= 300;
                var isMinimizedPlayerWindow = IsIconic(window)
                    && !string.IsNullOrWhiteSpace(ReadWindowTitle(window));
                var rank = isLargePlayerWindow
                    ? 2
                    : isMinimizedPlayerWindow
                        ? 1
                        : 0;
                if (rank > bestRank
                    || (rank == bestRank && rank > 0 && area > bestArea))
                {
                    bestRank = rank;
                    bestArea = area;
                    bestHandle = window;
                }

                return true;
            },
            nint.Zero);
        return bestHandle;
    }

    private static bool IsCloudMusicProcess(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return process.ProcessName.Equals(
                "cloudmusic",
                StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static (nint Handle, string Title) FindPlayerWindow(
        int processId)
    {
        var bestTitle = string.Empty;
        var bestHandle = nint.Zero;
        _ = EnumWindows(
            (window, unused) =>
            {
                _ = unused;
                GetWindowThreadProcessId(window, out var ownerProcessId);
                if (ownerProcessId != processId
                    || !ReadWindowClass(window).Equals(
                        "OrpheusBrowserHost",
                        StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }

                var title = ReadWindowTitle(window);
                if (string.IsNullOrWhiteSpace(title))
                {
                    return true;
                }

                bestTitle = title.Trim();
                bestHandle = window;
                return false;
            },
            nint.Zero);
        return (bestHandle, bestTitle);
    }

    public static NeteaseIpcSendResult SendWebCommand(object payload)
    {
        var json = JsonSerializer.Serialize(payload);
        var encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
        return Send(3, $"orpheus://{encoded}");
    }

    private static NeteaseIpcSendResult Send(int commandId, string data)
    {
        lock (SendSync)
        {
            var endpoint = FindEndpoint();
            if (endpoint is null)
            {
                return new NeteaseIpcSendResult(
                    false,
                    0,
                    "没有发现网易云原生 IPC 窗口。");
            }

            var windowState = CaptureWindowState(endpoint.ProcessId);
            var json = JsonSerializer.Serialize(new
            {
                id = commandId,
                data
            });
            var bytes = Encoding.UTF8.GetBytes(json + "\0");
            nint mappingHandle = nint.Zero;
            uint tick = 0;
            string mappingName = string.Empty;
            for (var attempt = 0; attempt < 8; attempt++)
            {
                tick = NextTick();
                mappingName = $"orpheus_ipc_{endpoint.ProcessId}_{tick}";
                mappingHandle = CreateFileMapping(
                    InvalidHandleValue,
                    nint.Zero,
                    PageReadWrite,
                    0,
                    checked((uint)bytes.Length),
                    mappingName);
                if (mappingHandle == nint.Zero)
                {
                    return new NeteaseIpcSendResult(
                        false,
                        0,
                        $"创建共享内存失败，Win32={Marshal.GetLastWin32Error()}。");
                }

                if (Marshal.GetLastWin32Error() != ErrorAlreadyExists)
                {
                    break;
                }

                _ = CloseHandle(mappingHandle);
                mappingHandle = nint.Zero;
            }

            if (mappingHandle == nint.Zero)
            {
                return new NeteaseIpcSendResult(
                    false,
                    0,
                    "无法分配唯一的网易云 IPC 共享内存名称。");
            }

            try
            {
                var view = MapViewOfFile(
                    mappingHandle,
                    FileMapWrite,
                    0,
                    0,
                    (nuint)bytes.Length);
                if (view == nint.Zero)
                {
                    return new NeteaseIpcSendResult(
                        false,
                        0,
                        $"映射共享内存失败，Win32={Marshal.GetLastWin32Error()}。");
                }

                try
                {
                    Marshal.Copy(bytes, 0, view, bytes.Length);
                    using var suppression = StartWindowSuppression(windowState);
                    var delivered = SendMessageTimeout(
                            endpoint.WindowHandle,
                            IpcMessage,
                            (nuint)endpoint.ProcessId,
                            (nint)(long)tick,
                            SendMessageTimeoutFlags.Block
                            | SendMessageTimeoutFlags.AbortIfHung,
                            1500,
                            out var receiverResult);
                    if (suppression is not null)
                    {
                        // 网易云有时会在 IPC 返回后异步恢复主窗口，继续
                        // 遮蔽一小段时间，覆盖这段延迟恢复窗口。
                        Thread.Sleep(180);
                    }
                    suppression?.Stop();
                    var restored = RestoreWindowState(windowState);
                    Thread.Sleep(50);
                    restored |= RestoreWindowState(windowState);
                    suppression?.ReleaseVisualSuppression();
                    var foregroundBefore =
                        windowState?.ForegroundWindow ?? nint.Zero;
                    var foregroundPreserved =
                        foregroundBefore == nint.Zero
                        || (GetForegroundWindow()
                            == foregroundBefore
                            && suppression?.FocusStealObservations == 0);
                    return delivered != nint.Zero
                        ? new NeteaseIpcSendResult(
                            true,
                            receiverResult,
                            $"网易云 IPC 已投递（mapping={mappingName}，"
                            + $"DWM遮蔽={suppression?.CloakApplied == true}，"
                            + $"透明遮蔽={suppression?.TransparencyApplied == true}，"
                            + $"焦点保护={suppression?.FocusProtectionApplied == true}，"
                            + $"前台保持={foregroundPreserved}，"
                            + $"抢焦点次数={suppression?.FocusStealObservations ?? 0}，"
                            + $"窗口遮蔽守卫={suppression is not null}，状态恢复={restored}）。")
                        : new NeteaseIpcSendResult(
                            false,
                            receiverResult,
                            $"网易云 IPC 超时或被拒绝，Win32={Marshal.GetLastWin32Error()}。");
                }
                finally
                {
                    _ = UnmapViewOfFile(view);
                }
            }
            finally
            {
                _ = CloseHandle(mappingHandle);
            }
        }
    }

    private static NeteaseWindowState? CaptureWindowState(int processId)
    {
        var playerWindow = FindMainPlayerWindow(processId);
        if (playerWindow.Handle == nint.Zero)
        {
            return null;
        }

        var placement = new NeteaseWindowPlacement
        {
            Length = Marshal.SizeOf<NeteaseWindowPlacement>()
        };
        _ = GetWindowPlacement(playerWindow.Handle, ref placement);
        return new NeteaseWindowState(
            playerWindow.Handle,
            processId,
            GetForegroundWindow(),
            IsWindowVisible(playerWindow.Handle),
            IsIconic(playerWindow.Handle),
            playerWindow.IsAuxiliaryOverlay,
            placement);
    }

    private static (nint Handle, bool IsAuxiliaryOverlay)
        FindMainPlayerWindow(int processId)
    {
        var bestHandle = nint.Zero;
        long bestArea = 0;
        _ = EnumWindows(
            (window, unused) =>
            {
                _ = unused;
                GetWindowThreadProcessId(window, out var ownerProcessId);
                if (ownerProcessId != processId
                    || !ReadWindowClass(window).Equals(
                        "Chrome_WidgetWin_0",
                        StringComparison.OrdinalIgnoreCase)
                    || !GetWindowRect(window, out var rectangle))
                {
                    return true;
                }

                var width = Math.Max(
                    0,
                    rectangle.Right - rectangle.Left);
                var height = Math.Max(
                    0,
                    rectangle.Bottom - rectangle.Top);
                var area = (long)width * height;
                if (width >= 400 && height >= 300 && area > bestArea)
                {
                    bestHandle = window;
                    bestArea = area;
                }

                return true;
            },
            nint.Zero);
        if (bestHandle != nint.Zero)
        {
            return (bestHandle, false);
        }

        var titleWindow = FindPlayerWindow(processId);
        return (titleWindow.Handle, titleWindow.Handle != nint.Zero);
    }

    private static void HideNotificationOverlays(int processId)
    {
        _ = EnumWindows(
            (window, unused) =>
            {
                _ = unused;
                GetWindowThreadProcessId(window, out var ownerProcessId);
                if (ownerProcessId != processId
                    || !ReadWindowClass(window).Equals(
                        "OrpheusBrowserHost",
                        StringComparison.OrdinalIgnoreCase)
                    || !GetWindowRect(window, out var rectangle))
                {
                    return true;
                }

                var width = Math.Max(
                    0,
                    rectangle.Right - rectangle.Left);
                var height = Math.Max(
                    0,
                    rectangle.Bottom - rectangle.Top);
                if (width <= 400 && height <= 120)
                {
                    _ = ShowWindow(window, ShowWindowCommand.Hide);
                }

                return true;
            },
            nint.Zero);
    }

    private static bool RestoreWindowState(NeteaseWindowState? state)
    {
        if (state is null || state.WindowHandle == nint.Zero)
        {
            return false;
        }

        var restored = false;
        var placement = state.Placement;
        placement.Length = Marshal.SizeOf<NeteaseWindowPlacement>();
        _ = SetWindowPlacement(state.WindowHandle, ref placement);

        if (!state.WasVisible)
        {
            _ = ShowWindow(state.WindowHandle, ShowWindowCommand.Hide);
            restored = true;
        }
        else if (state.WasMinimized)
        {
            _ = ShowWindow(
                state.WindowHandle,
                ShowWindowCommand.ShowMinNoActivate);
            restored = true;
        }

        var currentForeground = GetForegroundWindow();
        if (state.ForegroundWindow != nint.Zero
            && state.ForegroundWindow != state.WindowHandle
            && currentForeground == state.WindowHandle)
        {
            _ = SetForegroundWindow(state.ForegroundWindow);
            restored = true;
        }

        return restored;
    }

    private static WindowSuppressionScope? StartWindowSuppression(
        NeteaseWindowState? state)
    {
        if (state is null
            || state.WindowHandle == nint.Zero)
        {
            return null;
        }

        return new WindowSuppressionScope(state);
    }

    private sealed class WindowSuppressionScope : IDisposable
    {
        private readonly NeteaseWindowState _state;
        private readonly bool _suppressVisual;
        private readonly CancellationTokenSource _cancellation = new();
        private readonly Task _worker;
        private readonly int _originalExtendedStyle;
        private readonly bool _wasLayered;
        private readonly bool _wasEnabled;
        private readonly uint _originalColorKey;
        private readonly byte _originalAlpha = byte.MaxValue;
        private readonly uint _originalLayeredFlags = LayeredWindowAlpha;
        private bool _stopped;
        private bool _visualSuppressionReleased;

        public WindowSuppressionScope(NeteaseWindowState state)
        {
            _state = state;
            _suppressVisual = !_state.WasVisible
                || _state.WasMinimized
                || _state.IsAuxiliaryOverlay;
            HideNotificationOverlays(_state.ProcessId);
            if (_suppressVisual)
            {
                var cloak = 1;
                CloakResult = DwmSetWindowAttribute(
                    _state.WindowHandle,
                    DwmWindowAttributeCloak,
                    ref cloak,
                    sizeof(int));
                CloakApplied = CloakResult >= 0;
                if (CloakApplied)
                {
                    _ = DwmFlush();
                }
            }

            _originalExtendedStyle = GetWindowLong(
                _state.WindowHandle,
                GetWindowLongExtendedStyle);
            _wasLayered =
                (_originalExtendedStyle & WindowExtendedStyleLayered) != 0;
            _wasEnabled = IsWindowEnabled(_state.WindowHandle);
            if (_wasLayered
                && GetLayeredWindowAttributes(
                    _state.WindowHandle,
                    out var originalColorKey,
                    out var originalAlpha,
                    out var originalLayeredFlags))
            {
                _originalColorKey = originalColorKey;
                _originalAlpha = originalAlpha;
                _originalLayeredFlags = originalLayeredFlags;
            }

            if (!_wasLayered)
            {
                _ = SetWindowLong(
                    _state.WindowHandle,
                    GetWindowLongExtendedStyle,
                    _originalExtendedStyle
                    | WindowExtendedStyleLayered
                    | WindowExtendedStyleNoActivate);
            }
            else
            {
                _ = SetWindowLong(
                    _state.WindowHandle,
                    GetWindowLongExtendedStyle,
                    _originalExtendedStyle
                    | WindowExtendedStyleNoActivate);
            }
            FocusProtectionApplied =
                !EnableWindow(_state.WindowHandle, false)
                || !IsWindowEnabled(_state.WindowHandle);
            if (_suppressVisual)
            {
                TransparencyApplied = SetLayeredWindowAttributes(
                    _state.WindowHandle,
                    0,
                    0,
                    LayeredWindowAlpha);

            }
            _worker = Task.Factory.StartNew(
                Run,
                CancellationToken.None,
                TaskCreationOptions.LongRunning,
                TaskScheduler.Default);
        }

        public bool CloakApplied { get; }

        public int CloakResult { get; }

        public bool TransparencyApplied { get; }

        public bool FocusProtectionApplied { get; }

        public int FocusStealObservations { get; private set; }

        public void Stop()
        {
            if (_stopped)
            {
                return;
            }

            _stopped = true;
            _cancellation.Cancel();
            try
            {
                _worker.Wait(TimeSpan.FromMilliseconds(100));
            }
            catch
            {
                // The guard is best-effort and must never fail the IPC command.
            }
        }

        public void Dispose()
        {
            Stop();
            ReleaseVisualSuppression();
            _cancellation.Dispose();
        }

        public void ReleaseVisualSuppression()
        {
            if (_visualSuppressionReleased)
            {
                return;
            }

            _visualSuppressionReleased = true;

            _ = SetWindowLong(
                _state.WindowHandle,
                GetWindowLongExtendedStyle,
                _originalExtendedStyle);

            if (TransparencyApplied)
            {
                if (_wasLayered)
                {
                    _ = SetLayeredWindowAttributes(
                        _state.WindowHandle,
                        _originalColorKey,
                        _originalAlpha,
                        _originalLayeredFlags);
                }
                else
                {
                    _ = SetWindowPos(
                        _state.WindowHandle,
                        nint.Zero,
                        0,
                        0,
                        0,
                        0,
                        SetWindowPosFlags.NoMove
                        | SetWindowPosFlags.NoSize
                        | SetWindowPosFlags.NoActivate
                        | SetWindowPosFlags.NoOwnerZOrder
                        | SetWindowPosFlags.FrameChanged);
                }
            }

            if (CloakApplied)
            {
                var cloak = 0;
                _ = DwmSetWindowAttribute(
                    _state.WindowHandle,
                    DwmWindowAttributeCloak,
                    ref cloak,
                    sizeof(int));
                _ = DwmFlush();
            }

            if (_wasEnabled)
            {
                _ = EnableWindow(_state.WindowHandle, true);
            }

            HideNotificationOverlays(_state.ProcessId);
        }

        private void Run()
        {
            var overlayPoll = 0;
            while (!_cancellation.IsCancellationRequested)
            {
                if (GetForegroundWindow() == _state.WindowHandle)
                {
                    FocusStealObservations++;
                }
                _ = EnableWindow(_state.WindowHandle, false);
                var currentStyle = GetWindowLong(
                    _state.WindowHandle,
                    GetWindowLongExtendedStyle);
                if ((currentStyle & WindowExtendedStyleNoActivate) == 0)
                {
                    _ = SetWindowLong(
                        _state.WindowHandle,
                        GetWindowLongExtendedStyle,
                        currentStyle | WindowExtendedStyleNoActivate);
                }
                if (++overlayPoll >= 10)
                {
                    HideNotificationOverlays(_state.ProcessId);
                    overlayPoll = 0;
                }
                Thread.Sleep(1);
            }
        }
    }

    private static uint NextTick()
    {
        var tick = GetTickCount();
        if (tick == _lastTick)
        {
            tick = unchecked(tick + 1);
        }

        _lastTick = tick;
        return tick;
    }

    private static string ReadWindowTitle(nint window)
    {
        var length = GetWindowTextLength(window);
        if (length <= 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder(length + 1);
        _ = GetWindowText(window, builder, builder.Capacity);
        return builder.ToString();
    }

    private static string ReadWindowClass(nint window)
    {
        var builder = new StringBuilder(256);
        _ = GetClassName(window, builder, builder.Capacity);
        return builder.ToString();
    }

    private delegate bool EnumWindowsProc(nint window, nint lParam);

    [Flags]
    private enum SendMessageTimeoutFlags : uint
    {
        Block = 0x0001,
        AbortIfHung = 0x0002
    }

    private enum ShowWindowCommand
    {
        Hide = 0,
        ShowMinNoActivate = 7
    }

    [Flags]
    private enum SetWindowPosFlags : uint
    {
        NoSize = 0x0001,
        NoMove = 0x0002,
        NoActivate = 0x0010,
        FrameChanged = 0x0020,
        NoOwnerZOrder = 0x0200
    }

    private const int DwmWindowAttributeCloak = 13;
    private const int GetWindowLongExtendedStyle = -20;
    private const int WindowExtendedStyleLayered = 0x00080000;
    private const int WindowExtendedStyleNoActivate = 0x08000000;
    private const uint LayeredWindowAlpha = 0x00000002;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern nint FindWindowEx(
        nint parentHandle,
        nint childAfter,
        string className,
        string windowName);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(
        EnumWindowsProc callback,
        nint lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(
        nint window,
        out int processId);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(nint window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(nint window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(nint window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(
        nint window,
        out NeteaseWindowRect rectangle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(
        nint window,
        ShowWindowCommand command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowPlacement(
        nint window,
        ref NeteaseWindowPlacement placement);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPlacement(
        nint window,
        ref NeteaseWindowPlacement placement);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(
        nint window,
        nint insertAfter,
        int x,
        int y,
        int width,
        int height,
        SetWindowPosFlags flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowLong(
        nint window,
        int index);

    [DllImport(
        "user32.dll",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern int SetWindowLong(
        nint window,
        int index,
        int newValue);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetLayeredWindowAttributes(
        nint window,
        uint colorKey,
        byte alpha,
        uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetLayeredWindowAttributes(
        nint window,
        out uint colorKey,
        out byte alpha,
        out uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnableWindow(
        nint window,
        [MarshalAs(UnmanagedType.Bool)] bool enable);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(nint window);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessage(
        nint window,
        uint message,
        nuint wParam,
        nint lParam);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(
        nint window,
        int attribute,
        ref int value,
        int valueSize);

    [DllImport("dwmapi.dll")]
    private static extern int DwmFlush();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(
        nint window,
        StringBuilder text,
        int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(nint window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(
        nint window,
        StringBuilder className,
        int maxCount);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint SendMessageTimeout(
        nint window,
        uint message,
        nuint wParam,
        nint lParam,
        SendMessageTimeoutFlags flags,
        uint timeoutMilliseconds,
        out nuint result);

    [DllImport(
        "kernel32.dll",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern nint CreateFileMapping(
        nint fileHandle,
        nint attributes,
        uint protect,
        uint maximumSizeHigh,
        uint maximumSizeLow,
        string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint MapViewOfFile(
        nint fileMappingObject,
        uint desiredAccess,
        uint fileOffsetHigh,
        uint fileOffsetLow,
        nuint numberOfBytesToMap);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnmapViewOfFile(nint baseAddress);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint handle);

    [DllImport("kernel32.dll")]
    private static extern uint GetTickCount();

    [DllImport(
        "kernel32.dll",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern ushort GlobalFindAtom(string atomName);
}
