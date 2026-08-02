namespace KugouControlPoc;

internal sealed record KugouSongItemDelta(
    int SongItemId,
    int NewMatchCount,
    int TotalMatchCount,
    IReadOnlyList<long> NewHashAddresses);

internal sealed record KugouTrueNextProbeResult(
    KugouResolvedSearchTrack Target,
    KugouPlaybackState CurrentBefore,
    IReadOnlyList<KugouSongItemMemoryCandidate> CandidatesBefore,
    BackgroundOpenResult ExternalInsert,
    IReadOnlyList<KugouSongItemMemoryCandidate> CandidatesAfter,
    IReadOnlyList<KugouSongItemDelta> CandidateDelta,
    int? SelectedSongItemId,
    KugouPromoteQueueItemResult? Promote,
    BackgroundControlResult? VerificationNext,
    bool TargetBecameCurrent,
    BackgroundControlResult? RestorePrevious,
    bool RestoredOriginal,
    string Verdict);

internal static class KugouTrueNextProbe
{
    public static async Task<KugouTrueNextProbeResult> RunAsync(string query)
    {
        var target = await KugouNativeController.ResolveSearchTrackAsync(query)
            .ConfigureAwait(false);
        var currentBefore = KugouNativeController.ReadPlaybackState();
        var candidatesBefore = KugouProcessHashScanner.FindSongItemCandidates(
            target.Hash,
            target.DurationMilliseconds);
        var addressesBefore = candidatesBefore
            .SelectMany(candidate => candidate.HashAddresses)
            .ToHashSet();

        var externalInsert =
            await KugouNativeController.SearchAsNextBackgroundAsync(query)
                .ConfigureAwait(false);
        if (!externalInsert.Sent)
        {
            return Failed(
                target,
                currentBefore,
                candidatesBefore,
                externalInsert,
                "KuGou rejected the external insert payload.");
        }

        IReadOnlyList<KugouSongItemMemoryCandidate> candidatesAfter = [];
        IReadOnlyList<KugouSongItemDelta> delta = [];
        for (var attempt = 0; attempt < 4; attempt++)
        {
            await Task.Delay(attempt == 0 ? 180 : 250).ConfigureAwait(false);
            candidatesAfter = KugouProcessHashScanner.FindSongItemCandidates(
                target.Hash,
                target.DurationMilliseconds);
            delta = BuildDelta(candidatesAfter, addressesBefore);
            if (CanSelectUniqueCandidate(delta))
            {
                break;
            }
        }

        if (!CanSelectUniqueCandidate(delta))
        {
            return new KugouTrueNextProbeResult(
                target,
                currentBefore,
                candidatesBefore,
                externalInsert,
                candidatesAfter,
                delta,
                null,
                null,
                null,
                false,
                null,
                false,
                "The newly inserted SongItem could not be identified uniquely; no queue mutation was attempted.");
        }

        var selectedSongItemId = delta[0].SongItemId;
        var promote = KugouQueueNativeProbe.PromoteQueueItemAsNext(
            selectedSongItemId);
        if (promote.Stage != 6 || !promote.Succeeded)
        {
            return new KugouTrueNextProbeResult(
                target,
                currentBefore,
                candidatesBefore,
                externalInsert,
                candidatesAfter,
                delta,
                selectedSongItemId,
                promote,
                null,
                false,
                null,
                false,
                "KuGou's internal PromoteAsNext method did not accept the SongItem.");
        }

        await Task.Delay(180).ConfigureAwait(false);
        var verificationNext = KugouNativeController.SendDirectKugouCommand(
            KugouAppCommand.NextTrack,
            TimeSpan.FromSeconds(4));
        var targetBecameCurrent = MatchesTarget(
            verificationNext.After,
            target);

        BackgroundControlResult? restorePrevious = null;
        var restoredOriginal = false;
        if (targetBecameCurrent)
        {
            await Task.Delay(120).ConfigureAwait(false);
            restorePrevious = KugouNativeController.SendDirectKugouCommand(
                KugouAppCommand.PreviousTrack,
                TimeSpan.FromSeconds(4));
            restoredOriginal = SameTrack(
                restorePrevious.After,
                currentBefore);
        }

        return new KugouTrueNextProbeResult(
            target,
            currentBefore,
            candidatesBefore,
            externalInsert,
            candidatesAfter,
            delta,
            selectedSongItemId,
            promote,
            verificationNext,
            targetBecameCurrent,
            restorePrevious,
            restoredOriginal,
            targetBecameCurrent
                ? "Verified: the promoted SongItem was the real next track."
                : "PromoteAsNext returned success, but switching next did not reach the target track.");
    }

    private static KugouTrueNextProbeResult Failed(
        KugouResolvedSearchTrack target,
        KugouPlaybackState currentBefore,
        IReadOnlyList<KugouSongItemMemoryCandidate> candidatesBefore,
        BackgroundOpenResult externalInsert,
        string verdict) =>
        new(
            target,
            currentBefore,
            candidatesBefore,
            externalInsert,
            [],
            [],
            null,
            null,
            null,
            false,
            null,
            false,
            verdict);

    private static IReadOnlyList<KugouSongItemDelta> BuildDelta(
        IReadOnlyList<KugouSongItemMemoryCandidate> candidates,
        IReadOnlySet<long> addressesBefore) =>
        candidates
            .Select(candidate =>
            {
                var addedAddresses = candidate.HashAddresses
                    .Where(address => !addressesBefore.Contains(address))
                    .ToArray();
                return new KugouSongItemDelta(
                    candidate.SongItemId,
                    addedAddresses.Length,
                    candidate.MatchCount,
                    addedAddresses);
            })
            .Where(candidate => candidate.NewMatchCount > 0)
            .OrderByDescending(candidate => candidate.NewMatchCount)
            .ThenByDescending(candidate => candidate.TotalMatchCount)
            .ThenByDescending(candidate => candidate.SongItemId)
            .ToArray();

    private static bool CanSelectUniqueCandidate(
        IReadOnlyList<KugouSongItemDelta> delta)
    {
        if (delta.Count == 0 || delta[0].NewMatchCount < 2)
        {
            return false;
        }

        return delta.Count == 1
            || delta[0].NewMatchCount > delta[1].NewMatchCount;
    }

    private static bool MatchesTarget(
        KugouPlaybackState state,
        KugouResolvedSearchTrack target)
    {
        if (!string.IsNullOrWhiteSpace(state.Hash)
            && state.Hash.Equals(
                target.Hash,
                StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return Normalize(state.Title).Contains(Normalize(target.SongName))
            && (string.IsNullOrWhiteSpace(target.SingerName)
                || Normalize(state.Artist).Contains(
                    Normalize(target.SingerName)));
    }

    private static bool SameTrack(
        KugouPlaybackState left,
        KugouPlaybackState right)
    {
        if (left.SongItem > 0 && right.SongItem > 0)
        {
            return left.SongItem == right.SongItem;
        }

        return Normalize(left.RawTitle) == Normalize(right.RawTitle);
    }

    private static string Normalize(string value) =>
        string.Concat(value
            .Where(character => !char.IsWhiteSpace(character)))
            .ToLowerInvariant();
}
