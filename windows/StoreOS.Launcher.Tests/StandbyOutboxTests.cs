using StoreOS.Launcher.Services;

using Xunit;

namespace StoreOS.Launcher.Tests;

/// <summary>
/// ทางออกของข้อความไปหน้าเว็บ ต้องวิ่งผ่านเธรด UI เสมอ
///
/// เจอกับตัวบนเครื่องจริง: คำปลุกถูกตรวจพบบนเธรดของการ์ดเสียง แล้วเรียก
/// PostWebMessageAsJson ตรง ๆ ซึ่ง CoreWebView2 ไม่ยอมให้เรียกข้ามเธรด
/// log บอกว่า "ได้ยินคำปลุก hello_storeos (1.00)" ทุกครั้ง ตามด้วย
/// voice_bridge_post_failed: InvalidOperationException — คนหน้าร้านเห็นเป็น "ปลุกไม่ติด"
/// </summary>
public class StandbyOutboxTests
{
    private sealed class Recorder
    {
        public readonly List<string> Posted = new();
        public readonly List<string> Logs = new();
        public int DispatchCount;
        /// <summary>เธรดที่ postJson ถูกเรียกจริง — หัวใจของเทสต์ชุดนี้</summary>
        public int? PostedOnThread;
    }

    /// <summary>จำลอง Dispatcher: งานที่ส่งมาจะถูกทำบน "เธรด UI" ที่กำหนดไว้เท่านั้น</summary>
    private static (StandbyOutbox outbox, Recorder rec, Action drain) Build()
    {
        var rec = new Recorder();
        var queue = new Queue<Action>();
        var outbox = new StandbyOutbox(
            action => { rec.DispatchCount++; queue.Enqueue(action); },
            json => { rec.Posted.Add(json); rec.PostedOnThread = Environment.CurrentManagedThreadId; },
            (level, code, message) => rec.Logs.Add($"{level}:{code}:{message}"));
        return (outbox, rec, () => { while (queue.Count > 0) queue.Dequeue()(); });
    }

    [Fact]
    public void ส่งจากเธรดอื่นต้องไม่เรียกหน้าเว็บโดยตรง()
    {
        var (outbox, rec, drain) = Build();

        var worker = new Thread(() => outbox.Send("{\"type\":\"wake.detected\"}"));
        worker.Start();
        worker.Join();

        // ยังไม่ถูกส่งจนกว่าเธรด UI จะทำงาน — นี่คือสิ่งที่กันไม่ให้เกิด InvalidOperationException
        Assert.Empty(rec.Posted);
        Assert.Equal(1, rec.DispatchCount);

        drain();

        Assert.Single(rec.Posted);
        Assert.Equal(Environment.CurrentManagedThreadId, rec.PostedOnThread);
    }

    [Fact]
    public void ปิดสายแล้วต้องไม่ส่งอะไรอีก()
    {
        var (outbox, rec, drain) = Build();
        outbox.Enabled = false;

        outbox.Send("{}");
        drain();

        Assert.Empty(rec.Posted);
        Assert.Equal(0, rec.DispatchCount);
    }

    [Fact]
    public void ปิดสายระหว่างที่งานยังรอคิว_ต้องไม่ส่งของเก่าออกไป()
    {
        // หน้าเว็บถูกพาไปโดเมนอื่นระหว่างที่คำปลุกยังรอเธรด UI อยู่
        var (outbox, rec, drain) = Build();
        outbox.Send("{}");

        outbox.Enabled = false;
        drain();

        Assert.Empty(rec.Posted);
    }

    [Fact]
    public void ส่งไม่สำเร็จต้องบันทึกไว้_ไม่ใช่ทำให้โปรแกรมล้ม()
    {
        var logs = new List<string>();
        var outbox = new StandbyOutbox(
            action => action(),
            _ => throw new InvalidOperationException("wrong thread"),
            (level, code, message) => logs.Add($"{level}:{code}"));

        outbox.Send("{}");

        Assert.Contains("warn:voice_bridge_post_failed", logs);
    }
}
