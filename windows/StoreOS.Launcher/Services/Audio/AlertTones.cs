namespace StoreOS.Launcher.Services.Audio;

/// <summary>ชื่อเสียงที่หน้าเว็บขอเล่นได้ — ต้องตรงกับ AlertPattern ใน src/shared/notifications/alert-sound.ts</summary>
public static class AlertSoundIds
{
    public const string Order = "order";
    public const string Qr = "qr";
    public const string Connect = "connect";

    public static bool IsKnown(string? id) => id is Order or Qr or Connect;
}

/// <summary>
/// beep สองแบบเดิมของหน้าเว็บ (qr = สูงสามจังหวะไล่ขึ้น, connect = ต่ำสองจังหวะ) สังเคราะห์เป็น sample
/// ความถี่/จังหวะเดียวกับ playAlertChime ฝั่งเว็บ เพื่อให้ร้านได้ยินเสียงเดิมไม่ว่าเล่นจากที่ไหน
/// </summary>
public static class AlertTones
{
    private static readonly (double At, double Freq)[] QrNotes = [(0, 880), (0.16, 1040), (0.32, 1245)];
    private static readonly (double At, double Freq)[] ConnectNotes = [(0, 620), (0.26, 780)];
    private const double NoteSeconds = 0.2;
    private const float Peak = 0.32f;

    /// <summary>คืน sample mono แบบ float (−1..1); ชื่อที่ไม่รู้จัก = เงียบ (อาร์เรย์ว่าง)</summary>
    public static float[] Render(string sound, int sampleRate)
    {
        var notes = sound switch
        {
            AlertSoundIds.Qr => QrNotes,
            AlertSoundIds.Connect => ConnectNotes,
            _ => [],
        };
        if (notes.Length == 0) return [];

        var totalSeconds = notes.Max(n => n.At) + NoteSeconds + 0.02;
        var samples = new float[(int)(totalSeconds * sampleRate)];
        foreach (var (at, freq) in notes)
        {
            var start = (int)(at * sampleRate);
            var length = (int)(NoteSeconds * sampleRate);
            for (var i = 0; i < length && start + i < samples.Length; i++)
            {
                var t = (double)i / sampleRate;
                // ramp เข้า 20ms / ออกแบบ exponential เหมือนฝั่งเว็บ — กันเสียงป๊อกตอนตัด
                var attack = Math.Min(1.0, t / 0.02);
                var release = Math.Exp(-6.0 * t / NoteSeconds);
                var value = (float)(Math.Sin(2 * Math.PI * freq * t) * Peak * attack * release);
                samples[start + i] += value;
            }
        }
        return samples;
    }
}
