using System.IO;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using StoreOS.Launcher.Services;

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
    private const string LauncherVersion = "0.1.5";

    private readonly ScheduledTaskController _tasks = new();
    private readonly LauncherLogShipper _logs;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(5) };
    private readonly string _healthPath = PrintHubReadiness.HealthFilePath(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
    private DateTimeOffset _lastStartAttempt = DateTimeOffset.MinValue;
    private ReadinessState? _lastReportedState;
    /// <summary>ISSUE-002 — หน้าต่างลูกที่ Launcher เป็นเจ้าของ ต้องปิดตามตอนปิด Launcher</summary>
    private readonly List<Window> _childWindows = new();

    public MainWindow()
    {
        InitializeComponent();
        // credential ของร้านอ่านจาก config ของ Print Hub บนเครื่องเดียวกัน — ถ้ายังไม่ได้
        // ติดตั้ง Hub จะเป็น null แล้ว log จะถูกเก็บไว้ในคิวเฉย ๆ (ไม่ส่ง ไม่พัง)
        _logs = new LauncherLogShipper(
            LauncherLogShipper.ReadHubCredentials(HubConfigPath()),
            LauncherVersion);
        Loaded += OnLoaded;
        Closing += OnClosing;
        Closed += async (_, _) => await _logs.DisposeAsync();
    }

    private static string HubConfigPath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "StoreOSPrintHub",
        "print-hub.config.json");

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        var settings = LauncherSettings.Load();
        await Web.EnsureCoreWebView2Async();
        // production kiosk profile: ปิดเมนูขวา/DevTools ตามแผน (v1 W1)
        Web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = settings.AllowDevTools;
        Web.CoreWebView2.Settings.AreDevToolsEnabled = settings.AllowDevTools;
        // ISSUE-002 — ต้อง subscribe หลัง EnsureCoreWebView2Async เท่านั้น (ก่อนหน้านั้น
        // CoreWebView2 ยังเป็น null) และต้องก่อนตั้ง Source เพื่อไม่พลาด popup แรก
        Web.CoreWebView2.NewWindowRequested += OnNewWindowRequested;
        Web.Source = new Uri(settings.PosUrl);

        _logs.Enqueue("info", "launcher_started", "เปิด StoreOS Launcher", new Dictionary<string, object>
        {
            ["launcherVersion"] = LauncherVersion,
            ["webview2"] = Web.CoreWebView2.Environment.BrowserVersionString,
        });

        // Print Hub auto-provision — ขอ config ล่าสุดของเครื่องนี้หลังหน้าเว็บโหลดเสร็จ
        // (ต้องรอให้ผู้ใช้ล็อกอินก่อน จึงผูกกับ NavigationCompleted ไม่ใช่ตอน Loaded)
        Web.CoreWebView2.NavigationCompleted += OnNavigationCompletedAsync;

        Refresh();
        _timer.Tick += async (_, _) =>
        {
            Refresh();
            // ส่ง log เป็นก้อนตามรอบ — ส่งไม่ได้ก็เก็บไว้รอบหน้า ไม่กระทบการขาย
            await _logs.FlushAsync();
        };
        _timer.Start();
    }

    private bool _provisionAttempted;

    /// <summary>
    /// Print Hub auto-provision — แก้ปัญหา "Hub token rejected (401)" ให้หายเองตอนเปิดโปรแกรม
    ///
    /// เรียกครั้งเดียวต่อการเปิด Launcher หนึ่งรอบ และเรียกจากในหน้าเว็บเพื่อให้ติด session
    /// ของผู้ใช้ไปด้วย — server เป็นคนตัดสินว่าต้องออก token ใหม่ไหม ถ้าของเดิมยังใช้ได้
    /// เราจะไม่แตะไฟล์ config เลย
    /// </summary>
    private async void OnNavigationCompletedAsync(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (_provisionAttempted || !e.IsSuccess) return;
        _provisionAttempted = true;

        try
        {
            var configPath = HubConfigPath();
            var current = LauncherLogShipper.ReadHubCredentials(configPath);
            var deviceId = HubConfigProvisioner.DeviceId(ReadMachineGuid(), Environment.MachineName);
            var script = HubConfigProvisioner.BuildProvisionScript(deviceId, Environment.MachineName, current?.HubToken);

            var raw = await Web.CoreWebView2.ExecuteScriptAsync(script);
            var outcome = HubConfigProvisioner.Interpret(raw);

            if (!outcome.Rotated || outcome.ConfigJson is null)
            {
                // already_valid = ปกติที่สุด ไม่ต้องรบกวนใคร; ที่เหลือคือยังล็อกอินไม่เสร็จ/ไม่มีสิทธิ์
                _logs.Enqueue("info", "hub_provision_skipped", $"ไม่ต้องออก Hub token ใหม่ ({outcome.Reason})");
                return;
            }

            HubConfigProvisioner.WriteConfigAtomic(configPath, outcome.ConfigJson);
            // config เปลี่ยนแล้ว agent ต้องอ่านใหม่ — restart task ให้เลย ไม่ต้องรอคนไปกด
            _tasks.Restart();
            _logs.Enqueue("info", "hub_provision_rotated", "อัปเดต Print Hub config ของเครื่องนี้อัตโนมัติแล้ว");
        }
        catch (Exception ex)
        {
            // provision ล้มต้องไม่ทำให้ POS เปิดไม่ได้ — Hub จะยัง 401 เหมือนเดิมเท่านั้น
            _logs.Enqueue("warn", "hub_provision_failed", $"ขอ Print Hub config อัตโนมัติไม่สำเร็จ: {ex.GetType().Name}");
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

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
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
