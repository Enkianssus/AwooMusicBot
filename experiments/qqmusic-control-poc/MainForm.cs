using System.ComponentModel;

namespace QQMusicControlPoc;

internal sealed class MainForm : Form
{
    private readonly QQMusicCatalogClient _catalog = new();
    private readonly BindingList<QQMusicCatalogSong> _searchResults = [];
    private readonly System.Windows.Forms.Timer _monitorTimer = new()
    {
        Interval = 250
    };

    private readonly Label _connectionLabel = new();
    private readonly Label _trackLabel = new();
    private readonly Label _identityLabel = new();
    private readonly Label _playbackLabel = new();
    private readonly Label _queueLabel = new();
    private readonly Label _endpointLabel = new();
    private readonly Label _nativeProfileLabel = new();
    private readonly TextBox _searchTextBox = new();
    private readonly Button _searchButton = new();
    private readonly Button _playSelectedButton = new();
    private readonly Button _setNextButton = new();
    private readonly Button _prepareQueueButton = new();
    private readonly Button _previousButton = new();
    private readonly Button _playPauseButton = new();
    private readonly Button _nextButton = new();
    private readonly Button _analyzeNativeNextButton = new();
    private readonly DataGridView _resultsGrid = new();
    private readonly TextBox _logTextBox = new();
    private readonly Dictionary<
        (long SongId, int SongType),
        (string Title, string Artist)> _knownTracks = [];

    private QQMusicIpcSession? _ipcSession;
    private QQMusicPlaybackState? _windowState;
    private QQMusicPrivatePlaybackState? _privateState;
    private string? _lastStableIdentity;
    private string? _lastWindowIdentity;
    private string? _lastPrivateReadError;
    private int? _lastPlayStatus;
    private QQMusicSongReference[]? _expectedTwoSongQueue;
    private bool _twoSongQueueVerified;
    private PendingNativeNext? _pendingNativeNext;
    private bool _nativeNextVerified;
    private DateTimeOffset? _pendingNativeNextUnexpectedAt;
    private QQMusicPlaybackControl? _lastBlindPlaybackControl;
    private bool _monitorBusy;
    private bool _commandBusy;
    private bool _nativeNextExecutionAllowed;

    public MainForm()
    {
        Text = "QQ 音乐底层控制 POC · 原生下一首播放 v3";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(980, 680);
        Size = new Size(1160, 800);
        Font = new Font("Microsoft YaHei UI", 9F);

        BuildLayout();
        _setNextButton.Enabled = false;
        LoadPrivateComponents();

        _monitorTimer.Tick += async (_, _) =>
            await RefreshPlaybackStateAsync();
        _monitorTimer.Start();
        Shown += async (_, _) =>
        {
            await RefreshPlaybackStateAsync();
            await AnalyzeNativeNextAsync();
        };
        FormClosed += (_, _) =>
        {
            _monitorTimer.Stop();
            _ipcSession?.Dispose();
            _catalog.Dispose();
        };
    }

