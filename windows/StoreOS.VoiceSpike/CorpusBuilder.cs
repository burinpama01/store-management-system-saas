using StoreOS.Voice;
using Windows.Media.SpeechSynthesis;
using Windows.Storage.Streams;

namespace StoreOS.VoiceSpike;

public sealed record CorpusItem(string File, string Kind, string Label, string Text, string Voice);

/// <summary>
/// สร้างชุดเสียงทดสอบด้วยเสียงสังเคราะห์ของ Windows
///
/// ทำไมถึงใช้ TTS แทนคนพูด: W0 ต้องตอบว่า "recognizer ภาษาอังกฤษจับคำปลุกไทยได้ไหม"
/// ถ้ารอคนพูดจะได้ผลช้าและทำซ้ำไม่ได้ ส่วนเสียง Pattara (th-TH) ที่ติดมากับ Windows 11
/// ออกเสียงภาษาไทยจริง จึงใช้เป็นด่านแรกได้ว่า "เสียงไทยจริงผ่านไวยากรณ์อังกฤษหรือไม่"
///
/// ข้อจำกัดที่ต้องเขียนไว้ในรายงานเสมอ: เสียงสังเคราะห์ไม่มีเสียงรบกวนร้าน ไม่มีสำเนียงหลากหลาย
/// และไม่มีระยะห่างจากไมค์ ผลที่ได้จึงเป็น "เพดานบน" ไม่ใช่ตัวเลขที่ร้านจะเจอจริง
/// </summary>
public static class CorpusBuilder
{
    private static readonly double[] SpeakingRates = [0.80, 0.85, 0.90, 0.95, 1.0, 1.2];

    public static async Task<IReadOnlyList<CorpusItem>> BuildAsync(string outputDir)
    {
        Directory.CreateDirectory(outputDir);
        var items = new List<CorpusItem>();

        var voices = SpeechSynthesizer.AllVoices;
        var thaiVoice = voices.FirstOrDefault(v => v.Language.StartsWith("th", StringComparison.OrdinalIgnoreCase));
        var englishVoices = voices.Where(v => v.Language.StartsWith("en", StringComparison.OrdinalIgnoreCase)).Take(2).ToList();

        foreach (var phrase in WakePhrases.All)
        {
            // คำปลุกภาษาไทยต้องออกเสียงด้วยเสียงไทย ไม่งั้นเท่ากับทดสอบภาษาอังกฤษซ้ำ
            var speakers = phrase.Language == "th"
                ? (thaiVoice is null ? new List<VoiceInformation>() : new List<VoiceInformation> { thaiVoice })
                : englishVoices;

            foreach (var voice in speakers)
            {
                // เปลี่ยนความเร็วพูดเพื่อให้มีตัวอย่างมากกว่าหนึ่งต่อคำ — คนพูดเร็วช้าไม่เท่ากัน
                // และ engine ไวต่อความเร็วมากกว่าที่คิด
                foreach (var rate in SpeakingRates)
                {
                    var file = Path.Combine(outputDir, $"pos_{phrase.Id}_{Sanitize(voice.DisplayName)}_{rate:0.00}.wav");
                    await SynthesizeAsync(voice, phrase.Display, file, rate);
                    items.Add(new CorpusItem(file, "positive", phrase.Id, phrase.Display, $"{voice.DisplayName}@{rate:0.00}"));
                }
            }
        }

        if (thaiVoice is not null)
        {
            var index = 0;
            foreach (var probe in WakePhrases.FalseWakeProbes)
            {
                var file = Path.Combine(outputDir, $"neg_{index:00}.wav");
                await SynthesizeAsync(thaiVoice, probe, file);
                items.Add(new CorpusItem(file, "negative", $"probe_{index:00}", probe, thaiVoice.DisplayName));
                index++;
            }
        }

        return items;
    }

