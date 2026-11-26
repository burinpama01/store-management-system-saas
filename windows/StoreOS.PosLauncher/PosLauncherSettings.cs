using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace StoreOS.PosLauncher;

/// <summary>
/// ค่าตั้งต่อเครื่อง: %LOCALAPPDATA%\StoreOS\PosLauncher\settings.json (ไม่มีก็ใช้ค่าเริ่มต้น)
/// ไฟล์นี้โปรแกรมอื่นบนเครื่องเขียนได้ จึงตรวจ BaseUrl ด้วย PosNavigationPolicy ทุกครั้ง
/// (กันถูกแก้ให้เปิดหน้าเลียนแบบ StoreOS แล้วรอผู้ใช้พิมพ์รหัสผ่าน)
/// </summary>
public sealed class PosLauncherSettings
{
    public string BaseUrl { get; init; } = PosNavigationPolicy.DefaultBaseUrl;
    public string Channel { get; init; } = "prod";
    public bool AllowDevTools { get; init; }

    public static string DataRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StoreOS", "PosLauncher");

    public string SafeChannel
    {
        get
        {
            var safe = Regex.Replace(Channel ?? "", "[^A-Za-z0-9_-]", "");
            return safe.Length == 0 ? "prod" : safe.Length > 64 ? safe[..64] : safe;
        }
    }

    /// <summary>BaseUrl ที่ใช้จริง — ไม่ผ่านด่านก็กลับไปค่าเริ่มต้น (ร้านต้องขายต่อได้ ไม่ใช่เปิดไม่ขึ้น)</summary>
    public string ResolveBaseUrl()
    {
        if (Uri.TryCreate(BaseUrl, UriKind.Absolute, out var uri) && PosNavigationPolicy.IsAllowedHost(uri, Channel))
        {
            return uri.GetLeftPart(UriPartial.Authority);
        }
        return PosNavigationPolicy.DefaultBaseUrl;
    }

    public static PosLauncherSettings Load()
    {
        try
        {
            var path = Path.Combine(DataRoot, "settings.json");
            if (!File.Exists(path)) return new PosLauncherSettings();
            var text = File.ReadAllText(path).TrimStart('﻿'); // ไฟล์ที่ PowerShell 5.1 เขียนมักมี BOM
            return JsonSerializer.Deserialize<PosLauncherSettings>(text, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? new PosLauncherSettings();
        }
        catch
        {
            return new PosLauncherSettings();
        }
    }
}