    private void BuildLayout()
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(12),
            ColumnCount = 1,
            RowCount = 5
        };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 58));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 42));
        Controls.Add(root);

        root.Controls.Add(BuildStatusPanel(), 0, 0);
        root.Controls.Add(BuildControlPanel(), 0, 1);
        root.Controls.Add(BuildSearchPanel(), 0, 2);
        root.Controls.Add(BuildResultsGrid(), 0, 3);
        root.Controls.Add(BuildLogPanel(), 0, 4);
    }

    private Control BuildStatusPanel()
    {
        var panel = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            ColumnCount = 2,
            Padding = new Padding(8)
        };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        AddStatusRow(panel, 0, "客户端", _connectionLabel);
        AddStatusRow(panel, 1, "当前歌曲", _trackLabel);
        AddStatusRow(panel, 2, "稳定 ID", _identityLabel);
        AddStatusRow(panel, 3, "播放状态", _playbackLabel);
        AddStatusRow(panel, 4, "歌单验证", _queueLabel);
        AddStatusRow(panel, 5, "私有 IPC", _endpointLabel);
        AddStatusRow(panel, 6, "原生画像", _nativeProfileLabel);
        return panel;
    }

    private Control BuildControlPanel()
    {
        var panel = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            Padding = new Padding(5)
        };

        ConfigureButton(
            _previousButton,
            "上一首",
            async () => await SendPlaybackControlAsync(
                QQMusicPlaybackControl.Previous));
        ConfigureButton(
            _playPauseButton,
            "播放/暂停",
            TogglePlaybackAsync);
        ConfigureButton(
            _nextButton,
            "下一首",
            async () => await SendPlaybackControlAsync(
                QQMusicPlaybackControl.Next));
        ConfigureButton(
            _prepareQueueButton,
            "以前两条结果建立双曲测试队列",
            PrepareTwoSongQueueAsync);
        ConfigureButton(
            _analyzeNativeNextButton,
            "只读分析当前版本",
            AnalyzeNativeNextAsync);
        _previousButton.Enabled = false;
        _prepareQueueButton.Enabled = false;

        panel.Controls.Add(_previousButton);
        panel.Controls.Add(_playPauseButton);
        panel.Controls.Add(_nextButton);
        panel.Controls.Add(_prepareQueueButton);
        panel.Controls.Add(_analyzeNativeNextButton);
        panel.Controls.Add(new Label
        {
            Text = "已恢复播放/暂停和下一首；上一首仍停用。"
                + "单曲歌单、VIP 短试听或自然结束时只记录观察结果，"
                + "不会因歌曲未变化或快速跳过而直接判定控制失败。",
            AutoSize = true,
            ForeColor = Color.DarkOrange,
            Margin = new Padding(10, 8, 3, 3)
        });
        return panel;
    }

    private Control BuildSearchPanel()
    {
        var panel = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            Padding = new Padding(5)
        };
        _searchTextBox.Width = 430;
        _searchTextBox.PlaceholderText = "输入歌曲名或“歌手 歌名”";
        _searchTextBox.KeyDown += async (_, eventArgs) =>
        {
            if (eventArgs.KeyCode != Keys.Enter)
            {
                return;
            }

            eventArgs.SuppressKeyPress = true;
            await SearchAsync();
        };

        ConfigureButton(_searchButton, "搜索", SearchAsync);
        ConfigureButton(
            _playSelectedButton,
            "立即播放选中歌曲",
            PlaySelectedAsync);
        ConfigureButton(
            _setNextButton,
            "设为下一首播放（原生插入）",
            SetSelectedAsNextAsync);

        panel.Controls.Add(_searchTextBox);
        panel.Controls.Add(_searchButton);
        panel.Controls.Add(_playSelectedButton);
        panel.Controls.Add(_setNextButton);
        return panel;
    }

    private Control BuildResultsGrid()
    {
        _resultsGrid.Dock = DockStyle.Fill;
        _resultsGrid.ReadOnly = true;
        _resultsGrid.AllowUserToAddRows = false;
        _resultsGrid.AllowUserToDeleteRows = false;
        _resultsGrid.MultiSelect = false;
        _resultsGrid.SelectionMode =
            DataGridViewSelectionMode.FullRowSelect;
        _resultsGrid.AutoGenerateColumns = false;
        _resultsGrid.DataSource = _searchResults;

        AddTextColumn("歌曲", nameof(QQMusicCatalogSong.Title), 210);
        AddTextColumn("歌手", nameof(QQMusicCatalogSong.Artist), 190);
        AddTextColumn("专辑", nameof(QQMusicCatalogSong.Album), 170);
        AddTextColumn("songid", nameof(QQMusicCatalogSong.SongId), 100);
        AddTextColumn("songmid", nameof(QQMusicCatalogSong.SongMid), 140);
        _resultsGrid.Columns.Add(new DataGridViewCheckBoxColumn
        {
            HeaderText = "可播放",
            DataPropertyName = nameof(QQMusicCatalogSong.IsPlayable),
            Width = 70
        });
        return _resultsGrid;
    }

    private Control BuildLogPanel()
    {
        _logTextBox.Dock = DockStyle.Fill;
        _logTextBox.Multiline = true;
        _logTextBox.ReadOnly = true;
        _logTextBox.ScrollBars = ScrollBars.Vertical;
        _logTextBox.Font = new Font("Consolas", 9F);
        return _logTextBox;
    }

    private static void AddStatusRow(
        TableLayoutPanel panel,
        int row,
        string caption,
        Label value)
    {
        panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        panel.Controls.Add(new Label
        {
            Text = caption,
            AutoSize = true,
            Margin = new Padding(3, 5, 3, 5)
        }, 0, row);
        value.AutoSize = true;
        value.Margin = new Padding(3, 5, 3, 5);
        panel.Controls.Add(value, 1, row);
    }

    private void ConfigureButton(
        Button button,
        string text,
        Func<Task> action)
    {
        button.Text = text;
        button.AutoSize = true;
        button.Margin = new Padding(3, 3, 8, 3);
        button.Click += async (_, _) =>
        {
            try
            {
                await action();
            }
            catch (Exception exception)
            {
                AppendLog(
                    $"操作失败：{exception.GetType().Name}: "
                    + exception.Message);
                SetBusy(false);
            }
        };
    }

    private async Task AnalyzeNativeNextAsync()
    {
        if (_commandBusy)
        {
            return;
        }

        SetBusy(true);
        try
        {
            var analysis = await Task.Run(
                QQMusicNativeNextAnalyzer.AnalyzeCurrent);
            _nativeNextExecutionAllowed =
                analysis.ExecutionAllowed;
            _nativeProfileLabel.Text = analysis.ExecutionAllowed
                ? $"已验证 {analysis.FileVersion} · 可执行原生插入"
                : $"{analysis.FileVersion} · 只读候选，拒绝执行";
            _nativeProfileLabel.ForeColor = analysis.ExecutionAllowed
                ? Color.Green
                : Color.DarkOrange;
            AppendLog($"原生画像分析：{analysis.Summary}");
            foreach (var check in analysis.Checks.Where(
                         check => check.Required
                             && !check.Passed))
            {
                AppendLog(
                    $"画像门禁未通过：{check.Name} · "
                    + check.Detail);
            }

            if (!analysis.KnownProfileMatched)
            {
                foreach (var candidate in analysis.Candidates.Where(
                             candidate => candidate.Rvas.Count > 0))
                {
                    AppendLog(
                        $"只读候选 {candidate.Name}: "
                        + string.Join(", ", candidate.Rvas));
                }
            }
        }
        catch (Exception exception)
        {
            _nativeNextExecutionAllowed = false;
            _nativeProfileLabel.Text = "分析失败 · 原生插入保持关闭";
            _nativeProfileLabel.ForeColor = Color.Red;
            AppendLog(
                "原生画像只读分析失败："
                + $"{exception.GetType().Name}: "
                + exception.Message);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private void AddTextColumn(
        string header,
        string property,
        int width)
    {
        _resultsGrid.Columns.Add(new DataGridViewTextBoxColumn
        {
            HeaderText = header,
            DataPropertyName = property,
            Width = width
        });
    }

    private void LoadPrivateComponents()
    {
        try
        {
            _ipcSession = new QQMusicIpcSession();
            _endpointLabel.Text = _ipcSession.EndpointHandle == 0
                ? "QQMusic.exe 单实例 IPC · songID 状态端点未连接"
                : "QQMusic.exe 单实例 IPC · "
                    + $"songID HWND {_ipcSession.EndpointHandle}";
            AppendLog(
                "主控制已使用 QQMusic.exe 隐藏单实例 IPC；"
                + "QQMusicApi 仅用于可选 songID 状态读取。");
        }
        catch (Exception exception)
        {
            _endpointLabel.Text =
                $"不可用：{exception.GetType().Name}";
            AppendLog(
                "私有 IPC 初始化失败："
                + $"{exception.GetType().Name}: {exception.Message}");
        }
    }

    private async Task RefreshPlaybackStateAsync()
    {
        if (_monitorBusy)
        {
            return;
        }

        _monitorBusy = true;
        try
        {
            _windowState = QQMusicNativeController.ReadPlaybackState();
            _connectionLabel.Text = _windowState.IsRunning
                ? "已检测到 QQ 音乐"
                : "未检测到 QQ 音乐";
            _trackLabel.Text =
                string.IsNullOrWhiteSpace(_windowState.Title)
                    ? _windowState.WindowTitle ?? "未读取到歌曲"
                    : $"{_windowState.Title} - {_windowState.Artist}";

            if (_ipcSession is null)
            {
                _identityLabel.Text =
                    "私有 songID 不可用 · 使用窗口标题回退";
                UpdateWindowTrackEvents(_windowState);
                return;
            }

            try
            {
                var state = await _ipcSession.ReadAsync();
                _privateState = state;
                _lastPrivateReadError = null;
                _identityLabel.Text = state.HasStableSongId
                    ? $"songid={state.SongId}, type={state.SongType}, "
                        + $"position={state.SongPosition}"
                    : "songID 暂不可用 · 使用窗口标题回退";
                _playbackLabel.Text =
                    $"{DescribePlayStatus(state.PlayStatus)} "
                    + $"(raw={state.PlayStatus})";
                if (state.HasStableSongId)
                {
                    RememberCurrentWindowTrack(
                        state.SongId,
                        state.SongType);
                    UpdateTrackEvents(state);
                    UpdateQueueObservation(state);
                }
                else
                {
                    UpdateWindowTrackEvents(_windowState);
                    UpdateQueueObservationFromWindow();
                }
            }
            catch (Exception exception)
            {
                _privateState = null;
                _identityLabel.Text =
                    "私有 songID 不可用 · 使用窗口标题回退";
                _playbackLabel.Text = "状态 API 断开";
                var error = $"{exception.GetType().Name}: "
                    + exception.Message;
                if (!string.Equals(
                        _lastPrivateReadError,
                        error,
                        StringComparison.Ordinal))
                {
                    AppendLog($"私有状态读取断开：{error}");
                    _lastPrivateReadError = error;
                }

                UpdateWindowTrackEvents(_windowState);
                UpdateQueueObservationFromWindow();
            }
        }
        catch (Exception exception)
        {
            AppendLog(
                $"监测错误：{exception.GetType().Name}: "
                + exception.Message);
        }
        finally
        {
            _monitorBusy = false;
        }
    }

    private void UpdateWindowTrackEvents(QQMusicPlaybackState state)
    {
        if (string.IsNullOrWhiteSpace(state.WindowTitle))
        {
            return;
        }

        var currentIdentity =
            $"title:{state.WindowTitle.Trim()}";
        if (_lastWindowIdentity is null)
        {
            AppendLog($"CurrentSong(fallback): {currentIdentity}");
        }
        else if (!string.Equals(
                     _lastWindowIdentity,
                     currentIdentity,
                     StringComparison.OrdinalIgnoreCase))
        {
            AppendLog(
                $"TrackChanged(title-fallback): "
                + $"{_lastWindowIdentity} -> {currentIdentity}");
        }

        _lastWindowIdentity = currentIdentity;
    }

    private void UpdateTrackEvents(QQMusicPrivatePlaybackState state)
    {
        if (state.HasStableSongId)
        {
            var currentIdentity = state.StableIdentity;
            if (_lastStableIdentity is null)
            {
                AppendLog($"CurrentSong: {currentIdentity}");
            }
            else if (!string.Equals(
                         _lastStableIdentity,
                         currentIdentity,
                         StringComparison.Ordinal))
            {
                AppendLog(
                    $"TrackChanged(id): {_lastStableIdentity} -> "
                    + currentIdentity);
            }

            _lastStableIdentity = currentIdentity;
        }

        if (_lastPlayStatus is not null
            && _lastPlayStatus != state.PlayStatus)
        {
            AppendLog(
                $"PlaybackStateChanged: {_lastPlayStatus} -> "
                + state.PlayStatus);
        }

        _lastPlayStatus = state.PlayStatus;
    }

    private void UpdateQueueObservation(
        QQMusicPrivatePlaybackState state)
    {
        if (UpdateNativeNextObservation(
                new QQMusicSongReference(
                    state.SongId,
                    state.SongType),
                false))
        {
            return;
        }

        if (_expectedTwoSongQueue is null)
        {
            _queueLabel.Text =
                "未知 · 单曲或数量未知时不判定切歌失败";
            return;
        }

        var isExpectedSong = _expectedTwoSongQueue.Any(song =>
            song.SongId == state.SongId
            && song.SongType == state.SongType);
        if (!isExpectedSong && state.HasStableSongId)
        {
            ClearExpectedQueue("检测到队列外歌曲");
            return;
        }

        _queueLabel.Text = _twoSongQueueVerified
            ? "2 首 · 已由精确 ID 往返验证"
            : "请求 2 首 · 等待下一首/上一首精确验证";
    }

    private async Task SearchAsync()
    {
        var query = _searchTextBox.Text.Trim();
        if (query.Length == 0 || _commandBusy)
        {
            return;
        }

        SetBusy(true);
        _searchButton.Text = "搜索中…";
        try
        {
            var results = await _catalog.SearchAsync(query);
            _searchResults.RaiseListChangedEvents = false;
            _searchResults.Clear();
            foreach (var song in results)
            {
                _searchResults.Add(song);
                RememberTrack(song);
            }

            _searchResults.RaiseListChangedEvents = true;
            _searchResults.ResetBindings();
            if (_resultsGrid.Rows.Count > 0)
            {
                _resultsGrid.Rows[0].Selected = true;
            }

            AppendLog($"搜索“{query}”：{results.Count} 条结果");
        }
        catch (Exception exception)
        {
            AppendLog(
                $"搜索失败：{exception.GetType().Name}: "
                + exception.Message);
        }
        finally
        {
            _searchButton.Text = "搜索";
            SetBusy(false);
        }
    }

    private async Task PlaySelectedAsync()
    {
        var song = GetSelectedSong();
        if (song is null || _commandBusy)
        {
            return;
        }

        if (!_nativeNextExecutionAllowed)
        {
            AppendLog(
                "当前版本尚未通过原生画像门禁；请先执行只读分析。");
            return;
        }

        if (!song.IsPlayable)
        {
            AppendLog("选中结果被目录接口标记为不可播放。");
            return;
        }

        SetBusy(true);
        try
        {
            var result =
                await QQMusicSingleInstanceTransport.SendSongAsync(
                    song.SongId,
                    song.SongType,
                    song.Title,
                    song.Artist,
                    TimeSpan.FromSeconds(8));
            AppendLog(
                $"点歌 {song.Title} / {song.Artist}: "
                + $"{result.Verification}, "
                + $"foregroundUnchanged={result.ForegroundUnchanged}, "
                + $"{result.ElapsedMilliseconds}ms");
            AppendTransportError(result.Error);
            if (result.Sent)
            {
                RememberTrack(song);
                ClearPendingNativeNext("指定播放会改变当前队列位置");
                ClearExpectedQueue("指定播放会改变原队列");
            }

            await RefreshPlaybackStateAsync();
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task SetSelectedAsNextAsync()
    {
        var song = GetSelectedSong();
        if (song is null || _commandBusy)
        {
            return;
        }

        if (!song.IsPlayable)
        {
            AppendLog("选中结果被目录接口标记为不可播放。");
            return;
        }

        var current = TryGetCurrentSongReference();
        if (current?.SongId == song.SongId
            && current.SongType == song.SongType)
        {
            AppendLog(
                "选中的就是当前歌曲；未重复插入，以免把重播误认为"
                + "“下一首播放”。");
            return;
        }

        var beforePrivate = _privateState;
        SetBusy(true);
        try
        {
            var requestedSong = new QQMusicSongReference(
                song.SongId,
                song.SongType);
            var result =
                await QQMusicNativeNextTransport.InsertAsync(
                    requestedSong,
                    TimeSpan.FromSeconds(6));
            await RefreshPlaybackStateAsync();

            var privateTrackWasObservable =
                beforePrivate?.HasStableSongId == true
                && _privateState?.HasStableSongId == true;
            var privateTrackUnchanged =
                privateTrackWasObservable
                && beforePrivate!.SongId == _privateState!.SongId
                && beforePrivate.SongType == _privateState.SongType;
            var windowTrackWasObservable =
                !string.IsNullOrWhiteSpace(
                    result.Before.WindowTitle);
            var currentTrackUnchanged =
                privateTrackUnchanged
                || result.CurrentWindowTrackUnchanged;
            var noObservedInterruption =
                (!privateTrackWasObservable
                    && !windowTrackWasObservable)
                || currentTrackUnchanged;
            var requestAccepted =
                result.Verification
                    == "NativeNextInsertedCurrentTrackUnchangedPendingNextVerification"
                && result.NativeStage == 5
                && result.GetCatManagerHresult >= 0
                && result.GetSongInfoHresult >= 0
                && result.ResolvedSongId == requestedSong.SongId
                && noObservedInterruption;

            if (requestAccepted)
            {
                ClearExpectedQueue(
                    "已切换为原生“下一首播放”验证");
                ClearPendingNativeNext("替换上一条下一首请求");
                RememberTrack(song);
                _pendingNativeNext = new PendingNativeNext(
                    requestedSong,
                    current,
                    song.Title,
                    song.Artist,
                    DateTimeOffset.Now);
                _nativeNextVerified = false;
                _queueLabel.Text =
                    $"待验证下一首：{song.Title} / {song.Artist}";
                AppendLog(
                    $"已提交原生“下一首播放”：{song.Title} / "
                    + $"{song.Artist}；当前歌曲"
                    + (currentTrackUnchanged
                        ? "已确认未变化"
                        : "状态暂不可读，未观察到切歌")
                    + $"；内部解析 songID={result.ResolvedSongId}。"
                    + "请在 QQ 音乐里手动点击底栏“下一首”，"
                    + "监测器将只读核对精确目标。");
            }
            else
            {
                ClearPendingNativeNext("底层插入请求未通过安全验证");
                AppendLog(
                    $"原生“下一首播放”未确认："
                    + $"{result.Verification}, "
                    + $"patch={result.PatchApplied}, "
                    + $"restored={result.OriginalCodeRestored}, "
                    + $"stage={result.NativeStage}, "
                    + $"resolvedSongId={result.ResolvedSongId}, "
                    + $"foregroundUnchanged="
                    + result.ForegroundUnchanged);
            }

            AppendTransportError(result.Error);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task PrepareTwoSongQueueAsync()
    {
        if (_searchResults.Count < 2 || _commandBusy)
        {
            AppendLog("请先搜索并确保至少有两条结果。");
            return;
        }

        var first = _searchResults[0];
        var second = _searchResults[1];
        if (MatchesWindowTrack(first))
        {
            (first, second) = (second, first);
        }

        var songs = new[]
        {
            new QQMusicSongReference(first.SongId, first.SongType),
            new QQMusicSongReference(second.SongId, second.SongType)
        };
        SetBusy(true);
        try
        {
            ClearPendingNativeNext(
                "建立双曲测试队列会替换当前播放队列");
            var result =
                await QQMusicSingleInstanceTransport.SendQueueAsync(
                    songs,
                    first.Title,
                    first.Artist,
                    TimeSpan.FromSeconds(8));
            if (result.ExpectedTrackConfirmed
                && result.WindowTrackChanged)
            {
                _expectedTwoSongQueue = songs;
                _twoSongQueueVerified = false;
                RememberTrack(first);
                RememberTrack(second);
                AppendLog(
                    "双曲队列首曲已发生真实标题切换；"
                    + "已确认请求包含 2 首，现在可点击下一首"
                    + "精确验证第二首。");
            }
            else
            {
                ClearExpectedQueue("没有观察到真实首曲标题切换");
                AppendLog(
                    "双曲队列未确认：目标首曲未出现或发送前后相同，"
                    + "未进入切歌自动判定。");
            }

            AppendTransportError(result.Error);
            await RefreshPlaybackStateAsync();
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task TogglePlaybackAsync()
    {
        var control = _privateState?.PlayStatus switch
        {
            1 => QQMusicPlaybackControl.Pause,
            0 => QQMusicPlaybackControl.Play,
            _ => _lastBlindPlaybackControl
                == QQMusicPlaybackControl.Pause
                    ? QQMusicPlaybackControl.Play
                    : QQMusicPlaybackControl.Pause
        };
        if (_privateState is null)
        {
            AppendLog(
                $"状态 API 断开，交替发送明确的 {control} 命令。");
        }

        await SendPlaybackControlAsync(control);
    }

    private async Task SendPlaybackControlAsync(
        QQMusicPlaybackControl control)
    {
        if (_commandBusy)
        {
            return;
        }

        QQMusicSongReference? expected = null;
        var current = TryGetCurrentSongReference();
        var nativeNext = control == QQMusicPlaybackControl.Next
            ? _pendingNativeNext
            : null;
        if (nativeNext is not null)
        {
            expected = nativeNext.Target;
        }
        else if (control is QQMusicPlaybackControl.Next
                or QQMusicPlaybackControl.Previous
            && _expectedTwoSongQueue is not null
            && current is not null)
        {
            expected = _expectedTwoSongQueue.FirstOrDefault(song =>
                song.SongId != current.SongId
                || song.SongType != current.SongType);
        }

        SetBusy(true);
        try
        {
            (string Title, string Artist)? expectedMetadata =
                nativeNext is not null
                    ? (nativeNext.Title, nativeNext.Artist)
                    : expected is null
                        ? null
                        : TryGetKnownTrack(expected);
            var result =
                await QQMusicSingleInstanceTransport.SendControlAsync(
                    control,
                    expectedMetadata?.Title,
                    expectedMetadata?.Artist,
                    TimeSpan.FromSeconds(6));

            AppendLog(
                $"{control}: {result.Verification}, "
                + $"foregroundUnchanged={result.ForegroundUnchanged}, "
                + $"{result.ElapsedMilliseconds}ms");
            AppendTransportError(result.Error);
            if (result.Verification
                    == "IndeterminateQueueMayContainOneSong"
                && nativeNext is null
                && expected is null)
            {
                AppendLog(
                    "未判定成功或失败：当前歌单可能只有一首，"
                    + "或歌单数量未知。");
            }

            if (result.Sent
                && control is QQMusicPlaybackControl.Play
                    or QQMusicPlaybackControl.Pause)
            {
                _lastBlindPlaybackControl = control;
            }

            await RefreshPlaybackStateAsync();
            if (nativeNext is not null)
            {
                var exactIdConfirmed =
                    _privateState?.SongId == nativeNext.Target.SongId
                    && _privateState.SongType
                        == nativeNext.Target.SongType;
                var titleConfirmed =
                    result.ExpectedTrackConfirmed
                    || MatchesWindowTrack(
                        nativeNext.Title,
                        nativeNext.Artist);
                if (exactIdConfirmed || titleConfirmed)
                {
                    if (!_nativeNextVerified)
                    {
                        AppendLog(
                            "原生“下一首播放”已命中目标："
                            + $"{nativeNext.Title} / "
                            + nativeNext.Artist);
                    }

                    _nativeNextVerified = true;
                    _queueLabel.Text =
                        $"下一首已验证：{nativeNext.Title} / "
                        + nativeNext.Artist;
                }
                else
                {
                    AppendLog(
                        "本次观察窗口内尚未确认已设置的目标歌曲；"
                        + "可能是单曲歌单、VIP 短试听/自动结束，"
                        + "或播放器仍在加载。继续保留待验证状态，"
                        + "不直接判定控制失败。");
                }
            }
            else if (expected is not null
                && result.ExpectedTrackConfirmed)
            {
                _twoSongQueueVerified = true;
            }
            else if (expected is not null)
            {
                ClearExpectedQueue(
                    "未出现预期的双曲目标 songID");
            }

            if (result.Sent
                && control == QQMusicPlaybackControl.Previous)
            {
                ClearPendingNativeNext(
                    "上一首改变了原生下一首的相对队列位置");
            }
        }
        finally
        {
            SetBusy(false);
        }
    }

    private void RememberTrack(QQMusicCatalogSong song)
    {
        _knownTracks[(song.SongId, song.SongType)] =
            (song.Title, song.Artist);
    }

    private void RememberCurrentWindowTrack(
        long songId,
        int songType)
    {
        if (!string.IsNullOrWhiteSpace(_windowState?.Title))
        {
            _knownTracks[(songId, songType)] =
                (_windowState.Title, _windowState.Artist ?? string.Empty);
        }
    }

    private QQMusicSongReference? TryGetCurrentSongReference()
    {
        if (_privateState?.HasStableSongId == true)
        {
            return new QQMusicSongReference(
                _privateState.SongId,
                _privateState.SongType);
        }

        if (string.IsNullOrWhiteSpace(_windowState?.Title))
        {
            return null;
        }

        foreach (var pair in _knownTracks)
        {
            if (MatchesWindowTrack(
                    pair.Value.Title,
                    pair.Value.Artist))
            {
                return new QQMusicSongReference(
                    pair.Key.SongId,
                    pair.Key.SongType);
            }
        }

        return null;
    }

    private (string Title, string Artist)? TryGetKnownTrack(
        QQMusicSongReference song)
    {
        return _knownTracks.TryGetValue(
            (song.SongId, song.SongType),
            out var track)
                ? track
                : null;
    }

    private bool MatchesWindowTrack(QQMusicCatalogSong song)
    {
        return MatchesWindowTrack(song.Title, song.Artist);
    }

    private bool MatchesWindowTrack(
        string title,
        string? artist)
    {
        return string.Equals(
                   _windowState?.Title?.Trim(),
                   title.Trim(),
                   StringComparison.OrdinalIgnoreCase)
            && (string.IsNullOrWhiteSpace(artist)
                || string.Equals(
                    _windowState?.Artist?.Trim(),
                    artist.Trim(),
                    StringComparison.OrdinalIgnoreCase));
    }

    private void UpdateQueueObservationFromWindow()
    {
        if (UpdateNativeNextObservation(
                TryGetCurrentSongReference(),
                _pendingNativeNext is not null
                    && MatchesWindowTrack(
                        _pendingNativeNext.Title,
                        _pendingNativeNext.Artist)))
        {
            return;
        }

        if (_expectedTwoSongQueue is null)
        {
            _queueLabel.Text =
                "未知 · 单曲或数量未知时不判定切歌失败";
            return;
        }

        var current = TryGetCurrentSongReference();
        if (current is not null
            && !_expectedTwoSongQueue.Any(song =>
                song.SongId == current.SongId
                && song.SongType == current.SongType))
        {
            ClearExpectedQueue("窗口标题对应到队列外歌曲");
            return;
        }

        _queueLabel.Text = _twoSongQueueVerified
            ? "2 首 · 已由预期歌曲标题往返验证"
            : "请求 2 首 · 等待下一首/上一首验证";
    }

    private bool UpdateNativeNextObservation(
        QQMusicSongReference? current,
        bool titleMatchesTarget)
    {
        var pending = _pendingNativeNext;
        if (pending is null)
        {
            return false;
        }

        var exactTarget =
            current?.SongId == pending.Target.SongId
            && current.SongType == pending.Target.SongType;
        if (exactTarget || titleMatchesTarget)
        {
            if (!_nativeNextVerified)
            {
                AppendLog(
                    "TrackChanged(native-next): 命中 "
                    + $"{pending.Target.SongId}:"
                    + $"{pending.Target.SongType} "
                    + $"({pending.Title} / {pending.Artist})");
            }

            _nativeNextVerified = true;
            _queueLabel.Text =
                $"下一首已验证：{pending.Title} / "
                + pending.Artist;
            return true;
        }

        var originalStillPlaying =
            pending.OriginalCurrent is null
            || current is null
            || (current.SongId
                    == pending.OriginalCurrent.SongId
                && current.SongType
                    == pending.OriginalCurrent.SongType);
        if (_nativeNextVerified)
        {
            ClearPendingNativeNext(
                "已经离开已验证的目标歌曲");
            return false;
        }

        if (!originalStillPlaying)
        {
            _pendingNativeNextUnexpectedAt ??= DateTimeOffset.Now;
            var observedFor = DateTimeOffset.Now
                - _pendingNativeNextUnexpectedAt.Value;
            if (observedFor < TimeSpan.FromSeconds(10))
            {
                _queueLabel.Text =
                    $"观察到其他歌曲，继续等待目标："
                    + $"{pending.Title} / {pending.Artist}";
                return true;
            }

            ClearPendingNativeNext(
                "连续 10 秒未观察到目标；可能是 VIP 短试听、"
                + "自然切歌或队列已变化，结果保持未确认");
            return false;
        }

        _pendingNativeNextUnexpectedAt = null;
        _queueLabel.Text =
            $"待验证下一首：{pending.Title} / "
            + pending.Artist;
        return true;
    }

    private QQMusicCatalogSong? GetSelectedSong()
    {
        return _resultsGrid.SelectedRows
            .Cast<DataGridViewRow>()
            .Select(row => row.DataBoundItem)
            .OfType<QQMusicCatalogSong>()
            .FirstOrDefault();
    }

    private void ClearExpectedQueue(string reason)
    {
        if (_expectedTwoSongQueue is not null)
        {
            AppendLog($"清除双曲队列验证状态：{reason}");
        }

        _expectedTwoSongQueue = null;
        _twoSongQueueVerified = false;
    }

    private void ClearPendingNativeNext(string reason)
    {
        if (_pendingNativeNext is not null)
        {
            AppendLog($"清除原生下一首验证状态：{reason}");
        }

        _pendingNativeNext = null;
        _nativeNextVerified = false;
        _pendingNativeNextUnexpectedAt = null;
    }

    private void SetBusy(bool busy)
    {
        _commandBusy = busy;
        _searchButton.Enabled = !busy;
        _playSelectedButton.Enabled = !busy;
        _setNextButton.Enabled =
            !busy && _nativeNextExecutionAllowed;
        _prepareQueueButton.Enabled = false;
        _previousButton.Enabled = false;
        _playPauseButton.Enabled = !busy;
        _nextButton.Enabled = !busy;
        _analyzeNativeNextButton.Enabled = !busy;
    }

    private static string DescribePlayStatus(int playStatus)
    {
        return playStatus switch
        {
            0 => "已暂停",
            1 => "正在播放",
            2 => "已停止或加载中",
            _ => "未知"
        };
    }

    private void AppendLog(string message)
    {
        _logTextBox.AppendText(
            $"[{DateTime.Now:HH:mm:ss.fff}] {message}"
            + Environment.NewLine);
    }

    private void AppendTransportError(string? error)
    {
        if (!string.IsNullOrWhiteSpace(error))
        {
            AppendLog($"底层错误：{error}");
        }
    }

    private sealed record PendingNativeNext(
        QQMusicSongReference Target,
        QQMusicSongReference? OriginalCurrent,
        string Title,
        string Artist,
        DateTimeOffset RequestedAt);
}
