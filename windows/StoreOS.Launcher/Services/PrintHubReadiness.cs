using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace StoreOS.Launcher.Services;

/// <summary>สถานะที่ Launcher แสดงให้แคชเชียร์เห็น (POS เปิดได้เสมอ แม้ Hub ไม่พร้อม)</summary>
public enum ReadinessState
{
    /// <summary>Hub พร้อมพิมพ์</summary>
    Ready,

    /// <summary>กำลังเตรียม (เพิ่งสั่ง start / รอ health อัปเดต)</summary>
    Preparing,

    /// <summary>Hub ยังไม่พร้อม แต่ POS ใช้งานต่อได้ — งานพิมพ์จะค้างในคิวจนกว่าจะพร้อม</summary>
    Degraded,

    /// <summary>Hub เวอร์ชันเก่าเกินไป ต้องติดตั้งใหม่ (ไม่ใช่ปัญหาที่ retry แล้วหาย)</summary>
    Outdated,

    /// <summary>ยังไม่ได้ติดตั้ง Print Hub บนเครื่องนี้</summary>
    NotInstalled,
}

/// <summary>การตัดสินใจของ Launcher หนึ่งครั้ง: จะสั่ง start task ไหม และจะบอกผู้ใช้ว่าอะไร</summary>
public sealed record ReadinessDecision(
    ReadinessState State,
    bool ShouldStartTask,
    string Message);

/// <summary>สถานะที่ Scheduled Task รายงาน (อ่านผ่าน schtasks/PowerShell)</summary>
public enum ScheduledTaskState
{
    Missing,
    Stopped,
    Running,
    Unknown,
}

/// <summary>health.json ที่ agent เขียนแบบ atomic ทุกรอบ poll (ไม่มีความลับในไฟล์นี้)</summary>
public sealed class HubHealthSnapshot
{
    [JsonPropertyName("schemaVersion")] public int SchemaVersion { get; init; }
    [JsonPropertyName("pid")] public int Pid { get; init; }
    [JsonPropertyName("agentVersion")] public string? AgentVersion { get; init; }
    [JsonPropertyName("protocolVersion")] public int ProtocolVersion { get; init; }
    [JsonPropertyName("state")] public string? State { get; init; }
    [JsonPropertyName("startedAt")] public DateTimeOffset? StartedAt { get; init; }
    [JsonPropertyName("updatedAt")] public DateTimeOffset? UpdatedAt { get; init; }
    [JsonPropertyName("lastPollAt")] public DateTimeOffset? LastPollAt { get; init; }
    [JsonPropertyName("lastSuccessAt")] public DateTimeOffset? LastSuccessAt { get; init; }
    [JsonPropertyName("lastErrorCode")] public string? LastErrorCode { get; init; }
    [JsonPropertyName("storeId")] public string? StoreId { get; init; }
}

/// <summary>
/// ตรรกะการตัดสินใจล้วน ๆ ของ Launcher — ไม่มี I/O จึงทดสอบด้วย xUnit ได้ทั้งหมด
/// (แผน v3 Task 8 กำหนดว่าต้องพิสูจน์ด้วยเทสต์ก่อนแตะเครื่องจริง)
/// </summary>
public static class PrintHubReadiness
{
    /// <summary>health ที่ไม่ได้อัปเดตนานกว่านี้ถือว่าไม่สด (agent ค้าง/ถูกฆ่า)</summary>
    public static readonly TimeSpan HealthFreshWindow = TimeSpan.FromSeconds(45);

    /// <summary>ตัดสินจาก health + สถานะ task ว่าจะทำอะไรต่อ</summary>
    public static ReadinessDecision Decide(
        HubHealthSnapshot? health,
        ScheduledTaskState taskState,
        DateTimeOffset now)
    {
        if (taskState == ScheduledTaskState.Missing && health is null)
        {
            return new ReadinessDecision(
                ReadinessState.NotInstalled,
                ShouldStartTask: false,
                "ยังไม่ได้ติดตั้ง Print Hub บนเครื่องนี้ — เปิดหน้าตั้งค่า Print Hub ใน StoreOS แล้วทำตามขั้นตอนที่ 1");
        }

        var fresh = health?.UpdatedAt is { } updatedAt && now - updatedAt <= HealthFreshWindow;

        if (fresh && string.Equals(health!.State, "outdated", StringComparison.OrdinalIgnoreCase))
        {
            return new ReadinessDecision(
                ReadinessState.Outdated,
                ShouldStartTask: false,
                "Print Hub บนเครื่องนี้เป็นเวอร์ชันเก่าเกินไป — ติดตั้งตัวใหม่ทับจากหน้าตั้งค่า Print Hub");
        }

        if (fresh && string.Equals(health!.State, "ready", StringComparison.OrdinalIgnoreCase))
        {
            return new ReadinessDecision(ReadinessState.Ready, ShouldStartTask: false, "ระบบพิมพ์พร้อมใช้งาน");
        }

        if (fresh)
        {
            // agent ยังหายใจอยู่แต่ยังไม่ ready (กำลังเริ่ม / เน็ตมีปัญหา) — ไม่ต้องสั่ง start ซ้ำ
            return new ReadinessDecision(
                ReadinessState.Preparing,
                ShouldStartTask: false,
                "กำลังเตรียมระบบพิมพ์...");
        }

        // health ไม่สด: ถ้า task ไม่ได้ทำงานอยู่ ให้สั่ง start ผ่าน Scheduled Task เท่านั้น
        if (taskState == ScheduledTaskState.Stopped)
        {
            return new ReadinessDecision(
                ReadinessState.Preparing,
                ShouldStartTask: true,
                "กำลังเปิดระบบพิมพ์...");
        }

        if (taskState == ScheduledTaskState.Missing)
        {
            return new ReadinessDecision(
                ReadinessState.NotInstalled,
                ShouldStartTask: false,
                "ไม่พบตัวช่วยพิมพ์ที่ติดตั้งไว้ — ติดตั้ง Print Hub ใหม่จากหน้าตั้งค่า");
        }

        // task บอกว่า running แต่ health ไม่ขยับ = ค้าง; ไม่ฆ่าให้เอง เพราะอาจกำลังพิมพ์อยู่
        return new ReadinessDecision(
            ReadinessState.Degraded,
            ShouldStartTask: false,
            "ระบบพิมพ์ยังไม่ตอบสนอง — ใช้ขายต่อได้ งานพิมพ์จะค้างในคิวจนกว่าจะกลับมา");
    }

    /// <summary>
    /// อ่าน health.json แบบทนไฟล์เสีย — ไฟล์นี้ถูกเขียนโดยโปรเซสอื่นตลอดเวลา
    /// อ่านเจอครึ่ง ๆ (แม้จะเขียนแบบ atomic แล้ว) ต้องไม่ทำให้ Launcher พัง
    /// </summary>
    public static HubHealthSnapshot? Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            return JsonSerializer.Deserialize<HubHealthSnapshot>(json);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>ตำแหน่ง health.json ที่ agent เขียน (ต้องตรงกับ hubStateDir() ใน print-hub.mjs)</summary>
    public static string HealthFilePath(string localAppData) =>
        Path.Combine(localAppData, "StoreOSPrintHub", "health.json");
}
