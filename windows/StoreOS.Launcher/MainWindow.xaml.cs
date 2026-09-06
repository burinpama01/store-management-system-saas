using System.IO;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using StoreOS.Launcher.Services;
using StoreOS.Voice;

namespace StoreOS.Launcher;

/// <summary>
/// หน้าต่างเดียวของ Launcher: WebView2 ที่เปิด StoreOS POS + แถบสถานะระบบพิมพ์
///
/// หลักการ (แผน v3 Task 8):
///   * POS ต้องเปิดได้เสมอ แม้ Print Hub ยังไม่พร้อม (degraded ไม่ใช่ blocking)
///   * Launcher ไม่เป็นเจ้าของ process ของ Hub — สั่งผ่าน Scheduled Task เท่านั้น
///   * ไม่มี token ใด ๆ ในไฟล์/หน้าจอนี้ สถานะอ่านจาก health.json ที่ agent เขียน
/// </summary>
public partial class MainWindow : Window
{
    private const string LauncherVersion = "0.2.4";

    private readonly ScheduledTaskController _tasks = new();
    private readonly LauncherLogShipper _logs;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(5) };
    /// <summary>
    /// นาฬิกาของ watchdog เสียง — ต้องถี่กว่าตัวจับเวลาสถานะเครื่องพิมพ์มาก
    /// เพราะเส้นตายที่ต้องจับคือ 2 วินาที (เว็บตอบว่าเริ่มฟัง) ถ้าใช้รอบ 5 วินาที
    /// ผู้ใช้จะยืนรอปุ่ม "แตะเพื่อพูด" นานกว่าที่ควรถึงสองเท่า
    /// เดินเฉพาะตอนเปิดโหมดคำปลุกเท่านั้น จึงไม่กิน CPU บนเครื่องที่ปิดฟีเจอร์นี้
    /// </summary>
    private readonly DispatcherTimer _voiceTimer = new() { Interval = TimeSpan.FromMilliseconds(250) };
    private readonly string _healthPath = PrintHubReadiness.HealthFilePath(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
    private DateTimeOffset _lastStartAttempt = DateTimeOffset.MinValue;
    private ReadinessState? _lastReportedState;
    /// <summary>ISSUE-002 — หน้าต่างลูกที่ Launcher เป็นเจ้าของ ต้องปิดตามตอนปิด Launcher</summary>
    private readonly List<Window> _childWindows = new();
    /// <summary>
    /// ฝั่งคำปลุก (แผน v1 W1 + เครื่องยนต์จริง W2) — ปิดเป็นค่าเริ่มต้น
    /// เปิดทีละเครื่องด้วย VoiceStandbyEnabled ใน launcher.json ระหว่าง pilot เท่านั้น
    /// </summary>
    private readonly VoiceStandbyHost _voice;
    /// <summary>สัญญาณล็อกจอ/หลับของ Windows — ต้องถอด handler ตอนปิดไม่งั้น SystemEvents ถือ reference ค้าง</summary>
    private readonly WindowsSuspendSignals _suspendSignals = new();
    /// <summary>สายคุยคำปลุก↔หน้าเว็บ (W4) — สร้างหลัง WebView2 พร้อมเท่านั้น</summary>
    private WebViewStandbyBridge? _voiceBridge;

    public MainWindow()
    {
        InitializeComponent();
        // credential ของร้านอ่านจาก config ของ Print Hub บนเครื่องเดียวกัน — ถ้ายังไม่ได้
        // ติดตั้ง Hub จะเป็น null แล้ว log จะถูกเก็บไว้ในคิวเฉย ๆ (ไม่ส่ง ไม่พัง)
        _logs = new LauncherLogShipper(
            LauncherLogShipper.ReadHubCredentials(HubConfigPath()),
            LauncherVersion);
        _voice = new VoiceStandbyHost(
            () => new SystemSpeechWakeEngine(),
            (level, code, message) => _logs.Enqueue(level, code, message),
            hostVersion: LauncherVersion);
        _voice.Attach(_suspendSignals);
        Loaded += OnLoaded;
        Closing += OnClosing;
        // ปิดหน้าต่างทางไหนก็ตาม ต้องคืนไมโครโฟนก่อนแล้วค่อยปล่อยคิว log
        Closed += async (_, _) =>
        {
            _voiceBridge?.Dispose();
            _suspendSignals.Dispose();
            await _voice.DisposeAsync();
            await _logs.DisposeAsync();
        };
    }

    private static string HubConfigPath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "StoreOSPrintHub",
        "print-hub.config.json");

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        var settings = LauncherSettings.Load();

        // WebView2 ต้องมีโฟลเดอร์ข้อมูลที่ผู้ใช้เขียนได้ ไม่งั้นเครื่องที่ติดตั้งลง Program Files
        // จะเปิด POS ไม่ขึ้นเลย (ค่าเริ่มต้นของ WebView2 คือโฟลเดอร์ข้าง ๆ ไฟล์ exe)
        try
        {
            var userData = WebViewProfile.UserDataFolder(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                settings.Channel);
            Directory.CreateDirectory(userData);
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userData);
            await Web.EnsureCoreWebView2Async(environment);
        }
        catch (Exception ex)
        {
            // สร้าง environment เองไม่ได้ (สิทธิ์/ดิสก์) — ถอยไปใช้ค่าเริ่มต้นดีกว่าเปิดไม่ขึ้น
            _logs.Enqueue("warn", "webview2_profile_fallback", $"ใช้โฟลเดอร์ WebView2 เริ่มต้นแทน: {ex.GetType().Name}");
            await Web.EnsureCoreWebView2Async();
        }
        // production kiosk profile: ปิดเมนูขวา/DevTools ตามแผน (v1 W1)
        Web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = settings.AllowDevTools;
        Web.CoreWebView2.Settings.AreDevToolsEnabled = settings.AllowDevTools;
        // ISSUE-002 — ต้อง subscribe หลัง EnsureCoreWebView2Async เท่านั้น (ก่อนหน้านั้น
        // CoreWebView2 ยังเป็น null) และต้องก่อนตั้ง Source เพื่อไม่พลาด popup แรก
        Web.CoreWebView2.NewWindowRequested += OnNewWindowRequested;
        // ผลของ provision กลับมาทางนี้ ไม่ใช่ค่าคืนของ ExecuteScriptAsync (ดู HubConfigProvisioner)
        Web.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

        // config ของเครื่องถูกโปรแกรมอื่นแก้ให้ชี้เว็บปลอมได้ — Launcher เปิดเต็มจอไม่มีแถบที่อยู่
        // ผู้ใช้จึงไม่มีทางสังเกตเห็น ต้องกรองที่นี่
        var posUrl = settings.ResolvePosUrl(out var rejectedUrl);
        if (rejectedUrl)
        {
            _logs.Enqueue("error", "pos_url_rejected", "ค่า PosUrl ในไฟล์ตั้งค่าใช้ไม่ได้ กลับไปใช้ที่อยู่มาตรฐาน");
        }
        Web.Source = new Uri(posUrl);

        _logs.Enqueue("info", "launcher_started", "เปิด StoreOS Launcher", new Dictionary<string, object>
        {
            ["launcherVersion"] = LauncherVersion,
            ["webview2"] = Web.CoreWebView2.Environment.BrowserVersionString,
        });

        // Print Hub auto-provision — ขอ config ล่าสุดของเครื่องนี้หลังหน้าเว็บโหลดเสร็จ
        // (ต้องรอให้ผู้ใช้ล็อกอินก่อน จึงผูกกับ NavigationCompleted ไม่ใช่ตอน Loaded)
        Web.CoreWebView2.NavigationCompleted += OnNavigationCompletedAsync;

        // เปิดโหมดคำปลุกถ้าเครื่องนี้เปิดไว้ — ล้มเหลวก็แค่ไม่มีคำปลุก POS ยังขายได้
        await _voice.StartAsync(settings.VoiceStandbyEnabled);
        if (settings.VoiceStandbyEnabled)
        {
            // สายคุยผูกกับ origin ที่ Launcher เปิดจริงเท่านั้น (ผ่านด่าน ResolvePosUrl มาแล้ว)
            _voiceBridge = new WebViewStandbyBridge(
                Web.CoreWebView2,
                _voice,
                new Uri(posUrl),
                (level, code, message) => _logs.Enqueue(level, code, message));
            _voiceTimer.Tick += async (_, _) => await _voice.TickAsync();
            _voiceTimer.Start();
        }

        Refresh();
        _timer.Tick += async (_, _) =>
        {
            Refresh();
            // ส่ง log เป็นก้อนตามรอบ — ส่งไม่ได้ก็เก็บไว้รอบหน้า ไม่กระทบการขาย
            await _logs.FlushAsync();
        };
        _timer.Start();
    }

    /// <summary>
    /// จบเรื่อง provision แล้ว (ได้คำตอบชี้ขาดจาก server) — หยุดถามซ้ำ
    /// ตั้งเฉพาะตอนได้ผลชี้ขาดเท่านั้น ไม่ใช่ตอน "ลองแล้ว"
    /// </summary>
    private bool _provisionSettled;
    /// <summary>กันยิงซ้อนกันเอง เพราะ NavigationCompleted เป็น async void</summary>
    private bool _provisionInFlight;
    /// <summary>เพดานจำนวนครั้ง กันหน้าเว็บที่ redirect รัวทำให้ยิงไม่หยุด</summary>
    private int _provisionAttempts;
    private const int MaxProvisionAttempts = 12;

    /// <summary>
    /// Print Hub auto-provision — แก้ปัญหา "Hub token rejected (401)" ให้หายเองตอนเปิดโปรแกรม
    ///
    /// เรียกครั้งเดียวต่อการเปิด Launcher หนึ่งรอบ และเรียกจากในหน้าเว็บเพื่อให้ติด session
    /// ของผู้ใช้ไปด้วย — server เป็นคนตัดสินว่าต้องออก token ใหม่ไหม ถ้าของเดิมยังใช้ได้
    /// เราจะไม่แตะไฟล์ config เลย
    /// </summary>
    private async void OnNavigationCompletedAsync(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        // navigation แรกคือ "หน้าล็อกอิน" ซึ่งยังไม่มี session — ถ้าเลิกถามตั้งแต่ครั้งนั้น
        // เครื่องที่ token เพี้ยนจะค้าง 401 ตลอดไป (เครื่องร้านเจอจริง 2026-09-05)
        // จึงลองใหม่ทุกครั้งที่โหลดหน้าเสร็จ จนกว่าจะได้คำตอบชี้ขาดจาก server
        if (_provisionSettled || _provisionInFlight || !e.IsSuccess) return;
        if (_provisionAttempts >= MaxProvisionAttempts) return;
        _provisionInFlight = true;
        _provisionAttempts++;

        try
        {
            var current = LauncherLogShipper.ReadHubCredentials(HubConfigPath());
            var deviceId = HubConfigProvisioner.DeviceId(ReadMachineGuid(), Environment.MachineName);
            var script = HubConfigProvisioner.BuildProvisionScript(deviceId, Environment.MachineName, current?.HubToken);
            // ยิงอย่างเดียว — ผลลัพธ์รอที่ OnWebMessageReceived
            await Web.CoreWebView2.ExecuteScriptAsync(script);
        }
        catch (Exception ex)
        {
            _provisionInFlight = false;
            RecordProvision("warn", $"ขอ Print Hub config อัตโนมัติไม่สำเร็จ: {ex.GetType().Name}");
        }
    }

    /// <summary>
    /// รับผล provision จากหน้าเว็บ — นี่คือจุดเดียวที่ config ถูกเขียนทับ
    /// รับเฉพาะข้อความจากหน้าเว็บของ StoreOS เอง (host เดียวกับที่ Launcher เปิด)
    /// </summary>
    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string? message;
        try
        {
            message = e.TryGetWebMessageAsString();
        }
        catch (ArgumentException)
        {
            return; // ข้อความที่ไม่ใช่ string — ไม่ใช่ของเรา
        }

        if (!HubConfigProvisioner.IsProvisionMessage(message)) return;
        if (!IsTrustedSource(e.Source)) return;

        _provisionInFlight = false;
        var outcome = HubConfigProvisioner.InterpretEnvelope(message);

        if (!outcome.Rotated || outcome.ConfigJson is null)
        {
            // already_valid = ปกติที่สุด; not_signed_in / network_error = ยังไม่ชี้ขาด ลองใหม่หน้าถัดไป
            if (IsConclusive(outcome.Reason)) _provisionSettled = true;
            RecordProvision("info", $"ไม่ต้องออก Hub token ใหม่ ({outcome.Reason})");
            return;
        }

        try
        {
            _provisionSettled = true;
            HubConfigProvisioner.WriteConfigAtomic(HubConfigPath(), outcome.ConfigJson);
            // config เปลี่ยนแล้ว agent ต้องอ่านใหม่ — สั่ง restart ให้ แต่ถึง restart ไม่ผ่าน
            // agent รุ่น 1.2.0+ ก็จะเห็นไฟล์เปลี่ยนแล้วโหลดเองในรอบ poll ถัดไป
            var restarted = _tasks.Restart();
            RecordProvision("info", restarted
                ? "อัปเดต Print Hub config ของเครื่องนี้อัตโนมัติแล้ว"
                : "เขียน Print Hub config ใหม่แล้ว แต่สั่งรีสตาร์ตตัวช่วยพิมพ์ไม่สำเร็จ (agent จะโหลดเองในไม่กี่วินาที)");
        }
        catch (Exception ex)
        {
            RecordProvision("warn", $"เขียน Print Hub config ไม่สำเร็จ: {ex.GetType().Name}");
        }
    }

    /// <summary>
    /// ข้อความต้องมาจากหน้าเว็บของ StoreOS เอง ไม่ใช่ iframe/หน้าอื่นที่หลุดเข้ามา
    ///
    /// W4 — เปลี่ยนมาเทียบ origin แบบตรงตัว (scheme + host + port) แทนการเทียบแค่ host
    /// ของเดิมยอมรับพอร์ตใดก็ได้บนโฮสต์เดียวกัน ซึ่งกว้างเกินจำเป็นสำหรับข้อความที่
    /// เขียนไฟล์ตั้งค่าของเครื่องได้
    /// </summary>
    private bool IsTrustedSource(string? source) => WebOrigin.IsSameOrigin(source, Web.Source);

    /// <summary>
    /// เหตุผลที่ถือว่า "ถามไปแล้วได้คำตอบ" — ไม่ต้องถามซ้ำ
    /// ที่ไม่อยู่ในรายการนี้ (ยังไม่ล็อกอิน / เน็ตหลุด / อ่านผลไม่ออก) ต้องลองใหม่
    /// </summary>
    private static bool IsConclusive(string reason) =>
        reason is "already_valid" or "no_permission" or "server_rejected";

    /// <summary>
    /// log ที่ "อ่านได้จากเครื่องร้าน" — log ที่ส่งขึ้น server ใช้ hub token ซึ่งตอนมีปัญหา
    /// มักโดน 401 อยู่แล้ว จึงไม่มีวันไปถึง คนหน้างานต้องมีไฟล์เปิดดูเองได้
    /// ไม่มี token ในไฟล์นี้
    /// </summary>
    private void RecordProvision(string level, string message)
    {
        _logs.Enqueue(level, "hub_provision", message);
        try
        {
            var path = Path.Combine(Path.GetDirectoryName(HubConfigPath())!, "launcher-provision.log");
            var line = $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss} [{level}] {message}{Environment.NewLine}";
            File.AppendAllText(path, line);
        }
        catch (Exception)
        {
            // เขียน log ไม่ได้ต้องไม่ทำให้ POS สะดุด
        }
    }

    /// <summary>MachineGuid ของ Windows — ใช้เป็นเมล็ดของ device id (ถูก hash ก่อนส่งเสมอ)</summary>
    private static string? ReadMachineGuid()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
            return key?.GetValue("MachineGuid") as string;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// ISSUE-002 — รับเฉพาะจอลูกค้าของเราเองมาเป็นหน้าต่างลูก
    /// URL อื่นไม่ claim (e.Handled = false) เพื่อไม่ไปปิดหน้าต่างของเว็บอื่นผิดตัว
    /// </summary>
    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        if (!CustomerDisplayNavigation.TryResolve(Web.Source, e.Uri, out _)) return;

        var deferral = e.GetDeferral();
        var child = new CustomerDisplayWindow(Web.CoreWebView2.Environment, e, deferral)
        {
            Owner = this,
        };
        _childWindows.Add(child);
        child.Closed += (_, _) => _childWindows.Remove(child);
        child.Show();

        _logs.Enqueue("info", "customer_display_opened", "เปิดจอลูกค้าเป็นหน้าต่างลูกของ Launcher");
    }

    /// <summary>ผ่านขั้นตอนปิดที่ต้องรอ (คืนไมโครโฟน) แล้วหรือยัง</summary>
    private bool _shutdownPrepared;

    private async void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        // WPF ไม่รอ async void — ถ้าปล่อยให้ปิดไปเลยระหว่างที่ StopAsync ยังทำงาน
        // ไมโครโฟนจะถูกปล่อยหลัง process ตาย (หรือไม่ถูกปล่อยเลย) ซึ่งเป็นอาการ
        // "ไฟไมค์ค้างหลังปิดโปรแกรม" ที่ผู้ใช้ตีความว่าโปรแกรมแอบฟัง
        // จึงยกเลิกการปิดรอบแรก ทำให้เสร็จก่อน แล้วค่อยสั่งปิดจริง
        if (!_shutdownPrepared)
        {
            e.Cancel = true;
            _timer.Stop();
            _voiceTimer.Stop();
            try
            {
                await _voice.StopAsync();
            }
            finally
            {
                _shutdownPrepared = true;
                Close();
            }
            return;
        }

        // ปิดจาก snapshot เพราะ child.Closed จะแก้ list ระหว่างวน
        foreach (var child in _childWindows.ToArray())
        {
            try { child.Close(); }
            catch (InvalidOperationException) { /* ปิดไปแล้ว — ไม่ใช่ปัญหา */ }
        }
        _childWindows.Clear();
    }

    private void Refresh()
    {
        string? json = null;
        try
        {
            if (File.Exists(_healthPath)) json = File.ReadAllText(_healthPath);
        }
        catch (IOException)
        {
            // agent กำลังเขียนไฟล์อยู่พอดี — รอบหน้าค่อยอ่านใหม่
        }

        var taskState = _tasks.Query();
        var health = PrintHubReadiness.Parse(json);
        var decision = PrintHubReadiness.Decide(health, taskState, DateTimeOffset.Now);
        StatusText.Text = decision.Message;

        // รายงานเฉพาะตอน "สถานะเปลี่ยน" ไม่ใช่ทุก 5 วินาที — ไม่งั้น log ท่วมและอ่านไม่ออก
        if (_lastReportedState != decision.State)
        {
            _lastReportedState = decision.State;
            _logs.Enqueue(
                decision.State is ReadinessState.Ready or ReadinessState.Preparing ? "info" : "error",
                $"hub_{decision.State.ToString().ToLowerInvariant()}",
                decision.Message,
                new Dictionary<string, object>
                {
                    ["taskState"] = taskState.ToString(),
                    ["agentVersion"] = health?.AgentVersion ?? "unknown",
                    ["agentState"] = health?.State ?? "unknown",
                    ["lastErrorCode"] = health?.LastErrorCode ?? "none",
                });
        }

        // กันสั่ง start ถี่เกินไป (bounded restart ตามแผน): อย่างมาก 1 ครั้งต่อ 30 วินาที
        if (decision.ShouldStartTask && DateTimeOffset.Now - _lastStartAttempt > TimeSpan.FromSeconds(30))
        {
            _lastStartAttempt = DateTimeOffset.Now;
            var started = _tasks.Start();
            _logs.Enqueue(
                started ? "info" : "error",
                started ? "hub_start_requested" : "hub_start_failed",
                started ? "สั่งเปิด Print Hub ผ่าน Scheduled Task" : "สั่งเปิด Print Hub ไม่สำเร็จ",
                new Dictionary<string, object> { ["taskName"] = ScheduledTaskController.TaskName });
        }
    }
}


