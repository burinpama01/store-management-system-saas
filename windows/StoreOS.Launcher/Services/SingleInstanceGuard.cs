using System.Text.RegularExpressions;
using System.Threading;

namespace StoreOS.Launcher.Services;

/// <summary>
/// กันเปิด Launcher ซ้ำบนเครื่องเดียวกัน (แผน v1 W1 / v3 Task 7 "หนึ่ง task หนึ่ง process")
///
/// ทำไมต้องมี: Launcher ถูกตั้งให้เปิดตอนล็อกอิน และผู้ใช้มักดับเบิลคลิกไอคอนซ้ำอีก
/// ถ้าเปิดสองตัวจะได้ WebView2 สองอัน, timer สั่ง Start-ScheduledTask ซ้อนกัน และเมื่อถึง
/// W2 จะมีสองตัวแย่งไมโครโฟนกัน — ซึ่งเป็นอาการที่หาสาเหตุยากที่สุดของงานเสียง
///
/// ใช้ named mutex เพราะทำงานข้าม process จริงและถูกปล่อยให้เองเมื่อ process ตาย
/// (ต่างจากไฟล์ล็อกที่ค้างเมื่อเครื่องดับ)
/// </summary>
public sealed class SingleInstanceGuard : IDisposable
{
    private Mutex? _mutex;

    private SingleInstanceGuard(Mutex mutex) => _mutex = mutex;

    /// <summary>
    /// ชื่อ mutex ต่อ channel — ชื่อต้องไม่มี '\' นอกจากคำนำหน้า และต้องยาวไม่เกิน 260
    /// จึงกรองอักขระอื่นทิ้งทั้งหมด ไม่ใช่แค่ escape (ชื่อที่ผิดทำให้โยน exception ตอนเปิดโปรแกรม)
    /// </summary>
    public static string MutexName(string? channel)
    {
        var safe = Regex.Replace(channel ?? "", "[^A-Za-z0-9_-]", "");
        if (safe.Length == 0) safe = "prod";
        if (safe.Length > 64) safe = safe[..64];
        // Local\ ไม่ใช่ Global\ — Launcher เป็นโปรแกรมของผู้ใช้ที่ล็อกอินอยู่
        // ใช้ Global\ จะทำให้ผู้ใช้คนที่สองบนเครื่องเดียวกัน (fast user switching) เปิดไม่ได้
        return $@"Local\StoreOSLauncher-{safe}";
    }

    /// <summary>คว้าสิทธิ์ "เป็นตัวเดียว" — คืน null ถ้ามีตัวอื่นถืออยู่แล้ว</summary>
    public static SingleInstanceGuard? TryAcquire(string? channel)
    {
        // ใช้ createdNew ไม่ใช่ WaitOne: การรอแบบเป็นเจ้าของจะ "สำเร็จซ้ำ" ถ้าเรียกจาก
        // เธรดเดิม (mutex เป็นแบบ reentrant) ทำให้ตรวจไม่เจอกรณีเปิดซ้ำในบางเส้นทาง
        // และทดสอบไม่ได้ด้วย. createdNew ตอบจากการมีอยู่ของ kernel object ตรง ๆ
        // และ object จะหายไปเองเมื่อ process เดิมตาย (ทุก handle ถูกปิด)
        var mutex = new Mutex(initiallyOwned: true, MutexName(channel), out var createdNew);
        if (!createdNew)
        {
            mutex.Dispose();
            return null;
        }

        return new SingleInstanceGuard(mutex);
    }

    public void Dispose()
    {
        if (_mutex is null) return;
        try
        {
            _mutex.ReleaseMutex();
        }
        catch (ApplicationException)
        {
            // ไม่ได้เป็นเจ้าของแล้ว — ไม่ต้องทำอะไร
        }
        _mutex.Dispose();
        _mutex = null;
    }
}
