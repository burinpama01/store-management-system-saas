using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;

using StoreOS.Launcher.Services;

namespace StoreOS.Launcher;

/// <summary>
/// จุดเริ่มของ Launcher — รับผิดชอบสองเรื่องที่ต้องเกิดก่อนหน้าต่างจะเปิด (แผน v1 W1):
///   1. เปิดได้ตัวเดียวต่อเครื่อง (ตัวที่สองยกหน้าต่างเดิมขึ้นมาแล้วปิดตัวเองด้วย exit code 0)
///   2. ข้อผิดพลาดที่ไม่ถูกจับ ต้องไม่ทำให้โปรแกรมหายไปเงียบ ๆ โดยไม่คืนไมโครโฟน
/// </summary>
public partial class App : Application
{
    private SingleInstanceGuard? _guard;

    protected override void OnStartup(StartupEventArgs e)
    {
        var settings = LauncherSettings.Load();
        _guard = SingleInstanceGuard.TryAcquire(settings.Channel);
        if (_guard is null)
        {
            FocusExistingInstance();
            // exit 0 ไม่ใช่ error — "เปิดอยู่แล้ว" คือผลลัพธ์ที่ผู้ใช้ต้องการ
            Shutdown(0);
            return;
        }

        base.OnStartup(e);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _guard?.Dispose();
        _guard = null;
        base.OnExit(e);
    }

    /// <summary>
    /// ยกหน้าต่างของตัวที่เปิดอยู่ขึ้นมาให้ผู้ใช้เห็น
    ///
    /// ถ้าทำไม่ได้ก็แค่ปิดตัวเองเงียบ ๆ — ยอมให้ผู้ใช้งงดีกว่าเปิด Launcher ซ้อนสองตัว
    /// ซึ่งจะแย่งไมโครโฟนและสั่ง Scheduled Task ซ้อนกัน
    /// </summary>
    private static void FocusExistingInstance()
    {
        try
        {
            var me = Process.GetCurrentProcess();
            foreach (var other in Process.GetProcessesByName(me.ProcessName))
            {
                if (other.Id == me.Id || other.MainWindowHandle == IntPtr.Zero) continue;
                ShowWindow(other.MainWindowHandle, SW_RESTORE);
                SetForegroundWindow(other.MainWindowHandle);
                return;
            }
        }
        catch (Exception)
        {
            // ไม่มีสิทธิ์อ่าน process อื่น หรือมันเพิ่งปิดไป — ไม่ใช่เหตุให้เปิดซ้อน
        }
    }

    private const int SW_RESTORE = 9;

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
