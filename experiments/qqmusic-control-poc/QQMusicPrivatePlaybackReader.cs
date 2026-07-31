using System.Xml.Linq;

namespace QQMusicControlPoc;

internal sealed record QQMusicPrivatePlaybackState(
    long SongId,
    int SongType,
    string ListName,
    string ListKey,
    int SongPosition,
    int PlayStatus,
    DateTimeOffset ObservedAt)
{
    public bool HasStableSongId => SongId > 0 && SongType >= 0;

    public string StableIdentity =>
        HasStableSongId
            ? $"qq:{SongId}:{SongType}"
            : $"position:{ListKey}:{SongPosition}";
}

internal sealed class QQMusicPrivatePlaybackReader : IDisposable
{
    private readonly QQMusicApiClient _client;

    public QQMusicPrivatePlaybackReader()
    {
        _client = QQMusicApiClient.Open();
    }

    public QQMusicPrivatePlaybackState Read()
    {
        var xml = _client.WebPerform3(
            QQMusicWebProtocol.QueryPlayStatus());
        if (string.IsNullOrWhiteSpace(xml))
        {
            throw new InvalidDataException(
                "QQMusicApi.QueryPlayStatus 返回为空。");
        }

        var document = XDocument.Parse(xml);
        var songInfo = document
            .Descendants("songinfo")
            .FirstOrDefault()
            ?? throw new InvalidDataException(
                "QueryPlayStatus 响应中没有 songinfo。");

        return new QQMusicPrivatePlaybackState(
            ReadInt64(songInfo, "songID"),
            ReadInt32(songInfo, "songtype"),
            ReadString(songInfo, "listname"),
            ReadString(songInfo, "listkey"),
            ReadInt32(songInfo, "songpos"),
            ReadInt32(songInfo, "playstatus"),
            DateTimeOffset.Now);
    }

    public void Dispose()
    {
        _client.Dispose();
    }

    private static string ReadString(
        XElement element,
        string attributeName)
    {
        return (string?)element.Attribute(attributeName)
            ?? string.Empty;
    }

    private static int ReadInt32(
        XElement element,
        string attributeName)
    {
        return int.TryParse(
            ReadString(element, attributeName),
            out var value)
                ? value
                : 0;
    }

    private static long ReadInt64(
        XElement element,
        string attributeName)
    {
        return long.TryParse(
            ReadString(element, attributeName),
            out var value)
                ? value
                : 0;
    }
}
