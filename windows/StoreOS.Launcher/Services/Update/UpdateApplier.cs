using System.Diagnostics;
using System.IO;

namespace StoreOS.Launcher.Services.Update;

public sealed record ApplyOptions(string InstallDir, string StagingAppDir, int WaitPid, string Version);

/// <summary>งานระดับ process ที่ตัวติดตั้งต้องใช้ — แยกออกมาเพื่อทดสอบลำดับขั้นได้โดยไม่เปิดโปรแกรมจริง</summary>
public interface IUpdateProcessOps
{
    bool WaitForExit(int pid, TimeSpan timeout);
    int? Start(string exePath, IReadOnlyList<string> args);
    bool WaitForFile(string path, TimeSpan timeout);
    void Kill(int pid);
}

/// <summary>
/// ตัวติดตั้งอัปเดต — รันจาก exe ของรุ่นใหม่ในโฟลเดอร์ staging (โหมด --apply-update ไม่มีหน้าต่าง)
///
/// ลำดับ:
///   1. รอ Launcher ตัวเดิมปิด (ไฟล์ของมันยังถูกล็อกจนกว่าจะปิด)
///   2. ย้ายโฟลเดอร์โปรแกรมเดิมเป็น .previous (สำรองทั้งก้อน)
///   3. คัดลอกรุ่นใหม่ลงที่เดิม แล้วเปิด Launcher รุ่นใหม่พร้อม --post-update
///   4. รุ่นใหม่ต้องเขียนไฟล์ healthy ภายในเวลาที่กำหนด ไม่งั้นถือว่าพัง → ย้อนกลับ .previous แล้วเปิดรุ่นเดิม
/// ทุกทางที่ล้มต้องจบด้วย "มี Launcher เปิดอยู่หนึ่งตัว" — ร้านต้องขายของต่อได้เสมอ
/// </summary>
public static class UpdateApplier
{
    public static readonly TimeSpan OldProcessTimeout = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan HealthTimeout = TimeSpan.FromSeconds(90);

    public static UpdateResult Run(ApplyOptions options, UpdatePaths paths, IUpdateProcessOps ops)
    {
        var installDir = options.InstallDir.TrimEnd(Path.DirectorySeparatorChar);
        var previous = UpdatePaths.PreviousDir(installDir);
        var installedExe = Path.Combine(installDir, UpdatePaths.ExeName);
        paths.AppendLog($"apply {options.Version}: เริ่ม (install={installDir})");

        UpdateResult Finish(string outcome, string? error)
        {
            var result = new UpdateResult(options.Version, outcome, error, DateTimeOffset.Now);
            try
            {
                paths.WriteResult(result);
            }
            catch (Exception)
            {
                // เขียนผลไม่ได้ก็ต้องไปต่อ — สำคัญกว่าคือมี Launcher เปิดอยู่
            }
            paths.AppendLog($"apply {options.Version}: {outcome}{(error is null ? "" : $" ({error})")}");
            return result;
        }

        if (!File.Exists(Path.Combine(options.StagingAppDir, UpdatePaths.ExeName)))
        {
            ops.Start(installedExe, []);
            return Finish("failed", "staging_missing");
        }

        if (options.WaitPid > 0 && !ops.WaitForExit(options.WaitPid, OldProcessTimeout))
        {
            // ตัวเดิมยังเปิดอยู่ — ไม่แตะอะไรเลย (มันยังขายของอยู่)
            return Finish("failed", "old_still_running");
        }

        try
        {
            if (Directory.Exists(previous)) Directory.Delete(previous, recursive: true);
            MoveWithRetry(installDir, previous);
        }
        catch (Exception ex)
        {
            ops.Start(installedExe, []);
            return Finish("failed", $"backup_failed:{ex.GetType().Name}");
        }

        try
        {
            CopyDirectory(options.StagingAppDir, installDir);
        }
        catch (Exception ex)
        {
            Restore(installDir, previous);
            ops.Start(installedExe, ["--update-rolled-back", options.Version]);
            paths.WriteRolledBackVersion(options.Version);
            return Finish("rolled_back", $"copy_failed:{ex.GetType().Name}");
        }

        var marker = paths.HealthyMarker(options.Version);
        TryDeleteFile(marker);
        var newPid = ops.Start(installedExe, ["--post-update", options.Version]);
        if (newPid is not null && ops.WaitForFile(marker, HealthTimeout))
        {
            paths.ClearPending();
            return Finish("installed", null);
        }

        // รุ่นใหม่ไม่รายงานว่าเปิดได้ — ปิดทิ้งแล้วคืนรุ่นเดิม
        if (newPid is { } pid) ops.Kill(pid);
        ops.WaitForExit(newPid ?? 0, TimeSpan.FromSeconds(10));
        Restore(installDir, previous);
        paths.WriteRolledBackVersion(options.Version);
        paths.ClearPending();
        ops.Start(installedExe, ["--update-rolled-back", options.Version]);
        return Finish("rolled_back", newPid is null ? "start_failed" : "health_timeout");
    }

