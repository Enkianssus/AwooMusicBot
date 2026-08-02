namespace KugouControlPoc;

internal sealed record KugouAnchorValueCandidate(
    long Address,
    int Baseline,
    int AfterFirstInsert,
    int AfterSecondInsert,
    int AfterReset,
    string NearestObject,
    long RelativeOffset);

internal sealed record KugouInsertionAnchorValueProbeResult(
    KugouPlaybackState OriginalTrack,
    KugouQueueNativeProbeResult QueueController,
    KugouResolvedSearchTrack FirstTarget,
    BackgroundOpenResult FirstInsert,
    KugouResolvedSearchTrack SecondTarget,
    BackgroundOpenResult SecondInsert,
    BackgroundControlResult ResetNext,
    BackgroundControlResult ResetPrevious,
    bool OriginalTrackRestored,
    int BaselineDwordCount,
    int StableAfterFirstCount,
    int StableAfterSecondCount,
    IReadOnlyList<KugouAnchorValueCandidate> Candidates,
    string Verdict);

internal static class KugouInsertionAnchorValueProbe
{
    public static async Task<KugouInsertionAnchorValueProbeResult> RunAsync(
        string firstQuery,
        string secondQuery)
    {
        var original = KugouNativeController.ReadPlaybackState();
        var controller = KugouQueueNativeProbe.InspectUiController();
        var namedSeeds = BuildSeeds(controller);
        var seeds = namedSeeds.Select(seed => seed.Address).ToArray();
        var baseline = KugouProcessHashScanner.CaptureDwordsNear(
            seeds,
            0x100000);

        var firstTarget =
            await KugouNativeController.ResolveSearchTrackAsync(firstQuery)
                .ConfigureAwait(false);
        var firstInsert =
            await KugouNativeController.SearchAsNextBackgroundAsync(firstQuery)
                .ConfigureAwait(false);
        await Task.Delay(300).ConfigureAwait(false);
        var first = KugouProcessHashScanner.CaptureDwordsNear(
            seeds,
            0x100000);
        await Task.Delay(180).ConfigureAwait(false);
        var firstStable = KugouProcessHashScanner.CaptureDwordsNear(
            seeds,
            0x100000);

        var firstChanged = baseline.Keys
            .Where(address =>
                first.TryGetValue(address, out var firstValue)
                && firstStable.TryGetValue(address, out var stableValue)
                && firstValue == stableValue
                && firstValue != baseline[address])
            .ToArray();

        var secondTarget =
            await KugouNativeController.ResolveSearchTrackAsync(secondQuery)
                .ConfigureAwait(false);
        var secondInsert =
            await KugouNativeController.SearchAsNextBackgroundAsync(secondQuery)
                .ConfigureAwait(false);
        await Task.Delay(300).ConfigureAwait(false);
        var second = KugouProcessHashScanner.CaptureDwordsNear(
            seeds,
            0x100000);
        await Task.Delay(180).ConfigureAwait(false);
        var secondStable = KugouProcessHashScanner.CaptureDwordsNear(
            seeds,
            0x100000);

        var secondChanged = firstChanged
            .Where(address =>
                second.TryGetValue(address, out var secondValue)
                && secondStable.TryGetValue(address, out var stableValue)
                && secondValue == stableValue
                && secondValue != first[address])
            .ToArray();

        var resetNext = KugouNativeController.SendDirectKugouCommand(
            KugouAppCommand.NextTrack,
            TimeSpan.FromSeconds(4));
        await Task.Delay(150).ConfigureAwait(false);
        var resetPrevious = KugouNativeController.SendDirectKugouCommand(
            KugouAppCommand.PreviousTrack,
            TimeSpan.FromSeconds(4));
        var restored = SameTrack(resetPrevious.After, original);
        await Task.Delay(300).ConfigureAwait(false);
        var reset = KugouProcessHashScanner.CaptureDwordsNear(
            seeds,
            0x100000);
        await Task.Delay(180).ConfigureAwait(false);
        var resetStable = KugouProcessHashScanner.CaptureDwordsNear(
            seeds,
            0x100000);

        var candidates = secondChanged
            .Where(address =>
                reset.TryGetValue(address, out var resetValue)
                && resetStable.TryGetValue(address, out var stableValue)
                && resetValue == stableValue
                && resetValue == baseline[address])
            .Select(address =>
            {
                var nearest = namedSeeds
                    .OrderBy(seed => Math.Abs(address - seed.Address))
                    .First();
                return new KugouAnchorValueCandidate(
                    address,
                    baseline[address],
                    first[address],
                    second[address],
                    reset[address],
                    nearest.Name,
                    address - nearest.Address);
            })
            .OrderBy(candidate => Math.Abs(candidate.RelativeOffset))
            .Take(200)
            .ToArray();

        return new KugouInsertionAnchorValueProbeResult(
            original,
            controller,
            firstTarget,
            firstInsert,
            secondTarget,
            secondInsert,
            resetNext,
            resetPrevious,
            restored,
            baseline.Count,
            firstChanged.Length,
            secondChanged.Length,
            candidates,
            candidates.Length switch
            {
                1 => "One stable insertion-anchor candidate matched the full reset pattern.",
                0 => "No value near the known queue objects matched the full reset pattern.",
                _ => $"{candidates.Length} stable values matched; another controlled cycle can disambiguate them."
            });
    }

    private static IReadOnlyList<(string Name, long Address)> BuildSeeds(
        KugouQueueNativeProbeResult controller)
    {
        var seeds = new List<(string Name, long Address)>
        {
            ("UiQueueController", controller.Controller),
            ("UiQueueImplementation", controller.Implementation)
        };
        seeds.AddRange(controller.NestedObjects.Select(item =>
            ($"Nested+0x{item.ParentOffset:X}", item.Pointer)));
        return seeds
            .Where(seed => seed.Address > 0)
            .DistinctBy(seed => seed.Address)
            .ToArray();
    }

    private static bool SameTrack(
        KugouPlaybackState left,
        KugouPlaybackState right) =>
        string.Equals(
            left.RawTitle,
            right.RawTitle,
            StringComparison.OrdinalIgnoreCase);
}
