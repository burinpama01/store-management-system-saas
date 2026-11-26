using System.Text.Json;

namespace StoreOS.Printing;

public sealed record PosBridgeRequest(
    string Type,
    string? RequestId = null,
    DirectPrintJob? Job = null,
    string? Host = null,
    int Port = PrinterHostPolicy.DefaultPort);

/// <summary>
/// สัญญาข้อความช่อง "storeos.pos" ระหว่างหน้าเว็บกับ StoreOS POS Launcher
/// ต้องตรงกับ src/modules/printing/launcher-direct-print.ts ฝั่งเว็บ
///
/// ข้อความจากเว็บเป็น "คำขอ" — โปรแกรมตรวจเองทุกครั้ง (IP ต้องเป็นวง LAN, ขนาดไม่เกิน 256KB)
/// และโปรแกรมต้องรับข้อความเฉพาะจากหน้าในโดเมนที่อนุญาตเท่านั้น (ตรวจที่ตัวโปรแกรม ไม่ใช่ที่นี่)
/// </summary>
public static class PosBridgeProtocol
{
    public const string Channel = "storeos.pos";
    public const string ProtocolVersion = "1";

    public const string HelloRequest = "hello.request";
    public const string PrintJob = "print.job";
    public const string PrinterProbe = "printer.probe";
    public const string PrintersScan = "printers.scan";
    public const string HistoryGet = "print.history";

    public const string CapabilityDirectPrint = "print.direct";
    public const string CapabilityProbe = "printer.probe";
    public const string CapabilityScan = "printers.scan";

    // base64 ของ 256KB ≈ 350KB + ส่วนหัว JSON
    private const int MaxMessageChars = 400_000;
    private static readonly HashSet<string> AllowedKinds = ["receipt", "kitchen", "test", "table", "other"];

    public static PosBridgeRequest? Parse(string? json)
    {
        if (string.IsNullOrEmpty(json) || json.Length > MaxMessageChars) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || Str(root, "channel") != Channel) return null;
            var type = Str(root, "type");
            var requestId = ShortId(Str(root, "requestId"));
            switch (type)
            {
                case HelloRequest:
                case PrintersScan:
                case HistoryGet:
                    return new PosBridgeRequest(type, requestId);
                case PrinterProbe:
                {
                    var host = Str(root, "host");
                    return host is null ? null : new PosBridgeRequest(type, requestId, Host: host, Port: Port(root));
                }
                case PrintJob:
                {
                    var jobId = ShortId(Str(root, "jobId"));
                    var host = Str(root, "host");
                    var base64 = Str(root, "bytesBase64");
                    if (jobId is null || host is null || base64 is null) return null;
                    byte[] bytes;
                    try { bytes = Convert.FromBase64String(base64); }
                    catch (FormatException) { return null; }
                    var kind = Str(root, "kind");
                    if (kind is null || !AllowedKinds.Contains(kind)) kind = "other";
                    var label = Str(root, "label");
                    if (label is { Length: > 80 }) label = label[..80];
                    var job = new DirectPrintJob(jobId, ShortId(Str(root, "printerId")), host, Port(root), bytes, kind, label);
                    return new PosBridgeRequest(type, jobId, Job: job);
                }
                default:
                    return null;
            }
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static string Hello(string appVersion) => Serialize(new
    {
        channel = Channel,
        type = "hello",
        version = appVersion,
        protocol = ProtocolVersion,
        capabilities = new[] { CapabilityDirectPrint, CapabilityProbe, CapabilityScan },
    });

    public static string Result(DirectPrintResult result) => Serialize(new
    {
        channel = Channel,
        type = "print.result",
        jobId = result.JobId,
        outcome = result.Outcome,
        error = result.Error,
        attempts = result.Attempts,
        elapsedMs = result.ElapsedMs,
        bytes = result.Bytes,
    });

    public static string Probe(string? requestId, PrinterProbeResult probe) => Serialize(new
    {
        channel = Channel,
        type = "printer.status",
        requestId,
        host = probe.Host,
        port = probe.Port,
        reachable = probe.Reachable,
        latencyMs = probe.LatencyMs,
        error = probe.Error,
    });

    public static string Scan(string? requestId, IReadOnlyList<PrinterProbeResult> found) => Serialize(new
    {
        channel = Channel,
        type = "printers.found",
        requestId,
        printers = found.Select(p => new { host = p.Host, port = p.Port, latencyMs = p.LatencyMs }).ToArray(),
    });

    public static string History(string? requestId, IReadOnlyList<PrintHistoryEntry> entries) => Serialize(new
    {
        channel = Channel,
        type = "print.history",
        requestId,
        entries = entries.Select(e => new
        {
            at = e.At.ToString("O"),
            jobId = e.JobId,
            kind = e.Kind,
            label = e.Label,
            target = e.Target,
            outcome = e.Outcome,
            error = e.Error,
            attempts = e.Attempts,
            elapsedMs = e.ElapsedMs,
            bytes = e.Bytes,
        }).ToArray(),
    });

    private static int Port(JsonElement root) =>
        root.TryGetProperty("port", out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetInt32(out var n)
            ? n
            : PrinterHostPolicy.DefaultPort;

    /// <summary>id จากเว็บ: ตัวอักษร/ตัวเลข/-/_ ไม่เกิน 64 ตัว — กันข้อความแปลกปลอมไหลเข้า log</summary>
    private static string? ShortId(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 64) return null;
        foreach (var c in value)
        {
            if (!(char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or ':')) return null;
        }
        return value;
    }

    private static string Serialize(object value) => JsonSerializer.Serialize(value);

    private static string? Str(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
