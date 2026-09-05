namespace StoreOS.Launcher.Services;

/// <summary>
/// ISSUE-002 — ตัดสินว่า popup ที่เว็บขอเปิด "ใช่จอลูกค้าของเราไหม"
///
/// Launcher จะ claim หน้าต่างลูกไว้เป็นของตัวเอง (ตั้ง Owner แล้วปิดตามตอนปิด Launcher)
/// เฉพาะ URL ที่ผ่านที่นี่เท่านั้น ที่เหลือปล่อยให้ WebView2 จัดการตามพฤติกรรมเดิม
/// — ถ้าเรารับมั่ว จะกลายเป็นไปปิดหน้าต่างของเว็บอื่นที่พนักงานเปิดค้างไว้
///
/// กติกา fail closed: https + host เดียวกับที่ Launcher เปิดอยู่ + path ตรงตัวเท่านั้น
/// (ไม่ใช้ StartsWith เพราะ "/pos/display-admin" จะเล็ดลอดเข้ามาได้)
/// </summary>
public static class CustomerDisplayNavigation
{
    /// <summary>path เดียวที่เป็นจอลูกค้า (ตรงกับ src/app/pos/display/page.tsx)</summary>
    public const string DisplayPath = "/pos/display";

    public static bool TryResolve(Uri? baseUri, string? requestedUrl, out Uri? resolved)
    {
        resolved = null;
        if (baseUri is null) return false;
        if (string.IsNullOrWhiteSpace(requestedUrl)) return false;

        if (!Uri.TryCreate(requestedUrl, UriKind.Absolute, out var requested)) return false;

        // Uri จะ normalize "/pos/display/../admin" ให้เป็น "/admin" ตั้งแต่ตอน parse
        // การเทียบ AbsolutePath แบบตรงตัวจึงกันการไต่ path ออกไปได้ในตัว
        var ok = requested.Scheme == Uri.UriSchemeHttps
            && requested.Host.Equals(baseUri.Host, StringComparison.OrdinalIgnoreCase)
            && requested.Port == baseUri.Port
            && requested.AbsolutePath.Equals(DisplayPath, StringComparison.OrdinalIgnoreCase);

        if (!ok) return false;
        resolved = requested;
        return true;
    }
}
