using System.Text;
using System.Text.Json;

namespace StoreOS.Voice;

/// <summary>ข้อความที่หน้าเว็บส่งกลับมาหา native (หลังผ่านด่านแล้วเท่านั้น)</summary>
public sealed record StandbyInbound(string Type, long Seq, string SessionId, DateTimeOffset At);

/// <summary>ผลการตรวจข้อความหนึ่งใบ — ถูกปฏิเสธต้องมีเหตุผลเสมอเพื่อให้ไล่ปัญหาได้จาก log</summary>
public sealed record BridgeVerdict(bool Accepted, string Reason, StandbyInbound? Message = null)
{
    public static BridgeVerdict Reject(string reason) => new(false, reason);
    public static BridgeVerdict Accept(StandbyInbound message) => new(true, "ok", message);
}

/// <summary>เทียบ origin แบบตรงตัว (scheme + host + port)</summary>
public static class WebOrigin
{
    /// <summary>
    /// เทียบว่าเป็นเว็บเดียวกันจริง ๆ ไหม
    ///
    /// ต้องเทียบทั้ง scheme, host และ port — การเทียบแค่ host เป็นช่องโหว่คลาสสิก
    /// เพราะ http://โฮสต์เดียวกัน (ถูกดักกลางทางได้) จะผ่านด้วย
    /// </summary>
    public static bool IsSameOrigin(string? candidate, Uri? expected)
    {
        if (expected is null) return false;
        if (!Uri.TryCreate(candidate, UriKind.Absolute, out var uri)) return false;
        if (!string.IsNullOrEmpty(uri.UserInfo)) return false;

        return uri.Scheme.Equals(expected.Scheme, StringComparison.OrdinalIgnoreCase)
            && uri.Host.Equals(expected.Host, StringComparison.OrdinalIgnoreCase)
            && uri.Port == expected.Port;
    }
}

/// <summary>
/// ด่านตรวจข้อความจากหน้าเว็บก่อนถึงตัวประสานงานไมโครโฟน (แผน v1 W4)
///
/// ทำไมต้องมีด่านเต็มรูปแบบทั้งที่ "ก็หน้าเว็บของเราเอง":
///   หน้าเว็บรัน JavaScript ของบุคคลที่สามได้เสมอ (สคริปต์วิเคราะห์, ส่วนขยาย, โฆษณาในอนาคต)
///   และ WebView2 ส่งข้อความจาก iframe/หน้าที่ถูก navigate ไปแล้วเข้ามาทางเดียวกัน
///   สิ่งที่ข้อความเหล่านี้สั่งได้คือ "ไมโครโฟนของเครื่องร้าน" จึงต้องถือว่าเป็น
///   <b>ข้อมูลที่ไม่น่าเชื่อถือ</b> ทุกใบ ไม่ใช่คำสั่งจากพวกเดียวกัน
///
/// ที่ด่านนี้ปฏิเสธ:
///   * ไม่ใช่ origin เดียวกันแบบตรงตัว (รวมพอร์ต)
///   * ใหญ่เกิน 4KB — ข้อความจริงยาวไม่ถึง 200 ไบต์ ที่เกินคือความพยายามอย่างอื่น
///   * JSON เสีย, เวอร์ชันไม่รู้จัก, ชนิดที่เว็บไม่มีสิทธิ์ส่ง
///   * seq ย้อนหลัง/ซ้ำ (เล่นซ้ำข้อความเก่าเพื่อยืดเวลาถือไมค์)
///   * เวลาบนข้อความเก่าเกินไป
/// </summary>
public sealed class StandbyBridgePolicy
{
    public const int MaxPayloadBytes = 4096;
    /// <summary>ยอมให้นาฬิกาสองฝั่งต่างกันได้เท่าไร ก่อนถือว่าข้อความเก่าเกินใช้</summary>
    public static readonly TimeSpan MaxSkew = TimeSpan.FromSeconds(60);

    private static readonly HashSet<string> WebSendableTypes =
    [
        StandbyContract.SessionStarted,
        StandbyContract.SessionExtended,
        StandbyContract.SessionEnded,
        StandbyContract.RequestHealth,
    ];

    private readonly Dictionary<string, long> _lastSeqBySession = new();

    /// <summary>ล้างสถานะทั้งหมด — ใช้ตอนหน้าเว็บถูก navigate ไปที่อื่น</summary>
    public void Reset() => _lastSeqBySession.Clear();

    public BridgeVerdict Evaluate(string? rawJson, string? sourceUri, Uri? allowedOrigin, DateTimeOffset now)
    {
        if (!WebOrigin.IsSameOrigin(sourceUri, allowedOrigin)) return BridgeVerdict.Reject("origin_mismatch");
        if (string.IsNullOrWhiteSpace(rawJson)) return BridgeVerdict.Reject("empty");
        if (Encoding.UTF8.GetByteCount(rawJson) > MaxPayloadBytes) return BridgeVerdict.Reject("too_large");

        JsonElement root;
        try
        {
            using var document = JsonDocument.Parse(rawJson);
            root = document.RootElement.Clone();
        }
        catch (JsonException)
        {
            return BridgeVerdict.Reject("malformed_json");
        }

        if (root.ValueKind != JsonValueKind.Object) return BridgeVerdict.Reject("not_an_object");

        if (!root.TryGetProperty("v", out var version)
            || version.ValueKind != JsonValueKind.Number
            || version.GetInt32() != StandbyContract.Version)
            return BridgeVerdict.Reject("unknown_version");

        if (!root.TryGetProperty("type", out var typeElement)
            || typeElement.ValueKind != JsonValueKind.String
            || typeElement.GetString() is not { } type
            || !WebSendableTypes.Contains(type))
            return BridgeVerdict.Reject("unknown_type");

        if (!root.TryGetProperty("seq", out var seqElement)
            || seqElement.ValueKind != JsonValueKind.Number
            || !seqElement.TryGetInt64(out var seq)
            || seq <= 0)
            return BridgeVerdict.Reject("bad_seq");

        if (!root.TryGetProperty("sessionId", out var sessionElement)
            || sessionElement.ValueKind != JsonValueKind.String
            || sessionElement.GetString() is not { Length: > 0 } sessionId
            || sessionId.Length > 64)
            return BridgeVerdict.Reject("bad_session");

        var at = now;
        if (root.TryGetProperty("at", out var atElement) && atElement.ValueKind == JsonValueKind.String)
        {
            if (!DateTimeOffset.TryParse(atElement.GetString(), out at)) return BridgeVerdict.Reject("bad_timestamp");
            var drift = now - at;
            if (drift > MaxSkew || drift < -MaxSkew) return BridgeVerdict.Reject("stale_timestamp");
        }

        // ข้อความเก่าที่ถูกส่งซ้ำ = ความพยายามยืดเวลาถือไมค์ หรือสายที่ค้างแล้วมาถึงช้า
        if (_lastSeqBySession.TryGetValue(sessionId, out var last) && seq <= last)
            return BridgeVerdict.Reject("replayed_seq");
        _lastSeqBySession[sessionId] = seq;

        return BridgeVerdict.Accept(new StandbyInbound(type, seq, sessionId, at));
    }
}
