# Unified Player Control POC — connector protocol acceptance workbench

This project is a Windows Forms acceptance client for the three independent
player connectors.  It exercises the newline-delimited JSON (NDJSON) protocol
over each connector process's standard input and output.  Player control code,
native vendor probes, and player DLLs are not compiled into this workbench.
The older experimental sources remain in this directory as historical
references only.

The default entry point opens the GUI.  `--smoke-test` is a non-UI protocol
check that creates the NetEase, KuGou, and QQ Music process adapters in order,
probes each one, prints `connected`, `version`, and `status`, and returns a
non-zero exit code if any adapter or disposal fails.

## Build

Build the connectors independently before building the workbench.  This keeps
connector compatibility fixes isolated from the acceptance client:

```powershell
dotnet build .\BiliNCM-Connectors\src\Netease\BiliNCM.Connector.Netease.csproj -c Release
dotnet build .\BiliNCM-Connectors\src\Kugou\BiliNCM.Connector.Kugou.csproj -c Release
dotnet build .\BiliNCM-Connectors\src\QQMusic\BiliNCM.Connector.QQMusic.csproj -c Release
dotnet build .\experiments\unified-player-control-poc\UnifiedPlayerControlPoc.csproj -c Release
```

The workbench targets `net8.0-windows10.0.19041.0` with WinForms and uses an
`AnyCPU` host.  A connector may be x86 or x64; the host only starts it as a
child process and does not load its native dependencies.

Run the GUI with:

```powershell
dotnet run --project .\experiments\unified-player-control-poc\UnifiedPlayerControlPoc.csproj
```

Run the no-UI smoke check with:

```powershell
dotnet run --project .\experiments\unified-player-control-poc\UnifiedPlayerControlPoc.csproj -- --smoke-test
```

Expected smoke output has one line per connector, for example:

```text
netease: connected=False version=... status=...
kugou: connected=False version=... status=...
qqmusic: connected=False version=... status=...
```

`connected=False` is a valid probe result when the player is not running.  A
missing executable, malformed protocol response, timeout, or disposal error
is reported on stderr and makes the command fail.

## Protocol acceptance surface

Every connector speaks protocol version 1 using one JSON object per line.  The
acceptance sequence is:

1. `ping` negotiates the connector id, version, capabilities, and optional
   features.
2. `probe` obtains the current snapshot and remains the compatibility fallback.
3. `search` returns connector-native `PlayerTrack` data, including the opaque
   native payload needed by `PlaySelected` or `InsertNext`.
4. `execute` sends a player command and returns an explicit outcome such as
   `Accepted`, `Applied`, `Verified`, `Indeterminate`, `Rejected`, or
   `Unsupported`.
5. `shutdown` asks the child process to exit cleanly.

Connectors that advertise `snapshot-events-v1` accept `subscribe` and emit
`event`/`snapshot` envelopes.  The host consumes exact event snapshots while
the subscription is healthy and falls back to `probe` when a connector does
not advertise the feature, the stream closes, or the event source restarts.
Event snapshots include `Next` and `NextSource` when the connector can identify
the pending/next track; an empty value means that no reliable next-track
identity is available.

## Player-specific checks

### NetEase Cloud Music

Verify that `ping` reports the connector capabilities, then check `probe`,
search, `PlaySelected`, `Toggle`, `Previous`, `Next`, and `InsertNext`.  If
`snapshot-events-v1` is advertised, subscribe before changing tracks and check
that the UI receives an event without requiring a tight status loop.  Stop the
player and confirm that the host reports a disconnected snapshot rather than
crashing.

### KuGou Music

Search uses two HTTPS paths: the mobile catalog endpoint first and the signed
`gateway.kugou.com` mixed-search compatibility path second.  Plain HTTP search
is disabled by default.  It is only permitted after an explicit opt-in:

```powershell
$env:BILINCM_KUGOU_ALLOW_HTTP_SEARCH_FALLBACK = "1"
dotnet run --project .\experiments\unified-player-control-poc\UnifiedPlayerControlPoc.csproj
```

