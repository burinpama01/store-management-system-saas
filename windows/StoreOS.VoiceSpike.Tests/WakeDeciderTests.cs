using StoreOS.Voice;

using Xunit;

namespace StoreOS.Voice.Tests;

public class WakeDeciderTests
{
    [Fact]
    public void ปลุกเมื่อความมั่นใจถึงเกณฑ์()
    {
        var decider = new WakeDecider();

        var result = decider.Evaluate("hello_os", 0.9, nowMs: 0, sessionActive: false);

        Assert.Equal(WakeVerdict.Accepted, result.Verdict);
        Assert.True(result.ShouldWake);
    }

    [Fact]
    public void ไม่ปลุกเมื่อความมั่นใจต่ำกว่าเกณฑ์()
    {
        var decider = new WakeDecider(minConfidence: 0.8);

        var result = decider.Evaluate("sawatdee_os", 0.79, nowMs: 0, sessionActive: false);

        Assert.Equal(WakeVerdict.RejectedLowConfidence, result.Verdict);
    }

    [Fact]
    public void ปลุกซ้ำภายในช่วงพักต้องถูกปฏิเสธ()
    {
        var decider = new WakeDecider(cooldownMs: 3000);
        decider.Evaluate("hello_os", 0.95, nowMs: 1000, sessionActive: false);

        var again = decider.Evaluate("hello_os", 0.95, nowMs: 2500, sessionActive: false);

        Assert.Equal(WakeVerdict.RejectedCooldown, again.Verdict);
    }

    [Fact]
    public void พ้นช่วงพักแล้วปลุกได้อีก()
    {
        var decider = new WakeDecider(cooldownMs: 3000);
        decider.Evaluate("hello_os", 0.95, nowMs: 1000, sessionActive: false);

        var again = decider.Evaluate("hello_os", 0.95, nowMs: 4001, sessionActive: false);

        Assert.Equal(WakeVerdict.Accepted, again.Verdict);
    }

    [Fact]
    public void ห้ามปลุกขณะที่เว็บถือไมค์อยู่()
    {
        var decider = new WakeDecider();

        var result = decider.Evaluate("watdee_os", 0.99, nowMs: 10_000, sessionActive: true);

        Assert.Equal(WakeVerdict.RejectedSessionActive, result.Verdict);
    }
}
