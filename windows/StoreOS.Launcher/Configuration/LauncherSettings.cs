using System.IO;
using System.Text.Json;

namespace StoreOS.Launcher;

/// <summary>
/// ค่าตั้งของ Launcher ต่อเครื่อง (ไม่มีความลับ — token ของ Hub อยู่ที่ config ของ agent เท่านั้น)
/// อ่านจาก %LOCALAPPDATA%\StoreOSLauncher\launcher.json ถ้าไม่มีก็ใช้ค่าเริ่มต้น
/// </summary>
public sealed class LauncherSettings
{
    /// <summary>
    /// ISSUE-001 — ต้องเป็น "/pos" เท่านั้น
    /// /pos/unified ไม่ใช่ route (src/app/pos/unified มีแต่ component ไม่มี page.tsx)
    /// Launcher จึงเปิดมาเจอ 404 บนเครื่องร้าน; หน้าจริงคือ /pos ซึ่ง compose
    /// UnifiedPosWorkspace อยู่ข้างในอีกที และใช้โดเมนหลักของร้านแทน *.vercel.app
    /// </summary>
    public string PosUrl { get; init; } = "https://www.store-os.online/pos";
    public bool AllowDevTools { get; init; }

    /// <summary>
    /// ช่องทางของเครื่องนี้ — แยก mutex กันเปิดซ้ำ และแยกโฟลเดอร์ข้อมูลของ WebView2
    /// "prod" คือเครื่องขายจริง, "dev" ใช้ตอนทดสอบ (ยอมให้ชี้ localhost ได้)
    /// </summary>
    public string Channel { get; init; } = "prod";

    /// <summary>
    /// เปิดโหมดฟังคำปลุกบนเครื่องนี้หรือไม่ (แผน v1 W1)
    /// ค่าเริ่มต้นคือปิด — เปิดทีละเครื่องระหว่าง pilot เท่านั้น ไม่เปิดพร้อมกันทั้งฝูง
    /// </summary>
    public bool VoiceStandbyEnabled { get; init; }

    /// <summary>
    /// ลำโพงของเสียงแจ้งเตือน POS (MMDevice id ของ Windows) — null = ลำโพงหลักของ Windows
    /// Launcher เล่นเสียงแจ้งเตือนเอง (AlertPlayer) จึงแยกจากเพลงที่เล่นใน WebView2 ได้
    /// </summary>
    public string? AlertOutputDeviceId { get; init; }

    /// <summary>ความดังเสียงแจ้งเตือน 0–100 (คูณกับความดังของลำโพงใน Windows อีกชั้น)</summary>
    public int AlertVolume { get; init; } = 100;

    /// <summary>
    /// ลำโพงของเสียงจากหน้าเว็บ (เพลงจาก /player) — null = ลำโพงหลักของ Windows (ค่าเริ่มต้น ไม่แตะอะไร)
    /// ตั้งผ่านนโยบายเสียงต่อ process ของ Windows ให้ process ของ WebView2 (ดู ProcessAudioRouter)
    /// </summary>
    public string? MusicOutputDeviceId { get; init; }

    /// <summary>โฮสต์ที่ยอมให้ Launcher เปิดได้ — กัน config ที่ถูกแก้ให้ชี้ไปเว็บอื่น</summary>
    private static readonly string[] AllowedHosts =
    [
        "www.store-os.online",
        "store-os.online",
    ];

    /// <summary>
    /// ตรวจว่า URL ที่ตั้งมาเปิดได้ไหม
    ///
    /// เหตุผลที่ต้องมีด่านนี้: launcher.json อยู่ใน %LOCALAPPDATA% ที่โปรแกรมอื่นบนเครื่อง
    /// เขียนได้ ถ้าไม่ตรวจ ใครก็ตั้งให้ Launcher เปิดหน้าเลียนแบบ StoreOS แล้วรอผู้ใช้
    /// พิมพ์รหัสผ่านได้ — Launcher เปิดแบบเต็มจอไม่มีแถบที่อยู่ ผู้ใช้จึงไม่มีทางเห็นว่าโดนเปลี่ยน
    /// </summary>
    public static bool IsAllowedPosUrl(string? url, string? channel)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        if (!string.IsNullOrEmpty(uri.UserInfo)) return false; // https://user@host = เทคนิคหลอกตา

        var isLoopback = uri.IsLoopback;
        if (uri.Scheme != Uri.UriSchemeHttps && !(isLoopback && uri.Scheme == Uri.UriSchemeHttp)) return false;

        // localhost เปิดได้เฉพาะ channel ทดสอบ ไม่ใช่บนเครื่องขายจริง
        if (isLoopback) return string.Equals(channel, "dev", StringComparison.OrdinalIgnoreCase);