    /// <summary>
    /// บทสนทนาในร้านสำหรับเปิดผ่านลำโพงตอนวัด false wake
    /// ต้องยาวพอที่จะเจอเสียงหลากหลาย ไม่ใช่ประโยคเดียวซ้ำ ๆ
    /// </summary>
    public static readonly string[] ShopChatter =
    [
        "รับอะไรดีคะ วันนี้มีโปรกาแฟเย็นซื้อสองแถมหนึ่ง",
        "เอาลาเต้ร้อนหนึ่งแก้ว หวานน้อยนะครับ",
        "โต๊ะห้าสั่งเพิ่มชาไทยสองแก้วกับครัวซองต์หนึ่งชิ้น",
        "พี่ครับ ขอน้ำเปล่าเพิ่มหน่อยได้ไหม",
        "จ่ายเงินสดหรือโอนดีคะ สแกนคิวอาร์ตรงนี้ได้เลย",
        "เดี๋ยวผมไปเอาของหลังร้านนะ รอสักครู่",
        "สวัสดีค่ะ ยินดีต้อนรับ นั่งตรงไหนก็ได้เลยค่ะ",
        "อันนี้เท่าไหร่ครับ แล้วมีขนาดใหญ่กว่านี้ไหม",
        "หวัดดีครับพี่ วันนี้คนเยอะจังเลยนะ",
        "ฮัลโหล ได้ยินไหม เดี๋ยวโทรกลับนะ",
        "ปิดร้านกี่โมงคะ พรุ่งนี้เปิดเช้าเหมือนเดิมไหม",
        "ขอบคุณมากค่ะ แล้วมาใหม่นะคะ",
    ];

    /// <summary>สร้างชุดเสียงของคำปลุกทดลอง (ชุดยาว) เพื่อวัดว่ายังจับได้จริงไหม</summary>
    public static async Task<IReadOnlyList<CorpusItem>> BuildLongPhraseCorpusAsync(string outputDir)
    {
        Directory.CreateDirectory(outputDir);
        var items = new List<CorpusItem>();

        var voices = SpeechSynthesizer.AllVoices;
        var thaiVoice = voices.FirstOrDefault(v => v.Language.StartsWith("th", StringComparison.OrdinalIgnoreCase));
        var englishVoices = voices.Where(v => v.Language.StartsWith("en", StringComparison.OrdinalIgnoreCase)).Take(2).ToList();

        foreach (var candidate in ExperimentalPhrases.Long)
        {
            var thai = candidate.Display.Any(c => c >= '฀' && c <= '๿');
            var speakers = thai
                ? (thaiVoice is null ? new List<VoiceInformation>() : [thaiVoice])
                : englishVoices;

            foreach (var voice in speakers)
            {
                foreach (var rate in SpeakingRates)
                {
                    var file = Path.Combine(outputDir, $"long_{candidate.Id}_{Sanitize(voice.DisplayName)}_{rate:0.00}.wav");
                    await SynthesizeAsync(voice, candidate.Display, file, rate);
                    items.Add(new CorpusItem(file, "positive", candidate.Id, candidate.Display, $"{voice.DisplayName}@{rate:0.00}"));
                }
            }
        }

        // ชุดลบ: ประโยคในร้านชุดเดิม
        if (thaiVoice is not null)
        {
            var index = 0;
            foreach (var probe in WakePhrases.FalseWakeProbes)
            {
                var file = Path.Combine(outputDir, $"longneg_{index:00}.wav");
                await SynthesizeAsync(thaiVoice, probe, file);
                items.Add(new CorpusItem(file, "negative", $"probe_{index:00}", probe, thaiVoice.DisplayName));
                index++;
            }
        }

        return items;
    }

    /// <summary>สร้างไฟล์เสียงบทสนทนายาวหนึ่งไฟล์ (ไทย) ไว้เปิดผ่านลำโพง</summary>
    public static async Task<string> BuildChatterAsync(string outputDir, int repeats = 3)
    {
        Directory.CreateDirectory(outputDir);
        var path = Path.Combine(outputDir, "shop-chatter.wav");

        var thaiVoice = SpeechSynthesizer.AllVoices
            .FirstOrDefault(v => v.Language.StartsWith("th", StringComparison.OrdinalIgnoreCase));
        if (thaiVoice is null) throw new InvalidOperationException("เครื่องนี้ไม่มีเสียงสังเคราะห์ภาษาไทย");

        var text = string.Join(" ", Enumerable.Repeat(string.Join(" ", ShopChatter), repeats));
        await SynthesizeAsync(thaiVoice, text, path);
        return path;
    }

