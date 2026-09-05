using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace StoreOS.Launcher;

/// <summary>
/// ISSUE-002 — จอลูกค้าเป็น "หน้าต่างลูก" ของ Launcher
///
/// เดิมเว็บสั่ง window.open แล้ว WebView2 เปิดหน้าต่างลอยที่ไม่มีใครเป็นเจ้าของ
/// ปิด Launcher แล้วจอลูกค้าค้างอยู่บนจอที่สอง พนักงานต้องไปไล่ปิดเอง
///
/// หน้าต่างนี้ใช้ CoreWebView2Environment "ตัวเดียวกับหน้าหลัก" เพื่อให้อยู่ใน
/// browser context เดียวกัน (session/cookie เดียวกัน) — ไม่ต้องล็อกอินซ้ำ
/// </summary>
public partial class CustomerDisplayWindow : Window
{
    private readonly CoreWebView2Environment _environment;
    private readonly CoreWebView2Deferral _deferral;
    private readonly CoreWebView2NewWindowRequestedEventArgs _args;

    public CustomerDisplayWindow(
        CoreWebView2Environment environment,
        CoreWebView2NewWindowRequestedEventArgs args,
        CoreWebView2Deferral deferral)
    {
        InitializeComponent();
        _environment = environment;
        _args = args;
        _deferral = deferral;
        Loaded += OnLoadedAsync;
    }

    private async void OnLoadedAsync(object sender, RoutedEventArgs e)
    {
        try
        {
            await DisplayWeb.EnsureCoreWebView2Async(_environment);
            // ส่ง WebView ของหน้าต่างนี้กลับไปให้ตัวที่ขอเปิด แทนที่จะให้ WebView2
            // สร้างหน้าต่างของมันเอง — นี่คือจุดที่ทำให้ "หน้าต่างลอย" หายไป
            _args.NewWindow = DisplayWeb.CoreWebView2;
            _args.Handled = true;
        }
        catch (Exception)
        {
            // เปิดจอลูกค้าไม่ได้ต้องไม่ทำให้ POS ล่ม — ปล่อยให้ WebView2 จัดการเองตามเดิม
            _args.Handled = false;
        }
        finally
        {
            _deferral.Complete();
        }
    }
}
