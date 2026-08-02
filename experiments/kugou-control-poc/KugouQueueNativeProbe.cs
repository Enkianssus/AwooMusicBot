using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace KugouControlPoc;

internal sealed record KugouQueueNativeProbeResult(
    int ProcessId,
    string ModulePath,
    string FileVersion,
    string Sha256,
    long ModuleBase,
    long Controller,
    long Vtable,
    int Stage,
    IReadOnlyList<KugouQueueVtableSlot> Slots,
    long Implementation,
    IReadOnlyList<KugouNestedQueueObject> NestedObjects);

internal sealed record KugouQueueVtableSlot(
    int Offset,
    long Address,
    int? Rva,
    string Bytes);

internal sealed record KugouQueueHashQueryResult(
    int ProcessId,
    string FileVersion,
    string Sha256,
    int ModelType,
    string Hash,
    int VtableOffset,
    int Stage,
    bool QuerySucceeded,
    long Model,
    long ModelVtable,
    long QueryFunction,
    IReadOnlyList<int> QueueItemIds);

internal sealed record KugouUiQueuePositionProbeResult(
    int ProcessId,
    string FileVersion,
    string Sha256,
    int Stage,
    long Controller,
    int IndexFromItemMethod44,
    int IndexFromItemMethod48);

internal sealed record KugouPromoteQueueItemResult(
    int ProcessId,
    string FileVersion,
    string Sha256,
    int SongItemId,
    int Stage,
    bool Succeeded,
    long Controller,
    long Vtable,
    long Function);

internal sealed record KugouInsertionAnchorObject(
    long Address,
    int InsertCursor,
    int CurrentIndex,
    long QueueBegin,
    long QueueEnd,
    long QueueCapacity);

internal sealed record KugouInsertionAnchorSnapshot(
    int ProcessId,
    string FileVersion,
    string Sha256,
    long ExpectedVtable,
    IReadOnlyList<KugouInsertionAnchorObject> Objects);

internal sealed record KugouResetInsertionAnchorResult(
    int ProcessId,
    string FileVersion,
    string Sha256,
    long ExpectedVtable,
    IReadOnlyList<KugouInsertionAnchorObject> Objects,
    bool Reset,
    int CursorBefore,
    int CurrentIndex,
    int CursorAfter);

internal sealed record KugouNestedQueueObject(
    int ParentOffset,
    long Pointer,
    long DirectVtable,
    long PlusFourVtable,
    KugouQueueVtableSlot? DirectSlot94,
    KugouQueueVtableSlot? DirectSlot2F0,
    KugouQueueVtableSlot? PlusFourSlot94,
    KugouQueueVtableSlot? PlusFourSlot2F0);

internal sealed record KugouQueueObjectDword(
    int Offset,
    long UnsignedValue,
    string Hex);

internal sealed record KugouQueueServiceSnapshot(
    int ParentOffset,
    long Address,
    long Vtable,
    int? VtableRva,
    IReadOnlyList<KugouQueueObjectDword> Dwords,
    IReadOnlyList<KugouQueueVtableSlot> Slots);

internal sealed record KugouQueueInsertionStateSnapshot(
    int ProcessId,
    string FileVersion,
    string Sha256,
    long ModuleBase,
    long Controller,
    long Vtable,
    int VtableRva,
    long InsertFunction,
    int InsertFunctionRva,
    IReadOnlyList<KugouQueueObjectDword> ControllerDwords,
    IReadOnlyList<KugouQueueServiceSnapshot> Services,
    long QueueServiceImplementation,
    long PlaybackTokenSource,
    IReadOnlyList<KugouQueueObjectDword> QueueServiceImplementationDwords,
    IReadOnlyList<KugouQueueObjectDword> PlaybackTokenSourceDwords);

internal sealed record KugouQueueInsertCapturedArgument(
    int Index,
    long UnsignedValue,
    string Hex);

internal sealed record KugouQueueInsertArgumentCapture(
    int ProcessId,
    string FileVersion,
    string Sha256,
    long Controller,
    long OriginalVtable,
    long HookedVtableSlot,
    long OriginalInsertFunction,
    int InvocationCount,
    long ThisPointer,
    IReadOnlyList<KugouQueueInsertCapturedArgument> Arguments,
    BackgroundOpenResult Delivery,
    bool OriginalSlotRestored);

internal sealed record KugouInsertionCursorResolution(
    int ProcessId,
    string FileVersion,
    string Sha256,
    long Controller,
    long QueueService,
    long AnchorTracker,
    long AnchorTrackerSource,
    long AnchorHistoryBegin,
    long AnchorHistoryEnd,
    long AnchorHistoryCapacity,
    int AnchorHistoryCount,
    long AnchorHistoryLastEntry,
    long QueueState,
    long QueueOuter,
    long QueueModel,
    int QueueModelDirty,
    long QueueModelField0C,
    long QueueModelItems,
    int QueueModelItemCount,
    long ResolvedOwner,
    long ExpectedOwner,
    int ResolvedIndex,
    int QueueCount,
    long ResolvedObject,
    long ResolvedControlBlock,
    long QueueStateGetter,
    long CursorGetter,
    bool OwnerMatches,
    bool Released,
    int Stage);

internal sealed record KugouInsertionCursorCaptureSample(
    int Invocation,
    long ThisPointer,
    long VariantAddress,
    long ServiceImplementation,
    long PlaybackTokenSource,
    long PlaybackToken38,
    long PlaybackToken3C,
    long PlaybackToken40,
    long ResolvedOwner,
    int ResolvedIndex,
    long ResolvedObject,
    long ResolvedControlBlock);

internal sealed record KugouInsertionCursorCapture(
    int ProcessId,
    string FileVersion,
    string Sha256,
    long QueueService,
    long QueueServiceVtable,
    long HookedVtableSlot,
    long OriginalCursorGetter,
    long InsertVtableSlot,
    long OriginalInsertFunction,
    int InvocationCount,
    IReadOnlyList<KugouInsertionCursorCaptureSample> Samples,
    int HelperInvocationCount,
    long HelperThisPointer,
    int HelperRequestedIndex,
    BackgroundOpenResult Delivery,
    bool OriginalSlotRestored);

internal sealed record KugouModelRecordInsertCapture(
    int ProcessId,
    string FileVersion,
    string Sha256,
    long CallSite,
    long OriginalFunction,
    int InvocationCount,
    int CompletionCount,
    long ThisPointer,
    IReadOnlyList<KugouQueueInsertCapturedArgument> Arguments,
    int ReturnIndex,
    int InsertedFlag,
    int ModelEntryInvocationCount,
    int ModelEntryCompletionCount,
    long ModelEntryThisPointer,
    IReadOnlyList<KugouQueueInsertCapturedArgument> ModelEntryArguments,
    int ModelEntryReturnValue,
    long SharedCallerReturnAddress,
    int HelperInvocationCount,
    long HelperThisPointer,
    int HelperRequestedIndex,
    int SharedEntryInvocationCount,
    int SharedEntryCompletionCount,
    long SharedEntryThisPointer,
    IReadOnlyList<KugouQueueInsertCapturedArgument> SharedEntryArguments,
    int SharedEntryReturnValue,
    BackgroundOpenResult Delivery,
    bool OriginalCallRestored);

/// <summary>
/// Version-locked, read-only probe for KuGou's in-process play-queue
/// controller. The remote stub only resolves the existing singleton; queue
/// data is read afterwards with ReadProcessMemory and is never mutated.
/// </summary>
internal static class KugouQueueNativeProbe
{
    private const string ExpectedFileVersion = "20.0.81.27563";
    private const string ExpectedSha256 =
        "193CEB92AC2281FCDC8A109BC533F3BC54FCCAFDA0CB1C0E61C0D140657F6132";
    private const int GetServiceRootRva = 0x00C4982E;
    private const int GetQueueControllerRva = 0x00C491E9;
    private const int GetUiQueueServiceRva = 0x00C49169;
    private const int GetIdsByHashThunkRva = 0x001150D3;
    private const int AlternateHashQueryThunkRva = 0x001150E9;
    private const int ReadUiItemIndex44Rva = 0x00107E43;
    private const int ReadUiItemIndex48Rva = 0x00107EB4;
    private const int PromoteAsNextRva = 0x001057CA;
    private const int InsertionAnchorVtableRva = 0x0140E1F4;
    private const int QueueControllerVtableRva = 0x01548AFC;
    private const int QueueServiceVtableRva = 0x0153FDA0;
    private const int QueueInsertFunctionRva = 0x009180E2;
    private const int QueueStateGetterRva = 0x008CD8C9;
    private const int CursorGetterRva = 0x008CA181;
    private const int VariantOwnerGetterRva = 0x0090512E;
    private const int VariantIndexGetterRva = 0x00905159;
    private const int QueueCountGetterRva = 0x0092314B;
    private const int SharedControlReleaseRva = 0x000269F0;
    private const int ModelRecordInsertRva = 0x0093DE7D;
    private const int ModelRecordInsertCallSiteRva = 0x0093E277;
    private const int QueueModelEntryRva = 0x00932C22;
    private const int QueueModelEntryCallSiteRva = 0x0093706E;
    private const int SharedQueueEntryRva = 0x00936EF0;
    private const int SharedQueueEntryCallSiteRva = 0x00918FF0;
    private const int QueueInsertHelperRva = 0x009186E5;
    private const int QueueInsertHelperCallSiteRva = 0x009184F4;
    private static readonly byte[] ExpectedGetServiceRoot =
        [0xE9, 0x60, 0x30, 0x00, 0x00];
    private static readonly byte[] ExpectedGetQueueController =
        [0x8B, 0x49, 0x10, 0xE9, 0x7F, 0xDD, 0x94, 0xFF];
    private static readonly byte[] ExpectedGetUiQueueService =
        [0x8B, 0x49, 0x10, 0xE9, 0x39, 0xD7, 0xC7, 0xFF];
    private static readonly byte[] ExpectedUiItemIndexGetter =
        [0x8B, 0x49, 0x48, 0x8B, 0x01, 0xFF, 0x50, 0x14];
    private static readonly byte[] ExpectedPromoteAsNext =
        [0x6A, 0x4C, 0xB8, 0xBA, 0x4A, 0x0A, 0x11];

    private const uint ProcessCreateThread = 0x0002;
    private const uint ProcessVmOperation = 0x0008;
    private const uint ProcessVmRead = 0x0010;
    private const uint ProcessVmWrite = 0x0020;
    private const uint ProcessQueryInformation = 0x0400;
    private const uint MemCommit = 0x1000;
    private const uint MemReserve = 0x2000;
    private const uint MemRelease = 0x8000;
    private const uint PageExecuteReadWrite = 0x40;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 0x102;
    private const int DataOffset = 0x100;

    public static KugouQueueNativeProbeResult InspectController() =>
        InspectControllerCore(useUiQueueInterface: false);

    public static KugouQueueNativeProbeResult InspectUiController() =>
        InspectControllerCore(useUiQueueInterface: true);

