using System.Diagnostics;
using System.Speech.Recognition;

namespace StoreOS.Voice;

public enum WakeEngineState
{
    Off,
    Starting,
    /// <summary>ฟังคำปลุกอยู่</summary>
    Listening,
    /// <summary>พังกลางทาง — ต้องแจ้งผู้ใช้ ไม่ใช่เงียบ</summary>
    Faulted,
}

/// <summary>
/// ได้ยินคำปลุกแล้ว
///
/// ตั้งใจไม่มี transcript และไม่มีเสียง — ตามขอบเขตความปลอดภัยของแผน
/// native บอกได้แค่ "ได้ยินคำไหน มั่นใจแค่ไหน เมื่อไร"
/// </summary>
public sealed class WakeDetectedEventArgs(string phraseId, double confidence, DateTimeOffset detectedAt) : EventArgs
{
    public string PhraseId { get; } = phraseId;
    public double Confidence { get; } = confidence;
    public DateTimeOffset DetectedAt { get; } = detectedAt;
}

public sealed class WakeEngineFaultEventArgs(string code, string message) : EventArgs
{
    /// <summary>รหัสสั้นสำหรับ log — ไม่ใช่ข้อความเต็มของ exception</summary>
    public string Code { get; } = code;
    public string Message { get; } = message;
}

/// <param name="MinimumConfidence">
/// เกณฑ์ปลุก — ค่าเริ่มต้น 0.72 มาจากผลวัดจริง (คำปลุกไทยที่แย่ที่สุดอยู่ที่ 0.70–0.71)
/// แผน v1 เขียนไว้ 0.82 ซึ่งตั้งก่อนมีข้อมูล ถ้าใช้ค่านั้นคำว่า "ฮัลโหลโอเอส" จะไม่เคยติดเลย
/// </param>
/// <param name="Cooldown">ช่วงพักหลังปลุก กันเสียงสะท้อน/ลำโพงร้านปลุกรัว</param>
/// <param name="InputWaveFile">ถ้าระบุ = อ่านจากไฟล์เสียงแทนไมโครโฟน (ใช้ทดสอบเท่านั้น)</param>
public sealed record WakeWordOptions(
    double MinimumConfidence = WakeDecider.DefaultMinConfidence,
    TimeSpan? Cooldown = null,
    string? RecognizerId = null,
    string? InputWaveFile = null);

public interface IWakeWordEngine : IAsyncDisposable
{
    WakeEngineState State { get; }
    event EventHandler<WakeDetectedEventArgs>? WakeDetected;
    event EventHandler<WakeEngineFaultEventArgs>? Faulted;
    Task StartAsync(WakeWordOptions options, CancellationToken ct);
    Task StopAsync(CancellationToken ct);
}

/// <summary>
/// เครื่องยนต์คำปลุกของจริง บน System.Speech (แผน v1 W2)
///
/// สิ่งที่ยึดตามแผนและผลวัด:
///   * ใช้ constrained grammar เท่านั้น ไม่โหลด dictation — engine จึงรู้จักแค่คำปลุกกับคำล่อ
///     และไม่มีทางถอดเสียงบทสนทนาในร้านได้แม้อยากทำ
///   * ไม่มี event ที่มี transcript; ส่งออกแค่รหัสคำปลุก + ความมั่นใจ + เวลา
///   * ปล่อยไมโครโฟนต้องรอ RecognizeCompleted ก่อนเสมอ ไม่งั้นได้
///     "Cannot perform this operation while the recognizer is doing recognition"
///     และอุปกรณ์จะยังไม่ถูกคืนจริง (บทเรียนจาก handoff 100 รอบ)
/// </summary>
public sealed class SystemSpeechWakeEngine : IWakeWordEngine
{
    private readonly Func<string?, SpeechRecognitionEngine> _factory;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Stopwatch _clock = Stopwatch.StartNew();

    private SpeechRecognitionEngine? _engine;
    private WakeDecider? _decider;
    private ManualResetEventSlim? _completed;
    private bool _disposed;

    public SystemSpeechWakeEngine(Func<string?, SpeechRecognitionEngine>? factory = null)
    {
        _factory = factory ?? (id => id is null
            ? new SpeechRecognitionEngine()
            : new SpeechRecognitionEngine(id));
    }

    public WakeEngineState State { get; private set; } = WakeEngineState.Off;
    public event EventHandler<WakeDetectedEventArgs>? WakeDetected;
    public event EventHandler<WakeEngineFaultEventArgs>? Faulted;

    /// <summary>ไวยากรณ์โหลดแบบมีหน่วยเสียงได้ไหม (false = เครื่องนี้ตกไปใช้แบบสะกดอย่างเดียว)</summary>
    public bool PronunciationGrammarLoaded { get; private set; }

