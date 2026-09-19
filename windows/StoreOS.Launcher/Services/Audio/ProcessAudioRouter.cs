using System.Runtime.InteropServices;

namespace StoreOS.Launcher.Services.Audio;

/// <summary>
/// ตั้ง "ลำโพงของ process" ผ่านนโยบายเสียงของ Windows (หน้า Settings → Volume mixer ใช้กลไกเดียวกัน)
///
/// ใช้กับเพลงร้าน: /player เล่นผ่าน YouTube iframe ใน WebView2 — หน้าเว็บเลือกลำโพงให้ iframe ไม่ได้
/// จึงตั้งลำโพงให้ process ของ WebView2 ทั้งชุดแทน (เสียงแจ้งเตือนย้ายไปเล่นจาก Launcher เองแล้ว
/// จึงไม่โดนย้ายตามไปด้วย)
///
/// ⚠️ Windows.Media.Internal.AudioPolicyConfig เป็น API ที่ Microsoft ไม่ได้ประกาศเป็นทางการ
/// (EarTrumpet และโปรแกรมจัดการเสียงหลายตัวใช้กันมานานตั้งแต่ Windows 10 1803) — เรียกผ่าน vtable
/// ตรง ๆ และห่อทุกอย่างด้วย try: ใช้ไม่ได้ = คืน false ให้ผู้เรียกบอกผู้ใช้ไปตั้งใน Volume mixer เอง
/// ไม่มีทางทำให้ Launcher ล้ม
/// </summary>
public sealed class ProcessAudioRouter
{
    private const string ClassName = "Windows.Media.Internal.AudioPolicyConfig";
    /// <summary>Windows 10 21H2 / Windows 11 (build ≥ 21390)</summary>
    private static readonly Guid FactoryIid21H2 = new("ab3d4648-e242-459f-b02f-541c70306324");
    private static readonly Guid FactoryIidLegacy = new("2a59116d-6c4f-45e0-a74f-707e3fef9258");
    // vtable: IUnknown(3) + IInspectable(3) + เมธอดอื่น 19 ตัว → Set=25, Get=26
    private const int SetPersistedSlot = 25;
    private const int GetPersistedSlot = 26;

    private const int FlowRender = 0;
    private const int RoleConsole = 0;
    private const int RoleMultimedia = 1;

    private const string MmDevApiToken = @"\\?\SWD#MMDEVAPI#";
    private const string RenderInterfaceSuffix = "#{e6327cad-dcec-4949-ae8a-991e976a79d2}";

    private IntPtr _factory;
    private bool _initTried;

    /// <summary>id ของ MMDevice → รูปแบบ device interface path ที่ API นี้ต้องการ</summary>
    public static string ToInterfaceDeviceId(string mmDeviceId) => $"{MmDevApiToken}{mmDeviceId}{RenderInterfaceSuffix}";

    /// <summary>ย้อนกลับจาก interface path → id ของ MMDevice (null = ไม่ได้ตั้ง/อ่านไม่ออก)</summary>
    public static string? FromInterfaceDeviceId(string? interfaceId)
    {
        if (string.IsNullOrEmpty(interfaceId)) return null;
        if (!interfaceId.StartsWith(MmDevApiToken, StringComparison.OrdinalIgnoreCase)) return null;
        if (!interfaceId.EndsWith(RenderInterfaceSuffix, StringComparison.OrdinalIgnoreCase)) return null;
        return interfaceId[MmDevApiToken.Length..^RenderInterfaceSuffix.Length];
    }

    public bool IsSupported => EnsureFactory() != IntPtr.Zero;

