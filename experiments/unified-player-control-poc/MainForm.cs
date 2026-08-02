using System.ComponentModel;

namespace UnifiedPlayerControlPoc;

internal sealed class MainForm : Form
{
    private static readonly Color PageColor = Color.FromArgb(244, 247, 252);
    private static readonly Color CardColor = Color.White;
    private static readonly Color PrimaryColor = Color.FromArgb(37, 99, 235);
    private static readonly Color SuccessColor = Color.FromArgb(22, 163, 74);
    private static readonly Color WarningColor = Color.FromArgb(202, 138, 4);
    private static readonly Color ErrorColor = Color.FromArgb(220, 38, 38);
    private static readonly Color MutedColor = Color.FromArgb(100, 116, 139);

    private readonly IPlayerAdapter[] _adapters =
    [
        ConnectorProcessAdapter.CreateDefault("netease"),
        ConnectorProcessAdapter.CreateDefault("kugou"),
        ConnectorProcessAdapter.CreateDefault("qqmusic")
    ];
    private readonly CancellationTokenSource _lifetime = new();
    private readonly System.Windows.Forms.Timer _pollTimer = new()
    {
        Interval = 1000
    };
    private readonly ComboBox _playerSelector = new();
    private readonly Label _connectionLabel = new();
    private readonly Label _versionLabel = new();
    private readonly Label _trackLabel = new();
    private readonly Label _trackIdLabel = new();
    private readonly Label _nextTrackLabel = new();
    private readonly Label _nextSourceLabel = new();
    private readonly Label _capabilitiesLabel = new();
    private readonly Label _operationLabel = new();
    private readonly TextBox _searchTextBox = new();
    private readonly Button _searchButton = new();
    private readonly Button _refreshButton = new();
    private readonly Button _previousButton = new();
    private readonly Button _pauseButton = new();
    private readonly Button _resumeButton = new();
    private readonly Button _toggleButton = new();
    private readonly Button _nextButton = new();
    private readonly Button _playSelectedButton = new();
    private readonly Button _armNextGuardButton = new();
    private readonly Button _insertNextButton = new();
    private readonly DataGridView _resultsGrid = new();
    private readonly BindingList<PlayerTrack> _searchResults = [];
    private readonly RichTextBox _logBox = new();
    private readonly List<Button> _operationButtons = [];
    private readonly Dictionary<string, string> _lastAdapterStatuses = [];

    private bool _busy;
    private bool _polling;
    private bool _searching;
    private bool _eventStreamActive;
    private bool _fallbackPolling;
    private bool _shown;
    private bool _closing;
    private bool _closeCleanupStarted;
    private bool _allowClose;
    private long _adapterGeneration;
    private long _watchSequence;
    private long _lastAppliedWatchSequence;
    private CancellationTokenSource? _watchCancellation;
    private Task? _watchTask;

    public MainForm()
    {
        Text = "三合一播放器连接测试 · 网易云 / 酷狗 / QQ 音乐";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(1000, 760);
        Size = new Size(1180, 900);
        BackColor = PageColor;
        Font = new Font("Microsoft YaHei UI", 9F);

        BuildLayout();
        ConfigureEvents();
        _playerSelector.DataSource = _adapters;
        _playerSelector.DisplayMember = nameof(IPlayerAdapter.DisplayName);

        Shown += async (_, _) =>
        {
            _shown = true;
            var generation = await RestartSelectedAdapterWatchAsync();
            await RefreshSelectedPlayerAsync(
                manual: true,
                expectedGeneration: generation);
        };
        FormClosing += async (_, eventArgs) =>
        {
            if (_allowClose)
            {
                return;
            }

            eventArgs.Cancel = true;
            if (_closeCleanupStarted)
            {
                return;
            }

            _closeCleanupStarted = true;
            _closing = true;
            _pollTimer.Stop();
            _watchCancellation?.Cancel();
            _lifetime.Cancel();

            try
            {
                await StopSelectedAdapterWatchAsync();
                foreach (var adapter in _adapters)
                {
                    try
                    {
                        await adapter.DisposeAsync();
                    }
                    catch (Exception exception)
                    {
                        AppendLog(
                            $"关闭 {adapter.DisplayName} 时忽略异常："
                            + $"{exception.GetType().Name}: {exception.Message}");
                    }
                }
            }
            finally
            {
                _lifetime.Dispose();
                _pollTimer.Dispose();
                _allowClose = true;
                Close();
            }
        };
    }

