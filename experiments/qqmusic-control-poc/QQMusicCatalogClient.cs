using System.Net.Http.Json;
using System.Text.Json;

namespace QQMusicControlPoc;

internal sealed record QQMusicCatalogSong(
    long SongId,
    string SongMid,
    int SongType,
    string Title,
    string Artist,
    string Album,
    string AlbumMid,
    int DurationSeconds,
    bool IsPlayable)
{
    public string StableIdentity => $"{SongId}:{SongMid}:{SongType}";
}

internal sealed class QQMusicCatalogClient : IDisposable
{
    private static readonly Uri SearchEndpoint =
        new("https://u.y.qq.com/cgi-bin/musicu.fcg");
    private const string LegacySearchEndpoint =
        "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";

    private readonly HttpClient _httpClient;

    public QQMusicCatalogClient()
    {
        _httpClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(10)
        };
        _httpClient.DefaultRequestHeaders.Referrer =
            new Uri("https://y.qq.com/");
        _httpClient.DefaultRequestHeaders.UserAgent.ParseAdd(
            "Mozilla/5.0 QQMusicControlPoc/1.0");
    }

    public async Task<IReadOnlyList<QQMusicCatalogSong>> SearchAsync(
        string query,
        int count = 12,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(query);

        var raw = await SearchRawAsync(
            query,
            count,
            cancellationToken).ConfigureAwait(false);
        using var document = JsonDocument.Parse(raw);

        if (!TryGetProperty(
                document.RootElement,
                out var list,
                "search",
                "data",
                "body",
                "song",
                "list")
            || list.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<QQMusicCatalogSong>();
        }

        var songs = new List<QQMusicCatalogSong>();
        foreach (var item in list.EnumerateArray())
        {
            if (TryParseSong(item, out var song))
            {
                songs.Add(song);
            }
        }

        return songs.Count > 0
            ? songs
            : await SearchLegacyAsync(
                query,
                count,
                cancellationToken).ConfigureAwait(false);
    }

    public async Task<string> SearchRawAsync(
        string query,
        int count = 12,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(query);

        var payload = new
        {
            comm = new
            {
                ct = 24,
                cv = 0
            },
            search = new
            {
                method = "DoSearchForQQMusicDesktop",
                module = "music.search.SearchCgiService",
                param = new
                {
                    grp = 1,
                    num_per_page = Math.Clamp(count, 1, 30),
                    page_num = 1,
                    query = query.Trim(),
                    search_type = 0
                }
            }
        };

        using var response = await _httpClient.PostAsJsonAsync(
            SearchEndpoint,
            payload,
            cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync(
            cancellationToken).ConfigureAwait(false);
    }

    public async Task<string> SearchLegacyRawAsync(
        string query,
        int count = 12,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(query);
        var parameters = new Dictionary<string, string>
        {
            ["format"] = "json",
            ["inCharset"] = "utf8",
            ["outCharset"] = "utf-8",
            ["notice"] = "0",
            ["platform"] = "yqq.json",
            ["needNewCode"] = "0",
            ["p"] = "1",
            ["n"] = Math.Clamp(count, 1, 30).ToString(),
            ["w"] = query.Trim(),
            ["cr"] = "1",
            ["g_tk"] = "5381"
        };
        var queryString = string.Join(
            '&',
            parameters.Select(pair =>
                $"{Uri.EscapeDataString(pair.Key)}="
                + Uri.EscapeDataString(pair.Value)));
        return await _httpClient.GetStringAsync(
            $"{LegacySearchEndpoint}?{queryString}",
            cancellationToken).ConfigureAwait(false);
    }

    private async Task<IReadOnlyList<QQMusicCatalogSong>>
        SearchLegacyAsync(
            string query,
            int count,
            CancellationToken cancellationToken)
    {
        var raw = await SearchLegacyRawAsync(
            query,
            count,
            cancellationToken).ConfigureAwait(false);
        using var document = JsonDocument.Parse(raw);
        if (!TryGetProperty(
                document.RootElement,
                out var list,
                "data",
                "song",
                "list")
            || list.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<QQMusicCatalogSong>();
        }

        var songs = new List<QQMusicCatalogSong>();
        foreach (var item in list.EnumerateArray())
        {
            var songId = ReadInt64(item, "songid");
            var songMid = ReadString(item, "songmid");
            var title = ReadString(item, "songname");
            if (songId <= 0
                || string.IsNullOrWhiteSpace(songMid)
                || string.IsNullOrWhiteSpace(title))
            {
                continue;
            }

            var singers = new List<string>();
            if (item.TryGetProperty("singer", out var singerArray)
                && singerArray.ValueKind == JsonValueKind.Array)
            {
                foreach (var singer in singerArray.EnumerateArray())
                {
                    var name = ReadString(singer, "name");
                    if (!string.IsNullOrWhiteSpace(name))
                    {
                        singers.Add(name);
                    }
                }
            }

            songs.Add(new QQMusicCatalogSong(
                songId,
                songMid,
                checked((int)ReadInt64(item, "songtype")),
                title,
                string.Join(" / ", singers),
                ReadString(item, "albumname"),
                ReadString(item, "albummid"),
                checked((int)ReadInt64(item, "interval")),
                true));
        }

        return songs;
    }

    public void Dispose()
    {
        _httpClient.Dispose();
    }

    private static bool TryParseSong(
        JsonElement item,
        out QQMusicCatalogSong song)
    {
        song = null!;
        var songId = ReadInt64(item, "id");
        var songMid = ReadString(item, "mid");
        var title = ReadString(item, "name");
        if (songId <= 0
            || string.IsNullOrWhiteSpace(songMid)
            || string.IsNullOrWhiteSpace(title))
        {
            return false;
        }

        var singers = new List<string>();
        if (item.TryGetProperty("singer", out var singerArray)
            && singerArray.ValueKind == JsonValueKind.Array)
        {
            foreach (var singer in singerArray.EnumerateArray())
            {
                var name = ReadString(singer, "name");
                if (!string.IsNullOrWhiteSpace(name))
                {
                    singers.Add(name);
                }
            }
        }

        var album = string.Empty;
        var albumMid = string.Empty;
        if (item.TryGetProperty("album", out var albumElement))
        {
            album = ReadString(albumElement, "name");
            albumMid = ReadString(albumElement, "mid");
        }

        var playable = true;
        if (item.TryGetProperty("action", out var action)
            && action.TryGetProperty("switch", out var switchElement)
            && switchElement.TryGetInt64(out var switchValue))
        {
            playable = (switchValue & 1) != 0;
        }

        song = new QQMusicCatalogSong(
            songId,
            songMid,
            checked((int)ReadInt64(item, "type")),
            title,
            string.Join(" / ", singers),
            album,
            albumMid,
            checked((int)ReadInt64(item, "interval")),
            playable);
        return true;
    }

    private static bool TryGetProperty(
        JsonElement root,
        out JsonElement result,
        params string[] path)
    {
        result = root;
        foreach (var name in path)
        {
            if (result.ValueKind != JsonValueKind.Object
                || !result.TryGetProperty(name, out result))
            {
                return false;
            }
        }

        return true;
    }

    private static string ReadString(
        JsonElement element,
        string propertyName)
    {
        return element.TryGetProperty(propertyName, out var property)
            && property.ValueKind == JsonValueKind.String
                ? property.GetString() ?? string.Empty
                : string.Empty;
    }

    private static long ReadInt64(
        JsonElement element,
        string propertyName)
    {
        return element.TryGetProperty(propertyName, out var property)
            && property.TryGetInt64(out var value)
                ? value
                : 0;
    }
}
