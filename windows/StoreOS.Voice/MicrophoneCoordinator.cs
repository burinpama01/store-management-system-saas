namespace StoreOS.Voice;

public enum MicOwnerState
{
    /// <summary>ไม่มีใครถือไมค์ และเราไม่ได้พยายามจะถือ</summary>
    Off,
    /// <summary>native ถือไมค์ ฟังคำปลุก</summary>
    Standby,
    /// <summary>ปล่อยไมค์แล้ว กำลังรอเว็บบอกว่าเริ่มฟัง</summary>
    Handoff,
    /// <summary>เว็บถือไมค์อยู่</summary>
    Listening,
    /// <summary>จบรอบแล้ว พักสั้น ๆ ก่อนกลับไปฟังคำปลุก</summary>
    Cooldown,
    /// <summary>เครื่องล็อก/หลับ — ต้องไม่ถือไมค์เด็ดขาด</summary>
    Suspended,
    /// <summary>เปิดไม่ได้จริง ๆ — POS ยังขายได้ แต่คำปลุกใช้ไม่ได้จนกว่าจะแก้</summary>
    Degraded,
}

/// <summary>
/// สัญญาณจากระบบปฏิบัติการที่บังคับให้ปล่อยไมค์ (ล็อกจอ / เครื่องหลับ)
/// แยกเป็น interface เพื่อให้ทดสอบได้โดยไม่ต้องล็อกเครื่องจริง
/// </summary>
public interface ISystemSuspendSignals
{
    /// <summary>กำลังจะล็อก/หลับ — ต้องปล่อยไมค์ก่อน</summary>
    event EventHandler? Suspending;
    /// <summary>กลับมาใช้งาน — ต้องตรวจสภาพก่อนเปิดใหม่ ไม่ใช่เปิดทันที</summary>
    event EventHandler? Resumed;
}

/// <summary>
/// เจ้าของไมโครโฟนหนึ่งเดียวของเครื่อง (แผน v1 W3)
///
/// ปัญหาที่คลาสนี้มีไว้แก้: ไมโครโฟนมีเจ้าของได้ทีละคน แต่ในระบบนี้มีผู้ต้องการใช้สามฝ่าย
/// — ตัวฟังคำปลุก, หน้าเว็บที่รับคำสั่ง, และ Windows เองตอนล็อก/หลับ ถ้าไม่มีคนกลาง
/// ตัดสินว่าใครถืออยู่ อาการที่ได้คือ "คำปลุกใช้ได้บ้างไม่ได้บ้าง" ซึ่งไล่สาเหตุแทบไม่ได้
///
/// กฎที่ยึด:
///   * native ต้อง<b>ปล่อยไมค์ให้เสร็จก่อน</b>จึงส่ง wake.detected ออกไป ไม่ใช่ส่งพร้อมกัน
///   * ล็อก/หลับ = ปล่อยไมค์ทันที; กลับมา = ตรวจสภาพก่อนค่อยเปิด
///   * อุปกรณ์หาย = ลองใหม่ครั้งเดียว ถ้ายังไม่ได้ให้เป็น Degraded และเงียบ
///     (ลองใหม่ไม่หยุดจะกิน CPU และทำให้ log ท่วมจนหาของจริงไม่เจอ)
///   * ทุกการเปลี่ยนสถานะมี log — ฟีเจอร์เสียงพังแบบเงียบไม่ได้
/// </summary>
public sealed class MicrophoneCoordinator : IAsyncDisposable
{
    /// <summary>พักหลังจบรอบคำสั่งก่อนกลับไปฟังคำปลุก (แผน v1 W3)</summary>
    public const int CooldownMs = 350;
    /// <summary>ลองเปิดใหม่หลังอุปกรณ์หาย — ครั้งเดียวเท่านั้น</summary>
    public const int DeviceRetryDelayMs = 1500;

    private readonly Func<IWakeWordEngine> _engineFactory;
    private readonly WakeWordOptions _options;
    private readonly StandbySession _session;
    private readonly Func<long> _clock;
    private readonly Func<TimeSpan, Task> _delay;
    private readonly Action<string, string, string> _log;
    private readonly Func<bool> _healthProbe;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private IWakeWordEngine? _engine;
    private bool _disposed;
    private bool _deviceRetryUsed;