Player control remains local KuGou IPC; the search opt-in does not authorize a
remote control path.  Verify the status text identifies the HTTPS path or the
explicit HTTP fallback.

`InsertNext` means “insert this selected track after the current item.”
`ArmNextGuard` is a separate, idempotent guard operation for a target that is
already pending; it must not insert a second queue row.  Exercise both a normal
insert and a wrong-song transition, and check that the result is bounded and
reported as `Accepted`, `Verified`, or `Indeterminate` rather than silently
duplicating the track.  `Next` is the direct next-track command.  The
`NextSource` snapshot field records where the connector obtained next-track
metadata (or is empty when no reliable source exists).

### QQ Music

The connector uses exact, versioned compatibility profiles for QQ Music 22.22
and 22.41.  A build, architecture, or DLL hash outside a tested profile must be
rejected safely; it must not fall through to an unverified native operation.
Verify this by probing an unsupported installation (or a deliberately mismatched
profile fixture) and checking for a clear `Rejected`/unsupported status.  Keep
the normal `InsertNext` and guarded-next checks separate from any profile-gated
native capability.

## Manual acceptance checklist

1. Build all three connectors and this project.
2. Set connector paths (see below), start one supported player, and run the
   smoke test.  Confirm that all three lines are present and that failures are
   non-zero.
3. Open the GUI, select each connector, and press **连接 / 刷新**. Check
   process id, version, connection state, and capability text.
4. Check the log: the UI automatically sends `ping` and `subscribe`. Verify an
   initial `snapshot-events-v1` snapshot plus another snapshot after a title or
   queue change. Test an older connector without the feature to verify the
   one-second `probe` fallback.
5. Search for a known song, play the selected result, and verify the reported
   operation outcome and current-track identity.
6. Exercise `Toggle`, `Previous`, and `Next`; confirm that the host remains
   responsive when the player is closed or refuses a command.
7. Exercise `InsertNext`, then `ArmNextGuard` for an already pending target.
   Confirm that the queue is not duplicated and that `Next`/`NextSource` fields
   update when the target is observed.
8. For KuGou, repeat search once with HTTP fallback disabled and once with
   `BILINCM_KUGOU_ALLOW_HTTP_SEARCH_FALLBACK=1`; record which status is shown.
9. For QQ Music, verify that an unknown profile is refused and that no native
   mutation is attempted.
10. Send `shutdown` and confirm that each child connector exits without a
    lingering process.

## Connector path configuration

The process adapter searches the configured connector root and supports a
per-connector executable override.  Use a root containing `netease`, `kugou`,
and `qqmusic` connector output directories:

```powershell
$env:BILINCM_CONNECTOR_ROOT = "C:\path\to\connector-root"
```

For a precise executable path, set one or more overrides (the value is the
complete path to the `.exe`):

```powershell
$env:BILINCM_CONNECTOR_NETEASE_PATH = "C:\path\to\BiliNCM.Connector.Netease.exe"
$env:BILINCM_CONNECTOR_KUGOU_PATH = "C:\path\to\BiliNCM.Connector.Kugou.exe"
$env:BILINCM_CONNECTOR_QQMUSIC_PATH = "C:\path\to\BiliNCM.Connector.QQMusic.exe"
```

The per-connector variables take precedence over `BILINCM_CONNECTOR_ROOT`.
These variables are intentionally external to the project; no installation
drive or player path is hard-coded in the acceptance UI.

## Troubleshooting

- If a smoke line reports an executable error, set the corresponding
  `BILINCM_CONNECTOR_*_PATH` to the published executable and run again.
- If `ping` succeeds but `subscribe` is rejected, continue with `probe`; this
  is the protocol-v1 compatibility path.
- If a connector emits malformed JSON or exits early, preserve its stderr and
  the acceptance log with the operation outcome.  Do not infer success from a
  transport write alone.
- Keep `BILINCM_KUGOU_ALLOW_HTTP_SEARCH_FALLBACK` unset unless the insecure
  compatibility path is an intentional test condition.