    public static KugouQueueInsertionStateSnapshot InspectInsertionState()
    {
        var resolved = InspectController();
        using var target = Process.GetProcessById(resolved.ProcessId);
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var modulePath = module.FileName;
        var fileVersion = FileVersionInfo.GetVersionInfo(modulePath).FileVersion
            ?? string.Empty;
        var sha256 = Convert.ToHexString(
            SHA256.HashData(File.ReadAllBytes(modulePath)));
        if (!string.Equals(fileVersion, ExpectedFileVersion, StringComparison.Ordinal)
            || !string.Equals(sha256, ExpectedSha256, StringComparison.OrdinalIgnoreCase)
            || module.BaseAddress.ToInt64() != resolved.ModuleBase)
        {
            throw new InvalidOperationException(
                $"KuGou changed while resolving the queue controller: version={fileVersion}, sha256={sha256}, moduleBase=0x{module.BaseAddress:X}.");
        }

        using var processHandle = OpenProcess(
            ProcessVmRead | ProcessQueryInformation,
            false,
            target.Id);
        if (processHandle.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        var moduleBase = module.BaseAddress;
        var controller = (nint)resolved.Controller;
        var vtable = TryReadPointer(processHandle, controller);
        var expectedVtable = nint.Add(moduleBase, QueueControllerVtableRva);
        if (vtable != expectedVtable)
        {
            throw new InvalidOperationException(
                $"Unexpected queue-controller vtable: expected=0x{expectedVtable:X}, actual=0x{vtable:X}.");
        }

        var insertFunction = TryReadPointer(
            processHandle,
            nint.Add(vtable, 0x2FC));
        var expectedInsertFunction = nint.Add(moduleBase, QueueInsertFunctionRva);
        if (insertFunction != expectedInsertFunction)
        {
            throw new InvalidOperationException(
                $"Unexpected queue insert function: expected=0x{expectedInsertFunction:X}, actual=0x{insertFunction:X}.");
        }

        VerifyBytes(
            processHandle,
            insertFunction,
            Convert.FromHexString(
                "68D8050000B8AAC91B11E87AA670008BF189B534FAFFFF8B"),
            "QueueInsertFunction");

        var controllerDwords = ReadDwords(processHandle, controller, 0xC0);
        var services = new List<KugouQueueServiceSnapshot>();
        foreach (var parentOffset in new[] { 0x54, 0x58 })
        {
            var address = TryReadPointer(
                processHandle,
                nint.Add(controller, parentOffset));
            if (address == 0)
            {
                continue;
            }

            var serviceVtable = TryReadPointer(processHandle, address);
            var serviceVtableDelta = serviceVtable.ToInt64() - moduleBase.ToInt64();
            int? serviceVtableRva = serviceVtableDelta is >= 0 and <= int.MaxValue
                ? (int)serviceVtableDelta
                : null;
            var slots = new List<KugouQueueVtableSlot>();
            foreach (var slotOffset in new[] { 0x04, 0x1C, 0x44, 0x48, 0x54, 0x58, 0x7C, 0x94, 0x98 })
            {
                var slot = TryReadSlot(
                    processHandle,
                    moduleBase,
                    serviceVtable,
                    slotOffset);
                if (slot is not null)
                {
                    slots.Add(slot);
                }
            }

            services.Add(new KugouQueueServiceSnapshot(
                parentOffset,
                address.ToInt64(),
                serviceVtable.ToInt64(),
                serviceVtableRva,
                ReadDwords(processHandle, address, 0x100),
                slots));
        }

        var queueService = TryReadPointer(
            processHandle,
            nint.Add(controller, 0x58));
        var queueServiceImplementation = TryReadPointer(
            processHandle,
            nint.Add(queueService, 4));
        var playbackTokenSource = TryReadPointer(
            processHandle,
            nint.Add(queueServiceImplementation, 0x38));
        if (queueService == 0
            || queueServiceImplementation == 0
            || playbackTokenSource == 0)
        {
            throw new InvalidOperationException(
                "The verified QueueController+0x58 -> service+0x04 -> implementation+0x38 chain was incomplete.");
        }

        return new KugouQueueInsertionStateSnapshot(
            target.Id,
            fileVersion,
            sha256,
            moduleBase.ToInt64(),
            controller.ToInt64(),
            vtable.ToInt64(),
            QueueControllerVtableRva,
            insertFunction.ToInt64(),
            QueueInsertFunctionRva,
            controllerDwords,
            services,
            queueServiceImplementation.ToInt64(),
            playbackTokenSource.ToInt64(),
            ReadDwords(processHandle, queueServiceImplementation, 0x80),
            ReadDwords(processHandle, playbackTokenSource, 0x80));
    }

    public static async Task<KugouQueueInsertArgumentCapture>
        CaptureInsertArgumentsAsync(
            string query,
            string play,
            string insert,
            string force,
            string clear,
            string index,
            string addPlayQueue,
            string addToDefaultList)
    {
        if (IntPtr.Size != 4)
        {
            throw new PlatformNotSupportedException(
                "The KuGou insert-argument capture must run as x86.");
        }

        var resolved = InspectController();
        using var target = Process.GetProcessById(resolved.ProcessId);
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var modulePath = module.FileName;
        var fileVersion = FileVersionInfo.GetVersionInfo(modulePath).FileVersion
            ?? string.Empty;
        var sha256 = Convert.ToHexString(
            SHA256.HashData(File.ReadAllBytes(modulePath)));
        if (!string.Equals(fileVersion, ExpectedFileVersion, StringComparison.Ordinal)
            || !string.Equals(sha256, ExpectedSha256, StringComparison.OrdinalIgnoreCase)
            || module.BaseAddress.ToInt64() != resolved.ModuleBase)
        {
            throw new InvalidOperationException(
                $"KuGou changed while preparing the insert capture: version={fileVersion}, sha256={sha256}, moduleBase=0x{module.BaseAddress:X}.");
        }

        using var processHandle = OpenProcess(
            ProcessVmOperation
                | ProcessVmRead
                | ProcessVmWrite
                | ProcessQueryInformation,
            false,
            target.Id);
        if (processHandle.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        var moduleBase = module.BaseAddress;
        var controller = (nint)resolved.Controller;
        var originalVtable = TryReadPointer(processHandle, controller);
        var expectedVtable = nint.Add(moduleBase, QueueControllerVtableRva);
        if (originalVtable != expectedVtable)
        {
            throw new InvalidOperationException(
                $"Unexpected queue-controller vtable before capture: expected=0x{expectedVtable:X}, actual=0x{originalVtable:X}.");
        }

        var originalInsertFunction = TryReadPointer(
            processHandle,
            nint.Add(originalVtable, 0x2FC));
        var expectedInsertFunction = nint.Add(moduleBase, QueueInsertFunctionRva);
        if (originalInsertFunction != expectedInsertFunction)
        {
            throw new InvalidOperationException(
                $"Unexpected queue insert function before capture: expected=0x{expectedInsertFunction:X}, actual=0x{originalInsertFunction:X}.");
        }

        VerifyBytes(
            processHandle,
            originalInsertFunction,
            Convert.FromHexString(
                "68D8050000B8AAC91B11E87AA670008BF189B534FAFFFF8B"),
            "QueueInsertFunction");

        var remoteBlock = VirtualAllocEx(
            processHandle,
            0,
            0x2000,
            MemCommit | MemReserve,
            PageExecuteReadWrite);
        if (remoteBlock == 0)
        {
            throw CreateWin32Exception("VirtualAllocEx");
        }

        var stubAddress = remoteBlock;
        var captureAddress = nint.Add(remoteBlock, 0x400);
        var hookedVtableSlot = nint.Add(originalVtable, 0x2FC);
        WriteBytes(processHandle, captureAddress, new byte[0x100]);
        WriteBytes(
            processHandle,
            stubAddress,
            BuildInsertCaptureStub(
                stubAddress,
                captureAddress,
                originalInsertFunction));

        BackgroundOpenResult? delivery = null;
        byte[]? capturedBytes = null;
        var restored = false;
        if (!VirtualProtectEx(
                processHandle,
                hookedVtableSlot,
                4,
                PageExecuteReadWrite,
                out var originalProtection))
        {
            VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease);
            throw CreateWin32Exception("VirtualProtectEx");
        }

        try
        {
            WriteBytes(
                processHandle,
                hookedVtableSlot,
                BitConverter.GetBytes(stubAddress.ToInt32()));
            var installedFunction = TryReadPointer(
                processHandle,
                hookedVtableSlot);
            if (installedFunction != stubAddress)
            {
                throw new InvalidOperationException(
                    $"The insert capture stub was not installed: expected=0x{stubAddress:X}, actual=0x{installedFunction:X}.");
            }

            delivery = await KugouNativeController.SearchWithQueueInfoAsync(
                query,
                play,
                insert,
                force,
                clear,
                index,
                addPlayQueue,
                addToDefaultList).ConfigureAwait(false);
            capturedBytes = ReadBytes(processHandle, captureAddress, 0x100);
        }
        finally
        {
            var currentFunction = TryReadPointer(
                processHandle,
                hookedVtableSlot);
            if (currentFunction == stubAddress)
            {
                WriteBytes(
                    processHandle,
                    hookedVtableSlot,
                    BitConverter.GetBytes(originalInsertFunction.ToInt32()));
                restored = TryReadPointer(processHandle, hookedVtableSlot)
                    == originalInsertFunction;
            }

            if (!VirtualProtectEx(
                    processHandle,
                    hookedVtableSlot,
                    4,
                    originalProtection,
                    out _))
            {
                throw CreateWin32Exception("VirtualProtectEx restore");
            }

            if (!VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease))
            {
                throw CreateWin32Exception("VirtualFreeEx");
            }
        }

        if (delivery is null || capturedBytes is null)
        {
            throw new InvalidOperationException(
                "The insert capture did not reach the delivery stage.");
        }

        var invocationCount = BitConverter.ToInt32(capturedBytes, 0);
        var thisPointer = BitConverter.ToUInt32(capturedBytes, 4);
        var arguments = new List<KugouQueueInsertCapturedArgument>(19);
        for (var argumentIndex = 1; argumentIndex <= 19; argumentIndex++)
        {
            var value = BitConverter.ToUInt32(
                capturedBytes,
                4 + (argumentIndex * 4));
            arguments.Add(new KugouQueueInsertCapturedArgument(
                argumentIndex,
                value,
                $"0x{value:X8}"));
        }

        return new KugouQueueInsertArgumentCapture(
            target.Id,
            fileVersion,
            sha256,
            controller.ToInt64(),
            originalVtable.ToInt64(),
            hookedVtableSlot.ToInt64(),
            originalInsertFunction.ToInt64(),
            invocationCount,
            thisPointer,
            arguments,
            delivery,
            restored);
    }

