namespace StoreOS.Voice;

/// <summary>
/// คำปลุกหนึ่งคำ พร้อมวิธีที่จะให้ recognizer ภาษาอังกฤษ "ได้ยิน" คำไทย
///
/// ข้อเท็จจริงที่บังคับดีไซน์นี้ (วัดจากเครื่องจริง 2026-09-06):
/// Windows ไม่มี recognizer ภาษาไทยเลย ทั้ง System.Speech และ OneCore/WinRT
/// รองรับแค่ en-US / en-GB เท่านั้น ดังนั้นคำปลุกภาษาไทยต้องถูกอธิบายให้ engine
/// ภาษาอังกฤษฟังด้วยสองทาง:
///   1. <see cref="SpokenForms"/> — สะกดเป็นคำอังกฤษที่ออกเสียงใกล้เคียง (engine
///      มี lexicon ของมันเอง วิธีนี้ทนกว่าเวลาเจอสำเนียงต่างคน)
///   2. <see cref="Pronunciation"/> — ชุดหน่วยเสียง SAPI ของ en-US ที่บังคับเสียงตรง ๆ
/// ใส่ทั้งสองทางเป็นทางเลือกในไวยากรณ์เดียวกัน เพื่อให้ recall สูงที่สุดเท่าที่ engine ทำได้
/// </summary>
/// <param name="Id">รหัสสั้นสำหรับอ้างในรายงาน/telemetry — ห้ามใช้ข้อความไทยเป็นคีย์</param>
/// <param name="Display">คำที่ผู้ใช้เห็นในคู่มือและหน้าตั้งค่า</param>
/// <param name="Language">ภาษาที่คนพูดจริง (ไม่ใช่ภาษาของ recognizer)</param>
/// <param name="SpokenForms">รูปสะกดอังกฤษที่ให้ engine เดาเสียงเอง</param>
/// <param name="Pronunciations">
/// การออกเสียงแต่ละแบบ = ลำดับของ "คำ" (SAPI en-US)
///
/// เคยลองยุบเป็น token เดียวและลองแยกเป็นหลายคำ วัดในห้องจริงทั้งสองแบบแล้ว
/// ทั้งคู่ปลุกผิดสูงพอ ๆ กัน (14 กับ 20 ครั้งต่อ 4 นาที) — ปัจจัยชี้ขาดไม่ใช่โครงสร้าง token
/// แต่เป็น "ความยาวและความเฉพาะตัวของคำปลุก" (ดู artifacts/voice-standby-w0/)
/// </param>
public sealed record WakePhrase(
    string Id,
    string Display,
    string Language,
    IReadOnlyList<string> SpokenForms,
    IReadOnlyList<IReadOnlyList<string>> Pronunciations);

/// <summary>ชุดคำปลุกที่เจ้าของโปรเจกต์เลือกไว้ (6 ก.ย. 2026)</summary>
public static class WakePhrases
{
    /// <summary>
    /// ห้ามเพิ่มคำที่สั้นกว่า 3 พยางค์ — คำสั้นทำให้ false wake พุ่งในร้านที่มีเสียงคุย
    /// ทุกคำในชุดนี้ลงท้ายด้วย "โอเอส" (ow eh s) ซึ่งเป็นส่วนที่แยกจากคำพูดทั่วไปได้ดีที่สุด
    /// </summary>
    public static IReadOnlyList<WakePhrase> All { get; } = new List<WakePhrase>
    {
        new(
            Id: "hello_os",
            Display: "Hello OS",
            Language: "en",
            SpokenForms: new[] { "hello oh es", "hello o s", "hallo oh es", "hello oh ay es" },
            Pronunciations: new IReadOnlyList<string>[]
            {
                new[] { "h eh l ow", "ow eh s" },
                new[] { "h eh l ow", "ow ey eh s" },
            }),
        new(
            Id: "hanlo_os",
            Display: "ฮัลโหลโอเอส",
            Language: "th",
            SpokenForms: new[] { "han lo oh es", "hun lo oh es", "hallo oh es", "han lo oh ay es" },
            Pronunciations: new IReadOnlyList<string>[]
            {
                new[] { "h ah l ow", "ow eh s" },
                new[] { "h ah l ow", "ow ey eh s" },
                new[] { "h ah n l ow", "ow ey eh s" },
            }),
        new(
            Id: "helo_os",
            Display: "เฮลโหลโอเอส",
            Language: "th",
            SpokenForms: new[] { "hey lo oh es", "hel lo oh es", "hey lo oh ay es" },
            Pronunciations: new IReadOnlyList<string>[]
            {
                new[] { "h ey l ow", "ow eh s" },
                new[] { "h ey l ow", "ow ey eh s" },
            }),
        new(
            Id: "watdee_os",
            Display: "หวัดดีโอเอส",
            Language: "th",
            SpokenForms: new[] { "wat dee oh es", "what dee oh es", "wat dee oh ay es" },
            Pronunciations: new IReadOnlyList<string>[]
            {
                new[] { "w ah t d iy", "ow eh s" },
                new[] { "w ah t d iy", "ow ey eh s" },
            }),
        new(
            Id: "sawatdee_os",
            Display: "สวัสดีโอเอส",
            Language: "th",
            SpokenForms: new[] { "sa wat dee oh es", "sawa dee oh es", "sa wat dee oh ay es" },
            Pronunciations: new IReadOnlyList<string>[]
            {
                new[] { "s ah w ah t d iy", "ow eh s" },
                new[] { "s ah w ah t d iy", "ow ey eh s" },
                new[] { "s ax w ah t d iy", "ow ey eh s" },
            }),
    };

