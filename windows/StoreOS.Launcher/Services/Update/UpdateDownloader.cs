using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Security.Cryptography;

namespace StoreOS.Launcher.Services.Update;

public sealed class UpdateException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>
/// ดาวน์โหลดชุดอัปเดต ตรวจ SHA-256 แล้วแตกไว้ใน staging — ยังไม่แตะโปรแกรมที่รันอยู่
///
/// ขั้นนี้ทำเบื้องหลังระหว่างขายได้ ติดตั้งจริง (สลับโฟลเดอร์) เกิดตอนผู้ใช้กดเอง
/// หรือตอนเปิดโปรแกรมครั้งถัดไปเท่านั้น
/// </summary>
public sealed class UpdateDownloader(HttpClient http, UpdatePaths paths)
{
    public async Task<StagedUpdate> DownloadAndStageAsync(UpdateManifest manifest, CancellationToken ct)
    {
        var existing = paths.ReadPending();
        var appDir = paths.StagingAppDir(manifest.Version);
        if (existing?.Version == manifest.Version && File.Exists(Path.Combine(appDir, UpdatePaths.ExeName)))
        {
            return existing; // ดาวน์โหลด+ตรวจไว้แล้ว (เช่นเปิดโปรแกรมใหม่ก่อนกดติดตั้ง)
        }

        Directory.CreateDirectory(paths.Root);
        var zip = paths.ZipPath(manifest.Version);
        var part = zip + ".part";

        using (var response = await http.GetAsync(manifest.Url, HttpCompletionOption.ResponseHeadersRead, ct))
        {
            if (!response.IsSuccessStatusCode)
            {
                throw new UpdateException("download_failed", $"ดาวน์โหลดไม่สำเร็จ (HTTP {(int)response.StatusCode})");
            }

            await using var source = await response.Content.ReadAsStreamAsync(ct);
            await using var target = File.Create(part);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[81920];
            long total = 0;
            int read;
            while ((read = await source.ReadAsync(buffer, ct)) > 0)
            {
                total += read;
                if (total > manifest.Size || total > LauncherUpdatePolicy.MaxPackageBytes)
                {
                    throw new UpdateException("size_mismatch", "ไฟล์ใหญ่กว่าที่ประกาศไว้");
                }
                hash.AppendData(buffer, 0, read);
                await target.WriteAsync(buffer.AsMemory(0, read), ct);
            }

            var actual = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            if (total != manifest.Size || actual != manifest.Sha256)
            {
                target.Close();
                TryDelete(part);
                throw new UpdateException("sha256_mismatch", "ไฟล์ที่ดาวน์โหลดไม่ตรงกับที่เซิร์ฟเวอร์ประกาศ — ทิ้งไฟล์แล้ว");
            }
        }

        File.Move(part, zip, overwrite: true);

        var staging = paths.StagingDir(manifest.Version);
        if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
        // ExtractToDirectory ของ .NET ปฏิเสธ entry ที่พยายามเขียนออกนอกโฟลเดอร์ (zip slip) อยู่แล้ว
        ZipFile.ExtractToDirectory(zip, staging);

        if (!File.Exists(Path.Combine(appDir, UpdatePaths.ExeName)))
        {
            throw new UpdateException("bad_package", "ชุดอัปเดตไม่มีตัวโปรแกรมในโฟลเดอร์ app");
        }

        TryDelete(zip); // แตกแล้วไม่ต้องเก็บ zip (ประหยัดดิสก์ ~115 MB)
        var staged = new StagedUpdate(manifest.Version, appDir);
        paths.WritePending(staged);
        return staged;
    }

    /// <summary>ล้าง staging/zip ของรุ่นที่ติดตั้งแล้วหรือเก่ากว่า — เรียกตอน Launcher เปิดสำเร็จ</summary>
    public static void CleanupOlderThanOrEqual(UpdatePaths paths, string currentVersion)
    {
        try
        {
            if (!Directory.Exists(paths.Root)) return;
            foreach (var dir in Directory.GetDirectories(paths.Root, "staging-*"))
            {
                var version = Path.GetFileName(dir)["staging-".Length..];
                if (!LauncherUpdatePolicy.IsNewer(currentVersion, version)) Directory.Delete(dir, recursive: true);
            }
            foreach (var file in Directory.GetFiles(paths.Root, "storeos-launcher-*.zip*")) TryDelete(file);
            foreach (var file in Directory.GetFiles(paths.Root, "healthy-*")) TryDelete(file);
        }
        catch (Exception)
        {
            // ล้างไม่หมดรอบนี้ ไม่เป็นไร
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception)
        {
            // ไฟล์ถูกล็อกอยู่ — รอบหน้าค่อยลบ
        }
    }
}
