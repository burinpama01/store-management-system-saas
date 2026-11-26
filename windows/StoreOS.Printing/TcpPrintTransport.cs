using System.Net.Sockets;

namespace StoreOS.Printing;

/// <summary>ผลการส่งหนึ่งครั้ง — BytesSent บอกว่าเริ่มส่งข้อมูลไปแล้วหรือยัง (ใช้ตัดสินว่าลองใหม่ได้ปลอดภัยไหม)</summary>
public sealed record TransportResult(bool Ok, long BytesSent, string? Error, TimeSpan Elapsed);

public interface IPrintTransport
{
    Task<TransportResult> SendAsync(string host, int port, ReadOnlyMemory<byte> data, CancellationToken cancellationToken);
}

public sealed class TcpTransportOptions
{
    /// <summary>
    /// ห้ามขยายเกิน 2KB: เครื่องพิมพ์ร้าน (BARIGAN PR-01W) บัฟเฟอร์ล้นแล้วพ่นขยะทั้งม้วนเมื่อส่งก้อนใหญ่
    /// (ทดลองแล้ว 16KB พัง) — วัดจริง 26 พ.ย. 2026: 2KB/หน่วง 10ms กับไม่หน่วงใช้เวลาเท่ากัน ~1.5 วิ/91KB
    /// </summary>
    public int ChunkBytes { get; init; } = 2048;
    public int ChunkDelayMs { get; init; } = 10;
    public TimeSpan ConnectTimeout { get; init; } = TimeSpan.FromSeconds(5);
    public TimeSpan SendTimeout { get; init; } = TimeSpan.FromSeconds(30);
    /// <summary>หลังส่งครบ รอให้เครื่องพิมพ์รับข้อมูลที่ค้างใน socket ก่อนปิด (ปิดเร็วเกินไปบางรุ่นตัดท้ายใบ)</summary>
    public TimeSpan LingerAfterSend { get; init; } = TimeSpan.FromSeconds(5);
}

/// <summary>ส่งไบต์ ESC/POS ตรงเข้าเครื่องพิมพ์ด้วย TCP (raw 9100) — แบบเดียวกับ sendToSocket ของ Print Hub</summary>
public sealed class TcpPrintTransport(TcpTransportOptions? options = null) : IPrintTransport
{
    private readonly TcpTransportOptions _options = options ?? new TcpTransportOptions();

    public async Task<TransportResult> SendAsync(string host, int port, ReadOnlyMemory<byte> data, CancellationToken cancellationToken)
    {
        var started = DateTime.UtcNow;
        long sent = 0;
        using var client = new TcpClient { NoDelay = true };
        try
        {
            using (var connectCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
            {
                connectCts.CancelAfter(_options.ConnectTimeout);
                try
                {
                    await client.ConnectAsync(host, port, connectCts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    return new TransportResult(false, 0, $"เชื่อมต่อเครื่องพิมพ์ไม่ได้ใน {_options.ConnectTimeout.TotalSeconds:0} วิ", DateTime.UtcNow - started);
                }
            }

            using var sendCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            sendCts.CancelAfter(_options.SendTimeout);
            var stream = client.GetStream();
            try
            {
                for (var offset = 0; offset < data.Length; offset += _options.ChunkBytes)
                {
                    var length = Math.Min(_options.ChunkBytes, data.Length - offset);
                    await stream.WriteAsync(data.Slice(offset, length), sendCts.Token).ConfigureAwait(false);
                    sent += length;
                    if (_options.ChunkDelayMs > 0 && offset + length < data.Length)
                    {
                        await Task.Delay(_options.ChunkDelayMs, sendCts.Token).ConfigureAwait(false);
                    }
                }
                await stream.FlushAsync(sendCts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return new TransportResult(false, sent, $"ส่งข้อมูลไม่จบใน {_options.SendTimeout.TotalSeconds:0} วิ", DateTime.UtcNow - started);
            }

            // ปิดฝั่งส่งแล้วรอให้อีกฝั่งปิดตาม = ข้อมูลถึงเครื่องพิมพ์ครบ (ไม่ใช่แค่อยู่ในบัฟเฟอร์ของ Windows)
            client.Client.Shutdown(SocketShutdown.Send);
            await WaitForPeerCloseAsync(client.Client, _options.LingerAfterSend, cancellationToken).ConfigureAwait(false);
            return new TransportResult(true, sent, null, DateTime.UtcNow - started);
        }
        catch (SocketException ex)
        {
            return new TransportResult(false, sent, DescribeSocketError(ex), DateTime.UtcNow - started);
        }
        catch (IOException ex) when (ex.InnerException is SocketException socketEx)
        {
            return new TransportResult(false, sent, DescribeSocketError(socketEx), DateTime.UtcNow - started);
        }
    }

    private static async Task WaitForPeerCloseAsync(Socket socket, TimeSpan timeout, CancellationToken cancellationToken)
    {
        // เครื่องพิมพ์บางรุ่นไม่ปิด socket เอง — รอได้ไม่เกิน timeout แล้วถือว่าส่งครบ (ข้อมูล flush แล้ว)
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(timeout);
        var buffer = new byte[256];
        try
        {
            while (true)
            {
                var read = await socket.ReceiveAsync(buffer, SocketFlags.None, cts.Token).ConfigureAwait(false);
                if (read == 0) return; // อีกฝั่งปิดแล้ว
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (SocketException)
        {
            // ถูกตัด (RST) หลังส่งครบ — ข้อมูลถึงแล้ว ถือว่าสำเร็จ
        }
    }

    private static string DescribeSocketError(SocketException ex) => ex.SocketErrorCode switch
    {
        SocketError.ConnectionRefused => "เครื่องพิมพ์ปฏิเสธการเชื่อมต่อ (พอร์ตผิด หรือมีเครื่องอื่นกำลังพิมพ์)",
        SocketError.HostUnreachable or SocketError.NetworkUnreachable => "หาเครื่องพิมพ์ในวง WiFi ไม่เจอ (IP ผิด หรือเครื่องพิมพ์ปิดอยู่)",
        SocketError.TimedOut => "เครื่องพิมพ์ไม่ตอบ (สัญญาณ WiFi อ่อน หรือเครื่องพิมพ์ปิดอยู่)",
        SocketError.ConnectionReset => "การเชื่อมต่อถูกตัดกลางทาง (ECONNRESET)",
        _ => $"ส่งเข้าเครื่องพิมพ์ไม่สำเร็จ ({ex.SocketErrorCode})",
    };
}
