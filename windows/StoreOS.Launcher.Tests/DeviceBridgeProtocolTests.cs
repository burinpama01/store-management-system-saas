using System.Text.Json;
using StoreOS.Launcher;
using StoreOS.Launcher.Services;
using StoreOS.Launcher.Services.Audio;
using Xunit;

namespace StoreOS.Launcher.Tests;

public class DeviceBridgeProtocolTests
{
    private static string Msg(string type, string extra = "") =>
        $$"""{"channel":"storeos.device","type":"{{type}}"{{extra}}}""";

    [Fact]
    public void IgnoresOtherChannelsAndGarbage()
    {
        Assert.Null(DeviceBridgeProtocol.Parse(null));
        Assert.Null(DeviceBridgeProtocol.Parse("\"provision-string\"")); // ข้อความ provision เป็น string
        Assert.Null(DeviceBridgeProtocol.Parse("""{"v":1,"type":"sessionStarted"}""")); // สัญญาคำปลุก
        Assert.Null(DeviceBridgeProtocol.Parse(Msg("shell.exec")));
        Assert.Null(DeviceBridgeProtocol.Parse("{" + new string(' ', 5000) + "}"));
    }

    [Fact]
    public void AlertPlay_AcceptsOnlyKnownSounds()
    {
        Assert.Equal("order", DeviceBridgeProtocol.Parse(Msg("alert.play", ",\"sound\":\"order\""))!.Sound);
        Assert.Equal("connect", DeviceBridgeProtocol.Parse(Msg("alert.play", ",\"sound\":\"connect\""))!.Sound);
        Assert.Null(DeviceBridgeProtocol.Parse(Msg("alert.play", ",\"sound\":\"C:\\\\evil.wav\"")));
    }

    [Fact]
    public void SpeakersSet_NormalisesValues()
    {
        var request = DeviceBridgeProtocol.Parse(Msg(
            "speakers.set",
            ",\"alertDeviceId\":\"{0.0.0.00000000}.{usb}\",\"alertVolume\":250,\"musicDeviceId\":\"\""))!;
        Assert.True(request.HasSpeakers);
        Assert.Equal("{0.0.0.00000000}.{usb}", request.AlertDeviceId);
        Assert.Equal(100, request.AlertVolume);
        Assert.Null(request.MusicDeviceId); // ว่าง = ลำโพงหลักของ Windows
    }

    [Fact]
    public void OutboundMessages_CarryTheChannel()
    {
        using var hello = JsonDocument.Parse(DeviceBridgeProtocol.Hello("0.5.0", ["alert-player", "self-update"]));
        Assert.Equal("storeos.device", hello.RootElement.GetProperty("channel").GetString());
        Assert.Equal("hello", hello.RootElement.GetProperty("type").GetString());
        Assert.Equal(2, hello.RootElement.GetProperty("capabilities").GetArrayLength());

        var settings = new LauncherSettings().WithSpeakers("{usb}", 70, null);
        using var speakers = JsonDocument.Parse(DeviceBridgeProtocol.Speakers(
            [new AudioOutputDevice("{main}", "ลำโพงหลัก", true), new AudioOutputDevice("{usb}", "USB", false)],
            settings,
            musicRoutingSupported: true));
        Assert.Equal("{usb}", speakers.RootElement.GetProperty("alertDeviceId").GetString());
        Assert.Equal(70, speakers.RootElement.GetProperty("alertVolume").GetInt32());
        Assert.Equal(JsonValueKind.Null, speakers.RootElement.GetProperty("musicDeviceId").ValueKind);
        Assert.True(speakers.RootElement.GetProperty("devices")[0].GetProperty("isDefault").GetBoolean());

        using var status = JsonDocument.Parse(DeviceBridgeProtocol.UpdateStatus("ready", "0.5.0", "0.5.1", null));
        Assert.Equal("update.status", status.RootElement.GetProperty("type").GetString());
        Assert.Equal("0.5.1", status.RootElement.GetProperty("version").GetString());
    }
}
