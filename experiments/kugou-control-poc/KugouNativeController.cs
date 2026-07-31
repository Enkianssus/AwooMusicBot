using System.Diagnostics;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace KugouControlPoc;

internal enum KugouAppCommand
{
    NextTrack = 11,
    PreviousTrack = 12,
    Stop = 13,
    PlayPause = 14,
    Play = 46,
    Pause = 47
}

internal sealed record NativeControlResult(
    string Action,
    string Method,
    bool Sent,
    long? WindowHandle,
    int? ProcessId,
    int? X,
    int? Y,
    string? Error,
    DateTimeOffset Timestamp);

internal sealed record SearchPlayResult(
    string Query,
    string Method,
    bool Sent,
    bool TrackChanged,
    long? WindowHandle,
    int? ProcessId,
    KugouPlaybackState Before,
    KugouPlaybackState After,
    string? Error,
    DateTimeOffset Timestamp);

internal sealed record SearchQueueResult(
    string Query,
    string Method,
    bool Sent,
    long? WindowHandle,
    int? ProcessId,
    KugouPlaybackState CurrentTrack,
    string? Error,
    DateTimeOffset Timestamp);

internal sealed record BackgroundControlResult(
    string Action,
    string Method,
    bool Sent,
    bool TrackChanged,
    bool ForegroundUnchanged,
    bool CursorUnchanged,
    long? TargetWindowHandle,
    string? TargetWindowClass,
    long ForegroundWindowBefore,
    long ForegroundWindowAfter,
    int CursorXBefore,
    int CursorYBefore,
    int CursorXAfter,
    int CursorYAfter,
    KugouPlaybackState Before,
    KugouPlaybackState After,
    double DetectionLatencyMilliseconds,
    string? Error,
    DateTimeOffset Timestamp,
    string Recovery = "None",
    int Attempts = 1);

internal sealed record BackgroundOpenResult(
    string Resource,
    string Method,
    bool Sent,
    long ReceiverResult,
    bool TrackChanged,
    bool ForegroundUnchanged,
    bool CursorUnchanged,
    long? TargetWindowHandle,
    string? TargetWindowClass,
    long ForegroundWindowBefore,
    long ForegroundWindowAfter,
    int CursorXBefore,
    int CursorYBefore,
    int CursorXAfter,
    int CursorYAfter,
    KugouPlaybackState Before,
    KugouPlaybackState After,
    double DetectionLatencyMilliseconds,
    string? Error,
    DateTimeOffset Timestamp,
    string Recovery = "None",
    int Attempts = 1,
    int Privilege = 0);

internal sealed record KugouPlaybackState(
    string Source,
    string WindowTitle,
    string RawTitle,
    string Artist,
    string Title,
    int SongItem,
    int SongList,
    int SongTable,
    long LastPositionMilliseconds,
    DateTimeOffset? IniLastWriteTime,
    long AudioId = 0,
    long MixSongId = 0,
    string Hash = "",
    string IdentitySource = "Unresolved");

internal sealed record VipPopupGuardResult(
    bool Found,
    bool CloseSent,
    long? WindowHandle,
    string? WindowClass,
    string? WindowTitle,
    int Width,
    int Height,
    string? Error,
    DateTimeOffset Timestamp,
    bool CloseSucceeded = false,
    long? HostWindowHandle = null,
    int OriginX = 0,
    int OriginY = 0,
    string DetectionMethod = "None",
    string CloseMethod = "None");

internal sealed record WindowInfo(
    long Handle,
    int ProcessId,
    string ClassName,
    string Title,
    bool IsVisible,
    long? ParentHandle,
    int Left,
    int Top,
    int Width,
    int Height);

