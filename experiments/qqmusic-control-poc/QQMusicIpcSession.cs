namespace QQMusicControlPoc;

/// <summary>
/// Serializes every QQMusicApi.dll call onto one dedicated STA thread
/// that also owns a Windows message pump. QQMusic's private objects
/// require both apartment affinity and message dispatching.
/// </summary>
internal sealed class QQMusicIpcSession : IDisposable
{
    private readonly TaskCompletionSource<bool> _ready =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Thread _thread;
    private Control? _dispatcher;
    private ApplicationContext? _applicationContext;
    private QQMusicPrivatePlaybackReader? _reader;
    private QQMusicPrivateBridge? _bridge;
    private int _disposeStarted;

    public QQMusicIpcSession()
    {
        _thread = new Thread(Run)
        {
            IsBackground = true,
            Name = "QQMusic private IPC STA message-pump session"
        };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
        _ready.Task.GetAwaiter().GetResult();
    }

    public long EndpointHandle { get; private set; }

    public Task<QQMusicPrivatePlaybackState> ReadAsync()
    {
        return InvokeAsync((reader, _) => reader.Read());
    }

    public Task<QQMusicInternalCommandResult> SendSongAsync(
        QQMusicSongCommand command,
        long songId,
        int songType,
        TimeSpan? timeout = null)
    {
        if (songId <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(songId),
                "songId 必须大于 0。");
        }

        return InvokeAsync((reader, bridge) =>
            QQMusicInternalCommandTransport.SendSong(
                reader,
                bridge,
                command,
                songId,
                songType,
                timeout));
    }

    public Task<QQMusicQueueCommandResult> SendQueueAsync(
        IReadOnlyList<QQMusicSongReference> songs,
        TimeSpan? timeout = null)
    {
        ArgumentNullException.ThrowIfNull(songs);
        if (songs.Count < 2)
        {
            throw new ArgumentException(
                "用于切歌验证的已知队列至少需要两首歌曲。",
                nameof(songs));
        }

        if (songs.Any(song => song.SongId <= 0))
        {
            throw new ArgumentException(
                "队列中的每个 songId 都必须大于 0。",
                nameof(songs));
        }

        var copy = songs.ToArray();
        return InvokeAsync((reader, bridge) =>
            QQMusicInternalCommandTransport.SendQueue(
                reader,
                bridge,
                copy,
                timeout));
    }

    public Task<QQMusicPlaybackControlResult> SendControlAsync(
        QQMusicPlaybackControl control,
        QQMusicSongReference? expectedSong = null,
        TimeSpan? timeout = null)
    {
        return InvokeAsync((reader, bridge) =>
            QQMusicPlaybackControlTransport.Send(
                reader,
                bridge,
                control,
                expectedSong,
                timeout));
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposeStarted, 1) != 0)
        {
            return;
        }

        var dispatcher = _dispatcher;
        var applicationContext = _applicationContext;
        if (dispatcher is not null
            && applicationContext is not null
            && !dispatcher.IsDisposed)
        {
            try
            {
                dispatcher.BeginInvoke(
                    (Action)applicationContext.ExitThread);
            }
            catch (InvalidOperationException)
            {
                // The message-pump thread is already exiting.
            }
        }

        if (Thread.CurrentThread != _thread)
        {
            _thread.Join(TimeSpan.FromSeconds(10));
        }

        GC.SuppressFinalize(this);
    }

    private Task<T> InvokeAsync<T>(
        Func<
            QQMusicPrivatePlaybackReader,
            QQMusicPrivateBridge,
            T> operation)
    {
        ArgumentNullException.ThrowIfNull(operation);
        ObjectDisposedException.ThrowIf(
            Volatile.Read(ref _disposeStarted) != 0,
            this);

        var dispatcher = _dispatcher
            ?? throw new InvalidOperationException(
                "QQMusic 私有 IPC 调度器尚未初始化。");
        var completion = new TaskCompletionSource<T>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            dispatcher.BeginInvoke((Action)(() =>
            {
                try
                {
                    completion.SetResult(
                        operation(_reader!, _bridge!));
                }
                catch (Exception exception)
                {
                    completion.SetException(exception);
                }
            }));
        }
        catch (InvalidOperationException)
        {
            completion.SetException(
                new ObjectDisposedException(
                    nameof(QQMusicIpcSession)));
        }

        return completion.Task;
    }

    private void Run()
    {
        try
        {
            _applicationContext = new ApplicationContext();
            _dispatcher = new Control();
            _ = _dispatcher.Handle;
            _dispatcher.BeginInvoke((Action)InitializeSession);
            Application.Run(_applicationContext);
        }
        catch (Exception exception)
        {
            _ready.TrySetException(exception);
        }
        finally
        {
            _bridge?.Dispose();
            _reader?.Dispose();
            _bridge = null;
            _reader = null;
            _dispatcher?.Dispose();
            _applicationContext?.Dispose();
            _dispatcher = null;
            _applicationContext = null;
        }
    }

    private void InitializeSession()
    {
        try
        {
            _reader = new QQMusicPrivatePlaybackReader();
            _bridge = QQMusicPrivateBridge.Open();
            _bridge.Initialize();
            EndpointHandle = _bridge.FindPrivateEndpoint();
            _ready.SetResult(true);
        }
        catch (Exception exception)
        {
            _ready.SetException(exception);
            _applicationContext?.ExitThread();
        }
    }
}
