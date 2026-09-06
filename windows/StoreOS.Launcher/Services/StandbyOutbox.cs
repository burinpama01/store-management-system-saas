namespace StoreOS.Launcher.Services;

/// <summary>
/// ทางออกของข้อความ native → web (คำปลุก/สถานะไมโครโฟน)
///
/// ทำไมต้องแยกออกมาเป็นคลาสของตัวเอง: <b>CoreWebView2 เรียกได้จากเธรด UI เท่านั้น</b>
/// แต่คำปลุกถูกตรวจพบบน "เธรดของการ์ดเสียง" (NAudio เรียก callback เองจากเธรดนั้น)
/// การเรียก PostWebMessageAsJson ตรง ๆ จากที่นั่นจึงโยน InvalidOperationException ทุกครั้ง
///
/// อาการที่เกิดขึ้นจริงบนเครื่อง: log บอกว่า "ได้ยินคำปลุก hello_storeos (1.00)"
/// ตามด้วย voice_bridge_post_failed แล้ว watchdog คืนไมค์เพราะเว็บไม่เคยตอบ —
/// สำหรับคนหน้าร้านคือ "ปลุกไม่ติด" ทั้งที่ระบบได้ยินถูกต้องทุกครั้ง
///
/// ข้อผิดพลาดนี้มองไม่เห็นด้วยการอ่านโค้ด เพราะจุดที่ผิดคือ "เธรดที่เรียก" ไม่ใช่ตัวคำสั่ง
/// จึงบังคับให้ทุกทางออกวิ่งผ่าน dispatch เสมอ และมีเทสต์ยืนยันว่าไม่มีทางลัด
/// </summary>
public sealed class StandbyOutbox
{
    private readonly Action<Action> _dispatch;
    private readonly Action<string> _postJson;
    private readonly Action<string, string, string> _log;

    /// <param name="dispatch">พาไปทำงานบนเธรด UI (WPF: Dispatcher.InvokeAsync)</param>
    /// <param name="postJson">ส่ง JSON เข้าหน้าเว็บ — ถูกเรียกบนเธรด UI เท่านั้น</param>
    public StandbyOutbox(
        Action<Action> dispatch,
        Action<string> postJson,
        Action<string, string, string> log)
    {
        _dispatch = dispatch;
        _postJson = postJson;
        _log = log;
    }

    /// <summary>ปิดสายชั่วคราว (หน้าเว็บถูกพาไปโดเมนอื่น / กำลังปิดโปรแกรม)</summary>
    public bool Enabled { get; set; } = true;

    public void Send(string json)
    {
        if (!Enabled) return;

        // ต้องไม่บล็อกเธรดเสียง: ถ้ารอเธรด UI ตรงนี้ การอัดเสียงจะสะดุดทั้งเส้น
        _dispatch(() =>
        {
            if (!Enabled) return;
            try
            {
                _postJson(json);
            }
            catch (Exception ex)
            {
                // ส่งไม่ได้ (หน้าเว็บกำลังโหลด/ถูกปิด) ต้องไม่ทำให้ Launcher ล้ม
                _log("warn", "voice_bridge_post_failed", $"ส่งข้อความให้หน้าเว็บไม่สำเร็จ: {ex.GetType().Name}");
            }
        });
    }
}
