using StoreOS.Launcher.Services;

using Xunit;

namespace StoreOS.Launcher.Tests;

/// <summary>
/// W1 — วงจรชีวิตของฝั่งคำปลุก
///
/// ข้อที่สำคัญที่สุดคือ "ปิดโปรแกรมทางไหนก็ต้องคืนไมโครโฟน" และ "คำปลุกพังต้องไม่ทำให้ POS พัง"
/// </summary>
public class VoiceStandbyHostTests
{
    private sealed class FakeEngine : IWakeEngine
    {
        public int StartCalls { get; private set; }
        public int StopCalls { get; private set; }
        public int DisposeCalls { get; private set; }
        public Exception? StartThrows { get; init; }
        public Exception? StopThrows { get; init; }

        public Task StartAsync(CancellationToken ct)
        {
            StartCalls++;
            if (StartThrows is not null) throw StartThrows;
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken ct)
        {
            StopCalls++;
            if (StopThrows is not null) throw StopThrows;
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            DisposeCalls++;
            return ValueTask.CompletedTask;
        }
    }

    private static (VoiceStandbyHost host, FakeEngine engine, List<string> logs) Build(FakeEngine? engine = null)
    {
        var e = engine ?? new FakeEngine();
        var logs = new List<string>();
        var host = new VoiceStandbyHost(() => e, (level, code, _) => logs.Add($"{level}:{code}"));
        return (host, e, logs);
    }

    [Fact]
    public async Task ปิดอยู่ที่เครื่องนี้แปลว่าไม่แตะไมโครโฟนเลย()
    {
        var (host, engine, logs) = Build();

        await host.StartAsync(enabled: false);

        Assert.Equal(VoiceHostState.Off, host.State);
        Assert.Equal(0, engine.StartCalls);
        Assert.Contains("info:voice_standby_disabled", logs);
    }

    [Fact]
    public async Task เปิดแล้วเข้าสถานะ_standby()
    {
        var (host, engine, _) = Build();

        await host.StartAsync(enabled: true);

        Assert.Equal(VoiceHostState.Standby, host.State);
        Assert.Equal(1, engine.StartCalls);
    }

    [Fact]
    public async Task เปิดซ้ำต้องไม่สร้างเครื่องยนต์ตัวที่สอง()
    {
        var (host, engine, _) = Build();

        await host.StartAsync(enabled: true);
        await host.StartAsync(enabled: true);
        await host.StartAsync(enabled: true);

        Assert.Equal(1, engine.StartCalls);
        Assert.Equal(1, host.EngineStartCount);
    }

    [Fact]
    public async Task เปิดไม่ขึ้นต้องกลายเป็น_degraded_ไม่ใช่โยน_error_ออกไป()
    {
        var engine = new FakeEngine { StartThrows = new InvalidOperationException("ไม่มีไมโครโฟน") };
        var (host, _, logs) = Build(engine);

        await host.StartAsync(enabled: true);

        Assert.Equal(VoiceHostState.Degraded, host.State);
        Assert.Equal("InvalidOperationException", host.LastFault);
        // เปิดไม่ขึ้นต้องปล่อยของทิ้ง ไม่ค้างไว้กินไมค์
        Assert.Equal(1, engine.DisposeCalls);
        Assert.Contains("error:voice_standby_failed", logs);
    }

    [Fact]
    public async Task หยุดโดยไม่เคยเริ่มต้องไม่พัง()
    {
        var (host, engine, _) = Build();

        await host.StopAsync();

        Assert.Equal(VoiceHostState.Off, host.State);
        Assert.Equal(0, engine.StopCalls);
    }

    [Fact]
    public async Task หยุดซ้ำได้และคืนทรัพยากรครั้งเดียว()
    {
        var (host, engine, _) = Build();
        await host.StartAsync(enabled: true);

        await host.StopAsync();
        await host.StopAsync();

        Assert.Equal(1, engine.StopCalls);
        Assert.Equal(1, engine.DisposeCalls);
        Assert.Equal(VoiceHostState.Off, host.State);
    }

    [Fact]
    public async Task หยุดไม่สำเร็จก็ยังต้องปล่อยไมโครโฟน()
    {
        var engine = new FakeEngine { StopThrows = new TimeoutException("หยุดไม่ทัน") };
        var (host, _, logs) = Build(engine);
        await host.StartAsync(enabled: true);

        await host.StopAsync();

        Assert.Equal(1, engine.DisposeCalls);
        Assert.Equal(VoiceHostState.Off, host.State);
        Assert.Contains("error:voice_standby_stop_failed", logs);
    }

    [Fact]
    public async Task dispose_ต้องคืนไมโครโฟนให้เรียบร้อย()
    {
        var (host, engine, _) = Build();
        await host.StartAsync(enabled: true);

        await host.DisposeAsync();

        Assert.Equal(1, engine.StopCalls);
        Assert.Equal(1, engine.DisposeCalls);
    }

    [Fact]
    public async Task dispose_ซ้ำได้()
    {
        var (host, _, _) = Build();
        await host.StartAsync(enabled: true);

        await host.DisposeAsync();
        await host.DisposeAsync();
    }

    [Fact]
    public async Task เปิดหลัง_dispose_ต้องถูกปฏิเสธชัดเจน()
    {
        var (host, _, _) = Build();
        await host.DisposeAsync();

        await Assert.ThrowsAsync<ObjectDisposedException>(() => host.StartAsync(enabled: true));
    }

    [Fact]
    public async Task ปิดแล้วเปิดใหม่ได้()
    {
        var (host, engine, _) = Build();

        await host.StartAsync(enabled: true);
        await host.StopAsync();
        await host.StartAsync(enabled: true);

        Assert.Equal(2, engine.StartCalls);
        Assert.Equal(VoiceHostState.Standby, host.State);
    }

    [Fact]
    public async Task เครื่องยนต์ของ_W1_ยังไม่ฟังเสียงจริง()
    {
        // ยืนยันเจตนา: W1 ต่อวงจรชีวิตให้ครบ แต่ยังไม่มีการเปิดไมโครโฟน (นั่นคือ W2)
        var engine = new PlaceholderWakeEngine();
        var host = new VoiceStandbyHost(() => engine, (_, _, _) => { });

        await host.StartAsync(enabled: true);
        Assert.True(engine.Started);

        await host.DisposeAsync();
        Assert.True(engine.Disposed);
        Assert.False(engine.Started);
    }
}
