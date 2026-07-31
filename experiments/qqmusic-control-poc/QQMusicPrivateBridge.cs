using System.Runtime.InteropServices;

namespace QQMusicControlPoc;

internal sealed class QQMusicPrivateBridge : IDisposable
{
    private const string DefaultDllPath =
        @"F:\Program Files\QQMusic\QQMusicApi.dll";

    public static readonly Guid ClsidApiServer =
        new("F7FA930C-3B4E-4796-B672-E019FE6B4EFE");

    public static readonly Guid ClsidApiAlias =
        new("F425F108-7880-47E9-AEA4-F1CA079AC319");

    private static readonly Guid IidApiServer =
        new("857CC703-EFB4-4143-8731-9F34881A16E8");

    private static readonly Guid IidClassFactory =
        new("00000001-0000-0000-C000-000000000046");

    private readonly nint _library;
    private IClassFactory? _factory;
    private IApiServer? _server;
    private bool _initialized;

    private QQMusicPrivateBridge(
        nint library,
        IClassFactory factory,
        IApiServer server)
    {
        _library = library;
        _factory = factory;
        _server = server;
    }

    public static QQMusicPrivateBridge Open(
        string? dllPath = null,
        Guid? classId = null)
    {
        var resolvedPath = string.IsNullOrWhiteSpace(dllPath)
            ? DefaultDllPath
            : Path.GetFullPath(dllPath);
        if (!File.Exists(resolvedPath))
        {
            throw new FileNotFoundException(
                "没有找到 QQMusicApi.dll。",
                resolvedPath);
        }

        var library = NativeLibrary.Load(resolvedPath);
        try
        {
            var export = NativeLibrary.GetExport(
                library,
                "DllGetClassObject");
            var getClassObject =
                Marshal.GetDelegateForFunctionPointer<
                    DllGetClassObjectDelegate>(export);

            var requestedClassId = classId ?? ClsidApiServer;
            var factoryId = IidClassFactory;
            var result = getClassObject(
                ref requestedClassId,
                ref factoryId,
                out var factoryPointer);
            Marshal.ThrowExceptionForHR(result);

            IClassFactory factory;
            try
            {
                factory = (IClassFactory)Marshal.GetObjectForIUnknown(
                    factoryPointer);
            }
            finally
            {
                Marshal.Release(factoryPointer);
            }

            var interfaceId = IidApiServer;
            result = factory.CreateInstance(
                0,
                ref interfaceId,
                out var serverPointer);
            Marshal.ThrowExceptionForHR(result);

            IApiServer server;
            try
            {
                server = (IApiServer)Marshal.GetObjectForIUnknown(
                    serverPointer);
            }
            finally
            {
                Marshal.Release(serverPointer);
            }

            return new QQMusicPrivateBridge(library, factory, server);
        }
        catch
        {
            NativeLibrary.Free(library);
            throw;
        }
    }

    public long FindPrivateEndpoint()
    {
        ThrowIfDisposed();
        var reported = _server!.FindQMApiComWnd();
        if (reported != 0)
        {
            return reported;
        }

        return QQMusicNativeController
            .InspectWindows()
            .FirstOrDefault(window =>
                window.ClassName.Equals(
                    "csQQMusicComApiWnd2017",
                    StringComparison.OrdinalIgnoreCase))
            ?.Handle
            ?? 0;
    }

    public long FindReportedEndpoint()
    {
        ThrowIfDisposed();
        return _server!.FindQMApiComWnd();
    }

    public void Initialize()
    {
        ThrowIfDisposed();
        if (_initialized)
        {
            return;
        }

        _server!.Init();
        _initialized = true;
    }

    public void ForwardCommandLine(string commandLine)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(commandLine);
        Initialize();
        _server!.RollbackCmdLine(commandLine);
    }

    public IReadOnlyList<long> ReadInterfaceVtable()
    {
        ThrowIfDisposed();
        var unknown = Marshal.GetIUnknownForObject(_server!);
        nint interfacePointer = 0;
        try
        {
            var interfaceId = IidApiServer;
            Marshal.ThrowExceptionForHR(
                Marshal.QueryInterface(
                    unknown,
                    ref interfaceId,
                    out interfacePointer));
            var vtable = Marshal.ReadIntPtr(interfacePointer);
            var methods = new List<long>();
            for (var index = 0; index < 11; index++)
            {
                methods.Add(
                    Marshal.ReadIntPtr(
                        vtable,
                        index * IntPtr.Size));
            }

            return methods;
        }
        finally
        {
            if (interfacePointer != 0)
            {
                Marshal.Release(interfacePointer);
            }

            Marshal.Release(unknown);
        }
    }

    public void Dispose()
    {
        var server = Interlocked.Exchange(ref _server, null);
        if (server is not null && Marshal.IsComObject(server))
        {
            if (_initialized)
            {
                server.UnInit();
            }

            Marshal.FinalReleaseComObject(server);
        }

        var factory = Interlocked.Exchange(ref _factory, null);
        if (factory is not null && Marshal.IsComObject(factory))
        {
            Marshal.FinalReleaseComObject(factory);
        }

        if (_library != 0)
        {
            NativeLibrary.Free(_library);
        }

        GC.SuppressFinalize(this);
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_server is null, this);
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int DllGetClassObjectDelegate(
        ref Guid rclsid,
        ref Guid riid,
        out nint ppv);

    [ComImport]
    [Guid("00000001-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IClassFactory
    {
        [PreserveSig]
        int CreateInstance(
            nint outer,
            ref Guid riid,
            out nint instance);

        [PreserveSig]
        int LockServer(
            [MarshalAs(UnmanagedType.Bool)] bool lockServer);
    }

    [ComImport]
    [Guid("857CC703-EFB4-4143-8731-9F34881A16E8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApiServer
    {
        uint FindQMApiComWnd();

        void Init();

        void UnInit();

        void ChangeLoginInfo(
            ulong qqUin,
            [MarshalAs(UnmanagedType.BStr)] string newKey);

        void RollbackCmdLine(
            [MarshalAs(UnmanagedType.BStr)] string commandLine);

        void DestroyQMApiComWnd();

        void SetPlaySongInfo(
            [MarshalAs(UnmanagedType.BStr)] string name);

        void TransferData(ref int data);
    }
}