    private static async Task SynthesizeAsync(VoiceInformation voice, string text, string path, double speakingRate = 1.0)
    {
        using var synth = new SpeechSynthesizer { Voice = voice };
        synth.Options.SpeakingRate = speakingRate;
        using var stream = await synth.SynthesizeTextToStreamAsync(text);

        // อ่านผ่าน DataReader เพราะ extension แปลง IRandomAccessStream เป็น Stream
        // ไม่ได้มีให้ใช้ทุกเวอร์ชันของ .NET — วิธีนี้ใช้ได้แน่นอนกว่า
        var reader = new DataReader(stream.GetInputStreamAt(0));
        await reader.LoadAsync((uint)stream.Size);
        var bytes = new byte[stream.Size];
        reader.ReadBytes(bytes);
        await File.WriteAllBytesAsync(path, PadWithSilence(bytes, SilencePadMs));
    }

    /// <summary>ความเงียบที่เติมหัวท้ายไฟล์ (มิลลิวินาที)</summary>
    public const int SilencePadMs = 300;

    /// <summary>
    /// เติมความเงียบหัว-ท้ายไฟล์เสียง
    ///
    /// ทำไมต้องมี: เสียงสังเคราะห์เริ่มพูดทันทีที่ไบต์แรก แต่ตัวตรวจจับจุดเริ่มพูด (endpointer)
    /// ของ System.Speech ต้องการความเงียบนำหน้าเพื่อตั้งฐานเสียงรบกวนก่อน ถ้าไม่เติม
    /// ผลที่ได้จะเป็น "จับไม่ได้" ทั้งที่เสียงถูกต้อง — เป็นกับดักของการวัดด้วย TTS ไม่ใช่ข้อจำกัดจริงของคำปลุก
    /// </summary>
    public static byte[] PadWithSilence(byte[] wav, int padMs)
    {
        // หา chunk "data" แบบตรงไปตรงมา; ถ้ารูปแบบไม่ใช่ RIFF ที่คาดไว้ให้คืนของเดิม
        if (padMs <= 0 || wav.Length < 44 || wav[0] != 'R' || wav[1] != 'I' || wav[2] != 'F' || wav[3] != 'F')
            return wav;

        var sampleRate = BitConverter.ToInt32(wav, 24);
        var byteRate = BitConverter.ToInt32(wav, 28);
        if (sampleRate <= 0 || byteRate <= 0) return wav;

        var dataOffset = -1;
        for (var i = 12; i < wav.Length - 8; i++)
        {
            if (wav[i] == 'd' && wav[i + 1] == 'a' && wav[i + 2] == 't' && wav[i + 3] == 'a')
            {
                dataOffset = i + 8;
                break;
            }
        }
        if (dataOffset < 0) return wav;

        var padBytes = byteRate * padMs / 1000;
        padBytes -= padBytes % 2; // ให้ลงตัวกับตัวอย่าง 16 บิต

        var header = wav[..dataOffset];
        var data = wav[dataOffset..];
        var output = new byte[header.Length + padBytes + data.Length + padBytes];
        header.CopyTo(output, 0);
        data.CopyTo(output, header.Length + padBytes);

        // แก้ขนาดใน header ให้ตรงกับข้อมูลจริง ไม่งั้นตัวอ่านบางตัวจะตัดท้ายทิ้ง
        var newDataSize = data.Length + padBytes * 2;
        BitConverter.GetBytes(newDataSize).CopyTo(output, dataOffset - 4);
        BitConverter.GetBytes(output.Length - 8).CopyTo(output, 4);
        return output;
    }

    private static string Sanitize(string value) =>
        new(value.Where(char.IsLetterOrDigit).ToArray());
}