internal static class KugouNativeController
{
    private static readonly HttpClient HttpClient = new()
    {
        Timeout = TimeSpan.FromSeconds(10)
    };
    private static readonly ConcurrentDictionary<string, KugouSongIdentity>
        SongIdentityCache = new(StringComparer.Ordinal);
    private static readonly nint HwndMessage = new(-3);
    private const string KugouDataExchangeMappingName = @"Local\KuGouDataExchange";
    private const int KugouDataExchangeWindowOffset = 0x0e;
    private const uint FileMapRead = 0x0004;
    private const uint WmCopyData = 0x004a;
    private const uint WmClose = 0x0010;
    private const uint WmKeyDown = 0x0100;
    private const uint WmKeyUp = 0x0101;
    private const uint WmMouseMove = 0x0200;
    private const uint WmLeftButtonDown = 0x0201;
    private const uint WmLeftButtonUp = 0x0202;
    private const int VkEscape = 0x1b;
    private const int MouseKeyLeftButton = 0x0001;
    private const uint ChildWindowSkipInvisible = 0x0001;
    private const uint ChildWindowSkipDisabled = 0x0002;
    private const uint WmAppCommand = 0x0319;
    private const uint WmHotKey = 0x0312;
    private const int ReferenceWidth = 1060;
    private const int ReferenceHeight = 720;
    private const ushort VkControl = 0x11;
    private const ushort VkMenu = 0x12;
    private const ushort VkLeft = 0x25;
    private const ushort VkRight = 0x27;
    private const ushort VkA = 0x41;
    private const ushort VkReturn = 0x0D;
    private const ushort VkF5 = 0x74;
    private const uint InputKeyboard = 1;
    private const uint KeyEventKeyUp = 0x0002;
    private const uint KeyEventUnicode = 0x0004;
    private const string PlaybackSection = "PlaybackState";
    private static readonly string KugouIniPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "KuGou8",
        "KuGou.ini");

    public static NativeControlResult Send(KugouAppCommand command)
    {
        var target = FindMainWindow();
        if (target is null)
        {
            return new NativeControlResult(
                command.ToString(),
                "TargetedPhysicalClick",
                false,
                null,
                null,
                null,
                null,
                "没有找到可见的酷狗主窗口",
                DateTimeOffset.Now);
        }

        var clientSize = GetClientSize(target.Value.Handle);
        var point = command switch
        {
            KugouAppCommand.NextTrack => (X: clientSize.Width / 2 + 51, Y: clientSize.Height - 37),
            KugouAppCommand.PreviousTrack => (X: clientSize.Width / 2 - 55, Y: clientSize.Height - 37),
            KugouAppCommand.PlayPause or KugouAppCommand.Play or KugouAppCommand.Pause
                => (X: clientSize.Width / 2, Y: clientSize.Height - 37),
            _ => ((int X, int Y)?)null
        };

        if (point is null)
        {
            var lParam = (nint)((int)command << 16);
            _ = SendMessage(target.Value.Handle, WmAppCommand, target.Value.Handle, lParam);
        }
        else
        {
            _ = ShowWindow(target.Value.Handle, 9);
            if (!TryBringToForeground(target.Value.Handle))
            {
                return new NativeControlResult(
                    command.ToString(),
                    "TargetedPhysicalClick",
                    false,
                    target.Value.Handle,
                    target.Value.ProcessId,
                    point.Value.X,
                    point.Value.Y,
                    "Windows 拒绝将酷狗置于前台；为避免误点其他窗口，已取消点击",
                    DateTimeOffset.Now);
            }

            Thread.Sleep(150);
            if (!TryClickClientPoint(
                    target.Value.Handle,
                    point.Value.X,
                    point.Value.Y,
                    clickCount: 1,
                    out var clickError))
            {
                return new NativeControlResult(
                    command.ToString(),
                    "TargetedPhysicalClick",
                    false,
                    target.Value.Handle,
                    target.Value.ProcessId,
                    point.Value.X,
                    point.Value.Y,
                    clickError,
                    DateTimeOffset.Now);
            }
        }

        return new NativeControlResult(
            command.ToString(),
            point is null ? "WM_APPCOMMAND" : "TargetedPhysicalClick",
            true,
            target.Value.Handle,
            target.Value.ProcessId,
            point?.X,
            point?.Y,
            null,
            DateTimeOffset.Now);
    }

    public static SearchPlayResult SearchAndPlay(string query, TimeSpan? timeout = null)
    {
        query = query.Trim();
        var before = ReadPlaybackState();
        if (string.IsNullOrWhiteSpace(query))
        {
            return new SearchPlayResult(
                query,
                "TargetedSearchUi",
                false,
                false,
                null,
                null,
                before,
                before,
                "搜索词不能为空",
                DateTimeOffset.Now);
        }

        var target = FindMainWindow();
        if (target is null)
        {
            return new SearchPlayResult(
                query,
                "TargetedSearchUi",
                false,
                false,
                null,
                null,
                before,
                before,
                "没有找到可见的酷狗主窗口",
                DateTimeOffset.Now);
        }

        _ = ShowWindow(target.Value.Handle, 9);
        if (!TryBringToForeground(target.Value.Handle))
        {
            return new SearchPlayResult(
                query,
                "TargetedSearchUi",
                false,
                false,
                target.Value.Handle,
                target.Value.ProcessId,
                before,
                before,
                "Windows 拒绝将酷狗置于前台；已取消输入和点击",
                DateTimeOffset.Now);
        }

        var clientSize = GetClientSize(target.Value.Handle);
        var searchPoint = ScalePoint(390, 40, clientSize);
        if (!TryClickClientPoint(
                target.Value.Handle,
                searchPoint.X,
                searchPoint.Y,
                clickCount: 1,
                out var searchClickError))
        {
            return new SearchPlayResult(
                query,
                "TargetedSearchUi",
                false,
                false,
                target.Value.Handle,
                target.Value.ProcessId,
                before,
                before,
                searchClickError,
                DateTimeOffset.Now);
        }

        Thread.Sleep(200);
        if (GetForegroundWindow() != target.Value.Handle
            || !SendControlA()
            || !SendUnicodeText(query)
            || !SendVirtualKey(VkReturn))
        {
            return new SearchPlayResult(
                query,
                "TargetedSearchUi",
                false,
                false,
                target.Value.Handle,
                target.Value.ProcessId,
                before,
                ReadPlaybackState(),
                "酷狗搜索框输入失败或窗口失去前台焦点",
                DateTimeOffset.Now);
        }

        Thread.Sleep(1800);
        var resultPoint = ScalePoint(455, 390, clientSize);
        if (!TryClickClientPoint(
                target.Value.Handle,
                resultPoint.X,
                resultPoint.Y,
                clickCount: 2,
                out var resultClickError))
        {
            return new SearchPlayResult(
                query,
                "TargetedSearchUi",
                false,
                false,
                target.Value.Handle,
                target.Value.ProcessId,
                before,
                ReadPlaybackState(),
                resultClickError,
                DateTimeOffset.Now);
        }

        var deadline = DateTimeOffset.UtcNow + (timeout ?? TimeSpan.FromSeconds(6));
        var after = ReadPlaybackState();
        while (DateTimeOffset.UtcNow < deadline && !HasTrackChanged(before, after))
        {
            Thread.Sleep(100);
            after = ReadPlaybackState();
        }

        return new SearchPlayResult(
            query,
            "TargetedSearchUi",
            true,
            HasTrackChanged(before, after),
            target.Value.Handle,
            target.Value.ProcessId,
            before,
            after,
            HasTrackChanged(before, after)
                ? null
                : "已双击首条搜索结果，但在等待时间内没有检测到歌曲标题变化",
            DateTimeOffset.Now);
    }

    public static SearchQueueResult SearchAsNext(string query)
    {
        query = query.Trim();
        var current = ReadPlaybackState();
        if (string.IsNullOrWhiteSpace(query))
        {
            return new SearchQueueResult(
                query,
                "TargetedSearchUiQueueNext",
                false,
                null,
                null,
                current,
                "搜索词不能为空",
                DateTimeOffset.Now);
        }

        var target = FindMainWindow();
        if (target is null)
        {
            return new SearchQueueResult(
                query,
                "TargetedSearchUiQueueNext",
                false,
                null,
                null,
                current,
                "没有找到可见的酷狗主窗口",
                DateTimeOffset.Now);
        }

        _ = ShowWindow(target.Value.Handle, 9);
        if (!TryBringToForeground(target.Value.Handle))
        {
            return new SearchQueueResult(
                query,
                "TargetedSearchUiQueueNext",
                false,
                target.Value.Handle,
                target.Value.ProcessId,
                current,
                "Windows 拒绝将酷狗置于前台；已取消输入和点击",
                DateTimeOffset.Now);
        }

        var clientSize = GetClientSize(target.Value.Handle);
        var searchPoint = ScalePoint(390, 40, clientSize);
        if (!TryClickClientPoint(
                target.Value.Handle,
                searchPoint.X,
                searchPoint.Y,
                clickCount: 1,
                out var searchClickError))
        {
            return new SearchQueueResult(
                query,
                "TargetedSearchUiQueueNext",
                false,
                target.Value.Handle,
                target.Value.ProcessId,
                current,
                searchClickError,
                DateTimeOffset.Now);
        }

        Thread.Sleep(200);
        if (GetForegroundWindow() != target.Value.Handle
            || !SendControlA()
            || !SendUnicodeText(query)
            || !SendVirtualKey(VkReturn))
        {
            return new SearchQueueResult(
                query,
                "TargetedSearchUiQueueNext",
                false,
                target.Value.Handle,
                target.Value.ProcessId,
                current,
                "酷狗搜索框输入失败或窗口失去前台焦点",
                DateTimeOffset.Now);
        }

        Thread.Sleep(1800);
        var resultPoint = ScalePoint(455, 390, clientSize);
        if (!TryClickClientPoint(
                target.Value.Handle,
                resultPoint.X,
                resultPoint.Y,
                clickCount: 1,
                out var rowClickError))
        {
            return new SearchQueueResult(
                query,
                "TargetedSearchUiQueueNext",
                false,
                target.Value.Handle,
                target.Value.ProcessId,
                current,
                rowClickError,
                DateTimeOffset.Now);
        }

        Thread.Sleep(250);
        var queueNextPoint = ScalePoint(580, 390, clientSize);
        if (!TryClickClientPoint(
                target.Value.Handle,
                queueNextPoint.X,
                queueNextPoint.Y,
                clickCount: 1,
                out var queueClickError))
        {
            return new SearchQueueResult(
                query,
                "TargetedSearchUiQueueNext",
                false,
                target.Value.Handle,
                target.Value.ProcessId,
                current,
                queueClickError,
                DateTimeOffset.Now);
        }

        return new SearchQueueResult(
            query,
            "TargetedSearchUiQueueNext",
            true,
            target.Value.Handle,
            target.Value.ProcessId,
            ReadPlaybackState(),
            null,
            DateTimeOffset.Now);
    }

    public static BackgroundControlResult SendBackgroundAppCommand(
        KugouAppCommand command,
        TimeSpan? timeout = null)
    {
        var before = ReadPlaybackState();
        var foregroundBefore = GetForegroundWindow();
        _ = GetCursorPos(out var cursorBefore);
        var candidates = InspectWindows()
            .Where(window => window.ParentHandle is null)
            .OrderByDescending(window => window.ClassName.Equals(
                "Kugou::MediaEventNotifyWindow",
                StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(window => window.ClassName.Equals(
                "kugou_ui",
                StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(window => window.Title.Contains(
                "酷狗音乐",
                StringComparison.OrdinalIgnoreCase))
            .ToArray();

        if (candidates.Length == 0)
        {
            var foregroundAfterMissing = GetForegroundWindow();
            _ = GetCursorPos(out var cursorAfterMissing);
            return new BackgroundControlResult(
                command.ToString(),
                "WM_APPCOMMAND/SendMessageTimeout",
                false,
                false,
                foregroundBefore == foregroundAfterMissing,
                SamePoint(cursorBefore, cursorAfterMissing),
                null,
                null,
                foregroundBefore,
                foregroundAfterMissing,
                cursorBefore.X,
                cursorBefore.Y,
                cursorAfterMissing.X,
                cursorAfterMissing.Y,
                before,
                ReadPlaybackState(),
                0,
                "没有找到酷狗顶层窗口；如果从受限沙箱运行，请改为直接运行已生成的 exe",
                DateTimeOffset.Now);
        }

        var stopwatch = Stopwatch.StartNew();
        WindowInfo? lastTarget = null;
        var sent = false;
        var after = before;
        var deadline = DateTimeOffset.UtcNow + (timeout ?? TimeSpan.FromSeconds(5));
        foreach (var candidate in candidates)
        {
            lastTarget = candidate;
            var lParam = (nint)((int)command << 16);
            var delivered = SendMessageTimeout(
                (nint)candidate.Handle,
                WmAppCommand,
                (nint)candidate.Handle,
                lParam,
                SendMessageTimeoutFlags.AbortIfHung,
                750,
                out _);
            sent |= delivered != nint.Zero;

            var candidateDeadline = DateTimeOffset.UtcNow + TimeSpan.FromMilliseconds(1400);
            while (DateTimeOffset.UtcNow < deadline
                && DateTimeOffset.UtcNow < candidateDeadline)
            {
                Thread.Sleep(50);
                after = ReadPlaybackState();
                if (HasTrackChanged(before, after))
                {
                    break;
                }
            }

            if (HasTrackChanged(before, after) || DateTimeOffset.UtcNow >= deadline)
            {
                break;
            }
        }

        stopwatch.Stop();
        var foregroundAfter = GetForegroundWindow();
        _ = GetCursorPos(out var cursorAfter);
        var changed = HasTrackChanged(before, after);
        return new BackgroundControlResult(
            command.ToString(),
            "WM_APPCOMMAND/SendMessageTimeout",
            sent,
            changed,
            foregroundBefore == foregroundAfter,
            SamePoint(cursorBefore, cursorAfter),
            lastTarget?.Handle,
            lastTarget?.ClassName,
            foregroundBefore,
            foregroundAfter,
            cursorBefore.X,
            cursorBefore.Y,
            cursorAfter.X,
            cursorAfter.Y,
            before,
            after,
            stopwatch.Elapsed.TotalMilliseconds,
            changed
                ? null
                : sent
                    ? "消息已投递，但酷狗没有切歌；此版本可能忽略后台 WM_APPCOMMAND"
                    : "Windows 没有接受发送到酷狗窗口的消息",
            DateTimeOffset.Now);
    }

    public static BackgroundControlResult SendBackgroundHotkey(
        KugouAppCommand command,
        TimeSpan? timeout = null)
    {
        var virtualKey = command switch
        {
            KugouAppCommand.NextTrack => VkRight,
            KugouAppCommand.PreviousTrack => VkLeft,
            KugouAppCommand.PlayPause => VkF5,
            _ => (ushort)0
        };
        var hotkeyName = command switch
        {
            KugouAppCommand.NextTrack => "Alt+Right",
            KugouAppCommand.PreviousTrack => "Alt+Left",
            KugouAppCommand.PlayPause => "Alt+F5",
            _ => "Unsupported"
        };
        var before = ReadPlaybackState();
        var foregroundBefore = GetForegroundWindow();
        _ = GetCursorPos(out var cursorBefore);

        if (virtualKey == 0)
        {
            return CreateBackgroundHotkeyResult(
                command,
                hotkeyName,
                sent: false,
                before,
                before,
                foregroundBefore,
                cursorBefore,
                TimeSpan.Zero,
                "这个命令没有对应的酷狗全局快捷键");
        }

        var stopwatch = Stopwatch.StartNew();
        var inputs = new[]
        {
            CreateVirtualKeyInput(VkMenu, keyUp: false),
            CreateVirtualKeyInput(virtualKey, keyUp: false),
            CreateVirtualKeyInput(virtualKey, keyUp: true),
            CreateVirtualKeyInput(VkMenu, keyUp: true)
        };
        var sent = SendInput(
            (uint)inputs.Length,
            inputs,
            Marshal.SizeOf<Input>()) == (uint)inputs.Length;
        var after = ReadPlaybackState();
        var deadline = DateTimeOffset.UtcNow + (timeout ?? TimeSpan.FromSeconds(5));
        while (sent
            && command != KugouAppCommand.PlayPause
            && DateTimeOffset.UtcNow < deadline
            && !HasTrackChanged(before, after))
        {
            Thread.Sleep(50);
            after = ReadPlaybackState();
        }

        stopwatch.Stop();
        return CreateBackgroundHotkeyResult(
            command,
            hotkeyName,
            sent,
            before,
            after,
            foregroundBefore,
            cursorBefore,
            stopwatch.Elapsed,
            sent
                ? command == KugouAppCommand.PlayPause
                    ? null
                    : HasTrackChanged(before, after)
                        ? null
                        : $"已发送 {hotkeyName}，但没有检测到切歌；请在酷狗“设置 → 热键设置”启用全局快捷键"
                : $"发送 {hotkeyName} 失败");
    }

    private static BackgroundControlResult CreateBackgroundHotkeyResult(
        KugouAppCommand command,
        string hotkeyName,
        bool sent,
        KugouPlaybackState before,
        KugouPlaybackState after,
        nint foregroundBefore,
        Point cursorBefore,
        TimeSpan elapsed,
        string? error)
    {
        var foregroundAfter = GetForegroundWindow();
        _ = GetCursorPos(out var cursorAfter);
        return new BackgroundControlResult(
            command.ToString(),
            $"KuGouGlobalHotkey/{hotkeyName}",
            sent,
            HasTrackChanged(before, after),
            foregroundBefore == foregroundAfter,
            SamePoint(cursorBefore, cursorAfter),
            null,
            null,
            foregroundBefore,
            foregroundAfter,
            cursorBefore.X,
            cursorBefore.Y,
            cursorAfter.X,
            cursorAfter.Y,
            before,
            after,
            elapsed.TotalMilliseconds,
            error,
            DateTimeOffset.Now);
    }

    public static BackgroundControlResult SendDirectKugouCommand(
        KugouAppCommand command,
        TimeSpan? timeout = null)
    {
        var (hotkeyId, virtualKey) = command switch
        {
            KugouAppCommand.PlayPause => (Id: 0x40a, Key: 0xb3),
            KugouAppCommand.PreviousTrack => (Id: 0x40b, Key: 0xb1),
            KugouAppCommand.NextTrack => (Id: 0x40c, Key: 0xb0),
            KugouAppCommand.Stop => (Id: 0x40d, Key: 0xb2),
            _ => (Id: 0, Key: 0)
        };
        var before = ReadPlaybackState();
        var foregroundBefore = GetForegroundWindow();
        _ = GetCursorPos(out var cursorBefore);
        var target = FindMainWindow();

        if (hotkeyId == 0 || target is null)
        {
            var foregroundAfterMissing = GetForegroundWindow();
            _ = GetCursorPos(out var cursorAfterMissing);
            return new BackgroundControlResult(
                command.ToString(),
                $"DirectWM_HOTKEY/id=0x{hotkeyId:X}",
                false,
                false,
                foregroundBefore == foregroundAfterMissing,
                SamePoint(cursorBefore, cursorAfterMissing),
                target?.Handle,
                target is null ? null : ReadWindowClass(target.Value.Handle),
                foregroundBefore,
                foregroundAfterMissing,
                cursorBefore.X,
                cursorBefore.Y,
                cursorAfterMissing.X,
                cursorAfterMissing.Y,
                before,
                ReadPlaybackState(),
                0,
                hotkeyId == 0
                    ? "这个命令没有对应的酷狗内部媒体命令 ID"
                    : "没有找到可见的酷狗主窗口",
                DateTimeOffset.Now);
        }

        var stopwatch = Stopwatch.StartNew();
        var lParam = (nint)(virtualKey << 16);
        var delivered = SendMessageTimeout(
            target.Value.Handle,
            WmHotKey,
            hotkeyId,
            lParam,
            SendMessageTimeoutFlags.AbortIfHung,
            750,
            out _);
        var sent = delivered != nint.Zero;
        var after = ReadPlaybackState();
        var deadline = DateTimeOffset.UtcNow + (timeout ?? TimeSpan.FromSeconds(5));
        while (sent
            && command is KugouAppCommand.NextTrack or KugouAppCommand.PreviousTrack
            && DateTimeOffset.UtcNow < deadline
            && !HasTrackChanged(before, after))
        {
            Thread.Sleep(50);
            after = ReadPlaybackState();
        }

        stopwatch.Stop();
        var foregroundAfter = GetForegroundWindow();
        _ = GetCursorPos(out var cursorAfter);
        var changed = HasTrackChanged(before, after);
        return new BackgroundControlResult(
            command.ToString(),
            $"DirectWM_HOTKEY/id=0x{hotkeyId:X}",
            sent,
            changed,
            foregroundBefore == foregroundAfter,
            SamePoint(cursorBefore, cursorAfter),
            target.Value.Handle,
            ReadWindowClass(target.Value.Handle),
            foregroundBefore,
            foregroundAfter,
            cursorBefore.X,
            cursorBefore.Y,
            cursorAfter.X,
            cursorAfter.Y,
            before,
            after,
            stopwatch.Elapsed.TotalMilliseconds,
            sent
                ? command is KugouAppCommand.NextTrack or KugouAppCommand.PreviousTrack
                    ? changed
                        ? null
                        : "内部消息已投递，但没有检测到切歌"
                    : null
                : "Windows 没有接受发送到酷狗主窗口的内部消息",
            DateTimeOffset.Now);
    }

    public static BackgroundControlResult SendResilientKugouCommand(
        KugouAppCommand command,
        TimeSpan? timeout = null)
    {
        var recoverable =
            command is KugouAppCommand.NextTrack or KugouAppCommand.PreviousTrack;
        var first = SendDirectKugouCommand(
            command,
            recoverable ? TimeSpan.FromSeconds(2) : timeout);
        if (!recoverable || !first.Sent || first.TrackChanged)
        {
            return first;
        }

        var popup = TryCloseVipTrialPopup();
        var stop = SendDirectKugouCommand(
            KugouAppCommand.Stop,
            TimeSpan.Zero);
        Thread.Sleep(120);
        var retry = SendDirectKugouCommand(command, timeout);
        var changed = !SamePlaybackIdentity(first.Before, retry.After);
        var cursorUnchanged =
            first.CursorXBefore == retry.CursorXAfter
            && first.CursorYBefore == retry.CursorYAfter;
        return retry with
        {
            Method =
                $"{first.Method} -> Stop(0x40D) -> {retry.Method}",
            TrackChanged = changed,
            ForegroundUnchanged =
                first.ForegroundWindowBefore == retry.ForegroundWindowAfter,
            CursorUnchanged = cursorUnchanged,
            ForegroundWindowBefore = first.ForegroundWindowBefore,
            CursorXBefore = first.CursorXBefore,
            CursorYBefore = first.CursorYBefore,
            Before = first.Before,
            DetectionLatencyMilliseconds =
                first.DetectionLatencyMilliseconds
                + stop.DetectionLatencyMilliseconds
                + 120
                + retry.DetectionLatencyMilliseconds,
            Error = changed
                ? null
                : "普通内部切歌被阻塞；已停止当前播放并重试，但仍未检测到切歌",
            Recovery = popup.CloseSucceeded
                ? "CloseMatchedVipPopup+StopCurrent+RetryInternalCommand"
                : "StopCurrent+RetryInternalCommand",
            Attempts = 2
        };
    }

    public static BackgroundOpenResult SendBackgroundOpenFile(
        string path,
        long? targetWindowHandle = null,
        TimeSpan? timeout = null)
    {
        path = path.Trim().Trim('"');
        var before = ReadPlaybackState();
        var foregroundBefore = GetForegroundWindow();
        _ = GetCursorPos(out var cursorBefore);
        var detectedTarget = FindKugouIpcWindow();
        var target = targetWindowHandle is null
            ? detectedTarget
            : ((nint)targetWindowHandle.Value, GetProcessId((nint)targetWindowHandle.Value));

        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path) || target is null)
        {
            var foregroundAfterMissing = GetForegroundWindow();
            _ = GetCursorPos(out var cursorAfterMissing);
            return new BackgroundOpenResult(
                path,
                "WM_COPYDATA/dwData=1",
                false,
                0,
                false,
                foregroundBefore == foregroundAfterMissing,
                SamePoint(cursorBefore, cursorAfterMissing),
                target?.Handle,
                target is null ? null : ReadWindowClass(target.Value.Handle),
                foregroundBefore,
                foregroundAfterMissing,
                cursorBefore.X,
                cursorBefore.Y,
                cursorAfterMissing.X,
                cursorAfterMissing.Y,
                before,
                ReadPlaybackState(),
                0,
                target is null
                    ? $"没有从共享内存 {KugouDataExchangeMappingName} 找到酷狗 IPC 接收窗口"
                    : "指定的本地音频文件不存在",
                DateTimeOffset.Now);
        }

        var fullPath = Path.GetFullPath(path);
        var senderWindow = CreateWindowEx(
            0,
            "STATIC",
            "KugouControlPocSender",
            0,
            0,
            0,
            0,
            0,
            HwndMessage,
            nint.Zero,
            nint.Zero,
            nint.Zero);
        var dataPointer = Marshal.StringToHGlobalUni(fullPath);
        var copyData = new CopyDataStruct
        {
            Data = 1,
            ByteCount = checked((uint)Encoding.Unicode.GetByteCount(fullPath)),
            DataPointer = dataPointer
        };
        var structPointer = Marshal.AllocHGlobal(Marshal.SizeOf<CopyDataStruct>());
        var stopwatch = Stopwatch.StartNew();
        var delivered = nint.Zero;
        nuint receiverResult = 0;

        try
        {
            Marshal.StructureToPtr(copyData, structPointer, false);
            for (var index = 0; index < 2; index++)
            {
                delivered = SendMessageTimeout(
                    target.Value.Handle,
                    WmCopyData,
                    senderWindow,
                    structPointer,
                    SendMessageTimeoutFlags.AbortIfHung,
                    1500,
                    out receiverResult);
                if (delivered == nint.Zero)
                {
                    break;
                }

                if (index == 0)
                {
                    Thread.Sleep(100);
                }
            }
        }
        finally
        {
            if (senderWindow != nint.Zero)
            {
                _ = DestroyWindow(senderWindow);
            }

            Marshal.FreeHGlobal(structPointer);
            Marshal.FreeHGlobal(dataPointer);
        }

        var sent = delivered != nint.Zero;
        var after = ReadPlaybackState();
        var deadline = DateTimeOffset.UtcNow + (timeout ?? TimeSpan.FromSeconds(5));
        while (sent
            && DateTimeOffset.UtcNow < deadline
            && !HasTrackChanged(before, after))
        {
            Thread.Sleep(50);
            after = ReadPlaybackState();
        }

        stopwatch.Stop();
        var foregroundAfter = GetForegroundWindow();
        _ = GetCursorPos(out var cursorAfter);
        var changed = HasTrackChanged(before, after);
        return new BackgroundOpenResult(
            fullPath,
            "WM_COPYDATA/dwData=1 x2/message-only sender",
            sent,
            unchecked((long)receiverResult),
            changed,
            foregroundBefore == foregroundAfter,
            SamePoint(cursorBefore, cursorAfter),
            target.Value.Handle,
            ReadWindowClass(target.Value.Handle),
            foregroundBefore,
            foregroundAfter,
            cursorBefore.X,
            cursorBefore.Y,
            cursorAfter.X,
            cursorAfter.Y,
            before,
            after,
            stopwatch.Elapsed.TotalMilliseconds,
            sent
                ? changed
                    ? null
                    : "消息已投递，但没有检测到酷狗开始播放这个文件"
                : "Windows 没有接受发送到酷狗主窗口的 WM_COPYDATA 消息",
            DateTimeOffset.Now);
    }

    public static Task<BackgroundOpenResult> SearchAndPlayBackgroundAsync(
        string query,
        TimeSpan? timeout = null)
    {
        return SearchBackgroundAsync(
            query,
            playImmediately: true,
            forceRecovery: false,
            timeout: timeout);
    }

    public static Task<BackgroundOpenResult> SearchAndPlayForcedRecoveryAsync(
        string query,
        TimeSpan? timeout = null)
    {
        return SearchBackgroundAsync(
            query,
            playImmediately: true,
            forceRecovery: true,
            timeout: timeout);
    }

    public static Task<BackgroundOpenResult> SearchAsNextBackgroundAsync(
        string query,
        TimeSpan? timeout = null)
    {
        return SearchBackgroundAsync(
            query,
            playImmediately: false,
            forceRecovery: false,
            timeout: timeout);
    }

    private static async Task<BackgroundOpenResult> SearchBackgroundAsync(
        string query,
        bool playImmediately,
        bool forceRecovery,
        TimeSpan? timeout)
    {
        query = query.Trim();
        if (string.IsNullOrWhiteSpace(query))
        {
            throw new ArgumentException("搜索词不能为空", nameof(query));
        }

        var endpoint =
            "http://mobilecdn.kugou.com/api/v3/search/song"
            + "?format=json"
            + $"&keyword={Uri.EscapeDataString(query)}"
            + "&page=1&pagesize=1&showtype=1";
        using var response = await HttpClient.GetAsync(endpoint).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        await using var content = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
        using var document = await JsonDocument.ParseAsync(content).ConfigureAwait(false);

        if (!document.RootElement.TryGetProperty("data", out var data)
            || !data.TryGetProperty("info", out var info)
            || info.ValueKind != JsonValueKind.Array
            || info.GetArrayLength() == 0)
        {
            throw new InvalidOperationException($"酷狗搜索没有返回结果：{query}");
        }

        var song = info[0];
        var filename = ReadJsonText(song, "filename");
        var hash = ReadJsonText(song, "hash").ToUpperInvariant();
        var duration = ReadJsonLong(song, "timelength");
        if (duration <= 0)
        {
            duration = ReadJsonLong(song, "duration") * 1000;
        }

        var songName = ReadJsonText(song, "songname");
        var singerName = ReadJsonText(song, "singername");
        var audioId = ReadJsonLong(song, "audio_id");
        var mixSongId = ReadJsonLong(song, "mixsongid");
        var privilege = checked((int)ReadJsonLong(song, "privilege"));
        if (string.IsNullOrWhiteSpace(filename))
        {
            filename = string.IsNullOrWhiteSpace(singerName)
                ? songName
                : $"{singerName} - {songName}";
        }

        if (string.IsNullOrWhiteSpace(hash))
        {
            throw new InvalidOperationException("酷狗搜索结果缺少歌曲 hash，无法交给客户端解析");
        }

        CacheSongIdentity(
            filename,
            songName,
            singerName,
            audioId,
            mixSongId,
            hash,
            "SearchPayload");

        var file = new Dictionary<string, object?>
        {
            ["filename"] = filename,
            ["hash"] = hash,
            ["size"] = ReadJsonText(song, "filesize", "0"),
            ["duration"] = duration.ToString(),
            ["bitrate"] = ReadJsonText(song, "bitrate", "0"),
            ["isfilehead"] = "0",
            ["mvhash"] = ReadJsonText(song, "mvhash"),
            ["mvtrack"] = "0",
            ["mvstate"] = "0",
            ["ismvfilehead"] = "0",
            ["isvip"] = ReadJsonText(song, "isvip", "0"),
            ["privilege"] = ReadJsonText(song, "privilege", "0"),
            ["album_id"] = ReadJsonText(song, "album_id"),
            ["scid"] = "0",
            ["mixsongid"] = mixSongId.ToString(),
            ["special_id"] = ReadJsonText(song, "specialid", "0"),
            ["encrypt"] = "-1",
            ["songname"] = songName,
            ["singerinfo"] = Array.Empty<object>(),
            ["album_name"] = ReadJsonText(song, "album_name"),
            ["quality"] = "0",
            ["vip_icon"] = "0",
            ["songdescription"] = string.Empty
        };
        var payloadObject = new Dictionary<string, object?>
        {
            ["Source"] = "KugouControlPocSearch",
            ["SourceFile"] = string.Empty,
            ["SourcePath"] = string.Empty,
            ["ChargePath"] = string.Empty,
            ["ClassName"] = string.Empty,
            ["Files"] = new[] { file },
            ["Count"] = "1",
            ["ListId"] = string.Empty,
            ["DownloadPath"] = string.Empty,
            ["Type"] = string.Empty,
            ["From"] = "KugouControlPoc",
            ["LocalListId"] = string.Empty,
            ["CloudListId"] = string.Empty,
            ["NoPlayAds"] = 1,
            ["QueueInfo"] = new Dictionary<string, string>
            {
                ["Play"] = playImmediately ? "1" : "0",
                ["PlayAll"] = "0",
                ["Clear"] = "0",
                ["Insert"] = playImmediately ? "0" : "1",
                ["Force"] = playImmediately ? "1" : "0",
                ["IsMV"] = "0",
                ["Index"] = "0",
                ["AddToDefaultList"] = "1",
                ["climax"] = "0"
            },
            ["QueueSource"] = string.Empty
        };
        var payload = JsonSerializer.Serialize(payloadObject);
        if (playImmediately && forceRecovery)
        {
            var forcedPopup = TryCloseVipTrialPopup();
            var forcedStop = SendDirectKugouCommand(
                KugouAppCommand.Stop,
                TimeSpan.Zero);
            Thread.Sleep(120);
            var forced = SendBackgroundUtf8Payload(
                $"{filename} [{hash}]",
                payload,
                22,
                timeout,
                identifySender: false,
                expectTrackChange: true);
            return forced with
            {
                Method = $"Stop(0x40D) -> {forced.Method}",
                DetectionLatencyMilliseconds =
                    forcedStop.DetectionLatencyMilliseconds
                    + 120
                    + forced.DetectionLatencyMilliseconds,
                Error = forced.TrackChanged
                    ? null
                    : privilege > 0
                        ? "强制点播仍被酷狗拦截；目标结果需要 VIP/付费权限，程序不会绕过会员授权"
                        : "已停止当前播放并用 dwData=22 强制投递，但仍未检测到歌曲变化",
                Recovery = forcedPopup.CloseSucceeded
                    ? "ForcedCloseMatchedVipPopup+StopCurrent+DwData22"
                    : "ForcedStopCurrent+DwData22",
                Privilege = privilege
            };
        }

        var first = SendBackgroundUtf8Payload(
            $"{filename} [{hash}]",
            payload,
            20,
            playImmediately ? TimeSpan.FromSeconds(3) : timeout,
            identifySender: false,
            expectTrackChange: playImmediately);
        first = first with { Privilege = privilege };
        if (!playImmediately || first.TrackChanged)
        {
            return first;
        }

        var popup = TryCloseVipTrialPopup();
        var stop = SendDirectKugouCommand(
            KugouAppCommand.Stop,
            TimeSpan.Zero);
        Thread.Sleep(120);
        var retry = SendBackgroundUtf8Payload(
            $"{filename} [{hash}]",
            payload,
            22,
            timeout,
            identifySender: false,
            expectTrackChange: true);
        var changed = !SamePlaybackIdentity(first.Before, retry.After);
        var cursorUnchanged =
            first.CursorXBefore == retry.CursorXAfter
            && first.CursorYBefore == retry.CursorYAfter;
        return retry with
        {
            Method =
                $"{first.Method} -> Stop(0x40D) -> {retry.Method}",
            TrackChanged = changed,
            ForegroundUnchanged =
                first.ForegroundWindowBefore == retry.ForegroundWindowAfter,
            CursorUnchanged = cursorUnchanged,
            ForegroundWindowBefore = first.ForegroundWindowBefore,
            CursorXBefore = first.CursorXBefore,
            CursorYBefore = first.CursorYBefore,
            Before = first.Before,
            DetectionLatencyMilliseconds =
                first.DetectionLatencyMilliseconds
                + stop.DetectionLatencyMilliseconds
                + 120
                + retry.DetectionLatencyMilliseconds,
            Error = changed
                ? null
                : privilege > 0
                    ? "强制恢复点播仍被酷狗拦截；目标搜索结果需要 VIP/付费权限，程序不会绕过会员授权"
                    : "普通点播被阻塞；已停止当前播放并用 dwData=22 重投，但仍未检测到歌曲变化",
            Recovery = popup.CloseSucceeded
                ? "NoPlayAds+CloseMatchedVipPopup+StopCurrent+RetryDwData22"
                : "NoPlayAds+StopCurrent+RetryDwData22",
            Attempts = 2,
            Privilege = privilege
        };
    }

    private static BackgroundOpenResult SendBackgroundUtf8Payload(
        string resource,
        string payload,
        nuint data,
        TimeSpan? timeout,
        bool identifySender,
        bool expectTrackChange)
    {
        var before = ReadPlaybackState();
        var foregroundBefore = GetForegroundWindow();
        _ = GetCursorPos(out var cursorBefore);
        var target = FindKugouIpcWindow();

        if (target is null)
        {
            var foregroundAfterMissing = GetForegroundWindow();
            _ = GetCursorPos(out var cursorAfterMissing);
            return new BackgroundOpenResult(
                resource,
                $"WM_COPYDATA/dwData={data}/UTF-8",
                false,
                0,
                false,
                foregroundBefore == foregroundAfterMissing,
                SamePoint(cursorBefore, cursorAfterMissing),
                null,
                null,
                foregroundBefore,
                foregroundAfterMissing,
                cursorBefore.X,
                cursorBefore.Y,
                cursorAfterMissing.X,
                cursorAfterMissing.Y,
                before,
                ReadPlaybackState(),
                0,
                $"没有从共享内存 {KugouDataExchangeMappingName} 找到酷狗 IPC 接收窗口",
                DateTimeOffset.Now);
        }

        var senderWindow = identifySender
            ? CreateWindowEx(
                0,
                "STATIC",
                "KugouControlPocSender",
                0,
                0,
                0,
                0,
                0,
                HwndMessage,
                nint.Zero,
                nint.Zero,
                nint.Zero)
            : nint.Zero;
        var bytes = Encoding.UTF8.GetBytes(payload);
        var dataPointer = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, dataPointer, bytes.Length);
        var copyData = new CopyDataStruct
        {
            Data = data,
            ByteCount = checked((uint)bytes.Length),
            DataPointer = dataPointer
        };
        var structPointer = Marshal.AllocHGlobal(Marshal.SizeOf<CopyDataStruct>());
        var stopwatch = Stopwatch.StartNew();
        var delivered = nint.Zero;
        nuint receiverResult = 0;

        try
        {
            Marshal.StructureToPtr(copyData, structPointer, false);
            delivered = SendMessageTimeout(
                target.Value.Handle,
                WmCopyData,
                senderWindow,
                structPointer,
                SendMessageTimeoutFlags.AbortIfHung,
                1500,
                out receiverResult);
        }
        finally
        {
            if (senderWindow != nint.Zero)
            {
                _ = DestroyWindow(senderWindow);
            }

            Marshal.FreeHGlobal(structPointer);
            Marshal.FreeHGlobal(dataPointer);
        }

        var sent = delivered != nint.Zero && receiverResult != 0;
        var after = ReadPlaybackState();
        var deadline = DateTimeOffset.UtcNow + (timeout ?? TimeSpan.FromSeconds(8));
        while (sent
            && expectTrackChange
            && DateTimeOffset.UtcNow < deadline
            && !HasTrackChanged(before, after))
        {
            Thread.Sleep(50);
            after = ReadPlaybackState();
        }

        stopwatch.Stop();
        var foregroundAfter = GetForegroundWindow();
        _ = GetCursorPos(out var cursorAfter);
        var changed = HasTrackChanged(before, after);
        return new BackgroundOpenResult(
            resource,
            $"WM_COPYDATA/dwData={data}/UTF-8/wParam="
                + (identifySender ? "sender HWND" : "0")
                + $" via {KugouDataExchangeMappingName}",
            sent,
            unchecked((long)receiverResult),
            changed,
            foregroundBefore == foregroundAfter,
            SamePoint(cursorBefore, cursorAfter),
            target.Value.Handle,
            ReadWindowClass(target.Value.Handle),
            foregroundBefore,
            foregroundAfter,
            cursorBefore.X,
            cursorBefore.Y,
            cursorAfter.X,
            cursorAfter.Y,
            before,
            after,
            stopwatch.Elapsed.TotalMilliseconds,
            sent
                ? !expectTrackChange || changed
                    ? null
                    : "酷狗接受了在线点播 IPC，但等待期间未检测到歌曲变化"
                : "酷狗 IPC 接收端没有接受在线点播负载",
            DateTimeOffset.Now);
    }

    private static string ReadJsonText(
        JsonElement element,
        string name,
        string defaultValue = "")
    {
        if (!element.TryGetProperty(name, out var value))
        {
            return defaultValue;
        }

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? defaultValue,
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => "1",
            JsonValueKind.False => "0",
            _ => defaultValue
        };
    }

    private static long ReadJsonLong(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value)
            && (value.ValueKind == JsonValueKind.Number
                ? value.TryGetInt64(out var number)
                : long.TryParse(value.GetString(), out number))
            ? number
            : 0;
    }

    private static bool SamePoint(Point left, Point right)
    {
        return left.X == right.X && left.Y == right.Y;
    }

    private static bool HasTrackChanged(KugouPlaybackState before, KugouPlaybackState after)
    {
        return !SamePlaybackIdentity(before, after);
    }

    public static bool SamePlaybackIdentity(
        KugouPlaybackState left,
        KugouPlaybackState right)
    {
        if (left.AudioId > 0 && right.AudioId > 0)
        {
            return left.AudioId == right.AudioId;
        }

        if (!string.IsNullOrWhiteSpace(left.Hash)
            && !string.IsNullOrWhiteSpace(right.Hash))
        {
            return string.Equals(
                left.Hash,
                right.Hash,
                StringComparison.OrdinalIgnoreCase);
        }

        return string.Equals(left.Artist, right.Artist, StringComparison.Ordinal)
            && string.Equals(left.Title, right.Title, StringComparison.Ordinal);
    }

    private static (int X, int Y) ScalePoint(
        int referenceX,
        int referenceY,
        (int Width, int Height) clientSize)
    {
        return (
            (int)Math.Round(referenceX * clientSize.Width / (double)ReferenceWidth),
            (int)Math.Round(referenceY * clientSize.Height / (double)ReferenceHeight));
    }

    private static bool TryClickClientPoint(
        nint handle,
        int clientX,
        int clientY,
        int clickCount,
        out string? error)
    {
        error = null;
        if (GetForegroundWindow() != handle)
        {
            error = "酷狗未成为前台窗口；为避免误点其他窗口，已取消点击";
            return false;
        }

        var screenPoint = new Point { X = clientX, Y = clientY };
        if (!ClientToScreen(handle, ref screenPoint))
        {
            error = "无法把酷狗客户端坐标转换为屏幕坐标";
            return false;
        }

        _ = GetCursorPos(out var previousCursor);
        try
        {
            _ = SetCursorPos(screenPoint.X, screenPoint.Y);
            for (var index = 0; index < clickCount; index++)
            {
                MouseEvent(0x0002, 0, 0, 0, nuint.Zero);
                MouseEvent(0x0004, 0, 0, 0, nuint.Zero);
                if (index + 1 < clickCount)
                {
                    Thread.Sleep(80);
                }
            }

            Thread.Sleep(80);
            return true;
        }
        finally
        {
            _ = SetCursorPos(previousCursor.X, previousCursor.Y);
        }
    }

    private static bool SendControlA()
    {
        var inputs = new[]
        {
            CreateVirtualKeyInput(VkControl, keyUp: false),
            CreateVirtualKeyInput(VkA, keyUp: false),
            CreateVirtualKeyInput(VkA, keyUp: true),
            CreateVirtualKeyInput(VkControl, keyUp: true)
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) == (uint)inputs.Length;
    }

    private static bool SendUnicodeText(string text)
    {
        var inputs = new List<Input>(text.Length * 2);
        foreach (var character in text)
        {
            inputs.Add(CreateUnicodeInput(character, keyUp: false));
            inputs.Add(CreateUnicodeInput(character, keyUp: true));
        }

        return inputs.Count == 0
            || SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf<Input>()) == (uint)inputs.Count;
    }

    private static bool SendVirtualKey(ushort virtualKey)
    {
        var inputs = new[]
        {
            CreateVirtualKeyInput(virtualKey, keyUp: false),
            CreateVirtualKeyInput(virtualKey, keyUp: true)
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) == (uint)inputs.Length;
    }

    private static Input CreateVirtualKeyInput(ushort virtualKey, bool keyUp)
    {
        return new Input
        {
            Type = InputKeyboard,
            Data = new InputUnion
            {
                Keyboard = new KeyboardInput
                {
                    VirtualKey = virtualKey,
                    Flags = keyUp ? KeyEventKeyUp : 0
                }
            }
        };
    }

    private static Input CreateUnicodeInput(char character, bool keyUp)
    {
        return new Input
        {
            Type = InputKeyboard,
            Data = new InputUnion
            {
                Keyboard = new KeyboardInput
                {
                    ScanCode = character,
                    Flags = KeyEventUnicode | (keyUp ? KeyEventKeyUp : 0)
                }
            }
        };
    }

    public static VipPopupGuardResult DetectVipTrialPopup()
    {
        var main = FindMainWindow();
        if (main is null)
        {
            return new VipPopupGuardResult(
                false,
                false,
                null,
                null,
                null,
                0,
                0,
                "没有找到酷狗主窗口",
                DateTimeOffset.Now);
        }

        var windows = InspectWindows()
            .Where(window =>
                window.IsVisible
                && window.ParentHandle != HwndMessage.ToInt64())
            .OrderBy(window => window.Handle == main.Value.Handle ? 1 : 0)
            .ToArray();

        // KuGou renders this VIP prompt as two independent, borderless top-level
        // kugou_ui windows instead of a child control. The visible content window
        // is 474x590 and is inset by 10 px inside a 494x610 shadow/backdrop window.
        // This pair is a more reliable signal than GetDC for layered windows.
        var geometricPopup = windows
            .Where(window =>
                window.ParentHandle is null
                && window.Handle != main.Value.Handle
                && window.ClassName.Equals(
                    "kugou_ui",
                    StringComparison.OrdinalIgnoreCase)
                && string.IsNullOrWhiteSpace(window.Title)
                && Math.Abs(window.Width - 474) <= 3
                && Math.Abs(window.Height - 590) <= 3)
            .FirstOrDefault(inner =>
                windows.Any(outer =>
                    outer.ParentHandle is null
                    && outer.Handle != inner.Handle
                    && outer.ClassName.Equals(
                        "kugou_ui",
                        StringComparison.OrdinalIgnoreCase)
                    && string.IsNullOrWhiteSpace(outer.Title)
                    && Math.Abs(outer.Width - 494) <= 3
                    && Math.Abs(outer.Height - 610) <= 3
                    && Math.Abs(inner.Left - outer.Left - 10) <= 3
                    && Math.Abs(inner.Top - outer.Top - 10) <= 3));
        if (geometricPopup is not null)
        {
            return new VipPopupGuardResult(
                true,
                false,
                geometricPopup.Handle,
                geometricPopup.ClassName,
                geometricPopup.Title,
                geometricPopup.Width,
                geometricPopup.Height,
                null,
                DateTimeOffset.Now,
                false,
                geometricPopup.Handle,
                0,
                0,
                "DedicatedKugouVipWindowPair");
        }

        foreach (var window in windows)
        {
            var handle = (nint)window.Handle;
            if (!GetClientRect(handle, out var rect))
            {
                continue;
            }

            var width = Math.Max(0, rect.Right - rect.Left);
            var height = Math.Max(0, rect.Bottom - rect.Top);
            if (width < 430 || height < 520)
            {
                continue;
            }

            var deviceContext = GetDC(handle);
            if (deviceContext == nint.Zero)
            {
                continue;
            }

            try
            {
                var aspectRatio = width / (double)height;
                if (width <= 720
                    && height <= 920
                    && aspectRatio is >= 0.70 and <= 0.90
                    && MatchesVipVisualSignature(
                        deviceContext,
                        0,
                        0,
                        width,
                        height))
                {
                    return new VipPopupGuardResult(
                        true,
                        false,
                        window.Handle,
                        window.ClassName,
                        window.Title,
                        width,
                        height,
                        null,
                        DateTimeOffset.Now,
                        false,
                        window.Handle,
                        0,
                        0,
                        "DedicatedKugouWindowVisualSignature");
                }

                if (TryFindEmbeddedVipPopup(
                        deviceContext,
                        width,
                        height,
                        out var popup))
                {
                    return new VipPopupGuardResult(
                        true,
                        false,
                        window.Handle,
                        window.ClassName,
                        window.Title,
                        popup.Width,
                        popup.Height,
                        null,
                        DateTimeOffset.Now,
                        false,
                        window.Handle,
                        popup.X,
                        popup.Y,
                        window.Handle == main.Value.Handle
                            ? "EmbeddedInKugouMainWindow"
                            : "EmbeddedInKugouChildWindow");
                }
            }
            finally
            {
                _ = ReleaseDC(handle, deviceContext);
            }
        }

        return new VipPopupGuardResult(
            false,
            false,
            null,
            null,
            null,
            0,
            0,
            null,
            DateTimeOffset.Now);
    }

    public static VipPopupGuardResult TryCloseVipTrialPopup()
    {
        var detected = DetectVipTrialPopup();
        if (!detected.Found || detected.HostWindowHandle is null)
        {
            return detected;
        }

        var host = (nint)detected.HostWindowHandle.Value;
        var dedicatedWindow =
            detected.OriginX == 0
            && detected.OriginY == 0
            && GetClientRect(host, out var hostRect)
            && Math.Abs(
                (hostRect.Right - hostRect.Left) - detected.Width) <= 2
            && Math.Abs(
                (hostRect.Bottom - hostRect.Top) - detected.Height) <= 2;
        if (dedicatedWindow)
        {
            var sent = PostMessage(
                host,
                WmClose,
                nint.Zero,
                nint.Zero);
            Thread.Sleep(120);
            var succeeded = !IsWindowVisible(host)
                || !DetectVipTrialPopup().Found;
            return detected with
            {
                CloseSent = sent,
                CloseSucceeded = succeeded,
                CloseMethod = "WM_CLOSE",
                Error = succeeded
                    ? null
                    : "WM_CLOSE 已投递，但会员弹窗仍可见"
            };
        }

        var closePoint = new Point
        {
            X = detected.OriginX + detected.Width - Math.Max(14, detected.Width / 32),
            Y = detected.OriginY + Math.Max(16, detected.Height / 34)
        };
        var (clickTarget, targetPoint) =
            FindDeepestChildAtPoint(host, closePoint);
        var kugouProcessIds = Process.GetProcessesByName("KuGou")
            .Select(process => process.Id)
            .ToHashSet();
        if (clickTarget == nint.Zero
            || !kugouProcessIds.Contains(GetProcessId(clickTarget)))
        {
            clickTarget = host;
            targetPoint = closePoint;
        }

        var clickParameter = MakePointParameter(targetPoint.X, targetPoint.Y);
        var moveSent = PostMessage(
            clickTarget,
            WmMouseMove,
            nint.Zero,
            clickParameter);
        var downSent = PostMessage(
            clickTarget,
            WmLeftButtonDown,
            MouseKeyLeftButton,
            clickParameter);
        var upSent = PostMessage(
            clickTarget,
            WmLeftButtonUp,
            nint.Zero,
            clickParameter);
        Thread.Sleep(150);
        var succeededAfterClick = !DetectVipTrialPopup().Found;
        if (succeededAfterClick)
        {
            return detected with
            {
                CloseSent = moveSent && downSent && upSent,
                CloseSucceeded = true,
                CloseMethod = "DirectWindowMessageClick",
                Error = null
            };
        }

        var escapeDown = PostMessage(
            host,
            WmKeyDown,
            VkEscape,
            nint.Zero);
        var escapeUp = PostMessage(
            host,
            WmKeyUp,
            VkEscape,
            nint.Zero);
        Thread.Sleep(120);
        var succeededAfterEscape = !DetectVipTrialPopup().Found;
        return detected with
        {
            CloseSent = moveSent
                && downSent
                && upSent
                && escapeDown
                && escapeUp,
            CloseSucceeded = succeededAfterEscape,
            CloseMethod = "DirectWindowMessageClick+WindowEscapeMessage",
            Error = succeededAfterEscape
                ? null
                : "已向弹窗右上角发送窗口内点击并投递 Escape，但视觉检测仍发现会员弹窗"
        };
    }

    private static (nint Handle, Point Point) FindDeepestChildAtPoint(
        nint host,
        Point hostPoint)
    {
        var current = host;
        var currentPoint = hostPoint;
        for (var depth = 0; depth < 8; depth++)
        {
            var child = ChildWindowFromPointEx(
                current,
                currentPoint,
                ChildWindowSkipInvisible | ChildWindowSkipDisabled);
            if (child == nint.Zero || child == current)
            {
                break;
            }

            var screenPoint = currentPoint;
            if (!ClientToScreen(current, ref screenPoint))
            {
                break;
            }

            var childPoint = screenPoint;
            if (!ScreenToClient(child, ref childPoint))
            {
                break;
            }

            current = child;
            currentPoint = childPoint;
        }

        return (current, currentPoint);
    }

    private static bool TryFindEmbeddedVipPopup(
        nint deviceContext,
        int hostWidth,
        int hostHeight,
        out PopupRegion popup)
    {
        var sizes = new[]
        {
            (Width: 470, Height: 590),
            (Width: 588, Height: 738),
            (Width: 705, Height: 885)
        };
        foreach (var size in sizes)
        {
            if (hostWidth < size.Width || hostHeight < size.Height)
            {
                continue;
            }

            var centeredX = (hostWidth - size.Width) / 2;
            var centeredY = (hostHeight - size.Height) / 2;
            if (MatchesVipVisualSignature(
                    deviceContext,
                    centeredX,
                    centeredY,
                    size.Width,
                    size.Height))
            {
                popup = new PopupRegion(
                    centeredX,
                    centeredY,
                    size.Width,
                    size.Height);
                return true;
            }

            for (var y = 0; y <= hostHeight - size.Height; y += 10)
            {
                for (var x = 0; x <= hostWidth - size.Width; x += 10)
                {
                    if (Math.Abs(x - centeredX) < 10
                        && Math.Abs(y - centeredY) < 10)
                    {
                        continue;
                    }

                    if (MatchesVipVisualSignature(
                            deviceContext,
                            x,
                            y,
                            size.Width,
                            size.Height))
                    {
                        popup = new PopupRegion(
                            x,
                            y,
                            size.Width,
                            size.Height);
                        return true;
                    }
                }
            }
        }

        popup = default;
        return false;
    }

    private static bool MatchesVipVisualSignature(
        nint deviceContext,
        int originX,
        int originY,
        int width,
        int height)
    {
        var topCreamSamples = new[]
        {
            ReadPixel(
                deviceContext,
                originX + width * 8 / 100,
                originY + height * 4 / 100),
            ReadPixel(
                deviceContext,
                originX + width * 82 / 100,
                originY + height * 5 / 100)
        };
        var actionButtonSamples = new[]
        {
            ReadPixel(
                deviceContext,
                originX + width * 23 / 100,
                originY + height * 77 / 100),
            ReadPixel(
                deviceContext,
                originX + width * 77 / 100,
                originY + height * 77 / 100)
        };
        return topCreamSamples.All(IsVipHeaderCream)
            && actionButtonSamples.Any(IsVipActionCream);
    }

    private static nint MakePointParameter(int x, int y)
    {
        return (nint)((y & 0xffff) << 16 | (x & 0xffff));
    }

    private static (byte Red, byte Green, byte Blue)? ReadPixel(
        nint deviceContext,
        int x,
        int y)
    {
        var color = GetPixel(deviceContext, x, y);
        return color == uint.MaxValue
            ? null
            : (
                (byte)(color & 0xff),
                (byte)((color >> 8) & 0xff),
                (byte)((color >> 16) & 0xff));
    }

    private static bool IsVipHeaderCream(
        (byte Red, byte Green, byte Blue)? color)
    {
        return color is { } value
            && value.Red >= 245
            && value.Green >= 235
            && value.Blue >= 205;
    }

    private static bool IsVipActionCream(
        (byte Red, byte Green, byte Blue)? color)
    {
        return color is { } value
            && value.Red >= 225
            && value.Green is >= 170 and <= 240
            && value.Blue <= 210
            && value.Red - value.Green >= 10
            && value.Green - value.Blue >= 10;
    }

    public static async Task<KugouPlaybackState> ReadPlaybackStateWithIdentityAsync(
        CancellationToken cancellationToken = default)
    {
        var state = ReadPlaybackState();
        if (state.AudioId > 0
            || !string.IsNullOrWhiteSpace(state.Hash)
            || string.IsNullOrWhiteSpace(state.RawTitle))
        {
            return state;
        }

        var identityKey = NormalizeSongIdentityKey(state.RawTitle);
        if (SongIdentityCache.TryGetValue(identityKey, out var cached))
        {
            return ApplySongIdentity(state, cached);
        }

        try
        {
            var endpoint =
                "http://mobilecdn.kugou.com/api/v3/search/song"
                + "?format=json"
                + $"&keyword={Uri.EscapeDataString(state.RawTitle)}"
                + "&page=1&pagesize=10&showtype=1";
            using var response = await HttpClient
                .GetAsync(endpoint, cancellationToken)
                .ConfigureAwait(false);
            response.EnsureSuccessStatusCode();
            await using var content = await response.Content
                .ReadAsStreamAsync(cancellationToken)
                .ConfigureAwait(false);
            using var document = await JsonDocument
                .ParseAsync(content, cancellationToken: cancellationToken)
                .ConfigureAwait(false);

            if (!document.RootElement.TryGetProperty("data", out var data)
                || !data.TryGetProperty("info", out var info)
                || info.ValueKind != JsonValueKind.Array)
            {
                return state with { IdentitySource = "KugouSearchNoResult" };
            }

            var normalizedRawTitle = NormalizeSongIdentityKey(state.RawTitle);
            var normalizedArtist = NormalizeSongIdentityKey(state.Artist);
            var normalizedTitle = NormalizeSongIdentityKey(state.Title);
            JsonElement? exactSong = null;
            foreach (var song in info.EnumerateArray())
            {
                var filename = ReadJsonText(song, "filename");
                var singerName = ReadJsonText(song, "singername");
                var songName = ReadJsonText(song, "songname");
                var exactFilename =
                    NormalizeSongIdentityKey(filename) == normalizedRawTitle;
                var exactParts =
                    !string.IsNullOrWhiteSpace(normalizedArtist)
                    && !string.IsNullOrWhiteSpace(normalizedTitle)
                    && NormalizeSongIdentityKey(singerName) == normalizedArtist
                    && NormalizeSongIdentityKey(songName) == normalizedTitle;
                if (exactFilename || exactParts)
                {
                    exactSong = song;
                    break;
                }
            }

            if (exactSong is null)
            {
                var unresolved = new KugouSongIdentity(
                    0,
                    0,
                    string.Empty,
                    "KugouSearchNoExactMatch");
                SongIdentityCache[identityKey] = unresolved;
                return ApplySongIdentity(state, unresolved);
            }

            var match = exactSong.Value;
            var identity = new KugouSongIdentity(
                ReadJsonLong(match, "audio_id"),
                ReadJsonLong(match, "mixsongid"),
                ReadJsonText(match, "hash").ToUpperInvariant(),
                "KugouSearchExact");
            CacheSongIdentity(
                ReadJsonText(match, "filename"),
                ReadJsonText(match, "songname"),
                ReadJsonText(match, "singername"),
                identity.AudioId,
                identity.MixSongId,
                identity.Hash,
                identity.Source);
            SongIdentityCache[identityKey] = identity;
            return ApplySongIdentity(state, identity);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception) when (
            exception is HttpRequestException
                or TaskCanceledException
                or JsonException)
        {
            return state with { IdentitySource = "KugouSearchUnavailable" };
        }
    }

    public static KugouPlaybackState ReadPlaybackState()
    {
        var target = FindMainWindow();
        var windowTitle = target is null ? string.Empty : ReadWindowTitle(target.Value.Handle);
        var iniTitle = ReadIniString(PlaybackSection, "LastPlayingTitleName").Trim();
        var liveTitle = ExtractTitleFromKugouTicker(windowTitle);
        var rawTitle = string.IsNullOrWhiteSpace(liveTitle) ? iniTitle : liveTitle;
        var (artist, title) = ParseArtistAndTitle(rawTitle);

        DateTimeOffset? lastWrite = File.Exists(KugouIniPath)
            ? new DateTimeOffset(File.GetLastWriteTime(KugouIniPath))
            : null;

        var state = new KugouPlaybackState(
            string.IsNullOrWhiteSpace(liveTitle) ? "KuGou.ini" : "WindowTitle",
            windowTitle.Trim(),
            rawTitle,
            artist,
            title,
            ReadIniInt(PlaybackSection, "LastPlayingSongItem"),
            ReadIniInt(PlaybackSection, "LastPlayingSongList"),
            ReadIniInt(PlaybackSection, "LastPlayingSongTable"),
            ReadIniLong(PlaybackSection, "LastPlayingSongPos"),
            lastWrite);
        return SongIdentityCache.TryGetValue(
            NormalizeSongIdentityKey(rawTitle),
            out var identity)
            ? ApplySongIdentity(state, identity)
            : state;
    }

    private static string ExtractTitleFromKugouTicker(string windowTitle)
    {
        const string suffix = " - 酷狗音乐";
        const string separator = " - 酷狗音乐 ";
        const string wrappedPrefix = "酷狗音乐 ";
        var value = windowTitle.Trim();
        if (value.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
        {
            return value[..^suffix.Length].Trim();
        }

        var separatorIndex = value.IndexOf(
            separator,
            StringComparison.OrdinalIgnoreCase);
        if (separatorIndex >= 0)
        {
            var before = value[..separatorIndex];
            var after = value[(separatorIndex + separator.Length)..];
            return $"{after}{before}".Trim();
        }

        if (value.StartsWith(wrappedPrefix, StringComparison.OrdinalIgnoreCase))
        {
            var unwrapped = value[wrappedPrefix.Length..];
            return unwrapped.EndsWith(" -", StringComparison.Ordinal)
                ? unwrapped[..^2].Trim()
                : unwrapped.Trim();
        }

        return string.Empty;
    }

    private static void CacheSongIdentity(
        string filename,
        string songName,
        string singerName,
        long audioId,
        long mixSongId,
        string hash,
        string source)
    {
        var identity = new KugouSongIdentity(
            audioId,
            mixSongId,
            hash.ToUpperInvariant(),
            source);
        if (!string.IsNullOrWhiteSpace(filename))
        {
            SongIdentityCache[NormalizeSongIdentityKey(filename)] = identity;
        }

        var composedName = string.IsNullOrWhiteSpace(singerName)
            ? songName
            : $"{singerName} - {songName}";
        if (!string.IsNullOrWhiteSpace(composedName))
        {
            SongIdentityCache[NormalizeSongIdentityKey(composedName)] = identity;
        }
    }

    private static KugouPlaybackState ApplySongIdentity(
        KugouPlaybackState state,
        KugouSongIdentity identity)
    {
        return state with
        {
            AudioId = identity.AudioId,
            MixSongId = identity.MixSongId,
            Hash = identity.Hash,
            IdentitySource = identity.Source
        };
    }

    private static string NormalizeSongIdentityKey(string value)
    {
        var normalized = value
            .Normalize(NormalizationForm.FormKC)
            .Trim()
            .ToUpperInvariant();
        var builder = new StringBuilder(normalized.Length);
        foreach (var character in normalized)
        {
            if (!char.IsWhiteSpace(character))
            {
                builder.Append(character);
            }
        }

        return builder.ToString();
    }

    private static (string Artist, string Title) ParseArtistAndTitle(string rawTitle)
    {
        var separatorIndex = rawTitle.IndexOf(" - ", StringComparison.Ordinal);
        if (separatorIndex < 0)
        {
            return (string.Empty, rawTitle);
        }

        return (
            rawTitle[..separatorIndex].Trim(),
            rawTitle[(separatorIndex + 3)..].Trim());
    }

    public static IReadOnlyList<WindowInfo> InspectWindows()
    {
        var kugouProcessIds = Process.GetProcessesByName("KuGou")
            .Select(process => process.Id)
            .ToHashSet();
        var results = new List<WindowInfo>();
        var seenHandles = new HashSet<nint>();

        EnumWindows((handle, lParam) =>
        {
            _ = lParam;
            GetWindowThreadProcessId(handle, out var processId);
            if (!kugouProcessIds.Contains((int)processId))
            {
                return true;
            }

            if (seenHandles.Add(handle))
            {
                results.Add(CreateWindowInfo(handle, (int)processId, null));
            }

            EnumChildWindows(handle, (child, childLParam) =>
            {
                _ = childLParam;
                GetWindowThreadProcessId(child, out var childProcessId);
                if (seenHandles.Add(child))
                {
                    results.Add(CreateWindowInfo(child, (int)childProcessId, handle));
                }

                return true;
            }, nint.Zero);
            return true;
        }, nint.Zero);

        // EnumWindows deliberately skips HWND_MESSAGE windows. KuGou uses a hidden
        // singleton/IPC window, so include that namespace explicitly.
        var messageWindow = nint.Zero;
        while ((messageWindow = FindWindowEx(
                   HwndMessage,
                   messageWindow,
                   null,
                   null)) != nint.Zero)
        {
            GetWindowThreadProcessId(messageWindow, out var processId);
            if (kugouProcessIds.Contains((int)processId)
                && seenHandles.Add(messageWindow))
            {
                results.Add(CreateWindowInfo(
                    messageWindow,
                    (int)processId,
                    HwndMessage));
            }
        }

        return results;
    }

    public static WindowInfo? InspectIpcEndpoint()
    {
        var target = FindKugouIpcWindow();
        return target is null
            ? null
            : CreateWindowInfo(
                target.Value.Handle,
                target.Value.ProcessId,
                null);
    }

    private static (nint Handle, int ProcessId)? FindKugouIpcWindow()
    {
        var mapping = OpenFileMapping(
            FileMapRead,
            false,
            KugouDataExchangeMappingName);
        if (mapping == nint.Zero)
        {
            return null;
        }

        var view = nint.Zero;
        try
        {
            view = MapViewOfFile(
                mapping,
                FileMapRead,
                0,
                0,
                nuint.Zero);
            if (view == nint.Zero)
            {
                return null;
            }

            var rawHandle = unchecked((uint)Marshal.ReadInt32(
                view,
                KugouDataExchangeWindowOffset));
            if (rawHandle == 0)
            {
                return null;
            }

            var handle = (nint)rawHandle;
            var processId = GetProcessId(handle);
            return processId == 0 ? null : (handle, processId);
        }
        finally
        {
            if (view != nint.Zero)
            {
                _ = UnmapViewOfFile(view);
            }

            _ = CloseHandle(mapping);
        }
    }

    private static (nint Handle, int ProcessId)? FindMainWindow()
    {
        return InspectWindows()
            .Where(window => window.ParentHandle is null && window.IsVisible)
            .OrderByDescending(window => window.ClassName.Equals("kugou_ui", StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(window => window.Title.Contains("酷狗音乐", StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(window => !string.IsNullOrWhiteSpace(window.Title))
            .Select(window => ((nint)window.Handle, window.ProcessId))
            .Cast<(nint Handle, int ProcessId)?>()
            .FirstOrDefault();
    }

    private static int GetProcessId(nint handle)
    {
        _ = GetWindowThreadProcessId(handle, out var processId);
        return (int)processId;
    }

    private static (int Width, int Height) GetClientSize(nint handle)
    {
        if (!GetClientRect(handle, out var rect))
        {
            return (1060, 720);
        }

        return (Math.Max(1, rect.Right - rect.Left), Math.Max(1, rect.Bottom - rect.Top));
    }

    private static bool TryBringToForeground(nint target)
    {
        if (GetForegroundWindow() == target)
        {
            return true;
        }

        var foreground = GetForegroundWindow();
        var foregroundThread = foreground == nint.Zero
            ? 0
            : GetWindowThreadProcessId(foreground, out _);
        var targetThread = GetWindowThreadProcessId(target, out _);
        var currentThread = GetCurrentThreadId();
        var currentToForegroundAttached = false;
        var currentToTargetAttached = false;

        try
        {
            if (foregroundThread != 0 && foregroundThread != currentThread)
            {
                currentToForegroundAttached = AttachThreadInput(currentThread, foregroundThread, true);
            }

            if (targetThread != 0
                && targetThread != currentThread
                && targetThread != foregroundThread)
            {
                currentToTargetAttached = AttachThreadInput(currentThread, targetThread, true);
            }

            _ = BringWindowToTop(target);
            _ = SetForegroundWindow(target);
            return GetForegroundWindow() == target;
        }
        finally
        {
            if (currentToTargetAttached)
            {
                _ = AttachThreadInput(currentThread, targetThread, false);
            }

            if (currentToForegroundAttached)
            {
                _ = AttachThreadInput(currentThread, foregroundThread, false);
            }
        }
    }

    private static WindowInfo CreateWindowInfo(nint handle, int processId, nint? parent)
    {
        _ = GetWindowRect(handle, out var rect);
        return new WindowInfo(
            handle,
            processId,
            ReadWindowClass(handle),
            ReadWindowTitle(handle),
            IsWindowVisible(handle),
            parent,
            rect.Left,
            rect.Top,
            Math.Max(0, rect.Right - rect.Left),
            Math.Max(0, rect.Bottom - rect.Top));
    }

    private static string ReadWindowTitle(nint handle)
    {
        var length = GetWindowTextLength(handle);
        if (length <= 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder(length + 1);
        _ = GetWindowText(handle, builder, builder.Capacity);
        return builder.ToString();
    }

    private static string ReadWindowClass(nint handle)
    {
        var builder = new StringBuilder(256);
        _ = GetClassName(handle, builder, builder.Capacity);
        return builder.ToString();
    }

    private static string ReadIniString(string section, string key)
    {
        var builder = new StringBuilder(2048);
        _ = GetPrivateProfileString(section, key, string.Empty, builder, builder.Capacity, KugouIniPath);
        return builder.ToString();
    }

    private static int ReadIniInt(string section, string key)
    {
        return int.TryParse(ReadIniString(section, key), out var value) ? value : 0;
    }

    private static long ReadIniLong(string section, string key)
    {
        return long.TryParse(ReadIniString(section, key), out var value) ? value : 0;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint SendMessage(nint hWnd, uint msg, nint wParam, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessage(
        nint hWnd,
        uint msg,
        nint wParam,
        nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint SendMessageTimeout(
        nint hWnd,
        uint msg,
        nint wParam,
        nint lParam,
        SendMessageTimeoutFlags flags,
        uint timeoutMilliseconds,
        out nuint result);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetClientRect(nint hWnd, out Rect rect);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(nint hWnd, out Rect rect);

    [DllImport("user32.dll")]
    private static extern nint GetDC(nint hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(nint hWnd, nint hDC);

    [DllImport("gdi32.dll")]
    private static extern uint GetPixel(nint hDC, int x, int y);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClientToScreen(nint hWnd, ref Point point);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ScreenToClient(nint hWnd, ref Point point);

    [DllImport("user32.dll")]
    private static extern nint ChildWindowFromPointEx(
        nint parent,
        Point point,
        uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(nint hWnd, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(nint hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool BringWindowToTop(nint hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachThreadInput(uint firstThread, uint secondThread, bool attach);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll", EntryPoint = "mouse_event")]
    private static extern void MouseEvent(
        uint flags,
        uint dx,
        uint dy,
        uint data,
        nuint extraInfo);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, nint lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumChildWindows(nint parent, EnumWindowsProc callback, nint lParam);

    [DllImport("user32.dll", EntryPoint = "FindWindowExW", CharSet = CharSet.Unicode)]
    private static extern nint FindWindowEx(
        nint parent,
        nint childAfter,
        string? className,
        string? windowName);

    [DllImport("user32.dll", EntryPoint = "CreateWindowExW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateWindowEx(
        uint extendedStyle,
        string className,
        string windowName,
        uint style,
        int x,
        int y,
        int width,
        int height,
        nint parent,
        nint menu,
        nint instance,
        nint parameter);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyWindow(nint hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint hWnd, out uint processId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll", EntryPoint = "OpenFileMappingW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint OpenFileMapping(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint MapViewOfFile(
        nint fileMapping,
        uint desiredAccess,
        uint fileOffsetHigh,
        uint fileOffsetLow,
        nuint numberOfBytesToMap);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnmapViewOfFile(nint baseAddress);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint handle);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint inputCount, Input[] inputs, int inputSize);

    [DllImport("user32.dll", EntryPoint = "GetWindowTextLengthW")]
    private static extern int GetWindowTextLength(nint hWnd);

    [DllImport("user32.dll", EntryPoint = "GetWindowTextW", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(nint hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(nint hWnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(nint hWnd);

    [DllImport("kernel32.dll", EntryPoint = "GetPrivateProfileStringW", CharSet = CharSet.Unicode)]
    private static extern uint GetPrivateProfileString(
        string section,
        string key,
        string defaultValue,
        StringBuilder returnedString,
        int size,
        string filePath);

    private sealed record KugouSongIdentity(
        long AudioId,
        long MixSongId,
        string Hash,
        string Source);

    private readonly record struct PopupRegion(
        int X,
        int Y,
        int Width,
        int Height);

    private delegate bool EnumWindowsProc(nint hWnd, nint lParam);

    [Flags]
    private enum SendMessageTimeoutFlags : uint
    {
        AbortIfHung = 0x0002
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CopyDataStruct
    {
        public nuint Data;
        public uint ByteCount;
        public nint DataPointer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public InputUnion Data;
    }

    [StructLayout(LayoutKind.Explicit, Size = 32)]
    private struct InputUnion
    {
        [FieldOffset(0)]
        public KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort VirtualKey;
        public ushort ScanCode;
        public uint Flags;
        public uint Time;
        public nuint ExtraInfo;
    }
}
