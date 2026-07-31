using System.Diagnostics;

namespace QQMusicControlPoc;

internal sealed record QQMusicObservedTrack(
    string? Title,
    string? Artist,
    string? WindowTitle,
    DateTimeOffset ObservedAt);

internal sealed record QQMusicNextVerificationResult(
    string ExpectedTitle,
    string ExpectedArtist,
    QQMusicPlaybackState Before,
    QQMusicPlaybackState After,
    bool TrackChanged,
    bool ExpectedTrackConfirmed,
    IReadOnlyList<QQMusicObservedTrack> ObservedTracks,
    string Verification,
    long ElapsedMilliseconds);

/// <summary>
/// Read-only verifier for a pending "play next" request. It never sends a
/// playback command: the user can press QQ Music's own bottom-bar next button,
/// while this verifier only observes the resulting window-title transition.
/// </summary>
internal static class QQMusicNextVerification
{
    public static async Task<QQMusicNextVerificationResult> WaitAsync(
        string expectedTitle,
        string expectedArtist,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(expectedTitle))
        {
            throw new ArgumentException(
                "必须提供预期歌曲名。",
                nameof(expectedTitle));
        }

        if (timeout < TimeSpan.FromSeconds(2)
            || timeout > TimeSpan.FromMinutes(3))
        {
            throw new ArgumentOutOfRangeException(
                nameof(timeout),
                "只读验证时长必须在 2 秒到 3 分钟之间。");
        }

        var stopwatch = Stopwatch.StartNew();
        var before = QQMusicNativeController.ReadPlaybackState();
        var after = before;
        var observed = new List<QQMusicObservedTrack>();
        AddIfChanged(observed, before);

        var expectedAlreadyPlaying = Matches(
            before,
            expectedTitle,
            expectedArtist);
        var trackChanged = false;
        var expectedTrackConfirmed = false;

        while (stopwatch.Elapsed < timeout)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(
                TimeSpan.FromMilliseconds(100),
                cancellationToken);

            after = QQMusicNativeController.ReadPlaybackState();
            AddIfChanged(observed, after);
            trackChanged |= !SameTrack(before, after);
            if (!expectedAlreadyPlaying
                && trackChanged
                && Matches(after, expectedTitle, expectedArtist))
            {
                expectedTrackConfirmed = true;
                break;
            }
        }

        stopwatch.Stop();
        var verification = expectedAlreadyPlaying
            ? "ExpectedSongAlreadyPlayingCannotVerifyQueue"
            : expectedTrackConfirmed
                ? "ExpectedNextTrackConfirmed"
                : trackChanged
                    ? "TrackChangedButExpectedSongNotObserved"
                    : "NoTrackChangeObservedQueueNotJudged";

        return new QQMusicNextVerificationResult(
            expectedTitle.Trim(),
            expectedArtist.Trim(),
            before,
            after,
            trackChanged,
            expectedTrackConfirmed,
            observed,
            verification,
            stopwatch.ElapsedMilliseconds);
    }

    private static void AddIfChanged(
        ICollection<QQMusicObservedTrack> observed,
        QQMusicPlaybackState state)
    {
        var previous = observed.LastOrDefault();
        if (previous is not null
            && string.Equals(
                previous.WindowTitle,
                state.WindowTitle,
                StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        observed.Add(new QQMusicObservedTrack(
            state.Title,
            state.Artist,
            state.WindowTitle,
            state.ObservedAt));
    }

    private static bool SameTrack(
        QQMusicPlaybackState first,
        QQMusicPlaybackState second)
    {
        return string.Equals(
                   first.Title?.Trim(),
                   second.Title?.Trim(),
                   StringComparison.OrdinalIgnoreCase)
            && string.Equals(
                first.Artist?.Trim(),
                second.Artist?.Trim(),
                StringComparison.OrdinalIgnoreCase);
    }

    private static bool Matches(
        QQMusicPlaybackState state,
        string expectedTitle,
        string expectedArtist)
    {
        if (!string.Equals(
                state.Title?.Trim(),
                expectedTitle.Trim(),
                StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return string.IsNullOrWhiteSpace(expectedArtist)
            || string.Equals(
                NormalizeArtist(state.Artist),
                NormalizeArtist(expectedArtist),
                StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizeArtist(string? artist)
    {
        return string.Join(
            "/",
            (artist ?? string.Empty)
                .Split(
                    ['/', '、', '&'],
                    StringSplitOptions.TrimEntries
                        | StringSplitOptions.RemoveEmptyEntries)
                .Order(StringComparer.OrdinalIgnoreCase));
    }
}