    /// <summary>
    /// ประโยคที่พนักงานพูดกันจริงหน้าร้าน ใช้เป็นชุดลบ (negative set) วัด false wake
    /// เลือกจากคำสั่งเสียงที่ระบบรองรับอยู่แล้ว + ประโยคคุยทั่วไปที่มีเสียงใกล้ "โอเอส"
    /// </summary>
    public static IReadOnlyList<string> FalseWakeProbes { get; } = new[]
    {
        "เพิ่มกาแฟเย็นสองแก้ว",
        "เช็คบิลโต๊ะห้า",
        "ยกเลิกรายการล่าสุด",
        "ชำระเงินสด",
        "เปิดโต๊ะสาม",
        "ขอน้ำเปล่าหนึ่งขวด",
        "สวัสดีค่ะ รับอะไรดีคะ",
        "หวัดดีครับพี่",
        "ฮัลโหล ได้ยินไหม",
        "โอเคครับ เดี๋ยวจัดให้",
    };

    /// <summary>
    /// "คำล่อ" — คำทักทายไทยที่ไม่ได้ตั้งใจปลุก แต่เสียงใกล้คำปลุกมาก
    ///
    /// หมายเหตุ: เคยมี "ha lo"/"hallo" อยู่ในรายการนี้ แต่ถอดออกเพราะมันแย่งกับคำปลุก
    /// "ฮัลโหลโอเอส"/"เฮลโหลโอเอส" โดยตรง (วัดแล้วทำให้สองคำนั้นจับไม่ได้เลย)
    /// งานกันเสียงทั่วไปเป็นหน้าที่ของกฎ GARBAGE ไม่ใช่ของรายการที่เขียนมือ
    ///
    /// ใส่ไว้เป็นไวยากรณ์คู่แข่งในเครื่องเดียวกัน เพื่อให้ engine มีที่ให้เสียงเหล่านี้ "ลง"
    /// แทนที่จะถูกบีบให้เลือกคำปลุกที่ใกล้ที่สุด — เป็นวิธีมาตรฐานในการลด false wake
    /// โดยไม่ต้องดันเกณฑ์ความมั่นใจขึ้นจนคำปลุกจริงหลุด
    /// ค่าที่ตรงกับกฎนี้ต้องไม่ปลุก (PhraseIdForText จะคืน null)
    /// </summary>
    public static IReadOnlyList<string> DecoyForms { get; } = new[]
    {
        "wat dee krap",
        "wat dee ka",
        "sa wat dee krap",
        "sa wat dee ka",
        "sa wat dee",
        "oh kay krap",
        "oh kay ka",
    };

    public static WakePhrase ById(string id) =>
        All.FirstOrDefault(p => p.Id == id)
        ?? throw new ArgumentOutOfRangeException(nameof(id), id, "ไม่รู้จักคำปลุกนี้");
}
