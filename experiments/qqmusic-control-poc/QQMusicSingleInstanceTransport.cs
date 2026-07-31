using System.Diagnostics;
using System.Runtime.InteropServices;

namespace QQMusicControlPoc;

internal sealed record QQMusicSingleInstanceResult(
    string Action,
    string CommandLine,
    bool Sent,
    bool HelperExited,
    bool ForegroundUnchanged,
    QQMusicPlaybackState Before,
    QQMusicPlaybackState After,
    bool ExpectedTrackConfirmed,
    bool WindowTrackChanged,
    int RequestedQueueCount,
    string Verification,
    long ElapsedMilliseconds,
    string Transport,
    string? Error);

internal static class QQMusicSingleInstanceTransport
{
    public static Task<QQMusicSingleInstanceResult> SendSongAsync(
        long songId,
        int songType,
        string? expectedTitle,
        string? expectedArtist,
        TimeSpan? timeout = null)
    {
        if (songId <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(songId),
                "songId 必须大于 0。");
        }

        return Task.Run(() => Send(
            "PlaySong",
            "/playbysongid",
            BuildPlayBySongIdArgument(
                [new QQMusicSongReference(songId, songType)]),
            expectedTitle,
            expectedArtist,
            1,
            false,
            timeout ?? TimeSpan.FromSeconds(8)));
    }

    public static Task<QQMusicSingleInstanceResult> SendQueueAsync(
        IReadOnlyList<QQMusicSongReference> songs,
        string? expectedFirstTitle,
        string? expectedFirstArtist,
        TimeSpan? timeout = null)
    {
        ArgumentNullException.ThrowIfNull(songs);
        if (songs.Count < 2)
        {
            throw new ArgumentException(
                "已知测试队列至少需要两首歌曲。",
                nameof(songs));
        }

        if (songs.Any(song => song.SongId <= 0))
        {
            throw new ArgumentException(
                "队列中的每个 songId 都必须大于 0。",
                nameof(songs));
        }

        return Task.Run(() => Send(
            "PlayKnownQueue",
            "/playbysongid",
            BuildPlayBySongIdArgument(songs),
            expectedFirstTitle,
            expectedFirstArtist,
            songs.Count,
            false,
            timeout ?? TimeSpan.FromSeconds(8)));
    }

    public static Task<QQMusicSingleInstanceResult> SendControlAsync(
        QQMusicPlaybackControl control,
        string? expectedTitle = null,
        string? expectedArtist = null,
        TimeSpan? timeout = null)
    {
        var command = control switch
        {
            QQMusicPlaybackControl.Previous => "prev",
            QQMusicPlaybackControl.Next => "next",
            QQMusicPlaybackControl.Pause => "pause",
            QQMusicPlaybackControl.Play => "play",
            _ => throw new ArgumentOutOfRangeException(nameof(control))
        };
        return Task.Run(() => Send(
            control.ToString(),
            "/playcontrol",
            $"'{command}'",
            expectedTitle,
            expectedArtist,
            0,
            control is QQMusicPlaybackControl.Next
                or QQMusicPlaybackControl.Previous,
            timeout ?? TimeSpan.FromSeconds(6)));
    }

    private static QQMusicSingleInstanceResult Send(
        string action,
        string switchName,
        string argument,
        string? expectedTitle,
        string? expectedArtist,
        int requestedQueueCount,
        bool trackChangeControl,
        TimeSpan timeout)
    {
        var commandLine = $"{switchName} {argument}";
        var before = QQMusicNativeController.ReadPlaybackState();
        var after = before;
        var foregroundBefore = GetForegroundWindow();
        var stopwatch = Stopwatch.StartNew();
        var sent = false;
        var helperExited = false;
        string? error = null;

        try
        {
            var executablePath = QQMusicNativeNextAnalyzer
                .FindCurrentModules()
                .ExecutablePath;
            if (!File.Exists(executablePath))
            {
                throw new FileNotFoundException(
                    "没有找到 QQMusic.exe。",
                    executablePath);
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = executablePath,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            startInfo.ArgumentList.Add(switchName);
            startInfo.ArgumentList.Add(argument);

            using var helper = Process.Start(startInfo)
                ?? throw new InvalidOperationException(
                    "QQMusic.exe 单实例命令进程未启动。");
            sent = true;
            helperExited = helper.WaitForExit(
                checked((int)Math.Min(
                    timeout.TotalMilliseconds,
                    5000)));

            var deadline = DateTime.UtcNow + timeout;
            do
            {
                Thread.Sleep(100);
                after = QQMusicNativeController.ReadPlaybackState();
            }
            while (DateTime.UtcNow < deadline
                && !IsExpectedOutcome(
                    before,
                    after,
                    expectedTitle,
                    expectedArtist,
                    trackChangeControl));
        }
        catch (Exception exception)
        {
            error = $"{exception.GetType().Name}: "
                + exception.Message;
        }

        stopwatch.Stop();
        var expectedConfirmed = MatchesTrack(
            after,
            expectedTitle,
            expectedArtist);
        var trackChanged = HasWindowTrackChanged(before, after);
        return new QQMusicSingleInstanceResult(
            action,
            commandLine,
            sent,
            helperExited,
            foregroundBefore == GetForegroundWindow(),
            before,
            after,
            expectedConfirmed,
            trackChanged,
            requestedQueueCount,
            DescribeVerification(
                expectedTitle,
                expectedConfirmed,
                trackChanged,
                trackChangeControl),
            stopwatch.ElapsedMilliseconds,
            "QQMusic.exe hidden single-instance command IPC",
            error);
    }

    private static string BuildPlayBySongIdArgument(
        IReadOnlyList<QQMusicSongReference> songs)
    {
        var parts = new List<string>
        {
            $"cmd_count=={songs.Count}"
        };
        for (var index = 0; index < songs.Count; index++)
        {
            parts.Add($"id_{index}=={songs[index].SongId}");
            parts.Add($"songtype_{index}=={songs[index].SongType}");
        }

        return string.Join("&&", parts);
    }

    private static bool IsExpectedOutcome(
        QQMusicPlaybackState before,
        QQMusicPlaybackState after,
        string? expectedTitle,
        string? expectedArtist,
        bool trackChangeControl)
    {
        if (!string.IsNullOrWhiteSpace(expectedTitle))
        {
            return MatchesTrack(
                after,
                expectedTitle,
                expectedArtist);
        }

        return !trackChangeControl
            || HasWindowTrackChanged(before, after);
    }

    private static bool MatchesTrack(
        QQMusicPlaybackState state,
        string? expectedTitle,
        string? expectedArtist)
    {
        if (string.IsNullOrWhiteSpace(expectedTitle)
            || !string.Equals(
                state.Title?.Trim(),
                expectedTitle.Trim(),
                StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return string.IsNullOrWhiteSpace(expectedArtist)
            || string.Equals(
                state.Artist?.Trim(),
                expectedArtist.Trim(),
                StringComparison.OrdinalIgnoreCase);
    }

    private static bool HasWindowTrackChanged(
        QQMusicPlaybackState before,
        QQMusicPlaybackState after)
    {
        return !string.IsNullOrWhiteSpace(after.WindowTitle)
            && !string.Equals(
                before.WindowTitle?.Trim(),
                after.WindowTitle.Trim(),
                StringComparison.OrdinalIgnoreCase);
    }

    private static string DescribeVerification(
        string? expectedTitle,
        bool expectedConfirmed,
        bool trackChanged,
        bool trackChangeControl)
    {
        if (!string.IsNullOrWhiteSpace(expectedTitle))
        {
            return expectedConfirmed
                ? "ExpectedWindowTrackConfirmed"
                : trackChanged
                    ? "ChangedToUnexpectedWindowTrack"
                    : "ExpectedWindowTrackNotObserved";
        }

        if (trackChangeControl)
        {
            return trackChanged
                ? "WindowTrackChangedQueueCountUnknown"
                : "IndeterminateQueueMayContainOneSong";
        }

        return "CommandDeliveredPlaybackStateUnavailable";
    }

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();
}
