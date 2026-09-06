using System.Text.Json;
using System.Text.Json.Serialization;

namespace StoreOS.Voice;

/// <summary>
/// สัญญาข้อความระหว่าง native host กับหน้าเว็บ StoreOS (แผน v3 Task 9)
///
/// กฎที่ห้ามละเมิด:
///   * native ส่งได้แค่ "ได้ยินคำปลุก" — ห้ามส่ง intent สำเร็จรูป ห้ามส่ง transcript
///     และห้ามส่งเสียง การตีความทั้งหมดยังเป็นของโมดูลเดิมบนเว็บ
///   * ทุกข้อความมี <c>v</c> และ <c>seq</c> เพื่อให้ฝั่งรับทิ้งข้อความที่มาช้า/ซ้ำได้
///   * <c>sessionId</c> ผูก wake หนึ่งครั้งกับ session หนึ่งรอบ ใช้จับคู่ในรายงาน
/// ฝั่งเว็บมีสัญญาเดียวกันที่ src/modules/voice-pos/standby-contract.ts — แก้ที่ไหนต้องแก้อีกที่
/// </summary>
public static class StandbyContract
{
    public const int Version = 1;

    /// <summary>native → web: ได้ยินคำปลุกแล้ว และปล่อยไมค์เรียบร้อยแล้ว</summary>
    public const string WakeDetected = "wake.detected";
    /// <summary>native → web: ปลุกไม่สำเร็จ ให้เว็บแสดงทางเลือกกดพูดเอง</summary>
    public const string WakeFallback = "wake.fallback";
    /// <summary>web → native: เว็บเริ่มถือไมค์ฟังคำสั่งแล้ว</summary>
    public const string SessionStarted = "command.sessionStarted";
    /// <summary>web → native: ยังคุยต่อ (multi-turn) ขอต่อเวลา watchdog</summary>
    public const string SessionExtended = "command.sessionExtended";
    /// <summary>web → native: จบรอบแล้ว คืนไมค์ให้ native</summary>
    public const string SessionEnded = "command.sessionEnded";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string Serialize(StandbyMessage message) => JsonSerializer.Serialize(message, JsonOptions);
}

/// <summary>ข้อความหนึ่งใบบนสาย native ↔ web</summary>
public sealed record StandbyMessage(
    [property: JsonPropertyName("v")] int V,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("seq")] long Seq,
    [property: JsonPropertyName("sessionId")] string SessionId,
    [property: JsonPropertyName("at")] string At,
    /// <summary>รหัสคำปลุก (เฉพาะ wake.detected) — เป็นรหัส ไม่ใช่ข้อความที่ได้ยิน</summary>
    [property: JsonPropertyName("phraseId")] string? PhraseId = null,
    /// <summary>ความมั่นใจของ engine ปัดทศนิยม 2 ตำแหน่งพอ ไม่ต้องละเอียดกว่านี้</summary>
    [property: JsonPropertyName("confidence")] double? Confidence = null,
    /// <summary>เหตุผลที่จบ/ตกไป เช่น watchdog_timeout, user_activation_missing</summary>
    [property: JsonPropertyName("reason")] string? Reason = null);
