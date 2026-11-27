using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;

namespace StoreOS.PosLauncher;

/// <summary>
/// จอลูกค้า (/pos/display) — ใช้ WebView2 environment ตัวเดียวกับหน้าหลัก จึงล็อกอินอยู่แล้ว
/// และหน้า POS ส่งตะกร้ามาทาง BroadcastChannel ได้ (origin + profile เดียวกัน)
///
/// มีจอที่สอง = ไร้กรอบ เต็มจอที่สองพอดี / ไม่มี = หน้าต่างธรรมดาบนจอเดียวกัน (เปิดเองจากปุ่ม)
/// ถ้าหน้าเด้งไปที่อื่น (ร้านยังไม่เปิดฟีเจอร์จอลูกค้า / หลุดล็อกอิน) ปิดตัวเอง ไม่โชว์หน้าหลังร้านให้ลูกค้าเห็น
/// </summary>
public partial class CustomerDisplayWindow : Window
{
    private readonly CoreWebView2Environment _environment;
    private readonly string _url;
    private readonly string _channel;
    private MonitorRect? _monitor;

    public event Action<string>? ClosedBecause;

    public CustomerDisplayWindow(CoreWebView2Environment environment, string url, string channel, MonitorRect? monitor)
    {
        InitializeComponent();
        _environment = environment;
        _url = url;
        _channel = channel;
        _monitor = monitor;
        if (monitor is not null)
        {
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
        }
        SourceInitialized += (_, _) => PlaceOnMonitor();
        Loaded += OnLoadedAsync;
    }

    /// <summary>จอเปลี่ยน (เสียบ/ถอด/เปลี่ยนความละเอียด) — วางใหม่บนจอที่สองล่าสุด</summary>
    public void MoveTo(MonitorRect monitor)
    {
        _monitor = monitor;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        PlaceOnMonitor();
    }

    private void PlaceOnMonitor()
    {
        if (_monitor is null) return;
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd != IntPtr.Zero) MonitorInfo.Cover(hwnd, _monitor);
    }

    private async void OnLoadedAsync(object sender, RoutedEventArgs e)
    {
        try
        {
            await DisplayWeb.EnsureCoreWebView2Async(_environment);
            var core = DisplayWeb.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.NewWindowRequested += (_, args) => args.Handled = true; // จอลูกค้าห้ามเปิดหน้าต่างอื่น
            core.NavigationStarting += (_, args) =>
            {
                if (PosNavigationPolicy.Decide(args.Uri, _channel) == NavigationDecision.Block) args.Cancel = true;
            };
            core.SourceChanged += (_, _) => GuardDisplayPath(core.Source);
            core.Navigate(_url);
        }
        catch (Exception ex)
        {
            LocalLog.Write("error", "customer_display_failed", ex.Message);
            Close();
        }
    }

    private void GuardDisplayPath(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return;
        // ตรวจตรงตัว — ถ้าเว็บเพิ่ม sub-path ใต้ /pos/display ต้องแก้ที่นี่ด้วย
        if (uri.AbsolutePath.Equals("/pos/display", StringComparison.OrdinalIgnoreCase)) return;
        var reason = uri.AbsolutePath.StartsWith("/login", StringComparison.OrdinalIgnoreCase)
            || uri.AbsolutePath.StartsWith("/device-login", StringComparison.OrdinalIgnoreCase)
            ? "not_logged_in"
            : "feature_off";
        LocalLog.Write("info", "customer_display_closed", $"{reason} → {uri.AbsolutePath}");
        ClosedBecause?.Invoke(reason);
        Close();
    }
}
