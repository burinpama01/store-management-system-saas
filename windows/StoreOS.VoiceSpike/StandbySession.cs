namespace StoreOS.VoiceSpike;

public enum StandbyState
{
    /// <summary>native ถือไมค์ ฟังเฉพาะคำปลุก</summary>
    Standby,
    /// <summary>ปลุกแล้ว ปล่อยไมค์แล้ว กำลังรอเว็บบอกว่าเริ่มฟัง</summary>
    HandingOff,
    /// <summary>เว็บถือไมค์ฟังคำสั่งอยู่</summary>
    Listening,
}

/// <summary>
/// state machine + watchdog ของรอบ standby หนึ่งรอบ (แผน v3 Task 9)
///
/// เหตุผลที่ต้องมี watchdog: ไมค์มีเจ้าของได้ทีละคน ถ้าเว็บเปิด session แล้วแท็บถูกปิด
/// เครื่องล็อก หรือ browser ปฏิเสธ user-activation เงียบ ๆ native จะรอไมค์คืนตลอดกาล
/// = คำปลุกตายทั้งเครื่องโดยไม่มี error ให้เห็น ฟีเจอร์แบบนี้พังแบบเงียบไม่ได้
///
/// กฎเวลา (ทั้งหมดต้องมากกว่าหน้าต่างฟังจริงของเว็บ ไม่งั้น watchdog จะตัดกลางประโยค):
///   * <see cref="WebMaxListeningWindowMs"/> = 6000 คือ timeout จริงที่ใช้บนเว็บ
///     (แผนเขียนไว้ 2s แต่วัดจริงได้ 1.8–3.8s จึงตั้งใช้งานที่ 6s)
///   * watchdog ต่อรอบ default 9000 และเพดานรวม multi-turn 20000
///     (Test Matrix ของแผนกำหนดเคส multi-turn 15s ต้องผ่าน)
/// </summary>
public sealed class StandbySession
{
    /// <summary>หน้าต่างฟังสูงสุดของเว็บที่ใช้จริง — ค่านี้คือเพดานล่างของ watchdog</summary>
    public const int WebMaxListeningWindowMs = 6000;
    public const int DefaultHandoffTimeoutMs = 1200;
    public const int DefaultMaxListeningWindowMs = 9000;
    public const int DefaultAbsoluteMaxMs = 20000;

    private readonly int _handoffTimeoutMs;
    private readonly int _maxListeningWindowMs;
    private readonly int _absoluteMaxMs;
    private readonly Func<string> _sessionIdFactory;

    private long _seq;
    private string _sessionId = "";
    private long _sessionStartedAtMs;
    private long _deadlineMs;

    public StandbySession(
        int handoffTimeoutMs = DefaultHandoffTimeoutMs,
        int maxListeningWindowMs = DefaultMaxListeningWindowMs,
        int absoluteMaxMs = DefaultAbsoluteMaxMs,
        Func<string>? sessionIdFactory = null)
    {
        if (maxListeningWindowMs <= WebMaxListeningWindowMs)
            throw new ArgumentOutOfRangeException(
                nameof(maxListeningWindowMs),
                maxListeningWindowMs,
                $"watchdog ต้องมากกว่าหน้าต่างฟังของเว็บ ({WebMaxListeningWindowMs}ms) ไม่งั้นจะตัดกลางประโยค");
        if (absoluteMaxMs < maxListeningWindowMs)
            throw new ArgumentOutOfRangeException(nameof(absoluteMaxMs), absoluteMaxMs, "เพดานรวมต้องไม่น้อยกว่า watchdog ต่อรอบ");
        if (handoffTimeoutMs <= 0)
            throw new ArgumentOutOfRangeException(nameof(handoffTimeoutMs));

        _handoffTimeoutMs = handoffTimeoutMs;
        _maxListeningWindowMs = maxListeningWindowMs;
        _absoluteMaxMs = absoluteMaxMs;
        _sessionIdFactory = sessionIdFactory ?? (() => Guid.NewGuid().ToString("n")[..12]);
    }

    public StandbyState State { get; private set; } = StandbyState.Standby;
    public string SessionId => _sessionId;
    /// <summary>true เมื่อไมค์ไม่ได้อยู่กับ native — ใช้กัน wake ซ้อน</summary>
    public bool MicHeldByWeb => State is StandbyState.HandingOff or StandbyState.Listening;
    /// <summary>รอบล่าสุดจบด้วยการให้ผู้ใช้กดพูดเองหรือไม่ (ตัวชี้วัดของ W0)</summary>
    public bool LastRoundFellBackToPushToTalk { get; private set; }

    /// <summary>native ตัดสินว่าปลุก — คืนข้อความที่ต้องส่งให้เว็บ</summary>
    public StandbyMessage OnWakeAccepted(string phraseId, double confidence, long nowMs, DateTimeOffset at)
    {
        if (MicHeldByWeb)
            throw new InvalidOperationException("ห้ามปลุกซ้อนระหว่างที่เว็บถือไมค์ — ต้องกรองที่ WakeDecider ก่อน");

        _sessionId = _sessionIdFactory();
        _sessionStartedAtMs = nowMs;
        _deadlineMs = nowMs + _handoffTimeoutMs;
        State = StandbyState.HandingOff;
        LastRoundFellBackToPushToTalk = false;

        return new StandbyMessage(
            StandbyContract.Version,
            StandbyContract.WakeDetected,
            ++_seq,
            _sessionId,
            at.ToString("o"),
            PhraseId: phraseId,
            Confidence: Math.Round(confidence, 2));
    }

    /// <summary>เว็บตอบว่าเริ่มฟังแล้ว</summary>
    public void OnSessionStarted(long nowMs)
    {
        if (State != StandbyState.HandingOff) return; // ข้อความมาช้าหลัง watchdog ตัดไปแล้ว — ทิ้ง
        State = StandbyState.Listening;
        _deadlineMs = Math.Min(nowMs + _maxListeningWindowMs, _sessionStartedAtMs + _absoluteMaxMs);
    }

    /// <summary>เว็บขอต่อเวลาเพราะยังคุยต่อ</summary>
    public void OnSessionExtended(long nowMs)
    {
        if (State != StandbyState.Listening) return;
        _deadlineMs = Math.Min(nowMs + _maxListeningWindowMs, _sessionStartedAtMs + _absoluteMaxMs);
    }

    /// <summary>เว็บบอกว่าจบรอบแล้ว คืนไมค์</summary>
    public void OnSessionEnded(long nowMs)
    {
        State = StandbyState.Standby;
        _deadlineMs = 0;
    }

    /// <summary>
    /// เดินนาฬิกา — คืนข้อความที่ต้องส่งเมื่อ watchdog ตัด, คืน null เมื่อยังไม่ถึงกำหนด
    /// ผู้เรียกต้องเปิดไมค์ native กลับคืนทันทีที่ได้ข้อความจากเมธอดนี้
    /// </summary>
    public StandbyMessage? Tick(long nowMs, DateTimeOffset at)
    {
        if (State == StandbyState.Standby || nowMs < _deadlineMs) return null;

        var reason = State == StandbyState.HandingOff ? "user_activation_missing" : "watchdog_timeout";
        var type = State == StandbyState.HandingOff ? StandbyContract.WakeFallback : StandbyContract.SessionEnded;

        State = StandbyState.Standby;
        _deadlineMs = 0;
        LastRoundFellBackToPushToTalk = true;

        return new StandbyMessage(
            StandbyContract.Version,
            type,
            ++_seq,
            _sessionId,
            at.ToString("o"),
            Reason: reason);
    }
}
