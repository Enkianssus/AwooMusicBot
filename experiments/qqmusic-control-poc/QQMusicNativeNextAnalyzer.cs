using System.ComponentModel;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace QQMusicControlPoc;

internal sealed record QQMusicNativeNextAnalysisCheck(
    string Name,
    bool Required,
    bool Passed,
    string Detail);

internal sealed record QQMusicNativeNextCandidate(
    string Name,
    IReadOnlyList<string> Rvas,
    string Evidence);

internal sealed record QQMusicNativeNextAnalysis(
    DateTimeOffset AnalyzedAt,
    int? ProcessId,
    string ExecutablePath,
    string ClientModulePath,
    string CommonModulePath,
    string FileVersion,
    string ClientSha256,
    string CommonSha256,
    string Machine,
    bool KnownProfileMatched,
    string? MatchedProfileVersion,
    bool ExecutionAllowed,
    IReadOnlyList<QQMusicNativeNextAnalysisCheck> Checks,
    IReadOnlyList<QQMusicNativeNextCandidate> Candidates,
    string Summary)
{
    [JsonIgnore]
    public QQMusicNativeNextProfile? Profile { get; init; }
}

internal sealed record QQMusicNativeModuleSet(
    int ProcessId,
    string ExecutablePath,
    string ClientModulePath,
    string CommonModulePath,
    long WorkingSet);

/// <summary>
/// Performs read-only PE inspection. Unknown builds can produce candidate
/// anchors, but only an exact known profile with every required structural
/// check passing is allowed to reach the process-writing transport.
/// </summary>
internal static class QQMusicNativeNextAnalyzer
{
    private const ushort ImageFileMachineI386 = 0x014C;

    public static QQMusicNativeNextAnalysis AnalyzeCurrent()
    {
        var modules = FindCurrentModules();
        return AnalyzeFiles(
            modules.ClientModulePath,
            modules.CommonModulePath,
            modules.ExecutablePath,
            modules.ProcessId);
    }

