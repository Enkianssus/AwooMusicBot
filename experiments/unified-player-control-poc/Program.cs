using System.Text;
using System.Runtime.InteropServices;

namespace UnifiedPlayerControlPoc;

internal static class Program
{
    private static readonly string[] ConnectorKeys =
    [
        "netease",
        "kugou",
        "qqmusic"
    ];

    [STAThread]
    private static async Task<int> Main(string[] args)
    {
        if (args.Contains(
                "--smoke-test",
                StringComparer.OrdinalIgnoreCase))
        {
            _ = AttachConsole(AttachParentProcess);
            var requestedKeys = args
                .Where(argument => !argument.Equals(
                    "--smoke-test",
                    StringComparison.OrdinalIgnoreCase))
                .Select(argument => argument.Trim().ToLowerInvariant())
                .Where(ConnectorKeys.Contains)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
            return await RunSmokeTestAsync(
                    requestedKeys.Length == 0 ? ConnectorKeys : requestedKeys)
                .ConfigureAwait(false);
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
        return 0;
    }

    private static async Task<int> RunSmokeTestAsync(
        IReadOnlyList<string> connectorKeys)
    {
        Console.OutputEncoding = Encoding.UTF8;
        var failures = 0;

        foreach (var key in connectorKeys)
        {
            try
            {
                await using var adapter =
                    ConnectorProcessAdapter.CreateDefault(key);
                using var timeout = new CancellationTokenSource(
                    TimeSpan.FromSeconds(20));
                var snapshot = await adapter.ProbeAsync(
                    timeout.Token).ConfigureAwait(false);

                if (string.IsNullOrWhiteSpace(adapter.ConnectorVersion))
                {
                    throw new InvalidOperationException(
                        "连接器 ping 未完成：" + snapshot.Status);
                }

                Console.WriteLine(
                    $"{key}: connected={snapshot.Connected} "
                    + $"connector={adapter.ConnectorVersion} "
                    + $"version={FormatSingleLine(snapshot.Version)} "
                    + $"status={FormatSingleLine(snapshot.Status)}");
            }
            catch (Exception exception)
            {
                failures++;
                Console.Error.WriteLine(
                    $"{key}: ERROR {exception.GetType().Name}: "
                    + exception.Message);
            }
        }

        return failures == 0 ? 0 : 1;
    }

    private static string FormatSingleLine(string? value)
    {
        return (value ?? string.Empty).ReplaceLineEndings(" ").Trim();
    }

    private const uint AttachParentProcess = 0xFFFFFFFF;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);
}
