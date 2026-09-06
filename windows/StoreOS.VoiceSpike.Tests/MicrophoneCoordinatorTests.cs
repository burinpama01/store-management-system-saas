using StoreOS.Voice;

using Xunit;

namespace StoreOS.Voice.Tests;

/// <summary>
/// W3 — เจ้าของไมโครโฟนหนึ่งเดียว
///
/// ตารางสถานะที่แผนกำหนด: OFF → STANDBY → HANDOFF → LISTENING → COOLDOWN
/// รวมถึงล็อกจอ/หลับ/ตื่น และอุปกรณ์หายกลางทาง
/// เทสต์ทั้งหมดใช้นาฬิกาและการหน่วงเวลาปลอม จึงเร็วและให้ผลเดิมทุกครั้ง
/// </summary>
public class MicrophoneCoordinatorTests
{
    private sealed class FakeEngine : IWakeWordEngine
    {
        public static int LiveCount;

        public int StartCalls { get; private set; }
        public int StopCalls { get; private set; }
        public WakeEngineState State { get; private set; } = WakeEngineState.Off;
        public WakeEngineFaultEventArgs? StartFault { get; set; }

        public event EventHandler<WakeDetectedEventArgs>? WakeDetected;
        public event EventHandler<WakeEngineFaultEventArgs>? Faulted;

        public Task StartAsync(WakeWordOptions options, CancellationToken ct)
        {
            StartCalls++;
            if (StartFault is not null)
            {
                State = WakeEngineState.Faulted;
                Faulted?.Invoke(this, StartFault);
                return Task.CompletedTask;
            }
            State = WakeEngineState.Listening;
            Interlocked.Increment(ref LiveCount);
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken ct)
        {
            StopCalls++;
            if (State == WakeEngineState.Listening) Interlocked.Decrement(ref LiveCount);
            State = WakeEngineState.Off;
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;

        public void RaiseWake(string phraseId = "sawatdee_os", double confidence = 0.93) =>
            WakeDetected?.Invoke(this, new WakeDetectedEventArgs(phraseId, confidence, DateTimeOffset.Now));
    }

    private sealed class Harness
    {
        public long Now;
        public readonly List<StandbyMessage> ToWeb = new();
        public readonly List<string> Logs = new();
        public readonly List<FakeEngine> Engines = new();
        public FakeEngine Current => Engines[^1];
        public bool Healthy = true;
        public MicrophoneCoordinator Coordinator { get; }

        public Harness(WakeEngineFaultEventArgs? startFault = null)
        {
            FakeEngine.LiveCount = 0;
            Coordinator = new MicrophoneCoordinator(
                () =>
                {
                    var engine = new FakeEngine { StartFault = startFault };
                    Engines.Add(engine);
                    return engine;
                },
                (level, code, _) => Logs.Add($"{level}:{code}"),
                session: new StandbySession(
                    handoffTimeoutMs: 2000,
                    maxListeningWindowMs: 9000,
                    absoluteMaxMs: 20000,
                    sessionIdFactory: () => "sess" + Guid.NewGuid().ToString("n")[..8]),
                clock: () => Now,
                delay: _ => Task.CompletedTask,     // ไม่หน่วงจริงในเทสต์
                healthProbe: () => Healthy);
            Coordinator.MessageForWeb += (_, m) => ToWeb.Add(m);
        }
    }

    [Fact]
    public async Task เริ่มต้นแล้วเข้าสถานะ_standby_และถือไมค์ตัวเดียว()
    {
        var h = new Harness();

        await h.Coordinator.StartAsync();

        Assert.Equal(MicOwnerState.Standby, h.Coordinator.State);
        Assert.Equal(1, FakeEngine.LiveCount);
    }

    [Fact]
    public async Task สั่งเริ่มซ้ำไม่เปิดเครื่องยนต์ซ้อน()
    {
        var h = new Harness();

        await h.Coordinator.StartAsync();
        await h.Coordinator.StartAsync();

        Assert.Single(h.Engines);
        Assert.Equal(1, FakeEngine.LiveCount);
    }

