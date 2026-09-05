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
