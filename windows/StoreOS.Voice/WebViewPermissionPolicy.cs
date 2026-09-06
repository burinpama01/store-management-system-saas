namespace StoreOS.Voice;

/// <summary>สิ่งที่หน้าเว็บขอจาก WebView2 (ชื่อตรงกับ CoreWebView2PermissionKind)</summary>
public enum WebPermission
{
    Unknown,
    Microphone,
    Camera,
    Geolocation,
    Notifications,
    OtherSensors,
    ClipboardRead,
}

public enum WebPermissionDecision
{
    Allow,
    Deny,
}

/// <summary>
/// ตัดสินว่าหน้าเว็บใน Launcher ขออะไรได้บ้าง
///
/// ทำไมต้องตัดสินเอง แทนที่จะปล่อยให้ WebView2 ถามผู้ใช้:
///   * Launcher เปิดเต็มจอเป็นเครื่องขาย พนักงานหน้าร้านไม่ใช่คนที่จะตัดสินใจเรื่อง
///     "อนุญาตให้เว็บใช้ไมโครโฟนไหม" ได้อย่างมีข้อมูล และถ้ากดผิดครั้งเดียว
///     คำสั่งเสียงจะใช้ไม่ได้ทั้งเครื่องโดยไม่มีใครรู้ว่าเพราะอะไร
///   * เจ้าของร้านเป็นคนติดตั้งโปรแกรมนี้เพื่อเปิด StoreOS โดยเฉพาะ การอนุญาตจึงถูก
///     ตัดสินตั้งแต่ตอนติดตั้งแล้วโดยปริยาย
///
/// แต่ขอบเขตต้องแคบ: อนุญาตเฉพาะสิ่งที่ StoreOS ใช้จริง และเฉพาะเมื่อคำขอมาจาก
/// origin ของ StoreOS เอง หน้าอื่นที่หลุดเข้ามาไม่ได้อะไรเลย
/// </summary>
public static class WebViewPermissionPolicy
{
    /// <summary>สิ่งที่แอปใช้จริง — ไมค์ (สั่งงานด้วยเสียง), กล้อง (สแกนเมนู/สลิป), ตำแหน่ง (ลงเวลา)</summary>
    private static readonly HashSet<WebPermission> AllowedForOwnOrigin =
    [
        WebPermission.Microphone,
        WebPermission.Camera,
        WebPermission.Geolocation,
    ];

    public static WebPermissionDecision Decide(WebPermission permission, string? requestUri, Uri? allowedOrigin)
    {
        if (!WebOrigin.IsSameOrigin(requestUri, allowedOrigin)) return WebPermissionDecision.Deny;
        return AllowedForOwnOrigin.Contains(permission) ? WebPermissionDecision.Allow : WebPermissionDecision.Deny;
    }
}
