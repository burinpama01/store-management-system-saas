using System.IO;
using System.Net.Http;

namespace StoreOS.Launcher.Services.Update;

/// <summary>สถานะที่แถบของ Launcher และหน้าเว็บแสดง</summary>
public sealed record UpdateState(string State, string? Version, string? Error);

/// <summary>
/// ตัดสินว่าจะตรวจ/ดาวน์โหลด/ติดตั้งเมื่อไหร่ (L2: ไม่ปิดโปรแกรมเองกลางวัน)
///   * ตรวจ + ดาวน์โหลดเบื้องหลังได้ทุกเมื่อ (ไม่แตะโปรแกรมที่รันอยู่)
///   * ติดตั้งเมื่อผู้ใช้กด "อัปเดตตอนนี้" หรือตอนเปิดโปรแกรมครั้งถัดไป (ก่อนหน้าต่างขึ้น)
///   * รุ่นที่เคยย้อนกลับแล้วไม่ลองซ้ำ จนกว่าจะมีรุ่นที่ใหม่กว่า
/// </summary>
public sealed class LauncherUpdateCoordinator
{
    private readonly string _currentVersion;
    private readonly string _installDir;
    private readonly UpdatePaths _paths;
    private readonly HttpClient _http;
    private readonly Action<string, string, string> _log;
    private readonly SemaphoreSlim _busy = new(1, 1);

    public LauncherUpdateCoordinator(
        string currentVersion,
        string installDir,
        UpdatePaths paths,
        HttpClient http,
        Action<string, string, string> log)
    {
        _currentVersion = currentVersion;
        _installDir = installDir;
        _paths = paths;
        _http = http;
        _log = log;
    }

    public UpdateState State { get; private set; } = new("idle", null, null);
    public event EventHandler<UpdateState>? StateChanged;

    public static bool IsManagedInstall(string installDir) => LauncherUpdatePolicy.IsManagedInstall(
        installDir, Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));

    public bool Enabled => IsManagedInstall(_installDir);

    /// <summary>ตรวจรุ่นใหม่แล้วดาวน์โหลดเก็บไว้ — ปลอดภัยที่จะเรียกซ้ำ/พร้อมกัน</summary>
    public async Task CheckAndDownloadAsync(string posUrl, string channel, CancellationToken ct)
    {
        if (!Enabled) return;
        if (!await _busy.WaitAsync(0, ct)) return;
        try
        {
            var pending = _paths.ReadPending();
            if (pending is not null && IsInstallable(pending))
            {
                Set("ready", pending.Version, null);
                return;
            }

            Set("checking", null, null);
            var json = await _http.GetStringAsync(LauncherUpdatePolicy.ManifestUrl(posUrl, channel), ct);
            var manifest = LauncherUpdatePolicy.ParseManifest(json);
            if (manifest is null)
            {
                _log("warn", "update_manifest_invalid", "ข้อมูลรุ่นล่าสุดจากเซิร์ฟเวอร์ใช้ไม่ได้ — ข้ามรอบนี้");
                Set("failed", null, "manifest_invalid");
                return;
            }

            if (!LauncherUpdatePolicy.IsNewer(_currentVersion, manifest.Version)
                || _paths.ReadRolledBackVersion() == manifest.Version)
            {
                Set("up_to_date", null, null);
                return;
            }

            _log("info", "update_available", $"มี Launcher รุ่นใหม่ {manifest.Version} — กำลังดาวน์โหลด");
            Set("downloading", manifest.Version, null);
            var staged = await new UpdateDownloader(_http, _paths).DownloadAndStageAsync(manifest, ct);
            _log("info", "update_ready", $"ดาวน์โหลดและตรวจ Launcher {staged.Version} แล้ว พร้อมติดตั้ง");
            Set("ready", staged.Version, null);
        }
        catch (UpdateException ex)
        {
            _log("warn", "update_download_failed", $"{ex.Code}: {ex.Message}");
            Set("failed", State.Version, ex.Code);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException or InvalidDataException)
        {
            // เน็ตหลุด/ดิสก์เต็ม — รอรอบหน้า ไม่ต้องรบกวนหน้าร้าน
            _log("info", "update_check_skipped", $"ตรวจอัปเดตไม่สำเร็จรอบนี้: {ex.GetType().Name}");
            Set("failed", State.Version, ex.GetType().Name);
        }
        finally
        {
            _busy.Release();
        }
    }

    /// <summary>เริ่มตัวติดตั้งของรุ่นที่พร้อมแล้ว — true = ผู้เรียกต้องปิด Launcher ตัวนี้ทันที</summary>
    public bool TryStartInstall(IUpdateProcessOps ops, int currentPid)
    {
        var pending = _paths.ReadPending();
        if (!Enabled || pending is null || !IsInstallable(pending)) return false;

        var options = new ApplyOptions(_installDir, pending.AppDir, currentPid, pending.Version);
        var pid = ops.Start(Path.Combine(pending.AppDir, UpdatePaths.ExeName), UpdateApplier.BuildArgs(options));
        if (pid is null)
        {
            _log("warn", "update_install_start_failed", $"เปิดตัวติดตั้ง {pending.Version} ไม่สำเร็จ");
            Set("failed", pending.Version, "installer_start_failed");
            return false;
        }

        _log("info", "update_installing", $"กำลังติดตั้ง Launcher {pending.Version} (โปรแกรมจะเปิดใหม่เอง)");
        Set("installing", pending.Version, null);
        return true;
    }

    private bool IsInstallable(StagedUpdate pending) =>
        LauncherUpdatePolicy.IsNewer(_currentVersion, pending.Version)
        && _paths.ReadRolledBackVersion() != pending.Version
        && File.Exists(Path.Combine(pending.AppDir, UpdatePaths.ExeName));

    private void Set(string state, string? version, string? error)
    {
        State = new UpdateState(state, version, error);
        StateChanged?.Invoke(this, State);
    }
}
