using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;

using StoreOS.Launcher.Services;
using StoreOS.Launcher.Services.Update;

namespace StoreOS.Launcher;

/// <summary>
/// จุดเริ่มของ Launcher — รับผิดชอบสองเรื่องที่ต้องเกิดก่อนหน้าต่างจะเปิด (แผน v1 W1):
///   1. เปิดได้ตัวเดียวต่อเครื่อง (ตัวที่สองยกหน้าต่างเดิมขึ้นมาแล้วปิดตัวเองด้วย exit code 0)
///   2. ข้อผิดพลาดที่ไม่ถูกจับ ต้องไม่ทำให้โปรแกรมหายไปเงียบ ๆ โดยไม่คืนไมโครโฟน
/// </summary>
public partial class App : Application
{
    private SingleInstanceGuard? _guard;

    /// <summary>ตัวนี้ถูกเปิดโดยตัวติดตั้งหลังอัปเดต — ต้องเขียนไฟล์ healthy เมื่อเปิดหน้า POS ได้</summary>
    public static string? PostUpdateVersion { get; private set; }

    protected override void OnStartup(StartupEventArgs e)
    {
        // โหมดติดตั้งอัปเดต (0.5.0+): รันจาก exe รุ่นใหม่ในโฟลเดอร์ staging — ไม่มีหน้าต่าง
        // และไม่จับ single-instance (ตัวเดิมยังถือไว้จนกว่าจะปิด ตัวติดตั้งรอมันเอง)
        var apply = UpdateApplier.ParseArgs(e.Args);
        if (apply is not null)
        {
            var result = UpdateApplier.Run(apply, UpdatePaths.Default(), new SystemUpdateProcessOps());
            Shutdown(result.Outcome == "installed" ? 0 : 1);
            return;
        }
        PostUpdateVersion = ArgValue(e.Args, "--post-update");

        var settings = LauncherSettings.Load();
        _guard = SingleInstanceGuard.TryAcquire(settings.Channel);
        if (_guard is null)
        {
            FocusExistingInstance();
            // exit 0 ไม่ใช่ error — "เปิดอยู่แล้ว" คือผลลัพธ์ที่ผู้ใช้ต้องการ
            Shutdown(0);
            return;
        }

        // มีรุ่นใหม่ดาวน์โหลด+ตรวจไว้แล้วตั้งแต่รอบก่อน → ติดตั้งตอนนี้ ก่อนหน้าต่างขึ้น
        // (ไม่ทำตอนเพิ่งอัปเดต/เพิ่งย้อนกลับ กันวนติดตั้งซ้ำ)
        if (PostUpdateVersion is null && ArgValue(e.Args, "--update-rolled-back") is null && TryInstallPendingUpdate())
        {
            _guard.Dispose();
            _guard = null;
            Shutdown(0);
            return;
        }

        base.OnStartup(e);
        new MainWindow().Show();
    }

    private static bool TryInstallPendingUpdate()
    {
        try
        {
            var version = typeof(App).Assembly.GetName().Version is { } v ? $"{v.Major}.{v.Minor}.{v.Build}" : "0.0.0";
            var coordinator = new LauncherUpdateCoordinator(
                version,
                AppContext.BaseDirectory,
                UpdatePaths.Default(),
                new System.Net.Http.HttpClient(),
                (_, _, message) => UpdatePaths.Default().AppendLog(message));
            return coordinator.TryStartInstall(new SystemUpdateProcessOps(), Environment.ProcessId);
        }
        catch (Exception)
        {
            // ติดตั้งไม่ได้ = เปิดรุ่นเดิมตามปกติ ร้านต้องขายของได้ก่อน
            return false;
        }
    }

    private static string? ArgValue(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
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
