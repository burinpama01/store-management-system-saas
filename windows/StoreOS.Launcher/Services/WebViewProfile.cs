using System.IO;
using System.Text.RegularExpressions;

namespace StoreOS.Launcher.Services;

/// <summary>
/// ที่เก็บข้อมูลของ WebView2 ต่อ channel (แผน v1 W1)
///
/// ทำไมต้องกำหนดเอง: ค่าเริ่มต้นของ WebView2 คือโฟลเดอร์ข้าง ๆ ไฟล์ exe ซึ่งบนเครื่องร้าน
/// มักอยู่ใน Program Files ที่ผู้ใช้ทั่วไปเขียนไม่ได้ → WebView2 เปิดไม่ขึ้นและ POS ไม่เปิดเลย
/// ย้ายมาไว้ใต้ %LOCALAPPDATA% ของผู้ใช้จึงเปิดได้เสมอ และแยกตาม channel เพื่อให้
/// การทดสอบ (dev) ไม่ไปปน session/cookie ของเครื่องขายจริง
/// </summary>
public static class WebViewProfile
{
    /// <summary>โฟลเดอร์ user data ของ channel นั้น — ไม่สร้างไฟล์ ไม่แตะดิสก์</summary>
    public static string UserDataFolder(string localAppData, string? channel)
    {
        var safe = Regex.Replace(channel ?? "", "[^A-Za-z0-9_-]", "");
        if (safe.Length == 0) safe = "prod";
        if (safe.Length > 64) safe = safe[..64];
        return Path.Combine(localAppData, "StoreOSLauncher", "webview2", safe);
    }
}