    public static KugouInsertionCursorResolution InspectInsertionCursorResolution()
    {
        if (IntPtr.Size != 4)
        {
            throw new PlatformNotSupportedException(
                "The KuGou insertion-cursor resolver must run as x86.");
        }

        var resolved = InspectController();
        using var target = Process.GetProcessById(resolved.ProcessId);
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var modulePath = module.FileName;
        var fileVersion = FileVersionInfo.GetVersionInfo(modulePath).FileVersion
            ?? string.Empty;
        var sha256 = Convert.ToHexString(
            SHA256.HashData(File.ReadAllBytes(modulePath)));
        if (!string.Equals(fileVersion, ExpectedFileVersion, StringComparison.Ordinal)
            || !string.Equals(sha256, ExpectedSha256, StringComparison.OrdinalIgnoreCase)
            || module.BaseAddress.ToInt64() != resolved.ModuleBase)
        {
            throw new InvalidOperationException(
                $"KuGou changed while resolving the insertion cursor: version={fileVersion}, sha256={sha256}, moduleBase=0x{module.BaseAddress:X}.");
        }

        using var processHandle = OpenProcess(
            ProcessCreateThread
                | ProcessVmOperation
                | ProcessVmRead
                | ProcessVmWrite
                | ProcessQueryInformation,
            false,
            target.Id);
        if (processHandle.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        var moduleBase = module.BaseAddress;
        var controller = (nint)resolved.Controller;
        var vtable = TryReadPointer(processHandle, controller);
        if (vtable != nint.Add(moduleBase, QueueControllerVtableRva))
        {
            throw new InvalidOperationException(
                $"Unexpected queue-controller vtable while resolving the cursor: 0x{vtable:X}.");
        }

        var queueService = TryReadPointer(
            processHandle,
            nint.Add(controller, 0x58));
        var queueServiceVtable = TryReadPointer(processHandle, queueService);
        var queueStateGetter = TryReadPointer(
            processHandle,
            nint.Add(queueServiceVtable, 0x04));
        var cursorGetter = TryReadPointer(
            processHandle,
            nint.Add(queueServiceVtable, 0x54));
        if (queueStateGetter != nint.Add(moduleBase, QueueStateGetterRva)
            || cursorGetter != nint.Add(moduleBase, CursorGetterRva))
        {
            throw new InvalidOperationException(
                $"Unexpected queue-service getters: state=0x{queueStateGetter:X}, cursor=0x{cursorGetter:X}.");
        }

        VerifyBytes(
            processHandle,
            queueStateGetter,
            Convert.FromHexString("8B41048B8080000000C3"),
            "QueueStateGetter");
        VerifyBytes(
            processHandle,
            cursorGetter,
            Convert.FromHexString(
                "558BEC518B4904FF75088B4938E879B935008B4508C9C204"),
            "CursorGetter");
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, VariantOwnerGetterRva),
            Convert.FromHexString("8B0985C974048B01FF2033C0C3"),
            "VariantOwnerGetter");
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, VariantIndexGetterRva),
            Convert.FromHexString("8B0985C974058B01FF601483C8FFC3"),
            "VariantIndexGetter");
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, QueueCountGetterRva),
            Convert.FromHexString(
                "8B01FF902003000085C0740B8D48048B016A00FF5058C333C0C3"),
            "QueueCountGetter");
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, SharedControlReleaseRva),
            Convert.FromHexString(
                "565783CFFF8BF18BC7F00FC1460474035F5EC3"),
            "SharedControlRelease");

        var remoteBlock = VirtualAllocEx(
            processHandle,
            0,
            0x1000,
            MemCommit | MemReserve,
            PageExecuteReadWrite);
        if (remoteBlock == 0)
        {
            throw CreateWin32Exception("VirtualAllocEx");
        }

        try
        {
            var dataAddress = nint.Add(remoteBlock, 0x300);
            WriteBytes(processHandle, dataAddress, new byte[0x80]);
            WriteBytes(
                processHandle,
                remoteBlock,
                BuildInsertionCursorResolverStub(
                    remoteBlock,
                    dataAddress,
                    controller,
                    queueService,
                    moduleBase));

            using var thread = CreateRemoteThread(
                processHandle,
                0,
                0,
                remoteBlock,
                0,
                0,
                out _);
            if (thread.IsInvalid)
            {
                throw CreateWin32Exception("CreateRemoteThread");
            }

            var waitResult = WaitForSingleObject(thread, 3000);
            if (waitResult == WaitTimeout)
            {
                throw new TimeoutException(
                    "The KuGou insertion-cursor resolver did not return within three seconds.");
            }

            if (waitResult != WaitObject0)
            {
                throw CreateWin32Exception("WaitForSingleObject");
            }

            var data = ReadBytes(processHandle, dataAddress, 0x80);
            var stage = BitConverter.ToInt32(data, 0x00);
            var queueState = BitConverter.ToUInt32(data, 0x08);
            var resolvedObject = BitConverter.ToUInt32(data, 0x0C);
            var resolvedControlBlock = BitConverter.ToUInt32(data, 0x10);
            var owner = BitConverter.ToUInt32(data, 0x14);
            var resolvedIndex = BitConverter.ToInt32(data, 0x18);
            var queueCount = BitConverter.ToInt32(data, 0x1C);
            var released = BitConverter.ToInt32(data, 0x28) == 1;
            var queueOuter = queueState == 0
                ? 0
                : TryReadPointer(
                    processHandle,
                    nint.Add((nint)queueState, 0x18));
            var queueModel = queueOuter == 0
                ? 0
                : TryReadPointer(
                    processHandle,
                    nint.Add(queueOuter, 0x24));
            var queueModelDirty = queueModel == 0
                ? -1
                : ReadBytes(
                    processHandle,
                    nint.Add(queueModel, 0x24),
                    1)[0];
            var queueModelField0C = queueModel == 0
                ? 0
                : TryReadPointer(
                    processHandle,
                    nint.Add(queueModel, 0x0C));
            var queueModelItems = queueModel == 0
                ? 0
                : TryReadPointer(
                    processHandle,
                    nint.Add(queueModel, 0x1C));
            var queueModelItemCount = queueModelItems == 0
                ? -1
                : BitConverter.ToInt32(
                    ReadBytes(
                        processHandle,
                        nint.Add(queueModelItems, 0x24),
                        4),
                    0);
            var expectedOwner = queueState == 0
                ? 0u
                : queueState + 4u;
            var anchorTracker = TryReadPointer(
                processHandle,
                nint.Add(controller, 0x60));
            var anchorTrackerSource = anchorTracker == 0
                ? 0
                : TryReadPointer(
                    processHandle,
                    nint.Add(anchorTracker, 0x0C));
            var anchorHistoryBegin = anchorTracker == 0
                ? 0
                : TryReadPointer(
                    processHandle,
                    nint.Add(anchorTracker, 0x10));
            var anchorHistoryEnd = anchorTracker == 0
                ? 0
                : TryReadPointer(
                    processHandle,
                    nint.Add(anchorTracker, 0x14));
            var anchorHistoryCapacity = anchorTracker == 0
                ? 0
                : TryReadPointer(
                    processHandle,
                    nint.Add(anchorTracker, 0x18));
            var anchorHistoryCount = anchorHistoryBegin == 0
                || anchorHistoryEnd < anchorHistoryBegin
                    ? -1
                    : checked((anchorHistoryEnd - anchorHistoryBegin).ToInt32() / 4);
            var anchorHistoryLastEntry = anchorHistoryCount <= 0
                ? 0
                : TryReadPointer(
                    processHandle,
                    nint.Add(anchorHistoryEnd, -4));
            return new KugouInsertionCursorResolution(
                target.Id,
                fileVersion,
                sha256,
                controller.ToInt64(),
                queueService.ToInt64(),
                anchorTracker.ToInt64(),
                anchorTrackerSource.ToInt64(),
                anchorHistoryBegin.ToInt64(),
                anchorHistoryEnd.ToInt64(),
                anchorHistoryCapacity.ToInt64(),
                anchorHistoryCount,
                anchorHistoryLastEntry.ToInt64(),
                queueState,
                queueOuter.ToInt64(),
                queueModel.ToInt64(),
                queueModelDirty,
                queueModelField0C.ToInt64(),
                queueModelItems.ToInt64(),
                queueModelItemCount,
                owner,
                expectedOwner,
                resolvedIndex,
                queueCount,
                resolvedObject,
                resolvedControlBlock,
                queueStateGetter.ToInt64(),
                cursorGetter.ToInt64(),
                owner == expectedOwner,
                released,
                stage);
        }
        finally
        {
            if (!VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease))
            {
                throw CreateWin32Exception("VirtualFreeEx");
            }
        }
    }

    public static async Task<KugouInsertionCursorCapture>
        CaptureInsertionCursorDuringInsertAsync(string query)
    {
        if (IntPtr.Size != 4)
        {
            throw new PlatformNotSupportedException(
                "The KuGou insertion-cursor capture must run as x86.");
        }

        var resolved = InspectController();
        using var target = Process.GetProcessById(resolved.ProcessId);
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var modulePath = module.FileName;
        var fileVersion = FileVersionInfo.GetVersionInfo(modulePath).FileVersion
            ?? string.Empty;
        var sha256 = Convert.ToHexString(
            SHA256.HashData(File.ReadAllBytes(modulePath)));
        if (!string.Equals(fileVersion, ExpectedFileVersion, StringComparison.Ordinal)
            || !string.Equals(sha256, ExpectedSha256, StringComparison.OrdinalIgnoreCase)
            || module.BaseAddress.ToInt64() != resolved.ModuleBase)
        {
            throw new InvalidOperationException(
                $"KuGou changed while preparing the insertion-cursor capture: version={fileVersion}, sha256={sha256}, moduleBase=0x{module.BaseAddress:X}.");
        }

        using var processHandle = OpenProcess(
            ProcessVmOperation
                | ProcessVmRead
                | ProcessVmWrite
                | ProcessQueryInformation,
            false,
            target.Id);
        if (processHandle.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        var moduleBase = module.BaseAddress;
        var controller = (nint)resolved.Controller;
        var controllerVtable = TryReadPointer(processHandle, controller);
        if (controllerVtable != nint.Add(moduleBase, QueueControllerVtableRva))
        {
            throw new InvalidOperationException(
                $"Unexpected queue-controller vtable before cursor capture: 0x{controllerVtable:X}.");
        }

        var queueService = TryReadPointer(
            processHandle,
            nint.Add(controller, 0x58));
        var queueServiceVtable = TryReadPointer(processHandle, queueService);
        var expectedQueueServiceVtable = nint.Add(
            moduleBase,
            QueueServiceVtableRva);
        if (queueService == 0 || queueServiceVtable != expectedQueueServiceVtable)
        {
            throw new InvalidOperationException(
                $"Unexpected QueueController+0x58 service/vtable: service=0x{queueService:X}, expectedVtable=0x{expectedQueueServiceVtable:X}, actualVtable=0x{queueServiceVtable:X}.");
        }

        var hookedVtableSlot = nint.Add(queueServiceVtable, 0x54);
        var originalCursorGetter = TryReadPointer(
            processHandle,
            hookedVtableSlot);
        var expectedCursorGetter = nint.Add(moduleBase, CursorGetterRva);
        if (originalCursorGetter != expectedCursorGetter)
        {
            throw new InvalidOperationException(
                $"Unexpected cursor getter before capture: expected=0x{expectedCursorGetter:X}, actual=0x{originalCursorGetter:X}.");
        }

        VerifyBytes(
            processHandle,
            originalCursorGetter,
            Convert.FromHexString(
                "558BEC518B4904FF75088B4938E879B935008B4508C9C204"),
            "CursorGetter");
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, VariantOwnerGetterRva),
            Convert.FromHexString("8B0985C974048B01FF2033C0C3"),
            "VariantOwnerGetter");
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, VariantIndexGetterRva),
            Convert.FromHexString("8B0985C974058B01FF601483C8FFC3"),
            "VariantIndexGetter");

        var insertVtableSlot = nint.Add(controllerVtable, 0x2FC);
        var originalInsertFunction = TryReadPointer(
            processHandle,
            insertVtableSlot);
        var expectedInsertFunction = nint.Add(moduleBase, QueueInsertFunctionRva);
        if (originalInsertFunction != expectedInsertFunction)
        {
            throw new InvalidOperationException(
                $"Unexpected queue insert function before gated cursor capture: expected=0x{expectedInsertFunction:X}, actual=0x{originalInsertFunction:X}.");
        }
        VerifyBytes(
            processHandle,
            originalInsertFunction,
            Convert.FromHexString(
                "68D8050000B8AAC91B11E87AA670008BF189B534FAFFFF8B"),
            "QueueInsertFunction");

        var helperCallSite = nint.Add(
            moduleBase,
            QueueInsertHelperCallSiteRva);
        var originalHelper = nint.Add(moduleBase, QueueInsertHelperRva);
        var expectedHelperCall = Convert.FromHexString("E8EC010000");
        VerifyBytes(
            processHandle,
            helperCallSite,
            expectedHelperCall,
            "QueueInsertHelperCallSite");
        VerifyBytes(
            processHandle,
            originalHelper,
            Convert.FromHexString("68A0060000B8BECA1B11E877A07000"),
            "QueueInsertHelper");

        var remoteBlock = VirtualAllocEx(
            processHandle,
            0,
            0x2000,
            MemCommit | MemReserve,
            PageExecuteReadWrite);
        if (remoteBlock == 0)
        {
            throw CreateWin32Exception("VirtualAllocEx");
        }

        var captureAddress = nint.Add(remoteBlock, 0x400);
        var insertMarkerStub = nint.Add(remoteBlock, 0x300);
        var helperCaptureStub = nint.Add(remoteBlock, 0x200);
        var helperCaptureAddress = nint.Add(captureAddress, 0x180);
        WriteBytes(processHandle, captureAddress, new byte[0x200]);
        WriteBytes(
            processHandle,
            remoteBlock,
            BuildInsertionCursorCaptureStub(
                remoteBlock,
                captureAddress,
                originalCursorGetter,
                moduleBase));
        WriteBytes(
            processHandle,
            insertMarkerStub,
            BuildInsertCursorMarkerStub(
                insertMarkerStub,
                nint.Add(captureAddress, 4),
                originalInsertFunction));
        WriteBytes(
            processHandle,
            helperCaptureStub,
            BuildHelperRequestedIndexCaptureStub(
                helperCaptureStub,
                helperCaptureAddress,
                originalHelper));
        var replacementHelperCall = new byte[5];
        replacementHelperCall[0] = 0xE8;
        BitConverter.GetBytes(
            helperCaptureStub.ToInt32() - (helperCallSite.ToInt32() + 5))
            .CopyTo(replacementHelperCall, 1);

        BackgroundOpenResult? delivery = null;
        byte[]? capturedBytes = null;
        var restored = false;
        if (!VirtualProtectEx(
                processHandle,
                hookedVtableSlot,
                4,
                PageExecuteReadWrite,
                out var originalProtection))
        {
            VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease);
            throw CreateWin32Exception("VirtualProtectEx");
        }
        if (!VirtualProtectEx(
                processHandle,
                insertVtableSlot,
                4,
                PageExecuteReadWrite,
                out var originalInsertProtection))
        {
            VirtualProtectEx(
                processHandle,
                hookedVtableSlot,
                4,
                originalProtection,
                out _);
            VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease);
            throw CreateWin32Exception("VirtualProtectEx insert slot");
        }
        if (!VirtualProtectEx(
                processHandle,
                helperCallSite,
                5,
                PageExecuteReadWrite,
                out var originalHelperProtection))
        {
            VirtualProtectEx(
                processHandle,
                insertVtableSlot,
                4,
                originalInsertProtection,
                out _);
            VirtualProtectEx(
                processHandle,
                hookedVtableSlot,
                4,
                originalProtection,
                out _);
            VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease);
            throw CreateWin32Exception("VirtualProtectEx helper callsite");
        }

        try
        {
            WriteBytes(
                processHandle,
                hookedVtableSlot,
                BitConverter.GetBytes(remoteBlock.ToInt32()));
            if (TryReadPointer(processHandle, hookedVtableSlot) != remoteBlock)
            {
                throw new InvalidOperationException(
                    "The insertion-cursor capture stub was not installed.");
            }
            WriteBytes(
                processHandle,
                insertVtableSlot,
                BitConverter.GetBytes(insertMarkerStub.ToInt32()));
            if (TryReadPointer(processHandle, insertVtableSlot) != insertMarkerStub)
            {
                throw new InvalidOperationException(
                    "The queue-insert marker stub was not installed.");
            }
            WriteBytes(processHandle, helperCallSite, replacementHelperCall);
            if (!ReadBytes(processHandle, helperCallSite, 5)
                    .SequenceEqual(replacementHelperCall))
            {
                throw new InvalidOperationException(
                    "The queue-insert helper capture callsite was not installed.");
            }

            delivery = await KugouNativeController.SearchWithQueueInfoAsync(
                query,
                "0",
                "1",
                "0",
                "0",
                "0",
                "1",
                "0").ConfigureAwait(false);
            // KuGou acknowledges WM_COPYDATA before its queue worker always
            // reaches the cursor getter. Keep the read-only hook alive for a
            // short, bounded observation window, then restore it in finally.
            await Task.Delay(750).ConfigureAwait(false);
            capturedBytes = ReadBytes(processHandle, captureAddress, 0x200);
        }
        finally
        {
            var currentHelperCall = ReadBytes(processHandle, helperCallSite, 5);
            if (currentHelperCall.SequenceEqual(replacementHelperCall))
            {
                WriteBytes(processHandle, helperCallSite, expectedHelperCall);
            }

            var currentInsertFunction = TryReadPointer(
                processHandle,
                insertVtableSlot);
            if (currentInsertFunction == insertMarkerStub)
            {
                WriteBytes(
                    processHandle,
                    insertVtableSlot,
                    BitConverter.GetBytes(originalInsertFunction.ToInt32()));
            }

            var currentCursorFunction = TryReadPointer(
                processHandle,
                hookedVtableSlot);
            if (currentCursorFunction == remoteBlock)
            {
                WriteBytes(
                    processHandle,
                    hookedVtableSlot,
                    BitConverter.GetBytes(originalCursorGetter.ToInt32()));
            }
            restored = TryReadPointer(processHandle, hookedVtableSlot)
                    == originalCursorGetter
                && TryReadPointer(processHandle, insertVtableSlot)
                    == originalInsertFunction
                && ReadBytes(processHandle, helperCallSite, 5)
                    .SequenceEqual(expectedHelperCall);

            if (!VirtualProtectEx(
                    processHandle,
                    hookedVtableSlot,
                    4,
                    originalProtection,
                    out _))
            {
                throw CreateWin32Exception("VirtualProtectEx restore");
            }
            if (!VirtualProtectEx(
                    processHandle,
                    insertVtableSlot,
                    4,
                    originalInsertProtection,
                    out _))
            {
                throw CreateWin32Exception("VirtualProtectEx insert restore");
            }
            if (!VirtualProtectEx(
                    processHandle,
                    helperCallSite,
                    5,
                    originalHelperProtection,
                    out _))
            {
                throw CreateWin32Exception(
                    "VirtualProtectEx helper callsite restore");
            }

            if (!VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease))
            {
                throw CreateWin32Exception("VirtualFreeEx");
            }
        }

        if (delivery is null || capturedBytes is null)
        {
            throw new InvalidOperationException(
                "The insertion-cursor capture did not reach the delivery stage.");
        }

        var invocationCount = BitConverter.ToInt32(capturedBytes, 0);
        var sampleCount = Math.Min(invocationCount, 4);
        var samples = new List<KugouInsertionCursorCaptureSample>(sampleCount);
        for (var sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++)
        {
            var offset = 0x20 + (sampleIndex * 0x30);
            samples.Add(new KugouInsertionCursorCaptureSample(
                BitConverter.ToInt32(capturedBytes, offset + 0x00),
                BitConverter.ToUInt32(capturedBytes, offset + 0x04),
                BitConverter.ToUInt32(capturedBytes, offset + 0x08),
                BitConverter.ToUInt32(capturedBytes, offset + 0x0C),
                BitConverter.ToUInt32(capturedBytes, offset + 0x10),
                BitConverter.ToUInt32(capturedBytes, offset + 0x14),
                BitConverter.ToUInt32(capturedBytes, offset + 0x18),
                BitConverter.ToUInt32(capturedBytes, offset + 0x1C),
                BitConverter.ToUInt32(capturedBytes, offset + 0x20),
                BitConverter.ToInt32(capturedBytes, offset + 0x24),
                BitConverter.ToUInt32(capturedBytes, offset + 0x28),
                BitConverter.ToUInt32(capturedBytes, offset + 0x2C)));
        }

        return new KugouInsertionCursorCapture(
            target.Id,
            fileVersion,
            sha256,
            queueService.ToInt64(),
            queueServiceVtable.ToInt64(),
            hookedVtableSlot.ToInt64(),
            originalCursorGetter.ToInt64(),
            insertVtableSlot.ToInt64(),
            originalInsertFunction.ToInt64(),
            invocationCount,
            samples,
            BitConverter.ToInt32(capturedBytes, 0x180),
            BitConverter.ToUInt32(capturedBytes, 0x184),
            BitConverter.ToInt32(capturedBytes, 0x188),
            delivery,
            restored);
    }

    public static async Task<KugouModelRecordInsertCapture>
        CaptureModelRecordInsertionAsync(string query)
    {
        if (IntPtr.Size != 4)
        {
            throw new PlatformNotSupportedException(
                "The KuGou model-record insertion capture must run as x86.");
        }

        var resolved = InspectController();
        using var target = Process.GetProcessById(resolved.ProcessId);
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var modulePath = module.FileName;
        var fileVersion = FileVersionInfo.GetVersionInfo(modulePath).FileVersion
            ?? string.Empty;
        var sha256 = Convert.ToHexString(
            SHA256.HashData(File.ReadAllBytes(modulePath)));
        if (!string.Equals(fileVersion, ExpectedFileVersion, StringComparison.Ordinal)
            || !string.Equals(sha256, ExpectedSha256, StringComparison.OrdinalIgnoreCase)
            || module.BaseAddress.ToInt64() != resolved.ModuleBase)
        {
            throw new InvalidOperationException(
                $"KuGou changed while preparing the model-record capture: version={fileVersion}, sha256={sha256}, moduleBase=0x{module.BaseAddress:X}.");
        }

        using var processHandle = OpenProcess(
            ProcessVmOperation
                | ProcessVmRead
                | ProcessVmWrite
                | ProcessQueryInformation,
            false,
            target.Id);
        if (processHandle.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        var moduleBase = module.BaseAddress;
        var callSite = nint.Add(moduleBase, ModelRecordInsertCallSiteRva);
        var originalFunction = nint.Add(moduleBase, ModelRecordInsertRva);
        var modelEntryCallSite = nint.Add(
            moduleBase,
            QueueModelEntryCallSiteRva);
        var modelEntryFunction = nint.Add(moduleBase, QueueModelEntryRva);
        var helperCallSite = nint.Add(
            moduleBase,
            QueueInsertHelperCallSiteRva);
        var originalHelper = nint.Add(moduleBase, QueueInsertHelperRva);
        var sharedEntryCallSite = nint.Add(
            moduleBase,
            SharedQueueEntryCallSiteRva);
        var sharedEntryFunction = nint.Add(moduleBase, SharedQueueEntryRva);
        var expectedCallBytes = Convert.FromHexString("E801FCFFFF");
        var expectedModelEntryCallBytes = Convert.FromHexString("E8AFBBFFFF");
        var expectedHelperCallBytes = Convert.FromHexString("E8EC010000");
        var expectedSharedEntryCallBytes = Convert.FromHexString("E8FBDE0100");
        VerifyBytes(
            processHandle,
            callSite,
            expectedCallBytes,
            "ModelRecordInsertCallSite");
        VerifyBytes(
            processHandle,
            originalFunction,
            Convert.FromHexString("68080B0000B8AD081C11E8DF486E00"),
            "ModelRecordInsert");
        VerifyBytes(
            processHandle,
            modelEntryCallSite,
            expectedModelEntryCallBytes,
            "QueueModelEntryCallSite");
        VerifyBytes(
            processHandle,
            modelEntryFunction,
            Convert.FromHexString("558BEC51FF75148B4924FF7510FF750CFF7508"),
            "QueueModelEntry");
        VerifyBytes(
            processHandle,
            helperCallSite,
            expectedHelperCallBytes,
            "QueueInsertHelperCallSite");
        VerifyBytes(
            processHandle,
            originalHelper,
            Convert.FromHexString("68A0060000B8BECA1B11E877A07000"),
            "QueueInsertHelper");
        VerifyBytes(
            processHandle,
            sharedEntryCallSite,
            expectedSharedEntryCallBytes,
            "SharedQueueEntryCallSite");
        VerifyBytes(
            processHandle,
            sharedEntryFunction,
            Convert.FromHexString("6884010000B80BFE1B11E86CB86E00"),
            "SharedQueueEntry");

        var remoteBlock = VirtualAllocEx(
            processHandle,
            0,
            0x1000,
            MemCommit | MemReserve,
            PageExecuteReadWrite);
        if (remoteBlock == 0)
        {
            throw CreateWin32Exception("VirtualAllocEx");
        }

        var captureAddress = nint.Add(remoteBlock, 0x300);
        WriteBytes(processHandle, captureAddress, new byte[0x100]);
        WriteBytes(
            processHandle,
            remoteBlock,
            BuildModelRecordInsertCaptureStub(
                remoteBlock,
                captureAddress,
                originalFunction));
        var helperCaptureStub = nint.Add(remoteBlock, 0x100);
        var helperCaptureAddress = nint.Add(captureAddress, 0x60);
        WriteBytes(
            processHandle,
            helperCaptureStub,
            BuildHelperRequestedIndexCaptureStub(
                helperCaptureStub,
                helperCaptureAddress,
                originalHelper));
        var modelEntryStub = nint.Add(remoteBlock, 0x180);
        WriteBytes(
            processHandle,
            modelEntryStub,
            BuildQueueModelEntryCaptureStub(
                modelEntryStub,
                captureAddress,
                modelEntryFunction));
        var sharedEntryStub = nint.Add(remoteBlock, 0x220);
        WriteBytes(
            processHandle,
            sharedEntryStub,
            BuildSharedQueueEntryCaptureStub(
                sharedEntryStub,
                captureAddress,
                sharedEntryFunction));

        var replacementCall = new byte[5];
        replacementCall[0] = 0xE8;
        BitConverter.GetBytes(
            remoteBlock.ToInt32() - (callSite.ToInt32() + 5))
            .CopyTo(replacementCall, 1);
        var replacementModelEntryCall = new byte[5];
        replacementModelEntryCall[0] = 0xE8;
        BitConverter.GetBytes(
            modelEntryStub.ToInt32() - (modelEntryCallSite.ToInt32() + 5))
            .CopyTo(replacementModelEntryCall, 1);
        var replacementHelperCall = new byte[5];
        replacementHelperCall[0] = 0xE8;
        BitConverter.GetBytes(
            helperCaptureStub.ToInt32() - (helperCallSite.ToInt32() + 5))
            .CopyTo(replacementHelperCall, 1);
        var replacementSharedEntryCall = new byte[5];
        replacementSharedEntryCall[0] = 0xE8;
        BitConverter.GetBytes(
            sharedEntryStub.ToInt32() - (sharedEntryCallSite.ToInt32() + 5))
            .CopyTo(replacementSharedEntryCall, 1);

        BackgroundOpenResult? delivery = null;
        byte[]? capturedBytes = null;
        var restored = false;
        if (!VirtualProtectEx(
                processHandle,
                callSite,
                5,
                PageExecuteReadWrite,
                out var originalProtection))
        {
            VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease);
            throw CreateWin32Exception("VirtualProtectEx model callsite");
        }

        if (!VirtualProtectEx(
                processHandle,
                modelEntryCallSite,
                5,
                PageExecuteReadWrite,
                out var originalModelEntryProtection))
        {
            VirtualProtectEx(
                processHandle,
                callSite,
                5,
                originalProtection,
                out _);
            VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease);
            throw CreateWin32Exception(
                "VirtualProtectEx queue-model entry callsite");
        }

        if (!VirtualProtectEx(
                processHandle,
                helperCallSite,
                5,
                PageExecuteReadWrite,
                out var originalHelperProtection))
        {
            VirtualProtectEx(
                processHandle,
                modelEntryCallSite,
                5,
                originalModelEntryProtection,
                out _);
            VirtualProtectEx(
                processHandle,
                callSite,
                5,
                originalProtection,
                out _);
            VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease);
            throw CreateWin32Exception(
                "VirtualProtectEx queue-insert helper callsite");
        }

        if (!VirtualProtectEx(
                processHandle,
                sharedEntryCallSite,
                5,
                PageExecuteReadWrite,
                out var originalSharedEntryProtection))
        {
            VirtualProtectEx(
                processHandle,
                helperCallSite,
                5,
                originalHelperProtection,
                out _);
            VirtualProtectEx(
                processHandle,
                modelEntryCallSite,
                5,
                originalModelEntryProtection,
                out _);
            VirtualProtectEx(
                processHandle,
                callSite,
                5,
                originalProtection,
                out _);
            VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease);
            throw CreateWin32Exception(
                "VirtualProtectEx shared-queue entry callsite");
        }

        try
        {
            WriteBytes(
                processHandle,
                sharedEntryCallSite,
                replacementSharedEntryCall);
            WriteBytes(
                processHandle,
                helperCallSite,
                replacementHelperCall);
            WriteBytes(
                processHandle,
                modelEntryCallSite,
                replacementModelEntryCall);
            WriteBytes(processHandle, callSite, replacementCall);
            if (!ReadBytes(processHandle, callSite, 5)
                    .SequenceEqual(replacementCall)
                || !ReadBytes(processHandle, modelEntryCallSite, 5)
                    .SequenceEqual(replacementModelEntryCall)
                || !ReadBytes(processHandle, helperCallSite, 5)
                    .SequenceEqual(replacementHelperCall)
                || !ReadBytes(processHandle, sharedEntryCallSite, 5)
                    .SequenceEqual(replacementSharedEntryCall))
            {
                throw new InvalidOperationException(
                    "One or more model capture callsites were not installed.");
            }

            delivery = await KugouNativeController.SearchWithQueueInfoAsync(
                query,
                "0",
                "1",
                "0",
                "0",
                "0",
                "1",
                "0").ConfigureAwait(false);
            await Task.Delay(750).ConfigureAwait(false);
            capturedBytes = ReadBytes(processHandle, captureAddress, 0x100);
        }
        finally
        {
            var currentCallBytes = ReadBytes(processHandle, callSite, 5);
            if (currentCallBytes.SequenceEqual(replacementCall))
            {
                WriteBytes(processHandle, callSite, expectedCallBytes);
            }
            restored = ReadBytes(processHandle, callSite, 5)
                .SequenceEqual(expectedCallBytes);

            var currentModelEntryCallBytes = ReadBytes(
                processHandle,
                modelEntryCallSite,
                5);
            if (currentModelEntryCallBytes.SequenceEqual(
                    replacementModelEntryCall))
            {
                WriteBytes(
                    processHandle,
                    modelEntryCallSite,
                    expectedModelEntryCallBytes);
            }
            restored &= ReadBytes(processHandle, modelEntryCallSite, 5)
                .SequenceEqual(expectedModelEntryCallBytes);

            var currentHelperCallBytes = ReadBytes(
                processHandle,
                helperCallSite,
                5);
            if (currentHelperCallBytes.SequenceEqual(replacementHelperCall))
            {
                WriteBytes(
                    processHandle,
                    helperCallSite,
                    expectedHelperCallBytes);
            }
            restored &= ReadBytes(processHandle, helperCallSite, 5)
                .SequenceEqual(expectedHelperCallBytes);

            var currentSharedEntryCallBytes = ReadBytes(
                processHandle,
                sharedEntryCallSite,
                5);
            if (currentSharedEntryCallBytes.SequenceEqual(
                    replacementSharedEntryCall))
            {
                WriteBytes(
                    processHandle,
                    sharedEntryCallSite,
                    expectedSharedEntryCallBytes);
            }
            restored &= ReadBytes(processHandle, sharedEntryCallSite, 5)
                .SequenceEqual(expectedSharedEntryCallBytes);

            if (!VirtualProtectEx(
                    processHandle,
                    callSite,
                    5,
                    originalProtection,
                    out _))
            {
                throw CreateWin32Exception(
                    "VirtualProtectEx model callsite restore");
            }

            if (!VirtualProtectEx(
                    processHandle,
                    modelEntryCallSite,
                    5,
                    originalModelEntryProtection,
                    out _))
            {
                throw CreateWin32Exception(
                    "VirtualProtectEx queue-model entry callsite restore");
            }

            if (!VirtualProtectEx(
                    processHandle,
                    helperCallSite,
                    5,
                    originalHelperProtection,
                    out _))
            {
                throw CreateWin32Exception(
                    "VirtualProtectEx queue-insert helper callsite restore");
            }

            if (!VirtualProtectEx(
                    processHandle,
                    sharedEntryCallSite,
                    5,
                    originalSharedEntryProtection,
                    out _))
            {
                throw CreateWin32Exception(
                    "VirtualProtectEx shared-queue entry callsite restore");
            }

            if (!VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease))
            {
                throw CreateWin32Exception("VirtualFreeEx");
            }
        }

        if (delivery is null || capturedBytes is null)
        {
            throw new InvalidOperationException(
                "The model-record capture did not reach the delivery stage.");
        }

        var arguments = new List<KugouQueueInsertCapturedArgument>(8);
        for (var argumentIndex = 1; argumentIndex <= 8; argumentIndex++)
        {
            var value = BitConverter.ToUInt32(
                capturedBytes,
                0x10 + ((argumentIndex - 1) * 4));
            arguments.Add(new KugouQueueInsertCapturedArgument(
                argumentIndex,
                value,
                $"0x{value:X8}"));
        }

        var modelEntryArguments = new List<KugouQueueInsertCapturedArgument>(4);
        for (var argumentIndex = 1; argumentIndex <= 4; argumentIndex++)
        {
            var value = BitConverter.ToUInt32(
                capturedBytes,
                0x48 + ((argumentIndex - 1) * 4));
            modelEntryArguments.Add(new KugouQueueInsertCapturedArgument(
                argumentIndex,
                value,
                $"0x{value:X8}"));
        }

        var sharedEntryArguments = new List<KugouQueueInsertCapturedArgument>(10);
        for (var argumentIndex = 1; argumentIndex <= 10; argumentIndex++)
        {
            var value = BitConverter.ToUInt32(
                capturedBytes,
                0x78 + ((argumentIndex - 1) * 4));
            sharedEntryArguments.Add(new KugouQueueInsertCapturedArgument(
                argumentIndex,
                value,
                $"0x{value:X8}"));
        }

        return new KugouModelRecordInsertCapture(
            target.Id,
            fileVersion,
            sha256,
            callSite.ToInt64(),
            originalFunction.ToInt64(),
            BitConverter.ToInt32(capturedBytes, 0x00),
            BitConverter.ToInt32(capturedBytes, 0x0C),
            BitConverter.ToUInt32(capturedBytes, 0x04),
            arguments,
            BitConverter.ToInt32(capturedBytes, 0x08),
            BitConverter.ToInt32(capturedBytes, 0x30),
            BitConverter.ToInt32(capturedBytes, 0x40),
            BitConverter.ToInt32(capturedBytes, 0x58),
            BitConverter.ToUInt32(capturedBytes, 0x44),
            modelEntryArguments,
            BitConverter.ToInt32(capturedBytes, 0x5C),
            BitConverter.ToUInt32(capturedBytes, 0xB0),
            BitConverter.ToInt32(capturedBytes, 0x60),
            BitConverter.ToUInt32(capturedBytes, 0x64),
            BitConverter.ToInt32(capturedBytes, 0x68),
            BitConverter.ToInt32(capturedBytes, 0x70),
            BitConverter.ToInt32(capturedBytes, 0xA0),
            BitConverter.ToUInt32(capturedBytes, 0x74),
            sharedEntryArguments,
            BitConverter.ToInt32(capturedBytes, 0xA4),
            delivery,
            restored);
    }

    private static byte[] BuildInsertionCursorResolverStub(
        nint stubAddress,
        nint dataAddress,
        nint controller,
        nint queueService,
        nint moduleBase)
    {
        var code = new List<byte>(192)
        {
            0x55, 0x8B, 0xEC, // push ebp; mov ebp, esp
            0x53, 0x56, 0x57  // preserve ebx, esi, edi
        };
        code.Add(0xBE); // mov esi, controller
        code.AddRange(BitConverter.GetBytes(controller.ToInt32()));
        code.Add(0xBF); // mov edi, queue service
        code.AddRange(BitConverter.GetBytes(queueService.ToInt32()));

        code.AddRange([0x8B, 0xCF, 0x8B, 0x07]); // ecx=edi; eax=[edi]
        code.AddRange([0xFF, 0x50, 0x04]); // call [eax+4]
        AppendStoreEaxAbsolute(code, nint.Add(dataAddress, 0x08));

        code.AddRange([0x8B, 0xCF, 0x8B, 0x07]);
        code.AddRange([0x8B, 0x40, 0x54]); // eax=[vtable+54]
        AppendStoreEaxAbsolute(code, nint.Add(dataAddress, 0x24));
        code.Add(0x68); // push &resolved variant
        code.AddRange(BitConverter.GetBytes(nint.Add(dataAddress, 0x0C).ToInt32()));
        code.AddRange([0xFF, 0xD0]); // call eax

        code.Add(0xB9); // mov ecx, &variant
        code.AddRange(BitConverter.GetBytes(nint.Add(dataAddress, 0x0C).ToInt32()));
        AppendRelativeCall(
            code,
            stubAddress,
            nint.Add(moduleBase, VariantOwnerGetterRva));
        AppendStoreEaxAbsolute(code, nint.Add(dataAddress, 0x14));

        code.Add(0xB9);
        code.AddRange(BitConverter.GetBytes(nint.Add(dataAddress, 0x0C).ToInt32()));
        AppendRelativeCall(
            code,
            stubAddress,
            nint.Add(moduleBase, VariantIndexGetterRva));
        AppendStoreEaxAbsolute(code, nint.Add(dataAddress, 0x18));

        code.AddRange([0x8B, 0xCE]); // mov ecx, esi
        AppendRelativeCall(
            code,
            stubAddress,
            nint.Add(moduleBase, QueueCountGetterRva));
        AppendStoreEaxAbsolute(code, nint.Add(dataAddress, 0x1C));

        code.AddRange([0x8B, 0x0D]); // mov ecx, [variant control block]
        code.AddRange(BitConverter.GetBytes(nint.Add(dataAddress, 0x10).ToInt32()));
        code.AddRange([0x85, 0xC9]); // test ecx, ecx
        var skipReleaseJump = code.Count;
        code.AddRange([0x74, 0x00]); // jz skip release
        AppendRelativeCall(
            code,
            stubAddress,
            nint.Add(moduleBase, SharedControlReleaseRva));
        code.AddRange([0xC7, 0x05]);
        code.AddRange(BitConverter.GetBytes(nint.Add(dataAddress, 0x28).ToInt32()));
        code.AddRange(BitConverter.GetBytes(1));
        code[skipReleaseJump + 1] = checked((byte)(code.Count - (skipReleaseJump + 2)));

        code.AddRange([0xC7, 0x05]);
        code.AddRange(BitConverter.GetBytes(dataAddress.ToInt32()));
        code.AddRange(BitConverter.GetBytes(1));
        code.AddRange([0x5F, 0x5E, 0x5B, 0x33, 0xC0, 0x5D, 0xC2, 0x04, 0x00]);
        return code.ToArray();
    }

    private static byte[] BuildInsertionCursorCaptureStub(
        nint stubAddress,
        nint captureAddress,
        nint originalCursorGetter,
        nint moduleBase)
    {
        var code = new List<byte>(256)
        {
            0x55, 0x8B, 0xEC,       // push ebp; mov ebp, esp
            0x53, 0x56, 0x57,       // preserve ebx, esi, edi
            0x83, 0xEC, 0x04,       // local sample pointer
            0x8B, 0xF1,             // esi = service this
            0x8B, 0x7D, 0x08,       // edi = variant output
            0x57,                   // push variant output
            0x8B, 0xCE              // ecx = service this
        };
        AppendRelativeCall(code, stubAddress, originalCursorGetter);
        code.AddRange([0x8B, 0xD8]); // preserve original return value

        code.Add(0xA1); // only observe calls gated by the insert entry
        code.AddRange(BitConverter.GetBytes(nint.Add(captureAddress, 4).ToInt32()));
        code.AddRange([0x85, 0xC0]);
        var skipUngatedJump = code.Count;
        code.AddRange([0x0F, 0x84, 0x00, 0x00, 0x00, 0x00]);
        code.Add(0x48);
        code.Add(0xA3);
        code.AddRange(BitConverter.GetBytes(nint.Add(captureAddress, 4).ToInt32()));

        code.Add(0xA1); // eax = capture invocation count
        code.AddRange(BitConverter.GetBytes(captureAddress.ToInt32()));
        code.Add(0x40); // increment every invocation, including overflow samples
        code.Add(0xA3);
        code.AddRange(BitConverter.GetBytes(captureAddress.ToInt32()));
        code.Add(0x48); // zero-based sample index
        code.AddRange([0x83, 0xF8, 0x04]); // cmp eax, 4
        var skipCaptureJump = code.Count;
        code.AddRange([0x0F, 0x83, 0x00, 0x00, 0x00, 0x00]);
        code.AddRange([0x6B, 0xC0, 0x30]); // eax *= sample size
        code.Add(0x05); // add sample array base
        code.AddRange(BitConverter.GetBytes(nint.Add(captureAddress, 0x20).ToInt32()));
        code.AddRange([0x89, 0x45, 0xF0]); // [ebp-10h] = sample
        code.AddRange([0x8B, 0x55, 0xF0]);

        code.Add(0xA1); // current 1-based invocation
        code.AddRange(BitConverter.GetBytes(captureAddress.ToInt32()));
        code.AddRange([0x89, 0x02]);
        code.AddRange([0x89, 0x72, 0x04]); // this
        code.AddRange([0x89, 0x7A, 0x08]); // variant address
        code.AddRange([0x8B, 0x46, 0x04, 0x89, 0x42, 0x0C]); // implementation
        code.AddRange([0x85, 0xC0]);
        var noImplementationJump = code.Count;
        code.AddRange([0x74, 0x00]);
        code.AddRange([0x8B, 0x40, 0x38, 0x89, 0x42, 0x10]); // token source
        code.AddRange([0x85, 0xC0]);
        var noTokenJump = code.Count;
        code.AddRange([0x74, 0x00]);
        code.AddRange([0x8B, 0x48, 0x38, 0x89, 0x4A, 0x14]);
        code.AddRange([0x8B, 0x48, 0x3C, 0x89, 0x4A, 0x18]);
        code.AddRange([0x8B, 0x48, 0x40, 0x89, 0x4A, 0x1C]);
        var afterToken = code.Count;
        code[noTokenJump + 1] = checked((byte)(afterToken - (noTokenJump + 2)));
        code[noImplementationJump + 1] = checked((byte)(afterToken - (noImplementationJump + 2)));

        code.AddRange([0x8B, 0x07]);
        code.AddRange([0x89, 0x42, 0x28]); // variant object
        code.AddRange([0x8B, 0x47, 0x04]);
        code.AddRange([0x89, 0x42, 0x2C]); // variant control block

        code.AddRange([0x8B, 0xCF]);
        AppendRelativeCall(
            code,
            stubAddress,
            nint.Add(moduleBase, VariantOwnerGetterRva));
        code.AddRange([0x8B, 0x55, 0xF0, 0x89, 0x42, 0x20]);

        code.AddRange([0x8B, 0xCF]);
        AppendRelativeCall(
            code,
            stubAddress,
            nint.Add(moduleBase, VariantIndexGetterRva));
        code.AddRange([0x8B, 0x55, 0xF0, 0x89, 0x42, 0x24]);

        var skipCaptureTarget = code.Count;
        var skipCaptureDisplacement = BitConverter.GetBytes(
            skipCaptureTarget - (skipCaptureJump + 6));
        var skipUngatedDisplacement = BitConverter.GetBytes(
            skipCaptureTarget - (skipUngatedJump + 6));
        for (var byteIndex = 0; byteIndex < 4; byteIndex++)
        {
            code[skipCaptureJump + 2 + byteIndex] =
                skipCaptureDisplacement[byteIndex];
            code[skipUngatedJump + 2 + byteIndex] =
                skipUngatedDisplacement[byteIndex];
        }
        code.AddRange([
            0x8B, 0xC3,       // restore original return value
            0x83, 0xC4, 0x04,
            0x5F, 0x5E, 0x5B,
            0x5D,
            0xC2, 0x04, 0x00
        ]);
        return code.ToArray();
    }

    private static byte[] BuildInsertCursorMarkerStub(
        nint stubAddress,
        nint markerAddress,
        nint originalInsertFunction)
    {
        var code = new List<byte>(24)
        {
            0x9C,             // preserve flags and eax before tail-call
            0x50,
            0xB8, 0x02, 0x00, 0x00, 0x00,
            0xA3
        };
        code.AddRange(BitConverter.GetBytes(markerAddress.ToInt32()));
        code.AddRange([0x58, 0x9D, 0xE9]);
        var displacement = checked(
            originalInsertFunction.ToInt32()
            - (stubAddress.ToInt32() + code.Count + 4));
        code.AddRange(BitConverter.GetBytes(displacement));
        return code.ToArray();
    }

    private static byte[] BuildModelRecordInsertCaptureStub(
        nint stubAddress,
        nint captureAddress,
        nint originalFunction)
    {
        var code = new List<byte>(160)
        {
            0x55, 0x8B, 0xEC,
            0x53, 0x56, 0x57
        };

        code.Add(0xA1);
        code.AddRange(BitConverter.GetBytes(captureAddress.ToInt32()));
        code.Add(0x40);
        code.Add(0xA3);
        code.AddRange(BitConverter.GetBytes(captureAddress.ToInt32()));
        code.AddRange([0x89, 0x0D]);
        code.AddRange(BitConverter.GetBytes(nint.Add(captureAddress, 4).ToInt32()));

        for (var argumentIndex = 0; argumentIndex < 8; argumentIndex++)
        {
            var sourceOffset = checked((byte)(8 + (argumentIndex * 4)));
            code.AddRange([0x8B, 0x45, sourceOffset]);
            code.Add(0xA3);
            code.AddRange(BitConverter.GetBytes(
                nint.Add(captureAddress, 0x10 + (argumentIndex * 4))
                    .ToInt32()));
        }

        for (var argumentIndex = 8; argumentIndex >= 1; argumentIndex--)
        {
            var sourceOffset = checked((byte)(4 + (argumentIndex * 4)));
            code.AddRange([0xFF, 0x75, sourceOffset]);
        }
        AppendRelativeCall(code, stubAddress, originalFunction);
        AppendStoreEaxAbsolute(code, nint.Add(captureAddress, 0x08));

        code.AddRange([0x8B, 0x55, 0x14]); // argument 4 is the inserted flag
        code.AddRange([0x0F, 0xB6, 0x0A]);
        code.AddRange([0x89, 0x0D]);
        code.AddRange(BitConverter.GetBytes(nint.Add(captureAddress, 0x30).ToInt32()));

        code.Add(0xA1);
        code.AddRange(BitConverter.GetBytes(nint.Add(captureAddress, 0x0C).ToInt32()));
        code.Add(0x40);
        code.Add(0xA3);
        code.AddRange(BitConverter.GetBytes(nint.Add(captureAddress, 0x0C).ToInt32()));
        code.Add(0xA1); // restore the original function's return index
        code.AddRange(BitConverter.GetBytes(nint.Add(captureAddress, 0x08).ToInt32()));
        code.AddRange([0x5F, 0x5E, 0x5B, 0x5D, 0xC2, 0x20, 0x00]);
        return code.ToArray();
    }

    private static byte[] BuildQueueModelEntryCaptureStub(
        nint stubAddress,
        nint captureAddress,
        nint originalFunction)
    {
        var code = new List<byte>(128)
        {
            0x55, 0x8B, 0xEC,
            0x53, 0x56, 0x57
        };

        code.Add(0xA1);
        code.AddRange(BitConverter.GetBytes(
            nint.Add(captureAddress, 0x40).ToInt32()));
        code.Add(0x40);
        code.Add(0xA3);
        code.AddRange(BitConverter.GetBytes(
            nint.Add(captureAddress, 0x40).ToInt32()));
        code.AddRange([0x89, 0x0D]);
        code.AddRange(BitConverter.GetBytes(
            nint.Add(captureAddress, 0x44).ToInt32()));
        code.AddRange([0x8B, 0x45, 0x00, 0x8B, 0x40, 0x04]);
        AppendStoreEaxAbsolute(code, nint.Add(captureAddress, 0xB0));

        for (var argumentIndex = 0; argumentIndex < 4; argumentIndex++)
        {
            var sourceOffset = checked((byte)(8 + (argumentIndex * 4)));
            code.AddRange([0x8B, 0x45, sourceOffset]);
            code.Add(0xA3);
            code.AddRange(BitConverter.GetBytes(
                nint.Add(captureAddress, 0x48 + (argumentIndex * 4))
                    .ToInt32()));
        }

        for (var argumentIndex = 4; argumentIndex >= 1; argumentIndex--)
        {
            var sourceOffset = checked((byte)(4 + (argumentIndex * 4)));
            code.AddRange([0xFF, 0x75, sourceOffset]);
        }
        AppendRelativeCall(code, stubAddress, originalFunction);
        AppendStoreEaxAbsolute(code, nint.Add(captureAddress, 0x5C));

        code.Add(0xA1);
        code.AddRange(BitConverter.GetBytes(
            nint.Add(captureAddress, 0x58).ToInt32()));
        code.Add(0x40);
        code.Add(0xA3);
        code.AddRange(BitConverter.GetBytes(
            nint.Add(captureAddress, 0x58).ToInt32()));
        code.Add(0xA1);
        code.AddRange(BitConverter.GetBytes(
            nint.Add(captureAddress, 0x5C).ToInt32()));
        code.AddRange([0x5F, 0x5E, 0x5B, 0x5D, 0xC2, 0x10, 0x00]);
        return code.ToArray();
    }

    private static byte[] BuildSharedQueueEntryCaptureStub(
        nint stubAddress,
        nint captureAddress,
        nint originalFunction)
    {
        var code = new List<byte>(192)
        {
            0x55, 0x8B, 0xEC,
            0x53, 0x56, 0x57
        };

        code.Add(0xA1);
        code.AddRange(BitConverter.GetBytes(
            nint.Add(captureAddress, 0x70).ToInt32()));
        code.Add(0x40);
        code.Add(0xA3);
        code.AddRange(BitConverter.GetBytes(
            nint.Add(captureAddress, 0x70).ToInt32()));
        code.AddRange([0x89, 0x0D]);
        code.AddRange(BitConverter.GetBytes(
            nint.Add(captureAddress, 0x74).ToInt32()));

        for (var argumentIndex = 0; argumentIndex < 10; argumentIndex++)
        {
            var sourceOffset = checked((byte)(8 + (argumentIndex * 4)));
            code.AddRange([0x8B, 0x45, sourceOffset]);
            code.Add(0xA3);
            code.AddRange(BitConverter.GetBytes(
                nint.Add(captureAddress, 0x78 + (argumentIndex * 4))
                    .ToInt32()));
        }

        for (var argumentIndex = 10; argumentIndex >= 1; argumentIndex--)
        {
            var sourceOffset = checked((byte)(4 + (argumentIndex * 4)));
            code.AddRange([0xFF, 0x75, sourceOffset]);
        }
        AppendRelativeCall(code, stubAddress, originalFunction);
        AppendStoreEaxAbsolute(code, nint.Add(captureAddress, 0xA4));

        code.Add(0xA1);
        code.AddRange(BitConverter.GetBytes(
            nint.Add(captureAddress, 0xA0).ToInt32()));
        code.Add(0x40);
        code.Add(0xA3);
        code.AddRange(BitConverter.GetBytes(
            nint.Add(captureAddress, 0xA0).ToInt32()));
        code.Add(0xA1);
        code.AddRange(BitConverter.GetBytes(
            nint.Add(captureAddress, 0xA4).ToInt32()));
        code.AddRange([0x5F, 0x5E, 0x5B, 0x5D, 0xC2, 0x28, 0x00]);
        return code.ToArray();
    }

    private static byte[] BuildHelperRequestedIndexCaptureStub(
        nint stubAddress,
        nint captureAddress,
        nint originalHelper)
    {
        var code = new List<byte>(48)
        {
            0x9C,
            0x60
        };
        code.Add(0xA1);
        code.AddRange(BitConverter.GetBytes(captureAddress.ToInt32()));
        code.Add(0x40);
        code.Add(0xA3);
        code.AddRange(BitConverter.GetBytes(captureAddress.ToInt32()));
        AppendCaptureDword(code, 0x18, nint.Add(captureAddress, 4));
        AppendCaptureDword(code, 0x28, nint.Add(captureAddress, 8));
        code.AddRange([0x61, 0x9D, 0xE9]);
        var displacement = checked(
            originalHelper.ToInt32()
            - (stubAddress.ToInt32() + code.Count + 4));
        code.AddRange(BitConverter.GetBytes(displacement));
        return code.ToArray();
    }

    private static void AppendStoreEaxAbsolute(
        List<byte> code,
        nint destination)
    {
        code.Add(0xA3);
        code.AddRange(BitConverter.GetBytes(destination.ToInt32()));
    }

    private static void AppendRelativeCall(
        List<byte> code,
        nint stubAddress,
        nint target)
    {
        var callOffset = code.Count;
        code.Add(0xE8);
        var displacement = checked(
            target.ToInt32()
            - (stubAddress.ToInt32() + callOffset + 5));
        code.AddRange(BitConverter.GetBytes(displacement));
    }

    private static byte[] BuildInsertCaptureStub(
        nint stubAddress,
        nint captureAddress,
        nint originalInsertFunction)
    {
        var code = new List<byte>(256)
        {
            0x9C, // pushfd
            0x60  // pushad
        };
        code.Add(0xA1); // mov eax, [capture.count]
        code.AddRange(BitConverter.GetBytes(captureAddress.ToInt32()));
        code.Add(0x40); // inc eax
        code.Add(0xA3); // mov [capture.count], eax
        code.AddRange(BitConverter.GetBytes(captureAddress.ToInt32()));

        AppendCaptureDword(code, 0x18, nint.Add(captureAddress, 4));
        for (var argumentIndex = 1; argumentIndex <= 19; argumentIndex++)
        {
            var stackOffset = checked((byte)(0x24 + (argumentIndex * 4)));
            var destination = nint.Add(
                captureAddress,
                4 + (argumentIndex * 4));
            AppendCaptureDword(code, stackOffset, destination);
        }

        code.Add(0x61); // popad
        code.Add(0x9D); // popfd
        code.Add(0xE9); // jmp original insert function
        var displacement = checked(
            originalInsertFunction.ToInt32()
            - (stubAddress.ToInt32() + code.Count + 4));
        code.AddRange(BitConverter.GetBytes(displacement));
        return code.ToArray();
    }

    private static void AppendCaptureDword(
        List<byte> code,
        byte stackOffset,
        nint destination)
    {
        code.AddRange([0x8B, 0x44, 0x24, stackOffset]);
        code.Add(0xA3);
        code.AddRange(BitConverter.GetBytes(destination.ToInt32()));
    }

    private static IReadOnlyList<KugouQueueObjectDword> ReadDwords(
        SafeProcessHandle processHandle,
        nint address,
        int byteCount)
    {
        var bytes = ReadBytes(processHandle, address, byteCount);
        var result = new List<KugouQueueObjectDword>(byteCount / 4);
        for (var offset = 0; offset < byteCount; offset += 4)
        {
            var value = BitConverter.ToUInt32(bytes, offset);
            result.Add(new KugouQueueObjectDword(
                offset,
                value,
                $"0x{value:X8}"));
        }

        return result;
    }

    public static KugouPromoteQueueItemResult PromoteQueueItemAsNext(
        int songItemId)
    {
        if (songItemId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(songItemId));
        }

        if (IntPtr.Size != 4)
        {
            throw new PlatformNotSupportedException(
                "The KuGou queue mutation probe must run as x86.");
        }

        using var target = FindTarget();
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var modulePath = module.FileName;
        var fileVersion = FileVersionInfo.GetVersionInfo(modulePath).FileVersion
            ?? string.Empty;
        var sha256 = Convert.ToHexString(
            SHA256.HashData(File.ReadAllBytes(modulePath)));
        if (!string.Equals(fileVersion, ExpectedFileVersion, StringComparison.Ordinal)
            || !string.Equals(sha256, ExpectedSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Unsupported KuGou DLL: version={fileVersion}, sha256={sha256}.");
        }

        using var processHandle = OpenProcess(
            ProcessCreateThread
                | ProcessVmOperation
                | ProcessVmRead
                | ProcessVmWrite
                | ProcessQueryInformation,
            false,
            target.Id);
        if (processHandle.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        var moduleBase = module.BaseAddress;
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, GetServiceRootRva),
            ExpectedGetServiceRoot,
            "GetServiceRoot");
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, GetUiQueueServiceRva),
            ExpectedGetUiQueueService,
            "GetUiQueueService");
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, PromoteAsNextRva),
            ExpectedPromoteAsNext,
            "PromoteAsNext");

        var remoteBlock = VirtualAllocEx(
            processHandle,
            0,
            0x1000,
            MemCommit | MemReserve,
            PageExecuteReadWrite);
        if (remoteBlock == 0)
        {
            throw CreateWin32Exception("VirtualAllocEx");
        }

        try
        {
            var dataAddress = nint.Add(remoteBlock, DataOffset);
            WriteBytes(
                processHandle,
                remoteBlock,
                BuildPromoteAsNextStub(
                    dataAddress,
                    moduleBase,
                    songItemId));
            WriteBytes(processHandle, dataAddress, new byte[0x80]);

            using var thread = CreateRemoteThread(
                processHandle,
                0,
                0,
                remoteBlock,
                0,
                0,
                out _);
            if (thread.IsInvalid)
            {
                throw CreateWin32Exception("CreateRemoteThread");
            }

            var waitResult = WaitForSingleObject(thread, 3000);
            if (waitResult == WaitTimeout)
            {
                throw new TimeoutException(
                    "KuGou PromoteAsNext did not return within 3 seconds.");
            }

            if (waitResult != WaitObject0)
            {
                throw CreateWin32Exception("WaitForSingleObject");
            }

            var data = ReadBytes(processHandle, dataAddress, 24);
            return new KugouPromoteQueueItemResult(
                target.Id,
                fileVersion,
                sha256,
                songItemId,
                BitConverter.ToInt32(data, 0),
                BitConverter.ToInt32(data, 16) != 0,
                BitConverter.ToInt32(data, 4),
                BitConverter.ToInt32(data, 8),
                BitConverter.ToInt32(data, 12));
        }
        finally
        {
            if (!VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease))
            {
                throw CreateWin32Exception("VirtualFreeEx");
            }
        }
    }

    public static KugouResetInsertionAnchorResult ResetInsertionAnchor()
    {
        if (IntPtr.Size != 4)
        {
            throw new PlatformNotSupportedException(
                "The KuGou insertion-anchor reset must run as x86.");
        }

        using var target = FindTarget();
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var modulePath = module.FileName;
        var fileVersion = FileVersionInfo.GetVersionInfo(modulePath).FileVersion
            ?? string.Empty;
        var sha256 = Convert.ToHexString(
            SHA256.HashData(File.ReadAllBytes(modulePath)));
        if (!string.Equals(fileVersion, ExpectedFileVersion, StringComparison.Ordinal)
            || !string.Equals(sha256, ExpectedSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Unsupported KuGou DLL: version={fileVersion}, sha256={sha256}.");
        }

        var expectedVtable = nint.Add(
            module.BaseAddress,
            InsertionAnchorVtableRva);
        var objectAddresses = KugouProcessHashScanner.FindDwordAddresses(
            checked((int)expectedVtable.ToInt64()));

        using var processHandle = OpenProcess(
            ProcessVmOperation
                | ProcessVmRead
                | ProcessVmWrite
                | ProcessQueryInformation,
            false,
            target.Id);
        if (processHandle.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        var objects = new List<KugouInsertionAnchorObject>();
        foreach (var address in objectAddresses)
        {
            try
            {
                var bytes = ReadBytes(processHandle, (nint)address, 24);
                var cursor = BitConverter.ToInt32(bytes, 4);
                var current = BitConverter.ToInt32(bytes, 8);
                var begin = BitConverter.ToInt32(bytes, 12);
                var end = BitConverter.ToInt32(bytes, 16);
                var capacity = BitConverter.ToInt32(bytes, 20);
                if (cursor is < -1 or > 100_000
                    || current is < -1 or > 100_000
                    || begin < 0x10000
                    || end < begin
                    || capacity < end
                    || end - begin > 4 * 100_000
                    || capacity - begin > 4 * 100_000
                    || (end - begin) % 4 != 0
                    || (capacity - begin) % 4 != 0)
                {
                    continue;
                }

                objects.Add(new KugouInsertionAnchorObject(
                    address,
                    cursor,
                    current,
                    begin,
                    end,
                    capacity));
            }
            catch (Win32Exception)
            {
                // A stale allocation disappeared during the scan.
            }
        }

        var activeObjects = objects
            .Where(candidate =>
                candidate.InsertCursor != candidate.CurrentIndex
                && candidate.QueueEnd > candidate.QueueBegin)
            .OrderBy(candidate => candidate.QueueEnd - candidate.QueueBegin)
            .ToArray();
        var queue = activeObjects.FirstOrDefault();
        var queueSizeIsUnique = queue is not null
            && (activeObjects.Length == 1
                || activeObjects[1].QueueEnd - activeObjects[1].QueueBegin
                    > queue.QueueEnd - queue.QueueBegin);
        if (queue is null || !queueSizeIsUnique)
        {
            return new KugouResetInsertionAnchorResult(
                target.Id,
                fileVersion,
                sha256,
                expectedVtable.ToInt64(),
                objects,
                false,
                0,
                0,
                0);
        }

        WriteBytes(
            processHandle,
            (nint)(queue.Address + 4),
            BitConverter.GetBytes(queue.CurrentIndex));
        var cursorAfter = BitConverter.ToInt32(
            ReadBytes(processHandle, (nint)(queue.Address + 4), 4),
            0);
        return new KugouResetInsertionAnchorResult(
            target.Id,
            fileVersion,
            sha256,
            expectedVtable.ToInt64(),
            objects,
            cursorAfter == queue.CurrentIndex,
            queue.InsertCursor,
            queue.CurrentIndex,
            cursorAfter);
    }

    public static KugouInsertionAnchorSnapshot CaptureInsertionAnchors()
    {
        if (IntPtr.Size != 4)
        {
            throw new PlatformNotSupportedException(
                "The KuGou insertion-anchor probe must run as x86.");
        }

        using var target = FindTarget();
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var modulePath = module.FileName;
        var fileVersion = FileVersionInfo.GetVersionInfo(modulePath).FileVersion
            ?? string.Empty;
        var sha256 = Convert.ToHexString(
            SHA256.HashData(File.ReadAllBytes(modulePath)));
        VerifySupportedVersion(fileVersion, sha256);

        var expectedVtable = nint.Add(
            module.BaseAddress,
            InsertionAnchorVtableRva).ToInt64();
        var objectAddresses = KugouProcessHashScanner.FindDwordAddresses(
            checked((int)expectedVtable));

        using var processHandle = OpenProcess(
            ProcessVmRead | ProcessQueryInformation,
            false,
            target.Id);
        if (processHandle.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        return new KugouInsertionAnchorSnapshot(
            target.Id,
            fileVersion,
            sha256,
            expectedVtable,
            ReadInsertionAnchorObjects(
                processHandle,
                objectAddresses,
                expectedVtable));
    }

    public static IReadOnlyList<KugouInsertionAnchorObject>
        RefreshInsertionAnchors(KugouInsertionAnchorSnapshot snapshot)
    {
        using var target = FindTarget();
        if (target.Id != snapshot.ProcessId)
        {
            throw new InvalidOperationException(
                "KuGou restarted while the insertion-anchor probe was running.");
        }

        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var expectedVtable = nint.Add(
            module.BaseAddress,
            InsertionAnchorVtableRva).ToInt64();
        if (expectedVtable != snapshot.ExpectedVtable)
        {
            throw new InvalidOperationException(
                "KuGou module base changed while probing the insertion anchor.");
        }

        using var processHandle = OpenProcess(
            ProcessVmRead | ProcessQueryInformation,
            false,
            target.Id);
        if (processHandle.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        return ReadInsertionAnchorObjects(
            processHandle,
            snapshot.Objects.Select(candidate => candidate.Address),
            expectedVtable);
    }

    public static KugouResetInsertionAnchorResult ResetInsertionAnchorAt(
        KugouInsertionAnchorSnapshot snapshot,
        long objectAddress)
    {
        using var target = FindTarget();
        if (target.Id != snapshot.ProcessId)
        {
            throw new InvalidOperationException(
                "KuGou restarted before the insertion anchor could be reset.");
        }

        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var modulePath = module.FileName;
        var fileVersion = FileVersionInfo.GetVersionInfo(modulePath).FileVersion
            ?? string.Empty;
        var sha256 = Convert.ToHexString(
            SHA256.HashData(File.ReadAllBytes(modulePath)));
        VerifySupportedVersion(fileVersion, sha256);

        var expectedVtable = nint.Add(
            module.BaseAddress,
            InsertionAnchorVtableRva).ToInt64();
        if (expectedVtable != snapshot.ExpectedVtable
            || !snapshot.Objects.Any(candidate =>
                candidate.Address == objectAddress))
        {
            throw new InvalidOperationException(
                "The requested insertion-anchor object did not belong to the captured snapshot.");
        }

        using var processHandle = OpenProcess(
            ProcessVmOperation
                | ProcessVmRead
                | ProcessVmWrite
                | ProcessQueryInformation,
            false,
            target.Id);
        if (processHandle.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        var objects = ReadInsertionAnchorObjects(
            processHandle,
            [objectAddress],
            expectedVtable);
        var queue = objects.SingleOrDefault();
        if (queue is null
            || queue.InsertCursor == queue.CurrentIndex
            || queue.QueueEnd <= queue.QueueBegin)
        {
            return new KugouResetInsertionAnchorResult(
                target.Id,
                fileVersion,
                sha256,
                expectedVtable,
                objects,
                false,
                queue?.InsertCursor ?? 0,
                queue?.CurrentIndex ?? 0,
                queue?.InsertCursor ?? 0);
        }

        WriteBytes(
            processHandle,
            (nint)(objectAddress + 4),
            BitConverter.GetBytes(queue.CurrentIndex));
        var cursorAfter = BitConverter.ToInt32(
            ReadBytes(processHandle, (nint)(objectAddress + 4), 4),
            0);
        return new KugouResetInsertionAnchorResult(
            target.Id,
            fileVersion,
            sha256,
            expectedVtable,
            objects,
            cursorAfter == queue.CurrentIndex,
            queue.InsertCursor,
            queue.CurrentIndex,
            cursorAfter);
    }

    private static IReadOnlyList<KugouInsertionAnchorObject>
        ReadInsertionAnchorObjects(
            SafeProcessHandle processHandle,
            IEnumerable<long> objectAddresses,
            long expectedVtable)
    {
        var objects = new List<KugouInsertionAnchorObject>();
        foreach (var address in objectAddresses.Distinct())
        {
            try
            {
                var bytes = ReadBytes(processHandle, (nint)address, 24);
                if (BitConverter.ToInt32(bytes, 0)
                    != checked((int)expectedVtable))
                {
                    continue;
                }

                var cursor = BitConverter.ToInt32(bytes, 4);
                var current = BitConverter.ToInt32(bytes, 8);
                var begin = BitConverter.ToInt32(bytes, 12);
                var end = BitConverter.ToInt32(bytes, 16);
                var capacity = BitConverter.ToInt32(bytes, 20);
                if (cursor is < -1 or > 100_000
                    || current is < -1 or > 100_000
                    || begin < 0x10000
                    || end < begin
                    || capacity < end
                    || end - begin > 4 * 100_000
                    || capacity - begin > 4 * 100_000
                    || (end - begin) % 4 != 0
                    || (capacity - begin) % 4 != 0)
                {
                    continue;
                }

                objects.Add(new KugouInsertionAnchorObject(
                    address,
                    cursor,
                    current,
                    begin,
                    end,
                    capacity));
            }
            catch (Win32Exception)
            {
                // Ignore an allocation that was released during the refresh.
            }
        }

        return objects;
    }

    private static void VerifySupportedVersion(
        string fileVersion,
        string sha256)
    {
        if (!string.Equals(
                fileVersion,
                ExpectedFileVersion,
                StringComparison.Ordinal)
            || !string.Equals(
                sha256,
                ExpectedSha256,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Unsupported KuGou DLL: version={fileVersion}, sha256={sha256}.");
        }
    }

    public static KugouUiQueuePositionProbeResult ReadUiQueuePosition()
    {
        if (IntPtr.Size != 4)
        {
            throw new PlatformNotSupportedException(
                "酷狗队列位置探针必须使用 x86 POC 运行。");
        }

        using var target = FindTarget();
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var modulePath = module.FileName;
        var fileVersion = FileVersionInfo.GetVersionInfo(modulePath).FileVersion
            ?? string.Empty;
        var sha256 = Convert.ToHexString(
            SHA256.HashData(File.ReadAllBytes(modulePath)));
        if (!string.Equals(fileVersion, ExpectedFileVersion, StringComparison.Ordinal)
            || !string.Equals(sha256, ExpectedSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"酷狗 DLL 未通过精确版本校验：version={fileVersion}, sha256={sha256}。");
        }

        using var processHandle = OpenProcess(
            ProcessCreateThread
                | ProcessVmOperation
                | ProcessVmRead
                | ProcessVmWrite
                | ProcessQueryInformation,
            false,
            target.Id);
        if (processHandle.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        var moduleBase = module.BaseAddress;
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, GetServiceRootRva),
            ExpectedGetServiceRoot,
            "GetServiceRoot");
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, GetUiQueueServiceRva),
            ExpectedGetUiQueueService,
            "GetUiQueueService");
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, ReadUiItemIndex44Rva),
            ExpectedUiItemIndexGetter,
            "ReadUiItemIndex44");
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, ReadUiItemIndex48Rva),
            ExpectedUiItemIndexGetter,
            "ReadUiItemIndex48");

        var remoteBlock = VirtualAllocEx(
            processHandle,
            0,
            0x1000,
            MemCommit | MemReserve,
            PageExecuteReadWrite);
        if (remoteBlock == 0)
        {
            throw CreateWin32Exception("VirtualAllocEx");
        }

        try
        {
            var dataAddress = nint.Add(remoteBlock, DataOffset);
            WriteBytes(
                processHandle,
                remoteBlock,
                BuildUiPositionProbeStub(dataAddress, moduleBase));
            WriteBytes(processHandle, dataAddress, new byte[32]);

            using var thread = CreateRemoteThread(
                processHandle,
                0,
                0,
                remoteBlock,
                0,
                0,
                out _);
            if (thread.IsInvalid)
            {
                throw CreateWin32Exception("CreateRemoteThread");
            }

            var waitResult = WaitForSingleObject(thread, 3000);
            if (waitResult == WaitTimeout)
            {
                throw new TimeoutException("酷狗队列位置查询在 3 秒内没有返回。");
            }

            if (waitResult != WaitObject0)
            {
                throw CreateWin32Exception("WaitForSingleObject");
            }

            var data = ReadBytes(processHandle, dataAddress, 20);
            return new KugouUiQueuePositionProbeResult(
                target.Id,
                fileVersion,
                sha256,
                BitConverter.ToInt32(data, 0),
                BitConverter.ToInt32(data, 4),
                BitConverter.ToInt32(data, 8),
                BitConverter.ToInt32(data, 12));
        }
        finally
        {
            if (!VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease))
            {
                throw CreateWin32Exception("VirtualFreeEx");
            }
        }
    }

    public static KugouQueueHashQueryResult QueryQueueIdsByHash(
        string hash,
        int modelType = 6,
        int vtableOffset = 0xA8)
    {
        hash = hash.Trim();
        if (hash.Length != 32)
        {
            throw new ArgumentException(
                "酷狗歌曲 hash 必须是 32 位十六进制字符串。",
                nameof(hash));
        }

        byte[] hashBytes;
        try
        {
            hashBytes = Convert.FromHexString(hash);
        }
        catch (FormatException exception)
        {
            throw new ArgumentException(
                "酷狗歌曲 hash 包含非十六进制字符。",
                nameof(hash),
                exception);
        }

        if (IntPtr.Size != 4)
        {
            throw new PlatformNotSupportedException(
                "酷狗队列探针必须使用 x86 POC 运行。");
        }

        var queryThunkRva = vtableOffset switch
        {
            0xA8 => GetIdsByHashThunkRva,
            0xAC => AlternateHashQueryThunkRva,
            _ => throw new ArgumentOutOfRangeException(
                nameof(vtableOffset),
                "只允许测试已验证签名的 0xA8 或 0xAC 槽位。")
        };

        using var target = FindTarget();
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var modulePath = module.FileName;
        var fileVersion = FileVersionInfo.GetVersionInfo(modulePath).FileVersion
            ?? string.Empty;
        var sha256 = Convert.ToHexString(
            SHA256.HashData(File.ReadAllBytes(modulePath)));
        if (!string.Equals(
                fileVersion,
                ExpectedFileVersion,
                StringComparison.Ordinal)
            || !string.Equals(
                sha256,
                ExpectedSha256,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"酷狗 DLL 未通过精确版本校验：version={fileVersion}, "
                + $"sha256={sha256}。");
        }

        using var processHandle = OpenProcess(
            ProcessCreateThread
                | ProcessVmOperation
                | ProcessVmRead
                | ProcessVmWrite
                | ProcessQueryInformation,
            false,
            target.Id);
        if (processHandle.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        var moduleBase = module.BaseAddress;
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, GetServiceRootRva),
            ExpectedGetServiceRoot,
            "GetServiceRoot");
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, GetUiQueueServiceRva),
            ExpectedGetUiQueueService,
            "GetUiQueueService");

        var remoteBlock = VirtualAllocEx(
            processHandle,
            0,
            0x1000,
            MemCommit | MemReserve,
            PageExecuteReadWrite);
        if (remoteBlock == 0)
        {
            throw CreateWin32Exception("VirtualAllocEx");
        }

        try
        {
            var dataAddress = nint.Add(remoteBlock, DataOffset);
            WriteBytes(
                processHandle,
                remoteBlock,
                BuildHashQueryStub(
                    dataAddress,
                    moduleBase,
                    modelType,
                    vtableOffset,
                    queryThunkRva));
            WriteBytes(processHandle, dataAddress, new byte[0x840]);
            WriteBytes(
                processHandle,
                nint.Add(dataAddress, 0x10),
                hashBytes);

            using var thread = CreateRemoteThread(
                processHandle,
                0,
                0,
                remoteBlock,
                0,
                0,
                out _);
            if (thread.IsInvalid)
            {
                throw CreateWin32Exception("CreateRemoteThread");
            }

            var waitResult = WaitForSingleObject(thread, 3000);
            if (waitResult == WaitTimeout)
            {
                throw new TimeoutException(
                    "酷狗队列 hash 查询在 3 秒内没有返回。");
            }

            if (waitResult != WaitObject0)
            {
                throw CreateWin32Exception("WaitForSingleObject");
            }

            var header = ReadBytes(processHandle, dataAddress, 0x40);
            var stage = BitConverter.ToInt32(header, 0);
            var querySucceeded = BitConverter.ToInt32(header, 4) != 0;
            var model = (nint)BitConverter.ToInt32(header, 8);
            var begin = (nint)BitConverter.ToInt32(header, 0x20);
            var end = (nint)BitConverter.ToInt32(header, 0x24);
            var capacity = (nint)BitConverter.ToInt32(header, 0x28);
            var expectedBegin = nint.Add(dataAddress, 0x40);
            var expectedCapacity = nint.Add(expectedBegin, 0x800);
            if (stage != 3)
            {
                throw new InvalidOperationException(
                    $"酷狗队列 hash 查询未就绪，stage={stage}。");
            }

            if (begin != expectedBegin
                || capacity != expectedCapacity
                || end.ToInt64() < begin.ToInt64()
                || end.ToInt64() > capacity.ToInt64()
                || (end.ToInt64() - begin.ToInt64()) % 4 != 0)
            {
                throw new InvalidOperationException(
                    "酷狗队列 hash 查询返回了无效的 vector<int> 范围；"
                    + "为避免远程内存泄漏，已拒绝继续读取。");
            }

            var itemCount = checked((int)(
                (end.ToInt64() - begin.ToInt64()) / 4));
            var itemBytes = itemCount == 0
                ? []
                : ReadBytes(processHandle, begin, itemCount * 4);
            var queueItemIds = Enumerable.Range(0, itemCount)
                .Select(index => BitConverter.ToInt32(itemBytes, index * 4))
                .ToArray();
            var modelVtable = model == 0
                ? 0
                : ReadPointer(processHandle, model);
            var queryFunction = modelVtable == 0
                ? 0
                : ReadPointer(
                    processHandle,
                    nint.Add(modelVtable, vtableOffset));

            return new KugouQueueHashQueryResult(
                target.Id,
                fileVersion,
                sha256,
                modelType,
                hash.ToUpperInvariant(),
                vtableOffset,
                stage,
                querySucceeded,
                model.ToInt64(),
                modelVtable.ToInt64(),
                queryFunction.ToInt64(),
                queueItemIds);
        }
        finally
        {
            if (!VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease))
            {
                throw CreateWin32Exception("VirtualFreeEx");
            }
        }
    }

    private static KugouQueueNativeProbeResult InspectControllerCore(
        bool useUiQueueInterface)
    {
        if (IntPtr.Size != 4)
        {
            throw new PlatformNotSupportedException(
                "酷狗队列探针必须由 x86 POC 运行。");
        }

        using var target = FindTarget();
        var module = target.Modules.Cast<ProcessModule>()
            .Single(candidate => candidate.ModuleName.Equals(
                "kugou.dll",
                StringComparison.OrdinalIgnoreCase));
        var modulePath = module.FileName;
        var fileVersion = FileVersionInfo.GetVersionInfo(modulePath).FileVersion
            ?? string.Empty;
        var sha256 = Convert.ToHexString(
            SHA256.HashData(File.ReadAllBytes(modulePath)));
        if (!string.Equals(
                fileVersion,
                ExpectedFileVersion,
                StringComparison.Ordinal)
            || !string.Equals(
                sha256,
                ExpectedSha256,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"酷狗 DLL 未通过精确版本校验：version={fileVersion}, sha256={sha256}。");
        }

        using var processHandle = OpenProcess(
            ProcessCreateThread
                | ProcessVmOperation
                | ProcessVmRead
                | ProcessVmWrite
                | ProcessQueryInformation,
            false,
            target.Id);
        if (processHandle.IsInvalid)
        {
            throw CreateWin32Exception("OpenProcess");
        }

        var moduleBase = module.BaseAddress;
        VerifyBytes(
            processHandle,
            nint.Add(moduleBase, GetServiceRootRva),
            ExpectedGetServiceRoot,
            "GetServiceRoot");
        if (useUiQueueInterface)
        {
            VerifyBytes(
                processHandle,
                nint.Add(moduleBase, GetUiQueueServiceRva),
                ExpectedGetUiQueueService,
                "GetUiQueueService");
        }
        else
        {
            VerifyBytes(
                processHandle,
                nint.Add(moduleBase, GetQueueControllerRva),
                ExpectedGetQueueController,
                "GetQueueController");
        }

        var remoteBlock = VirtualAllocEx(
            processHandle,
            0,
            0x1000,
            MemCommit | MemReserve,
            PageExecuteReadWrite);
        if (remoteBlock == 0)
        {
            throw CreateWin32Exception("VirtualAllocEx");
        }

        try
        {
            var dataAddress = nint.Add(remoteBlock, DataOffset);
            WriteBytes(
                processHandle,
                remoteBlock,
                useUiQueueInterface
                    ? BuildUiResolverStub(dataAddress, moduleBase)
                    : BuildResolverStub(dataAddress, moduleBase));
            WriteBytes(processHandle, dataAddress, new byte[32]);

            using var thread = CreateRemoteThread(
                processHandle,
                0,
                0,
                remoteBlock,
                0,
                0,
                out _);
            if (thread.IsInvalid)
            {
                throw CreateWin32Exception("CreateRemoteThread");
            }

            var waitResult = WaitForSingleObject(thread, 3000);
            if (waitResult == WaitTimeout)
            {
                throw new TimeoutException("酷狗队列控制器探针 3 秒内没有返回。");
            }

            if (waitResult != WaitObject0)
            {
                throw CreateWin32Exception("WaitForSingleObject");
            }

            var data = ReadBytes(processHandle, dataAddress, 32);
            var stage = BitConverter.ToInt32(data, 0);
            var controller = (nint)BitConverter.ToInt32(data, 4);
            var vtable = (nint)BitConverter.ToInt32(data, 8);
            if (stage != 3 || controller == 0 || vtable == 0)
            {
                throw new InvalidOperationException(
                    $"酷狗队列控制器未就绪：stage={stage}, controller=0x{controller:X}, vtable=0x{vtable:X}。");
            }

            var slots = new List<KugouQueueVtableSlot>();
            for (var offset = 0x250; offset <= 0x340; offset += 4)
            {
                var pointerBytes = ReadBytes(
                    processHandle,
                    nint.Add(vtable, offset),
                    4);
                var address = (nint)BitConverter.ToInt32(pointerBytes, 0);
                if (address == 0)
                {
                    continue;
                }

                var rva64 = address.ToInt64() - moduleBase.ToInt64();
                int? rva = rva64 is >= 0 and <= int.MaxValue
                    ? (int)rva64
                    : null;
                string bytes;
                try
                {
                    bytes = Convert.ToHexString(
                        ReadBytes(processHandle, address, 24));
                }
                catch (Win32Exception)
                {
                    bytes = string.Empty;
                }

                slots.Add(new KugouQueueVtableSlot(
                    offset,
                    address.ToInt64(),
                    rva,
                    bytes));
            }

            var uiQueueHolder = useUiQueueInterface
                ? TryReadPointer(processHandle, nint.Add(controller, 0x48))
                : 0;
            var implementation = useUiQueueInterface
                ? TryReadPointer(processHandle, nint.Add(uiQueueHolder, 4))
                : TryReadPointer(
                    processHandle,
                    nint.Add(controller, 4));
            var nestedObjects = new List<KugouNestedQueueObject>();
            var nestedRoot = implementation;
            var nestedOffsets = useUiQueueInterface
                ? new[] { 0x34, 0x44, 0x48, 0x58, 0x5C }
                : new[] { 0x54, 0x58, 0x68, 0x80, 0xC4, 0x1A8 };
            foreach (var parentOffset in nestedOffsets)
            {
                var pointer = TryReadPointer(
                    processHandle,
                    nint.Add(nestedRoot, parentOffset));
                if (pointer == 0)
                {
                    continue;
                }

                var directVtable = TryReadPointer(processHandle, pointer);
                var plusFourVtable = TryReadPointer(
                    processHandle,
                    nint.Add(pointer, 4));
                nestedObjects.Add(new KugouNestedQueueObject(
                    parentOffset,
                    pointer.ToInt64(),
                    directVtable.ToInt64(),
                    plusFourVtable.ToInt64(),
                    TryReadSlot(processHandle, moduleBase, directVtable, 0x94),
                    TryReadSlot(processHandle, moduleBase, directVtable, 0x2F0),
                    TryReadSlot(processHandle, moduleBase, plusFourVtable, 0x94),
                    TryReadSlot(processHandle, moduleBase, plusFourVtable, 0x2F0)));
            }

            return new KugouQueueNativeProbeResult(
                target.Id,
                modulePath,
                fileVersion,
                sha256,
                moduleBase.ToInt64(),
                controller.ToInt64(),
                vtable.ToInt64(),
                stage,
                slots,
                implementation.ToInt64(),
                nestedObjects);
        }
        finally
        {
            if (!VirtualFreeEx(processHandle, remoteBlock, 0, MemRelease))
            {
                throw CreateWin32Exception("VirtualFreeEx");
            }
        }
    }

    private static Process FindTarget()
    {
        var matches = new List<Process>();
        foreach (var process in Process.GetProcessesByName("KuGou"))
        {
            try
            {
                if (process.Modules.Cast<ProcessModule>().Any(module =>
                        module.ModuleName.Equals(
                            "kugou.dll",
                            StringComparison.OrdinalIgnoreCase)))
                {
                    matches.Add(process);
                }
                else
                {
                    process.Dispose();
                }
            }
            catch (Exception exception)
                when (exception is Win32Exception
                    or InvalidOperationException)
            {
                process.Dispose();
            }
        }

        if (matches.Count == 0)
        {
            throw new InvalidOperationException(
                "没有找到已经加载 kugou.dll 的酷狗主进程。");
        }

        var selected = matches
            .OrderByDescending(process => process.MainWindowHandle != 0)
            .ThenByDescending(process => TryGetWorkingSet(process))
            .First();
        foreach (var process in matches)
        {
            if (!ReferenceEquals(process, selected))
            {
                process.Dispose();
            }
        }

        return selected;
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

    private static byte[] BuildResolverStub(
        nint dataAddress,
        nint moduleBase)
    {
        var data = checked((uint)dataAddress.ToInt64());
        var getRoot = checked((uint)nint.Add(
            moduleBase,
            GetServiceRootRva).ToInt64());
        var getController = checked((uint)nint.Add(
            moduleBase,
            GetQueueControllerRva).ToInt64());
        var bytes = new List<byte>(96)
        {
            0x55, 0x8B, 0xEC, 0x53, 0x56, 0x57,
            0xBF
        };
        AddUInt32(bytes, data);
        bytes.AddRange([0xC7, 0x07]);
        AddUInt32(bytes, 1);
        bytes.Add(0xB8);
        AddUInt32(bytes, getRoot);
        bytes.AddRange([0xFF, 0xD0, 0x85, 0xC0, 0x74, 0x25]);
        bytes.AddRange([0xC7, 0x07]);
        AddUInt32(bytes, 2);
        bytes.AddRange([0x8B, 0xC8, 0xB8]);
        AddUInt32(bytes, getController);
        bytes.AddRange([0xFF, 0xD0, 0x89, 0x47, 0x04]);
        bytes.AddRange([0x85, 0xC0, 0x74, 0x12, 0x8B, 0x08]);
        bytes.AddRange([0x89, 0x4F, 0x08, 0xC7, 0x07]);
        AddUInt32(bytes, 3);
        bytes.AddRange([
            0x33, 0xC0, 0x5F, 0x5E, 0x5B,
            0x8B, 0xE5, 0x5D, 0xC2, 0x04, 0x00
        ]);
        return bytes.ToArray();
    }

    private static byte[] BuildUiResolverStub(
        nint dataAddress,
        nint moduleBase)
    {
        var data = checked((uint)dataAddress.ToInt64());
        var getRoot = checked((uint)nint.Add(
            moduleBase,
            GetServiceRootRva).ToInt64());
        var getUiQueueService = checked((uint)nint.Add(
            moduleBase,
            GetUiQueueServiceRva).ToInt64());
        var bytes = new List<byte>(96)
        {
            0x55, 0x8B, 0xEC, 0x53, 0x56, 0x57,
            0xBF
        };
        AddUInt32(bytes, data);
        bytes.AddRange([0xC7, 0x07]);
        AddUInt32(bytes, 1);
        bytes.Add(0xB8);
        AddUInt32(bytes, getRoot);
        bytes.AddRange([0xFF, 0xD0, 0x85, 0xC0, 0x74, 0x2C]);
        bytes.AddRange([0xC7, 0x07]);
        AddUInt32(bytes, 2);
        bytes.AddRange([0x8B, 0xC8, 0xB8]);
        AddUInt32(bytes, getUiQueueService);
        bytes.AddRange([
            0xFF, 0xD0, 0x85, 0xC0, 0x74, 0x19,
            0x8B, 0xC8, 0x8B, 0x10, 0xFF, 0x52, 0x0C,
            0x89, 0x47, 0x04, 0x85, 0xC0, 0x74, 0x0B,
            0x8B, 0x08, 0x89, 0x4F, 0x08,
            0xC7, 0x07
        ]);
        AddUInt32(bytes, 3);
        bytes.AddRange([
            0x33, 0xC0, 0x5F, 0x5E, 0x5B,
            0x8B, 0xE5, 0x5D, 0xC2, 0x04, 0x00
        ]);
        return bytes.ToArray();
    }

    private static byte[] BuildUiPositionProbeStub(
        nint dataAddress,
        nint moduleBase)
    {
        var data = checked((uint)dataAddress.ToInt64());
        var getRoot = checked((uint)nint.Add(
            moduleBase,
            GetServiceRootRva).ToInt64());
        var getUiQueueService = checked((uint)nint.Add(
            moduleBase,
            GetUiQueueServiceRva).ToInt64());
        var readIndex44 = checked((uint)nint.Add(
            moduleBase,
            ReadUiItemIndex44Rva).ToInt64());
        var readIndex48 = checked((uint)nint.Add(
            moduleBase,
            ReadUiItemIndex48Rva).ToInt64());
        var bytes = new List<byte>(160)
        {
            0x55, 0x8B, 0xEC, 0x53, 0x56, 0x57,
            0xBF
        };
        AddUInt32(bytes, data);
        bytes.AddRange([0xC7, 0x07]);
        AddUInt32(bytes, 1);

        var failureJumps = new List<int>();
        bytes.Add(0xB8);
        AddUInt32(bytes, getRoot);
        bytes.AddRange([0xFF, 0xD0, 0x85, 0xC0]);
        AddConditionalJump(bytes, 0x84, failureJumps);
        bytes.AddRange([0x8B, 0xC8, 0xB8]);
        AddUInt32(bytes, getUiQueueService);
        bytes.AddRange([0xFF, 0xD0, 0x85, 0xC0]);
        AddConditionalJump(bytes, 0x84, failureJumps);
        bytes.AddRange([
            0x8B, 0xC8, 0x8B, 0x10, 0xFF, 0x52, 0x0C,
            0x85, 0xC0
        ]);
        AddConditionalJump(bytes, 0x84, failureJumps);
        bytes.AddRange([0x89, 0x47, 0x04, 0x8B, 0xC8, 0xB8]);
        AddUInt32(bytes, readIndex44);
        bytes.AddRange([0xFF, 0xD0, 0x89, 0x47, 0x08]);
        bytes.AddRange([0x8B, 0x4F, 0x04, 0xB8]);
        AddUInt32(bytes, readIndex48);
        bytes.AddRange([0xFF, 0xD0, 0x89, 0x47, 0x0C]);
        bytes.AddRange([0xC7, 0x07]);
        AddUInt32(bytes, 3);
        bytes.Add(0xE9);
        var successExitJump = bytes.Count;
        AddUInt32(bytes, 0);

        var failureOffset = bytes.Count;
        bytes.AddRange([0xC7, 0x07]);
        AddUInt32(bytes, unchecked((uint)-1));
        var exitOffset = bytes.Count;
        bytes.AddRange([
            0x33, 0xC0, 0x5F, 0x5E, 0x5B,
            0x8B, 0xE5, 0x5D, 0xC2, 0x04, 0x00
        ]);

        foreach (var displacementOffset in failureJumps)
        {
            PatchRelativeJump(bytes, displacementOffset, failureOffset);
        }

        PatchRelativeJump(bytes, successExitJump, exitOffset);
        return bytes.ToArray();
    }

    private static byte[] BuildPromoteAsNextStub(
        nint dataAddress,
        nint moduleBase,
        int songItemId)
    {
        var data = checked((uint)dataAddress.ToInt64());
        var vector = checked(data + 0x20);
        var item = checked(data + 0x40);
        var getRoot = checked((uint)nint.Add(
            moduleBase,
            GetServiceRootRva).ToInt64());
        var getUiQueueService = checked((uint)nint.Add(
            moduleBase,
            GetUiQueueServiceRva).ToInt64());
        var expectedFunction = checked((uint)nint.Add(
            moduleBase,
            PromoteAsNextRva).ToInt64());
        var bytes = new List<byte>(192)
        {
            0x55, 0x8B, 0xEC, 0x53, 0x56, 0x57,
            0xBF
        };
        AddUInt32(bytes, data);
        bytes.AddRange([0xC7, 0x07]);
        AddUInt32(bytes, 1);

        var failureJumps = new List<int>();
        bytes.Add(0xB8);
        AddUInt32(bytes, getRoot);
        bytes.AddRange([0xFF, 0xD0, 0x85, 0xC0]);
        AddConditionalJump(bytes, 0x84, failureJumps);
        bytes.AddRange([0x8B, 0xC8, 0xB8]);
        AddUInt32(bytes, getUiQueueService);
        bytes.AddRange([0xFF, 0xD0, 0x85, 0xC0]);
        AddConditionalJump(bytes, 0x84, failureJumps);
        bytes.AddRange([
            0x8B, 0xC8, 0x8B, 0x10, 0xFF, 0x52, 0x0C,
            0x85, 0xC0
        ]);
        AddConditionalJump(bytes, 0x84, failureJumps);
        bytes.AddRange([
            0x89, 0x47, 0x04,
            0x8B, 0x08,
            0x89, 0x4F, 0x08,
            0x8B, 0x91
        ]);
        AddUInt32(bytes, 0x2F0);
        bytes.AddRange([0x89, 0x57, 0x0C, 0x81, 0xFA]);
        AddUInt32(bytes, expectedFunction);
        AddConditionalJump(bytes, 0x85, failureJumps);

        bytes.AddRange([0xC7, 0x47, 0x20]);
        AddUInt32(bytes, item);
        bytes.AddRange([0xC7, 0x47, 0x24]);
        AddUInt32(bytes, checked(item + 4));
        bytes.AddRange([0xC7, 0x47, 0x28]);
        AddUInt32(bytes, checked(item + 4));
        bytes.AddRange([0xC7, 0x47, 0x40]);
        AddUInt32(bytes, unchecked((uint)songItemId));

        bytes.AddRange([
            0x6A, 0x10,
            0x6A, 0x01,
            0x8D, 0x47, 0x20,
            0x50,
            0x8B, 0x4F, 0x04,
            0xFF, 0xD2,
            0x0F, 0xB6, 0xC0,
            0x89, 0x47, 0x10,
            0xC7, 0x07
        ]);
        AddUInt32(bytes, 6);
        bytes.Add(0xE9);
        var successExitJump = bytes.Count;
        AddUInt32(bytes, 0);

        var failureOffset = bytes.Count;
        bytes.AddRange([0xC7, 0x07]);
        AddUInt32(bytes, unchecked((uint)-1));
        var exitOffset = bytes.Count;
        bytes.AddRange([
            0x33, 0xC0, 0x5F, 0x5E, 0x5B,
            0x8B, 0xE5, 0x5D, 0xC2, 0x04, 0x00
        ]);

        foreach (var displacementOffset in failureJumps)
        {
            PatchRelativeJump(bytes, displacementOffset, failureOffset);
        }

        PatchRelativeJump(bytes, successExitJump, exitOffset);
        return bytes.ToArray();
    }

    private static byte[] BuildHashQueryStub(
        nint dataAddress,
        nint moduleBase,
        int modelType,
        int vtableOffset,
        int queryThunkRva)
    {
        var data = checked((uint)dataAddress.ToInt64());
        var getRoot = checked((uint)nint.Add(
            moduleBase,
            GetServiceRootRva).ToInt64());
        var getUiQueueService = checked((uint)nint.Add(
            moduleBase,
            GetUiQueueServiceRva).ToInt64());
        var expectedQuery = checked((uint)nint.Add(
            moduleBase,
            queryThunkRva).ToInt64());
        var bytes = new List<byte>(192)
        {
            0x55, 0x8B, 0xEC, 0x53, 0x56, 0x57,
            0xBF
        };
        AddUInt32(bytes, data);
        bytes.AddRange([0xC7, 0x07]);
        AddUInt32(bytes, 1);
        bytes.AddRange([0xC7, 0x47, 0x04]);
        AddUInt32(bytes, 0);

        var failureJumps = new List<int>();
        bytes.Add(0xB8);
        AddUInt32(bytes, getRoot);
        bytes.AddRange([0xFF, 0xD0, 0x85, 0xC0]);
        AddConditionalJump(bytes, 0x84, failureJumps);
        bytes.AddRange([0x8B, 0xC8, 0xB8]);
        AddUInt32(bytes, getUiQueueService);
        bytes.AddRange([0xFF, 0xD0, 0x85, 0xC0]);
        AddConditionalJump(bytes, 0x84, failureJumps);
        bytes.AddRange([
            0x8B, 0xC8, 0x8B, 0x10, 0xFF, 0x52, 0x0C,
            0x85, 0xC0
        ]);
        AddConditionalJump(bytes, 0x84, failureJumps);
        bytes.AddRange([0x8B, 0x40, 0x48, 0x85, 0xC0]);
        AddConditionalJump(bytes, 0x84, failureJumps);
        bytes.AddRange([0x8B, 0x40, 0x04, 0x85, 0xC0]);
        AddConditionalJump(bytes, 0x84, failureJumps);
        bytes.AddRange([0x8B, 0x48, 0x5C, 0x85, 0xC9]);
        AddConditionalJump(bytes, 0x84, failureJumps);
        bytes.AddRange([0x89, 0x4F, 0x08, 0x8B, 0x11]);
        bytes.AddRange([0x81, 0xBA]);
        AddUInt32(bytes, unchecked((uint)vtableOffset));
        AddUInt32(bytes, expectedQuery);
        AddConditionalJump(bytes, 0x85, failureJumps);

        bytes.AddRange([0x8D, 0x47, 0x40]);
        bytes.AddRange([0x89, 0x47, 0x20, 0x89, 0x47, 0x24]);
        bytes.Add(0x05);
        AddUInt32(bytes, 0x800);
        bytes.AddRange([0x89, 0x47, 0x28]);
        bytes.AddRange([0x8D, 0x47, 0x20, 0x50]);
        bytes.AddRange([0x8D, 0x47, 0x10, 0x50]);
        bytes.Add(0x68);
        AddUInt32(bytes, unchecked((uint)modelType));
        bytes.AddRange([
            0x8B, 0x01,
            0xFF, 0x90
        ]);
        AddUInt32(bytes, unchecked((uint)vtableOffset));
        bytes.AddRange([
            0x0F, 0xB6, 0xC0,
            0x89, 0x47, 0x04,
            0xC7, 0x07
        ]);
        AddUInt32(bytes, 3);
        bytes.Add(0xE9);
        var successExitJump = bytes.Count;
        AddUInt32(bytes, 0);

        var failureOffset = bytes.Count;
        bytes.AddRange([0xC7, 0x07]);
        AddUInt32(bytes, unchecked((uint)-1));
        var exitOffset = bytes.Count;
        bytes.AddRange([
            0x33, 0xC0, 0x5F, 0x5E, 0x5B,
            0x8B, 0xE5, 0x5D, 0xC2, 0x04, 0x00
        ]);

        foreach (var displacementOffset in failureJumps)
        {
            PatchRelativeJump(bytes, displacementOffset, failureOffset);
        }

        PatchRelativeJump(bytes, successExitJump, exitOffset);
        return bytes.ToArray();
    }

    private static void AddConditionalJump(
        ICollection<byte> bytes,
        byte condition,
        ICollection<int> displacementOffsets)
    {
        bytes.Add(0x0F);
        bytes.Add(condition);
        displacementOffsets.Add(bytes.Count);
        AddUInt32(bytes, 0);
    }

    private static void PatchRelativeJump(
        IList<byte> bytes,
        int displacementOffset,
        int targetOffset)
    {
        var displacement = targetOffset - (displacementOffset + 4);
        var encoded = BitConverter.GetBytes(displacement);
        for (var index = 0; index < encoded.Length; index++)
        {
            bytes[displacementOffset + index] = encoded[index];
        }
    }

    private static void AddUInt32(ICollection<byte> bytes, uint value)
    {
        foreach (var item in BitConverter.GetBytes(value))
        {
            bytes.Add(item);
        }
    }

    private static void VerifyBytes(
        SafeProcessHandle process,
        nint address,
        byte[] expected,
        string name)
    {
        var actual = ReadBytes(process, address, expected.Length);
        if (!actual.AsSpan().SequenceEqual(expected))
        {
            throw new InvalidOperationException(
                $"{name} 原始机器码不匹配：{Convert.ToHexString(actual)}。");
        }
    }

    private static nint ReadPointer(
        SafeProcessHandle process,
        nint address)
    {
        return (nint)BitConverter.ToInt32(ReadBytes(process, address, 4), 0);
    }

    private static nint TryReadPointer(
        SafeProcessHandle process,
        nint address)
    {
        try
        {
            return ReadPointer(process, address);
        }
        catch (Win32Exception)
        {
            return 0;
        }
    }

    private static KugouQueueVtableSlot? TryReadSlot(
        SafeProcessHandle process,
        nint moduleBase,
        nint vtable,
        int offset)
    {
        if (vtable == 0)
        {
            return null;
        }

        try
        {
            var address = ReadPointer(process, nint.Add(vtable, offset));
            if (address == 0)
            {
                return null;
            }

            var rva64 = address.ToInt64() - moduleBase.ToInt64();
            int? rva = rva64 is >= 0 and <= int.MaxValue
                ? (int)rva64
                : null;
            return new KugouQueueVtableSlot(
                offset,
                address.ToInt64(),
                rva,
                Convert.ToHexString(ReadBytes(process, address, 24)));
        }
        catch (Win32Exception)
        {
            return null;
        }
    }

    private static void WriteBytes(
        SafeProcessHandle process,
        nint address,
        byte[] bytes)
    {
        if (!WriteProcessMemory(
                process,
                address,
                bytes,
                (nuint)bytes.Length,
                out var written)
            || written != (nuint)bytes.Length)
        {
            throw CreateWin32Exception("WriteProcessMemory");
        }
    }

    private static byte[] ReadBytes(
        SafeProcessHandle process,
        nint address,
        int length)
    {
        var buffer = new byte[length];
        if (!ReadProcessMemory(
                process,
                address,
                buffer,
                (nuint)buffer.Length,
                out var read)
            || read != (nuint)buffer.Length)
        {
            throw CreateWin32Exception("ReadProcessMemory");
        }

        return buffer;
    }

    private static Win32Exception CreateWin32Exception(string operation)
    {
        var code = Marshal.GetLastWin32Error();
        return new Win32Exception(
            code,
            $"{operation} 失败：{new Win32Exception(code).Message} (Win32={code})");
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint VirtualAllocEx(
        SafeProcessHandle process,
        nint address,
        nuint size,
        uint allocationType,
        uint protection);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool VirtualFreeEx(
        SafeProcessHandle process,
        nint address,
        nuint size,
        uint freeType);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool VirtualProtectEx(
        SafeProcessHandle process,
        nint address,
        nuint size,
        uint newProtection,
        out uint oldProtection);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeWaitHandle CreateRemoteThread(
        SafeProcessHandle process,
        nint threadAttributes,
        nuint stackSize,
        nint startAddress,
        nint parameter,
        uint creationFlags,
        out uint threadId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(
        SafeWaitHandle handle,
        uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteProcessMemory(
        SafeProcessHandle process,
        nint baseAddress,
        byte[] buffer,
        nuint size,
        out nuint bytesWritten);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadProcessMemory(
        SafeProcessHandle process,
        nint baseAddress,
        [Out] byte[] buffer,
        nuint size,
        out nuint bytesRead);
}
