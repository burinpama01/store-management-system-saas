using System.Globalization;
using System.Speech.Recognition;
using System.Speech.Recognition.SrgsGrammar;

namespace StoreOS.Voice;

public sealed record RecognizerInfo(string Id, string Name, string Culture);

/// <summary>
/// ไวยากรณ์คำปลุก — ส่วนที่ทั้งเครื่องมือวัดและตัวจริงบนเครื่องร้านต้องใช้ให้ตรงกัน
/// ถ้าสองที่ใช้ไวยากรณ์คนละชุด ตัวเลขที่วัดมาจะไม่ได้บอกอะไรเกี่ยวกับของจริงเลย
/// </summary>
public static class WakeGrammar
{
    private const string RuleName = "wake";

    public static IReadOnlyList<RecognizerInfo> InstalledRecognizers() =>
        SpeechRecognitionEngine.InstalledRecognizers()
            .Select(r => new RecognizerInfo(r.Id, r.Name, r.Culture.Name))
            .ToList();

    /// <summary>เลือก recognizer อังกฤษที่ดีที่สุดบนเครื่อง — คืน null ถ้าเครื่องนี้ใช้ไม่ได้เลย</summary>
    public static RecognizerInfo? PickEnglishRecognizer()
    {
        var installed = SpeechRecognitionEngine.InstalledRecognizers().ToList();
        var chosen = installed.FirstOrDefault(r => r.Culture.Name == "en-US")
                     ?? installed.FirstOrDefault(r => r.Culture.TwoLetterISOLanguageName == "en");
        return chosen is null ? null : new RecognizerInfo(chosen.Id, chosen.Name, chosen.Culture.Name);
    }

    /// <summary>
    /// สร้างไวยากรณ์คำปลุก: หนึ่งกฎ หนึ่ง one-of ที่มีทั้งรูปสะกดอังกฤษและหน่วยเสียง SAPI
    ///
    /// <paramref name="usePronunciation"/> เผื่อไว้เพราะบางเครื่อง engine ไม่รับชุดหน่วยเสียง
    /// (โยน exception ตอนโหลด) ผู้เรียกต้องลอง true ก่อน แล้ว fallback เป็น false และ "บันทึกว่า fallback"
    /// ห้ามกลืน exception เงียบ ๆ เพราะความต่างนี้เปลี่ยนผลการวัดและอัตราการจับคำปลุกจริง
    /// </summary>
    public static Grammar BuildWakeGrammar(bool usePronunciation = true)
    {
        var alternatives = new SrgsOneOf();

        foreach (var phrase in WakePhrases.All)
        {
            foreach (var spoken in phrase.SpokenForms)
            {
                alternatives.Add(new SrgsItem(spoken));
            }

            if (usePronunciation)
            {
                // ใส่ทุกแบบการออกเสียงเป็นทางเลือกแยกกัน — engine เลือกอันที่ตรงที่สุดเอง
                foreach (var pronunciation in phrase.Pronunciations)
                {
                    // หนึ่ง token ต่อหนึ่งคำ — ไม่ยัดทั้งวลีเป็น token เดียว
                    // เพื่อให้ engine ให้คะแนนรายคำ แล้วเรากรองด้วยคำที่แย่ที่สุดได้
                    var item = new SrgsItem();
                    var texts = PronunciationTokenText(phrase).Split(' ');
                    for (var i = 0; i < pronunciation.Count; i++)
                    {
                        var text = i < texts.Length ? texts[i] : $"{phrase.Id}{i}";
                        item.Add(new SrgsToken(text) { Pronunciation = pronunciation[i] });
                    }
                    alternatives.Add(item);
                }
            }
        }

        var rule = new SrgsRule(RuleName);
        rule.Add(alternatives);

        // ต้องบอกว่าใช้ชุดหน่วยเสียงของ SAPI ไม่งั้น System.Speech จะตีความเป็น UPS
        // แล้วโยน "Invalid phoneme" ทั้งไวยากรณ์ (พังเงียบทั้งฟีเจอร์ถ้าไม่ดัก)
        var document = new SrgsDocument
        {
            Culture = new CultureInfo("en-US"),
            PhoneticAlphabet = SrgsPhoneticAlphabet.Sapi,
        };
        document.Rules.Add(rule);
        document.Root = rule;

        return new Grammar(document) { Name = "storeos-wake" };
    }