        return AllowedHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>
    /// URL ที่จะเปิดจริง — ถ้าค่าที่ตั้งมาไม่ผ่านด่าน ให้กลับไปใช้ค่าเริ่มต้น
    /// (ไม่ใช่ปฏิเสธจนเปิดโปรแกรมไม่ได้ เพราะร้านต้องขายของต่อ)
    /// </summary>
    public string ResolvePosUrl(out bool rejected)
    {
        if (IsAllowedPosUrl(PosUrl, Channel))
        {
            rejected = false;
            return PosUrl;
        }

        rejected = true;
        return new LauncherSettings().PosUrl;
    }

    /// <summary>สำเนาของค่าตั้งเดิมที่เปลี่ยนเฉพาะสวิตช์คำปลุก (คลาสนี้เป็น init-only ทั้งหมด)</summary>
    public LauncherSettings WithVoiceStandby(bool enabled) => Copy(voiceStandbyEnabled: enabled);

    /// <summary>สำเนาที่เปลี่ยนเฉพาะค่าลำโพง — ค่าอื่นต้องคงเดิม (ไม่งั้นบันทึกลำโพงแล้วคำปลุกดับ)</summary>
    public LauncherSettings WithSpeakers(string? alertDeviceId, int alertVolume, string? musicDeviceId) => Copy(
        alertDeviceId: Optional.Of(NormalizeDeviceId(alertDeviceId)),
        alertVolume: Math.Clamp(alertVolume, 0, 100),
        musicDeviceId: Optional.Of(NormalizeDeviceId(musicDeviceId)));

    /// <summary>ค่าว่าง/ช่องว่าง = ลำโพงหลักของ Windows; id ยาวผิดปกติถูกตัดทิ้ง (ไฟล์นี้โปรแกรมอื่นเขียนได้)</summary>
    public static string? NormalizeDeviceId(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return null;
        var trimmed = id.Trim();
        return trimmed.Length > 512 ? null : trimmed;
    }

    private LauncherSettings Copy(
        bool? voiceStandbyEnabled = null,
        Optional<string?> alertDeviceId = default,
        int? alertVolume = null,
        Optional<string?> musicDeviceId = default) => new()
    {
        PosUrl = PosUrl,
        AllowDevTools = AllowDevTools,
        Channel = Channel,
        VoiceStandbyEnabled = voiceStandbyEnabled ?? VoiceStandbyEnabled,
        AlertOutputDeviceId = alertDeviceId.HasValue ? alertDeviceId.Value : AlertOutputDeviceId,
        AlertVolume = alertVolume ?? AlertVolume,
        MusicOutputDeviceId = musicDeviceId.HasValue ? musicDeviceId.Value : MusicOutputDeviceId,
    };

    /// <summary>แยก "ไม่ได้ส่งมา" ออกจาก "ส่ง null มา" (null = กลับไปใช้ลำโพงหลัก)</summary>
    private readonly struct Optional<T>
    {
        public bool HasValue { get; }
        public T Value { get; }
        private Optional(T value)
        {
            HasValue = true;
            Value = value;
        }
        public static Optional<T> Of(T value) => new(value);
    }

    private static class Optional
    {
        public static Optional<T> Of<T>(T value) => Optional<T>.Of(value);
    }

    /// <summary>เส้นทางไฟล์ตั้งค่าของเครื่องนี้</summary>
    public static string FilePath(string localAppData) =>
        Path.Combine(localAppData, "StoreOSLauncher", "launcher.json");

    /// <summary>
    /// บันทึกแบบ atomic — เขียนไฟล์ชั่วคราวก่อนแล้วค่อยสลับ
    ///
    /// ถ้าเขียนทับตรง ๆ แล้วไฟดับกลางทาง ไฟล์จะเหลือครึ่งเดียวและ Launcher จะอ่านไม่ออก
    /// รอบหน้า = ผู้ใช้เสียค่าตั้งทั้งหมดโดยไม่รู้ตัว (Load จะ fallback ไปค่าเริ่มต้นเงียบ ๆ)
    /// </summary>
    public void Save(string localAppData)
    {
        var path = FilePath(localAppData);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });

        var temp = path + ".tmp";
        File.WriteAllText(temp, json);
        if (File.Exists(path)) File.Replace(temp, path, null);
        else File.Move(temp, path);
    }

    public static LauncherSettings Load()
    {
        try
        {
            var path = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "StoreOSLauncher",
                "launcher.json");
            if (!File.Exists(path)) return new LauncherSettings();
            return JsonSerializer.Deserialize<LauncherSettings>(File.ReadAllText(path)) ?? new LauncherSettings();
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            // ไฟล์ตั้งค่าเสีย = ใช้ค่าเริ่มต้น ไม่ใช่เปิดไม่ขึ้น
            return new LauncherSettings();
        }
    }
}
