namespace UnifiedPlayerControlPoc;

internal sealed class GuardedNextMonitor : IDisposable
{
    private readonly object _sync = new();
    private CancellationTokenSource? _cancellation;
    private volatile string _status = string.Empty;

    public string Status => _status;

    public bool Arm(
        PlayerTrack? current,
        PlayerTrack target,
        Func<CancellationToken, Task<PlayerTrack?>> readCurrent,
        Func<PlayerTrack, CancellationToken, Task<string>> takeOver,
        CancellationToken lifetimeToken,
        out string message)
    {
        if (current is null || string.IsNullOrWhiteSpace(current.Title))
        {
            message = "当前歌曲不可识别，无法启动下一首守卫。";
            return false;
        }

        var owner =
            CancellationTokenSource.CreateLinkedTokenSource(lifetimeToken);
        CancellationTokenSource? previous;
        lock (_sync)
        {
            previous = _cancellation;
            _cancellation = owner;
            _status = $"下一首守卫待命：{target.DisplayName}";
            _ = MonitorAsync(
                owner,
                current,
                target,
                readCurrent,
                takeOver);
        }

        if (previous is not null)
        {
            previous.Cancel();
            previous.Dispose();
        }

        message =
            $"下一首守卫已启动：若实际下一首不是 {target.DisplayName}，"
            + "将先暂停/停止错误歌曲，再立即播放目标。";
        return true;
    }

    public void Cancel(string status = "")
    {
        CancellationTokenSource? cancellation;
        lock (_sync)
        {
            cancellation = _cancellation;
            _cancellation = null;
            _status = status;
        }

        if (cancellation is not null)
        {
            cancellation.Cancel();
            cancellation.Dispose();
        }
    }

    public void Dispose()
    {
        Cancel();
    }

    private async Task MonitorAsync(
        CancellationTokenSource owner,
        PlayerTrack initial,
        PlayerTrack target,
        Func<CancellationToken, Task<PlayerTrack?>> readCurrent,
        Func<PlayerTrack, CancellationToken, Task<string>> takeOver)
    {
        var cancellationToken = owner.Token;
        try
        {
            var expiresAt =
                DateTimeOffset.UtcNow + TimeSpan.FromHours(12);
            while (DateTimeOffset.UtcNow < expiresAt)
            {
                await Task.Delay(50, cancellationToken)
                    .ConfigureAwait(false);
                var observed =
                    await readCurrent(cancellationToken)
                        .ConfigureAwait(false);
                if (observed is null || SameTrack(observed, initial))
                {
                    continue;
                }

                if (SameTrack(observed, target))
                {
                    SetStatus(
                        owner,
                        $"下一首已正确命中：{target.DisplayName}");
                    return;
                }

                SetStatus(
                    owner,
                    $"检测到错误下一首：{observed.DisplayName}；正在暂停并接管");
                var result = await takeOver(target, cancellationToken)
                    .ConfigureAwait(false);
                SetStatus(owner, result);
                return;
            }

            SetStatus(owner, "下一首守卫已过期（12 小时未发生切歌）");
        }
        catch (OperationCanceledException)
        {
            // Replaced, cancelled, or the application is closing.
        }
        catch (Exception exception)
        {
            SetStatus(owner, $"下一首守卫异常：{exception.Message}");
        }
        finally
        {
            lock (_sync)
            {
                if (ReferenceEquals(_cancellation, owner))
                {
                    _cancellation = null;
                    owner.Dispose();
                }
            }
        }
    }

    private void SetStatus(
        CancellationTokenSource owner,
        string status)
    {
        lock (_sync)
        {
            if (ReferenceEquals(_cancellation, owner))
            {
                _status = status;
            }
        }
    }

    private static bool SameTrack(PlayerTrack left, PlayerTrack right)
    {
        if (!string.IsNullOrWhiteSpace(left.Id)
            && !string.IsNullOrWhiteSpace(right.Id))
        {
            return string.Equals(
                left.Id,
                right.Id,
                StringComparison.OrdinalIgnoreCase);
        }

        return Normalize(left.Title) == Normalize(right.Title)
            && (string.IsNullOrWhiteSpace(left.Artist)
                || string.IsNullOrWhiteSpace(right.Artist)
                || Normalize(left.Artist) == Normalize(right.Artist));
    }

    private static string Normalize(string value)
    {
        return value.Trim().ToUpperInvariant();
    }
}
