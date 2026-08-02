using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;

namespace UnifiedPlayerControlPoc;

/// <summary>
/// Hosts one of the independent desktop-player connectors. The connector owns
/// all player-specific native work; this adapter only speaks protocol-v1 over
/// the child process' stdin/stdout streams.
/// </summary>
internal sealed class ConnectorProcessAdapter :
    IPlayerAdapter,
    IPlayerSnapshotEventSource
{
    private const int ProtocolVersion = 1;
    private const int SnapshotEventProtocolVersion = 1;
    private const string SnapshotEventsFeature = "snapshot-events-v1";
    private const string Framework = "net8.0-windows10.0.19041.0";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        Converters =
        {
            new JsonStringEnumConverter(JsonNamingPolicy.CamelCase)
        }
    };

    private readonly ConnectorDefinition _definition;
    private readonly SemaphoreSlim _lifecycleGate = new(1, 1);
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private readonly ConcurrentDictionary<
        string,
        TaskCompletionSource<JsonElement?>> _pending = [];
    private readonly CancellationTokenSource _lifetime = new();

    private readonly object _stateSync = new();
    private Channel<PlayerSnapshot> _snapshotEvents = CreateSnapshotChannel();
    private Process? _process;
    private CancellationTokenSource? _processCancellation;
    private Task? _stdoutTask;
    private Task? _stderrTask;
    private volatile bool _eventSubscriptionActive;
    private volatile bool _disposed;
    private bool _offlinePublished;
    private int _disposeStarted;
    private long _requestSequence;
    private long _lastSnapshotSequence;
    private volatile string _resolvedExecutablePath = string.Empty;
    private volatile string _connectorVersion = string.Empty;
    private volatile string _lastStatus = string.Empty;
    private volatile string _lastStderr = string.Empty;
    private string[] _features = [];

    private ConnectorProcessAdapter(ConnectorDefinition definition)
    {
        _definition = definition;
        Capabilities = definition.FallbackCapabilities;
    }

    public string Key => _definition.Key;

    public string DisplayName => _definition.DisplayName;

    public string TestedVersion => _definition.TestedVersion;

    public PlayerCapabilities Capabilities { get; private set; }

    public string ProjectDirectory => _definition.ProjectDirectory;

    public string ExecutableName => _definition.ExecutableName;

    public string RuntimeIdentifier => _definition.RuntimeIdentifier;

    public string ConnectorVersion => _connectorVersion;

    public IReadOnlyList<string> Features
    {
        get
        {
            lock (_stateSync)
            {
                return [.. _features];
            }
        }
    }

    public int? EventProtocolVersion { get; private set; }

    public bool SnapshotEventsSubscribed => _eventSubscriptionActive;

    public long LastSnapshotSequence => Interlocked.Read(
        ref _lastSnapshotSequence);

    public string LastStderr => _lastStderr;

    public string LastStatus => _lastStatus;

    public string ResolvedExecutablePath => _resolvedExecutablePath;

    public static ConnectorProcessAdapter CreateDefault(string playerKey)
    {
        var normalized = playerKey?.Trim().ToLowerInvariant();
        return normalized switch
        {
            "netease" => new ConnectorProcessAdapter(new ConnectorDefinition(
                "netease",
                "网易云音乐",
                "src/Netease",
                "BiliNCM.Connector.Netease.exe",
                "win-x64",
                "3.1.37.205354",
                new PlayerCapabilities(
                    Search: true,
                    PlaySelected: true,
                    Previous: true,
                    Pause: true,
                    Resume: true,
                    Toggle: false,
                    Next: true,
                    InsertNext: true,
                    InsertNextLevel:
                        "进程内 CEF 插入并验证 + 错歌暂停接管守卫"))),
            "kugou" => new ConnectorProcessAdapter(new ConnectorDefinition(
                "kugou",
                "酷狗音乐",
                "src/Kugou",
                "BiliNCM.Connector.Kugou.exe",
                "win-x86",
                "20.0.81.27563",
                new PlayerCapabilities(
                    Search: true,
                    PlaySelected: true,
                    Previous: true,
                    Pause: false,
                    Resume: false,
                    Toggle: true,
                    Next: true,
                    InsertNext: true,
                    InsertNextLevel:
                        "原生插入 + 上一首重置锚点的有界兜底"))),
            "qqmusic" => new ConnectorProcessAdapter(new ConnectorDefinition(
                "qqmusic",
                "QQ 音乐",
                "src/QQMusic",
                "BiliNCM.Connector.QQMusic.exe",
                "win-x86",
                "22.22 / 22.41",
                new PlayerCapabilities(
                    Search: true,
                    PlaySelected: true,
                    Previous: true,
                    Pause: true,
                    Resume: true,
                    Toggle: false,
                    Next: true,
                    InsertNext: true,
                    InsertNextLevel:
                        "精确版本画像原生插队；静音+暂停守卫防漏音"))),
            _ => throw new ArgumentException(
                "播放器连接器必须是 netease、kugou 或 qqmusic。",
                nameof(playerKey))
        };
    }

    public async Task<PlayerSnapshot> ProbeAsync(
        CancellationToken cancellationToken)
    {
        try
        {
            await EnsureStartedAsync(cancellationToken).ConfigureAwait(false);
            var result = await RequestAsync(
                    "probe",
                    new Dictionary<string, object?>
                    {
                        ["player"] = Key
                    },
                    TimeSpan.FromSeconds(8),
                    cancellationToken)
                .ConfigureAwait(false);
            var snapshot = DeserializeRequired<PlayerSnapshot>(
                result,
                "probe 返回的 snapshot 为空。");
            var normalized = NormalizeSnapshot(snapshot);
            _lastStatus = normalized.Status ?? string.Empty;
            return normalized;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            return BuildOfflineSnapshot($"探测失败：{exception.Message}");
        }
    }

    public async Task<IReadOnlyList<PlayerTrack>> SearchAsync(
        string query,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(query);
        await EnsureStartedAsync(cancellationToken).ConfigureAwait(false);
        var result = await RequestAsync(
                "search",
                new Dictionary<string, object?>
                {
                    ["player"] = Key,
                    ["query"] = query.Trim()
                },
                TimeSpan.FromSeconds(18),
                cancellationToken)
            .ConfigureAwait(false);
        if (result is null || result.Value.ValueKind == JsonValueKind.Null)
        {
            return [];
        }

        return JsonSerializer.Deserialize<PlayerTrack[]>(
                   result.Value.GetRawText(),
                   JsonOptions)
               ?? [];
    }

    public async Task<PlayerOperationResult> ExecuteAsync(
        PlayerCommand command,
        PlayerTrack? track,
        CancellationToken cancellationToken)
    {
        try
        {
            await EnsureStartedAsync(cancellationToken).ConfigureAwait(false);
            var result = await RequestAsync(
                    "execute",
                    new Dictionary<string, object?>
                    {
                        ["player"] = Key,
                        ["command"] = command,
                        ["track"] = track
                    },
                    TimeSpan.FromSeconds(25),
                    cancellationToken)
                .ConfigureAwait(false);
            var operation = DeserializeRequired<PlayerOperationResult>(
                result,
                "execute 返回的 operation 为空。");
            if (operation.Snapshot is not null)
            {
                _lastStatus = operation.Snapshot.Status ?? string.Empty;
            }

            return operation;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            var snapshot = BuildOfflineSnapshot(
                $"执行失败：{exception.Message}");
            return new PlayerOperationResult(
                OperationOutcome.Rejected,
                snapshot.Status,
                snapshot);
        }
    }

    public async IAsyncEnumerable<PlayerSnapshot> WatchSnapshotsAsync(
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        Exception? startupException = null;
        try
        {
            await EnsureStartedAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            startupException = exception;
        }

        if (startupException is not null)
        {
            yield return BuildOfflineSnapshot(
                $"连接器启动失败：{startupException.Message}");
            yield break;
        }

        var initial = await ProbeAsync(cancellationToken).ConfigureAwait(false);
        yield return initial;

        ChannelReader<PlayerSnapshot> reader;
        var eventSubscriptionActive = _eventSubscriptionActive;
        lock (_stateSync)
        {
            reader = _snapshotEvents.Reader;
        }

        if (!eventSubscriptionActive)
        {
            // The WinForms host owns the compatibility polling loop. Ending
            // this iterator makes that fallback visible instead of disguising
            // a one-second probe loop as a protocol event stream.
            yield break;
        }

        while (await reader.WaitToReadAsync(cancellationToken)
                   .ConfigureAwait(false))
        {
            while (reader.TryRead(out var snapshot))
            {
                yield return snapshot;
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposeStarted, 1) != 0)
        {
            return;
        }

        try
        {
            await StopProcessAsync(sendShutdown: true).ConfigureAwait(false);
        }
        finally
        {
            _disposed = true;
            _lifetime.Cancel();
            lock (_stateSync)
            {
                _snapshotEvents.Writer.TryComplete();
            }

            _lifetime.Dispose();
            _lifecycleGate.Dispose();
            _writeGate.Dispose();
        }
    }

    private async Task EnsureStartedAsync(CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        if (IsProcessRunning())
        {
            return;
        }

        await _lifecycleGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThrowIfDisposed();
            if (!IsProcessRunning())
            {
                await StartProcessCoreAsync(cancellationToken)
                    .ConfigureAwait(false);
            }
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    private async Task StartProcessCoreAsync(
        CancellationToken cancellationToken)
    {
        var executable = ResolveExecutablePath();
        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = executable,
                WorkingDirectory = Path.GetDirectoryName(executable)
                    ?? Environment.CurrentDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            },
            EnableRaisingEvents = true
        };
        process.Exited += (_, _) => MarkProcessUnavailable(
            process,
            "连接器进程已退出");

        if (!process.Start())
        {
            process.Dispose();
            throw new InvalidOperationException(
                $"无法启动连接器：{executable}");
        }

        var processCancellation = CancellationTokenSource
            .CreateLinkedTokenSource(_lifetime.Token);
        lock (_stateSync)
        {
            if (_disposed)
            {
                processCancellation.Dispose();
                process.Kill(entireProcessTree: true);
                process.Dispose();
                throw new ObjectDisposedException(nameof(ConnectorProcessAdapter));
            }

            _process = process;
            _processCancellation = processCancellation;
            _stdoutTask = ReadStdoutLoopAsync(
                process,
                processCancellation.Token);
            _stderrTask = ReadStderrLoopAsync(
                process,
                processCancellation.Token);
            _snapshotEvents = CreateSnapshotChannel();
            _offlinePublished = false;
            _eventSubscriptionActive = false;
            _lastSnapshotSequence = 0;
            _resolvedExecutablePath = executable;
        }

        try
        {
            var ping = await RequestAsync(
                    "ping",
                    new Dictionary<string, object?>(),
                    TimeSpan.FromSeconds(5),
                    cancellationToken)
                .ConfigureAwait(false);
            ApplyPing(ping);
            if (_features.Contains(
                    SnapshotEventsFeature,
                    StringComparer.OrdinalIgnoreCase))
            {
                await TrySubscribeEventsAsync(cancellationToken)
                    .ConfigureAwait(false);
            }
        }
        catch
        {
            await StopProcessCoreAsync(process, sendShutdown: false)
                .ConfigureAwait(false);
            throw;
        }
    }

    private async Task TrySubscribeEventsAsync(
        CancellationToken cancellationToken)
    {
        try
        {
            var response = await RequestAsync(
                    "subscribe",
                    new Dictionary<string, object?>
                    {
                        ["eventProtocolVersion"] = SnapshotEventProtocolVersion
                    },
                    TimeSpan.FromSeconds(5),
                    cancellationToken)
                .ConfigureAwait(false);
            var subscribed = ReadBoolean(response, "subscribed");
            _eventSubscriptionActive = subscribed;
            if (!subscribed)
            {
                RecordStderr(
                    "snapshot-events-v1 不可用，将回退到 probe 状态读取。");
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            _eventSubscriptionActive = false;
            RecordStderr(
                $"snapshot 事件订阅失败，将回退到 probe：{exception.Message}");
        }
    }

    private void ApplyPing(JsonElement? result)
    {
        var root = RequireObject(result, "ping 返回为空。");
        var protocolVersion = ReadInt(root, "protocolVersion");
        if (protocolVersion != ProtocolVersion)
        {
            throw new InvalidOperationException(
                $"连接器协议版本不匹配：收到 {protocolVersion}，需要 {ProtocolVersion}。 ");
        }

        var connectorId = ReadString(root, "connectorId");
        if (!connectorId.Equals(Key, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"连接器标识不匹配：收到 {connectorId}，需要 {Key}。");
        }

        _connectorVersion = ReadString(root, "connectorVersion");
        EventProtocolVersion = ReadNullableInt(root, "eventProtocolVersion");
        var features = ReadStringArray(root, "features");
        lock (_stateSync)
        {
            _features = features;
        }

        if (root.TryGetProperty("capabilities", out var capabilities)
            && capabilities.ValueKind == JsonValueKind.Object)
        {
            var parsed = JsonSerializer.Deserialize<PlayerCapabilities>(
                capabilities.GetRawText(),
                JsonOptions);
            if (parsed is not null)
            {
                Capabilities = parsed;
            }
        }
    }

    private async Task<JsonElement?> RequestAsync(
        string action,
        IReadOnlyDictionary<string, object?> fields,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        Process process;
        lock (_stateSync)
        {
            process = _process
                ?? throw new IOException("播放器连接器未运行。");
        }

        try
        {
            if (process.HasExited)
            {
                throw new IOException("播放器连接器已退出。");
            }
        }
        catch (InvalidOperationException exception)
        {
            throw new IOException("播放器连接器尚未启动。", exception);
        }

        var id = $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-"
            + Interlocked.Increment(ref _requestSequence);
        var completion = new TaskCompletionSource<JsonElement?>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_pending.TryAdd(id, completion))
        {
            throw new InvalidOperationException(
                "无法登记播放器连接器请求。");
        }

        try
        {
            var request = new Dictionary<string, object?>(fields)
            {
                ["id"] = id,
                ["action"] = action
            };
            var line = JsonSerializer.Serialize(request, JsonOptions);

            await _writeGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                lock (_stateSync)
                {
                    if (!ReferenceEquals(_process, process))
                    {
                        throw new IOException("播放器连接器已切换。");
                    }
                }

                await process.StandardInput.WriteLineAsync(line)
                    .ConfigureAwait(false);
                await process.StandardInput.FlushAsync().ConfigureAwait(false);
            }
            finally
            {
                _writeGate.Release();
            }

            return await completion.Task
                .WaitAsync(timeout, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            _pending.TryRemove(id, out _);
        }
    }

    private async Task ReadStdoutLoopAsync(
        Process process,
        CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var line = await process.StandardOutput
                    .ReadLineAsync(cancellationToken)
                    .ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }

                if (!string.IsNullOrWhiteSpace(line))
                {
                    HandleStdoutLine(process, line);
                }
            }
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
            // Normal restart or shutdown.
        }
        catch (Exception exception)
        {
            RecordStderr($"stdout 读取失败：{exception.Message}");
        }
        finally
        {
            MarkProcessUnavailable(process, "连接器 stdout 已断开");
        }
    }

    private async Task ReadStderrLoopAsync(
        Process process,
        CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var line = await process.StandardError
                    .ReadLineAsync(cancellationToken)
                    .ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }

                line = line.Trim();
                if (!string.IsNullOrWhiteSpace(line))
                {
                    RecordStderr(line);
                }
            }
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
            // Normal restart or shutdown.
        }
        catch (Exception exception)
        {
            RecordStderr($"stderr 读取失败：{exception.Message}");
        }
    }

    private void HandleStdoutLine(Process process, string line)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(line);
        }
        catch (JsonException exception)
        {
            RecordStderr($"收到非 JSON 输出：{exception.Message}");
            return;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.TryGetProperty("type", out var type)
                && type.ValueKind == JsonValueKind.String
                && type.GetString()?.Equals(
                    "event",
                    StringComparison.OrdinalIgnoreCase) == true)
            {
                HandleEvent(process, root);
                return;
            }

            if (!root.TryGetProperty("id", out var idElement)
                || idElement.ValueKind != JsonValueKind.String)
            {
                RecordStderr("收到没有 id 的连接器响应。");
                return;
            }

            var id = idElement.GetString() ?? string.Empty;
            if (!_pending.TryRemove(id, out var completion))
            {
                return;
            }

            var ok = root.TryGetProperty("ok", out var okElement)
                && okElement.ValueKind == JsonValueKind.True;
            if (ok)
            {
                var result = root.TryGetProperty("result", out var resultElement)
                    ? resultElement.Clone()
                    : (JsonElement?)null;
                completion.TrySetResult(result);
                return;
            }

            var error = root.TryGetProperty("error", out var errorElement)
                && errorElement.ValueKind == JsonValueKind.String
                ? errorElement.GetString()
                : "播放器连接器请求失败";
            completion.TrySetException(new InvalidOperationException(error));
        }
    }

    private void HandleEvent(Process process, JsonElement root)
    {
        var eventName = ReadString(root, "event");
        if (!eventName.Equals("snapshot", StringComparison.OrdinalIgnoreCase)
            || !root.TryGetProperty("snapshot", out var snapshotElement)
            || snapshotElement.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        PlayerSnapshot snapshot;
        try
        {
            snapshot = DeserializeRequired<PlayerSnapshot>(
                snapshotElement.Clone(),
                "snapshot 事件为空。");
        }
        catch (Exception exception)
        {
            RecordStderr($"snapshot 事件解析失败：{exception.Message}");
            return;
        }

        var sequence = ReadLong(root, "sequence");
        if (sequence > 0
            && sequence <= Interlocked.Read(ref _lastSnapshotSequence))
        {
            return;
        }

        if (sequence > 0)
        {
            Interlocked.Exchange(ref _lastSnapshotSequence, sequence);
        }

        lock (_stateSync)
        {
            if (!ReferenceEquals(_process, process))
            {
                return;
            }

            _lastStatus = snapshot.Status ?? string.Empty;
            _snapshotEvents.Writer.TryWrite(NormalizeSnapshot(snapshot));
        }
    }

    private async Task StopProcessAsync(bool sendShutdown)
    {
        await _lifecycleGate.WaitAsync().ConfigureAwait(false);
        try
        {
            Process? process;
            lock (_stateSync)
            {
                process = _process;
            }

            if (process is not null)
            {
                await StopProcessCoreAsync(process, sendShutdown)
                    .ConfigureAwait(false);
            }
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    private async Task StopProcessCoreAsync(
        Process process,
        bool sendShutdown)
    {
        if (sendShutdown && IsLive(process))
        {
            try
            {
                await RequestAsync(
                        "shutdown",
                        new Dictionary<string, object?>(),
                        TimeSpan.FromSeconds(1.5),
                        CancellationToken.None)
                    .ConfigureAwait(false);
            }
            catch
            {
                // A dead or unresponsive connector is still safe to terminate
                // because this Process instance was started by this adapter.
            }
        }

        CancellationTokenSource? processCancellation;
        Task? stdoutTask;
        Task? stderrTask;
        lock (_stateSync)
        {
            processCancellation = _processCancellation;
            stdoutTask = _stdoutTask;
            stderrTask = _stderrTask;
        }

        processCancellation?.Cancel();
        if (IsLive(process))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // It exited between IsLive and Kill.
            }
        }

        try
        {
            await process.WaitForExitAsync()
                .WaitAsync(TimeSpan.FromSeconds(2))
                .ConfigureAwait(false);
        }
        catch
        {
            // Shutdown is best effort; do not keep a stale process reference.
        }

        try
        {
            var tasks = new[] { stdoutTask, stderrTask }
                .Where(task => task is not null)
                .Cast<Task>()
                .ToArray();
            if (tasks.Length > 0)
            {
                await Task.WhenAll(tasks)
                    .WaitAsync(TimeSpan.FromSeconds(2))
                    .ConfigureAwait(false);
            }
        }
        catch
        {
            // Reader tasks observe cancellation and will exit shortly.
        }
        finally
        {
            MarkProcessUnavailable(process, "连接器已停止");
            processCancellation?.Dispose();
            process.Dispose();
        }
    }

    private void MarkProcessUnavailable(Process process, string reason)
    {
        TaskCompletionSource<JsonElement?>[] pending;
        Channel<PlayerSnapshot>? channel = null;
        var publishOffline = false;
        lock (_stateSync)
        {
            if (!ReferenceEquals(_process, process))
            {
                return;
            }

            _process = null;
            _eventSubscriptionActive = false;
            _processCancellation?.Cancel();
            pending = [.. _pending.Values];
            _pending.Clear();
            channel = _snapshotEvents;
            publishOffline = !_offlinePublished;
            _offlinePublished = true;
            if (publishOffline)
            {
                channel.Writer.TryWrite(BuildOfflineSnapshot(reason));
            }

            channel.Writer.TryComplete();
        }

        foreach (var completion in pending)
        {
            completion.TrySetException(new IOException(
                $"播放器连接器已断开：{reason}"));
        }
    }

    private string ResolveExecutablePath()
    {
        var perConnectorVariable =
            $"BILINCM_CONNECTOR_{Key.ToUpperInvariant()}_PATH";
        var candidates = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        AddOverrideCandidates(
            Environment.GetEnvironmentVariable(perConnectorVariable),
            candidates,
            seen);
        AddOverrideCandidates(
            Environment.GetEnvironmentVariable("BILINCM_CONNECTOR_ROOT"),
            candidates,
            seen);

        foreach (var baseDirectory in EnumerateSearchBases())
        {
            AddRootCandidates(baseDirectory, candidates, seen);
            AddRootCandidates(
                Path.Combine(baseDirectory, "BiliNCM-Connectors"),
                candidates,
                seen);
            AddRootCandidates(
                Path.Combine(baseDirectory, "..", "BiliNCM-Connectors"),
                candidates,
                seen);
        }

        foreach (var candidate in candidates)
        {
            if (File.Exists(candidate))
            {
                return Path.GetFullPath(candidate);
            }
        }

        throw new FileNotFoundException(
            $"没有找到 {DisplayName} 独立连接器 {ExecutableName}。"
            + $" 可设置 {perConnectorVariable} 或"
            + " BILINCM_CONNECTOR_ROOT 指向连接器目录。"
            + $" 已检查 {candidates.Count} 个候选路径。",
            ExecutableName);
    }

    private void AddOverrideCandidates(
        string? value,
        ICollection<string> candidates,
        ISet<string> seen)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return;
        }

        var path = value.Trim().Trim('"');
        if (File.Exists(path))
        {
            AddCandidate(path, candidates, seen);
            return;
        }

        if (!Directory.Exists(path))
        {
            // Keep an explicit but not-yet-created override in the candidate
            // list so the failure message remains actionable.
            AddCandidate(path, candidates, seen);
            return;
        }

        AddRootCandidates(path, candidates, seen);
        AddCandidate(Path.Combine(path, ExecutableName), candidates, seen);
        AddCandidate(
            Path.Combine(path, "publish", ExecutableName),
            candidates,
            seen);
        AddCandidate(
            Path.Combine(path, Key, ExecutableName),
            candidates,
            seen);
        AddCandidate(
            Path.Combine(path, Key, "publish", ExecutableName),
            candidates,
            seen);
    }

    private void AddRootCandidates(
        string root,
        ICollection<string> candidates,
        ISet<string> seen)
    {
        var normalizedRoot = root.Trim();
        if (string.IsNullOrWhiteSpace(normalizedRoot))
        {
            return;
        }

        var projectRoots = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            normalizedRoot,
            Path.Combine(normalizedRoot, ProjectDirectory),
            Path.Combine(normalizedRoot, "BiliNCM-Connectors", ProjectDirectory),
            Path.Combine(normalizedRoot, "src", ProjectDirectory),
            Path.Combine(normalizedRoot, "BiliNCM-Connectors", "src", ProjectDirectory)
        };

        foreach (var projectRoot in projectRoots)
        {
            foreach (var configuration in new[] { "Release", "Debug" })
            {
                var outputRoot = Path.Combine(
                    projectRoot,
                    "bin",
                    configuration,
                    Framework,
                    RuntimeIdentifier);
                AddCandidate(
                    Path.Combine(outputRoot, ExecutableName),
                    candidates,
                    seen);
                AddCandidate(
                    Path.Combine(outputRoot, "publish", ExecutableName),
                    candidates,
                    seen);
            }
        }
    }

    private static IEnumerable<string> EnumerateSearchBases()
    {
        var starts = new[]
        {
            Environment.CurrentDirectory,
            AppContext.BaseDirectory
        };
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var start in starts)
        {
            var current = start;
            for (var depth = 0; depth < 10 && !string.IsNullOrWhiteSpace(current); depth++)
            {
                string full;
                try
                {
                    full = Path.GetFullPath(current);
                }
                catch
                {
                    yield break;
                }

                if (seen.Add(full))
                {
                    yield return full;
                }

                var parent = Directory.GetParent(full)?.FullName;
                if (string.Equals(parent, full, StringComparison.OrdinalIgnoreCase))
                {
                    break;
                }

                current = parent ?? string.Empty;
            }
        }
    }

    private static void AddCandidate(
        string candidate,
        ICollection<string> candidates,
        ISet<string> seen)
    {
        try
        {
            var full = Path.GetFullPath(candidate);
            if (seen.Add(full))
            {
                candidates.Add(full);
            }
        }
        catch
        {
            // Ignore malformed environment overrides and continue searching.
        }
    }

    private bool IsProcessRunning()
    {
        Process? process;
        lock (_stateSync)
        {
            process = _process;
        }

        if (process is null)
        {
            return false;
        }

        try
        {
            if (!process.HasExited)
            {
                return true;
            }
        }
        catch (InvalidOperationException)
        {
            // Treat an unstarted/disposed Process as offline.
        }

        MarkProcessUnavailable(process, "连接器进程已退出");
        return false;
    }

    private PlayerSnapshot BuildOfflineSnapshot(string reason)
    {
        var details = string.IsNullOrWhiteSpace(_lastStderr)
            ? string.Empty
            : $"；stderr={_lastStderr}";
        var status = $"连接器离线：{reason}{details}";
        _lastStatus = status;
        return new PlayerSnapshot(
            false,
            DisplayName,
            null,
            string.Empty,
            status,
            null,
            DateTimeOffset.Now,
            null,
            string.Empty);
    }

    private PlayerSnapshot NormalizeSnapshot(PlayerSnapshot snapshot)
    {
        var connectorVersion = string.IsNullOrWhiteSpace(ConnectorVersion)
            ? "未知"
            : ConnectorVersion;
        var transport = _eventSubscriptionActive
            ? "snapshot-events-v1"
            : "probe fallback";
        var status = string.IsNullOrWhiteSpace(snapshot.Status)
            ? $"连接器 {connectorVersion}；传输={transport}"
            : $"{snapshot.Status}；连接器 {connectorVersion}；传输={transport}";
        return snapshot with
        {
            Player = string.IsNullOrWhiteSpace(snapshot.Player)
                ? DisplayName
                : snapshot.Player,
            Version = snapshot.Version ?? string.Empty,
            Status = status,
            NextSource = snapshot.NextSource ?? string.Empty
        };
    }

    private void RecordStderr(string message)
    {
        var trimmed = message.Trim();
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            return;
        }

        // Keep one short, actionable line for the UI/diagnostics instead of
        // buffering an unbounded connector stderr stream.
        if (trimmed.Length > 500)
        {
            trimmed = trimmed[..500];
        }

        _lastStderr = trimmed;
    }

    private static Channel<PlayerSnapshot> CreateSnapshotChannel()
    {
        return Channel.CreateBounded<PlayerSnapshot>(
            new BoundedChannelOptions(64)
            {
                SingleReader = false,
                SingleWriter = false,
                FullMode = BoundedChannelFullMode.DropOldest,
                AllowSynchronousContinuations = false
            });
    }

    private static bool IsLive(Process process)
    {
        try
        {
            return !process.HasExited;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private static JsonElement RequireObject(
        JsonElement? element,
        string message)
    {
        if (element is null || element.Value.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException(message);
        }

        return element.Value;
    }

    private static T DeserializeRequired<T>(
        JsonElement? element,
        string message)
    {
        if (element is null || element.Value.ValueKind is JsonValueKind.Null)
        {
            throw new InvalidOperationException(message);
        }

        return JsonSerializer.Deserialize<T>(
                   element.Value.GetRawText(),
                   JsonOptions)
               ?? throw new InvalidOperationException(message);
    }

    private static string ReadString(JsonElement root, string property)
    {
        return root.TryGetProperty(property, out var element)
            && element.ValueKind == JsonValueKind.String
            ? element.GetString() ?? string.Empty
            : string.Empty;
    }

    private static int ReadInt(JsonElement root, string property)
    {
        return root.TryGetProperty(property, out var element)
               && element.TryGetInt32(out var value)
            ? value
            : 0;
    }

    private static int? ReadNullableInt(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out var element)
            || element.ValueKind is JsonValueKind.Null)
        {
            return null;
        }

        return element.TryGetInt32(out var value) ? value : null;
    }

    private static long ReadLong(JsonElement root, string property)
    {
        return root.TryGetProperty(property, out var element)
               && element.TryGetInt64(out var value)
            ? value
            : 0;
    }

    private static bool ReadBoolean(JsonElement? result, string property)
    {
        return result is not null
            && result.Value.ValueKind == JsonValueKind.Object
            && result.Value.TryGetProperty(property, out var element)
            && element.ValueKind == JsonValueKind.True;
    }

    private static string[] ReadStringArray(
        JsonElement root,
        string property)
    {
        if (!root.TryGetProperty(property, out var element)
            || element.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return element.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.String)
            .Select(item => item.GetString() ?? string.Empty)
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }

    private sealed record ConnectorDefinition(
        string Key,
        string DisplayName,
        string ProjectDirectory,
        string ExecutableName,
        string RuntimeIdentifier,
        string TestedVersion,
        PlayerCapabilities FallbackCapabilities);
}
