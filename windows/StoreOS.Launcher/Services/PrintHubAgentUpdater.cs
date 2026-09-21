using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json.Serialization;

namespace StoreOS.Launcher.Services;

/// <summary>รุ่นล่าสุดของ agent ที่เว็บประกาศไว้ (/api/print/hub/agent-latest)</summary>
public sealed record PrintHubAgentManifest
{
    [JsonPropertyName("version")] public string Version { get; init; } = "";
    [JsonPropertyName("url")] public string Url { get; init; } = "";
    [JsonPropertyName("sha256")] public string Sha256 { get; init; } = "";
    [JsonPropertyName("size")] public long Size { get; init; }
    [JsonPropertyName("notes")] public string? Notes { get; init; }
}

public enum PrintHubUpdateOutcome
{
    /// <summary>ไม่มีอะไรต้องทำ (เวอร์ชันตรงแล้ว หรือยังไม่รู้ว่าเครื่องนี้ลงรุ่นไหน)</summary>
    UpToDate,
    Updated,
    Failed,
}

public sealed record PrintHubUpdateResult(PrintHubUpdateOutcome Outcome, string Message, string? Version = null);

/// <summary>
/// อัปเดตไฟล์ agent ของ Print Hub ให้เครื่องร้าน
///
/// ทำไม Launcher ต้องเป็นคนทำ: agent เป็นสคริปต์ที่ Scheduled Task เรียก ไม่ใช่โปรแกรม
/// ที่มีตัวติดตั้งของตัวเอง มันจึงอัปเดตตัวเองไม่ได้ ผลคือทุกการแก้ฝั่ง agent ต้องเดินไป
/// ลงใหม่ทีละร้าน และแทบไม่เคยไปถึงหน้าร้านจริง Launcher รันอยู่บนเครื่องเดียวกันและ
/// อัปเดตตัวเองเป็นอยู่แล้ว จึงรับหน้าที่นี้แทน
///
/// ขอบเขตที่จงใจทำให้แคบ: แตะเฉพาะไฟล์ print-hub.mjs ไฟล์เดียว
///   - ไม่แตะ print-hub.config.json (token/ค่าเชื่อมต่อของร้านอยู่ในนั้น)
///   - ไม่แตะ node portable, ไม่สร้าง/ลบ Scheduled Task, ไม่รัน installer
/// ยิ่งแตะน้อย โอกาสที่ร้านตื่นมาแล้วพิมพ์ไม่ได้ยิ่งน้อย
///
/// ล้มเหลวเมื่อไหร่ต้องคืนของเดิมเสมอ — agent เก่าที่ใช้งานได้ ดีกว่า agent ใหม่ที่พัง
/// </summary>
public sealed class PrintHubAgentUpdater(
    HttpClient http,
    Func<TimeSpan, bool> stopAgentAndWait,
    Func<bool> startAgent,
    string installRoot)
{
    /// <summary>ชื่อไฟล์ agent ใน zip (ดู scripts/build-print-hub-zip.mjs)</summary>
    private const string EntryPath = "storeos-print-hub/print-hub.mjs";
    private const string AgentFileName = "print-hub.mjs";

    /// <summary>เพดานขนาดแพ็กเกจ — กันไฟล์ผิดหรือหน้า error ที่ถูกส่งมาแทน zip</summary>
    private const long MaxPackageBytes = 32L * 1024 * 1024;

    private string AgentPath => Path.Combine(installRoot, AgentFileName);
    private string BackupPath => Path.Combine(installRoot, AgentFileName + ".bak");

    /// <summary>
    /// ตรวจและอัปเดตถ้าจำเป็น
    ///
    /// <paramref name="installedVersion"/> มาจาก health.json ที่ agent เขียน (ดู PrintHubReadiness)
    /// ถ้าอ่านไม่ได้ = ไม่รู้ว่าเครื่องนี้ลงรุ่นไหน ซึ่งต้องไม่เดาแล้วเขียนทับ
    /// </summary>
    public async Task<PrintHubUpdateResult> EnsureLatestAsync(
        string? installedVersion,
        string manifestUrl,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(installedVersion))
        {
            return new(PrintHubUpdateOutcome.UpToDate, "ยังไม่รู้เวอร์ชันของ Print Hub บนเครื่องนี้ — ข้ามรอบนี้");
        }
        if (!File.Exists(AgentPath))
        {
            return new(PrintHubUpdateOutcome.UpToDate, "ไม่พบไฟล์ agent ที่ติดตั้งไว้ — ข้ามรอบนี้ (ยังไม่ได้ติดตั้ง Print Hub)");
        }

        PrintHubAgentManifest? manifest;
        try
        {
            manifest = await http.GetFromJsonAsync<PrintHubAgentManifest>(manifestUrl, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new(PrintHubUpdateOutcome.Failed, $"อ่านรุ่นล่าสุดไม่ได้: {ex.Message}");
        }

        if (manifest is null || !IsUsable(manifest))
        {
            return new(PrintHubUpdateOutcome.Failed, "ข้อมูลรุ่นล่าสุดไม่ครบหรือไม่น่าเชื่อถือ");
        }
        if (string.Equals(manifest.Version, installedVersion, StringComparison.OrdinalIgnoreCase))
        {
            return new(PrintHubUpdateOutcome.UpToDate, "Print Hub เป็นรุ่นล่าสุดอยู่แล้ว", manifest.Version);
        }

        byte[] agentBytes;
        try
        {
            agentBytes = await DownloadAgentAsync(manifest, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new(PrintHubUpdateOutcome.Failed, $"ดาวน์โหลดรุ่นใหม่ไม่สำเร็จ: {ex.Message}");
        }

        return ApplyAgent(agentBytes, manifest.Version);
    }

    /// <summary>ปฏิเสธ manifest ที่ใช้ไม่ได้ตั้งแต่ต้น ดีกว่าไปพังตอนเขียนทับไฟล์</summary>
    private static bool IsUsable(PrintHubAgentManifest m) =>
        !string.IsNullOrWhiteSpace(m.Version)
        && m.Size > 0
        && m.Size <= MaxPackageBytes
        && m.Sha256.Length == 64
        && m.Sha256.All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))
        && Uri.TryCreate(m.Url, UriKind.Absolute, out var uri)
        && uri.Scheme == Uri.UriSchemeHttps;

    private async Task<byte[]> DownloadAgentAsync(PrintHubAgentManifest manifest, CancellationToken ct)
    {
        using var response = await http.GetAsync(manifest.Url, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"HTTP {(int)response.StatusCode}");
        }

        using var buffer = new MemoryStream();
        await using (var source = await response.Content.ReadAsStreamAsync(ct))
        {
            var chunk = new byte[81920];
            int read;
            while ((read = await source.ReadAsync(chunk, ct)) > 0)
            {
                if (buffer.Length + read > manifest.Size)
                {
                    throw new InvalidOperationException("ไฟล์ใหญ่กว่าที่ประกาศไว้");
                }
                buffer.Write(chunk, 0, read);
            }
        }

        var bytes = buffer.ToArray();
        if (bytes.LongLength != manifest.Size)
        {
            throw new InvalidOperationException("ขนาดไฟล์ไม่ตรงกับที่ประกาศไว้");
        }
        var actual = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        if (!string.Equals(actual, manifest.Sha256, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("ลายนิ้วมือไฟล์ (SHA-256) ไม่ตรง");
        }

        using var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read);
        var entry = zip.GetEntry(EntryPath)
            ?? throw new InvalidOperationException($"ในแพ็กเกจไม่มี {EntryPath}");
        using var entryStream = entry.Open();
        using var agent = new MemoryStream();
        entryStream.CopyTo(agent);
        if (agent.Length == 0) throw new InvalidOperationException("ไฟล์ agent ในแพ็กเกจว่างเปล่า");
        return agent.ToArray();
    }

    /// <summary>
    /// หยุด agent, เขียนทับไฟล์, เริ่มใหม่ — คืนไฟล์เดิมทันทีถ้าขั้นใดล้ม
    ///
    /// ต้องหยุดให้โปรเซสปิดจริงก่อนเขียน ไม่งั้นไฟล์ถูกล็อก และถ้าเขียนสำเร็จครึ่งทาง
    /// ร้านจะเหลือ agent ที่รันไม่ได้
    /// </summary>
    private PrintHubUpdateResult ApplyAgent(byte[] agentBytes, string version)
    {
        var stopped = stopAgentAndWait(TimeSpan.FromSeconds(20));
        if (!stopped)
        {
            return new(PrintHubUpdateOutcome.Failed, "หยุด Print Hub ไม่สำเร็จ — ไม่เขียนทับไฟล์");
        }

        try
        {
            File.Copy(AgentPath, BackupPath, overwrite: true);
            File.WriteAllBytes(AgentPath, agentBytes);
        }
        catch (Exception ex)
        {
            TryRestoreBackup();
            startAgent();
            return new(PrintHubUpdateOutcome.Failed, $"เขียนไฟล์ใหม่ไม่สำเร็จ: {ex.Message}");
        }

        if (!startAgent())
        {
            TryRestoreBackup();
            startAgent();
            return new(PrintHubUpdateOutcome.Failed, "เริ่ม Print Hub ใหม่ไม่สำเร็จ — คืนไฟล์เดิมแล้ว");
        }

        return new(PrintHubUpdateOutcome.Updated, $"อัปเดต Print Hub เป็นรุ่น {version} แล้ว", version);
    }

    private void TryRestoreBackup()
    {
        try
        {
            if (File.Exists(BackupPath)) File.Copy(BackupPath, AgentPath, overwrite: true);
        }
        catch
        {
            // คืนไม่ได้ก็ต้องไม่ทับข้อความผิดพลาดเดิมที่บอกสาเหตุจริง
        }
    }

    /// <summary>โฟลเดอร์ที่ตัวติดตั้งวาง agent ไว้ (ต้องตรงกับ $InstallRoot ใน install-windows.ps1)</summary>
    public static string DefaultInstallRoot(string localAppData) =>
        Path.Combine(localAppData, "StoreOSPrintHub");
}
