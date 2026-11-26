using System.Net;
using System.Text.RegularExpressions;

namespace StoreOS.Printing;

/// <summary>
/// ปลายทางที่ยอมให้หน้าเว็บสั่งพิมพ์ได้ — ต้องตรงกับ isAllowedNetworkPrinterHost ใน scripts/print-hub.mjs
/// รับเฉพาะ IPv4 วง LAN ส่วนตัว (10/8, 172.16/12, 192.168/16) กันหน้าเว็บใช้โปรแกรมเป็นทางยิง
/// TCP ออกไปหาเครื่องอื่นบนอินเทอร์เน็ตหรือ loopback ของเครื่องเอง
/// </summary>
public static partial class PrinterHostPolicy
{
    public const int DefaultPort = 9100;
    public const int MaxJobBytes = 256 * 1024; // เท่ากับ MAX_PRINT_JOB_BYTES ของ Print Hub

    [GeneratedRegex(@"^(\d{1,3}\.){3}\d{1,3}$")]
    private static partial Regex Ipv4Shape();

    public static bool IsAllowedHost(string? host)
    {
        if (string.IsNullOrWhiteSpace(host) || !Ipv4Shape().IsMatch(host)) return false;
        var octets = host.Split('.');
        var bytes = new int[4];
        for (var i = 0; i < 4; i++)
        {
            if (!int.TryParse(octets[i], out bytes[i]) || bytes[i] < 0 || bytes[i] > 255) return false;
        }
        if (bytes[0] is 127 or 0 or 255) return false;
        if (bytes[0] == 169 && bytes[1] == 254) return false;
        return bytes[0] == 10
            || (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31)
            || (bytes[0] == 192 && bytes[1] == 168);
    }

    public static bool IsAllowedPort(int port) => port is >= 1 and <= 65535;

    /// <summary>ใช้เฉพาะเทสต์ (เซิร์ฟเวอร์ปลอมบน 127.0.0.1) — โปรแกรมจริงไม่เปิดทางนี้</summary>
    internal static bool IsLoopback(string? host) =>
        host is not null && IPAddress.TryParse(host, out var ip) && IPAddress.IsLoopback(ip);
}
