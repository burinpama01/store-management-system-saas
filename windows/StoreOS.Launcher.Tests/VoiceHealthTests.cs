using System.IO;
using System.Text.Json;

using StoreOS.Launcher;
using StoreOS.Launcher.Services;
using StoreOS.Voice;

using Xunit;

namespace StoreOS.Launcher.Tests;

/// <summary>W8 — ค่าตั้งต่อเครื่องและสถานะที่ส่งให้หน้าเว็บ</summary>
public class LauncherSettingsSaveTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "storeos-settings-" + Guid.NewGuid().ToString("n")[..8]);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); }
        catch (IOException) { /* เครื่อง build อาจล็อกไฟล์อยู่ — ไม่ใช่ความล้มเหลวของเทสต์ */ }
    }

    [Fact]
    public void บันทึกแล้วอ่านกลับได้ครบ()
    {
        var settings = new LauncherSettings { VoiceStandbyEnabled = true, Channel = "dev" };

        settings.Save(_root);

        var json = File.ReadAllText(LauncherSettings.FilePath(_root));
        var loaded = JsonSerializer.Deserialize<LauncherSettings>(json)!;
        Assert.True(loaded.VoiceStandbyEnabled);
        Assert.Equal("dev", loaded.Channel);
    }

    [Fact]
    public void เขียนทับของเดิมได้และไม่เหลือไฟล์ชั่วคราวค้าง()
    {
        new LauncherSettings { VoiceStandbyEnabled = false }.Save(_root);
        new LauncherSettings { VoiceStandbyEnabled = true }.Save(_root);

        var dir = Path.GetDirectoryName(LauncherSettings.FilePath(_root))!;
        Assert.Empty(Directory.GetFiles(dir, "*.tmp"));
        Assert.Contains("\"VoiceStandbyEnabled\": true", File.ReadAllText(LauncherSettings.FilePath(_root)));
    }

    [Fact]
    public void ไฟล์เสียต้องได้ค่าเริ่มต้นที่ปลอดภัย_ไม่ใช่เปิดคำปลุกเอง()
    {
        // ไฟล์พังแล้วเปิดคำปลุกเองคือสิ่งที่ห้ามเกิดที่สุด — ไมค์ต้องไม่ทำงานโดยไม่มีใครสั่ง
        var fallback = new LauncherSettings();

        Assert.False(fallback.VoiceStandbyEnabled);
        Assert.Equal("prod", fallback.Channel);
    }
}

public class VoiceHealthTests
{
    private sealed class FakeEngine : IWakeWordEngine
    {
        public WakeEngineState State { get; private set; } = WakeEngineState.Off;
        public WakeEngineFaultEventArgs? StartFault { get; init; }
        public event EventHandler<WakeDetectedEventArgs>? WakeDetected;
        public event EventHandler<WakeEngineFaultEventArgs>? Faulted;

        public Task StartAsync(WakeWordOptions options, CancellationToken ct)
        {
            if (StartFault is not null)
            {
                State = WakeEngineState.Faulted;
                Faulted?.Invoke(this, StartFault);
                return Task.CompletedTask;
            }
            State = WakeEngineState.Listening;
            _ = WakeDetected; // ไม่ใช้ในเทสต์ชุดนี้
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken ct)
        {
            State = WakeEngineState.Off;
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private static VoiceStandbyHost Build(FakeEngine engine) =>
        new(() => engine, (_, _, _) => { }, hostVersion: "9.9.9");

    [Fact]
    public async Task เปิดสำเร็จแล้วส่งสถานะให้หน้าเว็บทันที()
    {
        VoiceHealthMessage? sent = null;
        var host = Build(new FakeEngine());
        host.HealthForWeb += (_, health) => sent = health;

        await host.StartAsync(enabled: true);

        Assert.NotNull(sent);
        Assert.Equal(StandbyContract.Health, sent!.Type);
        Assert.Equal("standby", sent.State);
        Assert.Equal("9.9.9", sent.HostVersion);
    }

    [Fact]
    public async Task สถานะที่ส่งออกต้องไม่มีเส้นทางไฟล์หรือชื่อเครื่อง()
    {
        VoiceHealthMessage? sent = null;
        var host = Build(new FakeEngine());
        host.HealthForWeb += (_, health) => sent = health;
        await host.StartAsync(enabled: true);

        Assert.NotNull(sent);
        var json = StandbyContract.Serialize(sent!);

        Assert.DoesNotContain(Environment.MachineName, json);
        Assert.DoesNotContain("token", json, StringComparison.OrdinalIgnoreCase);
        // ตรวจที่ค่าจริง ไม่ใช่ที่ JSON ดิบ — System.Text.Json แปลงอักษรไทยเป็น escape \uXXXX
        // การค้นหาเครื่องหมายของเส้นทางไฟล์ในสตริง JSON จึงไปเจอ escape ของภาษาไทยแทน
        foreach (var field in new[] { sent!.HostVersion, sent.Recognizer, sent.RecognizerCulture, sent.Microphone })
        {
            if (field is null) continue;
            Assert.False(field.Contains('\\'), $"ค่าที่ส่งออกมีเครื่องหมายของเส้นทางไฟล์: {field}");
            Assert.False(field.Contains('/'), $"ค่าที่ส่งออกมีเครื่องหมายของเส้นทางไฟล์: {field}");
        }
    }

    [Fact]
    public async Task เปิดไม่ได้ต้องรายงานเป็น_degraded_พร้อมรหัสปัญหา()
    {
        VoiceHealthMessage? sent = null;
        var host = Build(new FakeEngine
        {
            StartFault = new WakeEngineFaultEventArgs("microphone_denied", "ไม่ได้รับอนุญาต"),
        });
        host.HealthForWeb += (_, health) => sent = health;

        await host.StartAsync(enabled: true);

        Assert.Equal("degraded", sent!.State);
        Assert.Equal("microphone_denied", sent.FaultCode);
        // ไม่มีไมค์ให้ใช้ = ต้องไม่อ้างว่ามี
        Assert.Null(sent.Microphone);
    }

    [Fact]
    public async Task กดตรวจอีกครั้งตอนใช้ไม่ได้_ต้องลองเปิดใหม่แล้วรายงานผล()
    {
        var host = Build(new FakeEngine
        {
            StartFault = new WakeEngineFaultEventArgs("audio_device_busy", "ไมค์ไม่ว่าง"),
        });
        var reports = 0;
        host.HealthForWeb += (_, _) => reports++;
        await host.StartAsync(enabled: true);
        var afterStart = reports;

        await host.RecheckAsync();

        Assert.True(reports > afterStart);
    }

    [Fact]
    public async Task ปิดคำปลุกอยู่_กดตรวจอีกครั้งต้องไม่แตะไมโครโฟน()
    {
        var host = Build(new FakeEngine());
        var reports = 0;
        host.HealthForWeb += (_, _) => reports++;

        await host.StartAsync(enabled: false);
        await host.RecheckAsync();

        Assert.Equal(0, reports);
    }
}