    public static QQMusicNativeNextAnalysis AnalyzeFiles(
        string clientModulePath,
        string commonModulePath,
        string executablePath,
        int? processId = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(clientModulePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(commonModulePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(executablePath);

        var clientFullPath = Path.GetFullPath(clientModulePath);
        var commonFullPath = Path.GetFullPath(commonModulePath);
        var executableFullPath = Path.GetFullPath(executablePath);
        var clientSha256 = ComputeSha256(clientFullPath);
        var commonSha256 = ComputeSha256(commonFullPath);
        var fileVersion = FileVersionInfo
            .GetVersionInfo(clientFullPath)
            .FileVersion
            ?? string.Empty;
        var client = PortableExecutableImage.Load(clientFullPath);
        var common = PortableExecutableImage.Load(commonFullPath);
        var profile = QQMusicNativeNextProfiles.Find(
            fileVersion,
            clientSha256,
            commonSha256);
        var checks = BuildChecks(
            client,
            common,
            executableFullPath,
            clientFullPath,
            commonFullPath,
            fileVersion,
            clientSha256,
            commonSha256,
            profile);
        var requiredChecksPassed = checks
            .Where(check => check.Required)
            .All(check => check.Passed);
        var candidates = BuildCandidates(client, common, profile);
        var executionAllowed =
            profile is not null && requiredChecksPassed;
        var summary = executionAllowed
            ? $"已匹配并完整验证 QQ 音乐 {profile!.FileVersion} 画像；"
                + "允许原生下一首执行。"
            : profile is null
                ? $"QQ 音乐 {fileVersion} 没有经过校准的画像；"
                    + "只生成候选地址，拒绝修改播放器进程。"
                : $"QQ 音乐 {profile.FileVersion} 画像存在，"
                    + "但至少一项强制校验失败；拒绝修改播放器进程。";

        return new QQMusicNativeNextAnalysis(
            DateTimeOffset.Now,
            processId,
            executableFullPath,
            clientFullPath,
            commonFullPath,
            fileVersion,
            clientSha256,
            commonSha256,
            $"0x{client.Machine:X4}",
            profile is not null,
            profile?.FileVersion,
            executionAllowed,
            checks,
            candidates,
            summary)
        {
            Profile = profile
        };
    }

    public static QQMusicNativeModuleSet FindCurrentModules()
    {
        var matches = new List<QQMusicNativeModuleSet>();
        foreach (var process in Process.GetProcessesByName("QQMusic"))
        {
            try
            {
                ProcessModule? executable = process.MainModule;
                ProcessModule? client = null;
                ProcessModule? common = null;
                foreach (ProcessModule module in process.Modules)
                {
                    if (module.ModuleName.Equals(
                            "QQMusic.dll",
                            StringComparison.OrdinalIgnoreCase))
                    {
                        client = module;
                    }
                    else if (module.ModuleName.Equals(
                                 "QQMusicCommon.dll",
                                 StringComparison.OrdinalIgnoreCase))
                    {
                        common = module;
                    }
                }

                if (executable is null
                    || client is null
                    || common is null)
                {
                    continue;
                }

                matches.Add(new QQMusicNativeModuleSet(
                    process.Id,
                    executable.FileName,
                    client.FileName,
                    common.FileName,
                    TryGetWorkingSet(process)));
            }
            catch (Exception exception)
                when (exception is Win32Exception
                    or InvalidOperationException
                    or NotSupportedException)
            {
                // Ignore stale helper and protected processes.
            }
            finally
            {
                process.Dispose();
            }
        }

        return matches
            .OrderByDescending(match => match.WorkingSet)
            .FirstOrDefault()
            ?? throw new InvalidOperationException(
                "没有找到同时加载 QQMusic.dll 和 QQMusicCommon.dll "
                + "的 QQ 音乐主进程。");
    }

    private static IReadOnlyList<QQMusicNativeNextAnalysisCheck> BuildChecks(
        PortableExecutableImage client,
        PortableExecutableImage common,
        string executablePath,
        string clientPath,
        string commonPath,
        string fileVersion,
        string clientSha256,
        string commonSha256,
        QQMusicNativeNextProfile? profile)
    {
        var checks = new List<QQMusicNativeNextAnalysisCheck>();
        AddCheck(
            checks,
            "x86-client",
            true,
            client.Machine == ImageFileMachineI386,
            $"QQMusic.dll Machine=0x{client.Machine:X4}");
        AddCheck(
            checks,
            "x86-common",
            true,
            common.Machine == ImageFileMachineI386,
            $"QQMusicCommon.dll Machine=0x{common.Machine:X4}");
        AddCheck(
            checks,
            "module-names",
            true,
            Path.GetFileName(executablePath).Equals(
                    "QQMusic.exe",
                    StringComparison.OrdinalIgnoreCase)
                && Path.GetFileName(clientPath).Equals(
                    "QQMusic.dll",
                    StringComparison.OrdinalIgnoreCase)
                && Path.GetFileName(commonPath).Equals(
                    "QQMusicCommon.dll",
                    StringComparison.OrdinalIgnoreCase),
            "仅接受 QQMusic.exe / QQMusic.dll / QQMusicCommon.dll");
        var executableDirectory = Path.GetDirectoryName(executablePath);
        AddCheck(
            checks,
            "same-install-directory",
            true,
            DirectoryEquals(
                    executableDirectory,
                    Path.GetDirectoryName(clientPath))
                && DirectoryEquals(
                    executableDirectory,
                    Path.GetDirectoryName(commonPath)),
            executableDirectory ?? string.Empty);

        if (profile is null)
        {
            AddCheck(
                checks,
                "known-version-profile",
                true,
                false,
                $"version={fileVersion}, client={clientSha256}, "
                    + $"common={commonSha256}");
            return checks;
        }

        AddCheck(
            checks,
            "known-version-profile",
            true,
            true,
            profile.Evidence);
        AddCheck(
            checks,
            "file-version",
            true,
            string.Equals(
                fileVersion,
                profile.FileVersion,
                StringComparison.Ordinal),
            $"actual={fileVersion}, expected={profile.FileVersion}");
        AddCheck(
            checks,
            "client-sha256",
            true,
            string.Equals(
                clientSha256,
                profile.ClientSha256,
                StringComparison.OrdinalIgnoreCase),
            clientSha256);
        AddCheck(
            checks,
            "common-sha256",
            true,
            string.Equals(
                commonSha256,
                profile.CommonSha256,
                StringComparison.OrdinalIgnoreCase),
            commonSha256);
        AddCheck(
            checks,
            "dispatch-bytes",
            true,
            client.ReadBytes(
                    profile.SingleSongPlayDispatchRva,
                    profile.ExpectedPlayDispatchBytes.Length)
                .SequenceEqual(profile.ExpectedPlayDispatchBytes),
            $"RVA=0x{profile.SingleSongPlayDispatchRva:X8}, "
                + $"expected={FormatBytes(profile.ExpectedPlayDispatchBytes)}");
        AddCheck(
            checks,
            "dispatch-target",
            true,
            client.TryReadRelativeCallTarget(
                    profile.SingleSongPlayDispatchRva,
                    out var dispatchTarget)
                && client.IsExecutableRva(dispatchTarget),
            client.TryReadRelativeCallTarget(
                    profile.SingleSongPlayDispatchRva,
                    out dispatchTarget)
                ? $"RVA=0x{dispatchTarget:X8}"
                : "not a relative call");
        AddExecutableRvaCheck(
            checks,
            client,
            "songitem-constructor",
            profile.SongItemConstructorRva);
        AddExecutableRvaCheck(
            checks,
            client,
            "songitem-destructor",
            profile.SongItemDestructorRva);
        AddExecutableRvaCheck(
            checks,
            client,
            "add-songs",
            profile.AddSongsRva);
        AddExecutableRvaCheck(
            checks,
            client,
            "get-list-root",
            profile.GetListRootRva);
        AddExecutableRvaCheck(
            checks,
            client,
            "get-list-helper",
            profile.GetListHelperRva);
        AddExecutableRvaCheck(
            checks,
            client,
            "get-category-count",
            profile.GetCategoryCountRva);
        AddCheck(
            checks,
            "hidden-category-global",
            true,
            client.IsWritableRva(profile.HiddenCategoryIdRva)
                && !client.IsExecutableRva(
                    profile.HiddenCategoryIdRva),
            $"RVA=0x{profile.HiddenCategoryIdRva:X8}");
        AddCheck(
            checks,
            "common-export-GetICatMgr",
            true,
            common.TryGetExportRva(
                    "GetICatMgr",
                    out var getCatManagerRva)
                && getCatManagerRva
                    == profile.GetCatManagerRva,
            common.TryGetExportRva(
                    "GetICatMgr",
                    out getCatManagerRva)
                ? $"RVA=0x{getCatManagerRva:X8}"
                : "export not found");
        AddCheck(
            checks,
            "common-export-GetQQUinEx",
            true,
            common.TryGetExportRva(
                    "GetQQUinEx",
                    out var getQqUinExRva)
                && getQqUinExRva == profile.GetQqUinExRva,
            common.TryGetExportRva(
                    "GetQQUinEx",
                    out getQqUinExRva)
                ? $"RVA=0x{getQqUinExRva:X8}"
                : "export not found");
        AddCheck(
            checks,
            "songitem-size",
            true,
            profile.SongItemSize == 0xA0,
            $"0x{profile.SongItemSize:X}");
        AddCheck(
            checks,
            "playsong-anchor",
            true,
            client.FindUtf16StringRvas("playsong").Count > 0,
            JoinRvas(client.FindUtf16StringRvas("playsong")));
        AddCheck(
            checks,
            "right-click-menu-anchor",
            false,
            client.FindUtf16StringRvas(
                    "IDS_MENU_ADDNEXTPLAY_ID").Count > 0,
            JoinRvas(
                client.FindUtf16StringRvas(
                    "IDS_MENU_ADDNEXTPLAY_ID")));
        AddCheck(
            checks,
            "add-songs-callers",
            true,
            client.FindRelativeCallSitesTo(
                    profile.AddSongsRva).Count > 0,
            JoinRvas(
                client.FindRelativeCallSitesTo(
                    profile.AddSongsRva)));
        return checks;
    }

    private static IReadOnlyList<QQMusicNativeNextCandidate> BuildCandidates(
        PortableExecutableImage client,
        PortableExecutableImage common,
        QQMusicNativeNextProfile? profile)
    {
        var candidates = new List<QQMusicNativeNextCandidate>();
        AddCandidate(
            candidates,
            "playsong-string",
            client.FindUtf16StringRvas("playsong"),
            "单曲命令解析动作字符串；用于定位异步完成回调。");
        AddCandidate(
            candidates,
            "playsong-xrefs",
            FindStringReferences(client, "playsong"),
            "对 playsong UTF-16 地址的代码引用。");
        AddCandidate(
            candidates,
            "native-next-menu-string",
            client.FindUtf16StringRvas(
                "IDS_MENU_ADDNEXTPLAY_ID"),
            "QQ 音乐右键“下一首播放”菜单资源。");
        AddCandidate(
            candidates,
            "native-next-menu-xrefs",
            FindStringReferences(
                client,
                "IDS_MENU_ADDNEXTPLAY_ID"),
            "原生菜单资源的代码引用；用于定位真实 UI 线程调用。");

        if (common.TryGetExportRva(
                "GetICatMgr",
                out var getCatManagerRva))
        {
            AddCandidate(
                candidates,
                "GetICatMgr-export",
                [getCatManagerRva],
                "稳定的 QQMusicCommon.dll 导出。");
        }

        if (common.TryGetExportRva(
                "GetQQUinEx",
                out var getQqUinExRva))
        {
            AddCandidate(
                candidates,
                "GetQQUinEx-export",
                [getQqUinExRva],
                "稳定的 QQMusicCommon.dll 导出。");
        }

        if (profile is not null)
        {
            AddCandidate(
                candidates,
                "validated-dispatch",
                [profile.SingleSongPlayDispatchRva],
                "画像校验通过的单曲立即播放分发调用。");
            AddCandidate(
                candidates,
                "validated-add-songs",
                [profile.AddSongsRva],
                "画像校验通过的 AddSongs(mode=0) 入口。");
            AddCandidate(
                candidates,
                "validated-hidden-category",
                [profile.HiddenCategoryIdRva],
                "画像校验通过的异步命令临时分类全局字段。");
        }

        return candidates;
    }

    private static IReadOnlyList<int> FindStringReferences(
        PortableExecutableImage image,
        string value)
    {
        return image.FindUtf16StringRvas(value)
            .SelectMany(rva => image.FindAbsoluteReferences(
                checked(image.ImageBase + (uint)rva)))
            .Distinct()
            .Order()
            .ToArray();
    }

    private static void AddExecutableRvaCheck(
        ICollection<QQMusicNativeNextAnalysisCheck> checks,
        PortableExecutableImage image,
        string name,
        int rva)
    {
        AddCheck(
            checks,
            name,
            true,
            image.IsExecutableRva(rva),
            $"RVA=0x{rva:X8}");
    }

    private static void AddCheck(
        ICollection<QQMusicNativeNextAnalysisCheck> checks,
        string name,
        bool required,
        bool passed,
        string detail)
    {
        checks.Add(new QQMusicNativeNextAnalysisCheck(
            name,
            required,
            passed,
            detail));
    }

    private static void AddCandidate(
        ICollection<QQMusicNativeNextCandidate> candidates,
        string name,
        IReadOnlyList<int> rvas,
        string evidence)
    {
        candidates.Add(new QQMusicNativeNextCandidate(
            name,
            rvas.Select(rva => $"0x{rva:X8}").ToArray(),
            evidence));
    }

    private static bool DirectoryEquals(string? left, string? right)
    {
        return !string.IsNullOrWhiteSpace(left)
            && !string.IsNullOrWhiteSpace(right)
            && string.Equals(
                Path.GetFullPath(left).TrimEnd('\\'),
                Path.GetFullPath(right).TrimEnd('\\'),
                StringComparison.OrdinalIgnoreCase);
    }

    private static string ComputeSha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    private static long TryGetWorkingSet(Process process)
    {
        try
        {
            return process.WorkingSet64;
        }
        catch (InvalidOperationException)
        {
            return 0;
        }
    }

    private static string JoinRvas(IReadOnlyList<int> rvas)
    {
        return rvas.Count == 0
            ? "not found"
            : string.Join(
                ", ",
                rvas.Take(12).Select(rva => $"0x{rva:X8}"));
    }

    private static string FormatBytes(IEnumerable<byte> bytes)
    {
        return string.Join(
            ' ',
            bytes.Select(value => value.ToString("X2")));
    }

    private sealed class PortableExecutableImage
    {
        private const uint ImageScnMemExecute = 0x20000000;
        private const uint ImageScnMemWrite = 0x80000000;
        private readonly byte[] _bytes;
        private readonly IReadOnlyList<Section> _sections;
        private readonly int _sizeOfHeaders;
        private readonly int _exportDirectoryRva;

        private PortableExecutableImage(
            byte[] bytes,
            ushort machine,
            uint imageBase,
            int sizeOfHeaders,
            int exportDirectoryRva,
            IReadOnlyList<Section> sections)
        {
            _bytes = bytes;
            Machine = machine;
            ImageBase = imageBase;
            _sizeOfHeaders = sizeOfHeaders;
            _exportDirectoryRva = exportDirectoryRva;
            _sections = sections;
        }

        public ushort Machine { get; }

        public uint ImageBase { get; }

        public static PortableExecutableImage Load(string path)
        {
            var bytes = File.ReadAllBytes(path);
            if (bytes.Length < 0x100
                || ReadUInt16(bytes, 0) != 0x5A4D)
            {
                throw new InvalidDataException(
                    $"{path} 不是有效的 PE 文件。");
            }

            var peOffset = ReadInt32(bytes, 0x3C);
            EnsureRange(bytes, peOffset, 24);
            if (ReadUInt32(bytes, peOffset) != 0x00004550)
            {
                throw new InvalidDataException(
                    $"{path} 缺少 PE 签名。");
            }

            var machine = ReadUInt16(bytes, peOffset + 4);
            var sectionCount = ReadUInt16(bytes, peOffset + 6);
            var optionalHeaderSize =
                ReadUInt16(bytes, peOffset + 20);
            var optionalHeaderOffset = peOffset + 24;
            EnsureRange(
                bytes,
                optionalHeaderOffset,
                optionalHeaderSize);
            var optionalMagic =
                ReadUInt16(bytes, optionalHeaderOffset);
            if (optionalMagic != 0x010B)
            {
                throw new InvalidDataException(
                    $"{path} 不是 PE32(x86) 映像。");
            }

            var imageBase =
                ReadUInt32(bytes, optionalHeaderOffset + 28);
            var sizeOfHeaders =
                ReadInt32(bytes, optionalHeaderOffset + 60);
            var exportDirectoryRva =
                ReadInt32(bytes, optionalHeaderOffset + 96);
            var sectionTableOffset =
                optionalHeaderOffset + optionalHeaderSize;
            var sections = new List<Section>(sectionCount);
            for (var index = 0; index < sectionCount; index++)
            {
                var offset = sectionTableOffset + (index * 40);
                EnsureRange(bytes, offset, 40);
                var nameLength = 0;
                while (nameLength < 8
                    && bytes[offset + nameLength] != 0)
                {
                    nameLength++;
                }

                sections.Add(new Section(
                    Encoding.ASCII.GetString(
                        bytes,
                        offset,
                        nameLength),
                    ReadInt32(bytes, offset + 8),
                    ReadInt32(bytes, offset + 12),
                    ReadInt32(bytes, offset + 16),
                    ReadInt32(bytes, offset + 20),
                    ReadUInt32(bytes, offset + 36)));
            }

            return new PortableExecutableImage(
                bytes,
                machine,
                imageBase,
                sizeOfHeaders,
                exportDirectoryRva,
                sections);
        }

        public byte[] ReadBytes(int rva, int length)
        {
            var offset = RvaToOffset(rva);
            EnsureRange(_bytes, offset, length);
            return _bytes.AsSpan(offset, length).ToArray();
        }

        public bool IsExecutableRva(int rva)
        {
            return FindSection(rva)?.Characteristics
                .HasFlagValue(ImageScnMemExecute) == true;
        }

        public bool IsWritableRva(int rva)
        {
            return FindSection(rva)?.Characteristics
                .HasFlagValue(ImageScnMemWrite) == true;
        }

        public bool TryReadRelativeCallTarget(
            int callRva,
            out int targetRva)
        {
            targetRva = 0;
            var bytes = ReadBytes(callRva, 5);
            if (bytes[0] != 0xE8)
            {
                return false;
            }

            targetRva = checked(
                callRva + 5 + BitConverter.ToInt32(bytes, 1));
            return true;
        }

        public IReadOnlyList<int> FindRelativeCallSitesTo(
            int targetRva)
        {
            var results = new List<int>();
            foreach (var section in _sections.Where(
                         section => section.Characteristics
                             .HasFlagValue(ImageScnMemExecute)))
            {
                var available = Math.Min(
                    section.RawSize,
                    _bytes.Length - section.RawOffset);
                for (var index = 0; index <= available - 5; index++)
                {
                    var offset = section.RawOffset + index;
                    if (_bytes[offset] != 0xE8)
                    {
                        continue;
                    }

                    var callRva = section.VirtualAddress + index;
                    var displacement =
                        BitConverter.ToInt32(_bytes, offset + 1);
                    if (callRva + 5 + displacement == targetRva)
                    {
                        results.Add(callRva);
                    }
                }
            }

            return results;
        }

        public IReadOnlyList<int> FindUtf16StringRvas(string value)
        {
            return FindPatternRvas(
                Encoding.Unicode.GetBytes(value + "\0"));
        }

        public IReadOnlyList<int> FindAbsoluteReferences(uint value)
        {
            var pattern = BitConverter.GetBytes(value);
            var results = new List<int>();
            foreach (var section in _sections.Where(
                         section => section.Characteristics
                             .HasFlagValue(ImageScnMemExecute)))
            {
                FindPatternInSection(section, pattern, results);
            }

            return results;
        }

        public bool TryGetExportRva(
            string exportName,
            out int exportRva)
        {
            exportRva = 0;
            if (_exportDirectoryRva == 0)
            {
                return false;
            }

            var exportOffset = RvaToOffset(
                _exportDirectoryRva);
            EnsureRange(_bytes, exportOffset, 40);
            var numberOfFunctions =
                ReadInt32(_bytes, exportOffset + 20);
            var numberOfNames =
                ReadInt32(_bytes, exportOffset + 24);
            var functionsOffset = RvaToOffset(
                ReadInt32(_bytes, exportOffset + 28));
            var namesOffset = RvaToOffset(
                ReadInt32(_bytes, exportOffset + 32));
            var ordinalsOffset = RvaToOffset(
                ReadInt32(_bytes, exportOffset + 36));
            if (numberOfFunctions < 0
                || numberOfNames < 0
                || numberOfNames > 100_000)
            {
                throw new InvalidDataException(
                    "PE 导出表数量无效。");
            }

            for (var index = 0; index < numberOfNames; index++)
            {
                var nameRva = ReadInt32(
                    _bytes,
                    namesOffset + (index * 4));
                var name = ReadAsciiZ(
                    _bytes,
                    RvaToOffset(nameRva));
                var exactName = string.Equals(
                    name,
                    exportName,
                    StringComparison.Ordinal);
                var decoratedCppName = name.StartsWith(
                    "?" + exportName + "@",
                    StringComparison.Ordinal);
                if (!exactName && !decoratedCppName)
                {
                    continue;
                }

                var ordinal = ReadUInt16(
                    _bytes,
                    ordinalsOffset + (index * 2));
                if (ordinal >= numberOfFunctions)
                {
                    return false;
                }

                exportRva = ReadInt32(
                    _bytes,
                    functionsOffset + (ordinal * 4));
                return exportRva != 0;
            }

            return false;
        }

        private IReadOnlyList<int> FindPatternRvas(byte[] pattern)
        {
            var results = new List<int>();
            foreach (var section in _sections)
            {
                FindPatternInSection(section, pattern, results);
            }

            return results;
        }

        private void FindPatternInSection(
            Section section,
            byte[] pattern,
            ICollection<int> results)
        {
            var available = Math.Min(
                section.RawSize,
                _bytes.Length - section.RawOffset);
            for (var index = 0;
                 index <= available - pattern.Length;
                 index++)
            {
                if (_bytes.AsSpan(
                        section.RawOffset + index,
                        pattern.Length)
                    .SequenceEqual(pattern))
                {
                    results.Add(section.VirtualAddress + index);
                }
            }
        }

        private Section? FindSection(int rva)
        {
            return _sections.FirstOrDefault(section =>
                rva >= section.VirtualAddress
                && rva < section.VirtualAddress
                    + Math.Max(
                        section.VirtualSize,
                        section.RawSize));
        }

        private int RvaToOffset(int rva)
        {
            if (rva >= 0 && rva < _sizeOfHeaders)
            {
                return rva;
            }

            var section = FindSection(rva)
                ?? throw new InvalidDataException(
                    $"RVA 0x{rva:X8} 不属于任何 PE 节。");
            return checked(
                section.RawOffset
                + (rva - section.VirtualAddress));
        }

        private static string ReadAsciiZ(
            byte[] bytes,
            int offset)
        {
            EnsureRange(bytes, offset, 1);
            var end = offset;
            while (end < bytes.Length
                && bytes[end] != 0
                && end - offset < 4096)
            {
                end++;
            }

            return Encoding.ASCII.GetString(
                bytes,
                offset,
                end - offset);
        }

        private static void EnsureRange(
            byte[] bytes,
            int offset,
            int length)
        {
            if (offset < 0
                || length < 0
                || offset > bytes.Length - length)
            {
                throw new InvalidDataException(
                    "PE 数据范围越界。");
            }
        }

        private static ushort ReadUInt16(
            byte[] bytes,
            int offset)
        {
            EnsureRange(bytes, offset, sizeof(ushort));
            return BitConverter.ToUInt16(bytes, offset);
        }

        private static uint ReadUInt32(
            byte[] bytes,
            int offset)
        {
            EnsureRange(bytes, offset, sizeof(uint));
            return BitConverter.ToUInt32(bytes, offset);
        }

        private static int ReadInt32(
            byte[] bytes,
            int offset)
        {
            EnsureRange(bytes, offset, sizeof(int));
            return BitConverter.ToInt32(bytes, offset);
        }

        private sealed record Section(
            string Name,
            int VirtualSize,
            int VirtualAddress,
            int RawSize,
            int RawOffset,
            uint Characteristics);
    }

    private static bool HasFlagValue(this uint value, uint flag)
    {
        return (value & flag) != 0;
    }
}
