using System.Diagnostics;
using System.Runtime.InteropServices;

namespace UnifiedPlayerControlPoc;

/// <summary>
/// Keeps direct references to QQMusic's current Windows audio sessions so they
/// can be muted without opening the volume mixer after a track change.
/// </summary>
internal sealed class QQMusicAudioMuteScope : IDisposable
{
    private readonly List<AudioSession> _sessions;
    private Guid _eventContext = Guid.NewGuid();
    private bool _muteApplied;
    private bool _disposed;

    private QQMusicAudioMuteScope(
        List<AudioSession> sessions,
        string captureError)
    {
        _sessions = sessions;
        CaptureError = captureError;
    }

    public int CapturedSessionCount => _sessions.Count;

    public string CaptureError { get; }

    public string LastError { get; private set; } = string.Empty;

    public static QQMusicAudioMuteScope Capture()
    {
        var sessions = new List<AudioSession>();
        try
        {
            object deviceEnumeratorObject =
                new MMDeviceEnumeratorComObject();
            var deviceEnumerator =
                (IMMDeviceEnumerator)deviceEnumeratorObject;
            var result = deviceEnumerator.GetDefaultAudioEndpoint(
                EDataFlow.Render,
                ERole.Multimedia,
                out var device);
            Marshal.ThrowExceptionForHR(result);

            var sessionManagerId = typeof(IAudioSessionManager2).GUID;
            result = device.Activate(
                ref sessionManagerId,
                ClsContext.All,
                0,
                out var sessionManagerObject);
            Marshal.ThrowExceptionForHR(result);

            var sessionManager = (IAudioSessionManager2)sessionManagerObject;
            result = sessionManager.GetSessionEnumerator(
                out var sessionEnumerator);
            Marshal.ThrowExceptionForHR(result);
            result = sessionEnumerator.GetCount(out var sessionCount);
            Marshal.ThrowExceptionForHR(result);

            for (var index = 0; index < sessionCount; index++)
            {
                if (sessionEnumerator.GetSession(
                        index,
                        out var sessionControl) < 0
                    || sessionControl is not IAudioSessionControl2 control2
                    || sessionControl is not ISimpleAudioVolume volume
                    || control2.GetProcessId(out var processId) < 0
                    || !IsQqMusicProcess(processId)
                    || volume.GetMute(out var wasMuted) < 0)
                {
                    continue;
                }

                sessions.Add(new AudioSession(
                    sessionControl,
                    volume,
                    wasMuted));
            }

            return new QQMusicAudioMuteScope(sessions, string.Empty);
        }
        catch (Exception exception)
        {
            return new QQMusicAudioMuteScope(
                sessions,
                $"{exception.GetType().Name}: {exception.Message}");
        }
    }

    public bool Mute()
    {
        if (_disposed)
        {
            LastError = "QQ 音频会话静音句柄已经释放。";
            return false;
        }

        if (_muteApplied)
        {
            return _sessions.Count > 0;
        }

        _muteApplied = true;
        var mutedCount = 0;
        var errors = new List<string>();
        foreach (var session in _sessions)
        {
            try
            {
                var result = session.Volume.SetMute(
                    true,
                    ref _eventContext);
                if (result >= 0)
                {
                    mutedCount++;
                }
                else
                {
                    errors.Add($"HRESULT=0x{result:X8}");
                }
            }
            catch (Exception exception)
            {
                errors.Add(exception.Message);
            }
        }

        LastError = errors.Count == 0
            ? string.Empty
            : string.Join("; ", errors);
        return mutedCount > 0;
    }

