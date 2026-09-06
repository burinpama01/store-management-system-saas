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