    /// <summary>ตั้งลำโพงของ process (null = กลับไปใช้ลำโพงหลักของ Windows) — คืน false ถ้าทำไม่ได้</summary>
    public bool TrySetProcessOutput(uint processId, string? mmDeviceId)
    {
        var factory = EnsureFactory();
        if (factory == IntPtr.Zero) return false;

        var hstring = IntPtr.Zero;
        try
        {
            if (mmDeviceId is not null)
            {
                var path = ToInterfaceDeviceId(mmDeviceId);
                if (WindowsCreateString(path, path.Length, out hstring) != 0) return false;
            }

            var ok = true;
            foreach (var role in new[] { RoleMultimedia, RoleConsole })
            {
                ok &= CallSet(factory, processId, FlowRender, role, hstring) >= 0;
            }
            return ok;
        }
        catch (Exception)
        {
            return false;
        }
        finally
        {
            if (hstring != IntPtr.Zero) WindowsDeleteString(hstring);
        }
    }

    /// <summary>อ่านลำโพงที่ตั้งไว้ให้ process (null = ใช้ลำโพงหลัก) — ใช้ตรวจว่าตั้งติดจริง</summary>
    public string? TryGetProcessOutput(uint processId)
    {
        var factory = EnsureFactory();
        if (factory == IntPtr.Zero) return null;
        try
        {
            if (CallGet(factory, processId, FlowRender, RoleMultimedia, out var hstring) < 0) return null;
            try
            {
                if (hstring == IntPtr.Zero) return null;
                var raw = WindowsGetStringRawBuffer(hstring, out var length);
                return FromInterfaceDeviceId(Marshal.PtrToStringUni(raw, (int)length));
            }
            finally
            {
                if (hstring != IntPtr.Zero) WindowsDeleteString(hstring);
            }
        }
        catch (Exception)
        {
            return null;
        }
    }

    private IntPtr EnsureFactory()
    {
        if (_initTried) return _factory;
        _initTried = true;
        try
        {
            // เธรดที่ยังไม่ได้เริ่ม COM (เช่นเธรดเบื้องหลัง) ต้องเริ่มก่อน; เธรด UI ของ WPF เริ่มไว้แล้ว
            // จะได้ RPC_E_CHANGED_MODE กลับมา ซึ่งไม่เป็นไร — ไม่เปลี่ยนสถานะเดิมของเธรด
            _ = RoInitialize(1);
            if (WindowsCreateString(ClassName, ClassName.Length, out var classId) != 0) return IntPtr.Zero;
            try
            {
                var iid = Environment.OSVersion.Version.Build >= 21390 ? FactoryIid21H2 : FactoryIidLegacy;
                if (RoGetActivationFactory(classId, ref iid, out var factory) >= 0) _factory = factory;
            }
            finally
            {
                WindowsDeleteString(classId);
            }
        }
        catch (Exception)
        {
            _factory = IntPtr.Zero;
        }
        return _factory;
    }

    private static unsafe int CallSet(IntPtr factory, uint pid, int flow, int role, IntPtr deviceId)
    {
        var vtable = *(IntPtr**)factory;
        var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, int, int, IntPtr, int>)vtable[SetPersistedSlot];
        return fn(factory, pid, flow, role, deviceId);
    }

    private static unsafe int CallGet(IntPtr factory, uint pid, int flow, int role, out IntPtr deviceId)
    {
        var vtable = *(IntPtr**)factory;
        var fn = (delegate* unmanaged[Stdcall]<IntPtr, uint, int, int, IntPtr*, int>)vtable[GetPersistedSlot];
        IntPtr result;
        var hr = fn(factory, pid, flow, role, &result);
        deviceId = result;
        return hr;
    }

    [DllImport("combase.dll", PreserveSig = true)]
    private static extern int RoInitialize(int initType);

    [DllImport("combase.dll", PreserveSig = true)]
    private static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

    [DllImport("combase.dll", PreserveSig = true, CharSet = CharSet.Unicode)]
    private static extern int WindowsCreateString(string sourceString, int length, out IntPtr hstring);

    [DllImport("combase.dll", PreserveSig = true)]
    private static extern int WindowsDeleteString(IntPtr hstring);

    [DllImport("combase.dll", PreserveSig = true)]
    private static extern IntPtr WindowsGetStringRawBuffer(IntPtr hstring, out uint length);
}
