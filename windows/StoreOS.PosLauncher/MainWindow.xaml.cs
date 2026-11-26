using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using StoreOS.Printing;

namespace StoreOS.PosLauncher;

/// <summary>
/// หน้าต่างหลัก: แท็บ ขาย (POS) / การตั้งค่าอื่นๆ (หน้าเว็บหลังร้านเต็ม) + จอลูกค้า + เพลง + ช่อง storeos.pos สำหรับพิมพ์ตรง
///
/// ด่านความปลอดภัย 2 ชั้น (ทั้งคู่ต้องผ่าน):
///   1. หน้าที่เปิดในโปรแกรมได้ = โดเมน StoreOS + เฉพาะหน้างาน POS (PosNavigationPolicy.Decide)
///   2. ข้อความสั่งพิมพ์รับเฉพาะจากหน้างานในโดเมน StoreOS (PosNavigationPolicy.IsTrustedMessageSource)
///      และ library ตรวจซ้ำอีกชั้น: IP ต้องเป็นวง LAN + พอร์ต 9100–9109 + ไม่เกิน 256KB
/// </summary>
public partial class MainWindow : Window
{
    private static readonly Brush ActiveBg = new SolidColorBrush(Color.FromRgb(0xB4, 0x53, 0x7E));
    private static readonly Brush OkBg = new SolidColorBrush(Color.FromRgb(0xE5, 0xF6, 0xEE));
    private static readonly Brush OkFg = new SolidColorBrush(Color.FromRgb(0x0F, 0x8A, 0x5F));
    private static readonly Brush BadBg = new SolidColorBrush(Color.FromRgb(0xFD, 0xEC, 0xEA));
    private static readonly Brush BadFg = new SolidColorBrush(Color.FromRgb(0xC0, 0x39, 0x2B));
    private static readonly Brush WarnBg = new SolidColorBrush(Color.FromRgb(0xFD, 0xF3, 0xE1));
    private static readonly Brush WarnFg = new SolidColorBrush(Color.FromRgb(0xA8, 0x67, 0x0A));

    public static string AppVersion { get; } =
        Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "1.0.0";

    private readonly PosLauncherSettings _settings;
    private readonly string _baseUrl;
    private readonly DirectPrintQueue _queue = new(new TcpPrintTransport());
    private readonly DispatcherTimer _probeTimer = new() { Interval = TimeSpan.FromSeconds(30) };
    private readonly DispatcherTimer _noticeTimer = new() { Interval = TimeSpan.FromSeconds(4) };
    /// <summary>เครื่องพิมพ์ที่เคยพิมพ์จากเครื่องนี้ (host:port) — ใช้ตรวจสถานะเป็นระยะ</summary>
    private readonly Dictionary<string, (string Host, int Port)> _knownPrinters = new(StringComparer.Ordinal);
    private DateTime _lastJobAt = DateTime.MinValue;
    private int _activeJobs;
    private bool _probeRunning;
    private string? _lastAllowedUrl;
    private bool _lastWasAuthPage = true;
    private PrinterToolsWindow? _tools;
    private CoreWebView2Environment? _environment;
    private CustomerDisplayWindow? _display;
    private MusicWindow? _music;
    /// <summary>ร้านยังไม่เปิดฟีเจอร์จอลูกค้า — ไม่เปิดเองซ้ำทุกครั้งที่เข้าหน้าขาย (กดปุ่มเองได้)</summary>
    private bool _displayFeatureOff;
    private bool _loggedIn;

    public MainWindow(PosLauncherSettings settings)
    {
        _settings = settings;
        _baseUrl = settings.ResolveBaseUrl();
        InitializeComponent();
        Title = $"StoreOS POS {AppVersion}";
        Loaded += OnLoaded;
        _queue.Completed += OnJobCompleted;
        _probeTimer.Tick += async (_, _) => await ProbeKnownPrintersAsync();
        _noticeTimer.Tick += (_, _) => { ExternalNotice.Visibility = Visibility.Collapsed; _noticeTimer.Stop(); };
    }

