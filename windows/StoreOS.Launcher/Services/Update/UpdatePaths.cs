using System.IO;
using System.Text.Json;

namespace StoreOS.Launcher.Services.Update;

/// <summary>ชุดอัปเดตที่ดาวน์โหลด+ตรวจแล้ว พร้อมติดตั้ง</summary>
public sealed record StagedUpdate(string Version, string AppDir);

/// <summary>ผลการติดตั้งรอบล่าสุด — ตัวติดตั้งเขียน, Launcher รุ่นที่เปิดขึ้นมาอ่านแล้ว log</summary>
public sealed record UpdateResult(string Version, string Outcome, string? Error, DateTimeOffset At);

/// <summary>
/// ที่เก็บไฟล์ของการอัปเดต — อยู่ข้างโฟลเดอร์โปรแกรม (ไม่ใช่ข้างใน) เพราะโฟลเดอร์โปรแกรมถูกสลับทั้งก้อน
/// ไม่แตะ launcher.json / โปรไฟล์ WebView2 / config ของ Print Hub ซึ่งอยู่คนละที่อยู่แล้ว
/// </summary>
public sealed class UpdatePaths(string root)
{
    public const string ExeName = "StoreOS.Launcher.exe";

    public string Root { get; } = root;

    public static UpdatePaths Default() => new(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StoreOS", "Launcher-updates"));

    public string ZipPath(string version) => Path.Combine(Root, $"storeos-launcher-{version}.zip");
    public string StagingDir(string version) => Path.Combine(Root, $"staging-{version}");
    public string StagingAppDir(string version) => Path.Combine(StagingDir(version), "app");
    public string HealthyMarker(string version) => Path.Combine(Root, $"healthy-{version}");
    public string PendingFile => Path.Combine(Root, "pending.json");
    public string ResultFile => Path.Combine(Root, "last-update.json");
    public string RolledBackFile => Path.Combine(Root, "rolled-back.json");
    public string LogFile => Path.Combine(Root, "update.log");

    public static string PreviousDir(string installDir) => installDir.TrimEnd(Path.DirectorySeparatorChar) + ".previous";

    public StagedUpdate? ReadPending() => Read<StagedUpdate>(PendingFile);
    public void WritePending(StagedUpdate staged) => Write(PendingFile, staged);
    public void ClearPending() => TryDelete(PendingFile);

    public UpdateResult? ReadResult() => Read<UpdateResult>(ResultFile);
    public void WriteResult(UpdateResult result) => Write(ResultFile, result);
    public void ClearResult() => TryDelete(ResultFile);

    /// <summary>รุ่นที่ติดตั้งแล้วเปิดไม่ขึ้นจนต้องย้อนกลับ — ไม่ลองซ้ำจนกว่าจะมีรุ่นที่ใหม่กว่านั้น</summary>
    public string? ReadRolledBackVersion() => Read<RolledBack>(RolledBackFile)?.Version;
    public void WriteRolledBackVersion(string version) => Write(RolledBackFile, new RolledBack(version));

    public void AppendLog(string message)
    {
        try
        {
            Directory.CreateDirectory(Root);
            File.AppendAllText(LogFile, string.Format(
                System.Globalization.CultureInfo.InvariantCulture,
                "{0:yyyy-MM-dd HH:mm:ss} {1}{2}", DateTimeOffset.Now, message, Environment.NewLine));
        }
        catch (Exception)
        {
            // log ไม่ได้ไม่ใช่เหตุให้การอัปเดตล้ม
        }
    }

    private sealed record RolledBack(string Version);

    private static T? Read<T>(string path) where T : class
    {
        try
        {
            return File.Exists(path) ? JsonSerializer.Deserialize<T>(File.ReadAllText(path)) : null;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private void Write<T>(string path, T value)
    {
        Directory.CreateDirectory(Root);
        var temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(value));
        File.Move(temp, path, overwrite: true);
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception)
        {
            // ลบไม่ได้รอบนี้ ลองใหม่รอบหน้า
        }
    }
}
