using System.Text.Json;

using StoreOS.Voice;

using Xunit;

namespace StoreOS.Voice.Tests;

/// <summary>
/// W4 — ด่านตรวจข้อความจากหน้าเว็บ
///
/// ข้อความพวกนี้สั่ง "ไมโครโฟนของเครื่องร้าน" ได้ จึงต้องถือว่าไม่น่าเชื่อถือทุกใบ
/// แม้จะมาจากหน้าเว็บของเราเอง (หน้าเว็บรันสคริปต์ของบุคคลที่สามได้เสมอ)
/// </summary>
public class StandbyBridgePolicyTests
{
    private static readonly Uri Allowed = new("https://www.store-os.online/pos");
    private static readonly DateTimeOffset Now = new(2026, 9, 6, 12, 0, 0, TimeSpan.FromHours(7));

    private static string Message(
        string type = StandbyContract.SessionStarted,
        int v = StandbyContract.Version,
        long seq = 1,
        string sessionId = "sess123",
        string? at = null)
    {
        var payload = new Dictionary<string, object?>
        {
            ["v"] = v,
            ["type"] = type,
            ["seq"] = seq,
            ["sessionId"] = sessionId,
            ["at"] = at ?? Now.ToString("o"),
        };
        return JsonSerializer.Serialize(payload);
    }

    [Fact]
    public void ข้อความปกติจากหน้าเดียวกันผ่าน()
    {
        var policy = new StandbyBridgePolicy();

        var verdict = policy.Evaluate(Message(), "https://www.store-os.online/pos", Allowed, Now);

        Assert.True(verdict.Accepted);
        Assert.Equal(StandbyContract.SessionStarted, verdict.Message!.Type);
        Assert.Equal("sess123", verdict.Message.SessionId);
    }

    [Theory]
    // คนละโดเมน
    [InlineData("https://evil.example/pos")]
    // โดเมนที่ตั้งใจให้ดูคล้าย
    [InlineData("https://www.store-os.online.evil.example/pos")]
    // scheme ต่างกัน — เทียบแค่ host จะปล่อยผ่าน ซึ่งเป็นช่องโหว่คลาสสิก
    [InlineData("http://www.store-os.online/pos")]
    // พอร์ตต่างกัน = คนละ origin ตามนิยามของเบราว์เซอร์
    [InlineData("https://www.store-os.online:8443/pos")]
    // เทคนิคหลอกตาด้วย user-info
    [InlineData("https://www.store-os.online@evil.example/pos")]
    [InlineData("about:blank")]
    [InlineData(null)]
    public void ข้อความจากที่อื่นถูกปฏิเสธ(string? source)
    {
        var policy = new StandbyBridgePolicy();

        var verdict = policy.Evaluate(Message(), source, Allowed, Now);

        Assert.False(verdict.Accepted);
        Assert.Equal("origin_mismatch", verdict.Reason);
    }

    [Fact]
    public void ข้อความใหญ่เกินสี่กิโลไบต์ถูกปฏิเสธ()
    {
        var policy = new StandbyBridgePolicy();
        var huge = Message(sessionId: new string('ก', 3000));

        var verdict = policy.Evaluate(huge, "https://www.store-os.online/pos", Allowed, Now);

        Assert.False(verdict.Accepted);
        Assert.Equal("too_large", verdict.Reason);
    }

    [Theory]
    [InlineData("{ไม่ใช่ json")]
    [InlineData("[1,2,3]")]
    [InlineData("\"just a string\"")]
    [InlineData("")]
    public void ข้อความรูปทรงผิดถูกปฏิเสธ(string raw)
    {
        var policy = new StandbyBridgePolicy();

        var verdict = policy.Evaluate(raw, "https://www.store-os.online/pos", Allowed, Now);

        Assert.False(verdict.Accepted);
    }

    [Fact]
    public void เวอร์ชันสัญญาที่ไม่รู้จักถูกปฏิเสธ()
    {
        var policy = new StandbyBridgePolicy();

        var verdict = policy.Evaluate(Message(v: 2), "https://www.store-os.online/pos", Allowed, Now);

        Assert.Equal("unknown_version", verdict.Reason);
    }