    public MicrophoneCoordinator(
        Func<IWakeWordEngine> engineFactory,
        Action<string, string, string> log,
        WakeWordOptions? options = null,
        StandbySession? session = null,
        Func<long>? clock = null,
        Func<TimeSpan, Task>? delay = null,
        Func<bool>? healthProbe = null)
    {
        _engineFactory = engineFactory;
        _log = log;
        _options = options ?? new WakeWordOptions();
        _session = session ?? new StandbySession();
        _clock = clock ?? (() => Environment.TickCount64);
        _delay = delay ?? Task.Delay;
        _healthProbe = healthProbe ?? DefaultHealthProbe;
    }

    public MicOwnerState State { get; private set; } = MicOwnerState.Off;
    public string? LastFault { get; private set; }
    /// <summary>เปิดเครื่องยนต์ไปแล้วกี่ครั้ง — ใช้ยืนยันว่าไม่เปิดซ้อนและกลับมาเปิดใหม่จริง</summary>
    public int EngineStartCount { get; private set; }

    /// <summary>ข้อความที่ต้องส่งให้หน้าเว็บ (wake.detected / wake.fallback / sessionEnded)</summary>
    public event EventHandler<StandbyMessage>? MessageForWeb;

    /// <summary>เริ่มฟังคำปลุก</summary>
    public async Task StartAsync(CancellationToken ct = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _gate.WaitAsync(ct);
        try
        {
            if (State is MicOwnerState.Standby or MicOwnerState.Handoff or MicOwnerState.Listening) return;
            _deviceRetryUsed = false;
            await StartEngineLockedAsync(ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>หยุดทุกอย่างและคืนไมค์</summary>
    public async Task StopAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(CancellationToken.None);
        try
        {
            await StopEngineLockedAsync(ct);
            State = MicOwnerState.Off;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>เครื่องกำลังล็อกหรือหลับ — ปล่อยไมค์ทันที</summary>
    public async Task SuspendAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(CancellationToken.None);
        try
        {
            if (State == MicOwnerState.Suspended) return;
            await StopEngineLockedAsync(ct);
            State = MicOwnerState.Suspended;
            _log("info", "voice_mic_suspended", "ปล่อยไมโครโฟนเพราะเครื่องล็อกหรือหลับ");
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>กลับมาใช้งาน — ตรวจว่ายังมีชุดรู้จำเสียงอยู่ก่อนค่อยเปิด</summary>
    public async Task ResumeAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(CancellationToken.None);
        try
        {
            if (State != MicOwnerState.Suspended) return;

            // ตรวจสภาพก่อนเปิด: หลังตื่นจาก sleep ไดรเวอร์เสียงอาจยังไม่พร้อม
            // การเปิดทันทีจะได้ error ที่ดูเหมือนเครื่องพัง ทั้งที่แค่เร็วไป
            if (!_healthProbe())
            {
                State = MicOwnerState.Degraded;
                LastFault = "no_recognizer";
                _log("error", "voice_mic_resume_failed", "กลับมาจากล็อก/หลับแล้วไม่พบชุดรู้จำเสียง");
                return;
            }

            _deviceRetryUsed = false;
            await StartEngineLockedAsync(ct);
            if (State == MicOwnerState.Standby)
                _log("info", "voice_mic_resumed", "กลับมาฟังคำปลุกหลังปลดล็อก");
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>ต่อสัญญาณล็อก/หลับของ Windows เข้ากับตัวประสานงาน</summary>
    public void Attach(ISystemSuspendSignals signals)
    {
        signals.Suspending += async (_, _) => await SuspendAsync();
        signals.Resumed += async (_, _) => await ResumeAsync();
    }

    /// <summary>เว็บตอบว่าเริ่มฟังคำสั่งแล้ว</summary>
    public void OnWebSessionStarted()
    {
        if (State != MicOwnerState.Handoff) return; // มาช้าหลัง watchdog ตัดไปแล้ว
        _session.OnSessionStarted(_clock());
        State = MicOwnerState.Listening;
    }

    /// <summary>เว็บบอกว่ายังคุยต่อ</summary>
    public void OnWebSessionExtended()
    {
        if (State != MicOwnerState.Listening) return;
        _session.OnSessionExtended(_clock());
    }

    /// <summary>เว็บจบรอบแล้ว — พักสั้น ๆ แล้วกลับไปฟังคำปลุก</summary>
    public async Task OnWebSessionEndedAsync(CancellationToken ct = default)
    {
        if (State is not (MicOwnerState.Listening or MicOwnerState.Handoff)) return;
        _session.OnSessionEnded(_clock());
        await ReturnToStandbyAsync(ct);
    }

    /// <summary>
    /// เดินนาฬิกา — ต้องถูกเรียกเป็นระยะ (ตัวจับเวลาของ Launcher)
    /// คืนไมค์เองเมื่อเว็บเงียบหายไป ไม่ว่าจะเพราะแท็บถูกปิดหรือเบราว์เซอร์ไม่ยอมเริ่มฟัง
    /// </summary>
    public async Task TickAsync(CancellationToken ct = default)
    {
        if (State is not (MicOwnerState.Handoff or MicOwnerState.Listening)) return;

        var timeout = _session.Tick(_clock(), DateTimeOffset.Now);
        if (timeout is null) return;

        _log("warn", "voice_session_timeout", $"คืนไมโครโฟนเองเพราะ {timeout.Reason}");
        MessageForWeb?.Invoke(this, timeout);
        await ReturnToStandbyAsync(ct);
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        await StopAsync();
        _disposed = true;
        _gate.Dispose();
    }

    /// <summary>ยังมีชุดรู้จำเสียงให้ใช้อยู่ไหม</summary>
    private static bool DefaultHealthProbe() => WakeGrammar.PickEnglishRecognizer() is not null;

    /// <summary>
    /// สรุปสถานะให้หน้าเว็บแสดงบนหน้าตั้งค่า (W8)
    /// ไม่มีรหัสอุปกรณ์ดิบ ไม่มีเส้นทางไฟล์ ไม่มีชื่อเครื่อง — แค่พอให้รู้ว่าใช้ได้ไหมและติดอะไร
    /// </summary>
    public VoiceHealthMessage BuildHealth(string hostVersion, long seq)
    {
        var recognizer = WakeGrammar.PickEnglishRecognizer();
        return new VoiceHealthMessage(
            StandbyContract.Version,
            StandbyContract.Health,
            seq,
            DateTimeOffset.Now.ToString("o"),
            State switch
            {
                MicOwnerState.Standby => "standby",
                MicOwnerState.Handoff or MicOwnerState.Listening => "listening",
                MicOwnerState.Degraded => "degraded",
                _ => "off",
            },
            hostVersion,
            recognizer?.Name,
            recognizer?.Culture,
            MicrophoneName(),
            LastFault,
            (_engine as SystemSpeechWakeEngine)?.PronunciationGrammarLoaded ?? true);
    }

    /// <summary>
    /// ชื่อไมโครโฟนที่คนอ่านออก — System.Speech ไม่บอกชื่ออุปกรณ์ที่ใช้อยู่
    /// จึงรายงานได้แค่ว่า "ใช้ตัวที่ Windows ตั้งเป็นค่าเริ่มต้น" ตามความจริง
    /// ไม่เดาชื่อจากที่อื่นเพราะจะทำให้ผู้ใช้ไล่ปัญหาผิดตัว
    /// </summary>
    private string? MicrophoneName() => State == MicOwnerState.Degraded ? null : "ไมโครโฟนเริ่มต้นของ Windows";

    private async Task StartEngineLockedAsync(CancellationToken ct)
    {
        if (_engine is not null) return;

        var engine = _engineFactory();
        engine.WakeDetected += OnWakeDetected;
        engine.Faulted += OnEngineFaulted;

        try
        {
            await engine.StartAsync(_options, ct);
        }
        catch (Exception ex)
        {
            await DetachAndDisposeAsync(engine);
            State = MicOwnerState.Degraded;
            LastFault = ex.GetType().Name;
            _log("error", "voice_mic_start_failed", $"เปิดไมโครโฟนไม่สำเร็จ: {ex.GetType().Name}");
            return;
        }

        if (engine.State != WakeEngineState.Listening)
        {
            await DetachAndDisposeAsync(engine);

            // อุปกรณ์ไม่ว่าง/หายไป: ลองใหม่ครั้งเดียว เผื่อโปรแกรมอื่นเพิ่งปล่อยไมค์
            if (!_deviceRetryUsed && LastFault is "audio_device_busy" or "audio_input_missing")
            {
                _deviceRetryUsed = true;
                _log("warn", "voice_mic_retry", $"ไมโครโฟนยังใช้ไม่ได้ ({LastFault}) — ลองใหม่อีกครั้งเดียว");
                await _delay(TimeSpan.FromMilliseconds(DeviceRetryDelayMs));
                await StartEngineLockedAsync(ct);
                return;
            }

            State = MicOwnerState.Degraded;
            _log("error", "voice_mic_unavailable", $"ใช้ไมโครโฟนไม่ได้: {LastFault ?? "unknown"}");
            return;
        }

        _engine = engine;
        EngineStartCount++;
        State = MicOwnerState.Standby;
    }

    private async Task StopEngineLockedAsync(CancellationToken ct)
    {
        if (_engine is null) return;
        var engine = _engine;
        _engine = null;

        try
        {
            await engine.StopAsync(ct);
        }
        catch (Exception ex)
        {
            LastFault = ex.GetType().Name;
            _log("error", "voice_mic_stop_failed", $"หยุดฟังไม่สนิท: {ex.GetType().Name}");
        }

        await DetachAndDisposeAsync(engine);
    }

    private async Task DetachAndDisposeAsync(IWakeWordEngine engine)
    {
        engine.WakeDetected -= OnWakeDetected;
        engine.Faulted -= OnEngineFaulted;
        try
        {
            await engine.DisposeAsync();
        }
        catch (Exception ex)
        {
            _log("error", "voice_mic_dispose_failed", $"ปล่อยทรัพยากรไม่สำเร็จ: {ex.GetType().Name}");
        }
    }

    /// <summary>
    /// ได้ยินคำปลุก — ลำดับตรงนี้สำคัญกว่าความเร็ว
    /// ต้องหยุด engine และรอให้ไมค์ถูกปล่อยจริงก่อน แล้วจึงบอกเว็บ
    /// ถ้าสลับลำดับ เว็บจะขอไมค์ตอนที่ native ยังถืออยู่ = เปิดไม่ได้ หรือได้เสียงว่าง
    /// </summary>
    private async void OnWakeDetected(object? sender, WakeDetectedEventArgs e)
    {
        await _gate.WaitAsync();
        try
        {
            if (State != MicOwnerState.Standby) return;

            await StopEngineLockedAsync(CancellationToken.None);
            var message = _session.OnWakeAccepted(e.PhraseId, e.Confidence, _clock(), e.DetectedAt);
            State = MicOwnerState.Handoff;
            MessageForWeb?.Invoke(this, message);
        }
        catch (Exception ex)
        {
            _log("error", "voice_wake_handoff_failed", $"ส่งไมค์ต่อไม่สำเร็จ: {ex.GetType().Name}");
        }
        finally
        {
            _gate.Release();
        }
    }

    private void OnEngineFaulted(object? sender, WakeEngineFaultEventArgs e)
    {
        LastFault = e.Code;
        if (e.Code == "pronunciation_fallback")
        {
            _log("warn", "voice_pronunciation_fallback", "เครื่องนี้ใช้ไวยากรณ์แบบไม่มีหน่วยเสียง คำปลุกไทยอาจจับได้น้อยลง");
            return;
        }
        _log("error", "voice_mic_fault", $"ชุดรู้จำเสียงมีปัญหา: {e.Code}");
    }

    /// <summary>พักสั้น ๆ แล้วกลับไปฟังคำปลุก — พักเพื่อไม่ให้ประโยคสุดท้ายของผู้ใช้ปลุกซ้ำทันที</summary>
    private async Task ReturnToStandbyAsync(CancellationToken ct)
    {
        State = MicOwnerState.Cooldown;
        await _delay(TimeSpan.FromMilliseconds(CooldownMs));

        await _gate.WaitAsync(CancellationToken.None);
        try
        {
            // ระหว่างพัก อาจมีคำสั่งปิด/ล็อกเข้ามาแทรก — เคารพสถานะล่าสุดเสมอ
            if (State != MicOwnerState.Cooldown) return;
            await StartEngineLockedAsync(ct);
        }
        finally
        {
            _gate.Release();
        }
    }
}
