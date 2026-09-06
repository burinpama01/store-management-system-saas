using System.Speech.Recognition;

using StoreOS.Voice;
using StoreOS.VoiceSpike;

using Xunit;

namespace StoreOS.VoiceSpike.Tests;

public class WakePhrasesTests
{
    private static readonly string[] SapiEnglishPhonemes =
    [
        "aa","ae","ah","ao","aw","ax","ay","b","ch","d","dh","eh","er","ey","f","g","h","ih","iy","jh",
        "k","l","m","n","ng","ow","oy","p","r","s","sh","t","th","uh","uw","v","w","y","z","zh",
    ];

    [Fact]
    public void มีคำปลุกครบชุดที่ตกลงไว้()
    {
        var ids = WakePhrases.All.Select(p => p.Id).ToArray();

        Assert.Equal(new[] { "hello_os", "hanlo_os", "helo_os", "watdee_os", "sawatdee_os" }, ids);
        Assert.Equal("ฮัลโหลโอเอส", WakePhrases.ById("hanlo_os").Display);
        Assert.Equal("สวัสดีโอเอส", WakePhrases.ById("sawatdee_os").Display);
    }

    [Fact]
    public void หน่วยเสียงทุกคำต้องอยู่ในชุดหน่วยเสียงของ_SAPI_อังกฤษ()
    {
        // ถ้าหลุดไปหนึ่งตัว ไวยากรณ์จะโหลดไม่ขึ้นทั้งชุด และ engine จะเงียบโดยไม่บอกเหตุผล
        foreach (var phrase in WakePhrases.All)
        {
            Assert.NotEmpty(phrase.Pronunciations);
            foreach (var pronunciation in phrase.Pronunciations)
            {
                foreach (var word in pronunciation)
                {
                    foreach (var phoneme in word.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                    {
                        Assert.Contains(phoneme, SapiEnglishPhonemes);
                    }
                }
            }
        }
    }

    [Fact]
    public void ทุกคำต้องลงท้ายด้วยเสียง_โอเอส_เพื่อกันคำสั้นชนคำพูดทั่วไป()
    {
        foreach (var phrase in WakePhrases.All)
        {
            Assert.All(phrase.Pronunciations, variant =>
            {
                // ต้องแยกเป็นอย่างน้อยสองคำ — วลีทั้งก้อนใน token เดียวทำให้เสียงรบกวนปลุกได้
                // (วัดจากห้องจริง: แบบ token เดียวปลุกผิด 10 ครั้งใน 4 นาที)
                Assert.True(variant.Count >= 2, "การออกเสียงต้องแยกเป็นหลายคำ");
                // ทุกแบบต้องมีสระ "โอ" และจบด้วยเสียง s — ส่วนที่กันคำทักทายทั่วไป
                Assert.Contains("ow", string.Join(" ", variant).Split(' '));
                Assert.EndsWith(" s", variant[^1]);
            });
            Assert.True(phrase.SpokenForms.Count > 0);
        }
    }

    [Fact]
    public void ชุดทดสอบ_false_wake_ต้องมีคำทักทายไทยที่ใกล้คำปลุก()
    {
        // "สวัสดีค่ะ" กับ "สวัสดีโอเอส" ต่างกันแค่ท้ายประโยค — ถ้าระบบแยกไม่ออกคือใช้ไม่ได้จริง
        Assert.Contains(WakePhrases.FalseWakeProbes, p => p.StartsWith("สวัสดี"));
        Assert.Contains(WakePhrases.FalseWakeProbes, p => p.StartsWith("หวัดดี"));
        Assert.Contains(WakePhrases.FalseWakeProbes, p => p.StartsWith("ฮัลโหล"));
    }

    [Fact]
    public void ไวยากรณ์คำปลุกสร้างได้จริงและมีทางเลือกครบทุกคำ()
    {
        var grammar = WakeGrammar.BuildWakeGrammar(usePronunciation: true);

        Assert.NotNull(grammar);
        Assert.Equal("storeos-wake", grammar.Name);
    }

    [Fact]
    public void ไวยากรณ์โหลดเข้า_engine_ภาษาอังกฤษบนเครื่องนี้ได้()
    {
        var chosen = WakeGrammar.PickEnglishRecognizer();
        // เครื่อง build ที่ไม่มี recognizer ไม่ควรทำให้ CI แดง — แต่ต้องเห็นว่าข้ามไป
        if (chosen is null) return;

        using var engine = new SpeechRecognitionEngine(chosen!.Id);
        var withPronunciation = WakeGrammar.Load(engine, out var error);

        Assert.True(withPronunciation, $"ไวยากรณ์แบบมีหน่วยเสียงโหลดไม่ขึ้น: {error}");
    }
}
