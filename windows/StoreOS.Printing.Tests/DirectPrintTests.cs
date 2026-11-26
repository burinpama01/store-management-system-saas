using Xunit;
using System.Net;
using System.Net.Sockets;
using System.Text;
using StoreOS.Printing;

namespace StoreOS.Printing.Tests;

public class PrinterHostPolicyTests
{
    [Theory]
    [InlineData("192.168.1.20", true)]
    [InlineData("10.0.0.5", true)]
    [InlineData("172.16.3.4", true)]
    [InlineData("172.31.255.1", true)]
    [InlineData("172.32.0.1", false)]
    [InlineData("127.0.0.1", false)]
    [InlineData("169.254.1.1", false)]
    [InlineData("8.8.8.8", false)]
    [InlineData("192.168.1.256", false)]
    [InlineData("printer.local", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void OnlyPrivateLanIpv4(string? host, bool allowed) => Assert.Equal(allowed, PrinterHostPolicy.IsAllowedHost(host));

    [Theory]
    [InlineData(9100, true)]
    [InlineData(9109, true)]
    [InlineData(445, false)]
    [InlineData(3389, false)]
    [InlineData(22, false)]
    [InlineData(80, false)]
    public void OnlyRawPrintingPorts(int port, bool allowed) => Assert.Equal(allowed, PrinterHostPolicy.IsAllowedPort(port));
}

public class PosBridgeProtocolTests
{
    private static string Job(string host = "192.168.1.20", string? jobId = "job-1", string base64 = "G0A=", string kind = "receipt") =>
        $$"""{"channel":"storeos.pos","type":"print.job","jobId":"{{jobId}}","printerId":"p1","host":"{{host}}","port":9100,"bytesBase64":"{{base64}}","kind":"{{kind}}","label":"#0042"}""";

    [Fact]
    public void ParsesPrintJob()
    {
        var req = PosBridgeProtocol.Parse(Job());
        Assert.NotNull(req);
        Assert.Equal(PosBridgeProtocol.PrintJob, req!.Type);
        Assert.Equal("192.168.1.20", req.Job!.Host);
        Assert.Equal(new byte[] { 0x1b, 0x40 }, req.Job.Bytes);
        Assert.Equal("receipt", req.Job.Kind);
    }

    [Fact]
    public void RejectsOtherChannelBadIdAndBadBase64()
    {
        Assert.Null(PosBridgeProtocol.Parse("""{"channel":"storeos.device","type":"print.job"}"""));
        Assert.Null(PosBridgeProtocol.Parse(Job(jobId: "bad id with spaces")));
        Assert.Null(PosBridgeProtocol.Parse(Job(jobId: "job:with:colon")));
        Assert.Null(PosBridgeProtocol.Parse(Job(base64: "!!!not-base64")));
        Assert.Null(PosBridgeProtocol.Parse("not json"));
        Assert.Null(PosBridgeProtocol.Parse(new string('x', 500_000)));
    }

    [Fact]
    public void UnknownKindBecomesOther() => Assert.Equal("other", PosBridgeProtocol.Parse(Job(kind: "evil"))!.Job!.Kind);

    [Fact]
    public void HelloAdvertisesDirectPrint()
    {
        var hello = PosBridgeProtocol.Hello("1.0.0");
        Assert.Contains("\"channel\":\"storeos.pos\"", hello);
        Assert.Contains("print.direct", hello);
    }
}

/// <summary>เซิร์ฟเวอร์ TCP ปลอมบน loopback ทำตัวเป็นเครื่องพิมพ์ — เก็บไบต์ที่ได้รับ</summary>
internal sealed class FakePrinter : IAsyncDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _cts = new();
    public List<byte[]> Received { get; } = [];
    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;
    public int Connections;

    public FakePrinter(int dropAfterBytes = -1)
    {
        _listener.Start();
        _ = Task.Run(async () =>
        {
            while (!_cts.IsCancellationRequested)
            {
                TcpClient client;
                try { client = await _listener.AcceptTcpClientAsync(_cts.Token); }
                catch { return; }
                Interlocked.Increment(ref Connections);
                _ = Task.Run(async () =>
                {
                    using var c = client;
                    using var ms = new MemoryStream();
                    var buf = new byte[4096];
                    try
                    {
                        var stream = c.GetStream();
                        int n;
                        while ((n = await stream.ReadAsync(buf, _cts.Token)) > 0)
                        {
                            ms.Write(buf, 0, n);
                            if (dropAfterBytes >= 0 && ms.Length >= dropAfterBytes)
                            {
                                c.Client.LingerState = new LingerOption(true, 0); // RST
                                break;
                            }
                        }
                    }
                    catch { }
                    lock (Received) Received.Add(ms.ToArray());
                });
            }
        });
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        _listener.Stop();
        await Task.Delay(50);
    }
}

public class DirectPrintQueueTests
{
    private static readonly TcpTransportOptions Fast = new() { ChunkDelayMs = 0, LingerAfterSend = TimeSpan.FromSeconds(1), ConnectTimeout = TimeSpan.FromSeconds(1) };
    private static DirectPrintQueueOptions TestOptions() => new() { AllowLoopbackForTests = true, RetryDelays = [TimeSpan.FromMilliseconds(10), TimeSpan.FromMilliseconds(10)] };