    [Theory]
    // ชนิดที่ native เป็นคนส่ง เว็บส่งกลับมาไม่ได้ — ไม่งั้นหน้าเว็บ "ปลุกตัวเอง" ได้
    [InlineData("wake.detected")]
    [InlineData("wake.fallback")]
    [InlineData("command.startListeningNow")]
    public void ชนิดที่เว็บไม่มีสิทธิ์ส่งถูกปฏิเสธ(string type)
    {
        var policy = new StandbyBridgePolicy();

        var verdict = policy.Evaluate(Message(type: type), "https://www.store-os.online/pos", Allowed, Now);

        Assert.Equal("unknown_type", verdict.Reason);
    }

    [Fact]
    public void ส่งข้อความเดิมซ้ำเพื่อยืดเวลาถือไมค์ถูกปฏิเสธ()
    {
        var policy = new StandbyBridgePolicy();
        const string source = "https://www.store-os.online/pos";
        policy.Evaluate(Message(seq: 5), source, Allowed, Now);

        var replay = policy.Evaluate(Message(seq: 5), source, Allowed, Now);
        var older = policy.Evaluate(Message(seq: 3), source, Allowed, Now);

        Assert.Equal("replayed_seq", replay.Reason);
        Assert.Equal("replayed_seq", older.Reason);
    }

    [Fact]
    public void seq_เดินหน้าในรอบเดิมผ่านได้()
    {
        var policy = new StandbyBridgePolicy();
        const string source = "https://www.store-os.online/pos";

        policy.Evaluate(Message(seq: 1), source, Allowed, Now);
        var next = policy.Evaluate(Message(type: StandbyContract.SessionExtended, seq: 2), source, Allowed, Now);

        Assert.True(next.Accepted);
    }

    [Fact]
    public void คนละรอบนับ_seq_แยกกัน()
    {
        var policy = new StandbyBridgePolicy();
        const string source = "https://www.store-os.online/pos";
        policy.Evaluate(Message(seq: 9, sessionId: "sessA"), source, Allowed, Now);

        var other = policy.Evaluate(Message(seq: 1, sessionId: "sessB"), source, Allowed, Now);

        Assert.True(other.Accepted);
    }

    [Theory]
    [InlineData(-120)]
    [InlineData(120)]
    public void เวลาบนข้อความที่ห่างเกินไปถูกปฏิเสธ(int secondsOffset)
    {
        var policy = new StandbyBridgePolicy();

        var verdict = policy.Evaluate(
            Message(at: Now.AddSeconds(secondsOffset).ToString("o")),
            "https://www.store-os.online/pos",
            Allowed,
            Now);

        Assert.Equal("stale_timestamp", verdict.Reason);
    }

    [Fact]
    public void นาฬิกาเครื่องต่างกันเล็กน้อยยังผ่าน()
    {
        var policy = new StandbyBridgePolicy();

        var verdict = policy.Evaluate(
            Message(at: Now.AddSeconds(-20).ToString("o")),
            "https://www.store-os.online/pos",
            Allowed,
            Now);

        Assert.True(verdict.Accepted);
    }

    [Fact]
    public void ล้างสถานะแล้วเริ่มนับ_seq_ใหม่ได้()
    {
        var policy = new StandbyBridgePolicy();
        const string source = "https://www.store-os.online/pos";
        policy.Evaluate(Message(seq: 7), source, Allowed, Now);

        policy.Reset();
        var afterReset = policy.Evaluate(Message(seq: 1), source, Allowed, Now);

        Assert.True(afterReset.Accepted);
    }

    [Fact]
    public void ไม่มีปลายทางที่อนุญาตไว้ก็ต้องไม่รับอะไรเลย()
    {
        var policy = new StandbyBridgePolicy();

        var verdict = policy.Evaluate(Message(), "https://www.store-os.online/pos", null, Now);

        Assert.Equal("origin_mismatch", verdict.Reason);
    }
}
