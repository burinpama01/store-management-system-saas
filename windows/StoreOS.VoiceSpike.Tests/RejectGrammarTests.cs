using System.Speech.Recognition;

using StoreOS.Voice;

using Xunit;

namespace StoreOS.Voice.Tests;

/// <summary>
/// กฎ "รองรับเสียงอื่น" (GARBAGE) — ชิ้นที่ทำให้เครื่องเลิกปลุกเองในที่ที่มีเสียงคน
///
/// อาการที่วัดได้จากเครื่องจริงก่อนมีกฎนี้: ฟัง 45 วินาทีโดยไม่มีใครพูดคำปลุก
/// เด้ง 3 ครั้ง สูงสุดที่ความมั่นใจ 0.975 — เพราะไวยากรณ์แบบจำกัดคำไม่มีที่ให้
/// เสียงทั่วไปลง engine จึงถูกบังคับให้เลือกคำที่ใกล้ที่สุดจากรายการคำปลุกเสมอ
/// หลังใส่กฎนี้: 60 วินาที เด้ง 0 ครั้ง (เสียงรอบข้างไปตกที่กฎนี้แทน)
/// </summary>
public class RejectGrammarTests
{
    [Fact]
    public void สร้างกฎรองรับเสียงอื่นได้()
    {
        var grammar = WakeGrammar.BuildRejectGrammar();

        Assert.NotNull(grammar);
        Assert.Equal("storeos-reject", grammar.Name);
    }

    [Fact]
    public void โหลดเข้า_engine_พร้อมกันครบสามไวยากรณ์()
    {
        var chosen = WakeGrammar.PickEnglishRecognizer();
        if (chosen is null) return; // เครื่อง build ที่ไม่มี recognizer

        using var engine = new SpeechRecognitionEngine(chosen.Id);
        WakeGrammar.Load(engine, out _);

        var names = engine.Grammars.Select(g => g.Name).ToList();
        Assert.Contains("storeos-wake", names);
        Assert.Contains("storeos-decoy", names);
        Assert.Contains("storeos-reject", names);
    }

    [Fact]
    public void สิ่งที่ตกกฎรองรับเสียงอื่นต้องไม่ถูกนับเป็นคำปลุก()
    {
        // ข้อความจากกฎนี้เป็นเสียงอะไรก็ได้ ต้องไม่ map กลับเป็นรหัสคำปลุก
        Assert.Null(WakeGrammar.PhraseIdForText("..."));
        Assert.Null(WakeGrammar.PhraseIdForText("ha lo"));
        Assert.Null(WakeGrammar.PhraseIdForText("wat dee krap"));
    }

    [Fact]
    public void คำล่อต้องไม่มีคำที่ชนกับคำปลุกเอง()
    {
        // "ha lo"/"hallo" เคยอยู่ในรายการคำล่อ แล้วแย่งกับ ฮัลโหลโอเอส/เฮลโหลโอเอส โดยตรง
        foreach (var decoy in WakePhrases.DecoyForms)
        {
            Assert.Null(WakeGrammar.PhraseIdForText(decoy));
        }
    }
}
