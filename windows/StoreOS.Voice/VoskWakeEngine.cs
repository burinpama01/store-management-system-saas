using System.Text.Json;

using NAudio.Wave;

using Vosk;

namespace StoreOS.Voice;

/// <summary>
/// เครื่องยนต์คำปลุกที่ใช้จริงบนเครื่องร้าน — ทำงานออฟไลน์ทั้งหมด
///
/// ทำไมเปลี่ยนมาจาก System.Speech (วัดในห้องจริงชุดละ 4 นาที ไม่มีใครพูดคำปลุก):
///   System.Speech คำสั้น            ปลุกผิด 14 ครั้ง
///   System.Speech คำสั้น + กรองรายคำ ปลุกผิด 20 ครั้ง
///   System.Speech คำยาว + หน่วยเสียงไทย ปลุกผิด 10 ครั้ง
///   Vosk (ตัวนี้)                    ปลุกผิด  0 ครั้ง   จับคำจริงได้ 12/12
///
/// สาเหตุเชิงโครงสร้าง: ไวยากรณ์จำกัดคำของ System.Speech ไม่มีที่ให้เสียงนอกรายการ "ลง"
/// จึงถูกบังคับให้เลือกคำปลุกที่ใกล้ที่สุดเสมอ ส่วน Vosk มี "[unk]" ในตัว
/// เสียงคุยในร้านจึงถูกถอดเป็น [unk] แทนที่จะกลายเป็นคำปลุก
///
/// ข้อจำกัดที่ต้องรู้: โมเดลเป็นภาษาอังกฤษ คำปลุกจึงต้องเป็นคำอังกฤษ
/// (กลับเป็นข้อดีในร้านไทย เพราะบทสนทนารอบข้างเป็นไทยและถูกถอดเป็น [unk] ทั้งหมด)
/// และคำที่ไม่อยู่ในพจนานุกรมของโมเดล เช่น "โอเอส" จะเป็น [unk] เสมอ
/// จึงต้องเทียบแบบ "ได้ยินวลีครบเป็นลำดับคำ" ไม่ใช่เทียบทั้งประโยค
/// </summary>
public sealed class VoskWakeEngine : IWakeWordEngine
{
    private readonly string _modelPath;
    private readonly IReadOnlyList<string> _phrases;
    private readonly Func<IWaveIn>? _captureFactory;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private Model? _model;
    private VoskRecognizer? _recognizer;
    private IWaveIn? _capture;
    private DateTimeOffset _lastWakeAt = DateTimeOffset.MinValue;
    private TimeSpan _cooldown = TimeSpan.FromMilliseconds(WakeDecider.DefaultCooldownMs);
    private double _minConfidence = WakeDecider.DefaultMinConfidence;
    private bool _disposed;

    /// <param name="modelPath">โฟลเดอร์โมเดล Vosk (ฝังมากับชุดติดตั้ง)</param>
    /// <param name="phrases">วลีคำปลุก (ตัวพิมพ์เล็ก คำอังกฤษที่อยู่ในพจนานุกรมของโมเดล)</param>
    /// <param name="captureFactory">ฉีดตัวรับเสียงได้ในเทสต์; ไม่ส่งมาจะใช้ไมโครโฟนเริ่มต้น</param>
    public VoskWakeEngine(string modelPath, IReadOnlyList<string>? phrases = null, Func<IWaveIn>? captureFactory = null)
    {
        _modelPath = modelPath;
        _phrases = (phrases ?? WakePhrases.VoskPhrases).Select(p => p.ToLowerInvariant()).ToList();
        _captureFactory = captureFactory;
    }

    public WakeEngineState State { get; private set; } = WakeEngineState.Off;
    public event EventHandler<WakeDetectedEventArgs>? WakeDetected;
    public event EventHandler<WakeEngineFaultEventArgs>? Faulted;

    /// <summary>โมเดลอยู่ที่เดียวกับโปรแกรม — ตัวติดตั้งวางไว้ให้แล้ว</summary>
    public static string DefaultModelPath() =>
        Path.Combine(AppContext.BaseDirectory, "vosk-model");

    public static bool ModelExists(string? path = null) =>
        Directory.Exists(path ?? DefaultModelPath());

