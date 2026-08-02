namespace KugouControlPoc;

internal sealed record KugouResetAnchorInsertProbeResult(
    KugouPlaybackState OriginalTrack,
    KugouResolvedSearchTrack DirtyTarget,
    BackgroundOpenResult DirtyInsert,
    long DetectedAnchorAddress,
    int AnchorDetectionMilliseconds,
    KugouResetInsertionAnchorResult AnchorReset,
    KugouResolvedSearchTrack ExpectedNext,
    BackgroundOpenResult ExpectedNextInsert,
    bool ExpectedInsertObserved,
    BackgroundControlResult VerificationNext,
    bool ExpectedTrackPlayed,
    BackgroundControlResult? RestorePrevious,
    bool OriginalTrackRestored,
    string Verdict);

internal static class KugouResetAnchorInsertProbe
{
    public static async Task<KugouResetAnchorInsertProbeResult> RunAsync(
        string dirtyQuery,
        string expectedNextQuery)
    {
        var original = KugouNativeController.ReadPlaybackState();
        var baseline = KugouQueueNativeProbe.CaptureInsertionAnchors();
        var dirtyTarget =
            await KugouNativeController.ResolveSearchTrackAsync(dirtyQuery)
                .ConfigureAwait(false);
        var dirtyInsert =
            await KugouNativeController.SearchAsNextBackgroundAsync(dirtyQuery)
                .ConfigureAwait(false);
        var detection = await WaitForChangedAnchorAsync(
                baseline,
                TimeSpan.FromSeconds(3))
            .ConfigureAwait(false);
        var reset = detection.Anchor is null
            ? EmptyReset(baseline)
            : KugouQueueNativeProbe.ResetInsertionAnchorAt(
                baseline,
                detection.Anchor.Address);
        var expectedNext =
            await KugouNativeController.ResolveSearchTrackAsync(expectedNextQuery)
                .ConfigureAwait(false);
        var expectedInsert = reset.Reset
            ? await KugouNativeController.SearchAsNextBackgroundAsync(
                    expectedNextQuery)
                .ConfigureAwait(false)
            : default!;

        var expectedInsertObserved = false;
        if (reset.Reset && expectedInsert.Sent && detection.Anchor is not null)
        {
            expectedInsertObserved = await WaitForAnchorToAdvanceAsync(
                    baseline,
                    detection.Anchor.Address,
                    TimeSpan.FromSeconds(3))
                .ConfigureAwait(false);
        }

        if (!reset.Reset
            || !expectedInsert.Sent
            || !expectedInsertObserved)
        {
            return new KugouResetAnchorInsertProbeResult(
                original,
                dirtyTarget,
                dirtyInsert,
                detection.Anchor?.Address ?? 0,
                detection.ElapsedMilliseconds,
                reset,
                expectedNext,
                expectedInsert,
                expectedInsertObserved,
                default!,
                false,
                null,
                false,
                "The changed queue object was not uniquely detected, reset, or observed after the target insert; Next was not sent.");
        }

        await Task.Delay(100).ConfigureAwait(false);
        var next = KugouNativeController.SendDirectKugouCommand(
            KugouAppCommand.NextTrack,
            TimeSpan.FromSeconds(4));
        var expectedPlayed = Matches(next.After, expectedNext);
        BackgroundControlResult? previous = null;
        var restored = false;
        if (expectedPlayed)
        {
            await Task.Delay(150).ConfigureAwait(false);
            previous = KugouNativeController.SendDirectKugouCommand(
                KugouAppCommand.PreviousTrack,
                TimeSpan.FromSeconds(4));
            restored = string.Equals(
                previous.After.RawTitle,
                original.RawTitle,
                StringComparison.OrdinalIgnoreCase);
        }

        return new KugouResetAnchorInsertProbeResult(
            original,
            dirtyTarget,
            dirtyInsert,
            detection.Anchor?.Address ?? 0,
            detection.ElapsedMilliseconds,
            reset,
            expectedNext,
            expectedInsert,
            expectedInsertObserved,
            next,
            expectedPlayed,
            previous,
            restored,
            expectedPlayed
                ? "Verified: resetting cursor to current index made the following insert the real next track."
                : "The cursor reset was written, but Next did not reach the expected track.");
    }

    private static async Task<(KugouInsertionAnchorObject? Anchor, int ElapsedMilliseconds)>
        WaitForChangedAnchorAsync(
            KugouInsertionAnchorSnapshot baseline,
            TimeSpan timeout)
    {
        var before = baseline.Objects.ToDictionary(
            candidate => candidate.Address);
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        while (stopwatch.Elapsed < timeout)
        {
            await Task.Delay(100).ConfigureAwait(false);
            var changed = KugouQueueNativeProbe
                .RefreshInsertionAnchors(baseline)
                .Where(candidate =>
                    before.TryGetValue(candidate.Address, out var original)
                    && candidate.CurrentIndex == original.CurrentIndex
                    && candidate.InsertCursor != original.InsertCursor
                    && candidate.InsertCursor != candidate.CurrentIndex)
                .ToArray();
            if (changed.Length == 1)
            {
                return (changed[0], checked((int)stopwatch.ElapsedMilliseconds));
            }

            if (changed.Length > 1)
            {
                var oneStep = changed.Where(candidate =>
                        candidate.InsertCursor
                        == before[candidate.Address].InsertCursor + 1)
                    .ToArray();
                if (oneStep.Length == 1)
                {
                    return (oneStep[0], checked((int)stopwatch.ElapsedMilliseconds));
                }
            }
        }

        return (null, checked((int)stopwatch.ElapsedMilliseconds));
    }

    private static async Task<bool> WaitForAnchorToAdvanceAsync(
        KugouInsertionAnchorSnapshot baseline,
        long address,
        TimeSpan timeout)
    {
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        while (stopwatch.Elapsed < timeout)
        {
            await Task.Delay(100).ConfigureAwait(false);
            var anchor = KugouQueueNativeProbe
                .RefreshInsertionAnchors(baseline)
                .SingleOrDefault(candidate => candidate.Address == address);
            if (anchor is not null
                && anchor.InsertCursor != anchor.CurrentIndex)
            {
                return true;
            }
        }

        return false;
    }

    private static KugouResetInsertionAnchorResult EmptyReset(
        KugouInsertionAnchorSnapshot baseline) =>
        new(
            baseline.ProcessId,
            baseline.FileVersion,
            baseline.Sha256,
            baseline.ExpectedVtable,
            [],
            false,
            0,
            0,
            0);

    private static bool Matches(
        KugouPlaybackState state,
        KugouResolvedSearchTrack expected) =>
        (!string.IsNullOrWhiteSpace(state.Hash)
         && state.Hash.Equals(expected.Hash, StringComparison.OrdinalIgnoreCase))
        || (state.Title.Contains(expected.SongName, StringComparison.OrdinalIgnoreCase)
            && state.Artist.Contains(
                expected.SingerName,
                StringComparison.OrdinalIgnoreCase));
}
