namespace StoreOS.PosLauncher;

public enum PosTab
{
    None,
    Pos,
    Catalog,
    Printers,
}

public enum NavigationDecision
{
    /// <summary>เปิดในโปรแกรม</summary>
    Allow,
    /// <summary>หน้าของ StoreOS ที่ไม่ใช่งาน POS (รายงาน/เงินเดือน/ตั้งค่าร้าน…) → เปิดในเบราว์เซอร์ของเครื่องแทน</summary>
    OpenExternal,
    /// <summary>เว็บอื่น / scheme แปลก → ไม่เปิดเลย</summary>
    Block,
}

/// <summary>
/// กฎว่าโปรแกรม StoreOS POS เปิดหน้าไหนได้ และรับข้อความ (สั่งพิมพ์) จากหน้าไหน
/// แผน POS Launcher Direct IP Printing v2 — ข้อ 3 ②
///
/// ไม่ผูก WPF/WebView2 เพื่อให้ทดสอบได้ใน StoreOS.Printing.Tests (ลิงก์ไฟล์ไปคอมไพล์)
/// </summary>
public static class PosNavigationPolicy
{
    public const string DefaultBaseUrl = "https://www.store-os.online";

    private static readonly string[] AllowedHosts = ["www.store-os.online", "store-os.online"];

    /// <summary>หน้าที่ใช้งานในโปรแกรม (prefix ของ path) — ต้องตรงกับแท็บ + หน้าที่ต้องผ่านเพื่อเข้าระบบ</summary>
    private static readonly string[] AppPaths = ["/pos", "/catalog", "/settings/receipt"];

    /// <summary>หน้าที่เกี่ยวกับการเข้าระบบ — เปิดได้ในโปรแกรม แต่ไม่รับคำสั่งพิมพ์จากหน้าเหล่านี้</summary>
    private static readonly string[] AuthPaths =
    [
        "/login", "/register", "/reset-password", "/update-password", "/auth", "/device-login",
        "/api/device-login", // ส่งฟอร์มแลกตั๋ว (POST) เป็นการนำทางระดับหน้า
        "/account-inactive", "/suspended", "/onboarding", "/app-entry",
    ];

    public static bool IsAllowedHost(Uri uri, string? channel)
    {
        if (!string.IsNullOrEmpty(uri.UserInfo)) return false; // https://user@host = เทคนิคหลอกตา
        if (uri.IsLoopback)
        {
            // localhost เปิดได้เฉพาะเครื่องทดสอบ (channel dev) — ไม่ใช่เครื่องขายจริง
            return string.Equals(channel, "dev", StringComparison.OrdinalIgnoreCase)
                && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);
        }
        return uri.Scheme == Uri.UriSchemeHttps && AllowedHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase);
    }

    public static NavigationDecision Decide(string? target, string? channel)
    {
        if (!Uri.TryCreate(target, UriKind.Absolute, out var uri)) return NavigationDecision.Block;
        if (uri.Scheme is "about" or "data" or "blob") return uri.AbsoluteUri == "about:blank" ? NavigationDecision.Allow : NavigationDecision.Block;
        if (!IsAllowedHost(uri, channel)) return NavigationDecision.Block;
        var path = uri.AbsolutePath;
        if (path == "/" || MatchesAny(path, AppPaths) || MatchesAny(path, AuthPaths)) return NavigationDecision.Allow;
        return NavigationDecision.OpenExternal;
    }

    /// <summary>
    /// รับข้อความช่อง storeos.pos (สั่งพิมพ์/สแกนวง LAN) เฉพาะจากหน้างานในโดเมน StoreOS เท่านั้น
    /// หน้าเข้าระบบ / เว็บอื่น / iframe ของบุคคลที่สาม ส่งมาก็ทิ้ง
    /// </summary>
    public static bool IsTrustedMessageSource(string? source, string? channel)
    {
        if (!Uri.TryCreate(source, UriKind.Absolute, out var uri)) return false;
        return IsAllowedHost(uri, channel) && MatchesAny(uri.AbsolutePath, AppPaths);
    }

    public static PosTab TabFor(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return PosTab.None;
        var path = uri.AbsolutePath;
        if (Matches(path, "/pos")) return PosTab.Pos;
        if (Matches(path, "/catalog")) return PosTab.Catalog;
        if (Matches(path, "/settings/receipt")) return PosTab.Printers;
        return PosTab.None;
    }

    public static string UrlFor(PosTab tab, string baseUrl) => baseUrl.TrimEnd('/') + tab switch
    {
        PosTab.Catalog => "/catalog",
        PosTab.Printers => "/settings/receipt",
        _ => "/pos",
    };

    private static bool MatchesAny(string path, IEnumerable<string> prefixes) => prefixes.Any(p => Matches(path, p));

    /// <summary>"/pos" ตรงกับ /pos, /pos/, /pos/grocery แต่ไม่ตรงกับ /posxyz</summary>
    private static bool Matches(string path, string prefix) =>
        path.Equals(prefix, StringComparison.OrdinalIgnoreCase)
        || path.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase);
}
