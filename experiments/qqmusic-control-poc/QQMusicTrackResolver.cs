using System.Globalization;
using System.Text;

namespace QQMusicControlPoc;

internal sealed record QQMusicResolvedTrack(
    string Title,
    string Artist,
    long? SongId,
    string? SongMid,
    int? SongType,
    string Identity,
    string Resolution,
    DateTimeOffset ObservedAt);

internal sealed class QQMusicTrackResolver
{
    private readonly QQMusicCatalogClient _catalog;
    private readonly Dictionary<string, QQMusicCatalogSong> _cache =
        new(StringComparer.Ordinal);

    public QQMusicTrackResolver(QQMusicCatalogClient catalog)
    {
        _catalog = catalog;
    }

    public async Task<QQMusicResolvedTrack?> ResolveAsync(
        QQMusicPlaybackState state,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(state.Title))
        {
            return null;
        }

        var title = state.Title.Trim();
        var artist = state.Artist?.Trim() ?? string.Empty;
        var key = BuildKey(title, artist);
        if (_cache.TryGetValue(key, out var cached))
        {
            return FromCatalog(cached, "Cache");
        }

        var results = await _catalog.SearchAsync(
            string.IsNullOrWhiteSpace(artist)
                ? title
                : $"{title} {artist}",
            15,
            cancellationToken).ConfigureAwait(false);

        var exact = results.FirstOrDefault(candidate =>
            Normalize(candidate.Title) == Normalize(title)
            && ArtistsOverlap(candidate.Artist, artist));
        exact ??= results.FirstOrDefault(candidate =>
            Normalize(candidate.Title) == Normalize(title));
        exact ??= results.FirstOrDefault();

        if (exact is null)
        {
            return new QQMusicResolvedTrack(
                title,
                artist,
                null,
                null,
                null,
                $"title:{key}",
                "WindowTitleOnly",
                state.ObservedAt);
        }

        _cache[key] = exact;
        return FromCatalog(exact, "QQMusicCatalogSearch");
    }

    public QQMusicResolvedTrack? ResolveKnown(
        QQMusicPlaybackState state)
    {
        if (string.IsNullOrWhiteSpace(state.Title))
        {
            return null;
        }

        var title = state.Title.Trim();
        var artist = state.Artist?.Trim() ?? string.Empty;
        var key = BuildKey(title, artist);
        return _cache.TryGetValue(key, out var cached)
            ? FromCatalog(cached, "Cache")
            : new QQMusicResolvedTrack(
                title,
                artist,
                null,
                null,
                null,
                $"title:{key}",
                "WindowTitleOnly",
                state.ObservedAt);
    }

    public void Remember(QQMusicCatalogSong song)
    {
        _cache[BuildKey(song.Title, song.Artist)] = song;
    }

    private static QQMusicResolvedTrack FromCatalog(
        QQMusicCatalogSong song,
        string resolution)
    {
        return new QQMusicResolvedTrack(
            song.Title,
            song.Artist,
            song.SongId,
            song.SongMid,
            song.SongType,
            song.StableIdentity,
            resolution,
            DateTimeOffset.Now);
    }

    private static bool ArtistsOverlap(string left, string right)
    {
        if (string.IsNullOrWhiteSpace(right))
        {
            return true;
        }

        var normalizedLeft = Normalize(left);
        return right
            .Split(
                ['/', '、', ',', '&'],
                StringSplitOptions.TrimEntries
                    | StringSplitOptions.RemoveEmptyEntries)
            .Select(Normalize)
            .Any(artist =>
                normalizedLeft.Contains(
                    artist,
                    StringComparison.Ordinal));
    }

    private static string BuildKey(string title, string artist)
    {
        return $"{Normalize(title)}|{Normalize(artist)}";
    }

    private static string Normalize(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var character in value.Normalize(
                     NormalizationForm.FormKC))
        {
            if (char.IsLetterOrDigit(character))
            {
                builder.Append(char.ToLower(
                    character,
                    CultureInfo.InvariantCulture));
            }
        }

        return builder.ToString();
    }
}
