using System.Runtime.InteropServices;

namespace StoreOS.PosLauncher;

/// <summary>จอหนึ่งจอ (พิกัดเป็นพิกเซลจริงของ Windows)</summary>
public sealed record MonitorRect(int Left, int Top, int Width, int Height, bool IsPrimary);

/// <summary>
/// อ่านรายชื่อจอผ่าน Win32 (EnumDisplayMonitors) — ไม่เปิด WinForms ในโปรเจค WPF
/// (UseWindowsForms ทำให้ชื่อ Application/MessageBox/Button ชนกันทั้งโปรเจค)
/// </summary>
public static class MonitorInfo
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfoEx
    {
        public int cbSize;
        public Rect rcMonitor;
        public Rect rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr lprcMonitor, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc callback, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MonitorInfoEx info);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    private const uint MonitorInfoPrimary = 1;
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpShowWindow = 0x0040;
    /// <summary>ไม่แย่งโฟกัส — เสียบ/ถอดจอระหว่างขาย แคชเชียร์ต้องพิมพ์/สแกนต่อที่หน้าขายได้</summary>
    private const uint SwpNoActivate = 0x0010;

    public static IReadOnlyList<MonitorRect> All()
    {
        var list = new List<MonitorRect>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (handle, _, _, _) =>
        {
            var info = new MonitorInfoEx { cbSize = Marshal.SizeOf<MonitorInfoEx>() };
            if (GetMonitorInfo(handle, ref info))
            {
                var r = info.rcMonitor;
                list.Add(new MonitorRect(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, (info.dwFlags & MonitorInfoPrimary) != 0));
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }

    /// <summary>จอที่ไม่ใช่จอหลัก (จอลูกค้า) — ไม่มีจอที่สอง = null</summary>
    public static MonitorRect? Secondary() => All().FirstOrDefault(m => !m.IsPrimary);

    /// <summary>วางหน้าต่างให้เต็มจอนั้นพอดี (พิกเซลจริง ไม่ต้องแปลง DPI เอง)</summary>
    public static void Cover(IntPtr hwnd, MonitorRect monitor) =>
        SetWindowPos(hwnd, IntPtr.Zero, monitor.Left, monitor.Top, monitor.Width, monitor.Height, SwpNoZOrder | SwpShowWindow | SwpNoActivate);
}
