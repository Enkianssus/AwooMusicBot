namespace KugouControlPoc;

internal sealed record KugouInsertionAnchorCandidate(
    long Address,
    int BaselineValue,
    int AfterFirstInsert,
    int AfterSecondInsert,
    int AfterTrackChangeReset);

internal sealed record KugouInsertionAnchorProbeResult(
    KugouPlaybackState OriginalTrack,
    BackgroundControlResult ResetNext,
    BackgroundControlResult ResetPrevious,
    bool OriginalTrackRestoredBeforeProbe,
    KugouResolvedSearchTrack FirstTarget,
    BackgroundOpenResult FirstInsert,
    IReadOnlyList<KugouSongItemMemoryCandidate> FirstSongItems,
    KugouResolvedSearchTrack SecondTarget,
    BackgroundOpenResult SecondInsert,
    IReadOnlyList<KugouSongItemMemoryCandidate> SecondSongItems,
    BackgroundControlResult FinalResetNext,
    BackgroundControlResult FinalResetPrevious,
    bool OriginalTrackRestoredAfterProbe,
    int InitialAddressCount,
    IReadOnlyList<KugouInsertionAnchorCandidate> Candidates,
    string Verdict);

internal static class KugouInsertionAnchorProbe
{
    public static async Task<KugouInsertionAnchorProbeResult> RunAsync(
        string firstQuery,
        string secondQuery)
    {
        var original = KugouNativeController.ReadPlaybackState();
        if (original.SongItem <= 0)
        {
            throw new InvalidOperationException(
                "The current KuGou SongItem ID is unavailable.");
        }

        var firstTarget =
            await KugouNativeController.ResolveSearchTrackAsync(firstQuery)
                .ConfigureAwait(false);
        var secondTarget =
            await KugouNativeController.ResolveSearchTrackAsync(secondQuery)
                .ConfigureAwait(false);

        var resetNext = KugouNativeController.SendDirectKugouCommand(
            KugouAppCommand.NextTrack,
            TimeSpan.FromSeconds(4));
        await Task.Delay(150).ConfigureAwait(false);
        var resetPrevious = KugouNativeController.SendDirectKugouCommand(
            KugouAppCommand.PreviousTrack,
            TimeSpan.FromSeconds(4));
        var restoredBefore = SameTrack(resetPrevious.After, original);
        if (!restoredBefore)
        {
            return EmptyResult(
                original,
                resetNext,
                resetPrevious,
                firstTarget,
                secondTarget,
                "Could not restore the original track before scanning; probe aborted.");
        }

        await Task.Delay(250).ConfigureAwait(false);
        var baselineAddresses = KugouProcessHashScanner.FindDwordAddresses(
            original.SongItem);

        var firstInsert =
            await KugouNativeController.SearchAsNextBackgroundAsync(firstQuery)
                .ConfigureAwait(false);
        await Task.Delay(350).ConfigureAwait(false);
        var firstItems = KugouProcessHashScanner.FindSongItemCandidates(
            firstTarget.Hash,
            firstTarget.DurationMilliseconds);
        var firstIds = firstItems.Select(item => item.SongItemId).ToHashSet();
        var afterFirstValues = KugouProcessHashScanner.ReadDwordValues(
            baselineAddresses);
        var changedToFirst = baselineAddresses
            .Where(address =>
                afterFirstValues.GetValueOrDefault(address) is int value
                && value != original.SongItem
                && firstIds.Contains(value))
            .ToArray();

        var secondInsert =
            await KugouNativeController.SearchAsNextBackgroundAsync(secondQuery)
                .ConfigureAwait(false);
        await Task.Delay(350).ConfigureAwait(false);
        var secondItems = KugouProcessHashScanner.FindSongItemCandidates(
            secondTarget.Hash,
            secondTarget.DurationMilliseconds);
        var secondIds = secondItems.Select(item => item.SongItemId).ToHashSet();
        var afterSecondValues = KugouProcessHashScanner.ReadDwordValues(
            changedToFirst);
        var changedToSecond = changedToFirst
            .Where(address =>
                afterSecondValues.GetValueOrDefault(address) is int value
                && secondIds.Contains(value)
                && value != afterFirstValues[address])
            .ToArray();

        var finalResetNext = KugouNativeController.SendDirectKugouCommand(
            KugouAppCommand.NextTrack,
            TimeSpan.FromSeconds(4));
        await Task.Delay(150).ConfigureAwait(false);
        var finalResetPrevious = KugouNativeController.SendDirectKugouCommand(
            KugouAppCommand.PreviousTrack,
            TimeSpan.FromSeconds(4));
        var restoredAfter = SameTrack(finalResetPrevious.After, original);
        await Task.Delay(250).ConfigureAwait(false);
        var afterResetValues = KugouProcessHashScanner.ReadDwordValues(
            changedToSecond);

        var candidates = changedToSecond
            .Where(address => afterResetValues.GetValueOrDefault(address)
                == original.SongItem)
            .Select(address => new KugouInsertionAnchorCandidate(
                address,
                original.SongItem,
                afterFirstValues[address]!.Value,
                afterSecondValues[address]!.Value,
                afterResetValues[address]!.Value))
            .ToArray();

        return new KugouInsertionAnchorProbeResult(
            original,
            resetNext,
            resetPrevious,
            restoredBefore,
            firstTarget,
            firstInsert,
            firstItems,
            secondTarget,
            secondInsert,
            secondItems,
            finalResetNext,
            finalResetPrevious,
            restoredAfter,
            baselineAddresses.Count,
            candidates,
            candidates.Length switch
            {
                1 => "Verified one insertion-anchor field that follows the last inserted SongItem and resets to the current SongItem after a track change.",
                0 => "No SongItem-ID insertion anchor matched the expected reset pattern.",
                _ => $"Found {candidates.Length} fields with the expected pattern; more discrimination is required."
            });
    }

    private static KugouInsertionAnchorProbeResult EmptyResult(
        KugouPlaybackState original,
        BackgroundControlResult resetNext,
        BackgroundControlResult resetPrevious,
        KugouResolvedSearchTrack firstTarget,
        KugouResolvedSearchTrack secondTarget,
        string verdict) =>
        new(
            original,
            resetNext,
            resetPrevious,
            false,
            firstTarget,
            default!,
            [],
            secondTarget,
            default!,
            [],
            resetNext,
            resetPrevious,
            false,
            0,
            [],
            verdict);

    private static bool SameTrack(
        KugouPlaybackState left,
        KugouPlaybackState right) =>
        left.SongItem > 0 && right.SongItem > 0
            ? left.SongItem == right.SongItem
            : string.Equals(
                left.RawTitle,
                right.RawTitle,
                StringComparison.OrdinalIgnoreCase);
}
