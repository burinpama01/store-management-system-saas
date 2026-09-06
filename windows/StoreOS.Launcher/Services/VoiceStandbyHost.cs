using StoreOS.Voice;

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
/// วงจรชีวิตของฝั่งคำปลุกใน Launcher (แผน v1 W1 + เครื่องยนต์จริงของ W2)
///
/// กฎที่ยึด:
///   * <b>POS ต้องเปิดได้เสมอ</b> — คำปลุกพังต้องไม่ทำให้ขายของไม่ได้ ทุก error จบที่
///     สถานะ Degraded พร้อมเหตุผล ไม่มีการโยน exception ออกไปหา UI
///   * ปิดโปรแกรมทางไหนก็ต้องคืนไมโครโฟน — <see cref="StopAsync"/> ต้องเรียกซ้ำได้
///     และต้องปลอดภัยแม้ไม่เคย Start
///   * ค่าเริ่มต้นคือ "ปิด" — เปิดได้เฉพาะเมื่อ settings เปิดไว้จริง (feature flag ต่อเครื่อง)
///   * ไม่มี transcript ผ่านชั้นนี้เลย — ได้แค่รหัสคำปลุกกับความมั่นใจ
/// </summary>
public sealed class VoiceStandbyHost : IAsyncDisposable
{
    private readonly Func<IWakeWordEngine> _engineFactory;
    private readonly Action<string, string, string> _log;
    private readonly WakeWordOptions _options;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private IWakeWordEngine? _engine;
    private bool _disposed;

    /// <param name="engineFactory">สร้างเครื่องยนต์คำปลุก (ตัวจริงคือ SystemSpeechWakeEngine)</param>
    /// <param name="log">level, code, message — ต่อเข้ากับ LauncherLogShipper</param>
    public VoiceStandbyHost(
        Func<IWakeWordEngine> engineFactory,
        Action<string, string, string> log,
        WakeWordOptions? options = null)
    {
        _engineFactory = engineFactory;
        _log = log;
        _options = options ?? new WakeWordOptions();
    }

    public VoiceHostState State { get; private set; } = VoiceHostState.Off;
    public string? LastFault { get; private set; }
    /// <summary>นับจำนวนครั้งที่เปิดเครื่องยนต์จริง — ใช้ยืนยันว่า Start ซ้ำไม่เปิดซ้อน</summary>
    public int EngineStartCount { get; private set; }
    /// <summary>ได้ยินคำปลุก — W3/W4 จะเอาไปเริ่มการส่งไมค์ต่อให้หน้าเว็บ</summary>
    public event EventHandler<WakeDetectedEventArgs>? WakeDetected;

    /// <summary>เปิดโหมดฟังคำปลุก</summary>
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
            engine.WakeDetected += OnWakeDetected;
            engine.Faulted += OnFaulted;

            try
            {
                await engine.StartAsync(_options, ct);
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

            // engine รายงานปัญหาผ่าน event แล้วคืนมาปกติ — ต้องอ่านสถานะจริงของมัน ไม่ใช่เดา
            if (engine.State != WakeEngineState.Listening)
            {
                await SafeDisposeAsync(engine);
                State = VoiceHostState.Degraded;
                _log("error", "voice_standby_failed", $"เปิดโหมดคำปลุกไม่สำเร็จ: {LastFault ?? "unknown"}");
                return;
            }

            _engine = engine;
            EngineStartCount++;
            State = VoiceHostState.Standby;
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

    private void OnWakeDetected(object? sender, WakeDetectedEventArgs e)
    {
        // log ได้แค่รหัสคำปลุก ห้ามมีข้อความที่ได้ยิน
        _log("info", "voice_wake_detected", $"ได้ยินคำปลุก {e.PhraseId} ({e.Confidence:0.00})");
        WakeDetected?.Invoke(this, e);
    }

    private void OnFaulted(object? sender, WakeEngineFaultEventArgs e)
    {
        LastFault = e.Code;

        // ไวยากรณ์ตกไปใช้แบบสะกดอย่างเดียวยังฟังได้ แค่จับคำไทยได้แย่ลง — ไม่ใช่เหตุให้ปิดทั้งฟีเจอร์
        if (e.Code == "pronunciation_fallback")
        {
            _log("warn", "voice_pronunciation_fallback", "เครื่องนี้ใช้ไวยากรณ์แบบไม่มีหน่วยเสียง คำปลุกไทยอาจจับได้น้อยลง");
            return;
        }

        _log("error", "voice_standby_fault", $"ชุดรู้จำเสียงมีปัญหา: {e.Code}");
    }

    private async Task SafeDisposeAsync(IWakeWordEngine engine)
    {
        engine.WakeDetected -= OnWakeDetected;
        engine.Faulted -= OnFaulted;
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