    internal DirectPrintQueue Queue => _queue;

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        LocalLog.Write("info", "starting", $"StoreOS POS {AppVersion} base={_baseUrl} channel={_settings.SafeChannel}");
        try
        {
            var userData = Path.Combine(PosLauncherSettings.DataRoot, "webview2", _settings.SafeChannel);
            Directory.CreateDirectory(userData);
            // เพลงในร้านต้องเล่นเองได้โดยไม่ต้องมีคนกด (เปิดเครื่องตอนเช้าแล้วเพลงขึ้นเลย)
            var options = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
            _environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userData, options: options);
            await Web.EnsureCoreWebView2Async(_environment);
        }
        catch (Exception ex)
        {
            LocalLog.Write("error", "webview2_init", ex.ToString());
            MessageBox.Show(
                "เปิดหน้า POS ไม่ได้ — เครื่องนี้อาจยังไม่มี Microsoft Edge WebView2 Runtime\nติดตั้งได้จาก https://go.microsoft.com/fwlink/p/?LinkId=2124703",
                "StoreOS POS", MessageBoxButton.OK, MessageBoxImage.Error);
            return;
        }

        var core = Web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = _settings.AllowDevTools;
        core.Settings.AreDefaultContextMenusEnabled = _settings.AllowDevTools;
        core.Settings.IsStatusBarEnabled = false;
        // ให้หน้าเว็บรู้ว่าเปิดในโปรแกรม StoreOS POS (หน้า QR ใช้ตั้งชื่ออุปกรณ์)
        core.Settings.UserAgent = $"{core.Settings.UserAgent} StoreOSPos/{AppVersion}";
        if (_settings.AllowDevTools) LocalLog.Write("warn", "devtools_enabled", $"channel={_settings.SafeChannel}");
        core.NavigationStarting += OnNavigationStarting;
        core.SourceChanged += OnSourceChanged;
        core.NewWindowRequested += OnNewWindowRequested;
        core.WebMessageReceived += OnWebMessageReceived;
        core.ProcessFailed += (_, args) => LocalLog.Write("error", "webview2_process_failed", args.ProcessFailedKind.ToString());

        Navigate(PosTab.Pos);
        _probeTimer.Start();
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
        Closed += (_, _) => Microsoft.Win32.SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
    }

    // ───────────── แท็บ ─────────────

    private void OnTabPos(object sender, RoutedEventArgs e) => Navigate(PosTab.Pos);
    private void OnTabSettings(object sender, RoutedEventArgs e) => Navigate(PosTab.Settings);

    private void Navigate(PosTab tab)
    {
        if (Web.CoreWebView2 is null) return;
        Web.CoreWebView2.Navigate(PosNavigationPolicy.UrlFor(tab, _baseUrl));
        HighlightTab(tab);
    }

    private void HighlightTab(PosTab tab)
    {
        foreach (var (button, t) in new[] { (TabPos, PosTab.Pos), (TabSettings, PosTab.Settings) })
        {
            var on = t == tab;
            button.Background = on ? ActiveBg : Brushes.Transparent;
            button.Foreground = on ? Brushes.White : new SolidColorBrush(Color.FromRgb(0x6A, 0x61, 0x5A));
        }
    }

    // ───────────── ด่านหน้าที่เปิดได้ ─────────────

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        var decision = PosNavigationPolicy.Decide(e.Uri, _settings.Channel);
        if (decision == NavigationDecision.Allow) return;
        e.Cancel = true;
        HandleDisallowed(e.Uri, decision);
    }

    /// <summary>
    /// Next.js เปลี่ยนหน้าแบบ client-side (pushState) ไม่ผ่าน NavigationStarting — ตรวจซ้ำที่นี่
    /// หน้าไม่อนุญาต = เปิดในเบราว์เซอร์แทน แล้วพากลับหน้าเดิม
    /// </summary>
    private void OnSourceChanged(object? sender, CoreWebView2SourceChangedEventArgs e)
    {
        var url = Web.CoreWebView2.Source;
        var decision = PosNavigationPolicy.Decide(url, _settings.Channel);
        if (decision == NavigationDecision.Allow)
        {
            var tab = PosNavigationPolicy.TabFor(url);
            // ล็อกอินด้วยรหัสผ่านแล้วเว็บพาไปหน้าแดชบอร์ด — ในโปรแกรมนี้ให้เริ่มที่หน้าขายเสมอ
            if (_lastWasAuthPage && tab == PosTab.Settings)
            {
                _lastWasAuthPage = false;
                Navigate(PosTab.Pos);
                return;
            }
            _lastWasAuthPage = tab == PosTab.None;
            if (tab != PosTab.None)
            {
                _lastAllowedUrl = url;
                HighlightTab(tab);
                if (!_loggedIn)
                {
                    _loggedIn = true;
                    AutoOpenCustomerDisplay();
                }
            }
            return;
        }
        HandleDisallowed(url, decision);
    }

    private void HandleDisallowed(string url, NavigationDecision decision)
    {
        if (decision == NavigationDecision.OpenExternal)
        {
            OpenInBrowser(url);
            ShowNotice("หน้านี้ไม่อยู่ในโปรแกรม POS — เปิดในเบราว์เซอร์ให้แล้ว");
        }
        else
        {
            LocalLog.Write("warn", "navigation_blocked", url);
            ShowNotice("ไม่อนุญาตให้เปิดเว็บนี้ในโปรแกรม POS");
        }
        if (_lastAllowedUrl is not null && Web.CoreWebView2.Source != _lastAllowedUrl)
        {
            Web.CoreWebView2.Navigate(_lastAllowedUrl);
        }
        else if (_lastAllowedUrl is null)
        {
            Navigate(PosTab.Pos);
        }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        // หน้าต่างใหม่ (เช่น ใบเสร็จ PDF, ลิงก์ target=_blank) ไม่เปิดในโปรแกรม — StoreOS ไปเบราว์เซอร์, เว็บอื่นบล็อก
        // ยกเว้นจอลูกค้า (/pos/display) และเครื่องเล่นเพลง (/player/...) ที่โปรแกรมเปิดเป็นหน้าต่างของตัวเอง
        e.Handled = true;
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var target) && PosNavigationPolicy.IsAllowedHost(target, _settings.Channel))
        {
            if (target.AbsolutePath.Equals("/pos/display", StringComparison.OrdinalIgnoreCase))
            {
                OpenCustomerDisplay(userRequested: true);
                return;
            }
            if (target.AbsolutePath.StartsWith("/player/", StringComparison.OrdinalIgnoreCase))
            {
                OpenMusic(target.AbsoluteUri);
                return;
            }
        }
        var decision = PosNavigationPolicy.Decide(e.Uri, _settings.Channel);
        if (decision != NavigationDecision.Block)
        {
            OpenInBrowser(e.Uri);
        }
        else
        {
            LocalLog.Write("warn", "popup_blocked", e.Uri);
        }
    }

    private static void OpenInBrowser(string url)
    {
        try
        {
            if (Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps)
            {
                Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
            }
        }
        catch (Exception ex)
        {
            LocalLog.Write("warn", "open_browser_failed", ex.Message);
        }
    }

    private void ShowNotice(string text)
    {
        ExternalNoticeText.Text = text;
        ExternalNotice.Visibility = Visibility.Visible;
        _noticeTimer.Stop();
        _noticeTimer.Start();
    }

    // ───────────── ช่อง storeos.pos ─────────────

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!PosNavigationPolicy.IsTrustedMessageSource(e.Source, _settings.Channel)) return;
        string? json;
        try { json = e.WebMessageAsJson; }
        catch { return; }
        var request = PosBridgeProtocol.Parse(json);
        if (request is null) return;

        try
        {
            switch (request.Type)
            {
                case PosBridgeProtocol.HelloRequest:
                    Post(PosBridgeProtocol.Hello(AppVersion));
                    break;
                case PosBridgeProtocol.PrintJob when request.Job is not null:
                    await HandlePrintAsync(request.Job);
                    break;
                case PosBridgeProtocol.PrinterProbe when request.Host is not null:
                    Post(PosBridgeProtocol.Probe(request.RequestId,
                        await PrinterDiscovery.ProbeAsync(request.Host, request.Port, TimeSpan.FromSeconds(2))));
                    break;
                case PosBridgeProtocol.PrintersScan:
                    Post(PosBridgeProtocol.Scan(request.RequestId, await PrinterDiscovery.ScanAsync(PrinterDiscovery.LocalSubnetPrefixes())));
                    break;
                case PosBridgeProtocol.HistoryGet:
                    Post(PosBridgeProtocol.History(request.RequestId, _queue.History()));
                    break;
            }
        }
        catch (Exception ex)
        {
            LocalLog.Write("error", "bridge_request_failed", $"{request.Type}: {ex.Message}");
        }
    }

    private async Task HandlePrintAsync(DirectPrintJob job)
    {
        _activeJobs++;
        _lastJobAt = DateTime.UtcNow;
        SetStatus($"● กำลังส่งงานพิมพ์ · {job.Host}:{job.Port}", WarnBg, WarnFg);
        try
        {
            var result = await _queue.PrintAsync(job);
            Post(PosBridgeProtocol.Result(result));
        }
        finally
        {
            _activeJobs--;
            _lastJobAt = DateTime.UtcNow;
        }
    }

    private void Post(string json)
    {
        try { Web.CoreWebView2?.PostWebMessageAsJson(json); }
        catch (Exception ex) { LocalLog.Write("warn", "post_message_failed", ex.Message); }
    }

    private void OnJobCompleted(PrintHistoryEntry entry)
    {
        LocalLog.Write(entry.Outcome == "printed" ? "info" : "warn", "print",
            $"{entry.Kind} {entry.Label} → {entry.Target} {entry.Outcome} {entry.ElapsedMs}ms attempts={entry.Attempts} bytes={entry.Bytes} {entry.Error}");
        // InvokeAsync ไม่ใช่ Invoke: Completed อาจถูกยกจาก UI thread เอง (เช่นงานที่ถูกปฏิเสธทันที) — Invoke จะค้าง
        Dispatcher.InvokeAsync(() =>
        {
            var parts = entry.Target.Split(':');
            if (parts.Length == 2 && int.TryParse(parts[1], out var port)) _knownPrinters[entry.Target] = (parts[0], port);
            if (entry.Outcome == "printed")
            {
                SetStatus($"● พิมพ์ตรง พร้อม · {entry.Target} · ใบล่าสุด {entry.ElapsedMs / 1000.0:0.0} วิ", OkBg, OkFg);
            }
            else
            {
                SetStatus($"● พิมพ์ไม่สำเร็จ · {entry.Target} · {entry.Error}", entry.Outcome == "unknown" ? WarnBg : BadBg, entry.Outcome == "unknown" ? WarnFg : BadFg);
            }
            _tools?.Refresh();
        });
    }

    /// <summary>ตรวจเครื่องพิมพ์ที่เคยใช้ทุก 30 วิ — ข้ามถ้ากำลังพิมพ์/เพิ่งพิมพ์ (กันชนกับงานจริง)</summary>
    private async Task ProbeKnownPrintersAsync()
    {
        if (_probeRunning || _knownPrinters.Count == 0 || _activeJobs > 0 || DateTime.UtcNow - _lastJobAt < TimeSpan.FromSeconds(20)) return;
        _probeRunning = true;
        var down = new List<string>();
        try
        {
            foreach (var (key, target) in _knownPrinters.ToList())
            {
                var probe = await PrinterDiscovery.ProbeAsync(target.Host, target.Port, TimeSpan.FromSeconds(2));
                if (!probe.Reachable) down.Add(key);
            }
        }
        finally
        {
            _probeRunning = false;
        }
        if (_activeJobs > 0) return; // มีงานพิมพ์เข้ามาระหว่างตรวจ — สถานะจริงมาจากงานนั้น
        if (down.Count > 0)
        {
            SetStatus($"● เครื่องพิมพ์ไม่ตอบ · {string.Join(", ", down)}", BadBg, BadFg);
        }
        else if (StatusPill.Background == BadBg)
        {
            SetStatus($"● พิมพ์ตรง พร้อม · {string.Join(", ", _knownPrinters.Keys)}", OkBg, OkFg);
        }
    }

    private void SetStatus(string text, Brush bg, Brush fg)
    {
        StatusText.Text = text.Length > 90 ? text[..90] + "…" : text;
        StatusPill.Background = bg;
        StatusText.Foreground = fg;
    }

    // ───────────── จอลูกค้า ─────────────

    private void AutoOpenCustomerDisplay()
    {
        if (!_settings.CustomerDisplayAuto || _displayFeatureOff || _display is not null) return;
        if (MonitorInfo.Secondary() is null) return;
        OpenCustomerDisplay(userRequested: false);
    }

    private void OpenCustomerDisplay(bool userRequested)
    {
        if (_environment is null) return;
        if (_display is not null)
        {
            _display.Activate();
            return;
        }
        var monitor = MonitorInfo.Secondary();
        if (userRequested) _displayFeatureOff = false;
        var window = new CustomerDisplayWindow(_environment, _baseUrl + "/pos/display", _settings.Channel, monitor) { Owner = this };
        window.ClosedBecause += reason =>
        {
            if (reason == "feature_off")
            {
                _displayFeatureOff = true;
                if (userRequested) ShowNotice("ร้านนี้ยังไม่เปิดจอลูกค้า — เปิดได้ที่ การตั้งค่าอื่นๆ › ตั้งค่า › จอลูกค้า");
            }
        };
        window.Closed += (_, _) =>
        {
            _display = null;
            DisplayButton.Content = "🖥  จอลูกค้า";
        };
        _display = window;
        DisplayButton.Content = "🖥  ปิดจอลูกค้า";
        window.Show();
        // จอที่สองเต็มจอแล้ว — ดึงโฟกัสกลับมาที่หน้าขาย (แคชเชียร์พิมพ์/สแกนต่อได้ทันที)
        Activate();
        LocalLog.Write("info", "customer_display_opened", monitor is null ? "window (single screen)" : $"fullscreen {monitor.Width}x{monitor.Height} @ {monitor.Left},{monitor.Top}");
    }

    private void OnToggleCustomerDisplay(object sender, RoutedEventArgs e)
    {
        if (_display is not null)
        {
            _display.Close();
            return;
        }
        OpenCustomerDisplay(userRequested: true);
    }

    /// <summary>เสียบ/ถอดจอ หรือเปลี่ยนความละเอียด — ย้าย/เปิด/ปิดจอลูกค้าตาม</summary>
    private void OnDisplaySettingsChanged(object? sender, EventArgs e)
    {
        Dispatcher.InvokeAsync(() =>
        {
            var secondary = MonitorInfo.Secondary();
            if (secondary is not null)
            {
                if (_display is not null) _display.MoveTo(secondary);
                else if (_loggedIn) AutoOpenCustomerDisplay();
            }
            else if (_display is not null && _display.WindowStyle == WindowStyle.None)
            {
                _display.Close(); // จอที่สองถูกถอด — ไม่ปล่อยหน้าต่างไร้กรอบทับหน้าขาย
            }
        });
    }

    // ───────────── เพลง ─────────────

    private void OpenMusic(string? url = null)
    {
        if (_environment is null) return;
        if (_music is null)
        {
            _music = new MusicWindow(_environment, url ?? _baseUrl + "/player/_", _settings.Channel) { Owner = this };
            _music.Unavailable += () => ShowNotice("ร้านนี้ยังไม่เปิดเครื่องเล่นเพลง/ขอเพลง — ตั้งค่าได้ที่ การตั้งค่าอื่นๆ › ตั้งค่า › เครื่องเล่นเพลง");
            _music.Closed += (_, _) =>
            {
                _music = null;
                MusicStopButton.Visibility = Visibility.Collapsed;
            };
            MusicStopButton.Visibility = Visibility.Visible;
        }
        _music.Show();
        if (_music.WindowState == WindowState.Minimized) _music.WindowState = WindowState.Normal;
        _music.Activate();
    }

    private void OnOpenMusic(object sender, RoutedEventArgs e) => OpenMusic();

    private void OnStopMusic(object sender, RoutedEventArgs e) => _music?.Stop();

    private void OnOpenPrinterTools(object sender, RoutedEventArgs e)
    {
        if (_tools is { IsVisible: true })
        {
            _tools.Activate();
            return;
        }
        _tools = new PrinterToolsWindow(_queue) { Owner = this };
        _tools.Show();
    }
}
