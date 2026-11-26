using System.Threading;
using System.Windows;
using System.Windows.Threading;

namespace StoreOS.PosLauncher;

/// <summary>
/// จุดเริ่มของ StoreOS POS — เปิดได้ตัวเดียวต่อเครื่อง (named mutex, ปล่อยเองเมื่อ process ตาย)
/// ชื่อ mutex ต่างจาก Launcher เดิม จึงเปิดคู่กันได้ระหว่างช่วงเปลี่ยนผ่าน
/// </summary>
public partial class App : Application
{
    private Mutex? _mutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        var settings = PosLauncherSettings.Load();
        _mutex = new Mutex(initiallyOwned: true, $@"Local\StoreOSPosLauncher-{settings.SafeChannel}", out var createdNew);
        if (!createdNew)
        {
            _mutex.Dispose();
            _mutex = null;
            Shutdown(0); // เปิดอยู่แล้ว = ผลลัพธ์ที่ผู้ใช้ต้องการ ไม่ใช่ error
            return;
        }

        DispatcherUnhandledException += OnUnhandled;
        LocalLog.Prune();
        base.OnStartup(e);
        new MainWindow(settings).Show();
    }

    private static void OnUnhandled(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        // ห้ามปิดโปรแกรมเงียบ ๆ ระหว่างขาย — บันทึกแล้วไปต่อ
        LocalLog.Write("error", "unhandled", e.Exception.ToString());
        e.Handled = true;
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _mutex?.Dispose();
        base.OnExit(e);
    }
}