    [Fact]
    public async Task ได้ยินคำปลุกแล้วต้องปล่อยไมค์ก่อนค่อยบอกเว็บ()
    {
        var h = new Harness();
        await h.Coordinator.StartAsync();

        h.Current.RaiseWake();
        await Task.Delay(50); // ปล่อยให้ handler ที่เป็น async void ทำงานจบ

        Assert.Equal(MicOwnerState.Handoff, h.Coordinator.State);
        // หัวใจของ W3: ตอนที่ข้อความถึงเว็บ ต้องไม่มีใครถือไมค์แล้ว
        Assert.Equal(0, FakeEngine.LiveCount);
        Assert.Single(h.ToWeb);
        Assert.Equal(StandbyContract.WakeDetected, h.ToWeb[0].Type);
        Assert.Equal("sawatdee_os", h.ToWeb[0].PhraseId);
    }

    [Fact]
    public async Task ปลุกซ้อนระหว่างส่งต่อไมค์ต้องไม่เกิดขึ้น()
    {
        var h = new Harness();
        await h.Coordinator.StartAsync();
        var engine = h.Current;

        engine.RaiseWake();
        await Task.Delay(50);
        engine.RaiseWake();  // engine ตัวเดิมยิงซ้ำหลังถูกหยุดแล้ว
        await Task.Delay(50);

        Assert.Single(h.ToWeb);
    }

    [Fact]
    public async Task วงจรครบรอบ_standby_handoff_listening_cooldown_แล้วกลับมา_standby()
    {
        var h = new Harness();
        await h.Coordinator.StartAsync();
        h.Current.RaiseWake();
        await Task.Delay(50);

        h.Coordinator.OnWebSessionStarted();
        Assert.Equal(MicOwnerState.Listening, h.Coordinator.State);

        await h.Coordinator.OnWebSessionEndedAsync();

        Assert.Equal(MicOwnerState.Standby, h.Coordinator.State);
        Assert.Equal(2, h.Coordinator.EngineStartCount); // เปิดใหม่หลังพัก
        Assert.Equal(1, FakeEngine.LiveCount);
    }

    [Fact]
    public async Task เว็บไม่ตอบภายในเวลาที่ให้_ต้องคืนไมค์เองและบอกให้กดพูด()
    {
        var h = new Harness();
        await h.Coordinator.StartAsync();
        h.Current.RaiseWake();
        await Task.Delay(50);

        h.Now += 2500; // เกิน ack timeout 2 วินาที
        await h.Coordinator.TickAsync();

        Assert.Equal(MicOwnerState.Standby, h.Coordinator.State);
        Assert.Equal(StandbyContract.WakeFallback, h.ToWeb[^1].Type);
        Assert.Equal("user_activation_missing", h.ToWeb[^1].Reason);
        Assert.Contains("warn:voice_session_timeout", h.Logs);
    }

    [Fact]
    public async Task เว็บฟังค้างเกินหน้าต่างที่ให้_watchdog_ต้องดึงไมค์กลับ()
    {
        var h = new Harness();
        await h.Coordinator.StartAsync();
        h.Current.RaiseWake();
        await Task.Delay(50);
        h.Coordinator.OnWebSessionStarted();

        h.Now += 9500;
        await h.Coordinator.TickAsync();

        Assert.Equal(MicOwnerState.Standby, h.Coordinator.State);
        Assert.Equal(StandbyContract.SessionEnded, h.ToWeb[^1].Type);
        Assert.Equal("watchdog_timeout", h.ToWeb[^1].Reason);
    }

    [Fact]
    public async Task คุยต่อหลายรอบไม่ถูกตัดกลางประโยค()
    {
        var h = new Harness();
        await h.Coordinator.StartAsync();
        h.Current.RaiseWake();
        await Task.Delay(50);
        h.Coordinator.OnWebSessionStarted();

        h.Now += 5000;
        h.Coordinator.OnWebSessionExtended();
        h.Now += 5000;
        await h.Coordinator.TickAsync();

        Assert.Equal(MicOwnerState.Listening, h.Coordinator.State);
    }

    [Fact]
    public async Task ล็อกจอหรือเครื่องหลับต้องปล่อยไมค์ทันที()
    {
        var h = new Harness();
        await h.Coordinator.StartAsync();

        await h.Coordinator.SuspendAsync();

        Assert.Equal(MicOwnerState.Suspended, h.Coordinator.State);
        Assert.Equal(0, FakeEngine.LiveCount);
        Assert.Contains("info:voice_mic_suspended", h.Logs);
    }