    [Fact]
    public async Task PrintsAllBytesToPrinter()
    {
        await using var printer = new FakePrinter();
        var queue = new DirectPrintQueue(new TcpPrintTransport(Fast), TestOptions());
        var payload = Enumerable.Range(0, 95_000).Select(i => (byte)(i % 251)).ToArray();

        var result = await queue.PrintAsync(new DirectPrintJob("j1", "p1", "127.0.0.1", printer.Port, payload, "receipt", "#1"));

        Assert.Equal("printed", result.Outcome);
        Assert.Equal(1, result.Attempts);
        await Task.Delay(100);
        Assert.Single(printer.Received);
        Assert.Equal(payload, printer.Received[0]);
        Assert.Single(queue.History());
    }

    [Fact]
    public async Task RetriesWhenNothingWasSentThenFails()
    {
        // พอร์ตที่ไม่มีใครฟัง = เชื่อมต่อไม่ได้ ยังไม่ได้ส่งอะไร → ลองครบ 3 ครั้งแล้วบอก failed (กดพิมพ์ซ้ำได้)
        var port = FreePort();
        var queue = new DirectPrintQueue(new TcpPrintTransport(Fast), TestOptions());
        var result = await queue.PrintAsync(new DirectPrintJob("j2", null, "127.0.0.1", port, [1, 2, 3], "receipt", null));
        Assert.Equal("failed", result.Outcome);
        Assert.Equal(3, result.Attempts);
        Assert.NotNull(result.Error);
    }

    [Fact]
    public async Task DoesNotRetryAfterPartialSend()
    {
        // เครื่องพิมพ์ตัดสายกลางทาง → อาจออกกระดาษแล้ว ห้ามลองใหม่ (กันใบซ้ำ)
        await using var printer = new FakePrinter(dropAfterBytes: 4096);
        var queue = new DirectPrintQueue(new TcpPrintTransport(new TcpTransportOptions { ChunkBytes = 1024, ChunkDelayMs = 5, LingerAfterSend = TimeSpan.FromSeconds(1) }), TestOptions());
        var result = await queue.PrintAsync(new DirectPrintJob("j3", null, "127.0.0.1", printer.Port, new byte[200_000], "receipt", null));
        // ส่งไปแล้วบางส่วน → ไม่ใช่ "failed" (ซึ่งแปลว่ากดซ้ำได้ปลอดภัย) และต้องไม่ต่อใหม่อีกรอบ
        Assert.NotEqual("failed", result.Outcome);
        Assert.Equal(1, result.Attempts);
        Assert.Equal(1, printer.Connections);
    }

    [Fact]
    public async Task RejectsPublicIpWithoutConnecting()
    {
        var transport = new CountingTransport();
        var queue = new DirectPrintQueue(transport);
        var result = await queue.PrintAsync(new DirectPrintJob("j4", null, "8.8.8.8", 9100, [1], "receipt", null));
        Assert.Equal("failed", result.Outcome);
        Assert.Equal(0, transport.Calls);
    }

    [Fact]
    public async Task SamePrinterJobsRunOneAtATime()
    {
        var transport = new CountingTransport(delayMs: 80);
        var queue = new DirectPrintQueue(transport, TestOptions());
        var jobs = Enumerable.Range(0, 3).Select(i => queue.PrintAsync(new DirectPrintJob($"s{i}", null, "192.168.1.20", 9100, [1], "receipt", null)));
        await Task.WhenAll(jobs);
        Assert.Equal(1, transport.MaxConcurrent);
        Assert.Equal(3, transport.Calls);
    }

    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var p = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return p;
    }

    private sealed class CountingTransport(int delayMs = 0) : IPrintTransport
    {
        private int _current;
        public int Calls;
        public int MaxConcurrent;

        public async Task<TransportResult> SendAsync(string host, int port, ReadOnlyMemory<byte> data, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Calls);
            var now = Interlocked.Increment(ref _current);
            MaxConcurrent = Math.Max(MaxConcurrent, now);
            await Task.Delay(delayMs, cancellationToken);
            Interlocked.Decrement(ref _current);
            return new TransportResult(true, data.Length, null, TimeSpan.FromMilliseconds(delayMs));
        }
    }
}
