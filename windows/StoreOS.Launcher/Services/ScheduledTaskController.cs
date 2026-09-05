using System.Diagnostics;

namespace StoreOS.Launcher.Services;

/// <summary>
/// คุย Scheduled Task "StoreOSPrintHub" ที่ตัวติดตั้งสร้างไว้ ผ่าน schtasks.exe
///
/// Launcher **ไม่** สร้าง/ลบ task และ **ไม่** เรียก node โดยตรง — เจ้าของ process ของ Hub
/// มีทางเดียวคือ Scheduled Task (แผน v3 §2) ถ้า Launcher เปิด node เองด้วย จะได้ Hub
/// สองตัวบนเครื่องเดียว ซึ่งเป็นความเสี่ยง "พิมพ์ซ้อน" ที่แผนสั่งห้ามไว้ชัดเจน
/// </summary>
public sealed class ScheduledTaskController
{
    public const string TaskName = "StoreOSPrintHub";

    private readonly Func<string, string, (int ExitCode, string StdOut)> _run;

    public ScheduledTaskController(Func<string, string, (int, string)>? run = null)
    {
        _run = run ?? RunProcess;
    }

    /// <summary>อ่านสถานะ task โดยไม่แก้อะไร</summary>
    public ScheduledTaskState Query()
    {
        var (exitCode, stdout) = _run("schtasks.exe", $"/Query /TN \"{TaskName}\" /FO LIST");
        if (exitCode != 0) return ScheduledTaskState.Missing;
        return ParseState(stdout);
    }

    /// <summary>แปลผลลัพธ์ของ schtasks /Query (แยกออกมาเพื่อให้ทดสอบได้โดยไม่ต้องมี Windows task จริง)</summary>
    public static ScheduledTaskState ParseState(string stdout)
    {
        if (string.IsNullOrWhiteSpace(stdout)) return ScheduledTaskState.Unknown;
        foreach (var line in stdout.Split('\n'))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith("Status:", StringComparison.OrdinalIgnoreCase)
                && !trimmed.StartsWith("สถานะ:", StringComparison.Ordinal))
            {
                continue;
            }
            var value = trimmed[(trimmed.IndexOf(':') + 1)..].Trim();
            if (value.Contains("Running", StringComparison.OrdinalIgnoreCase)
                || value.Contains("กำลังทำงาน", StringComparison.Ordinal))
            {
                return ScheduledTaskState.Running;
            }
            if (value.Contains("Ready", StringComparison.OrdinalIgnoreCase)
                || value.Contains("Disabled", StringComparison.OrdinalIgnoreCase)
                || value.Contains("พร้อม", StringComparison.Ordinal))
            {
                return ScheduledTaskState.Stopped;
            }
        }
        return ScheduledTaskState.Unknown;
    }

    /// <summary>สั่งให้ task เริ่มทำงาน (idempotent — สั่งซ้ำตอนที่รันอยู่แล้วไม่เกิดโปรเซสที่สอง)</summary>
    public bool Start()
    {
        var (exitCode, _) = _run("schtasks.exe", $"/Run /TN \"{TaskName}\"");
        return exitCode == 0;
    }

    /// <summary>
    /// สั่งหยุดแล้วเริ่มใหม่ — ใช้หลังเขียน config ของ Hub ทับ เพราะ agent อ่าน config
    /// ตอนเริ่มโปรเซสเท่านั้น ถ้าไม่ restart มันจะยังยิง token เก่าจน 401 ต่อไป
    /// (/End กับ task ที่ไม่ได้รันอยู่จะคืน exit code ไม่ใช่ 0 ซึ่งไม่ใช่ความผิดพลาด)
    /// </summary>
    public bool Restart()
    {
        _run("schtasks.exe", $"/End /TN \"{TaskName}\"");
        return Start();
    }

    private static (int, string) RunProcess(string fileName, string arguments)
    {
        var psi = new ProcessStartInfo(fileName, arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        using var process = Process.Start(psi);
        if (process is null) return (-1, string.Empty);
        var stdout = process.StandardOutput.ReadToEnd();
        process.WaitForExit(10_000);
        return (process.HasExited ? process.ExitCode : -1, stdout);
    }
}
