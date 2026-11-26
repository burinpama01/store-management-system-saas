using System.Globalization;
using System.IO;
using System.Text;

namespace StoreOS.PosLauncher;

/// <summary>log ในเครื่อง: %LOCALAPPDATA%\StoreOS\PosLauncher\logs\yyyy-MM-dd.log (เก็บ 14 วัน)</summary>
public static class LocalLog
{
    private static readonly object Gate = new();
    private static readonly string Dir = Path.Combine(PosLauncherSettings.DataRoot, "logs");

    public static void Write(string level, string eventName, string message)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Dir);
                // InvariantCulture: เครื่องร้านตั้งภาษาไทย → yyyy กลายเป็นปี พ.ศ. (2569) ชื่อไฟล์/เวลาใน log สับสน
                var now = DateTimeOffset.Now;
                var line = now.ToString("yyyy-MM-dd HH:mm:ss.fff zzz", CultureInfo.InvariantCulture)
                    + $" [{level}] {eventName}: {message.Replace('\n', ' ')}{Environment.NewLine}";
                File.AppendAllText(Path.Combine(Dir, now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + ".log"), line, new UTF8Encoding(false));
            }
        }
        catch
        {
            // เขียน log ไม่ได้ต้องไม่ทำให้ขายของไม่ได้
        }
    }

    public static void Prune()
    {
        try
        {
            if (!Directory.Exists(Dir)) return;
            foreach (var file in Directory.GetFiles(Dir, "*.log"))
            {
                if (File.GetLastWriteTime(file) < DateTime.Now.AddDays(-14)) File.Delete(file);
            }
        }
        catch
        {
        }
    }
}