    [Fact]
    public async Task ปลดล็อกแล้วกลับมาฟังใหม่()
    {
        var h = new Harness();
        await h.Coordinator.StartAsync();
        await h.Coordinator.SuspendAsync();

        await h.Coordinator.ResumeAsync();

        Assert.Equal(MicOwnerState.Standby, h.Coordinator.State);
        Assert.Equal(1, FakeEngine.LiveCount);
        Assert.Contains("info:voice_mic_resumed", h.Logs);
    }

    [Fact]
    public async Task ตื่นมาแล้วไม่มีชุดรู้จำเสียงต้องเป็น_degraded_ไม่ใช่พยายามเปิดวน()
    {
        var h = new Harness();
        await h.Coordinator.StartAsync();
        await h.Coordinator.SuspendAsync();
        h.Healthy = false;

        await h.Coordinator.ResumeAsync();

        Assert.Equal(MicOwnerState.Degraded, h.Coordinator.State);
        Assert.Equal(0, FakeEngine.LiveCount);
        Assert.Contains("error:voice_mic_resume_failed", h.Logs);
    }

    [Fact]
    public async Task ล็อกระหว่างที่เว็บกำลังฟังก็ต้องปล่อยไมค์()
    {
        var h = new Harness();
        await h.Coordinator.StartAsync();
        h.Current.RaiseWake();
        await Task.Delay(50);
        h.Coordinator.OnWebSessionStarted();

        await h.Coordinator.SuspendAsync();

        Assert.Equal(MicOwnerState.Suspended, h.Coordinator.State);
        Assert.Equal(0, FakeEngine.LiveCount);
    }

    [Fact]
    public async Task ไมโครโฟนไม่ว่างต้องลองใหม่ครั้งเดียวแล้วยอมเป็น_degraded()
    {
        var h = new Harness(new WakeEngineFaultEventArgs("audio_device_busy", "โปรแกรมอื่นใช้ไมค์อยู่"));

        await h.Coordinator.StartAsync();

        Assert.Equal(MicOwnerState.Degraded, h.Coordinator.State);
        // ลองครั้งแรก + ลองซ้ำอีกครั้งเดียว = 2 ครั้ง ไม่ใช่วนไม่หยุด
        Assert.Equal(2, h.Engines.Count);
        Assert.Contains("warn:voice_mic_retry", h.Logs);
        Assert.Contains("error:voice_mic_unavailable", h.Logs);
    }

    [Fact]
    public async Task ไม่มีชุดรู้จำเสียงตั้งแต่แรกต้องไม่ลองซ้ำ()
    {
        var h = new Harness(new WakeEngineFaultEventArgs("no_recognizer", "เครื่องนี้ไม่มีชุดรู้จำเสียง"));

        await h.Coordinator.StartAsync();

        Assert.Equal(MicOwnerState.Degraded, h.Coordinator.State);
        Assert.Single(h.Engines); // ลองซ้ำไปก็ไม่มีทางได้ — อย่าเสียเวลา
    }

    [Fact]
    public async Task หยุดแล้วต้องไม่เหลือใครถือไมค์()
    {
        var h = new Harness();
        await h.Coordinator.StartAsync();

        await h.Coordinator.StopAsync();

        Assert.Equal(MicOwnerState.Off, h.Coordinator.State);
        Assert.Equal(0, FakeEngine.LiveCount);
    }

    [Fact]
    public async Task dispose_ต้องคืนไมค์()
    {
        var h = new Harness();
        await h.Coordinator.StartAsync();

        await h.Coordinator.DisposeAsync();

        Assert.Equal(0, FakeEngine.LiveCount);
    }

    [Fact]
    public async Task ข้อความ_sessionStarted_ที่มาช้าหลังคืนไมค์แล้วต้องถูกทิ้ง()
    {
        var h = new Harness();
        await h.Coordinator.StartAsync();
        h.Current.RaiseWake();
        await Task.Delay(50);
        h.Now += 2500;
        await h.Coordinator.TickAsync(); // คืนไมค์ไปแล้ว

        h.Coordinator.OnWebSessionStarted();

        Assert.Equal(MicOwnerState.Standby, h.Coordinator.State);
        Assert.Equal(1, FakeEngine.LiveCount);
    }
}