    public async Task StartAsync(WakeWordOptions options, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        await _gate.WaitAsync(ct);
        try
        {
            if (_capture is not null) return; // เปิดซ้ำระหว่างที่ฟังอยู่ = ไม่ทำอะไร

            State = WakeEngineState.Starting;
            _minConfidence = options.MinimumConfidence;
            _cooldown = options.Cooldown ?? TimeSpan.FromMilliseconds(WakeDecider.DefaultCooldownMs);

            if (!Directory.Exists(_modelPath))
            {
                State = WakeEngineState.Faulted;
                Faulted?.Invoke(this, new WakeEngineFaultEventArgs(
                    "vosk_model_missing", "ไม่พบชุดข้อมูลเสียงของโปรแกรม — ติดตั้งใหม่อีกครั้ง"));
                return;
            }

            try
            {
                Vosk.Vosk.SetLogLevel(-1); // ไลบรารีนี้พิมพ์ log ลง stdout ถ้าไม่ปิด
                _model = new Model(_modelPath);

                // "[unk]" คือหัวใจ: เป็นที่ให้เสียงนอกรายการลง แทนที่จะถูกยัดเป็นคำปลุก
                var grammar = JsonSerializer.Serialize(_phrases.Append("[unk]").ToArray());
                _recognizer = new VoskRecognizer(_model, 16000.0f, grammar);
                _recognizer.SetWords(true);

                var capture = _captureFactory?.Invoke()
                    ?? new WaveInEvent { WaveFormat = new WaveFormat(16000, 16, 1), BufferMilliseconds = 100 };
                capture.DataAvailable += OnAudio;
                capture.StartRecording();
                _capture = capture;
            }
            catch (Exception ex)
            {
                ReleaseResources();
                State = WakeEngineState.Faulted;
                Faulted?.Invoke(this, new WakeEngineFaultEventArgs(FaultCode(ex), ex.Message));
                return;
            }

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
            if (_capture is null) return;
            try
            {
                _capture.DataAvailable -= OnAudio;
                _capture.StopRecording();
            }
            catch (Exception ex)
            {
                Faulted?.Invoke(this, new WakeEngineFaultEventArgs(FaultCode(ex), ex.Message));
            }
            finally
            {
                ReleaseResources();
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

    private void OnAudio(object? sender, WaveInEventArgs e)
    {
        var recognizer = _recognizer;
        if (recognizer is null) return;

        try
        {
            if (!recognizer.AcceptWaveform(e.Buffer, e.BytesRecorded)) return;
            HandleResult(recognizer.Result());
        }
        catch (Exception ex)
        {
            // เสียงมาเป็นสายตลอด — พังหนึ่งก้อนต้องไม่ทำให้โปรแกรมล้ม
            Faulted?.Invoke(this, new WakeEngineFaultEventArgs("engine_error", ex.Message));
        }
    }

    private void HandleResult(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        var text = root.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
        if (text.Length == 0) return;

        var phrase = MatchWakePhrase(text, _phrases);
        if (phrase is null) return;

        // ความมั่นใจ = คำที่แย่ที่สุดในประโยค (คำปลุกจริงทุกคำต้องชัด)
        double confidence = 1;
        if (root.TryGetProperty("result", out var words) && words.ValueKind == JsonValueKind.Array)
        {
            foreach (var word in words.EnumerateArray())
            {
                if (word.TryGetProperty("conf", out var conf)) confidence = Math.Min(confidence, conf.GetDouble());
            }
        }
        if (confidence < _minConfidence) return;

        // พักหลังปลุก — กันเสียงสะท้อนหรือลำโพงร้านปลุกซ้ำทันที
        var now = DateTimeOffset.Now;
        if (now - _lastWakeAt < _cooldown) return;
        _lastWakeAt = now;

        WakeDetected?.Invoke(this, new WakeDetectedEventArgs(
            WakePhrases.VoskPhraseId(phrase), Math.Round(confidence, 2), now));
    }

    /// <summary>
    /// หาว่าประโยคที่ถอดได้มีวลีคำปลุกครบเป็นลำดับคำหรือไม่
    ///
    /// ไม่เทียบทั้งประโยคเพราะคำนอกพจนานุกรมจะกลายเป็น [unk] เสมอ
    /// ("Hello StoreOS" ถอดได้เป็น "hello store [unk]" ทุกครั้งที่วัด)
    /// </summary>
    public static string? MatchWakePhrase(string text, IReadOnlyList<string> phrases)
    {
        var words = text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        foreach (var phrase in phrases)
        {
            var target = phrase.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (target.Length == 0) continue;

            for (var start = 0; start + target.Length <= words.Length; start++)
            {
                var match = true;
                for (var i = 0; i < target.Length && match; i++)
                {
                    if (!string.Equals(words[start + i], target[i], StringComparison.OrdinalIgnoreCase)) match = false;
                }
                if (match) return phrase;
            }
        }
        return null;
    }

    private void ReleaseResources()
    {
        (_capture as IDisposable)?.Dispose();
        _capture = null;
        _recognizer?.Dispose();
        _recognizer = null;
        _model?.Dispose();
        _model = null;
    }

    private static string FaultCode(Exception ex) => ex switch
    {
        DirectoryNotFoundException or FileNotFoundException => "vosk_model_missing",
        InvalidOperationException => "audio_device_busy",
        UnauthorizedAccessException => "microphone_denied",
        _ => "engine_error",
    };
}
