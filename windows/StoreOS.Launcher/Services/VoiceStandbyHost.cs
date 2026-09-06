namespace StoreOS.Launcher.Services;

/// <summary>สถานะของฝั่งคำปลุกใน Launcher</summary>
public enum VoiceHostState
{
    /// <summary>ปิดอยู่ — ไม่ถือไมโครโฟน</summary>
    Off,
    /// <summary>กำลังเปิดชุดรู้จำเสียง</summary>
    Starting,
    /// <summary>ฟังคำปลุกอยู่ (native ถือไมค์)</summary>
    Standby,
    /// <summary>เปิดไม่สำเร็จหรือพังกลางทาง — POS ยังใช้งานได้ตามปกติ</summary>
    Degraded,
}

/// <summary>
/// ตัวเครื่องยนต์คำปลุก — W1 ยังไม่ใส่ของจริง (นั่นคือ W2)
/// แยกเป็น interface ตั้งแต่ตอนนี้เพื่อให้ lifecycle ทดสอบได้โดยไม่ต้องมีไมโครโฟน
/// </summary>
public interface IWakeEngine : IAsyncDisposable
{
    Task StartAsync(CancellationToken ct);
    Task StopAsync(CancellationToken ct);
}

/// <summary>
/// วงจรชีวิตของฝั่งคำปลุกใน Launcher (แผน v1 W1)
///
/// กฎที่ยึด:
///   * <b>POS ต้องเปิดได้เสมอ</b> — คำปลุกพังต้องไม่ทำให้ขายของไม่ได้ ทุก error จบที่
///     สถานะ Degraded พร้อมเหตุผล ไม่มีการโยน exception ออกไปหา UI
///   * ปิดโปรแกรมทางไหนก็ต้องคืนไมโครโฟน — <see cref="StopAsync"/> ต้องเรียกซ้ำได้
///     และต้องปลอดภัยแม้ไม่เคย Start
///   * ค่าเริ่มต้นคือ "ปิด" — เปิดได้เฉพาะเมื่อ settings เปิดไว้จริง (feature flag ต่อเครื่อง)
/// </summary>
public sealed class VoiceStandbyHost : IAsyncDisposable
{
    private readonly Func<IWakeEngine> _engineFactory;
    private readonly Action<string, string, string> _log;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private IWakeEngine? _engine;
    private bool _disposed;

    /// <param name="engineFactory">สร้างเครื่องยนต์คำปลุก (W2 จะส่งตัวจริงเข้ามา)</param>
    /// <param name="log">level, code, message — ต่อเข้ากับ LauncherLogShipper</param>
    public VoiceStandbyHost(Func<IWakeEngine> engineFactory, Action<string, string, string> log)
    {
        _engineFactory = engineFactory;
        _log = log;
    }

    public VoiceHostState State { get; private set; } = VoiceHostState.Off;
    public string? LastFault { get; private set; }
    /// <summary>นับจำนวนครั้งที่เปิดเครื่องยนต์จริง — ใช้ยืนยันว่า Start ซ้ำไม่เปิดซ้อน</summary>
    public int EngineStartCount { get; private set; }

    /// <summary>
    /// เปิดโหมดฟังคำปลุก
    /// </summary>
    /// <param name="enabled">ค่าจาก settings ของเครื่อง — ปิดอยู่ = ไม่ทำอะไรเลย</param>
    public async Task StartAsync(bool enabled, CancellationToken ct = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!enabled)
        {
            _log("info", "voice_standby_disabled", "โหมดคำปลุกปิดอยู่บนเครื่องนี้");
            return;
        }

        await _gate.WaitAsync(ct);
        try
        {
            // เปิดซ้ำระหว่างที่เปิดอยู่แล้วต้องไม่สร้าง engine ตัวที่สอง (สองตัว = แย่งไมค์กัน)
            if (_engine is not null) return;

            State = VoiceHostState.Starting;
            var engine = _engineFactory();
            try
            {
                await engine.StartAsync(ct);
            }
            catch (Exception ex)
            {
                // เปิดไม่ขึ้น (ไม่มี recognizer / ไมค์ถูกใช้อยู่ / ไดรเวอร์เพี้ยน)
                await SafeDisposeAsync(engine);
                State = VoiceHostState.Degraded;
                LastFault = ex.GetType().Name;
                _log("error", "voice_standby_failed", $"เปิดโหมดคำปลุกไม่สำเร็จ: {ex.GetType().Name}");
                return;
            }

            _engine = engine;
            EngineStartCount++;
            State = VoiceHostState.Standby;
            LastFault = null;
            _log("info", "voice_standby_started", "เริ่มฟังคำปลุกแล้ว");
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>ปิดและคืนไมโครโฟน — เรียกซ้ำได้ และปลอดภัยแม้ไม่เคยเปิด</summary>
    public async Task StopAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(CancellationToken.None);
        try
        {
            if (_engine is null)
            {
                State = State == VoiceHostState.Degraded ? VoiceHostState.Degraded : VoiceHostState.Off;
                return;
            }

            var engine = _engine;
            _engine = null;
            try
            {
                await engine.StopAsync(ct);
            }
            catch (Exception ex)
            {
                // หยุดไม่สำเร็จก็ยังต้อง dispose ต่อ — ห้ามค้างสถานะว่ายังถือไมค์อยู่
                LastFault = ex.GetType().Name;
                _log("error", "voice_standby_stop_failed", $"หยุดโหมดคำปลุกไม่สนิท: {ex.GetType().Name}");
            }

            await SafeDisposeAsync(engine);
            State = VoiceHostState.Off;
            _log("info", "voice_standby_stopped", "ปิดโหมดคำปลุกและคืนไมโครโฟนแล้ว");
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        await StopAsync();
        _disposed = true;
        _gate.Dispose();
    }

    private async Task SafeDisposeAsync(IWakeEngine engine)
    {
        try
        {
            await engine.DisposeAsync();
        }
        catch (Exception ex)
        {
            _log("error", "voice_standby_dispose_failed", $"ปล่อยทรัพยากรคำปลุกไม่สำเร็จ: {ex.GetType().Name}");
        }
    }
}
