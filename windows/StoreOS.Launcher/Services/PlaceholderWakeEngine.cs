namespace StoreOS.Launcher.Services;

/// <summary>
/// เครื่องยนต์คำปลุกชั่วคราวของ W1 — <b>ไม่แตะไมโครโฟนและไม่ฟังอะไรทั้งสิ้น</b>
///
/// มีไว้เพื่อให้เส้นทางเปิด/ปิด/คืนทรัพยากรของ <see cref="VoiceStandbyHost"/> ถูกใช้งานจริง
/// ตั้งแต่ W1 (ไม่ใช่โค้ดที่ไม่เคยรัน) แล้ว W2 ค่อยสลับมาเป็นตัวจริงที่ใช้ System.Speech
/// ตามผลวัดใน Plan/Windows Voice Standby W0 Spike Evidence v2.html
///
/// ตั้งใจให้เห็นชัดในสถานะว่ายัง "ไม่ได้ฟังจริง" — ห้ามให้ UI แสดงว่าพร้อมฟังคำปลุก
/// จนกว่า W2 จะเสร็จ
/// </summary>
public sealed class PlaceholderWakeEngine : IWakeEngine
{
    public bool Started { get; private set; }
    public bool Disposed { get; private set; }

    public Task StartAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        Started = true;
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken ct)
    {
        Started = false;
        return Task.CompletedTask;
    }

    public ValueTask DisposeAsync()
    {
        Started = false;
        Disposed = true;
        return ValueTask.CompletedTask;
    }
}
