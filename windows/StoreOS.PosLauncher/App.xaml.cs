using System.Threading;
using System.Windows;
using System.Windows.Threading;

namespace StoreOS.PosLauncher;

/// <summary>
/// จุดเริ่มของ StoreOS POS — เปิดได้ตัวเดียวต่อเครื่อง (named mutex, ปล่อยเองเมื่อ process ตาย)
/// ชื่อ mutex ต่างจาก Launcher เดิม จึงเปิดคู่กันได้ระหว่างช่วงเปลี่ยนผ่าน
///
/// เปิดซ้ำ (เช่นดับเบิลคลิกไอคอนตอนหน้าต่างถูกย่อ/อยู่หลังจอ) → ส่งสัญญาณให้ตัวแรกยกหน้าต่างขึ้นมา
/// ไม่งั้นพนักงานจะเห็นว่า "กดแล้วไม่ขึ้น" ทั้งที่โปรแกรมเปิดอยู่
/// </summary>
public partial class App : Application
{
    private Mutex? _mutex;
    private EventWaitHandle? _activate;

    protected override void OnStartup(StartupEventArgs e)
    {
        var settings = PosLauncherSettings.Load();
        var name = $@"Local\StoreOSPosLauncher-{settings.SafeChannel}";
        _mutex = new Mutex(initiallyOwned: true, name, out var createdNew);
        if (!createdNew)
        {
            _mutex.Dispose();
            _mutex = null;
            try
            {
                using var signal = EventWaitHandle.OpenExisting(name + "-activate");
                signal.Set();
            }
            catch
            {
                // ตัวแรกยังไม่พร้อมรับสัญญาณ — ไม่เป็นไร
            }
            Shutdown(0); // เปิดอยู่แล้ว = ผลลัพธ์ที่ผู้ใช้ต้องการ ไม่ใช่ error
            return;
        }

        DispatcherUnhandledException += OnUnhandled;
        LocalLog.Prune();
        base.OnStartup(e);
        var window = new MainWindow(settings);
        window.Show();

        _activate = new EventWaitHandle(false, EventResetMode.AutoReset, name + "-activate");
        var listener = new Thread(() =>
        {
            while (_activate is not null)
            {
                try
                {
                    if (!_activate.WaitOne()) continue;
                }
                catch (ObjectDisposedException)
                {
                    return;
                }
                Dispatcher.BeginInvoke(() =>
                {
                    if (window.WindowState == WindowState.Minimized) window.WindowState = WindowState.Maximized;
                    window.Show();
                    window.Activate();
                    window.Topmost = true; // ดันขึ้นหน้าสุดครั้งเดียว แล้วปล่อย
                    window.Topmost = false;
                    window.Focus();
                });
            }
        }) { IsBackground = true, Name = "activate-listener" };
        listener.Start();
    }

    private static void OnUnhandled(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        // ห้ามปิดโปรแกรมเงียบ ๆ ระหว่างขาย — บันทึกแล้วไปต่อ
        LocalLog.Write("error", "unhandled", e.Exception.ToString());
        e.Handled = true;
    }

    protected override void OnExit(ExitEventArgs e)
    {
        var activate = _activate;
        _activate = null;
        activate?.Dispose();
        _mutex?.Dispose();
        base.OnExit(e);
    }
}
