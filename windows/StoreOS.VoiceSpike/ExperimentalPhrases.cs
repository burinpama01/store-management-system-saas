using System.Globalization;
using System.Speech.Recognition;
using System.Speech.Recognition.SrgsGrammar;

using StoreOS.Voice;

namespace StoreOS.VoiceSpike;

/// <summary>
/// ชุดคำปลุก "ทดลอง" สำหรับหาคำที่ทนเสียงร้านได้จริง — อยู่ในเครื่องมือวัดเท่านั้น
/// ไม่ใช่ของที่ส่งไปเครื่องร้าน จนกว่าจะมีตัวเลขยืนยันว่าดีกว่าชุดปัจจุบัน
///
/// หมายเหตุ: ชื่อ rule ห้ามมีขีดกลาง (SRGS ไม่รับ) — เจอตอนรันจริงว่า "rule ID not valid"
/// เหตุผลที่ต้องทดลอง: ชุดปัจจุบันลงท้ายด้วย "โอเอส" ซึ่งสั้นและเป็นเสียงสามัญ
/// วัดในห้องจริง 4 นาทีโดยไม่มีใครพูดคำปลุก ได้ปลุกผิด 14–20 ครั้ง
/// สมมติฐาน: คำที่ยาวขึ้นและมีพยางค์เฉพาะตัว ("สโตร์โอเอส") จะถูกมโนยากกว่ามาก
/// </summary>
public static class ExperimentalPhrases
{
    public sealed record Candidate(
        string Id,
        string Display,
        IReadOnlyList<string> SpokenForms,
        IReadOnlyList<IReadOnlyList<string>>? Pronunciations = null);

    /// <summary>คำยาวขึ้น — เติม "สโตร์/store" เข้าไปให้มีพยางค์ที่ไม่ค่อยโผล่ในบทสนทนา</summary>
    public static IReadOnlyList<Candidate> Long { get; } =
    [
        new("hello_storeos", "Hello StoreOS", ["hello store os", "hello store o s"]),
        // คำไทยต้องมีหน่วยเสียงกำกับ ไม่งั้นเสียงไทยจริงไม่ตรงกับรูปสะกดอังกฤษเลย (วัดแล้วได้ 0/6)
        new("sawatdee_storeos", "สวัสดีสโตร์โอเอส", ["sa wat dee store os", "sa wat dee sa tor os"],
            [["s ah w ah t d iy", "s t ao r", "ow eh s"], ["s ah w ah t d iy", "s ah t ao", "ow ey eh s"]]),
        new("watdee_storeos", "หวัดดีสโตร์โอเอส", ["wat dee store os", "what dee store os"],
            [["w ah t d iy", "s t ao r", "ow eh s"], ["w ah t d iy", "s ah t ao", "ow ey eh s"]]),
        new("hanlo_storeos", "ฮัลโหลสโตร์โอเอส", ["han lo store os", "hun lo store os"],
            [["h ah l ow", "s t ao r", "ow eh s"], ["h ah l ow", "s ah t ao", "ow ey eh s"]]),
    ];

    public static Grammar BuildGrammar()
    {
        var alternatives = new SrgsOneOf();
        foreach (var candidate in Long)
        {
            foreach (var spoken in candidate.SpokenForms)
            {
                alternatives.Add(new SrgsItem(spoken));
            }

            foreach (var variant in candidate.Pronunciations ?? [])
            {
                var item = new SrgsItem();
                var texts = candidate.SpokenForms[0].Split(' ');
                for (var i = 0; i < variant.Count; i++)
                {
                    // ข้อความของ token ต้องรวมกันแล้วตรงกับรูปสะกดแบบแรก เพื่อให้ map กลับเป็นรหัสได้
                    var text = i < texts.Length ? texts[i] : $"w{i}";
                    item.Add(new SrgsToken(text) { Pronunciation = variant[i] });
                }
                alternatives.Add(item);
            }
        }

        var rule = new SrgsRule("wakeLong");
        rule.Add(alternatives);

        var document = new SrgsDocument
        {
            Culture = new CultureInfo("en-US"),
            PhoneticAlphabet = SrgsPhoneticAlphabet.Sapi,
        };
        document.Rules.Add(rule);
        document.Root = rule;

        return new Grammar(document) { Name = "storeos-wake-long" };
    }

    public static string? PhraseIdForText(string? recognizedText)
    {
        if (string.IsNullOrWhiteSpace(recognizedText)) return null;
        var key = recognizedText.Trim().ToLowerInvariant();
        foreach (var candidate in Long)
        {
            if (candidate.SpokenForms.Any(f => string.Equals(f, key, StringComparison.OrdinalIgnoreCase))) return candidate.Id;
            // token ที่ผูกหน่วยเสียงใช้ข้อความของรูปสะกดแบบแรก แต่ตัดเหลือเท่าจำนวน token
            var head = string.Join(" ", candidate.SpokenForms[0].Split(' ').Take(3));
            if (string.Equals(head, key, StringComparison.OrdinalIgnoreCase)) return candidate.Id;
        }
        return null;
    }

    /// <summary>โหลดชุดทดลอง + กฎรองรับเสียงอื่น (ไม่โหลดชุดปัจจุบัน เพื่อวัดแยกกัน)</summary>
    public static void Load(SpeechRecognitionEngine engine)
    {
        engine.LoadGrammar(BuildGrammar());
        engine.LoadGrammar(WakeGrammar.BuildRejectGrammar());
    }
}
