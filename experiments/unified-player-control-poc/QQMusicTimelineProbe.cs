using Windows.Media.Control;

namespace UnifiedPlayerControlPoc;

/// <summary>
/// Uses the public Windows media-session timeline only as an early-warning
/// signal. QQ playback commands still go through the existing native adapter.
/// </summary>
internal sealed class QQMusicTimelineProbe
{
    private readonly GlobalSystemMediaTransportControlsSessionManager _manager;

    private QQMusicTimelineProbe(
        GlobalSystemMediaTransportControlsSessionManager manager)
    {
        _manager = manager;
    }

    public static async Task<QQMusicTimelineProbe?> TryCreateAsync()
    {
        try
        {
            var manager =
                await GlobalSystemMediaTransportControlsSessionManager
                    .RequestAsync();
            return new QQMusicTimelineProbe(manager);
        }
        catch
        {
            return null;
        }
    }

    public bool IsPlayingNearNaturalEnd(
        TimeSpan threshold,
        out TimeSpan remaining)
    {
        remaining = TimeSpan.MaxValue;
        try
        {
            var session = _manager.GetSessions()
                .FirstOrDefault(candidate =>
                    candidate.SourceAppUserModelId.Contains(
                        "qqmusic",
                        StringComparison.OrdinalIgnoreCase));
            if (session is null)
            {
                return false;
            }

            var playback = session.GetPlaybackInfo();
            if (playback.PlaybackStatus
                != GlobalSystemMediaTransportControlsSessionPlaybackStatus
                    .Playing)
            {
                return false;
            }

            var timeline = session.GetTimelineProperties();
            if (timeline.EndTime <= timeline.StartTime
                || timeline.Position < timeline.StartTime
                || timeline.Position > timeline.EndTime)
            {
                return false;
            }

            var estimatedPosition = timeline.Position;
            var elapsedSinceUpdate =
                DateTimeOffset.Now - timeline.LastUpdatedTime;
            if (elapsedSinceUpdate > TimeSpan.Zero
                && elapsedSinceUpdate < TimeSpan.FromSeconds(5))
            {
                estimatedPosition += elapsedSinceUpdate;
            }

            remaining = timeline.EndTime - estimatedPosition;
            return remaining > TimeSpan.Zero
                && remaining <= threshold;
        }
        catch
        {
            return false;
        }
    }
}
