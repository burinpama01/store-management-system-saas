namespace StoreOS.VoiceSpike;

/// <summary>ผลตัดสินว่าจะปลุกหรือไม่ปลุก — เก็บเหตุผลไว้เสมอเพื่อให้ debug ได้จาก log อย่างเดียว</summary>
public enum WakeVerdict
{
    /// <summary>ปลุก: ส่ง wake.detected แล้วส่งไมค์ต่อให้เว็บ</summary>
    Accepted,
    /// <summary>ความมั่นใจต่ำกว่าเกณฑ์ — engine ได้ยินคล้าย ๆ แต่ไม่พอ</summary>
    RejectedLowConfidence,
    /// <summary>เพิ่งปลุกไปเมื่อกี้ ยังอยู่ในช่วงพัก (กันปลุกรัวจากเสียงสะท้อน/ลำโพงร้าน)</summary>
    RejectedCooldown,
    /// <summary>กำลังมี session ฟังคำสั่งอยู่ — ห้ามปลุกซ้อน ไม่งั้นไมค์ชนกัน</summary>
    RejectedSessionActive,
}

public sealed record WakeEvaluation(WakeVerdict Verdict, string PhraseId, double Confidence)
{
    public bool ShouldWake => Verdict == WakeVerdict.Accepted;
}

/// <summary>
/// ตรรกะตัดสินคำปลุก — แยกออกจาก System.Speech ทั้งหมดเพื่อให้ทดสอบได้โดยไม่ต้องมีไมค์
///
/// ค่าเริ่มต้นมาจากเกณฑ์ในแผน v1: false wake ต้องต่ำพอที่ร้านจะไม่ปิดฟีเจอร์ทิ้ง
/// จึงตั้ง threshold ค่อนข้างสูงไว้ก่อน แล้วค่อยลดลงเมื่อมีข้อมูลจากร้านจริง
/// </summary>
public sealed class WakeDecider
{
    public const double DefaultMinConfidence = 0.72;
    public const int DefaultCooldownMs = 3000;

    private readonly double _minConfidence;
    private readonly int _cooldownMs;
    private long? _lastAcceptedAtMs;

    public WakeDecider(double minConfidence = DefaultMinConfidence, int cooldownMs = DefaultCooldownMs)
    {
        if (minConfidence is < 0 or > 1) throw new ArgumentOutOfRangeException(nameof(minConfidence));
        if (cooldownMs < 0) throw new ArgumentOutOfRangeException(nameof(cooldownMs));
        _minConfidence = minConfidence;
        _cooldownMs = cooldownMs;
    }

    public double MinConfidence => _minConfidence;

    /// <param name="nowMs">นาฬิกาเดินหน้า (monotonic) หน่วยมิลลิวินาที — ส่งเข้ามาเพื่อให้เทสต์คุมเวลาได้</param>
    /// <param name="sessionActive">เว็บกำลังถือไมค์ฟังคำสั่งอยู่หรือไม่</param>
    public WakeEvaluation Evaluate(string phraseId, double confidence, long nowMs, bool sessionActive)
    {
        if (sessionActive)
            return new WakeEvaluation(WakeVerdict.RejectedSessionActive, phraseId, confidence);

        if (confidence < _minConfidence)
            return new WakeEvaluation(WakeVerdict.RejectedLowConfidence, phraseId, confidence);

        if (_lastAcceptedAtMs is { } last && nowMs - last < _cooldownMs)
            return new WakeEvaluation(WakeVerdict.RejectedCooldown, phraseId, confidence);

        _lastAcceptedAtMs = nowMs;
        return new WakeEvaluation(WakeVerdict.Accepted, phraseId, confidence);
    }

    /// <summary>เรียกเมื่อ session จบ เพื่อให้ปลุกครั้งถัดไปไม่ต้องรอ cooldown ซ้ำซ้อน</summary>
    public void NotifySessionEnded(long nowMs) => _lastAcceptedAtMs = nowMs;
}
