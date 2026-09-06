using System.Speech.Recognition;
using System.Text.Json;

using StoreOS.Voice;
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
        "vosk-listen" => VoskListen(),
        "vosk-recognize" => await VoskRecognizeAsync(),
        "chatter" => await BuildChatterAsync(),
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
    var recognizers = WakeGrammar.InstalledRecognizers();
    var chosen = WakeGrammar.PickEnglishRecognizer();

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
        pronunciationOk = WakeGrammar.Load(engine, out pronunciationError);
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
    var chosen = WakeGrammar.PickEnglishRecognizer()
        ?? throw new InvalidOperationException("เครื่องนี้ไม่มี recognizer ภาษาอังกฤษ — W0 ตกตั้งแต่ข้อแรก");

    var dir = CorpusDir();
    var longSet = ArgValue("--phrases") == "long";
    var items = longSet
        ? await CorpusBuilder.BuildLongPhraseCorpusAsync(dir)
        : await CorpusBuilder.BuildAsync(dir);
    var results = WakeRecognizer.RecognizeCorpus(chosen.Id, items, longSet);

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
    var chosen = WakeGrammar.PickEnglishRecognizer()
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

async Task<object> BuildChatterAsync()
{
    var path = await CorpusBuilder.BuildChatterAsync(CorpusDir(), ArgInt("--repeats", 3));
    return new { checkedAt = DateTimeOffset.Now.ToString("o"), file = path };
}

string VoskModelPath() =>
    ArgValue("--model")
    ?? Path.Combine(Path.GetTempPath(), "claude", "D--Store-management-system-saas",
                    "ce760d78-4317-431e-bd0c-906277a94cd3", "scratchpad", "vosk", "vosk-model-small-en-us-0.15");

/// <summary>คำปลุกที่ทดสอบกับ Vosk — ต้องเป็นคำที่มีอยู่ในพจนานุกรมของโมเดล</summary>
string[] VoskPhrases() => (ArgValue("--phrases") ?? "hello store os").Split('|');

object VoskListen()
{
    var seconds = ArgInt("--seconds", 60);
    var phrases = VoskPhrases();
    Console.WriteLine($"Vosk: ฟัง {seconds} วินาที (คำปลุก: {string.Join(", ", phrases)})");
    var detections = VoskWakeProbe.ListenToMicrophone(VoskModelPath(), phrases, seconds);

    return new
    {
        checkedAt = DateTimeOffset.Now.ToString("o"),
        engine = "vosk",
        model = Path.GetFileName(VoskModelPath()),
        phrases,
        listenedSeconds = seconds,
        detections,
    };
}

async Task<object> VoskRecognizeAsync()
{
    var phrases = VoskPhrases();
    var dir = CorpusDir();
    var items = ArgValue("--corpus-set") == "long"
        ? await CorpusBuilder.BuildLongPhraseCorpusAsync(dir)
        : await CorpusBuilder.BuildAsync(dir);

    var results = items.Select(item =>
    {
        var detection = VoskWakeProbe.RecognizeFile(VoskModelPath(), phrases, item.File);
        return new
        {
            file = Path.GetFileName(item.File),
            kind = item.Kind,
            label = item.Label,
            heard = detection?.Text ?? "",
            confidence = detection?.Confidence ?? 0,
            isWakePhrase = detection?.IsWakePhrase ?? false,
        };
    }).ToList();

    return new
    {
        checkedAt = DateTimeOffset.Now.ToString("o"),
        engine = "vosk",
        phrases,
        positives = results.Count(r => r.kind == "positive"),
        positiveHits = results.Count(r => r.kind == "positive" && r.isWakePhrase),
        negatives = results.Count(r => r.kind == "negative"),
        falseWakes = results.Count(r => r.kind == "negative" && r.isWakePhrase),
        results,
    };
}

