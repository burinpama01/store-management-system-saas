using System.Windows;
using StoreOS.Printing;

namespace StoreOS.PosLauncher;

/// <summary>หน้าต่างเครื่องมือ: สแกนหาเครื่องพิมพ์ในวง + ประวัติงานพิมพ์ในเครื่องนี้</summary>
public partial class PrinterToolsWindow : Window
{
    private readonly DirectPrintQueue _queue;

    public PrinterToolsWindow(DirectPrintQueue queue)
    {
        _queue = queue;
        InitializeComponent();
        Refresh();
    }

    public void Refresh()
    {
        HistoryList.Items.Clear();
        var history = _queue.History();
        if (history.Count == 0)
        {
            HistoryList.Items.Add("ยังไม่มีงานพิมพ์ตั้งแต่เปิดโปรแกรม");
            return;
        }
        foreach (var e in history)
        {
            var status = e.Outcome switch { "printed" => "✅ สำเร็จ", "unknown" => "⚠️ ไม่แน่ใจ", _ => "❌ ล้ม" };
            HistoryList.Items.Add(
                $"{e.At:HH:mm:ss}  {status}  {e.Kind,-7} {e.Label ?? "",-14} → {e.Target}  {e.ElapsedMs / 1000.0:0.0} วิ  {e.Bytes / 1024}KB" +
                (e.Attempts > 1 ? $"  ลอง {e.Attempts} ครั้ง" : "") +
                (e.Error is null ? "" : $"  ({e.Error})"));
        }
    }

    private void OnRefresh(object sender, RoutedEventArgs e) => Refresh();

    private async void OnScan(object sender, RoutedEventArgs e)
    {
        ScanButton.IsEnabled = false;
        FoundList.Items.Clear();
        var prefixes = PrinterDiscovery.LocalSubnetPrefixes();
        ScanStatus.Text = prefixes.Count == 0 ? "เครื่องนี้ไม่ได้ต่อ WiFi/LAN วงในร้าน" : $"กำลังค้นหาใน {string.Join(", ", prefixes.Select(p => p + ".x"))} …";
        try
        {
            if (prefixes.Count > 0)
            {
                var found = await PrinterDiscovery.ScanAsync(prefixes);
                foreach (var p in found) FoundList.Items.Add($"{p.Host}:{p.Port}   ตอบใน {p.LatencyMs} ms");
                ScanStatus.Text = found.Count == 0 ? "ไม่เจอเครื่องพิมพ์ (เปิดเครื่องพิมพ์/ต่อ WiFi วงเดียวกันหรือยัง?)" : $"เจอ {found.Count} เครื่อง";
            }
        }
        catch (Exception ex)
        {
            ScanStatus.Text = "ค้นหาไม่สำเร็จ: " + ex.Message;
        }
        finally
        {
            ScanButton.IsEnabled = true;
        }
    }
}
