using StoreOS.Voice;

using Xunit;

namespace StoreOS.Voice.Tests;

public class StandbySessionTests
{
    private static StandbySession NewSession() =>
        new(handoffTimeoutMs: 1200, maxListeningWindowMs: 9000, absoluteMaxMs: 20000, sessionIdFactory: () => "sess1");

    private static readonly DateTimeOffset At = new(2026, 9, 6, 10, 0, 0, TimeSpan.FromHours(7));

    [Fact]
    public void ปลุกแล้วส่งข้อความ_wake_detected_พร้อมรหัสคำปลุก()
    {
        var session = NewSession();

        var message = session.OnWakeAccepted("sawatdee_os", 0.912, nowMs: 0, At);

        Assert.Equal(StandbyContract.WakeDetected, message.Type);
        Assert.Equal(StandbyContract.Version, message.V);
        Assert.Equal("sess1", message.SessionId);
        Assert.Equal("sawatdee_os", message.PhraseId);
        Assert.Equal(0.91, message.Confidence);
        Assert.Equal(StandbyState.HandingOff, session.State);
    }

    [Fact]
    public void ข้อความที่ส่งออกต้องไม่มีข้อความที่ได้ยินหรือเสียง()
    {
        var session = NewSession();

        var json = StandbyContract.Serialize(session.OnWakeAccepted("hello_os", 0.9, 0, At));

        Assert.DoesNotContain("transcript", json);
        Assert.DoesNotContain("audio", json);
        Assert.Contains("\"phraseId\":\"hello_os\"", json);
    }

    [Fact]
    public void เว็บตอบว่าเริ่มฟังแล้วจึงเข้าสถานะ_listening()
    {
        var session = NewSession();
        session.OnWakeAccepted("hello_os", 0.9, 0, At);

        session.OnSessionStarted(nowMs: 300);

        Assert.Equal(StandbyState.Listening, session.State);
        Assert.Null(session.Tick(nowMs: 5000, At));
    }

    [Fact]
    public void เว็บไม่ตอบภายในเวลา_ต้องตกไปให้ผู้ใช้กดพูดเอง()
    {
        var session = NewSession();
        session.OnWakeAccepted("hello_os", 0.9, 0, At);

        var fallback = session.Tick(nowMs: 1300, At);

        Assert.NotNull(fallback);
        Assert.Equal(StandbyContract.WakeFallback, fallback!.Type);
        Assert.Equal("user_activation_missing", fallback.Reason);
        Assert.Equal(StandbyState.Standby, session.State);
        Assert.True(session.LastRoundFellBackToPushToTalk);
    }

    [Fact]
    public void watchdog_ต้องยาวกว่าหน้าต่างฟังของเว็บเสมอ()
    {
        // ถ้าตั้ง watchdog สั้นกว่าหน้าต่างฟังจริงของเว็บ จะตัดกลางประโยคผู้ใช้
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            new StandbySession(maxListeningWindowMs: StandbySession.WebMaxListeningWindowMs));
    }

    [Fact]
    public void watchdog_ตัดเมื่อเว็บฟังเกินหน้าต่างที่ให้()
    {
        var session = NewSession();
        session.OnWakeAccepted("hello_os", 0.9, 0, At);
        session.OnSessionStarted(nowMs: 200);

        var ended = session.Tick(nowMs: 200 + 9001, At);

        Assert.NotNull(ended);
        Assert.Equal(StandbyContract.SessionEnded, ended!.Type);
        Assert.Equal("watchdog_timeout", ended.Reason);
        Assert.Equal(StandbyState.Standby, session.State);
    }

    [Fact]
    public void คุยต่อหลายรอบต่อเวลาได้_แต่ไม่เกินเพดานรวม()
    {
        var session = NewSession();
        session.OnWakeAccepted("hello_os", 0.9, 0, At);
        session.OnSessionStarted(nowMs: 0);

        // ต่อเวลาทุก 5 วินาที — multi-turn 15 วินาทีตาม Test Matrix ต้องยังไม่ถูกตัด
        session.OnSessionExtended(nowMs: 5000);
        session.OnSessionExtended(nowMs: 10_000);
        session.OnSessionExtended(nowMs: 15_000);
        Assert.Null(session.Tick(nowMs: 15_500, At));

        // แต่พอเลยเพดานรวม 20 วินาที ต้องถูกตัดแม้จะยังขอต่อเวลา
        session.OnSessionExtended(nowMs: 19_000);
        Assert.NotNull(session.Tick(nowMs: 20_001, At));
    }

    [Fact]
    public void จบรอบปกติแล้วกลับไป_standby_และปลุกใหม่ได้()
    {
        var session = NewSession();
        session.OnWakeAccepted("hello_os", 0.9, 0, At);
        session.OnSessionStarted(100);
        session.OnSessionEnded(3000);

        Assert.Equal(StandbyState.Standby, session.State);
        Assert.False(session.MicHeldByWeb);

        var next = session.OnWakeAccepted("watdee_os", 0.95, 4000, At);
        Assert.Equal(2, next.Seq); // seq เดินหน้าเสมอเพื่อให้ฝั่งรับทิ้งข้อความซ้ำได้
    }

    [Fact]
    public void ข้อความ_sessionStarted_ที่มาช้าหลัง_watchdog_ตัดแล้วต้องถูกทิ้ง()
    {
        var session = NewSession();
        session.OnWakeAccepted("hello_os", 0.9, 0, At);
        session.Tick(nowMs: 1300, At); // watchdog ตัดไปแล้ว

        session.OnSessionStarted(nowMs: 1400);

        Assert.Equal(StandbyState.Standby, session.State);
    }

    [Fact]
    public void ห้ามปลุกซ้อนขณะที่ยังไม่คืนไมค์()
    {
        var session = NewSession();
        session.OnWakeAccepted("hello_os", 0.9, 0, At);

        Assert.Throws<InvalidOperationException>(() => session.OnWakeAccepted("hello_os", 0.9, 100, At));
    }
}
