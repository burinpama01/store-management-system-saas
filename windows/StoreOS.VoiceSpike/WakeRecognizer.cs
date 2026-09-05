using System.Diagnostics;
using System.Globalization;
using System.Speech.Recognition;
using System.Speech.Recognition.SrgsGrammar;

namespace StoreOS.VoiceSpike;

public sealed record RecognizerInfo(string Id, string Name, string Culture);

public sealed record WavResult(string File, string Kind, string Label, string? PhraseId, double Confidence, string? Error);

public sealed record HandoffRound(int Round, double NativeReleaseMs, double WebAcquireMs, double NativeReacquireMs, string Status, string? Error);

/// <summary>
/// ห่อ System.Speech ให้ทำสามอย่างที่ W0 ต้องการ: สร้างไวยากรณ์คำปลุก, ยิงเสียงเข้าไปวัดผล,
/// และสลับเจ้าของไมค์ระหว่าง native กับ "เว็บ" (จำลองด้วย engine ตัวที่สอง)
/// </summary>
public sealed class WakeRecognizer
{
    private const string RuleName = "wake";

    public static IReadOnlyList<RecognizerInfo> Inventory() =>
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
    /// ห้ามกลืน exception เงียบ ๆ เพราะความต่างนี้เปลี่ยนผลการวัด
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
                // token ที่บังคับเสียง: text ไว้ให้อ่านออกตอน debug, pronunciation คือของจริงที่ engine ใช้
                // ใส่ทุกแบบการออกเสียงเป็นทางเลือกแยกกัน — engine เลือกอันที่ตรงที่สุดเอง
                foreach (var pronunciation in phrase.Pronunciations)
                {
                    var token = new SrgsToken(PronunciationTokenText(phrase)) { Pronunciation = pronunciation };
                    var item = new SrgsItem();
                    item.Add(token);
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

    /// <summary>ข้อความของ token ที่ผูกหน่วยเสียงไว้ — ใช้เป็นกุญแจย้อนกลับหารหัสคำปลุก</summary>
    public static string PronunciationTokenText(WakePhrase phrase) => phrase.Id.Replace('_', ' ');

    /// <summary>
    /// แปลงข้อความที่ engine ได้ยินกลับเป็นรหัสคำปลุก
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

    /// <summary>โหลดไวยากรณ์เข้า engine โดยลองแบบมีหน่วยเสียงก่อน — คืนว่าใช้แบบไหนได้จริง</summary>
    public static bool LoadWakeGrammar(SpeechRecognitionEngine engine, out string? pronunciationError)
    {
        pronunciationError = null;
        try
        {
            engine.LoadGrammar(BuildWakeGrammar(usePronunciation: true));
            engine.LoadGrammar(BuildDecoyGrammar());
            return true;
        }
        catch (Exception ex)
        {
            pronunciationError = ex.Message;
            engine.UnloadAllGrammars();
            engine.LoadGrammar(BuildWakeGrammar(usePronunciation: false));
            engine.LoadGrammar(BuildDecoyGrammar());
            return false;
        }
    }

    /// <summary>ยิงไฟล์เสียงเข้า engine ทีละไฟล์ — ใช้วัด recall ของคำปลุกและ false wake ของประโยคทั่วไป</summary>
    public static IReadOnlyList<WavResult> RecognizeCorpus(string recognizerId, IEnumerable<CorpusItem> corpus)
    {
        var results = new List<WavResult>();

        foreach (var item in corpus)
        {
            try
            {
                // engine ใหม่ต่อไฟล์: state ของ engine เดิมค้างข้ามไฟล์ได้ และเราต้องการผลที่ทำซ้ำได้
                using var engine = new SpeechRecognitionEngine(recognizerId);
                LoadWakeGrammar(engine, out _);
                engine.SetInputToWaveFile(item.File);

                var result = engine.Recognize(TimeSpan.FromSeconds(3));
                if (result is null)
                {
                    results.Add(new WavResult(item.File, item.Kind, item.Label, null, 0, null));
                    continue;
                }

                var phraseId = PhraseIdForText(result.Text);
                results.Add(new WavResult(item.File, item.Kind, item.Label, phraseId, Math.Round(result.Confidence, 3), null));
            }
            catch (Exception ex)
            {
                results.Add(new WavResult(item.File, item.Kind, item.Label, null, 0, ex.Message));
            }
        }

        return results;
    }

    /// <summary>
    /// สลับเจ้าของไมค์ native → "เว็บ" → native ตามจำนวนรอบที่สั่ง
    ///
    /// เว็บถูกจำลองด้วย SpeechRecognitionEngine ตัวที่สองที่เปิดไมค์ตัวเดียวกัน —
    /// ถ้า native ยังไม่ปล่อยไมค์จริง การเปิดของตัวที่สองจะช้าผิดปกติหรือโยน exception
    /// ซึ่งคือสิ่งที่เกณฑ์ "ไม่มี mic overlap" ต้องการจับ
    /// </summary>
    public static IReadOnlyList<HandoffRound> RunHandoffRounds(string recognizerId, int rounds)
    {
        var output = new List<HandoffRound>(rounds);

        // engine ตัวเดียวต่อฝั่ง ตลอดการทดสอบ — ตรงกับของจริงที่ native host เปิดค้างไว้
        using var native = new SpeechRecognitionEngine(recognizerId);
        using var web = new SpeechRecognitionEngine(recognizerId);
        LoadWakeGrammar(native, out _);
        LoadWakeGrammar(web, out _);

        using var nativeDone = new ManualResetEventSlim(true);
        using var webDone = new ManualResetEventSlim(true);
        native.RecognizeCompleted += (_, _) => nativeDone.Set();
        web.RecognizeCompleted += (_, _) => webDone.Set();

        for (var round = 1; round <= rounds; round++)
        {
            double releaseMs = 0, acquireMs = 0, reacquireMs = 0;
            var status = "ok";
            string? error = null;

            try
            {
                Acquire(native, nativeDone);

                var sw = Stopwatch.StartNew();
                Release(native, nativeDone);
                releaseMs = sw.Elapsed.TotalMilliseconds;

                sw.Restart();
                Acquire(web, webDone);
                acquireMs = sw.Elapsed.TotalMilliseconds;

                Release(web, webDone);

                sw.Restart();
                Acquire(native, nativeDone);
                reacquireMs = sw.Elapsed.TotalMilliseconds;

                Release(native, nativeDone);
            }
            catch (Exception ex)
            {
                status = "error";
                error = ex.Message;
                // พยายามคืนสภาพให้รอบถัดไปยังวัดได้ ไม่ปล่อยให้ error ลามทั้งชุด
                TryReset(native, nativeDone);
                TryReset(web, webDone);
            }

            output.Add(new HandoffRound(round, Math.Round(releaseMs, 2), Math.Round(acquireMs, 2), Math.Round(reacquireMs, 2), status, error));
        }

        return output;
    }

    /// <summary>เปิดไมค์และเริ่มฟัง</summary>
    private static void Acquire(SpeechRecognitionEngine engine, ManualResetEventSlim done)
    {
        engine.SetInputToDefaultAudioDevice();
        done.Reset();
        engine.RecognizeAsync(RecognizeMode.Multiple);
    }

    /// <summary>
    /// หยุดฟังแล้วคืนอุปกรณ์
    ///
    /// จุดที่พลาดง่ายและเป็นหัวใจของ Task 9: <c>RecognizeAsyncCancel()</c> เป็นงานแบบไม่รอ
    /// ถ้าเรียก <c>SetInputToNull()</c> ต่อทันทีจะได้ "Cannot perform this operation while the
    /// recognizer is doing recognition." — native host ตัวจริงต้อง "รอ RecognizeCompleted ก่อน"
    /// ถึงจะบอกได้ว่าไมค์ถูกปล่อยจริง ไม่ใช่แค่สั่งให้ปล่อย
    /// </summary>
    private static void Release(SpeechRecognitionEngine engine, ManualResetEventSlim done)
    {
        engine.RecognizeAsyncCancel();
        if (!done.Wait(TimeSpan.FromSeconds(3)))
            throw new TimeoutException("รอ RecognizeCompleted เกิน 3 วินาที — ไมค์ยังไม่ถูกปล่อย");
        engine.SetInputToNull();
    }

    private static void TryReset(SpeechRecognitionEngine engine, ManualResetEventSlim done)
    {
        try
        {
            engine.RecognizeAsyncCancel();
            done.Wait(TimeSpan.FromSeconds(3));
            engine.SetInputToNull();
        }
        catch
        {
            // ตั้งใจกลืน: นี่คือทางกู้สภาพ ไม่ใช่เส้นทางวัดผล
        }
    }
}
