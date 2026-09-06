using System.IO;

using StoreOS.Voice;

using Xunit;

namespace StoreOS.Voice.Tests;

/// <summary>
/// เครื่องยนต์คำปลุกที่ใช้จริง (Vosk)
///
/// ตัวเลขที่ทำให้เลือก engine นี้ (วัดในห้องจริงชุดละ 4 นาที ไม่มีใครพูดคำปลุก):
/// System.Speech ปลุกผิด 14–20 ครั้ง · Vosk ปลุกผิด 0 ครั้ง และจับคำจริงได้ 12/12
/// </summary>
public class VoskWakeEngineTests
{
    [Fact]
    public void ได้ยินวลีคำปลุกกลางประโยคก็ต้องนับ()
    {
        // ผลจริงจากโมเดล: "Hello StoreOS" ถูกถอดเป็น "hello store [unk]" ทุกครั้ง
        // เพราะ "โอเอส" ไม่มีในพจนานุกรม — ถ้าเทียบทั้งประโยคจะพลาดทุกครั้ง
        var match = VoskWakeEngine.MatchWakePhrase("hello store [unk]", WakePhrases.VoskPhrases);

        Assert.Equal("hello store", match);
    }

    [Theory]
    [InlineData("[unk]")]
    [InlineData("[unk] [unk]")]
    // ได้ยินแค่คำเดียวของวลีต้องไม่ปลุก — เจอจริงในห้อง 3 ครั้งใน 4 นาที
    [InlineData("hello")]
    [InlineData("store")]
    [InlineData("hello [unk] store")]
    [InlineData("")]
    public void เสียงอื่นต้องไม่นับเป็นคำปลุก(string heard)
    {
        Assert.Null(VoskWakeEngine.MatchWakePhrase(heard, WakePhrases.VoskPhrases));
    }

    [Fact]
    public void คำปลุกที่ใช้ต้องเป็นคำอังกฤษล้วน()
    {
        // โมเดลเป็นภาษาอังกฤษ การใส่คำไทยจะกลายเป็น [unk] เสมอ
        // และการเขียนหน่วยเสียงไทยเองบน engine อังกฤษคือสาเหตุของการปลุกเองที่วัดได้
        foreach (var phrase in WakePhrases.VoskPhrases)
        {
            Assert.All(phrase, c => Assert.True(c < 128, $"คำปลุกต้องเป็น ASCII: {phrase}"));
            Assert.Contains(' ', phrase); // ต้องมีอย่างน้อยสองคำ คำเดียวปลุกง่ายเกินไป
        }
    }

    [Fact]
    public void รหัสคำปลุกไม่ใช่ข้อความที่ได้ยิน()
    {
        Assert.Equal("hello_storeos", WakePhrases.VoskPhraseId("hello store"));
        Assert.Equal("unknown", WakePhrases.VoskPhraseId("อะไรก็ไม่รู้"));
    }

    [Fact]
    public async Task ไม่มีชุดข้อมูลเสียงต้องบอกเหตุผลชัด_ไม่ใช่พังเงียบ()
    {
        await using var engine = new VoskWakeEngine(Path.Combine(Path.GetTempPath(), "ไม่มีโฟลเดอร์นี้"));
        WakeEngineFaultEventArgs? fault = null;
        engine.Faulted += (_, e) => fault = e;

        await engine.StartAsync(new WakeWordOptions(), CancellationToken.None);

        Assert.Equal(WakeEngineState.Faulted, engine.State);
        Assert.Equal("vosk_model_missing", fault!.Code);
    }

    [Fact]
    public async Task หยุดโดยไม่เคยเริ่มต้องไม่พัง()
    {
        await using var engine = new VoskWakeEngine(VoskWakeEngine.DefaultModelPath());

        await engine.StopAsync(CancellationToken.None);

        Assert.Equal(WakeEngineState.Off, engine.State);
    }

    [Fact]
    public async Task เริ่มหลัง_dispose_ต้องถูกปฏิเสธ()
    {
        var engine = new VoskWakeEngine(VoskWakeEngine.DefaultModelPath());
        await engine.DisposeAsync();

        await Assert.ThrowsAsync<ObjectDisposedException>(() =>
            engine.StartAsync(new WakeWordOptions(), CancellationToken.None));
    }
}
