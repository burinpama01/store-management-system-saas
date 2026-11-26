using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace StoreOS.Printing;

public sealed record PrinterProbeResult(string Host, int Port, bool Reachable, long? LatencyMs, string? Error);

/// <summary>ตรวจว่าเครื่องพิมพ์ตอบไหม (เปิด TCP แล้วปิดทันที ไม่ส่งข้อมูล = ไม่ออกกระดาษ) + ค้นหาในวง LAN</summary>
public static class PrinterDiscovery
{
    public static async Task<PrinterProbeResult> ProbeAsync(string host, int port, TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        if (!PrinterHostPolicy.IsAllowedHost(host) || !PrinterHostPolicy.IsAllowedPort(port))
        {
            return new PrinterProbeResult(host, port, false, null, "IP/พอร์ตไม่อยู่ในวง LAN ของร้าน");
        }
        return await ProbeUncheckedAsync(host, port, timeout, cancellationToken).ConfigureAwait(false);
    }

    internal static async Task<PrinterProbeResult> ProbeUncheckedAsync(string host, int port, TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var client = new TcpClient();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(timeout);
        var watch = Stopwatch.StartNew();
        try
        {
            await client.ConnectAsync(host, port, cts.Token).ConfigureAwait(false);
            return new PrinterProbeResult(host, port, true, watch.ElapsedMilliseconds, null);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new PrinterProbeResult(host, port, false, null, "ไม่ตอบ");
        }
        catch (SocketException ex)
        {
            return new PrinterProbeResult(host, port, false, null, ex.SocketErrorCode.ToString());
        }
    }

    /// <summary>วง /24 ของการ์ดเครือข่ายที่ต่ออยู่ (เฉพาะวง LAN ส่วนตัว) เช่น 192.168.1</summary>
    public static IReadOnlyList<string> LocalSubnetPrefixes()
    {
        var prefixes = new List<string>();
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            foreach (var address in nic.GetIPProperties().UnicastAddresses)
            {
                if (address.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                var ip = address.Address.ToString();
                if (!PrinterHostPolicy.IsAllowedHost(ip)) continue;
                var prefix = ip[..ip.LastIndexOf('.')];
                if (!prefixes.Contains(prefix)) prefixes.Add(prefix);
            }
        }
        return prefixes;
    }

    /// <summary>สแกนพอร์ต 9100 ทั้งวง (1–254) แบบขนาน — ใช้เวลาราว 1–2 วิ ไม่ส่งข้อมูลใด ๆ</summary>
    public static async Task<IReadOnlyList<PrinterProbeResult>> ScanAsync(
        IReadOnlyList<string> prefixes,
        int port = PrinterHostPolicy.DefaultPort,
        TimeSpan? timeout = null,
        int concurrency = 64,
        CancellationToken cancellationToken = default)
    {
        var perHost = timeout ?? TimeSpan.FromMilliseconds(400);
        var throttle = new SemaphoreSlim(concurrency);
        var tasks = new List<Task<PrinterProbeResult>>();
        foreach (var prefix in prefixes.Take(4))
        {
            for (var last = 1; last <= 254; last++)
            {
                var host = $"{prefix}.{last}";
                if (!PrinterHostPolicy.IsAllowedHost(host)) continue;
                tasks.Add(Task.Run(async () =>
                {
                    await throttle.WaitAsync(cancellationToken).ConfigureAwait(false);
                    try { return await ProbeUncheckedAsync(host, port, perHost, cancellationToken).ConfigureAwait(false); }
                    finally { throttle.Release(); }
                }, cancellationToken));
            }
        }
        var results = await Task.WhenAll(tasks).ConfigureAwait(false);
        return results.Where(r => r.Reachable).OrderBy(r => IPAddress.Parse(r.Host).GetAddressBytes()[3]).ToList();
    }
}