    public void Restore()
    {
        if (_disposed || !_muteApplied)
        {
            return;
        }

        var errors = new List<string>();
        foreach (var session in _sessions)
        {
            try
            {
                var result = session.Volume.SetMute(
                    session.WasMuted,
                    ref _eventContext);
                if (result < 0)
                {
                    errors.Add($"HRESULT=0x{result:X8}");
                }
            }
            catch (Exception exception)
            {
                errors.Add(exception.Message);
            }
        }

        _muteApplied = false;
        if (errors.Count > 0)
        {
            LastError = string.Join("; ", errors);
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        Restore();
        _disposed = true;
    }

    private static bool IsQqMusicProcess(uint processId)
    {
        if (processId == 0 || processId > int.MaxValue)
        {
            return false;
        }

        try
        {
            using var process =
                Process.GetProcessById(checked((int)processId));
            return process.ProcessName.Equals(
                "QQMusic",
                StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private sealed record AudioSession(
        IAudioSessionControl SessionControl,
        ISimpleAudioVolume Volume,
        bool WasMuted);

    private enum EDataFlow
    {
        Render = 0
    }

    private enum ERole
    {
        Multimedia = 1
    }

    [Flags]
    private enum ClsContext : uint
    {
        InprocServer = 0x1,
        InprocHandler = 0x2,
        LocalServer = 0x4,
        RemoteServer = 0x10,
        All = InprocServer | InprocHandler | LocalServer | RemoteServer
    }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private sealed class MMDeviceEnumeratorComObject
    {
    }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig]
        int EnumAudioEndpoints(
            EDataFlow dataFlow,
            uint stateMask,
            out nint devices);

        [PreserveSig]
        int GetDefaultAudioEndpoint(
            EDataFlow dataFlow,
            ERole role,
            out IMMDevice device);

        [PreserveSig]
        int GetDevice(
            [MarshalAs(UnmanagedType.LPWStr)] string id,
            out IMMDevice device);

        [PreserveSig]
        int RegisterEndpointNotificationCallback(nint client);

        [PreserveSig]
        int UnregisterEndpointNotificationCallback(nint client);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig]
        int Activate(
            ref Guid interfaceId,
            ClsContext classContext,
            nint activationParameters,
            [MarshalAs(UnmanagedType.IUnknown)] out object interfaceObject);

        [PreserveSig]
        int OpenPropertyStore(uint access, out nint properties);

        [PreserveSig]
        int GetId(
            [MarshalAs(UnmanagedType.LPWStr)] out string id);

        [PreserveSig]
        int GetState(out uint state);
    }

    [ComImport]
    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2
    {
        [PreserveSig]
        int GetAudioSessionControl(
            ref Guid sessionId,
            uint streamFlags,
            out IAudioSessionControl sessionControl);

        [PreserveSig]
        int GetSimpleAudioVolume(
            ref Guid sessionId,
            uint streamFlags,
            out ISimpleAudioVolume volume);

        [PreserveSig]
        int GetSessionEnumerator(
            out IAudioSessionEnumerator sessionEnumerator);

        [PreserveSig]
        int RegisterSessionNotification(nint notification);

        [PreserveSig]
        int UnregisterSessionNotification(nint notification);

        [PreserveSig]
        int RegisterDuckNotification(
            [MarshalAs(UnmanagedType.LPWStr)] string sessionId,
            nint notification);

        [PreserveSig]
        int UnregisterDuckNotification(nint notification);
    }

    [ComImport]
    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator
    {
        [PreserveSig]
        int GetCount(out int sessionCount);

        [PreserveSig]
        int GetSession(
            int sessionIndex,
            out IAudioSessionControl sessionControl);
    }

    [ComImport]
    [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl
    {
        [PreserveSig]
        int GetState(out int state);

        [PreserveSig]
        int GetDisplayName(
            [MarshalAs(UnmanagedType.LPWStr)] out string displayName);

        [PreserveSig]
        int SetDisplayName(
            [MarshalAs(UnmanagedType.LPWStr)] string displayName,
            ref Guid eventContext);

        [PreserveSig]
        int GetIconPath(
            [MarshalAs(UnmanagedType.LPWStr)] out string iconPath);

        [PreserveSig]
        int SetIconPath(
            [MarshalAs(UnmanagedType.LPWStr)] string iconPath,
            ref Guid eventContext);

        [PreserveSig]
        int GetGroupingParam(out Guid groupingId);

        [PreserveSig]
        int SetGroupingParam(
            ref Guid groupingId,
            ref Guid eventContext);

        [PreserveSig]
        int RegisterAudioSessionNotification(nint client);

        [PreserveSig]
        int UnregisterAudioSessionNotification(nint client);
    }

    [ComImport]
    [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2
    {
        [PreserveSig]
        int GetState(out int state);

        [PreserveSig]
        int GetDisplayName(
            [MarshalAs(UnmanagedType.LPWStr)] out string displayName);

        [PreserveSig]
        int SetDisplayName(
            [MarshalAs(UnmanagedType.LPWStr)] string displayName,
            ref Guid eventContext);

        [PreserveSig]
        int GetIconPath(
            [MarshalAs(UnmanagedType.LPWStr)] out string iconPath);

        [PreserveSig]
        int SetIconPath(
            [MarshalAs(UnmanagedType.LPWStr)] string iconPath,
            ref Guid eventContext);

        [PreserveSig]
        int GetGroupingParam(out Guid groupingId);

        [PreserveSig]
        int SetGroupingParam(
            ref Guid groupingId,
            ref Guid eventContext);

        [PreserveSig]
        int RegisterAudioSessionNotification(nint client);

        [PreserveSig]
        int UnregisterAudioSessionNotification(nint client);

        [PreserveSig]
        int GetSessionIdentifier(
            [MarshalAs(UnmanagedType.LPWStr)] out string sessionIdentifier);

        [PreserveSig]
        int GetSessionInstanceIdentifier(
            [MarshalAs(UnmanagedType.LPWStr)]
            out string sessionInstanceIdentifier);

        [PreserveSig]
        int GetProcessId(out uint processId);

        [PreserveSig]
        int IsSystemSoundsSession();

        [PreserveSig]
        int SetDuckingPreference(
            [MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    [ComImport]
    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ISimpleAudioVolume
    {
        [PreserveSig]
        int SetMasterVolume(float volume, ref Guid eventContext);

        [PreserveSig]
        int GetMasterVolume(out float volume);

        [PreserveSig]
        int SetMute(
            [MarshalAs(UnmanagedType.Bool)] bool mute,
            ref Guid eventContext);

        [PreserveSig]
        int GetMute(
            [MarshalAs(UnmanagedType.Bool)] out bool mute);
    }
}
