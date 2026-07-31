using System.Runtime.InteropServices;

namespace QQMusicControlPoc;

internal sealed class QQMusicApiClient : IDisposable
{
    private const string DefaultDllPath = @"F:\Program Files\QQMusic\QQMusicApi.dll";

    private static readonly Guid ClsidQmApiCli =
        new("05CB0B5A-57FA-4067-B405-E1ACCA3035DF");

    private static readonly Guid IidIClassFactory =
        new("00000001-0000-0000-C000-000000000046");

    private static readonly Guid IidQmApiCli =
        new("EEBC7E3F-B437-42A7-9C16-6978660A2E5C");

    private readonly nint _library;
    private IClassFactory? _factory;
    private IQmApiCli? _client;

    private QQMusicApiClient(
        nint library,
        IClassFactory factory,
        IQmApiCli client)
    {
        _library = library;
        _factory = factory;
        _client = client;
    }

    public static QQMusicApiClient Open(string? dllPath = null)
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
            var export = NativeLibrary.GetExport(library, "DllGetClassObject");
            var getClassObject =
                Marshal.GetDelegateForFunctionPointer<DllGetClassObjectDelegate>(
                    export);

            nint factoryPointer = 0;
            var classId = ClsidQmApiCli;
            var factoryId = IidIClassFactory;
            var result = getClassObject(
                ref classId,
                ref factoryId,
                out factoryPointer);
            Marshal.ThrowExceptionForHR(result);
            if (factoryPointer == 0)
            {
                throw new COMException(
                    "QQMusicApi.dll 未返回类工厂。",
                    unchecked((int)0x80004005));
            }

            IClassFactory? factory = null;
            try
            {
                factory = (IClassFactory)Marshal.GetObjectForIUnknown(
                    factoryPointer);
            }
            finally
            {
                Marshal.Release(factoryPointer);
            }

            nint dispatchPointer = 0;
            var dispatchId = IidQmApiCli;
            result = factory.CreateInstance(
                0,
                ref dispatchId,
                out dispatchPointer);
            Marshal.ThrowExceptionForHR(result);
            if (dispatchPointer == 0)
            {
                Marshal.FinalReleaseComObject(factory);
                throw new COMException(
                    "QQMusicApi.dll 未返回客户端对象。",
                    unchecked((int)0x80004005));
            }

            IQmApiCli client;
            try
            {
                client = (IQmApiCli)Marshal.GetObjectForIUnknown(
                    dispatchPointer);
            }
            finally
            {
                Marshal.Release(dispatchPointer);
            }

            return new QQMusicApiClient(library, factory, client);
        }
        catch
        {
            NativeLibrary.Free(library);
            throw;
        }
    }

    public uint GetVersion()
    {
        ThrowIfDisposed();
        return _client!.GetVersion();
    }

    public ulong GetQqUinForConnectionCheck()
    {
        ThrowIfDisposed();
        return _client!.GetQQUin();
    }

    public void WebPerform(string command)
    {
        ThrowIfDisposed();
        _client!.WebPerform(command);
    }

    public string? WebPerform3(string command)
    {
        ThrowIfDisposed();
        return _client!.WebPerform3(command);
    }

    public void Dispose()
    {
        var client = Interlocked.Exchange(ref _client, null);
        if (client is not null && Marshal.IsComObject(client))
        {
            Marshal.FinalReleaseComObject(client);
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
        ObjectDisposedException.ThrowIf(_client is null, this);
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
    [Guid("EEBC7E3F-B437-42A7-9C16-6978660A2E5C")]
    [InterfaceType(ComInterfaceType.InterfaceIsDual)]
    private interface IQmApiCli
    {
        void WebPerform(
            [MarshalAs(UnmanagedType.BStr)] string command);

        ulong GetQQUin();

        void PutShareFriendList(
            [MarshalAs(UnmanagedType.BStr)] string friendList);

        [return: MarshalAs(UnmanagedType.BStr)]
        string GetShareFriendList(
            [MarshalAs(UnmanagedType.BStr)] string key);

        void WebPerform2(
            [MarshalAs(UnmanagedType.BStr)] string command,
            [MarshalAs(UnmanagedType.BStr)] string secondCommand);

        [return: MarshalAs(UnmanagedType.BStr)]
        string GetDldCacheInfo(
            [MarshalAs(UnmanagedType.BStr)] string key);

        [return: MarshalAs(UnmanagedType.BStr)]
        string GetDldConfig();

        [return: MarshalAs(UnmanagedType.BStr)]
        string GetDldFolderInfo();

        [return: MarshalAs(UnmanagedType.BStr)]
        string SelectDldFolder();

        int ConfigureDownload();

        void Drag(
            [MarshalAs(UnmanagedType.BStr)] string information);

        uint GetVersion();

        [return: MarshalAs(UnmanagedType.BStr)]
        string WebPerform3(
            [MarshalAs(UnmanagedType.BStr)] string command);

        void FakeAsyncXmlCmd(
            int identifier,
            [MarshalAs(UnmanagedType.BStr)] string command);
    }
}
