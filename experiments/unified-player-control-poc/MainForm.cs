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
        new NeteasePlayerAdapter(),
        new KugouPlayerAdapter(),
        new QQMusicPlayerAdapter()
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
    private readonly Label _capabilitiesLabel = new();
    private readonly Label _operationLabel = new();
    private readonly CheckBox _unsafeQqNextCheckBox = new();
    private readonly TextBox _searchTextBox = new();
    private readonly Button _searchButton = new();
    private readonly Button _refreshButton = new();
    private readonly Button _previousButton = new();
    private readonly Button _pauseButton = new();
    private readonly Button _resumeButton = new();
    private readonly Button _toggleButton = new();
    private readonly Button _nextButton = new();
    private readonly Button _playSelectedButton = new();
    private readonly Button _insertNextButton = new();
    private readonly DataGridView _resultsGrid = new();
    private readonly BindingList<PlayerTrack> _searchResults = [];
    private readonly RichTextBox _logBox = new();
    private readonly List<Button> _operationButtons = [];
    private readonly Dictionary<string, string> _lastAdapterStatuses = [];

    private bool _busy;
    private bool _polling;
    private bool _searching;

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
            _pollTimer.Start();
            await RefreshSelectedPlayerAsync(manual: true);
        };
        FormClosed += (_, _) =>
        {
            _pollTimer.Stop();
            _lifetime.Cancel();
            foreach (var adapter in _adapters)
            {
                try
                {
                    adapter.DisposeAsync().AsTask().GetAwaiter().GetResult();
                }
                catch
                {
                    // The process is already closing.
                }
            }

            _lifetime.Dispose();
            _pollTimer.Dispose();
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
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 166));
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
            RowCount = 5
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 118));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (var index = 0; index < 5; index++)
        {
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 20));
        }

        AddStatusRow(layout, 0, "连接状态", _connectionLabel);
        AddStatusRow(layout, 1, "版本", _versionLabel);
        AddStatusRow(layout, 2, "当前歌曲", _trackLabel);
        AddStatusRow(layout, 3, "歌曲标识", _trackIdLabel);
        AddStatusRow(layout, 4, "能力", _capabilitiesLabel);
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
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 260));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 205));

        _searchTextBox.Dock = DockStyle.Fill;
        _searchTextBox.PlaceholderText = "输入歌名和歌手，例如：周杰伦 稻香";
        ConfigureButton(_searchButton, "搜索", PrimaryColor);
        ConfigureButton(_playSelectedButton, "立即播放所选", SuccessColor);
        _unsafeQqNextCheckBox.Dock = DockStyle.Fill;
        _unsafeQqNextCheckBox.Text =
            "叠加 QQ 22.22 原生插队（修改进程，风险）";
        _unsafeQqNextCheckBox.ForeColor = ErrorColor;
        _unsafeQqNextCheckBox.TextAlign = ContentAlignment.MiddleLeft;
        _unsafeQqNextCheckBox.Visible = false;
        ConfigureButton(_insertNextButton, "设为下一首", Color.FromArgb(126, 34, 206));
        row.Controls.Add(_searchTextBox, 0, 0);
        row.Controls.Add(_searchButton, 1, 0);
        row.Controls.Add(_playSelectedButton, 2, 0);
        row.Controls.Add(_unsafeQqNextCheckBox, 3, 0);
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
            _unsafeQqNextCheckBox.Visible =
                SelectedAdapter is QQMusicPlayerAdapter;
            ApplyCapabilities();
            await RefreshSelectedPlayerAsync(manual: true);
        };
        _unsafeQqNextCheckBox.CheckedChanged += (_, _) =>
        {
            if (SelectedAdapter is QQMusicPlayerAdapter adapter)
            {
                adapter.AllowUnsafeNativeNext =
                    _unsafeQqNextCheckBox.Checked;
                AppendLog(
                    adapter.AllowUnsafeNativeNext
                        ? "已允许 QQ 22.22 原生插队；仍会执行校验，并保留暂停接管守卫。"
                        : "已关闭 QQ 原生插队；设为下一首将仅使用暂停接管守卫。");
            }

            ApplyCapabilities();
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
        _insertNextButton.Click += async (_, _) =>
            await ExecuteAsync(PlayerCommand.InsertNext);
    }

    private async Task RefreshSelectedPlayerAsync(bool manual)
    {
        if (_busy || _polling || IsDisposed)
        {
            return;
        }

        _polling = true;
        try
        {
            var adapter = SelectedAdapter;
            var snapshot = await adapter.ProbeAsync(_lifetime.Token);
            if (!ReferenceEquals(adapter, SelectedAdapter))
            {
                return;
            }

            UpdateSnapshot(snapshot);
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
        }
        catch (OperationCanceledException)
        {
            // The form is closing.
        }
        catch (Exception exception)
        {
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
            adapter is QQMusicPlayerAdapter
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
            or PlayerCommand.InsertNext;
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
        _connectionLabel.Text = snapshot.Connected
            ? $"● 已连接 · PID {snapshot.ProcessId}"
            : "● 未连接";
        _connectionLabel.ForeColor = snapshot.Connected
            ? SuccessColor
            : ErrorColor;

        var adapter = SelectedAdapter;
        var version = string.IsNullOrWhiteSpace(snapshot.Version)
            ? "未知"
            : snapshot.Version;
        var versionVerified = string.Equals(
            version,
            adapter.TestedVersion,
            StringComparison.OrdinalIgnoreCase);
        _versionLabel.Text =
            $"当前 {version} · 实测基准 {adapter.TestedVersion}"
            + (versionVerified
                ? " · 已验证版本"
                : " · 未验证版本，使用能力探测");
        _versionLabel.ForeColor = versionVerified
            ? SuccessColor
            : WarningColor;
        _trackLabel.Text = snapshot.Current?.DisplayName ?? "—";
        _trackIdLabel.Text =
            string.IsNullOrWhiteSpace(snapshot.Current?.Id)
                ? "未解析"
                : snapshot.Current.Id;
        _capabilitiesLabel.Text =
            BuildCapabilitiesText(adapter.Capabilities);
        ApplyCapabilities();
    }

    private void ApplyCapabilities()
    {
        var capabilities = SelectedAdapter.Capabilities;
        var isQqMusic = SelectedAdapter is QQMusicPlayerAdapter;
        _unsafeQqNextCheckBox.Visible = isQqMusic;
        _previousButton.Enabled = !_busy && capabilities.Previous;
        _pauseButton.Enabled = !_busy && capabilities.Pause;
        _resumeButton.Enabled = !_busy && capabilities.Resume;
        _toggleButton.Enabled = !_busy && capabilities.Toggle;
        _nextButton.Enabled = !_busy && capabilities.Next;
        _searchButton.Enabled =
            !_busy && !_searching && capabilities.Search;
        _searchButton.Text = _searching ? "搜索中…" : "搜索";
        _searchTextBox.Enabled =
            !_busy && !_searching && capabilities.Search;
        _playSelectedButton.Enabled =
            !_busy && capabilities.PlaySelected;
        _insertNextButton.Enabled =
            !_busy
            && capabilities.InsertNext;
        _insertNextButton.Text =
            !isQqMusic
                ? "守卫设为下一首"
                : _unsafeQqNextCheckBox.Checked
                    ? "原生+守卫下一首（风险）"
                    : "守卫设为下一首";
        _refreshButton.Enabled = !_busy && !_searching;
        _playerSelector.Enabled = !_busy && !_searching;
        _unsafeQqNextCheckBox.Enabled = !_busy;
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
