using System.Speech.Recognition;
using System.Text.Json;

using StoreOS.VoiceSpike;

// CLI ของ spike — ทุกคำสั่งจบด้วยการเขียน JSON หนึ่งไฟล์เพื่อแนบเป็นหลักฐาน W0
//   inventory              : recognizer/ไมค์/เสียงสังเคราะห์ที่มีบนเครื่องนี้
//   corpus                 : สร้างไฟล์เสียงทดสอบ (ไทยด้วยเสียง Pattara, อังกฤษด้วย David/Zira)
//   recognize              : corpus + ยิงเข้า recognizer วัด recall และ false wake
//   handoff --rounds 100   : สลับเจ้าของไมค์ native ↔ เว็บ ตามจำนวนรอบ
//   listen --seconds 60    : โหมดให้คนพูดจริงหน้าร้าน (ต้องมีคนกดและพูด)

var command = args.FirstOrDefault() ?? "inventory";
var outPath = ArgValue("--out") ?? Path.Combine(Environment.CurrentDirectory, $"voice-spike-{command}.json");
var jsonOptions = new JsonSerializerOptions { WriteIndented = true };

try
{
    object report = command switch
    {
        "inventory" => Inventory(),
        "corpus" => await BuildCorpusAsync(),
        "recognize" => await RecognizeAsync(),
        "handoff" => Handoff(),
        "listen" => Listen(),
        _ => throw new ArgumentException($"ไม่รู้จักคำสั่ง '{command}'"),
    };

    var json = JsonSerializer.Serialize(report, jsonOptions);
    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
    await File.WriteAllTextAsync(outPath, json);
    Console.WriteLine(json);
    Console.WriteLine($"\nเขียนผลลง: {outPath}");
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"ล้มเหลว: {ex.Message}");
    return 1;
}

string? ArgValue(string name)
{
    var index = Array.IndexOf(args, name);
    return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
}

int ArgInt(string name, int fallback) =>
    int.TryParse(ArgValue(name), out var parsed) ? parsed : fallback;

string CorpusDir() => ArgValue("--corpus") ?? Path.Combine(Path.GetTempPath(), "storeos-wake-corpus");

object Inventory()
{
    var recognizers = WakeRecognizer.Inventory();
    var chosen = WakeRecognizer.PickEnglishRecognizer();

    var micOk = false;
    string? micError = null;
    try
    {
        using var probe = new SpeechRecognitionEngine();
        probe.SetInputToDefaultAudioDevice();
        probe.SetInputToNull();
        micOk = true;
    }
    catch (Exception ex)
    {
        micError = ex.Message;
    }

    var pronunciationOk = true;
    string? pronunciationError = null;
    if (chosen is not null)
    {
        using var engine = new SpeechRecognitionEngine(chosen.Id);
        pronunciationOk = WakeRecognizer.LoadWakeGrammar(engine, out pronunciationError);
    }

    return new
    {
        checkedAt = DateTimeOffset.Now.ToString("o"),
        os = Environment.OSVersion.VersionString,
        machine = Environment.MachineName,
        recognizers,
        chosenRecognizer = chosen,
        microphoneUsable = micOk,
        microphoneError = micError,
        wakePhrases = WakePhrases.All.Select(p => new { p.Id, p.Display, p.Language, p.Pronunciations }),
        pronunciationGrammarLoaded = pronunciationOk,
        pronunciationGrammarError = pronunciationError,
    };
}

async Task<object> BuildCorpusAsync()
{
    var dir = CorpusDir();
    var items = await CorpusBuilder.BuildAsync(dir);
    return new { checkedAt = DateTimeOffset.Now.ToString("o"), dir, count = items.Count, items };
}

async Task<object> RecognizeAsync()
{
    var chosen = WakeRecognizer.PickEnglishRecognizer()
        ?? throw new InvalidOperationException("เครื่องนี้ไม่มี recognizer ภาษาอังกฤษ — W0 ตกตั้งแต่ข้อแรก");

    var dir = CorpusDir();
    var items = await CorpusBuilder.BuildAsync(dir);
    var results = WakeRecognizer.RecognizeCorpus(chosen.Id, items);

    var positives = results.Where(r => r.Kind == "positive").ToList();
    var negatives = results.Where(r => r.Kind == "negative").ToList();

    // "จับได้" = ต้องได้รหัสคำปลุกตรงตัว ไม่ใช่แค่ engine ได้ยินอะไรสักอย่าง
    var hits = positives.Count(r => r.PhraseId == r.Label);
    var falseWakes = negatives.Count(r => r.PhraseId is not null && r.Confidence >= WakeDecider.DefaultMinConfidence);

    return new
    {
        checkedAt = DateTimeOffset.Now.ToString("o"),
        recognizer = chosen,
        minConfidence = WakeDecider.DefaultMinConfidence,
        positiveCount = positives.Count,
        positiveHits = hits,
        positiveHitsAtThreshold = positives.Count(r => r.PhraseId == r.Label && r.Confidence >= WakeDecider.DefaultMinConfidence),
        negativeCount = negatives.Count,
        falseWakesAtThreshold = falseWakes,
        perPhrase = positives
            .GroupBy(r => r.Label)
            .Select(g => new
            {
                phraseId = g.Key,
                attempts = g.Count(),
                hits = g.Count(r => r.PhraseId == g.Key),
                bestConfidence = g.Max(r => r.Confidence),
            }),
        results,
    };
}

