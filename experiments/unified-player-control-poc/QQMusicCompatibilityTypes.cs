namespace QQMusicControlPoc;

// QQMusicNativeNextTransport originally gets this record from the experimental
// internal-command file. Keeping the small value type here avoids compiling the
// unrelated diagnostic transports into the unified application.
internal sealed record QQMusicSongReference(long SongId, int SongType);
