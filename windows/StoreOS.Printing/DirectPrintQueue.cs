using System.Collections.Concurrent;

namespace StoreOS.Printing;

public sealed record DirectPrintJob(
    string JobId,
    string? PrinterId,
    string Host,
    int Port,
    byte[] Bytes,
    string Kind,
    string? Label);

/// <summary>
/// outcome: printed | failed (ยังไม่ได้ส่งอะไรเลย — กดพิมพ์ซ้ำได้ปลอดภัย) |
/// unknown (ส่งไปแล้วบางส่วนแล้วหลุด — อาจออกกระดาษแล้ว ห้ามพิมพ์ซ้ำอัตโนมัติ)
/// ความหมายเดียวกับ classifyPrintOutcome ของ Print Hub
/// </summary>
public sealed record DirectPrintResult(
    string JobId,
    string Outcome,
    string? Error,
    int Attempts,
    long ElapsedMs,
    int Bytes);

public sealed record PrintHistoryEntry(
    DateTimeOffset At,
    string JobId,
    string Kind,
    string? Label,
    string Target,
    string Outcome,
    string? Error,
    int Attempts,
    long ElapsedMs,
    int Bytes);

public sealed class DirectPrintQueueOptions
{
    /// <summary>หน่วงก่อนลองใหม่ (ลองได้เฉพาะตอนยังไม่ได้ส่งข้อมูลเลย) — 3 ครั้งรวมครั้งแรก = 1 + 2 ครั้ง</summary>
    public IReadOnlyList<TimeSpan> RetryDelays { get; init; } = [TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5)];
    public int HistoryLimit { get; init; } = 50;
    /// <summary>เฉพาะเทสต์ที่ใช้เซิร์ฟเวอร์ปลอมบน loopback</summary>
    internal bool AllowLoopbackForTests { get; init; }
}

/// <summary>
/// คิวพิมพ์ในเครื่อง — พิมพ์ทีละงานต่อเครื่องพิมพ์ (เครื่องพิมพ์ใบเสร็จรับพร้อมกันไม่ไหว)
/// เครื่องพิมพ์ต่างเครื่องพิมพ์ขนานกันได้ (ใบเสร็จ + ตั๋วครัว)
/// </summary>
public sealed class DirectPrintQueue(IPrintTransport transport, DirectPrintQueueOptions? options = null)
{
    private readonly DirectPrintQueueOptions _options = options ?? new DirectPrintQueueOptions();
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);
    private readonly LinkedList<PrintHistoryEntry> _history = new();
    private readonly object _historyGate = new();

    public event Action<PrintHistoryEntry>? Completed;

    public IReadOnlyList<PrintHistoryEntry> History()
    {
        lock (_historyGate) return _history.ToList();
    }

    public async Task<DirectPrintResult> PrintAsync(DirectPrintJob job, CancellationToken cancellationToken = default)
    {
        var rejected = Validate(job);
        if (rejected is not null) return Record(job, new DirectPrintResult(job.JobId, "failed", rejected, 0, 0, job.Bytes.Length));

        var gate = _locks.GetOrAdd($"{job.Host}:{job.Port}", _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var started = DateTime.UtcNow;
            TransportResult last = new(false, 0, "ยังไม่ได้ส่ง", TimeSpan.Zero);
            var attempts = 0;
            for (var i = 0; i <= _options.RetryDelays.Count; i++)
            {
                attempts++;
                last = await transport.SendAsync(job.Host, job.Port, job.Bytes, cancellationToken).ConfigureAwait(false);
                if (last.Ok) break;
                // ส่งไปแล้วบางส่วน = อาจออกกระดาษครึ่งใบแล้ว ลองใหม่จะได้ใบซ้ำ → หยุดและบอกว่าไม่แน่ใจ
                if (last.BytesSent > 0) break;
                if (i < _options.RetryDelays.Count)
                {
                    await Task.Delay(_options.RetryDelays[i], cancellationToken).ConfigureAwait(false);
                }
            }
            var elapsed = (long)(DateTime.UtcNow - started).TotalMilliseconds;
            var outcome = last.Ok ? "printed" : last.BytesSent > 0 ? "unknown" : "failed";
            return Record(job, new DirectPrintResult(job.JobId, outcome, last.Ok ? null : last.Error, attempts, elapsed, job.Bytes.Length));
        }
        finally
        {
            gate.Release();
        }
    }

    private string? Validate(DirectPrintJob job)
    {
        var hostOk = PrinterHostPolicy.IsAllowedHost(job.Host)
            || (_options.AllowLoopbackForTests && PrinterHostPolicy.IsLoopback(job.Host));
        if (!hostOk) return "IP เครื่องพิมพ์ต้องเป็นวง LAN ในร้าน (เช่น 192.168.x.x)";
        if (!PrinterHostPolicy.IsAllowedPort(job.Port)) return "พอร์ตเครื่องพิมพ์ไม่ถูกต้อง";
        if (job.Bytes.Length == 0) return "งานพิมพ์ว่าง";
        if (job.Bytes.Length > PrinterHostPolicy.MaxJobBytes) return "งานพิมพ์ใหญ่เกิน 256KB";
        return null;
    }

    private DirectPrintResult Record(DirectPrintJob job, DirectPrintResult result)
    {
        var entry = new PrintHistoryEntry(
            DateTimeOffset.Now, job.JobId, job.Kind, job.Label, $"{job.Host}:{job.Port}",
            result.Outcome, result.Error, result.Attempts, result.ElapsedMs, result.Bytes);
        lock (_historyGate)
        {
            _history.AddFirst(entry);
            while (_history.Count > _options.HistoryLimit) _history.RemoveLast();
        }
        Completed?.Invoke(entry);
        return result;
    }
}