    private IPlayerAdapter SelectedAdapter =>
        _playerSelector.SelectedItem as IPlayerAdapter
        ?? _adapters[0];

    private void BuildLayout()
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(18),
            ColumnCount = 1,
            RowCount = 7,
            BackColor = PageColor
        };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 214));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 174));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        Controls.Add(root);

        root.Controls.Add(BuildHeader(), 0, 0);
        root.Controls.Add(BuildStatusCard(), 0, 1);
        root.Controls.Add(BuildControlRow(), 0, 2);
        root.Controls.Add(BuildSearchRow(), 0, 3);
        root.Controls.Add(BuildResultsGrid(), 0, 4);
        root.Controls.Add(BuildLogPanel(), 0, 5);

        _operationLabel.Dock = DockStyle.Fill;
        _operationLabel.TextAlign = ContentAlignment.MiddleLeft;
        _operationLabel.ForeColor = MutedColor;
        _operationLabel.Text = "选择播放器后点击“连接 / 刷新”。";
        root.Controls.Add(_operationLabel, 0, 6);
    }

    private Control BuildHeader()
    {
        var panel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 4,
            Padding = new Padding(0, 7, 0, 7)
        };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 95));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 260));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 125));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        var title = new Label
        {
            Text = "目标播放器",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            Font = new Font(Font, FontStyle.Bold)
        };
        _playerSelector.Dock = DockStyle.Fill;
        _playerSelector.DropDownStyle = ComboBoxStyle.DropDownList;

        ConfigureButton(_refreshButton, "连接 / 刷新", PrimaryColor);

        panel.Controls.Add(title, 0, 0);
        panel.Controls.Add(_playerSelector, 1, 0);
        panel.Controls.Add(_refreshButton, 2, 0);
        panel.Controls.Add(new Panel(), 3, 0);
        return panel;
    }

    private Control BuildStatusCard()
    {
        var card = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = CardColor,
            Padding = new Padding(18),
            Margin = new Padding(0, 4, 0, 8)
        };
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 7
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 118));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (var index = 0; index < 7; index++)
        {
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100f / 7f));
        }

        AddStatusRow(layout, 0, "连接状态", _connectionLabel);
        AddStatusRow(layout, 1, "版本", _versionLabel);
        AddStatusRow(layout, 2, "当前歌曲", _trackLabel);
        AddStatusRow(layout, 3, "歌曲标识", _trackIdLabel);
        AddStatusRow(layout, 4, "下一首预览", _nextTrackLabel);
        AddStatusRow(layout, 5, "下一首来源", _nextSourceLabel);
        AddStatusRow(layout, 6, "能力", _capabilitiesLabel);
        card.Controls.Add(layout);
        return card;
    }

    private Control BuildControlRow()
    {
        var row = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Padding = new Padding(0, 7, 0, 7)
        };
        ConfigureButton(_previousButton, "上一首", Color.FromArgb(71, 85, 105));
        ConfigureButton(_pauseButton, "暂停", Color.FromArgb(71, 85, 105));
        ConfigureButton(_resumeButton, "恢复播放", Color.FromArgb(71, 85, 105));
        ConfigureButton(_toggleButton, "播放/暂停切换", Color.FromArgb(71, 85, 105));
        ConfigureButton(_nextButton, "下一首", Color.FromArgb(71, 85, 105));
        row.Controls.AddRange(
        [
            _previousButton,
            _pauseButton,
            _resumeButton,
            _toggleButton,
            _nextButton
        ]);
        return row;
    }

    private Control BuildSearchRow()
    {
        var row = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 5,
            Padding = new Padding(0, 8, 0, 8)
        };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 180));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 180));

        _searchTextBox.Dock = DockStyle.Fill;
        _searchTextBox.PlaceholderText = "输入歌名和歌手，例如：周杰伦 稻香";
        ConfigureButton(_searchButton, "搜索", PrimaryColor);
        ConfigureButton(_playSelectedButton, "立即播放所选", SuccessColor);
        ConfigureButton(_armNextGuardButton, "仅挂下一首守卫", Color.FromArgb(126, 34, 206));
        ConfigureButton(_insertNextButton, "原生插入下一首", Color.FromArgb(88, 28, 135));
        row.Controls.Add(_searchTextBox, 0, 0);
        row.Controls.Add(_searchButton, 1, 0);
        row.Controls.Add(_playSelectedButton, 2, 0);
        row.Controls.Add(_armNextGuardButton, 3, 0);
        row.Controls.Add(_insertNextButton, 4, 0);
        return row;
    }

    private Control BuildResultsGrid()
    {
        _resultsGrid.Dock = DockStyle.Fill;
        _resultsGrid.BackgroundColor = CardColor;
        _resultsGrid.BorderStyle = BorderStyle.FixedSingle;
        _resultsGrid.AutoGenerateColumns = false;
        _resultsGrid.AllowUserToAddRows = false;
        _resultsGrid.AllowUserToDeleteRows = false;
        _resultsGrid.AllowUserToResizeRows = false;
        _resultsGrid.ReadOnly = true;
        _resultsGrid.MultiSelect = false;
        _resultsGrid.SelectionMode =
            DataGridViewSelectionMode.FullRowSelect;
        _resultsGrid.RowHeadersVisible = false;
        _resultsGrid.DataSource = _searchResults;
        AddGridColumn("ID", nameof(PlayerTrack.Id), 150);
        AddGridColumn("歌曲", nameof(PlayerTrack.Title), 310);
        AddGridColumn("歌手", nameof(PlayerTrack.Artist), 300);
        AddGridColumn("专辑", nameof(PlayerTrack.Album), 260);
        return _resultsGrid;
    }

    private Control BuildLogPanel()
    {
        var group = new GroupBox
        {
            Dock = DockStyle.Fill,
            Text = "操作与能力验证日志",
            Padding = new Padding(8)
        };
        _logBox.Dock = DockStyle.Fill;
        _logBox.ReadOnly = true;
        _logBox.BackColor = Color.FromArgb(15, 23, 42);
        _logBox.ForeColor = Color.FromArgb(226, 232, 240);
        _logBox.Font = new Font("Consolas", 9F);
        _logBox.BorderStyle = BorderStyle.None;
        group.Controls.Add(_logBox);
        return group;
    }

    private void ConfigureEvents()
    {
        _playerSelector.SelectedIndexChanged += async (_, _) =>
        {
            _searchResults.Clear();
            ApplyCapabilities();
            if (!_shown)
            {
                return;
            }

            var generation = await RestartSelectedAdapterWatchAsync();
            await RefreshSelectedPlayerAsync(
                manual: true,
                expectedGeneration: generation);
        };
        _refreshButton.Click += async (_, _) =>
            await RefreshSelectedPlayerAsync(manual: true);
        _pollTimer.Tick += async (_, _) =>
            await RefreshSelectedPlayerAsync(manual: false);
        _searchButton.Click += async (_, _) => await SearchAsync();
        _searchTextBox.KeyDown += async (_, eventArgs) =>
        {
            if (eventArgs.KeyCode == Keys.Enter)
            {
                eventArgs.SuppressKeyPress = true;
                await SearchAsync();
            }
        };
        _resultsGrid.CellDoubleClick += async (_, eventArgs) =>
        {
            if (eventArgs.RowIndex >= 0)
            {
                await ExecuteAsync(PlayerCommand.PlaySelected);
            }
        };
        _previousButton.Click += async (_, _) =>
            await ExecuteAsync(PlayerCommand.Previous);
        _pauseButton.Click += async (_, _) =>
            await ExecuteAsync(PlayerCommand.Pause);
        _resumeButton.Click += async (_, _) =>
            await ExecuteAsync(PlayerCommand.Resume);
        _toggleButton.Click += async (_, _) =>
            await ExecuteAsync(PlayerCommand.Toggle);
        _nextButton.Click += async (_, _) =>
            await ExecuteAsync(PlayerCommand.Next);
        _playSelectedButton.Click += async (_, _) =>
            await ExecuteAsync(PlayerCommand.PlaySelected);
        _armNextGuardButton.Click += async (_, _) =>
            await ExecuteAsync(PlayerCommand.ArmNextGuard);
        _insertNextButton.Click += async (_, _) =>
            await ExecuteAsync(PlayerCommand.InsertNext);
    }

    private async Task<long> RestartSelectedAdapterWatchAsync()
    {
        var generation = Interlocked.Increment(ref _adapterGeneration);
        await StopSelectedAdapterWatchAsync();
        _lastAppliedWatchSequence = 0;
        _fallbackPolling = false;
        _pollTimer.Stop();

        if (_closing)
        {
            return generation;
        }

        var adapter = SelectedAdapter;
        if (adapter is not IPlayerSnapshotEventSource eventSource)
        {
            ActivatePollingFallback(
                adapter,
                generation,
                "连接器未提供事件源");
            return generation;
        }

        var cancellation = CancellationTokenSource.CreateLinkedTokenSource(
            _lifetime.Token);
        _watchCancellation = cancellation;
        _eventStreamActive = true;
        _fallbackPolling = false;
        SetOperation(
            $"{adapter.DisplayName}：协议事件流已启动，1 秒轮询已停止",
            PrimaryColor);
        AppendLog(
            $"{adapter.DisplayName}：协议事件流已启动 "
            + $"（generation={generation}）");
        _watchTask = WatchSnapshotsAsync(
            adapter,
            eventSource,
            generation,
            cancellation);
        return generation;
    }

    private async Task StopSelectedAdapterWatchAsync()
    {
        var cancellation = Interlocked.Exchange(
            ref _watchCancellation,
            null);
        var watchTask = Interlocked.Exchange(ref _watchTask, null);
        cancellation?.Cancel();
        if (watchTask is not null)
        {
            try
            {
                await watchTask;
            }
            catch (OperationCanceledException)
            {
                // Expected when switching adapters or closing the form.
            }
            catch (Exception exception)
            {
                if (!_closing)
                {
                    AppendLog(
                        $"停止快照事件流失败："
                        + $"{exception.GetType().Name}: {exception.Message}");
                }
            }
        }

        cancellation?.Dispose();
        _eventStreamActive = false;
    }

    private async Task WatchSnapshotsAsync(
        IPlayerAdapter adapter,
        IPlayerSnapshotEventSource eventSource,
        long generation,
        CancellationTokenSource owner)
    {
        try
        {
            await foreach (var snapshot in eventSource
                               .WatchSnapshotsAsync(owner.Token)
                               .WithCancellation(owner.Token)
                               .ConfigureAwait(false))
            {
                var sequence = Interlocked.Increment(ref _watchSequence);
                PostToUi(() =>
                {
                    if (_closing
                        || owner.IsCancellationRequested
                        || generation != Volatile.Read(ref _adapterGeneration)
                        || !ReferenceEquals(adapter, SelectedAdapter)
                        || sequence <= _lastAppliedWatchSequence)
                    {
                        return;
                    }

                    _lastAppliedWatchSequence = sequence;
                    UpdateSnapshot(snapshot);
                    SetOperation(
                        $"{adapter.DisplayName}：协议事件快照 #{sequence}",
                        PrimaryColor);
                    AppendLog(
                        $"{adapter.DisplayName}：协议事件快照 #{sequence} "
                        + $"status={snapshot.Status}");
                });
            }

            if (!owner.IsCancellationRequested)
            {
                PostToUi(() => ActivatePollingFallback(
                    adapter,
                    generation,
                    "事件流已结束"));
            }
        }
        catch (OperationCanceledException)
            when (owner.IsCancellationRequested)
        {
            // Expected when switching adapters or closing the form.
        }
        catch (Exception exception)
        {
            PostToUi(() => ActivatePollingFallback(
                adapter,
                generation,
                $"事件流异常：{exception.GetType().Name}"));
        }
    }

    private void ActivatePollingFallback(
        IPlayerAdapter adapter,
        long generation,
        string reason)
    {
        if (_closing
            || generation != Volatile.Read(ref _adapterGeneration)
            || !ReferenceEquals(adapter, SelectedAdapter))
        {
            return;
        }

        _eventStreamActive = false;
        _fallbackPolling = true;
        _pollTimer.Start();
        SetOperation(
            $"{adapter.DisplayName}：{reason}；每 1 秒兼容探测",
            WarningColor);
        AppendLog(
            $"{adapter.DisplayName}：{reason}；已恢复兼容探测 "
            + $"（generation={generation}）");
        _ = RefreshSelectedPlayerAsync(
            manual: true,
            expectedAdapter: adapter,
            expectedGeneration: generation);
    }

    private void PostToUi(Action action)
    {
        if (_closing || IsDisposed || Disposing || !IsHandleCreated)
        {
            return;
        }

        void SafeInvoke()
        {
            if (_closing || IsDisposed || Disposing)
            {
                return;
            }

            try
            {
                action();
            }
            catch (Exception exception)
            {
                if (!_closing)
                {
                    AppendLog(
                        $"协议事件更新 UI 失败："
                        + $"{exception.GetType().Name}: {exception.Message}");
                }
            }
        }

        try
        {
            if (InvokeRequired)
            {
                BeginInvoke((Action)SafeInvoke);
            }
            else
            {
                SafeInvoke();
            }
        }
        catch (ObjectDisposedException)
        {
            // The form is already disposed.
        }
        catch (InvalidOperationException)
        {
            // The handle may be tearing down.
        }
    }

    private async Task RefreshSelectedPlayerAsync(
        bool manual,
        IPlayerAdapter? expectedAdapter = null,
        long expectedGeneration = 0)
    {
        if (_busy || _polling || IsDisposed || _closing
            || (_eventStreamActive && !manual))
        {
            return;
        }

        _polling = true;
        var adapter = expectedAdapter ?? SelectedAdapter;
        var generation = expectedGeneration == 0
            ? Volatile.Read(ref _adapterGeneration)
            : expectedGeneration;
        try
        {
            var snapshot = await adapter.ProbeAsync(_lifetime.Token);
            if (_closing
                || generation != Volatile.Read(ref _adapterGeneration)
                || !ReferenceEquals(adapter, SelectedAdapter))
            {
                return;
            }

            UpdateSnapshot(snapshot);
            var source = _eventStreamActive
                ? "协议事件"
                : _fallbackPolling
                    ? "兼容探测"
                    : "主动探测";
            SetOperation(
                $"{adapter.DisplayName}：{source}快照已更新",
                _fallbackPolling ? WarningColor : PrimaryColor);
            var statusChanged =
                !_lastAdapterStatuses.TryGetValue(
                    adapter.Key,
                    out var previousStatus)
                || previousStatus != snapshot.Status;
            _lastAdapterStatuses[adapter.Key] = snapshot.Status;
            if (manual
                || (statusChanged
                    && snapshot.Status.Contains(
                        "下一首",
                        StringComparison.Ordinal)))
            {
                AppendLog(
                    $"{adapter.DisplayName}：{snapshot.Status}；"
                    + $"version={snapshot.Version}，pid={snapshot.ProcessId}。");
            }

            if (_fallbackPolling
                && adapter is ConnectorProcessAdapter
                {
                    SnapshotEventsSubscribed: true
                })
            {
                AppendLog(
                    $"{adapter.DisplayName}：连接器已恢复事件订阅，"
                    + "正在退出 1 秒兼容探测。");
                await RestartSelectedAdapterWatchAsync();
            }
        }
        catch (OperationCanceledException)
        {
            // The form is closing.
        }
        catch (Exception exception)
        {
            if (_closing
                || generation != Volatile.Read(ref _adapterGeneration)
                || !ReferenceEquals(adapter, SelectedAdapter))
            {
                return;
            }
            _connectionLabel.Text = "● 连接检测异常";
            _connectionLabel.ForeColor = ErrorColor;
            if (manual)
            {
                AppendLog(
                    $"连接检测失败：{exception.GetType().Name}: "
                    + exception.Message);
            }
        }
        finally
        {
            _polling = false;
        }
    }

    private async Task SearchAsync()
    {
        var query = _searchTextBox.Text.Trim();
        if (_busy || _searching || string.IsNullOrWhiteSpace(query))
        {
            return;
        }

        var adapter = SelectedAdapter;
        SetSearching(true, $"正在后台搜索 {adapter.DisplayName}…");
        using var searchTimeout =
            CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        searchTimeout.CancelAfter(
            string.Equals(adapter.Key, "qqmusic", StringComparison.OrdinalIgnoreCase)
                ? TimeSpan.FromSeconds(12)
                : TimeSpan.FromSeconds(20));
        try
        {
            var results = await adapter.SearchAsync(
                query,
                searchTimeout.Token);
            _searchResults.RaiseListChangedEvents = false;
            _searchResults.Clear();
            foreach (var result in results)
            {
                _searchResults.Add(result);
            }

            _searchResults.RaiseListChangedEvents = true;
            _searchResults.ResetBindings();
            if (_resultsGrid.Rows.Count > 0)
            {
                _resultsGrid.Rows[0].Selected = true;
            }

            SetOperation(
                $"搜索完成：{results.Count} 条结果。",
                results.Count > 0 ? SuccessColor : WarningColor);
            AppendLog(
                $"{adapter.DisplayName} 搜索“{query}”："
                + $"{results.Count} 条。");
        }
        catch (OperationCanceledException)
            when (!_lifetime.IsCancellationRequested)
        {
            SetOperation(
                $"{adapter.DisplayName} 搜索超时，已恢复界面，可重新搜索。",
                WarningColor);
            AppendLog(
                $"{adapter.DisplayName} 搜索“{query}”超时，"
                + "已取消请求并恢复操作按钮。");
        }
        catch (OperationCanceledException)
        {
            // The form is closing.
        }
        catch (Exception exception)
        {
            SetOperation($"搜索失败：{exception.Message}", ErrorColor);
            AppendLog(
                $"搜索异常：{exception.GetType().Name}: "
                + exception.Message);
        }
        finally
        {
            SetSearching(false);
        }
    }

    private async Task ExecuteAsync(PlayerCommand command)
    {
        if (_busy)
        {
            return;
        }

        var requiresTrack = command is PlayerCommand.PlaySelected
            or PlayerCommand.InsertNext
            or PlayerCommand.ArmNextGuard;
        var track = requiresTrack ? GetSelectedTrack() : null;
        if (requiresTrack && track is null)
        {
            SetOperation("请先选择一条搜索结果。", WarningColor);
            return;
        }

        var adapter = SelectedAdapter;
        SetBusy(true, $"{adapter.DisplayName} 正在执行 {command}…");
        try
        {
            var result = await adapter.ExecuteAsync(
                command,
                track,
                _lifetime.Token);
            SetOperation(
                $"[{result.Outcome}] {result.Message}",
                OutcomeColor(result.Outcome));
            AppendLog(
                $"{adapter.DisplayName} {command}："
                + $"{result.Outcome} | {result.Message}");
            if (result.Snapshot is not null)
            {
                UpdateSnapshot(result.Snapshot);
            }
        }
        catch (OperationCanceledException)
        {
            // The form is closing.
        }
        catch (Exception exception)
        {
            SetOperation(
                $"{command} 异常：{exception.Message}",
                ErrorColor);
            AppendLog(
                $"{command} 异常：{exception.GetType().Name}: "
                + exception.Message);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private void UpdateSnapshot(PlayerSnapshot snapshot)
    {
        _connectionLabel.ForeColor = snapshot.Connected
            ? SuccessColor
            : ErrorColor;

        var adapter = SelectedAdapter;
        var playerName = string.IsNullOrWhiteSpace(snapshot.Player)
            ? adapter.DisplayName
            : snapshot.Player;
        var displayVersion = string.IsNullOrWhiteSpace(snapshot.Version)
            ? "未知"
            : snapshot.Version.Trim();
        var versionMatches = IsVersionInTestedList(
            displayVersion,
            adapter.TestedVersion);
        _connectionLabel.Text = snapshot.Connected
            ? $"● 已连接 {playerName} · PID {snapshot.ProcessId}"
            : $"● 未连接 {playerName}";
        _versionLabel.Text =
            $"当前 {displayVersion} · 实测基准 {adapter.TestedVersion}"
            + (versionMatches
                ? " · 已验证版本"
                : " · 未验证版本，使用能力探测");
        _versionLabel.ForeColor = versionMatches
            ? SuccessColor
            : WarningColor;
        _trackLabel.Text = snapshot.Current?.DisplayName ?? "—";
        _trackIdLabel.Text = string.IsNullOrWhiteSpace(snapshot.Current?.Id)
            ? "未解析"
            : snapshot.Current.Id;
        _nextTrackLabel.Text = snapshot.Next?.DisplayName ?? "—";
        _nextSourceLabel.Text = string.IsNullOrWhiteSpace(snapshot.NextSource)
            ? "—"
            : snapshot.NextSource;
        _capabilitiesLabel.Text =
            BuildCapabilitiesText(adapter.Capabilities);
        ApplyCapabilities();
    }

    private void ApplyCapabilities()
    {
        var capabilities = SelectedAdapter.Capabilities;
        var operationsEnabled = !_busy && !_searching;
        _previousButton.Enabled = operationsEnabled && capabilities.Previous;
        _pauseButton.Enabled = operationsEnabled && capabilities.Pause;
        _resumeButton.Enabled = operationsEnabled && capabilities.Resume;
        _toggleButton.Enabled = operationsEnabled && capabilities.Toggle;
        _nextButton.Enabled = operationsEnabled && capabilities.Next;
        _playSelectedButton.Enabled =
            operationsEnabled && capabilities.PlaySelected;
        _armNextGuardButton.Enabled =
            operationsEnabled && capabilities.InsertNext;
        _insertNextButton.Enabled =
            operationsEnabled && capabilities.InsertNext;
        _searchButton.Enabled = operationsEnabled && capabilities.Search;
        _searchButton.Text = _searching ? "搜索中…" : "搜索";
        _searchTextBox.Enabled = operationsEnabled && capabilities.Search;
        _armNextGuardButton.Text = "仅挂下一首守卫";
        _insertNextButton.Text = "原生插入下一首";
        _refreshButton.Enabled = !_busy && !_searching;
        _playerSelector.Enabled = !_busy && !_searching;
    }

    private void SetSearching(bool searching, string? message = null)
    {
        _searching = searching;
        if (!string.IsNullOrWhiteSpace(message))
        {
            SetOperation(message, MutedColor);
        }

        ApplyCapabilities();
    }

    private void SetBusy(bool busy, string? message = null)
    {
        _busy = busy;
        Application.UseWaitCursor = busy;
        UseWaitCursor = busy;
        Cursor = busy ? Cursors.WaitCursor : Cursors.Default;
        if (!busy)
        {
            Cursor.Current = Cursors.Default;
        }

        if (!string.IsNullOrWhiteSpace(message))
        {
            SetOperation(message, MutedColor);
        }

        ApplyCapabilities();
    }

    private PlayerTrack? GetSelectedTrack()
    {
        return _resultsGrid.CurrentRow?.DataBoundItem as PlayerTrack;
    }

    private void SetOperation(string message, Color color)
    {
        _operationLabel.Text = message;
        _operationLabel.ForeColor = color;
    }

    private void AppendLog(string message)
    {
        _logBox.AppendText(
            $"[{DateTime.Now:HH:mm:ss.fff}] {message}"
            + Environment.NewLine);
        _logBox.SelectionStart = _logBox.TextLength;
        _logBox.ScrollToCaret();
        if (_logBox.Lines.Length > 500)
        {
            _logBox.Lines = _logBox.Lines.TakeLast(420).ToArray();
        }
    }

    private static void AddStatusRow(
        TableLayoutPanel layout,
        int row,
        string caption,
        Label value)
    {
        var label = new Label
        {
            Text = caption,
            Dock = DockStyle.Fill,
            ForeColor = MutedColor,
            TextAlign = ContentAlignment.MiddleLeft
        };
        value.Dock = DockStyle.Fill;
        value.TextAlign = ContentAlignment.MiddleLeft;
        value.AutoEllipsis = true;
        value.Text = "—";
        layout.Controls.Add(label, 0, row);
        layout.Controls.Add(value, 1, row);
    }

    private void ConfigureButton(
        Button button,
        string text,
        Color backColor)
    {
        button.Text = text;
        button.AutoSize = true;
        button.Height = 36;
        button.MinimumSize = new Size(88, 36);
        button.Margin = new Padding(0, 0, 8, 0);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.BackColor = backColor;
        button.ForeColor = Color.White;
        _operationButtons.Add(button);
    }

    private void AddGridColumn(
        string header,
        string property,
        int width)
    {
        _resultsGrid.Columns.Add(new DataGridViewTextBoxColumn
        {
            HeaderText = header,
            DataPropertyName = property,
            Width = width,
            AutoSizeMode = property == nameof(PlayerTrack.Title)
                ? DataGridViewAutoSizeColumnMode.Fill
                : DataGridViewAutoSizeColumnMode.None
        });
    }

    private static bool IsVersionInTestedList(
        string version,
        string testedVersions)
    {
        if (string.IsNullOrWhiteSpace(version)
            || string.IsNullOrWhiteSpace(testedVersions))
        {
            return false;
        }

        return testedVersions
            .Split(
                ['/', ',', ';', '|'],
                StringSplitOptions.RemoveEmptyEntries)
            .Select(candidate => candidate.Trim())
            .Any(candidate => string.Equals(
                candidate,
                version.Trim(),
                StringComparison.OrdinalIgnoreCase));
    }

    private static string BuildCapabilitiesText(
        PlayerCapabilities capabilities)
    {
        var values = new List<string>();
        if (capabilities.Search) values.Add("搜索");
        if (capabilities.PlaySelected) values.Add("指定播放");
        if (capabilities.Previous) values.Add("上一首");
        if (capabilities.Pause) values.Add("暂停");
        if (capabilities.Resume) values.Add("恢复");
        if (capabilities.Toggle) values.Add("Toggle");
        if (capabilities.Next) values.Add("下一首");
        if (capabilities.InsertNext)
        {
            values.Add("单独挂守卫");
            values.Add($"插入下一首（{capabilities.InsertNextLevel}）");
        }

        return string.Join(" · ", values);
    }

    private static Color OutcomeColor(OperationOutcome outcome)
    {
        return outcome switch
        {
            OperationOutcome.Verified or OperationOutcome.Applied =>
                SuccessColor,
            OperationOutcome.Accepted => PrimaryColor,
            OperationOutcome.Indeterminate => WarningColor,
            _ => ErrorColor
        };
    }
}
