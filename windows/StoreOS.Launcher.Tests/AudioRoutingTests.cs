using Xunit;
using StoreOS.Launcher;
using StoreOS.Launcher.Services.Audio;

namespace StoreOS.Launcher.Tests;

public class AudioRoutingTests
{
    private static readonly AudioOutputDevice Main = new("{0.0.0.00000000}.{main}", "ลำโพงหลัก", true);
    private static readonly AudioOutputDevice Usb = new("{0.0.0.00000000}.{usb}", "USB Speaker", false);

    [Fact]
    public void NoSelection_UsesWindowsDefault()
    {
        var (device, fellBack) = AudioDeviceResolver.Resolve(null, [Main, Usb]);
        Assert.Equal(Main, device);
        Assert.False(fellBack);
    }

    [Fact]
    public void SelectedDevice_IsUsedWhenPresent()
    {
        var (device, fellBack) = AudioDeviceResolver.Resolve(Usb.Id.ToUpperInvariant(), [Main, Usb]);
        Assert.Equal(Usb, device);
        Assert.False(fellBack);
    }

    [Fact]
    public void UnpluggedSelection_FallsBackToDefaultAndSaysSo()
    {
        var (device, fellBack) = AudioDeviceResolver.Resolve(Usb.Id, [Main]);
        Assert.Equal(Main, device);
        Assert.True(fellBack);
    }

    [Fact]
    public void Tones_MatchWebBeepLengths_AndUnknownIsSilent()
    {
        var qr = AlertTones.Render(AlertSoundIds.Qr, 44100);
        var connect = AlertTones.Render(AlertSoundIds.Connect, 44100);
        Assert.InRange(qr.Length, (int)(0.5 * 44100), (int)(0.56 * 44100));
        Assert.InRange(connect.Length, (int)(0.45 * 44100), (int)(0.5 * 44100));
        Assert.All(qr, s => Assert.InRange(s, -1f, 1f));
        Assert.Empty(AlertTones.Render("siren", 44100));
        Assert.Empty(AlertTones.Render(AlertSoundIds.Order, 44100)); // order = ไฟล์ mp3 ไม่ใช่ tone
    }

    [Fact]
    public void OrderSound_IsEmbeddedInTheLauncher()
    {
        using var stream = typeof(AlertPlayer).Assembly.GetManifestResourceStream("StoreOS.Launcher.alert_new_order.mp3");
        Assert.NotNull(stream);
        Assert.Equal(26452, stream!.Length);
    }

    [Fact]
    public void InterfaceDeviceId_RoundTrips()
    {
        var path = ProcessAudioRouter.ToInterfaceDeviceId(Usb.Id);
        Assert.StartsWith(@"\\?\SWD#MMDEVAPI#", path);
        Assert.EndsWith("#{e6327cad-dcec-4949-ae8a-991e976a79d2}", path);
        Assert.Equal(Usb.Id, ProcessAudioRouter.FromInterfaceDeviceId(path));
        Assert.Null(ProcessAudioRouter.FromInterfaceDeviceId(null));
        Assert.Null(ProcessAudioRouter.FromInterfaceDeviceId("garbage"));
    }

    [Fact]
    public void Settings_WithSpeakers_KeepsOtherValues()
    {
        var original = new LauncherSettings { VoiceStandbyEnabled = true, Channel = "dev" };
        var updated = original.WithSpeakers(Usb.Id, 150, "  ");
        Assert.True(updated.VoiceStandbyEnabled);
        Assert.Equal("dev", updated.Channel);
        Assert.Equal(Usb.Id, updated.AlertOutputDeviceId);
        Assert.Equal(100, updated.AlertVolume);
        Assert.Null(updated.MusicOutputDeviceId); // ช่องว่าง = ลำโพงหลักของ Windows

        var voiceToggled = updated.WithVoiceStandby(false);
        Assert.Equal(Usb.Id, voiceToggled.AlertOutputDeviceId); // สลับคำปลุกต้องไม่ล้างค่าลำโพง
        Assert.Equal(100, voiceToggled.AlertVolume);
    }

    /// <summary>เล่นเสียงจริงออกลำโพงหลักของเครื่องนี้ (เปิดด้วย STOREOS_AUDIO_POLICY_TEST=1)</summary>
    [Fact]
    public async Task AlertPlayer_PlaysOnThisMachine()
    {
        if (Environment.GetEnvironmentVariable("STOREOS_AUDIO_POLICY_TEST") != "1") return;

        var logs = new List<string>();
        using var player = new AlertPlayer(new WasapiDeviceCatalog(), () => new LauncherSettings { AlertVolume = 20 }, (_, code, _) => logs.Add(code));
        var order = player.Play(AlertSoundIds.Order);
        Assert.True(order.Played, order.Error);
        Assert.False(order.FellBack);
        await Task.Delay(1800); // ให้เสียง 1.6 วิ เล่นจบ
        var qr = player.Play(AlertSoundIds.Qr);
        Assert.True(qr.Played, qr.Error);
        await Task.Delay(700);
        Assert.Empty(logs);

        var missing = new AlertPlayer(new WasapiDeviceCatalog(), () => new LauncherSettings().WithSpeakers("{gone}", 20, null), (_, code, _) => logs.Add(code));
        var fallback = missing.Play(AlertSoundIds.Connect);
        Assert.True(fallback.Played, fallback.Error);
        Assert.True(fallback.FellBack);
        Assert.Contains("alert_device_missing", logs);
        await Task.Delay(700);
        missing.Dispose();
    }

    /// <summary>
    /// ทดสอบกับ Windows จริง (เปิดด้วย STOREOS_AUDIO_POLICY_TEST=1) — ตั้งลำโพงให้ process ทดสอบแล้วอ่านกลับ
    /// ยืนยันว่า vtable slot ถูกต้องบนเครื่องนี้ และล้างค่ากลับทุกครั้ง
    /// </summary>
    [Fact]
    public void ProcessRouting_RoundTripsOnThisMachine()
    {
        if (Environment.GetEnvironmentVariable("STOREOS_AUDIO_POLICY_TEST") != "1") return;

        var devices = new WasapiDeviceCatalog().ListOutputs();
        Assert.NotEmpty(devices);
        var router = new ProcessAudioRouter();
        Assert.True(router.IsSupported);

        var pid = (uint)Environment.ProcessId;
        var target = devices[0];
        try
        {
            Assert.True(router.TrySetProcessOutput(pid, target.Id));
            Assert.Equal(target.Id, router.TryGetProcessOutput(pid), ignoreCase: true);
        }
        finally
        {
            Assert.True(router.TrySetProcessOutput(pid, null));
        }
        Assert.Null(router.TryGetProcessOutput(pid));
    }
}
