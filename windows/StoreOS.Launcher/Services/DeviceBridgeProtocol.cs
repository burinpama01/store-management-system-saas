using System.Text.Json;
using StoreOS.Launcher.Services.Audio;

namespace StoreOS.Launcher.Services;

/// <summary>คำขอจากหน้าเว็บผ่านช่อง storeos.device (ลำโพง / เสียงแจ้งเตือน / อัปเดต)</summary>
public sealed record DeviceRequest(
    string Type,
    string? Sound = null,
    bool HasSpeakers = false,
    string? AlertDeviceId = null,
    int AlertVolume = 100,
    string? MusicDeviceId = null);

/// <summary>
/// สัญญาข้อความของช่อง "อุปกรณ์ของเครื่อง" ระหว่างหน้าเว็บกับ Launcher
///
/// แยกจากสัญญาคำปลุก (StandbyContract) โดยตั้งใจ: คนละเรื่อง คนละรอบชีวิต และข้อความของช่องนี้
/// ไม่ได้สั่งเปิดไมโครโฟน — ต้องตรงกับ src/modules/launcher/device-host.ts ฝั่งเว็บ
/// ข้อความจากเว็บเป็น "คำขอ" ที่ Launcher ตัดสินเองว่าทำได้แค่ไหน (เช่นติดตั้งอัปเดตต้องให้คนยืนยันก่อน)
/// </summary>
public static class DeviceBridgeProtocol
{
    public const string Channel = "storeos.device";

    public const string HelloRequest = "hello.request";
    public const string AlertPlay = "alert.play";
    public const string AlertTest = "alert.test";
    public const string SpeakersGet = "speakers.get";
    public const string SpeakersSet = "speakers.set";
    public const string UpdateCheck = "update.check";
    public const string UpdateInstall = "update.install";

    private static readonly HashSet<string> Known =
    [
        HelloRequest, AlertPlay, AlertTest, SpeakersGet, SpeakersSet, UpdateCheck, UpdateInstall,
    ];

    /// <summary>ไม่ใช่ข้อความของช่องนี้ / รูปทรงผิด = null (ปล่อยให้ handler อื่นดูต่อ)</summary>
    public static DeviceRequest? Parse(string? json)
    {
        if (string.IsNullOrEmpty(json) || json.Length > 4096) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (Str(root, "channel") != Channel) return null;
            var type = Str(root, "type");
            if (type is null || !Known.Contains(type)) return null;

            if (type == AlertPlay)
            {
                var sound = Str(root, "sound");
                return AlertSoundIds.IsKnown(sound) ? new DeviceRequest(type, Sound: sound) : null;
            }

            if (type == SpeakersSet)
            {
                var volume = root.TryGetProperty("alertVolume", out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n)
                    ? Math.Clamp(n, 0, 100)
                    : 100;
                return new DeviceRequest(
                    type,
                    HasSpeakers: true,
                    AlertDeviceId: LauncherSettings.NormalizeDeviceId(Str(root, "alertDeviceId")),
                    AlertVolume: volume,
                    MusicDeviceId: LauncherSettings.NormalizeDeviceId(Str(root, "musicDeviceId")));
            }

            return new DeviceRequest(type);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static string Hello(string version, IEnumerable<string> capabilities) => Serialize(new
    {
        channel = Channel,
        type = "hello",
        version,
        capabilities = capabilities.ToArray(),
    });

    public static string Speakers(
        IReadOnlyList<AudioOutputDevice> devices,
        LauncherSettings settings,
        bool musicRoutingSupported) => Serialize(new
    {
        channel = Channel,
        type = "speakers",
        devices = devices.Select(d => new { id = d.Id, name = d.Name, isDefault = d.IsDefault }).ToArray(),
        alertDeviceId = settings.AlertOutputDeviceId,
        alertVolume = settings.AlertVolume,
        musicDeviceId = settings.MusicOutputDeviceId,
        musicRoutingSupported,
    });

    /// <summary>state: idle | checking | downloading | ready | installing | failed | up_to_date</summary>
    public static string UpdateStatus(string state, string currentVersion, string? version, string? error) => Serialize(new
    {
        channel = Channel,
        type = "update.status",
        state,
        currentVersion,
        version,
        error,
    });

    private static string Serialize(object value) => JsonSerializer.Serialize(value);

    private static string? Str(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
