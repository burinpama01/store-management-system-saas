using System.IO;
using System.Text.Json;

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
        Assert.Equal("hey_storeos", WakePhrases.VoskPhraseId("hey store"));
        Assert.Equal("unknown", WakePhrases.VoskPhraseId("อะไรก็ไม่รู้"));
    }

    [Fact]
    public void ทุกคำปลุกที่ใช้ต้องมีรหัส_ไม่งั้น_telemetry_จะเป็น_unknown()
    {
        // ลืมเพิ่มรหัสตอนเพิ่มคำปลุก = ฝั่งเว็บได้ "unknown" แล้วทิ้งข้อความนั้น
        // อาการปลายทางคือ "ปลุกติดแล้วแต่ไม่ขึ้นรับคำสั่ง" ซึ่งไล่สาเหตุไม่ได้เลย
        foreach (var phrase in WakePhrases.VoskPhrases)
        {
            Assert.NotEqual("unknown", WakePhrases.VoskPhraseId(phrase));
        }
    }

    [Fact]
    public void คำปลุกทางเลือก_hey_store_ต้องจับได้เหมือนกัน()
    {
        Assert.Equal("hey store", VoskWakeEngine.MatchWakePhrase("hey store [unk]", WakePhrases.VoskPhrases));
    }

    [Fact]
    public void รู้ตำแหน่งของวลีในประโยค_เพื่อให้คะแนนเฉพาะคำของคำปลุก()
    {
        var match = VoskWakeEngine.FindWakePhrase("[unk] hello store [unk]", WakePhrases.VoskPhrases);

        Assert.NotNull(match);
        Assert.Equal("hello store", match!.Phrase);
        Assert.Equal(1, match.StartIndex);
        Assert.Equal(2, match.WordCount);
    }

    [Fact]
    public void ความมั่นใจต้องนับเฉพาะคำของคำปลุก_ไม่ใช่ทั้งประโยค()
    {
        // นี่คือสาเหตุของอาการ "พูดแล้วไม่ติด": เราบอกผู้ใช้ให้พูด "Hello StoreOS"
        // ซึ่งถอดได้เป็น "hello store [unk]" เสมอ และ [unk] มีความมั่นใจต่ำมาก
        // ของเดิมเอาคำที่แย่ที่สุดทั้งประโยค คำปลุกจริงจึงถูกปัดตกทุกครั้ง
        using var document = JsonDocument.Parse(
            """{"text":"hello store [unk]","result":[{"word":"hello","conf":0.95},{"word":"store","conf":0.88},{"word":"[unk]","conf":0.11}]}""");
        var match = VoskWakeEngine.FindWakePhrase("hello store [unk]", WakePhrases.VoskPhrases)!;

        var score = VoskWakeEngine.ScorePhrase(document.RootElement, match);

        Assert.Equal(0.88, score, 3);
        Assert.True(score >= WakeDecider.DefaultMinConfidence, "คำปลุกที่ได้ยินครบต้องผ่านเกณฑ์");
    }

    [Fact]
    public void คำในวลีที่ไม่ชัดต้องยังปัดตกได้ตามเดิม()
    {
        using var document = JsonDocument.Parse(
            """{"text":"hello store","result":[{"word":"hello","conf":0.95},{"word":"store","conf":0.40}]}""");
        var match = VoskWakeEngine.FindWakePhrase("hello store", WakePhrases.VoskPhrases)!;

        Assert.Equal(0.40, VoskWakeEngine.ScorePhrase(document.RootElement, match), 3);
    }

    [Fact]
    public void รูปทรง_result_ไม่ตรงกับประโยค_ต้องถอยไปเกณฑ์เดิมที่เข้มกว่า()
    {
        // โมเดลคนละรุ่นอาจไม่ส่งคำครบ — ห้ามเดา ให้ใช้คำที่แย่ที่สุดทั้งก้อนแทน
        using var document = JsonDocument.Parse(
            """{"text":"[unk] hello store","result":[{"word":"hello","conf":0.95}]}""");
        var match = VoskWakeEngine.FindWakePhrase("[unk] hello store", WakePhrases.VoskPhrases)!;

        Assert.Equal(0.95, VoskWakeEngine.ScorePhrase(document.RootElement, match), 3);
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