    public async Task StartAsync(WakeWordOptions options, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        await _gate.WaitAsync(ct);
        try
        {
            // เรียกซ้ำระหว่างที่ฟังอยู่ = ไม่ทำอะไร (engine ตัวที่สองจะแย่งไมค์กับตัวแรก)
            if (_engine is not null) return;

            State = WakeEngineState.Starting;
            var recognizerId = options.RecognizerId ?? WakeGrammar.PickEnglishRecognizer()?.Id;
            if (recognizerId is null)
            {
                State = WakeEngineState.Faulted;
                Faulted?.Invoke(this, new WakeEngineFaultEventArgs(
                    "no_recognizer", "เครื่องนี้ไม่มีชุดรู้จำเสียงภาษาอังกฤษ"));
                return;
            }

            SpeechRecognitionEngine engine;
            try
            {
                // สร้าง engine ก็ล้มได้ (id ผิด / ชุดรู้จำเสียงถูกถอนออกระหว่างทาง)
                // ต้องจบเป็น fault เหมือนกรณีอื่น ไม่ใช่โยนออกไปให้ผู้เรียกเดาเอง
                engine = _factory(recognizerId);
            }
            catch (Exception ex)
            {
                State = WakeEngineState.Faulted;
                Faulted?.Invoke(this, new WakeEngineFaultEventArgs(FaultCode(ex), ex.Message));
                return;
            }

            var completed = new ManualResetEventSlim(true);
            try
            {
                PronunciationGrammarLoaded = WakeGrammar.Load(engine, out var pronunciationError);
                if (!PronunciationGrammarLoaded)
                {
                    // ไม่ใช่ความล้มเหลว แต่ต้องเห็นในรายงาน เพราะอัตราการจับคำไทยจะต่างไป
                    Faulted?.Invoke(this, new WakeEngineFaultEventArgs(
                        "pronunciation_fallback", pronunciationError ?? "ไวยากรณ์แบบมีหน่วยเสียงโหลดไม่ขึ้น"));
                }

                _decider = new WakeDecider(
                    options.MinimumConfidence,
                    (int)(options.Cooldown ?? TimeSpan.FromMilliseconds(WakeDecider.DefaultCooldownMs)).TotalMilliseconds);

                engine.SpeechRecognized += OnSpeechRecognized;
                engine.RecognizeCompleted += (_, _) => completed.Set();

                if (options.InputWaveFile is { } wave) engine.SetInputToWaveFile(wave);
                else engine.SetInputToDefaultAudioDevice();

                completed.Reset();
                engine.RecognizeAsync(RecognizeMode.Multiple);
            }
            catch (Exception ex)
            {
                engine.Dispose();
                completed.Dispose();
                State = WakeEngineState.Faulted;
                Faulted?.Invoke(this, new WakeEngineFaultEventArgs(FaultCode(ex), ex.Message));
                return;
            }

            _engine = engine;
            _completed = completed;
            State = WakeEngineState.Listening;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task StopAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(CancellationToken.None);
        try
        {
            if (_engine is null) return;

            var engine = _engine;
            var completed = _completed;
            _engine = null;
            _completed = null;

            try
            {
                engine.SpeechRecognized -= OnSpeechRecognized;
                engine.RecognizeAsyncCancel();
                // RecognizeAsyncCancel ไม่รอ — ต้องรออีเวนต์จบก่อน ไม่งั้น SetInputToNull โยน
                // และไมโครโฟนยังไม่ถูกคืนจริง
                completed?.Wait(TimeSpan.FromSeconds(3));
                engine.SetInputToNull();
            }
            catch (Exception ex)
            {
                Faulted?.Invoke(this, new WakeEngineFaultEventArgs(FaultCode(ex), ex.Message));
            }
            finally
            {
                engine.Dispose();
                completed?.Dispose();
                State = WakeEngineState.Off;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        await StopAsync(CancellationToken.None);
        _disposed = true;
        _gate.Dispose();
    }

    private void OnSpeechRecognized(object? sender, SpeechRecognizedEventArgs e)
    {
        var phraseId = WakeGrammar.PhraseIdForText(e.Result?.Text);
        // ตกที่กฎคำล่อหรือได้ยินอย่างอื่น = ไม่ใช่คำปลุก จบตรงนี้ ไม่ส่งอะไรออกไปเลย
        if (phraseId is null || _decider is null) return;

        var verdict = _decider.Evaluate(phraseId, e.Result!.Confidence, _clock.ElapsedMilliseconds, sessionActive: false);
        if (!verdict.ShouldWake) return;

        WakeDetected?.Invoke(this, new WakeDetectedEventArgs(
            phraseId, Math.Round(e.Result.Confidence, 2), DateTimeOffset.Now));
    }

    /// <summary>รหัสสั้นสำหรับ log — ห้ามส่งข้อความ exception ดิบไปเป็นรหัส</summary>
    private static string FaultCode(Exception ex) => ex switch
    {
        InvalidOperationException => "audio_device_busy",
        System.IO.FileNotFoundException => "audio_input_missing",
        UnauthorizedAccessException => "microphone_denied",
        _ => "engine_error",
    };
}