    /// <summary>
    /// ไวยากรณ์ "คำล่อ" — คำทักทายที่ต้องไม่ปลุก โหลดคู่กับไวยากรณ์คำปลุกเสมอ
    ///
    /// วัดแล้วว่าลด false wake จาก 1/10 เหลือ 0/10 โดยคำปลุกจริงยังจับได้เท่าเดิม
    /// (ถ้าแก้ด้วยการดันเกณฑ์ความมั่นใจแทน คำปลุกไทยที่อยู่ราว 0.70 จะหลุดทันที)
    /// </summary>
    public static Grammar BuildDecoyGrammar()
    {
        var alternatives = new SrgsOneOf();
        foreach (var decoy in WakePhrases.DecoyForms)
        {
            alternatives.Add(new SrgsItem(decoy));
        }

        var rule = new SrgsRule("decoy");
        rule.Add(alternatives);

        var document = new SrgsDocument { Culture = new CultureInfo("en-US") };
        document.Rules.Add(rule);
        document.Root = rule;

        return new Grammar(document) { Name = "storeos-decoy" };
    }

    /// <summary>
    /// ไวยากรณ์ "ที่รองรับเสียงอื่น" — กฎเดียวที่ยอมรับอะไรก็ได้ (GARBAGE ของ SAPI)
    ///
    /// นี่คือชิ้นที่ขาดไปและทำให้เครื่องปลุกเองรัว ๆ ในที่ที่มีเสียงคน:
    /// ไวยากรณ์แบบจำกัดคำไม่มีที่ให้เสียงทั่วไปลง engine จึงถูกบังคับให้เลือก
    /// "คำที่ใกล้ที่สุด" จากรายการคำปลุกเสมอ แม้เสียงนั้นจะไม่ใกล้อะไรเลย
    /// (วัดได้จริง: ฟัง 45 วินาทีโดยไม่มีใครพูด เด้ง 3 ครั้ง สูงสุด 0.975)
    ///
    /// พอมีกฎนี้แข่งอยู่ เสียงที่ไม่ใช่คำปลุกจะไปตกที่กฎนี้แทน
    /// </summary>
    public static Grammar BuildRejectGrammar()
    {
        // SrgsRule.Add รับเฉพาะ SrgsElement — ห่อ ruleref ไว้ใน item ก่อน
        var item = new SrgsItem();
        item.Add(SrgsRuleRef.Garbage);
        var rule = new SrgsRule("reject");
        rule.Add(item);

        var document = new SrgsDocument { Culture = new CultureInfo("en-US") };
        document.Rules.Add(rule);
        document.Root = rule;

        return new Grammar(document) { Name = "storeos-reject" };
    }

    /// <summary>ข้อความของ token ที่ผูกหน่วยเสียงไว้ — ใช้เป็นกุญแจย้อนกลับหารหัสคำปลุก</summary>
    public static string PronunciationTokenText(WakePhrase phrase) => phrase.Id.Replace('_', ' ');

    /// <summary>
    /// แปลงข้อความที่ engine ได้ยินกลับเป็นรหัสคำปลุก — คืน null เมื่อไม่ใช่คำปลุก (เช่นตกที่กฎคำล่อ)
    ///
    /// ไม่ใช้ semantic tag ของ SRGS เพราะ System.Speech รุ่นที่ .NET 8 ใช้ไม่รองรับรูปแบบ
    /// key-value ที่ต้องการ — ตารางค้นหาตรง ๆ อ่านง่ายกว่าและทดสอบได้โดยไม่ต้องมี engine
    /// </summary>
    public static string? PhraseIdForText(string? recognizedText)
    {
        if (string.IsNullOrWhiteSpace(recognizedText)) return null;
        var key = recognizedText.Trim().ToLowerInvariant();

        foreach (var phrase in WakePhrases.All)
        {
            if (key == PronunciationTokenText(phrase)) return phrase.Id;
            if (phrase.SpokenForms.Any(form => string.Equals(form, key, StringComparison.OrdinalIgnoreCase)))
                return phrase.Id;
        }

        return null;
    }

    /// <summary>โหลดไวยากรณ์คำปลุก + คำล่อเข้า engine — คืนว่าใช้แบบมีหน่วยเสียงได้จริงหรือไม่</summary>
    public static bool Load(SpeechRecognitionEngine engine, out string? pronunciationError)
    {
        pronunciationError = null;
        try
        {
            engine.LoadGrammar(BuildWakeGrammar(usePronunciation: true));
            engine.LoadGrammar(BuildDecoyGrammar());
            engine.LoadGrammar(BuildRejectGrammar());
            return true;
        }
        catch (Exception ex)
        {
            pronunciationError = ex.Message;
            engine.UnloadAllGrammars();
            engine.LoadGrammar(BuildWakeGrammar(usePronunciation: false));
            engine.LoadGrammar(BuildDecoyGrammar());
            engine.LoadGrammar(BuildRejectGrammar());
            return false;
        }
    }
}
