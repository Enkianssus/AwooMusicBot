using System.Diagnostics;
using System.Runtime.InteropServices;

namespace QQMusicControlPoc;

internal enum QQMusicSongCommand
{
    PlaySong
}

internal sealed record QQMusicSongReference(
    long SongId,
    int SongType);

internal sealed record QQMusicInternalCommandResult(
    QQMusicSongCommand Command,
    long SongId,
    int SongType,
    string CommandLine,
    bool Sent,
    bool ForegroundUnchanged,
    long ForegroundBefore,
    long ForegroundAfter,
    QQMusicPrivatePlaybackState? Before,
    QQMusicPrivatePlaybackState? After,
    bool RequestedSongConfirmed,
    bool TrackChanged,
    long ElapsedMilliseconds,
    string Transport,
    string? Error);

internal sealed record QQMusicQueueCommandResult(
    IReadOnlyList<QQMusicSongReference> Songs,
    string CommandLine,
    bool Sent,
    bool ForegroundUnchanged,
    QQMusicPrivatePlaybackState? Before,
    QQMusicPrivatePlaybackState? After,
    bool FirstSongConfirmed,
    bool FirstSongTransitionConfirmed,
    int RequestedQueueCount,
    long ElapsedMilliseconds,
    string Transport,
    string? Error);

internal static class QQMusicInternalCommandTransport
{
    public static Task<QQMusicInternalCommandResult> SendSongAsync(
        QQMusicSongCommand command,
        long songId,
        int songType,
        TimeSpan? timeout = null)
    {
        if (songId <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(songId),
                "songId 必须大于 0。");
        }

        var completion =
            new TaskCompletionSource<QQMusicInternalCommandResult>(
                TaskCreationOptions.RunContinuationsAsynchronously);
        var worker = new Thread(() =>
        {
            try
            {
                completion.SetResult(
                    SendSong(
                        command,
                        songId,
                        songType,
                        timeout));
            }
            catch (Exception exception)
            {
                completion.SetException(exception);
            }
        })
        {
            IsBackground = true,
            Name = "QQMusic private IPC worker"
        };
        worker.SetApartmentState(ApartmentState.STA);
        worker.Start();
        return completion.Task;
    }

    public static Task<QQMusicQueueCommandResult> SendQueueAsync(
        IReadOnlyList<QQMusicSongReference> songs,
        TimeSpan? timeout = null)
    {
        ArgumentNullException.ThrowIfNull(songs);
        if (songs.Count < 2)
        {
            throw new ArgumentException(
                "用于切歌验证的已知队列至少需要两首歌曲。",
                nameof(songs));
        }

        if (songs.Any(song => song.SongId <= 0))
        {
            throw new ArgumentException(
                "队列中的每个 songId 都必须大于 0。",
                nameof(songs));
        }

        var copy = songs.ToArray();
        var completion =
            new TaskCompletionSource<QQMusicQueueCommandResult>(
                TaskCreationOptions.RunContinuationsAsynchronously);
        var worker = new Thread(() =>
        {
            try
            {
                completion.SetResult(
                    SendQueue(copy, timeout));
            }
            catch (Exception exception)
            {
                completion.SetException(exception);
            }
        })
        {
            IsBackground = true,
            Name = "QQMusic private queue IPC worker"
        };
        worker.SetApartmentState(ApartmentState.STA);
        worker.Start();
        return completion.Task;
    }

    private static QQMusicInternalCommandResult SendSong(
        QQMusicSongCommand command,
        long songId,
        int songType,
        TimeSpan? timeout)
    {
        using var reader = new QQMusicPrivatePlaybackReader();
        using var bridge = QQMusicPrivateBridge.Open();
        return SendSong(
            reader,
            bridge,
            command,
            songId,
            songType,
            timeout);
    }

    internal static QQMusicInternalCommandResult SendSong(
        QQMusicPrivatePlaybackReader reader,
        QQMusicPrivateBridge bridge,
        QQMusicSongCommand command,
        long songId,
        int songType,
        TimeSpan? timeout)
    {
        ArgumentNullException.ThrowIfNull(reader);
        ArgumentNullException.ThrowIfNull(bridge);
        var commandLine = BuildCommandLine(command, songId, songType);
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
                && after?.SongId != songId);
        }

        stopwatch.Stop();
        var foregroundAfter = GetForegroundWindow();
        return new QQMusicInternalCommandResult(
            command,
            songId,
            songType,
            commandLine,
            sent,
            foregroundBefore == foregroundAfter,
            foregroundBefore,
            foregroundAfter,
            before,
            after,
            after?.SongId == songId,
            HasTrackChanged(before, after),
            stopwatch.ElapsedMilliseconds,
            "QQMusicApi.CQMApiSvr.RollbackCmdLine",
            errors.Count == 0 ? null : string.Join(" | ", errors));
    }

    private static QQMusicQueueCommandResult SendQueue(
        IReadOnlyList<QQMusicSongReference> songs,
        TimeSpan? timeout)
    {
        using var reader = new QQMusicPrivatePlaybackReader();
        using var bridge = QQMusicPrivateBridge.Open();
        return SendQueue(reader, bridge, songs, timeout);
    }

    internal static QQMusicQueueCommandResult SendQueue(
        QQMusicPrivatePlaybackReader reader,
        QQMusicPrivateBridge bridge,
        IReadOnlyList<QQMusicSongReference> songs,
        TimeSpan? timeout)
    {
        ArgumentNullException.ThrowIfNull(reader);
        ArgumentNullException.ThrowIfNull(bridge);
        var commandLine = BuildPlayBySongIdCommandLine(songs);
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
            var firstSong = songs[0];
            var deadline = DateTime.UtcNow
                + (timeout ?? TimeSpan.FromSeconds(8));
            var minimumSettleTime = DateTime.UtcNow
                + TimeSpan.FromMilliseconds(600);
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
                && (DateTime.UtcNow < minimumSettleTime
                    || after?.SongId != firstSong.SongId
                    || after.SongType != firstSong.SongType));
        }

        stopwatch.Stop();
        var foregroundAfter = GetForegroundWindow();
        return new QQMusicQueueCommandResult(
            songs,
            commandLine,
            sent,
            foregroundBefore == foregroundAfter,
            before,
            after,
            after?.SongId == songs[0].SongId
                && after.SongType == songs[0].SongType,
            before is not null
                && after is not null
                && (before.SongId != after.SongId
                    || before.SongType != after.SongType)
                && after.SongId == songs[0].SongId
                && after.SongType == songs[0].SongType,
            songs.Count,
            stopwatch.ElapsedMilliseconds,
            "QQMusicApi.CQMApiSvr.RollbackCmdLine",
            errors.Count == 0 ? null : string.Join(" | ", errors));
    }

    private static string BuildCommandLine(
        QQMusicSongCommand command,
        long songId,
        int songType)
    {
        if (command != QQMusicSongCommand.PlaySong)
        {
            throw new ArgumentOutOfRangeException(nameof(command));
        }

        return BuildPlayBySongIdCommandLine(
            [new QQMusicSongReference(songId, songType)]);
    }

    private static string BuildPlayBySongIdCommandLine(
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

        return "/playbysongid " + string.Join("&&", parts);
    }

    private static bool HasTrackChanged(
        QQMusicPrivatePlaybackState? before,
        QQMusicPrivatePlaybackState? after)
    {
        if (after is null)
        {
            return false;
        }

        return before is null
            || before.SongId != after.SongId
            || before.SongType != after.SongType
            || before.SongPosition != after.SongPosition;
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
