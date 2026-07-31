namespace KugouControlPoc;

internal sealed class KugouTrackChangedEventArgs(
    KugouPlaybackState previous,
    KugouPlaybackState current,
    DateTimeOffset timestamp) : EventArgs
{
    public KugouPlaybackState Previous { get; } = previous;
    public KugouPlaybackState Current { get; } = current;
    public DateTimeOffset Timestamp { get; } = timestamp;
}

internal sealed class KugouStateEventArgs(KugouPlaybackState state) : EventArgs
{
    public KugouPlaybackState State { get; } = state;
}

internal sealed class KugouMonitorErrorEventArgs(Exception exception) : EventArgs
{
    public Exception Exception { get; } = exception;
}

internal sealed class KugouVipPopupClosedEventArgs(
    VipPopupGuardResult result) : EventArgs
{
    public VipPopupGuardResult Result { get; } = result;
}

internal sealed class KugouTrackMonitor : IDisposable
{
    private readonly System.Threading.Timer _timer;
    private KugouPlaybackState? _lastState;
    private string? _lastPopupFingerprint;
    private int _polling;
    private bool _disposed;

    public KugouTrackMonitor(TimeSpan pollInterval)
    {
        _timer = new System.Threading.Timer(
            Poll,
            null,
            Timeout.InfiniteTimeSpan,
            pollInterval);
    }

    public event EventHandler<KugouStateEventArgs>? StateUpdated;
    public event EventHandler<KugouTrackChangedEventArgs>? TrackChanged;
    public event EventHandler<KugouVipPopupClosedEventArgs>? VipPopupClosed;
    public event EventHandler<KugouVipPopupClosedEventArgs>? VipPopupStatusChanged;
    public event EventHandler<KugouMonitorErrorEventArgs>? Error;

    public void Start()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        _timer.Change(TimeSpan.Zero, TimeSpan.FromMilliseconds(250));
    }

    public void Stop()
    {
        if (!_disposed)
        {
            _timer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        }
    }

    private async void Poll(object? _)
    {
        if (Interlocked.Exchange(ref _polling, 1) != 0)
        {
            return;
        }

        try
        {
            var popup = KugouNativeController.TryCloseVipTrialPopup();
            var popupFingerprint =
                $"{popup.Found}:{popup.CloseSucceeded}:"
                + $"{popup.HostWindowHandle}:{popup.Error}";
            if (!string.Equals(
                    _lastPopupFingerprint,
                    popupFingerprint,
                    StringComparison.Ordinal))
            {
                _lastPopupFingerprint = popupFingerprint;
                VipPopupStatusChanged?.Invoke(
                    this,
                    new KugouVipPopupClosedEventArgs(popup));
            }

            if (popup.CloseSucceeded)
            {
                VipPopupClosed?.Invoke(
                    this,
                    new KugouVipPopupClosedEventArgs(popup));
            }

            var current =
                await KugouNativeController.ReadPlaybackStateWithIdentityAsync();
            StateUpdated?.Invoke(this, new KugouStateEventArgs(current));

            var previous = _lastState;
            _lastState = current;
            if (previous is not null && !SameTrack(previous, current))
            {
                TrackChanged?.Invoke(
                    this,
                    new KugouTrackChangedEventArgs(previous, current, DateTimeOffset.Now));
            }
        }
        catch (Exception exception)
        {
            Error?.Invoke(this, new KugouMonitorErrorEventArgs(exception));
        }
        finally
        {
            Volatile.Write(ref _polling, 0);
        }
    }

    private static bool SameTrack(KugouPlaybackState left, KugouPlaybackState right)
    {
        return KugouNativeController.SamePlaybackIdentity(left, right);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _timer.Dispose();
    }
}
