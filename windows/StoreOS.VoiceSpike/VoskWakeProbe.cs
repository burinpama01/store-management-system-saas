using System.Text.Json;

using NAudio.Wave;

using StoreOS.Voice;

using Vosk;

namespace StoreOS.VoiceSpike;

/// <summary>
/// ทดลองใช้ Vosk เป็นตัวจับคำปลุกแทน System.Speech (แผน v1 W2 "engine gate")
///
/// ทำไมต้องเปลี่ยน engine: วัดในห้องจริงแล้ว System.Speech + ไวยากรณ์จำกัดคำ
/// ปลุกผิด 14–20 ครั้งต่อ 4 นาทีโดยไม่มีใครพูดคำปลุกเลย และการขันเกณฑ์/กรองคะแนน
/// ไม่ช่วย เพราะเสียงที่ถูกมโนได้คะแนนสูงพอ ๆ กับของจริง (ดู artifacts/voice-standby-w0/)
///
/// ทำไมเลือก Vosk: Apache-2.0, ทำงานออฟไลน์ล้วน, ไม่ต้องใช้ key หรือบริการคลาวด์
/// และรองรับ "[unk]" ในไวยากรณ์ ซึ่งเป็นแบบจำลองเสียงนอกรายการที่ System.Speech ไม่มี
/// (Porcupine แม่นกว่าแต่ต้องมี AccessKey ของ Picovoice และมีค่าไลเซนส์เชิงพาณิชย์)
/// </summary>
public sealed class VoskWakeProbe : IDisposable
{
    private readonly Model _model;
    private readonly VoskRecognizer _recognizer;
    private readonly List<string> _phrases;

    public VoskWakeProbe(string modelPath, IEnumerable<string> phrases)
    {
        Vosk.Vosk.SetLogLevel(-1); // เงียบ log ของไลบรารี
        _model = new Model(modelPath);
        _phrases = phrases.Select(p => p.ToLowerInvariant()).ToList();

        // ไวยากรณ์แบบจำกัดคำ + "[unk]" — ตัวสุดท้ายคือที่ให้เสียงนอกรายการไป "ลง"
        // ซึ่งเป็นชิ้นที่ System.Speech ไม่มีและทำให้มันมโนคำปลุกจากเสียงทั่วไป
        var grammar = JsonSerializer.Serialize(_phrases.Append("[unk]").ToArray());
        _recognizer = new VoskRecognizer(_model, 16000.0f, grammar);
        _recognizer.SetWords(true);
    }

    public sealed record Detection(string Text, double Confidence, bool IsWakePhrase);

    /// <summary>ป้อนเสียงเข้าไปหนึ่งก้อน — คืนผลเมื่อ Vosk ตัดประโยคจบ</summary>
    public Detection? Feed(byte[] buffer, int count)
    {
        if (!_recognizer.AcceptWaveform(buffer, count)) return null;

        var json = _recognizer.Result();
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        var text = root.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
        if (text.Length == 0) return null;

        // ความมั่นใจ = ค่าต่ำสุดของคำในประโยค (เหมือนกติกาที่ใช้กับ engine เดิม)
        double confidence = 1;
        if (root.TryGetProperty("result", out var words) && words.ValueKind == JsonValueKind.Array)
        {
            foreach (var word in words.EnumerateArray())
            {
                if (word.TryGetProperty("conf", out var conf)) confidence = Math.Min(confidence, conf.GetDouble());
            }
        }

        return new Detection(text, Math.Round(confidence, 3), ContainsWakePhrase(text));
    }

    /// <summary>
    /// ถือว่าเป็นคำปลุกเมื่อ "ได้ยินวลีนั้นครบเป็นลำดับคำ" ในประโยคที่ถอดได้
    ///
    /// ไม่บังคับให้ทั้งประโยคตรงเป๊ะ เพราะคำที่ไม่อยู่ในพจนานุกรมของโมเดล (เช่น "โอเอส")
    /// จะถูกถอดเป็น [unk] เสมอ — ผลจริงที่วัดได้คือ "hello store [unk]"
    /// การเทียบทั้งประโยคจึงพลาดทุกครั้งทั้งที่ได้ยินคำปลุกถูกต้อง
    /// </summary>
    private bool ContainsWakePhrase(string text)
    {
        var words = text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        foreach (var phrase in _phrases)
        {
            var target = phrase.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            for (var start = 0; start + target.Length <= words.Length; start++)
            {
                var match = true;
                for (var i = 0; i < target.Length && match; i++)
                {
                    if (!string.Equals(words[start + i], target[i], StringComparison.OrdinalIgnoreCase)) match = false;
                }
                if (match) return true;
            }
        }
        return false;
    }

    /// <summary>ฟังไมโครโฟนจริงตามเวลาที่กำหนด แล้วคืนทุกอย่างที่ได้ยิน</summary>
    public static List<object> ListenToMicrophone(string modelPath, IEnumerable<string> phrases, int seconds)
    {
        var detections = new List<object>();
        using var probe = new VoskWakeProbe(modelPath, phrases);

        // Vosk ต้องการ PCM 16-bit mono 16kHz — ตั้งให้ตรงตั้งแต่ต้นทาง ไม่ต้องแปลงทีหลัง
        using var capture = new WaveInEvent { WaveFormat = new WaveFormat(16000, 16, 1), BufferMilliseconds = 100 };
        capture.DataAvailable += (_, e) =>
        {
            var detection = probe.Feed(e.Buffer, e.BytesRecorded);
            if (detection is null) return;
            detections.Add(new
            {
                at = DateTimeOffset.Now.ToString("o"),
                heard = detection.Text,
                confidence = detection.Confidence,
                isWakePhrase = detection.IsWakePhrase,
            });
        };

        capture.StartRecording();
        Thread.Sleep(TimeSpan.FromSeconds(seconds));
        capture.StopRecording();
        return detections;
    }

    /// <summary>ป้อนไฟล์เสียงเข้าไปทั้งไฟล์ (ใช้วัด recall จากชุดเสียงสังเคราะห์)</summary>
    public static Detection? RecognizeFile(string modelPath, IEnumerable<string> phrases, string wavPath)
    {
        using var probe = new VoskWakeProbe(modelPath, phrases);
        using var reader = new WaveFileReader(wavPath);

        var buffer = new byte[4096];
        Detection? last = null;
        int read;
        while ((read = reader.Read(buffer, 0, buffer.Length)) > 0)
        {
            var detection = probe.Feed(buffer, read);
            if (detection is not null) last = detection;
        }

        // เสียงหมดแล้วต้องดึงผลสุดท้ายออกมาด้วย ไม่งั้นประโยคที่ยังไม่ถูกตัดจะหายไป
        if (last is null)
        {
            using var document = JsonDocument.Parse(probe._recognizer.FinalResult());
            var text = document.RootElement.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
            if (text.Length > 0) last = new Detection(text, 1, probe.ContainsWakePhrase(text));
        }

        return last;
    }

    public void Dispose()
    {
        _recognizer.Dispose();
        _model.Dispose();
    }
}
