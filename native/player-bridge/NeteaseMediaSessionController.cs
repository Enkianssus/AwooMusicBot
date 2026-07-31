using Windows.Media.Control;

namespace UnifiedPlayerControlPoc;

internal sealed record MediaSessionDescriptor(
    string SourceAppUserModelId,
    string PlaybackStatus,
    string Title,
    string Artist,
    bool IsNetease);

internal sealed record MediaSessionCommandResult(
    bool SessionFound,
    bool Accepted,
    string Message);

internal static class NeteaseMediaSessionController
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static GlobalSystemMediaTransportControlsSessionManager? _manager;

    public static async Task<IReadOnlyList<MediaSessionDescriptor>>
        ListSessionsAsync(CancellationToken cancellationToken)
    {
        await Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var manager = await GetManagerAsync().ConfigureAwait(false);
            var sessions = new List<MediaSessionDescriptor>();
            foreach (var session in manager.GetSessions())
            {
                cancellationToken.ThrowIfCancellationRequested();
                var title = string.Empty;
                var artist = string.Empty;
                try
                {
                    var properties =
                        await session.TryGetMediaPropertiesAsync();
                    title = properties?.Title ?? string.Empty;
                    artist = properties?.Artist ?? string.Empty;
                }
                catch
                {
                    // Session identity and playback status are still useful.
                }

                sessions.Add(new MediaSessionDescriptor(
                    session.SourceAppUserModelId,
                    session.GetPlaybackInfo().PlaybackStatus.ToString(),
                    title,
                    artist,
                    IsNeteaseSession(session.SourceAppUserModelId)));
            }

            return sessions;
        }
        finally
        {
            Gate.Release();
        }
    }

    public static async Task<MediaSessionCommandResult> ExecuteAsync(
        PlayerCommand command,
        CancellationToken cancellationToken)
    {
        await Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var manager = await GetManagerAsync().ConfigureAwait(false);
            var session = manager.GetSessions().FirstOrDefault(candidate =>
                IsNeteaseSession(candidate.SourceAppUserModelId));
            if (session is null)
            {
                var ids = manager.GetSessions()
                    .Select(candidate => candidate.SourceAppUserModelId)
                    .Where(id => !string.IsNullOrWhiteSpace(id))
                    .Distinct(StringComparer.OrdinalIgnoreCase);
                return new MediaSessionCommandResult(
                    false,
                    false,
                    "没有发现网易云 Windows 媒体会话。当前会话: "
                    + string.Join(", ", ids));
            }

            var accepted = command switch
            {
                PlayerCommand.Previous =>
                    await session.TrySkipPreviousAsync(),
                PlayerCommand.Next =>
                    await session.TrySkipNextAsync(),
                PlayerCommand.Pause =>
                    await session.TryPauseAsync(),
                PlayerCommand.Resume =>
                    await session.TryPlayAsync(),
                _ => false
            };
            return new MediaSessionCommandResult(
                true,
                accepted,
                accepted
                    ? $"Windows 媒体会话已接收 {command}，未调用网易云窗口 IPC。"
                    : $"网易云 Windows 媒体会话拒绝 {command}。");
        }
        catch (Exception exception)
        {
            _manager = null;
            return new MediaSessionCommandResult(
                false,
                false,
                $"Windows 媒体会话异常: {exception.Message}");
        }
        finally
        {
            Gate.Release();
        }
    }

    private static async Task<
        GlobalSystemMediaTransportControlsSessionManager> GetManagerAsync()
    {
        _manager ??=
            await GlobalSystemMediaTransportControlsSessionManager
                .RequestAsync();
        return _manager;
    }

    private static bool IsNeteaseSession(string sourceAppUserModelId)
    {
        return sourceAppUserModelId.Contains(
                "cloudmusic",
                StringComparison.OrdinalIgnoreCase)
            || sourceAppUserModelId.Contains(
                "netease",
                StringComparison.OrdinalIgnoreCase)
            || sourceAppUserModelId.Contains(
                "orpheus",
                StringComparison.OrdinalIgnoreCase)
            || sourceAppUserModelId.Contains(
                "music.163",
                StringComparison.OrdinalIgnoreCase);
    }
}
