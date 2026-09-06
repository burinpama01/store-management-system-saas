using System.Diagnostics;
using System.Speech.Recognition;

using StoreOS.Voice;

namespace StoreOS.VoiceSpike;

public sealed record WavResult(string File, string Kind, string Label, string? PhraseId, double Confidence, string? Error);

public sealed record HandoffRound(int Round, double NativeReleaseMs, double WebAcquireMs, double NativeReacquireMs, string Status, string? Error);

/// <summary>
/// เครื่องมือวัดสองอย่างของ W0: ยิงไฟล์เสียงเข้า engine เพื่อวัด recall/false wake
/// และสลับเจ้าของไมค์ระหว่าง native กับ "เว็บ" (จำลองด้วย engine ตัวที่สอง)
///
/// ไวยากรณ์คำปลุกอยู่ที่ StoreOS.Voice — ตัวจริงบนเครื่องร้านกับเครื่องมือวัดต้องใช้ชุดเดียวกัน
/// </summary>
public sealed class WakeRecognizer
{
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
                WakeGrammar.Load(engine, out _);
                engine.SetInputToWaveFile(item.File);

                var result = engine.Recognize(TimeSpan.FromSeconds(3));
                if (result is null)
                {
                    results.Add(new WavResult(item.File, item.Kind, item.Label, null, 0, null));
                    continue;
                }

                var phraseId = WakeGrammar.PhraseIdForText(result.Text);
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
        WakeGrammar.Load(native, out _);
        WakeGrammar.Load(web, out _);

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
