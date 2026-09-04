using System.IO;
using System.Text.Json;

namespace StoreOS.Launcher;

/// <summary>
/// ค่าตั้งของ Launcher ต่อเครื่อง (ไม่มีความลับ — token ของ Hub อยู่ที่ config ของ agent เท่านั้น)
/// อ่านจาก %LOCALAPPDATA%\StoreOSLauncher\launcher.json ถ้าไม่มีก็ใช้ค่าเริ่มต้น
/// </summary>
public sealed class LauncherSettings
{
    public string PosUrl { get; init; } = "https://store-os-manage.vercel.app/pos/unified";
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
