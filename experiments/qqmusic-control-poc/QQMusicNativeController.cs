using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace QQMusicControlPoc;

internal sealed record QQMusicWindowInfo(
    long Handle,
    int ProcessId,
    string ProcessName,
    string ClassName,
    string Title,
    bool IsVisible);

internal sealed record QQMusicPlaybackState(
    bool IsRunning,
    string? Title,
    string? Artist,
    long? WindowHandle,
    string? WindowTitle,
    DateTimeOffset ObservedAt);

internal static class QQMusicNativeController
{
    public static IReadOnlyList<QQMusicWindowInfo> InspectWindows()
    {
        var windows = new List<QQMusicWindowInfo>();
        EnumWindows(
            (handle, _) =>
            {
                GetWindowThreadProcessId(handle, out var processId);
                if (processId == 0)
                {
                    return true;
                }

                try
                {
                    using var process = Process.GetProcessById(
                        checked((int)processId));
                    if (!process.ProcessName.Equals(
                            "QQMusic",
                            StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }

                    windows.Add(new QQMusicWindowInfo(
                        handle,
                        checked((int)processId),
                        process.ProcessName,
                        ReadClassName(handle),
                        ReadWindowText(handle),
                        IsWindowVisible(handle)));
                }
                catch (ArgumentException)
                {
                    // The process exited while EnumWindows was running.
                }

                return true;
            },
            0);

        return windows;
    }

    public static QQMusicPlaybackState ReadPlaybackState()
    {
        var window = FindMainWindow();
        if (window is null)
        {
            return new QQMusicPlaybackState(
                false,
                null,
                null,
                null,
                null,
                DateTimeOffset.Now);
        }

        var (title, artist) = ParseTrack(window.Title);
        return new QQMusicPlaybackState(
            true,
            title,
            artist,
            window.Handle,
            window.Title,
            DateTimeOffset.Now);
    }

    private static QQMusicWindowInfo? FindMainWindow()
    {
        return InspectWindows()
            .Where(window => window.IsVisible)
            .OrderByDescending(window => HasTrackTitle(window.Title))
            .ThenByDescending(window =>
                window.Title.Equals(
                    "QQ音乐",
                    StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(window => window.Title.Length)
            .FirstOrDefault();
    }

    private static bool HasTrackTitle(string title)
    {
        return !string.IsNullOrWhiteSpace(title)
            && !title.Equals(
                "QQ音乐",
                StringComparison.OrdinalIgnoreCase)
            && title.Contains(" - ", StringComparison.Ordinal);
    }

    private static (string? Title, string? Artist) ParseTrack(
        string windowTitle)
    {
        if (!HasTrackTitle(windowTitle))
        {
            return (null, null);
        }

        var separator = windowTitle.IndexOf(
            " - ",
            StringComparison.Ordinal);
        if (separator <= 0)
        {
            return (windowTitle.Trim(), null);
        }

        return (
            windowTitle[..separator].Trim(),
            windowTitle[(separator + 3)..].Trim());
    }

    private static string ReadWindowText(nint handle)
    {
        var length = GetWindowTextLength(handle);
        if (length <= 0)
        {
            return string.Empty;
        }

        var buffer = new StringBuilder(length + 1);
        _ = GetWindowText(handle, buffer, buffer.Capacity);
        return buffer.ToString().Trim();
    }

    private static string ReadClassName(nint handle)
    {
        var buffer = new StringBuilder(256);
        _ = GetClassName(handle, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private delegate bool EnumWindowsCallback(nint handle, nint lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(
        EnumWindowsCallback callback,
        nint lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(
        nint handle,
        out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(nint handle);

    [DllImport(
        "user32.dll",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern int GetWindowText(
        nint handle,
        StringBuilder text,
        int maximum);

    [DllImport(
        "user32.dll",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern int GetClassName(
        nint handle,
        StringBuilder className,
        int maximum);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(nint handle);
}
