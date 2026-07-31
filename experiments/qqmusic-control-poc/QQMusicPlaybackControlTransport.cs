using System.Diagnostics;
using System.Runtime.InteropServices;

namespace QQMusicControlPoc;

internal enum QQMusicPlaybackControl
{
    Previous,
    Next,
    Pause,
    Play
}

internal sealed record QQMusicPlaybackControlResult(
    QQMusicPlaybackControl Control,
    string CommandLine,
    bool Sent,
    bool ForegroundUnchanged,
    QQMusicPrivatePlaybackState? Before,
    QQMusicPrivatePlaybackState? After,
    QQMusicSongReference? ExpectedSong,
    bool ExpectedSongConfirmed,
    bool StableTrackChanged,
    bool PlaybackStateChanged,
    string Verification,
    long ElapsedMilliseconds,
    string Transport,
    string? Error);

internal static class QQMusicPlaybackControlTransport
{
    public static Task<QQMusicPlaybackControlResult> SendAsync(
        QQMusicPlaybackControl control,
        QQMusicSongReference? expectedSong = null,
        TimeSpan? timeout = null)
    {
        var completion =
            new TaskCompletionSource<QQMusicPlaybackControlResult>(
                TaskCreationOptions.RunContinuationsAsynchronously);
        var worker = new Thread(() =>
        {
            try
            {
                completion.SetResult(
                    Send(control, expectedSong, timeout));
            }
            catch (Exception exception)
            {
                completion.SetException(exception);
            }
        })
        {
            IsBackground = true,
            Name = "QQMusic private playback-control IPC worker"
        };
        worker.SetApartmentState(ApartmentState.STA);
        worker.Start();
        return completion.Task;
    }

    private static QQMusicPlaybackControlResult Send(
        QQMusicPlaybackControl control,
        QQMusicSongReference? expectedSong,
        TimeSpan? timeout)
    {
        using var reader = new QQMusicPrivatePlaybackReader();
        using var bridge = QQMusicPrivateBridge.Open();
        return Send(
            reader,
            bridge,
            control,
            expectedSong,
            timeout);
    }

    internal static QQMusicPlaybackControlResult Send(
        QQMusicPrivatePlaybackReader reader,
        QQMusicPrivateBridge bridge,
        QQMusicPlaybackControl control,
        QQMusicSongReference? expectedSong,
        TimeSpan? timeout)
    {
        ArgumentNullException.ThrowIfNull(reader);
        ArgumentNullException.ThrowIfNull(bridge);
        var commandValue = control switch
        {
            QQMusicPlaybackControl.Previous => "prev",
            QQMusicPlaybackControl.Next => "next",
            QQMusicPlaybackControl.Pause => "pause",
            QQMusicPlaybackControl.Play => "play",
            _ => throw new ArgumentOutOfRangeException(nameof(control))
        };
        var commandLine = $"/playcontrol '{commandValue}'";
        QQMusicPrivatePlaybackState? before = null;
        QQMusicPrivatePlaybackState? after = null;
        var foregroundBefore = GetForegroundWindow();
        var stopwatch = Stopwatch.StartNew();
        var sent = false;
        var errors = new List<string>();

        try
        {
            before = reader.Read();
        }
        catch (Exception exception)
        {
            AddError(errors, "发送前状态读取", exception);
        }

        try
        {
            bridge.ForwardCommandLine(commandLine);
            sent = true;
        }
        catch (Exception exception)
        {
            AddError(errors, "命令投递", exception);
        }

        if (sent)
        {
            var deadline = DateTime.UtcNow
                + (timeout ?? TimeSpan.FromSeconds(5));
            var readErrorRecorded = false;
            do
            {
                Thread.Sleep(50);
                try
                {
                    after = reader.Read();
                }
                catch (Exception exception)
                {
                    if (!readErrorRecorded)
                    {
                        AddError(errors, "发送后状态读取", exception);
                        readErrorRecorded = true;
                    }
                }
            }
            while (DateTime.UtcNow < deadline
                && !IsExpectedOutcome(
                    control,
                    before,
                    after,
                    expectedSong));
        }

        stopwatch.Stop();
        var foregroundAfter = GetForegroundWindow();
        var expectedConfirmed = expectedSong is not null
            && after?.SongId == expectedSong.SongId
            && after.SongType == expectedSong.SongType;
        var stableTrackChanged = HasStableTrackChanged(before, after);
        var playbackStateChanged = before is not null
            && after is not null
            && before.PlayStatus != after.PlayStatus;
        return new QQMusicPlaybackControlResult(
            control,
            commandLine,
            sent,
            foregroundBefore == foregroundAfter,
            before,
            after,
            expectedSong,
            expectedConfirmed,
            stableTrackChanged,
            playbackStateChanged,
            DescribeVerification(
                control,
                expectedSong,
                expectedConfirmed,
                stableTrackChanged,
                playbackStateChanged),
            stopwatch.ElapsedMilliseconds,
            "QQMusicApi.CQMApiSvr.RollbackCmdLine",
            errors.Count == 0 ? null : string.Join(" | ", errors));
    }

    private static bool IsExpectedOutcome(
        QQMusicPlaybackControl control,
        QQMusicPrivatePlaybackState? before,
        QQMusicPrivatePlaybackState? after,
        QQMusicSongReference? expectedSong)
    {
        if (after is null)
        {
            return false;
        }

        if (expectedSong is not null)
        {
            return after.SongId == expectedSong.SongId
                && after.SongType == expectedSong.SongType;
        }

        return control is QQMusicPlaybackControl.Pause
            or QQMusicPlaybackControl.Play
                ? before is not null
                    && before.PlayStatus != after.PlayStatus
                : HasStableTrackChanged(before, after);
    }

    private static bool HasStableTrackChanged(
        QQMusicPrivatePlaybackState? before,
        QQMusicPrivatePlaybackState? after)
    {
        return before is not null
            && after is not null
            && (before.SongId != after.SongId
                || before.SongType != after.SongType
                || before.SongPosition != after.SongPosition);
    }

    private static string DescribeVerification(
        QQMusicPlaybackControl control,
        QQMusicSongReference? expectedSong,
        bool expectedConfirmed,
        bool stableTrackChanged,
        bool playbackStateChanged)
    {
        if (expectedSong is not null)
        {
            return expectedConfirmed
                ? "ExpectedSongConfirmed"
                : stableTrackChanged
                    ? "ChangedToUnexpectedSong"
                    : "ExpectedSongNotObserved";
        }

        if (control is QQMusicPlaybackControl.Next
            or QQMusicPlaybackControl.Previous)
        {
            return stableTrackChanged
                ? "SongIdChangedQueueCountUnknown"
                : "IndeterminateQueueMayContainOneSong";
        }

        return playbackStateChanged
            ? "PlaybackStateChanged"
            : "PlaybackStateNotObserved";
    }

    private static void AddError(
        ICollection<string> errors,
        string stage,
        Exception exception)
    {
        errors.Add(
            $"{stage}: {exception.GetType().Name}: "
            + exception.Message);
    }

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();
}