    /// <summary>อ่านอาร์กิวเมนต์ของโหมดติดตั้ง — ผิดรูปแบบ = null (ไม่ทำอะไรเลย)</summary>
    public static ApplyOptions? ParseArgs(IReadOnlyList<string> args)
    {
        if (args.Count == 0 || args[0] != "--apply-update") return null;
        string? install = null, staging = null, version = null;
        var pid = 0;
        for (var i = 1; i + 1 < args.Count; i += 2)
        {
            switch (args[i])
            {
                case "--install-dir": install = args[i + 1]; break;
                case "--staging-app": staging = args[i + 1]; break;
                case "--wait-pid": _ = int.TryParse(args[i + 1], out pid); break;
                case "--version": version = args[i + 1]; break;
            }
        }
        if (install is null || staging is null || LauncherUpdatePolicy.ParseVersion(version) is null) return null;
        return new ApplyOptions(install, staging, pid, version!);
    }

    public static IReadOnlyList<string> BuildArgs(ApplyOptions options) =>
    [
        "--apply-update",
        "--install-dir", options.InstallDir,
        "--staging-app", options.StagingAppDir,
        "--wait-pid", options.WaitPid.ToString(System.Globalization.CultureInfo.InvariantCulture),
        "--version", options.Version,
    ];

    private static void Restore(string installDir, string previous)
    {
        try
        {
            if (Directory.Exists(installDir)) Directory.Delete(installDir, recursive: true);
            if (Directory.Exists(previous)) MoveWithRetry(previous, installDir);
        }
        catch (Exception)
        {
            // คืนไม่ได้ = ปล่อย .previous ไว้ให้คนมาย้ายเอง (log ถูกเขียนโดยผู้เรียกแล้ว)
        }
    }

    /// <summary>ไฟล์ที่เพิ่งปิดอาจยังถูก antivirus/ indexer ถือไว้ครู่หนึ่ง — ลองซ้ำก่อนยอมแพ้</summary>
    private static void MoveWithRetry(string from, string to)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                Directory.Move(from, to);
                return;
            }
            catch (IOException) when (attempt < 20)
            {
                Thread.Sleep(500);
            }
            catch (UnauthorizedAccessException) when (attempt < 20)
            {
                Thread.Sleep(500);
            }
        }
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var dir in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(destination, Path.GetRelativePath(source, dir)));
        }
        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            File.Copy(file, Path.Combine(destination, Path.GetRelativePath(source, file)), overwrite: true);
        }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception)
        {
            // ไม่เป็นไร
        }
    }
}

/// <summary>ของจริงที่ใช้ตอนรัน</summary>
public sealed class SystemUpdateProcessOps : IUpdateProcessOps
{
    public bool WaitForExit(int pid, TimeSpan timeout)
    {
        if (pid <= 0) return true;
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.WaitForExit(timeout);
        }
        catch (ArgumentException)
        {
            return true; // ไม่มี process นี้แล้ว = ปิดไปแล้ว
        }
    }

    public int? Start(string exePath, IReadOnlyList<string> args)
    {
        try
        {
            var info = new ProcessStartInfo(exePath)
            {
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(exePath)!,
            };
            foreach (var arg in args) info.ArgumentList.Add(arg);
            using var process = Process.Start(info);
            return process?.Id;
        }
        catch (Exception)
        {
            return null;
        }
    }

    public bool WaitForFile(string path, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (File.Exists(path)) return true;
            Thread.Sleep(500);
        }
        return File.Exists(path);
    }

    public void Kill(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            process.Kill(entireProcessTree: true);
        }
        catch (Exception)
        {
            // ปิดไปเองแล้ว
        }
    }
}
