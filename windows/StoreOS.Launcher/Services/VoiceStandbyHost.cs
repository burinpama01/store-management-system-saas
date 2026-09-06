using StoreOS.Voice;

namespace StoreOS.Launcher.Services;

/// <summary>สถานะที่ Launcher สนใจ (ย่อจากสถานะละเอียดของตัวประสานงานไมโครโฟน)</summary>
public enum VoiceHostState
{
    /// <summary>ปิดอยู่ — ไม่ถือไมโครโฟน</summary>
    Off,
    /// <summary>กำลังเปิดชุดรู้จำเสียง</summary>
    Starting,
    /// <summary>ทำงานอยู่ (ฟังคำปลุก หรือกำลังส่งไมค์ให้เว็บ)</summary>
    Standby,
    /// <summary>เปิดไม่สำเร็จหรือพังกลางทาง — POS ยังใช้งานได้ตามปกติ</summary>
    Degraded,
}

/// <summary>
/// ด้านที่ Launcher มองเห็นของฟีเจอร์คำปลุก (แผน v1 W1–W3)
///
/// งานจริงทั้งหมดอยู่ที่ <see cref="MicrophoneCoordinator"/> ในไลบรารีกลาง —
/// คลาสนี้เหลือแค่สามหน้าที่: เคารพ feature flag ต่อเครื่อง, แปลงสถานะให้ UI อ่านง่าย,
/// และส่ง log เข้าคิวของ Launcher
///
/// กฎที่ยึด: <b>POS ต้องเปิดได้เสมอ</b> — คำปลุกพังต้องไม่ทำให้ขายของไม่ได้
/// </summary>
public sealed class VoiceStandbyHost : IAsyncDisposable
{
    private readonly MicrophoneCoordinator _coordinator;
    private readonly Action<string, string, string> _log;
    private readonly string _hostVersion;
    private long _healthSeq;
    private bool _enabled;
    private bool _disposed;

    /// <param name="engineFactory">สร้างเครื่องยนต์คำปลุก (ตัวจริงคือ SystemSpeechWakeEngine)</param>
    /// <param name="log">level, code, message — ต่อเข้ากับ LauncherLogShipper</param>
    public VoiceStandbyHost(
        Func<IWakeWordEngine> engineFactory,
        Action<string, string, string> log,
        WakeWordOptions? options = null,
        string hostVersion = "0.0.0")
    {
        _log = log;
        _hostVersion = hostVersion;
        _coordinator = new MicrophoneCoordinator(engineFactory, log, options);
        _coordinator.MessageForWeb += (_, message) => MessageForWeb?.Invoke(this, message);
    }

    public VoiceHostState State => _coordinator.State switch
    {
        MicOwnerState.Off or MicOwnerState.Suspended => VoiceHostState.Off,
        MicOwnerState.Degraded => VoiceHostState.Degraded,
        _ => VoiceHostState.Standby,
    };

    public string? LastFault => _coordinator.LastFault;
    /// <summary>นับจำนวนครั้งที่เปิดเครื่องยนต์จริง — ใช้ยืนยันว่า Start ซ้ำไม่เปิดซ้อน</summary>
    public int EngineStartCount => _coordinator.EngineStartCount;

    /// <summary>ข้อความที่ต้องส่งให้หน้าเว็บ — ส่งจริงผ่าน WebView2 ที่ชั้น bridge</summary>
    public event EventHandler<StandbyMessage>? MessageForWeb;

    /// <summary>สถานะของเครื่องที่ต้องส่งให้หน้าตั้งค่าบนเว็บ (W8)</summary>
    public event EventHandler<VoiceHealthMessage>? HealthForWeb;

    /// <summary>ส่งสถานะล่าสุดให้หน้าเว็บ (ตอนเปิดหน้า, ตอนสถานะเปลี่ยน, หรือตอนผู้ใช้กด "ตรวจอีกครั้ง")</summary>
    public void PublishHealth()
    {
        var health = _coordinator.BuildHealth(_hostVersion, ++_healthSeq);
        HealthForWeb?.Invoke(this, health);
    }

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

        _enabled = true;
        await _coordinator.StartAsync(ct);
        if (State == VoiceHostState.Standby)
            _log("info", "voice_standby_started", "เริ่มฟังคำปลุกแล้ว");
        PublishHealth();
    }

    /// <summary>ปิดและคืนไมโครโฟน — เรียกซ้ำได้ และปลอดภัยแม้ไม่เคยเปิด</summary>
    public async Task StopAsync(CancellationToken ct = default)
    {
        if (!_enabled) return;
        _enabled = false;
        await _coordinator.StopAsync(ct);
        _log("info", "voice_standby_stopped", "ปิดโหมดคำปลุกและคืนไมโครโฟนแล้ว");
    }

    /// <summary>เดินนาฬิกาให้ watchdog — Launcher เรียกจากตัวจับเวลาเดิมที่มีอยู่แล้ว</summary>
    public Task TickAsync() => _enabled ? _coordinator.TickAsync() : Task.CompletedTask;

    /// <summary>
    /// ผู้ใช้กด "ตรวจอีกครั้ง" บนหน้าตั้งค่า — ลองเปิดใหม่ถ้าตอนนี้ใช้ไม่ได้ แล้วรายงานผลกลับ
    /// เป็นทางออกจากสถานะ Degraded โดยไม่ต้องปิดเปิดโปรแกรมทั้งตัว
    /// </summary>
    public async Task RecheckAsync(CancellationToken ct = default)
    {
        if (!_enabled) return;
        if (State == VoiceHostState.Degraded) await _coordinator.StartAsync(ct);
        PublishHealth();
    }

    /// <summary>ต่อสัญญาณล็อกจอ/หลับของ Windows</summary>
    public void Attach(ISystemSuspendSignals signals) => _coordinator.Attach(signals);

    /// <summary>เว็บรายงานกลับมาว่าเริ่มฟัง/คุยต่อ/จบรอบ (ใช้จริงเมื่อ W4 ต่อสายเสร็จ)</summary>
    public void OnWebSessionStarted() => _coordinator.OnWebSessionStarted();
    public void OnWebSessionExtended() => _coordinator.OnWebSessionExtended();
    public Task OnWebSessionEndedAsync() => _coordinator.OnWebSessionEndedAsync();

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        await _coordinator.DisposeAsync();
    }
}
