using System.Text.Json;
using System.Text.Json.Serialization;

namespace UnifiedPlayerControlPoc;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        Converters =
        {
            new JsonStringEnumConverter(JsonNamingPolicy.CamelCase)
        }
    };

    private static async Task<int> Main()
    {
        Console.InputEncoding = System.Text.Encoding.UTF8;
        Console.OutputEncoding = System.Text.Encoding.UTF8;

        var adapters = new Dictionary<string, IPlayerAdapter>(
            StringComparer.OrdinalIgnoreCase)
        {
            ["netease"] = new NeteasePlayerAdapter(),
            ["kugou"] = new KugouPlayerAdapter(),
            ["qqmusic"] = new QQMusicPlayerAdapter
            {
                // The app always uses the safe mute/pause software-next guard.
                AllowUnsafeNativeNext = false
            }
        };

        try
        {
            string? line;
            while ((line = await Console.In.ReadLineAsync()) is not null)
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                BridgeRequest? request = null;
                try
                {
                    request = JsonSerializer.Deserialize<BridgeRequest>(
                        line,
                        JsonOptions);
                    if (request is null
                        || string.IsNullOrWhiteSpace(request.Id)
                        || string.IsNullOrWhiteSpace(request.Action))
                    {
                        throw new InvalidOperationException(
                            "Request id and action are required.");
                    }

                    if (request.Action.Equals(
                            "shutdown",
                            StringComparison.OrdinalIgnoreCase))
                    {
                        await WriteResponseAsync(new BridgeResponse(
                            request.Id,
                            true,
                            new { stopped = true },
                            null));
                        break;
                    }

                    if (request.Action.Equals(
                            "ping",
                            StringComparison.OrdinalIgnoreCase))
                    {
                        await WriteResponseAsync(new BridgeResponse(
                            request.Id,
                            true,
                            new
                            {
                                bridgeVersion = "1.1.0",
                                players = adapters.Keys.ToArray()
                            },
                            null));
                        continue;
                    }

                    if (string.IsNullOrWhiteSpace(request.Player)
                        || !adapters.TryGetValue(
                            request.Player,
                            out var adapter))
                    {
                        throw new InvalidOperationException(
                            $"Unknown player: {request.Player}");
                    }

                    using var timeout = new CancellationTokenSource(
                        GetTimeout(request.Action));
                    var result = await ExecuteAsync(
                        adapter,
                        request,
                        timeout.Token);
                    await WriteResponseAsync(new BridgeResponse(
                        request.Id,
                        true,
                        result,
                        null));
                }
                catch (Exception exception)
                {
                    await WriteResponseAsync(new BridgeResponse(
                        request?.Id ?? string.Empty,
                        false,
                        null,
                        $"{exception.GetType().Name}: {exception.Message}"));
                }
            }
        }
        finally
        {
            foreach (var adapter in adapters.Values)
            {
                await adapter.DisposeAsync();
            }
        }

        return 0;
    }

    private static TimeSpan GetTimeout(string action)
    {
        return action.ToLowerInvariant() switch
        {
            "probe" => TimeSpan.FromSeconds(6),
            "search" => TimeSpan.FromSeconds(15),
            _ => TimeSpan.FromSeconds(20)
        };
    }

    private static async Task<object?> ExecuteAsync(
        IPlayerAdapter adapter,
        BridgeRequest request,
        CancellationToken cancellationToken)
    {
        switch (request.Action.ToLowerInvariant())
        {
            case "probe":
                return await adapter.ProbeAsync(cancellationToken);
            case "search":
                if (string.IsNullOrWhiteSpace(request.Query))
                {
                    throw new InvalidOperationException(
                        "Search query is required.");
                }

                return await adapter.SearchAsync(
                    request.Query,
                    cancellationToken);
            case "media-sessions":
                return await NeteaseMediaSessionController.ListSessionsAsync(
                    cancellationToken);
            case "netease-windows":
                return NeteaseNativeIpc.ListWindows();
            case "execute":
                if (!Enum.TryParse<PlayerCommand>(
                        request.Command,
                        true,
                        out var command))
                {
                    throw new InvalidOperationException(
                        $"Unknown command: {request.Command}");
                }

                return await adapter.ExecuteAsync(
                    command,
                    request.Track,
                    cancellationToken);
            default:
                throw new InvalidOperationException(
                    $"Unknown action: {request.Action}");
        }
    }

    private static async Task WriteResponseAsync(BridgeResponse response)
    {
        var json = JsonSerializer.Serialize(response, JsonOptions);
        await Console.Out.WriteLineAsync(json);
        await Console.Out.FlushAsync();
    }

    private sealed record BridgeRequest(
        string Id,
        string Action,
        string? Player,
        string? Query,
        string? Command,
        PlayerTrack? Track);

    private sealed record BridgeResponse(
        string Id,
        bool Ok,
        object? Result,
        string? Error);
}
