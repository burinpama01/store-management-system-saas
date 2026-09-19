using System.Globalization;
using System.IO;
using System.Text.Json;

namespace StoreOS.Launcher.Services.Update;

/// <summary>รุ่นล่าสุดที่เซิร์ฟเวอร์ประกาศ (GET /api/launcher/latest)</summary>
public sealed record UpdateManifest(string Version, string Url, string Sha256, long Size, string? Notes);

/// <summary>
/// กติกาความปลอดภัยของการอัปเดตตัวเอง — pure ทั้งหมดเพื่อทดสอบได้
///
/// โปรแกรมที่ดาวน์โหลดโค้ดมารันเองคือเป้าหมายชั้นดี จึงต้องผ่านทุกด่าน:
///   * manifest มาจาก origin เดียวกับ POS (https + โฮสต์ที่อนุญาตใน LauncherSettings)
///   * ไฟล์ต้องมาจาก GitHub Releases ของ repo เราเท่านั้น (allowlist แบบ prefix ตรงตัว)
///   * SHA-256 ต้องตรงกับที่ manifest ประกาศ ไม่ตรง = ทิ้ง
///   * เลขรุ่นต้องใหม่กว่าที่รันอยู่ (ไม่ยอมให้ถอยรุ่นผ่านช่องนี้)
/// </summary>
public static class LauncherUpdatePolicy
{
    public const string AllowedDownloadPrefix =
        "https://github.com/burinpama01/store-management-system-saas/releases/download/launcher-v";

    /// <summary>เพดานขนาดชุดอัปเดต — รุ่นปัจจุบัน ~115 MB (มีโมเดลเสียง) เผื่อไว้ แต่กันไฟล์ผิดปกติ</summary>
    public const long MaxPackageBytes = 400L * 1024 * 1024;

    public static string ManifestUrl(string posUrl, string channel)
    {
        var origin = new Uri(posUrl).GetLeftPart(UriPartial.Authority);
        return $"{origin}/api/launcher/latest?channel={Uri.EscapeDataString(channel)}";
    }

    public static UpdateManifest? ParseManifest(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;

            var version = GetString(root, "version");
            var url = GetString(root, "url");
            var sha = GetString(root, "sha256")?.ToLowerInvariant();
            var size = root.TryGetProperty("size", out var s) && s.ValueKind == JsonValueKind.Number && s.TryGetInt64(out var n) ? n : 0;
            var notes = GetString(root, "notes");

            if (version is null || ParseVersion(version) is null) return null;
            if (url is null || !IsAllowedDownloadUrl(url, version)) return null;
            if (sha is null || sha.Length != 64 || !sha.All(Uri.IsHexDigit)) return null;
            if (size <= 0 || size > MaxPackageBytes) return null;

            return new UpdateManifest(version, url, sha, size, notes is { Length: > 500 } ? notes[..500] : notes);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>ไฟล์ต้องอยู่ใต้ tag ของรุ่นนั้นพอดี — กัน manifest ที่ชี้ไปรุ่นอื่น/repo อื่น</summary>
    public static bool IsAllowedDownloadUrl(string url, string version)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        if (uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo)) return false;
        var expected = $"{AllowedDownloadPrefix}{version}/storeos-launcher-{version}.zip";
        return string.Equals(uri.GetLeftPart(UriPartial.Path), expected, StringComparison.Ordinal);
    }

    public static Version? ParseVersion(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var parts = text.Trim().Split('.');
        if (parts.Length != 3) return null;
        var numbers = new int[3];
        for (var i = 0; i < 3; i++)
        {
            if (!int.TryParse(parts[i], NumberStyles.None, CultureInfo.InvariantCulture, out numbers[i])) return null;
        }
        return new Version(numbers[0], numbers[1], numbers[2]);
    }

    public static bool IsNewer(string current, string candidate)
    {
        var a = ParseVersion(current);
        var b = ParseVersion(candidate);
        return a is not null && b is not null && b > a;
    }

    /// <summary>
    /// อัปเดตตัวเองได้เฉพาะตัวที่ติดตั้งไว้ที่มาตรฐาน (%LOCALAPPDATA%\StoreOS\Launcher)
    /// — ตัวที่รันจากโฟลเดอร์ build/ทดสอบต้องไม่ไปเขียนทับตัวเอง
    /// </summary>
    public static bool IsManagedInstall(string installDir, string localAppData)
    {
        var expected = Path.GetFullPath(Path.Combine(localAppData, "StoreOS", "Launcher"));
        var actual = Path.GetFullPath(installDir).TrimEnd(Path.DirectorySeparatorChar);
        return string.Equals(actual, expected.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);
    }

    private static string? GetString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
