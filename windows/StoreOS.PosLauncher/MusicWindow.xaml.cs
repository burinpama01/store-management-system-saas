using System.ComponentModel;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace StoreOS.PosLauncher;

/// <summary>
/// เพลงในร้าน + ระบบขอเพลง: เปิดหน้า /player ของเว็บ (หน้าเดียวกับที่ใช้เล่นเพลง/รับคิวขอเพลงจาก QR)
/// ในหน้าต่างแยก ใช้ environment เดียวกับหน้าหลัก (ล็อกอินอยู่แล้ว)
///
/// กดปิด (X) = ซ่อนหน้าต่าง เพลงเล่นต่อ — เพลงหยุดเมื่อกด "หยุดเพลง" หรือปิดโปรแกรมหลัก
/// /player/_ : หน้าเว็บ redirect ไป slug จริงของร้านที่ล็อกอินอยู่เอง (ไม่ต้องรู้ slug ฝั่งโปรแกรม)
/// </summary>
public partial class MusicWindow : Window
{
    private readonly CoreWebView2Environment _environment;
    private readonly string _url;
    private readonly string _channel;
    private bool _reallyClose;

    public event Action? Unavailable;

    public MusicWindow(CoreWebView2Environment environment, string url, string channel)
    {
        InitializeComponent();
        _environment = environment;
        _url = url;
        _channel = channel;
        Loaded += OnLoadedAsync;
        Closing += OnClosing;
    }

    /// <summary>ปิดจริง (หยุดเพลง)</summary>
    public void Stop()
    {
        _reallyClose = true;
        Close();
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_reallyClose) return;
        e.Cancel = true;
        Hide();
    }

    private async void OnLoadedAsync(object sender, RoutedEventArgs e)
    {
        try
        {
            await PlayerWeb.EnsureCoreWebView2Async(_environment);
            var core = PlayerWeb.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.NewWindowRequested += (_, args) => args.Handled = true;
            core.NavigationStarting += (_, args) =>
            {
                if (PosNavigationPolicy.Decide(args.Uri, _channel) == NavigationDecision.Block) args.Cancel = true;
            };
            // ร้านยังไม่เปิดเครื่องเล่นเพลง/ไม่มีสิทธิ์ → เว็บพาไปแดชบอร์ด: ปิดหน้าต่างแล้วบอกเหตุผลแทน
            core.SourceChanged += (_, _) =>
            {
                if (!Uri.TryCreate(core.Source, UriKind.Absolute, out var uri)) return;
                if (uri.AbsolutePath.StartsWith("/dashboard", StringComparison.OrdinalIgnoreCase))
                {
                    LocalLog.Write("info", "music_unavailable", uri.AbsolutePath);
                    Unavailable?.Invoke();
                    Stop();
                }
                else if (uri.AbsolutePath.StartsWith("/login", StringComparison.OrdinalIgnoreCase)
                    || uri.AbsolutePath.StartsWith("/device-login", StringComparison.OrdinalIgnoreCase))
                {
                    // หลุดล็อกอิน — ปิดหน้าต่างเพลง ไม่ค้างหน้าเข้าระบบไว้ (ล็อกอินใหม่ที่หน้าหลักแล้วกดเพลงอีกครั้ง)
                    LocalLog.Write("info", "music_logged_out", uri.AbsolutePath);
                    Stop();
                }
            };
            core.Navigate(_url);
            LocalLog.Write("info", "music_opened", _url);
        }
        catch (Exception ex)
        {
            LocalLog.Write("error", "music_failed", ex.Message);
            Stop();
        }
    }
}