object Handoff()
{
    var chosen = WakeRecognizer.PickEnglishRecognizer()
        ?? throw new InvalidOperationException("เครื่องนี้ไม่มี recognizer ภาษาอังกฤษ");

    var rounds = ArgInt("--rounds", 100);
    var measured = WakeRecognizer.RunHandoffRounds(chosen.Id, rounds);
    var ok = measured.Where(r => r.Status == "ok").ToList();

    return new
    {
        checkedAt = DateTimeOffset.Now.ToString("o"),
        recognizer = chosen,
        rounds,
        okRounds = ok.Count,
        errorRounds = measured.Count - ok.Count,
        releaseMsP95 = Percentile(ok.Select(r => r.NativeReleaseMs).ToList(), 0.95),
        webAcquireMsP95 = Percentile(ok.Select(r => r.WebAcquireMs).ToList(), 0.95),
        reacquireMsP95 = Percentile(ok.Select(r => r.NativeReacquireMs).ToList(), 0.95),
        firstErrors = measured.Where(r => r.Status != "ok").Take(5),
        rounds_detail = measured,
    };
}

object Listen()
{
    var chosen = WakeRecognizer.PickEnglishRecognizer()
        ?? throw new InvalidOperationException("เครื่องนี้ไม่มี recognizer ภาษาอังกฤษ");

    var seconds = ArgInt("--seconds", 60);
    var detections = new List<object>();
    var decider = new WakeDecider();
    var session = new StandbySession();
    var started = DateTimeOffset.Now;
    var clock = System.Diagnostics.Stopwatch.StartNew();

    using var engine = new SpeechRecognitionEngine(chosen.Id);
    WakeRecognizer.LoadWakeGrammar(engine, out _);
    engine.SetInputToDefaultAudioDevice();

    engine.SpeechRecognized += (_, e) =>
    {
        var phraseId = WakeRecognizer.PhraseIdForText(e.Result.Text) ?? "unknown";
        var verdict = decider.Evaluate(phraseId, e.Result.Confidence, clock.ElapsedMilliseconds, session.MicHeldByWeb);
        detections.Add(new
        {
            at = DateTimeOffset.Now.ToString("o"),
            heard = e.Result.Text,
            phraseId,
            confidence = Math.Round(e.Result.Confidence, 3),
            verdict = verdict.Verdict.ToString(),
        });
        if (verdict.ShouldWake)
        {
            var message = session.OnWakeAccepted(phraseId, e.Result.Confidence, clock.ElapsedMilliseconds, DateTimeOffset.Now);
            Console.WriteLine($"WAKE → {StandbyContract.Serialize(message)}");
            // ในโหมดนี้ไม่มีเว็บจริงมารับ ปล่อยให้ watchdog ตัดเองเพื่อพิสูจน์ fallback
        }
    };

    Console.WriteLine($"พูดคำปลุกใส่ไมค์ได้เลย — ฟัง {seconds} วินาที (Ctrl+C เพื่อหยุดก่อน)");
    engine.RecognizeAsync(RecognizeMode.Multiple);

    var deadline = DateTime.UtcNow.AddSeconds(seconds);
    var fallbacks = 0;
    while (DateTime.UtcNow < deadline)
    {
        Thread.Sleep(100);
        var timeout = session.Tick(clock.ElapsedMilliseconds, DateTimeOffset.Now);
        if (timeout is not null)
        {
            fallbacks++;
            Console.WriteLine($"WATCHDOG → {StandbyContract.Serialize(timeout)}");
        }
    }

    engine.RecognizeAsyncCancel();
    engine.SetInputToNull();

    return new
    {
        checkedAt = started.ToString("o"),
        recognizer = chosen,
        listenedSeconds = seconds,
        detections,
        watchdogFallbacks = fallbacks,
    };
}

static double Percentile(List<double> values, double percentile)
{
    if (values.Count == 0) return 0;
    var sorted = values.OrderBy(v => v).ToList();
    var index = (int)Math.Ceiling(percentile * sorted.Count) - 1;
    return Math.Round(sorted[Math.Clamp(index, 0, sorted.Count - 1)], 2);
}
