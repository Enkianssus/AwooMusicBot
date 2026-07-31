namespace UnifiedPlayerControlPoc;

internal enum PlayerCommand
{
    Previous,
    Pause,
    Resume,
    Toggle,
    Next,
    PlaySelected,
    InsertNext
}

internal enum OperationOutcome
{
    Unsupported,
    Rejected,
    Accepted,
    Applied,
    Verified,
    Indeterminate
}

internal sealed record PlayerCapabilities(
    bool Search,
    bool PlaySelected,
    bool Previous,
    bool Pause,
    bool Resume,
    bool Toggle,
    bool Next,
    bool InsertNext,
    string InsertNextLevel);

internal sealed record PlayerTrack(
    string Id,
    string Title,
    string Artist,
    string Album,
    string NativeData = "")
{
    public string DisplayName =>
        string.IsNullOrWhiteSpace(Artist) ? Title : $"{Title} - {Artist}";
}

internal sealed record PlayerSnapshot(
    bool Connected,
    string Player,
    int? ProcessId,
    string Version,
    string Status,
    PlayerTrack? Current,
    DateTimeOffset ObservedAt);

internal sealed record PlayerOperationResult(
    OperationOutcome Outcome,
    string Message,
    PlayerSnapshot? Snapshot = null)
{
    public bool IsSuccess =>
        Outcome is OperationOutcome.Accepted
            or OperationOutcome.Applied
            or OperationOutcome.Verified;
}

internal interface IPlayerAdapter : IAsyncDisposable
{
    string Key { get; }

    string DisplayName { get; }

    string TestedVersion { get; }

    PlayerCapabilities Capabilities { get; }

    Task<PlayerSnapshot> ProbeAsync(CancellationToken cancellationToken);

    Task<IReadOnlyList<PlayerTrack>> SearchAsync(
        string query,
        CancellationToken cancellationToken);

    Task<PlayerOperationResult> ExecuteAsync(
        PlayerCommand command,
        PlayerTrack? track,
        CancellationToken cancellationToken);
}
