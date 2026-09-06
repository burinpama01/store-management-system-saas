using Microsoft.Web.WebView2.Core;

using StoreOS.Voice;

namespace StoreOS.Launcher.Services;

/// <summary>
/// สายคุยระหว่างตัวฟังคำปลุกกับหน้าเว็บ StoreOS (แผน v1 W4)
///
/// ทิศทางข้อความ:
///   native → web : wake.detected / wake.fallback / command.sessionEnded (watchdog ตัด)
///   web → native : command.sessionStarted / sessionExtended / sessionEnded
///
/// สิ่งที่ตั้งใจ<b>ไม่</b>ทำ:
///   * ไม่เปิด host object (<c>AddHostObjectToScript</c>) — นั่นคือการยื่นวัตถุของ .NET
///     ให้สคริปต์ในหน้าเว็บเรียกได้ ซึ่งกว้างเกินความจำเป็นมหาศาลสำหรับงานที่ต้องการ
///     แค่ส่งข้อความไม่กี่ชนิด
///   * ไม่ inject สคริปต์เพิ่ม และไม่แตะ CSP ของหน้าเว็บ
///   * ไม่ส่งอะไรออกไปนอกจากรหัสคำปลุก/สถานะ — ไม่มีเสียง ไม่มีข้อความที่ได้ยิน
///
/// เมื่อหน้าเว็บถูกพาไปที่อื่น (navigate) ต้อง<b>ปิดสายและคืนไมค์ก่อน</b>หน้าใหม่จะโหลด
/// ไม่งั้นหน้าใหม่จะได้รับช่วงสิทธิ์ถือไมค์ของหน้าเก่าไปเฉย ๆ
/// </summary>
public sealed class WebViewStandbyBridge : IDisposable
{
    private readonly CoreWebView2 _web;
    private readonly VoiceStandbyHost _voice;
    private readonly Action<string, string, string> _log;
    private readonly StandbyBridgePolicy _policy = new();
    private readonly StandbyOutbox _outbox;
    private Uri? _allowedOrigin;
    private bool _enabled;

    /// <param name="dispatch">
    /// พางานไปทำบนเธรด UI — คำปลุกถูกตรวจพบบนเธรดของการ์ดเสียง และ CoreWebView2
    /// เรียกข้ามเธรดไม่ได้ (ดู StandbyOutbox)
    /// </param>
    public WebViewStandbyBridge(
        CoreWebView2 web,
        VoiceStandbyHost voice,
        Uri allowedOrigin,
        Action<string, string, string> log,
        Action<Action> dispatch)
    {
        _web = web;
        _voice = voice;
        _allowedOrigin = allowedOrigin;
        _log = log;
        _enabled = true;
        _outbox = new StandbyOutbox(dispatch, json => web.PostWebMessageAsJson(json), log);

        _voice.MessageForWeb += OnMessageForWeb;
        _voice.HealthForWeb += OnHealthForWeb;
        _web.WebMessageReceived += OnWebMessageReceived;
        _web.NavigationStarting += OnNavigationStarting;
    }

    /// <summary>จำนวนข้อความที่ถูกด่านปฏิเสธ — เอาไว้ดูว่ามีอะไรผิดปกติบนเครื่องร้าน</summary>
    public int RejectedCount { get; private set; }

    private void OnHealthForWeb(object? sender, VoiceHealthMessage health) =>
        _outbox.Send(StandbyContract.Serialize(health));

    private void OnMessageForWeb(object? sender, StandbyMessage message) =>
        _outbox.Send(StandbyContract.Serialize(message));

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!_enabled) return;

        string? raw;
        try
        {
            raw = e.WebMessageAsJson;
        }
        catch (Exception)
        {
            return; // ข้อความที่ไม่ใช่ JSON — ไม่ใช่ของเรา
        }

        var verdict = _policy.Evaluate(raw, e.Source, _allowedOrigin, DateTimeOffset.Now);
        if (!verdict.Accepted)
        {
            // ข้อความของฟีเจอร์อื่น (เช่น provision ของ Print Hub) ก็ตกที่นี่ด้วย จึงไม่ใช่ error เสมอ
            // แต่ต้องนับไว้ ถ้าเครื่องไหนโดนปฏิเสธรัว ๆ แปลว่ามีอะไรผิดปกติจริง
            RejectedCount++;
            return;
        }

        switch (verdict.Message!.Type)
        {
            case StandbyContract.SessionStarted:
                _voice.OnWebSessionStarted();
                break;
            case StandbyContract.SessionExtended:
                _voice.OnWebSessionExtended();
                break;
            case StandbyContract.SessionEnded:
                await _voice.OnWebSessionEndedAsync();
                break;
            case StandbyContract.SetStandby when verdict.Message.Enabled is { } enabled:
                await _voice.SetEnabledAsync(enabled);
                break;
            case StandbyContract.RequestHealth:
                // ผู้ใช้กด "ตรวจอีกครั้ง" บนหน้าตั้งค่า หรือหน้าเว็บเพิ่งโหลดแล้วอยากรู้สถานะ
                await _voice.RecheckAsync();
                break;
        }
    }

    /// <summary>
    /// หน้าเว็บกำลังจะไปที่อื่น — ปิดสายและคืนไมค์ก่อนเสมอ
    ///
    /// ถ้าไปยัง origin เดิม (เปลี่ยนหน้าใน POS) แค่ล้างสถานะของด่านแล้วเปิดสายต่อ
    /// ถ้าไป origin อื่น ให้ปิดสายถาวรจนกว่าจะกลับมา — หน้าอื่นไม่มีสิทธิ์คุยกับไมโครโฟน
    /// </summary>
    private async void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        var sameOrigin = WebOrigin.IsSameOrigin(e.Uri, _allowedOrigin);

        _policy.Reset();
        _enabled = sameOrigin;
        _outbox.Enabled = sameOrigin;

        // ระหว่างเปลี่ยนหน้า เว็บไม่มีทางรายงาน sessionEnded กลับมาได้ — ต้องคืนไมค์ให้เอง
        await _voice.OnWebSessionEndedAsync();

        if (!sameOrigin)
        {
            _log("warn", "voice_bridge_disabled", "หน้าเว็บถูกพาไปโดเมนอื่น — ปิดสายคำปลุกและคืนไมโครโฟน");
        }
    }

    public void Dispose()
    {
        _enabled = false;
        _outbox.Enabled = false;
        _voice.MessageForWeb -= OnMessageForWeb;
        _voice.HealthForWeb -= OnHealthForWeb;
        _web.WebMessageReceived -= OnWebMessageReceived;
        _web.NavigationStarting -= OnNavigationStarting;
    }
}