object Listen()
{
    var chosen = WakeGrammar.PickEnglishRecognizer()
        ?? throw new InvalidOperationException("เครื่องนี้ไม่มี recognizer ภาษาอังกฤษ");

    var seconds = ArgInt("--seconds", 60);
    var detections = new List<object>();
    var decider = new WakeDecider();
    var session = new StandbySession();
    var started = DateTimeOffset.Now;
    var clock = System.Diagnostics.Stopwatch.StartNew();

    // --phrases long = วัดชุดคำปลุกทดลอง (ยาวขึ้น) แทนชุดปัจจุบัน
    var useLongPhrases = ArgValue("--phrases") == "long";
    using var engine = new SpeechRecognitionEngine(chosen.Id);
    if (useLongPhrases) ExperimentalPhrases.Load(engine);
    else WakeGrammar.Load(engine, out _);
    engine.SetInputToDefaultAudioDevice();

    engine.SpeechRecognized += (_, e) =>
    {
        // ต้องเป็นคำปลุกจริงเท่านั้น — ของเดิมยัด "unknown" เข้าไปแล้วนับเป็นปลุกด้วย
        // ทำให้ตัวเลขที่วัดได้สูงเกินจริง (ตัวจริงใน SystemSpeechWakeEngine ทิ้งไปถูกแล้ว)
        var phraseId = useLongPhrases
            ? ExperimentalPhrases.PhraseIdForText(e.Result.Text)
            : WakeGrammar.PhraseIdForText(e.Result.Text);
        var weakest = e.Result.Words.Count > 0 ? e.Result.Words.Min(w => w.Confidence) : 0;
        var verdict = phraseId is null
            ? new WakeEvaluation(WakeVerdict.RejectedLowConfidence, "not_a_wake_phrase", e.Result.Confidence)
            : weakest < WakeDecider.DefaultMinWordConfidence
                ? new WakeEvaluation(WakeVerdict.RejectedLowConfidence, "weak_word", e.Result.Confidence)
                : decider.Evaluate(phraseId, e.Result.Confidence, clock.ElapsedMilliseconds, session.MicHeldByWeb);
        // เก็บสัญญาณเพิ่มเพื่อหาเกณฑ์แยก "คำปลุกจริง" ออกจาก "เสียงคุยที่ฟังคล้าย"
        // (ค่าความมั่นใจอย่างเดียวแยกไม่ออก — ของจริงกับของปลอมทับช่วงกัน)
        var words = e.Result.Words.Select(w => Math.Round(w.Confidence, 3)).ToArray();
        detections.Add(new
        {
            at = DateTimeOffset.Now.ToString("o"),
            heard = e.Result.Text,
            phraseId = phraseId ?? "(ไม่ใช่คำปลุก)",
            confidence = Math.Round(e.Result.Confidence, 3),
            durationMs = (int)(e.Result.Audio?.Duration.TotalMilliseconds ?? 0),
            wordCount = words.Length,
            minWordConfidence = words.Length > 0 ? words.Min() : 0,
            words,
            verdict = verdict.Verdict.ToString(),
        });
        if (verdict.ShouldWake && phraseId is not null)
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

    // ต้องรอ RecognizeCompleted ก่อนตัด input เสมอ — บั๊กเดียวกับที่เจอตอนวัด handoff
    // ("Cannot perform this operation while the recognizer is doing recognition")
    // ถ้าไม่รอ การวัดจะพังท้ายรอบและไม่ได้ไฟล์ผลลัพธ์เลย
    using var completed = new ManualResetEventSlim(false);
    engine.RecognizeCompleted += (_, _) => completed.Set();
    engine.RecognizeAsyncCancel();
    completed.Wait(TimeSpan.FromSeconds(5));
    engine.SetInputToNull();

    return new
    {
        checkedAt = started.ToString("o"),
        recognizer = chosen,
        listenedSeconds = seconds,
        phraseSet = useLongPhrases ? "long-experimental" : "current",
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
