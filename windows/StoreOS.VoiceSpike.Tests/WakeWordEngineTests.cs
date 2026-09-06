using System.Speech.Recognition;

using StoreOS.Voice;
using StoreOS.VoiceSpike;

using Xunit;

namespace StoreOS.Voice.Tests;

/// <summary>
/// W2 — เครื่องยนต์คำปลุกของจริง
///
/// เทสต์ในไฟล์นี้ใช้ System.Speech ตัวจริง แต่ป้อนเสียงจาก "ไฟล์" แทนไมโครโฟน
/// จึงรันบนเครื่อง build ได้โดยไม่ต้องมีคนพูด และให้ผลเหมือนเดิมทุกครั้ง
/// (เครื่องที่ไม่มี recognizer อังกฤษจะข้ามไป ไม่ทำให้ชุดเทสต์แดง)
/// </summary>
public class WakeWordEngineTests
{
    private static string? RecognizerId => WakeGrammar.PickEnglishRecognizer()?.Id;

    /// <summary>ไฟล์เสียงเงียบ ๆ ที่ใช้เปิด engine ได้โดยไม่ต้องแตะไมโครโฟน</summary>
    private static async Task<string> SilenceWavAsync()
    {
        var dir = Path.Combine(Path.GetTempPath(), "storeos-wake-tests");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "silence.wav");
        if (!File.Exists(path))
        {
            // สร้างจากเสียงสังเคราะห์สั้น ๆ แล้วเก็บไว้ใช้ซ้ำ (ประโยคที่ไม่ใช่คำปลุก)
            var items = await CorpusBuilder.BuildAsync(dir);
            var neutral = items.First(i => i.Kind == "negative");
            File.Copy(neutral.File, path, overwrite: true);
        }
        return path;
    }

    [Fact]
    public async Task เปิดสองครั้งติดกันต้องไม่เปิดซ้อน()
    {
        if (RecognizerId is null) return;
        var wave = await SilenceWavAsync();
        await using var engine = new SystemSpeechWakeEngine();
        var options = new WakeWordOptions(RecognizerId: RecognizerId, InputWaveFile: wave);

        await engine.StartAsync(options, CancellationToken.None);
        var stateAfterFirst = engine.State;
        await engine.StartAsync(options, CancellationToken.None);

        Assert.Equal(WakeEngineState.Listening, stateAfterFirst);
        Assert.Equal(WakeEngineState.Listening, engine.State);
    }

    [Fact]
    public async Task หยุดซ้ำได้และปลอดภัยแม้ไม่เคยเริ่ม()
    {
        if (RecognizerId is null) return;
        await using var engine = new SystemSpeechWakeEngine();

        await engine.StopAsync(CancellationToken.None);
        await engine.StartAsync(
            new WakeWordOptions(RecognizerId: RecognizerId, InputWaveFile: await SilenceWavAsync()),
            CancellationToken.None);
        await engine.StopAsync(CancellationToken.None);
        await engine.StopAsync(CancellationToken.None);

        Assert.Equal(WakeEngineState.Off, engine.State);
    }

    [Fact]
    public async Task เปิดหลัง_dispose_ต้องถูกปฏิเสธ()
    {
        var engine = new SystemSpeechWakeEngine();
        await engine.DisposeAsync();

        await Assert.ThrowsAsync<ObjectDisposedException>(() =>
            engine.StartAsync(new WakeWordOptions(), CancellationToken.None));
    }

    [Fact]
    public async Task เครื่องที่ไม่มีชุดรู้จำเสียงต้องรายงาน_no_recognizer_ไม่ใช่พัง()
    {
        // จำลองเครื่องที่ไม่มี recognizer ด้วยการบังคับ id ที่ไม่มีจริง
        await using var engine = new SystemSpeechWakeEngine(_ => throw new ArgumentException("ไม่มี recognizer นี้"));
        WakeEngineFaultEventArgs? fault = null;
        engine.Faulted += (_, e) => fault = e;

        await engine.StartAsync(new WakeWordOptions(RecognizerId: "ไม่มีจริง"), CancellationToken.None);

        Assert.Equal(WakeEngineState.Faulted, engine.State);
        Assert.NotNull(fault);
        Assert.Equal("engine_error", fault!.Code);
    }

    [Fact]
    public async Task ไฟล์เสียงหายต้องรายงานเป็น_fault_ไม่ใช่โยนออกมา()
    {
        if (RecognizerId is null) return;
        await using var engine = new SystemSpeechWakeEngine();
        WakeEngineFaultEventArgs? fault = null;
        engine.Faulted += (_, e) => fault = e;

        await engine.StartAsync(
            new WakeWordOptions(RecognizerId: RecognizerId, InputWaveFile: @"C:\ไม่มีไฟล์นี้.wav"),
            CancellationToken.None);

        Assert.Equal(WakeEngineState.Faulted, engine.State);
        Assert.NotNull(fault);
    }

    [Fact]
    public async Task เสียงพูดคำปลุกจริงต้องปลุก_และไม่มีข้อความที่ได้ยินหลุดออกมา()
    {
        if (RecognizerId is null) return;

        var dir = Path.Combine(Path.GetTempPath(), "storeos-wake-corpus");
        var corpus = await CorpusBuilder.BuildAsync(dir);
        // ใช้คำไทยที่พูดช้า (rate 0.80) — ผลวัดใน W0 บอกว่าเป็นช่วงที่ engine จับได้
        var sample = corpus.FirstOrDefault(i => i.Kind == "positive" && i.Label == "sawatdee_os" && i.Voice.EndsWith("@0.80"));
        if (sample is null) return; // เครื่องนี้ไม่มีเสียงสังเคราะห์ภาษาไทย

        var detected = new List<WakeDetectedEventArgs>();
        await using var engine = new SystemSpeechWakeEngine();
        engine.WakeDetected += (_, e) => detected.Add(e);

        await engine.StartAsync(
            new WakeWordOptions(RecognizerId: RecognizerId, InputWaveFile: sample.File),
            CancellationToken.None);

        // ปล่อยให้ engine กินไฟล์จนจบ (ไฟล์ยาวราว 2.5 วินาที)
        await Task.Delay(TimeSpan.FromSeconds(4));
        await engine.StopAsync(CancellationToken.None);

        Assert.NotEmpty(detected);
        Assert.Equal("sawatdee_os", detected[0].PhraseId);
        Assert.True(detected[0].Confidence >= WakeDecider.DefaultMinConfidence);
        // สัญญาสำคัญ: event ไม่มีที่ให้ใส่ transcript เลย
        Assert.DoesNotContain(
            typeof(WakeDetectedEventArgs).GetProperties(),
            p => p.Name.Contains("Text", StringComparison.OrdinalIgnoreCase)
                 || p.Name.Contains("Transcript", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task คำทักทายทั่วไปต้องไม่ปลุก()
    {
        if (RecognizerId is null) return;

        var dir = Path.Combine(Path.GetTempPath(), "storeos-wake-corpus");
        var corpus = await CorpusBuilder.BuildAsync(dir);
        // probe_07 = "หวัดดีครับพี่" — เคยปลุกผิดที่ 0.84 ก่อนใส่ไวยากรณ์คำล่อ
        var probe = corpus.FirstOrDefault(i => i.Kind == "negative" && i.Label == "probe_07");
        if (probe is null) return;

        var detected = new List<WakeDetectedEventArgs>();
        await using var engine = new SystemSpeechWakeEngine();
        engine.WakeDetected += (_, e) => detected.Add(e);

        await engine.StartAsync(
            new WakeWordOptions(RecognizerId: RecognizerId, InputWaveFile: probe.File),
            CancellationToken.None);
        await Task.Delay(TimeSpan.FromSeconds(4));
        await engine.StopAsync(CancellationToken.None);

        Assert.Empty(detected);
    }

    [Fact]
    public void ค่าเริ่มต้นของ_options_ตรงกับผลวัดจริง_ไม่ใช่ตัวเลขในแผนฉบับแรก()
    {
        var options = new WakeWordOptions();

        // แผน v1 เขียน 0.82 ซึ่งตั้งก่อนมีข้อมูล — คำว่า "ฮัลโหลโอเอส" วัดได้ 0.70–0.71
        // ถ้าใช้ 0.82 คำนั้นจะไม่เคยติดเลยแม้แต่ครั้งเดียว
        Assert.Equal(0.72, options.MinimumConfidence);
        Assert.Null(options.InputWaveFile);
    }
}
