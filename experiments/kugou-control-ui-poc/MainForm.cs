using System.Drawing.Drawing2D;

namespace KugouControlPoc;

internal sealed class MainForm : Form
{
    private static readonly Color PageColor = Color.FromArgb(245, 247, 251);
    private static readonly Color CardColor = Color.White;
    private static readonly Color PrimaryColor = Color.FromArgb(40, 113, 255);
    private static readonly Color SuccessColor = Color.FromArgb(28, 160, 93);
    private static readonly Color TextColor = Color.FromArgb(31, 41, 55);
    private static readonly Color MutedColor = Color.FromArgb(107, 114, 128);

    private readonly KugouTrackMonitor _monitor = new(TimeSpan.FromMilliseconds(250));
    private readonly Label _connectionLabel;
    private readonly Label _songLabel;
    private readonly Label _detailLabel;
    private readonly Label _operationLabel;
    private readonly Label _popupGuardLabel;
    private readonly TextBox _searchBox;
    private readonly RichTextBox _eventLog;
    private readonly List<Button> _actionButtons = [];

    private bool _busy;
    private DateTimeOffset? _lastPopupClosedAt;

    public MainForm()
    {
        Text = "酷狗控制 UI POC · 弹窗守卫 v2";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(860, 840);
        MinimumSize = new Size(800, 780);
        BackColor = PageColor;
        Font = new Font("Microsoft YaHei UI", 9F);

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(22),
            ColumnCount = 1,
            RowCount = 6,
            BackColor = PageColor
        };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 168));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 158));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 128));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        Controls.Add(root);

        var statusCard = CreateCard();
        root.Controls.Add(statusCard, 0, 0);

        _connectionLabel = new Label
        {
            AutoSize = true,
            Text = "● 正在连接酷狗…",
            ForeColor = MutedColor,
            Font = new Font(Font, FontStyle.Bold),
            Location = new Point(20, 17)
        };
        statusCard.Controls.Add(_connectionLabel);

        _songLabel = new Label
        {
            AutoEllipsis = true,
            Text = "等待当前歌曲",
            ForeColor = TextColor,
            Font = new Font("Microsoft YaHei UI", 17F, FontStyle.Bold),
            Location = new Point(18, 45),
            Size = new Size(730, 36)
        };
        statusCard.Controls.Add(_songLabel);

        _detailLabel = new Label
        {
            AutoEllipsis = true,
            Text = "窗口标题与 KuGou.ini 自动回退",
            ForeColor = MutedColor,
            Location = new Point(20, 88),
            Size = new Size(730, 24)
        };
        statusCard.Controls.Add(_detailLabel);

        var controlsRow = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Padding = new Padding(0, 10, 0, 6),
            BackColor = PageColor
        };
        root.Controls.Add(controlsRow, 0, 1);

        controlsRow.Controls.Add(CreateActionButton(
            "⏮ 上一首",
            Color.White,
            TextColor,
            async (_, _) => await RunDirectControlAsync(KugouAppCommand.PreviousTrack)));
        controlsRow.Controls.Add(CreateActionButton(
            "⏯ 播放 / 暂停",
            Color.White,
            TextColor,
            async (_, _) => await RunDirectControlAsync(KugouAppCommand.PlayPause)));
        controlsRow.Controls.Add(CreateActionButton(
            "下一首 ⏭",
            PrimaryColor,
            Color.White,
            async (_, _) => await RunDirectControlAsync(KugouAppCommand.NextTrack)));
        controlsRow.Controls.Add(CreateActionButton(
            "刷新状态",
            Color.White,
            TextColor,
            async (_, _) => await RefreshStateAsync()));

        var backgroundCard = CreateCard();
        root.Controls.Add(backgroundCard, 0, 2);

        var backgroundTitle = new Label
        {
            AutoSize = true,
            Text = "后台控制（酷狗无需焦点，不移动鼠标）",
            ForeColor = TextColor,
            Font = new Font(Font, FontStyle.Bold),
            Location = new Point(20, 15)
        };
        backgroundCard.Controls.Add(backgroundTitle);

        var backgroundHint = new Label
        {
            AutoEllipsis = true,
            Text = "纯后台模式直接投递酷狗内部命令，不产生键盘输入；快捷键模式保留为回退。",
            ForeColor = MutedColor,
            Location = new Point(20, 40),
            Size = new Size(760, 22)
        };
        backgroundCard.Controls.Add(backgroundHint);

        var directLabel = new Label
        {
            AutoSize = true,
            Text = "纯后台消息",
            ForeColor = SuccessColor,
            Font = new Font(Font, FontStyle.Bold),
            Location = new Point(20, 75)
        };
        backgroundCard.Controls.Add(directLabel);

        var directPreviousButton = CreateActionButton(
            "上一首",
            Color.FromArgb(236, 242, 255),
            PrimaryColor,
            async (_, _) => await RunDirectControlAsync(KugouAppCommand.PreviousTrack));
        directPreviousButton.Location = new Point(140, 65);
        directPreviousButton.Size = new Size(104, 34);
        backgroundCard.Controls.Add(directPreviousButton);

        var directToggleButton = CreateActionButton(
            "播放 / 暂停",
            Color.White,
            TextColor,
            async (_, _) => await RunDirectControlAsync(KugouAppCommand.PlayPause));
        directToggleButton.Location = new Point(254, 65);
        directToggleButton.Size = new Size(116, 34);
        backgroundCard.Controls.Add(directToggleButton);

        var directNextButton = CreateActionButton(
            "下一首",
            PrimaryColor,
            Color.White,
            async (_, _) => await RunDirectControlAsync(KugouAppCommand.NextTrack));
        directNextButton.Location = new Point(380, 65);
        directNextButton.Size = new Size(104, 34);
        backgroundCard.Controls.Add(directNextButton);

        var hotkeyLabel = new Label
        {
            AutoSize = true,
            Text = "快捷键回退",
            ForeColor = MutedColor,
            Font = new Font(Font, FontStyle.Bold),
            Location = new Point(20, 117)
        };
        backgroundCard.Controls.Add(hotkeyLabel);

        var hotkeyPreviousButton = CreateActionButton(
            "Alt+←",
            Color.White,
            TextColor,
            async (_, _) => await RunHotkeyControlAsync(KugouAppCommand.PreviousTrack));
        hotkeyPreviousButton.Location = new Point(140, 107);
        hotkeyPreviousButton.Size = new Size(104, 34);
        backgroundCard.Controls.Add(hotkeyPreviousButton);

        var hotkeyToggleButton = CreateActionButton(
            "Alt+F5",
            Color.White,
            TextColor,
            async (_, _) => await RunHotkeyControlAsync(KugouAppCommand.PlayPause));
        hotkeyToggleButton.Location = new Point(254, 107);
        hotkeyToggleButton.Size = new Size(116, 34);
        backgroundCard.Controls.Add(hotkeyToggleButton);

        var hotkeyNextButton = CreateActionButton(
            "Alt+→",
            Color.White,
            TextColor,
            async (_, _) => await RunHotkeyControlAsync(KugouAppCommand.NextTrack));
        hotkeyNextButton.Location = new Point(380, 107);
        hotkeyNextButton.Size = new Size(104, 34);
        backgroundCard.Controls.Add(hotkeyNextButton);

        _popupGuardLabel = new Label
        {
            AutoEllipsis = true,
            Text = "会员弹窗：未检测到 · 自动关闭已开启",
            ForeColor = MutedColor,
            Location = new Point(510, 75),
            Size = new Size(270, 56)
        };
        backgroundCard.Controls.Add(_popupGuardLabel);

        var searchCard = CreateCard();
        root.Controls.Add(searchCard, 0, 3);

        var searchTitle = new Label
        {
            AutoSize = true,
            Text = "后台文字点歌与本地文件（酷狗无需焦点）",
            ForeColor = TextColor,
            Font = new Font(Font, FontStyle.Bold),
            Location = new Point(20, 15)
        };
        searchCard.Controls.Add(searchTitle);

        _searchBox = new TextBox
        {
            PlaceholderText = "输入歌手和歌名，例如：周杰伦 稻香",
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Microsoft YaHei UI", 10F),
            Location = new Point(20, 43),
            Size = new Size(410, 32)
        };
        _searchBox.KeyDown += SearchBoxOnKeyDown;
        searchCard.Controls.Add(_searchBox);

        var playNowButton = CreateActionButton(
            "立即跳转播放",
            PrimaryColor,
            Color.White,
            async (_, _) => await SearchAndPlayAsync());
        playNowButton.Location = new Point(445, 42);
        playNowButton.Size = new Size(132, 34);
        searchCard.Controls.Add(playNowButton);

        var queueNextButton = CreateActionButton(
            "设为下一首（实验）",
            Color.FromArgb(236, 242, 255),
            PrimaryColor,
            async (_, _) => await SearchAsNextAsync());
        queueNextButton.Location = new Point(588, 42);
        queueNextButton.Size = new Size(152, 34);
        searchCard.Controls.Add(queueNextButton);

        var openLocalButton = CreateActionButton(
            "后台打开本地音频",
            Color.White,
            TextColor,
            async (_, _) => await OpenLocalFileAsync());
        openLocalButton.Location = new Point(20, 84);
        openLocalButton.Size = new Size(168, 34);
        searchCard.Controls.Add(openLocalButton);

        var forceRecoveryButton = CreateActionButton(
            "强制绕过弹窗点歌",
            Color.FromArgb(255, 244, 225),
            Color.FromArgb(180, 92, 20),
            async (_, _) => await ForceSearchAndPlayAsync());
        forceRecoveryButton.Location = new Point(200, 84);
        forceRecoveryButton.Size = new Size(180, 34);
        searchCard.Controls.Add(forceRecoveryButton);

        var ipcHint = new Label
        {
            AutoEllipsis = true,
            Text = "强制模式：内部 Stop → dwData=22；不绕过 VIP 授权。",
            ForeColor = MutedColor,
            Location = new Point(394, 91),
            Size = new Size(346, 24)
        };
        searchCard.Controls.Add(ipcHint);

        _operationLabel = new Label
        {
            AutoEllipsis = true,
            Text = "立即点播和本地文件已验证为纯后台；“设为下一首”仍在验证酷狗队列语义。",
            ForeColor = MutedColor,
            Location = new Point(20, 128),
            Size = new Size(720, 24)
        };
        searchCard.Controls.Add(_operationLabel);

        var eventCard = CreateCard();
        root.Controls.Add(eventCard, 0, 4);

        var logTitle = new Label
        {
            AutoSize = true,
            Text = "切歌信号",
            ForeColor = TextColor,
            Font = new Font(Font, FontStyle.Bold),
            Location = new Point(20, 15)
        };
        eventCard.Controls.Add(logTitle);

        var clearButton = new Button
        {
            Text = "清空",
            FlatStyle = FlatStyle.Flat,
            ForeColor = MutedColor,
            BackColor = CardColor,
            Location = new Point(675, 9),
            Size = new Size(60, 28),
            Cursor = Cursors.Hand
        };
        clearButton.FlatAppearance.BorderColor = Color.FromArgb(220, 224, 230);
        eventCard.Controls.Add(clearButton);

        _eventLog = new RichTextBox
        {
            ReadOnly = true,
            BorderStyle = BorderStyle.None,
            BackColor = Color.FromArgb(249, 250, 252),
            ForeColor = TextColor,
            Font = new Font("Cascadia Mono", 9F),
            Location = new Point(20, 46),
            Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
            Size = new Size(715, 150)
        };
        eventCard.Controls.Add(_eventLog);
        clearButton.Click += (_, _) => _eventLog.Clear();
        eventCard.Resize += (_, _) =>
        {
            clearButton.Left = eventCard.ClientSize.Width - 80;
            _eventLog.Size = new Size(
                eventCard.ClientSize.Width - 40,
                eventCard.ClientSize.Height - 62);
        };

        var footer = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = MutedColor,
            Text = "监测间隔 250ms · 控制、在线点播、本地文件均走酷狗内部消息 · 快捷键仅作回退"
        };
        root.Controls.Add(footer, 0, 5);

        _monitor.StateUpdated += MonitorOnStateUpdated;
        _monitor.TrackChanged += MonitorOnTrackChanged;
        _monitor.VipPopupClosed += MonitorOnVipPopupClosed;
        _monitor.VipPopupStatusChanged += MonitorOnVipPopupStatusChanged;
        _monitor.Error += MonitorOnError;

        Shown += (_, _) =>
        {
            AppendLog("监测器已启动，等待切歌信号。");
            _monitor.Start();
        };
        FormClosed += (_, _) => _monitor.Dispose();
    }

    private Panel CreateCard()
    {
        return new RoundedPanel
        {
            Dock = DockStyle.Fill,
            Margin = new Padding(0, 0, 0, 10),
            BackColor = CardColor
        };
    }

    private Button CreateActionButton(
        string text,
        Color backColor,
        Color foreColor,
        EventHandler onClick)
    {
        var button = new Button
        {
            Text = text,
            BackColor = backColor,
            ForeColor = foreColor,
            FlatStyle = FlatStyle.Flat,
            Size = new Size(142, 36),
            Margin = new Padding(0, 0, 10, 0),
            Cursor = Cursors.Hand,
            Font = new Font(Font, FontStyle.Bold)
        };
        button.FlatAppearance.BorderColor = backColor == Color.White
            ? Color.FromArgb(220, 224, 230)
            : backColor;
        button.Click += onClick;
        _actionButtons.Add(button);
        return button;
    }

    private async Task RunControlAsync(KugouAppCommand command)
    {
        await RunOperationAsync(
            command.ToString(),
            () => KugouNativeController.Send(command),
            result =>
            {
                if (result.Sent)
                {
                    AppendLog($"控制已发送：{result.Action}，句柄 {result.WindowHandle}。");
                    return "命令已发送到酷狗，等待状态变化。";
                }

                AppendLog($"控制失败：{result.Error}");
                return result.Error ?? "控制失败";
            });
    }

    private async Task RunDirectControlAsync(KugouAppCommand command)
    {
        await RunOperationAsync(
            $"纯后台 {command}",
            () => KugouNativeController.SendResilientKugouCommand(command),
            result =>
            {
                var safety =
                    $"前台{(result.ForegroundUnchanged ? "未变" : "已变")}，"
                    + $"鼠标{(result.CursorUnchanged ? "未动" : "已动")}";
                var succeeded = result.Sent
                    && result.ForegroundUnchanged
                    && result.CursorUnchanged
                    && (command == KugouAppCommand.PlayPause || result.TrackChanged);
                AppendLog(succeeded
                    ? $"纯后台控制成功：{result.Method}；"
                        + $"恢复={result.Recovery}；未发送按键；{safety}。"
                    : $"纯后台控制未确认：{result.Error}；{safety}。");
                return succeeded
                    ? command == KugouAppCommand.PlayPause
                        ? $"纯后台播放/暂停命令已投递；未发送按键；{safety}。"
                        : $"纯后台切歌成功：{FormatTrack(result.After)}；{safety}。"
                    : result.Error ?? $"纯后台控制未确认；{safety}。";
            });
    }

    private async Task RunHotkeyControlAsync(KugouAppCommand command)
    {
        await RunOperationAsync(
            $"快捷键回退 {command}",
            () => KugouNativeController.SendBackgroundHotkey(command),
            result =>
            {
                var safety =
                    $"前台{(result.ForegroundUnchanged ? "未变" : "已变")}，"
                    + $"鼠标{(result.CursorUnchanged ? "未动" : "已动")}";
                var succeeded = result.Sent
                    && result.ForegroundUnchanged
                    && result.CursorUnchanged
                    && (command == KugouAppCommand.PlayPause || result.TrackChanged);
                AppendLog(succeeded
                    ? $"快捷键回退成功：{result.Method}；{safety}。"
                    : $"快捷键回退未确认：{result.Error}；{safety}。");
                return succeeded
                    ? command == KugouAppCommand.PlayPause
                        ? $"后台播放/暂停命令已发送；{safety}。"
                        : $"后台切歌成功：{FormatTrack(result.After)}；{safety}。"
                    : result.Error ?? $"后台控制未确认；{safety}。";
            });
    }

    private async Task SearchAndPlayAsync()
    {
        var query = _searchBox.Text.Trim();
        if (!ValidateQuery(query))
        {
            return;
        }

        await RunAsyncOperationAsync(
            "立即跳转播放",
            () => KugouNativeController.SearchAndPlayBackgroundAsync(query),
            result =>
            {
                var target = FormatTrack(result.After);
                var succeeded = result.Sent
                    && result.TrackChanged
                    && result.ForegroundUnchanged;
                AppendLog(succeeded
                    ? $"后台跳转播放成功：{target}；"
                        + $"尝试 {result.Attempts} 次；恢复={result.Recovery}；"
                        + $"酷狗前台未变化。"
                    : $"跳转播放未确认：{result.Error}");
                return succeeded
                    ? $"已在后台跳转：{target}；"
                        + $"恢复={result.Recovery}；酷狗窗口没有被激活。"
                    : result.Error ?? "酷狗接受了点播消息，但结果未完整确认";
            });
    }

    private async Task SearchAsNextAsync()
    {
        var query = _searchBox.Text.Trim();
        if (!ValidateQuery(query))
        {
            return;
        }

        await RunAsyncOperationAsync(
            "设为下一首",
            () => KugouNativeController.SearchAsNextBackgroundAsync(query),
            result =>
            {
                var accepted = result.Sent && result.ForegroundUnchanged;
                AppendLog(accepted
                    ? $"酷狗已接受后台队列负载：{result.Resource}；等待继续验证实际顺序。"
                    : $"加入下一首失败：{result.Error}");
                return accepted
                    ? $"已提交实验队列：{result.Resource}；酷狗窗口没有被激活。"
                    : result.Error ?? "加入下一首失败";
            });
    }

    private async Task ForceSearchAndPlayAsync()
    {
        var query = _searchBox.Text.Trim();
        if (!ValidateQuery(query))
        {
            return;
        }

        await RunAsyncOperationAsync(
            "强制绕过弹窗点歌",
            () => KugouNativeController.SearchAndPlayForcedRecoveryAsync(query),
            result =>
            {
                var target = FormatTrack(result.After);
                var succeeded = result.Sent
                    && result.TrackChanged
                    && result.ForegroundUnchanged;
                AppendLog(succeeded
                    ? $"强制点歌成功：{target}；{result.Method}；"
                        + $"恢复={result.Recovery}。"
                    : $"强制点歌失败：{result.Error}；"
                        + $"Privilege={result.Privilege}。");
                return succeeded
                    ? $"强制恢复完成：{target}；酷狗窗口没有被激活。"
                    : result.Error ?? "强制恢复未检测到歌曲变化";
            });
    }

    private async Task OpenLocalFileAsync()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "选择要交给酷狗后台播放的音频文件",
            Filter =
                "音频文件|*.mp3;*.flac;*.wav;*.m4a;*.aac;*.ogg;*.wma"
                + "|所有文件|*.*",
            CheckFileExists = true,
            Multiselect = false
        };
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        await RunOperationAsync(
            "后台打开本地音频",
            () => KugouNativeController.SendBackgroundOpenFile(dialog.FileName),
            result =>
            {
                var succeeded = result.Sent
                    && result.TrackChanged
                    && result.ForegroundUnchanged;
                AppendLog(succeeded
                    ? $"本地文件后台播放成功：{result.Resource}"
                    : $"本地文件播放未确认：{result.Error}");
                return succeeded
                    ? $"酷狗已在后台播放本地文件：{Path.GetFileName(result.Resource)}"
                    : result.Error ?? "酷狗接受了文件消息，但没有检测到歌曲变化";
            });
    }

    private async Task RefreshStateAsync()
    {
        await RunAsyncOperationAsync(
            "刷新状态",
            () => KugouNativeController.ReadPlaybackStateWithIdentityAsync(),
            state =>
            {
                UpdateState(state);
                return $"已刷新：{FormatTrack(state)}";
            });
    }

    private async Task RunOperationAsync<T>(
        string operation,
        Func<T> action,
        Func<T, string> describe)
    {
        if (_busy)
        {
            return;
        }

        SetBusy(true, $"{operation}执行中…");
        try
        {
            var result = await Task.Run(action);
            SetOperationMessage(describe(result), success: true);
        }
        catch (Exception exception)
        {
            AppendLog($"{operation}异常：{exception.Message}");
            SetOperationMessage($"{operation}失败：{exception.Message}", success: false);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task RunAsyncOperationAsync<T>(
        string operation,
        Func<Task<T>> action,
        Func<T, string> describe)
    {
        if (_busy)
        {
            return;
        }

        SetBusy(true, $"{operation}执行中…");
        try
        {
            var result = await action();
            SetOperationMessage(describe(result), success: true);
        }
        catch (Exception exception)
        {
            AppendLog($"{operation}异常：{exception.Message}");
            SetOperationMessage($"{operation}失败：{exception.Message}", success: false);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private void MonitorOnStateUpdated(object? sender, KugouStateEventArgs eventArgs)
    {
        SafeUi(() => UpdateState(eventArgs.State));
    }

    private void MonitorOnTrackChanged(object? sender, KugouTrackChangedEventArgs eventArgs)
    {
        SafeUi(() =>
        {
            AppendLog(
                $"切歌信号：{FormatTrack(eventArgs.Previous)}"
                + $" [{FormatSongId(eventArgs.Previous)}]"
                + $"  →  {FormatTrack(eventArgs.Current)}"
                + $" [{FormatSongId(eventArgs.Current)}]");
            SetOperationMessage(
                $"收到切歌信号：{FormatTrack(eventArgs.Current)}"
                + $"；{FormatSongId(eventArgs.Current)}",
                success: true);
        });
    }

    private void MonitorOnVipPopupClosed(
        object? sender,
        KugouVipPopupClosedEventArgs eventArgs)
    {
        SafeUi(() =>
        {
            var result = eventArgs.Result;
            _lastPopupClosedAt = DateTimeOffset.Now;
            _popupGuardLabel.Text =
                $"会员弹窗：已检测并关闭（{result.CloseMethod}）";
            _popupGuardLabel.ForeColor = SuccessColor;
            AppendLog(
                $"已自动关闭会员试听弹窗：句柄 {result.WindowHandle}，"
                + $"{result.Width}×{result.Height}；"
                + $"检测={result.DetectionMethod}；关闭={result.CloseMethod}；"
                + "未移动物理鼠标。");
            SetOperationMessage(
                "检测到阻塞点歌的会员试听弹窗，已在后台自动关闭。",
                success: true);
        });
    }

    private void MonitorOnVipPopupStatusChanged(
        object? sender,
        KugouVipPopupClosedEventArgs eventArgs)
    {
        SafeUi(() =>
        {
            var result = eventArgs.Result;
            if (!result.Found)
            {
                if (_lastPopupClosedAt is null
                    || DateTimeOffset.Now - _lastPopupClosedAt
                    > TimeSpan.FromSeconds(5))
                {
                    _popupGuardLabel.Text = "会员弹窗：未检测到 · 自动关闭已开启";
                    _popupGuardLabel.ForeColor = MutedColor;
                }

                return;
            }

            if (result.CloseSucceeded)
            {
                return;
            }

            _popupGuardLabel.Text =
                $"会员弹窗：已检测，关闭失败（{result.DetectionMethod}）";
            _popupGuardLabel.ForeColor = Color.FromArgb(210, 65, 65);
            AppendLog(
                $"检测到会员弹窗但未能关闭：{result.Error ?? "未知原因"}；"
                + $"宿主句柄 {result.HostWindowHandle}。");
        });
    }

    private void MonitorOnError(object? sender, KugouMonitorErrorEventArgs eventArgs)
    {
        SafeUi(() =>
        {
            _connectionLabel.Text = "● 未连接";
            _connectionLabel.ForeColor = Color.FromArgb(210, 65, 65);
            AppendLog($"监测错误：{eventArgs.Exception.Message}");
        });
    }

    private void UpdateState(KugouPlaybackState state)
    {
        _connectionLabel.Text = "● 已连接酷狗";
        _connectionLabel.ForeColor = SuccessColor;
        _songLabel.Text = FormatTrack(state);
        _detailLabel.Text =
            $"歌曲 ID：{(state.AudioId > 0 ? state.AudioId : "解析中")}"
            + $"    Hash：{ShortHash(state.Hash)}"
            + $"    身份来源：{state.IdentitySource}"
            + $"    队列项：{state.SongItem}";
    }

    private void AppendLog(string message)
    {
        var line = $"[{DateTime.Now:HH:mm:ss.fff}] {message}{Environment.NewLine}";
        _eventLog.AppendText(line);
        _eventLog.SelectionStart = _eventLog.TextLength;
        _eventLog.ScrollToCaret();

        if (_eventLog.Lines.Length > 300)
        {
            _eventLog.Lines = _eventLog.Lines.TakeLast(240).ToArray();
        }
    }

    private void SetBusy(bool busy, string? message = null)
    {
        _busy = busy;
        foreach (var button in _actionButtons)
        {
            button.Enabled = !busy;
        }

        _searchBox.Enabled = !busy;
        UseWaitCursor = busy;
        if (!string.IsNullOrWhiteSpace(message))
        {
            _operationLabel.Text = message;
            _operationLabel.ForeColor = MutedColor;
        }
    }

    private void SetOperationMessage(string message, bool success)
    {
        _operationLabel.Text = message;
        _operationLabel.ForeColor = success ? SuccessColor : Color.FromArgb(210, 65, 65);
    }

    private bool ValidateQuery(string query)
    {
        if (!string.IsNullOrWhiteSpace(query))
        {
            return true;
        }

        SetOperationMessage("请先输入歌手或歌曲关键词。", success: false);
        _searchBox.Focus();
        return false;
    }

    private async void SearchBoxOnKeyDown(object? sender, KeyEventArgs eventArgs)
    {
        if (eventArgs.KeyCode != Keys.Enter)
        {
            return;
        }

        eventArgs.SuppressKeyPress = true;
        await SearchAndPlayAsync();
    }

    private void SafeUi(Action action)
    {
        if (IsDisposed)
        {
            return;
        }

        if (InvokeRequired)
        {
            BeginInvoke(action);
        }
        else
        {
            action();
        }
    }

    private static string FormatTrack(KugouPlaybackState state)
    {
        if (string.IsNullOrWhiteSpace(state.Artist))
        {
            return string.IsNullOrWhiteSpace(state.Title) ? "未知歌曲" : state.Title;
        }

        return $"{state.Artist} — {state.Title}";
    }

    private static string FormatSongId(KugouPlaybackState state)
    {
        return state.AudioId > 0
            ? $"audio_id={state.AudioId}"
            : !string.IsNullOrWhiteSpace(state.Hash)
                ? $"hash={ShortHash(state.Hash)}"
                : "歌曲 ID 未解析";
    }

    private static string ShortHash(string hash)
    {
        return string.IsNullOrWhiteSpace(hash)
            ? "—"
            : hash.Length <= 12
                ? hash
                : $"{hash[..8]}…{hash[^4..]}";
    }

    private sealed class RoundedPanel : Panel
    {
        protected override void OnResize(EventArgs eventArgs)
        {
            base.OnResize(eventArgs);
            using var path = new GraphicsPath();
            const int radius = 12;
            var bounds = ClientRectangle;
            bounds.Width -= 1;
            bounds.Height -= 1;
            path.AddArc(bounds.Left, bounds.Top, radius, radius, 180, 90);
            path.AddArc(bounds.Right - radius, bounds.Top, radius, radius, 270, 90);
            path.AddArc(bounds.Right - radius, bounds.Bottom - radius, radius, radius, 0, 90);
            path.AddArc(bounds.Left, bounds.Bottom - radius, radius, radius, 90, 90);
            path.CloseFigure();
            Region = new Region(path);
        }
    }
}
