using System.IO;
using System.Net.Http;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using StoreOS.Launcher.Services;
using StoreOS.Launcher.Services.Audio;
using StoreOS.Launcher.Services.Update;

namespace StoreOS.Launcher;

/// <summary>
/// ส่วน "อุปกรณ์ของเครื่อง" ของหน้าต่างหลัก (0.5.0):
///   * เสียงแจ้งเตือนของ POS เล่นจาก Launcher ออกลำโพงที่เลือก (AlertPlayer)
///   * เพลงจาก /player ออกลำโพงที่เลือก (ProcessAudioRouter กับ process ของ WebView2)
///   * ตรวจ/ดาวน์โหลด/ติดตั้งอัปเดตตัวเอง (LauncherUpdateCoordinator)
/// แยกไฟล์ไว้เพื่อไม่ให้ MainWindow.xaml.cs โตจนอ่านไม่ออก — ต่อเข้ากับไฟล์หลักด้วย hook 4 จุด
/// </summary>
public partial class MainWindow
{
    private readonly WasapiDeviceCatalog _audioCatalog = new();
    private readonly ProcessAudioRouter _audioRouter = new();
    private readonly DispatcherTimer _musicTimer = new() { Interval = TimeSpan.FromSeconds(15) };
    private readonly HashSet<uint> _musicRoutedPids = new();
    private readonly DispatcherTimer _updateTimer = new() { Interval = TimeSpan.FromHours(6) };
    /// <summary>
    /// สร้างตอนใช้ครั้งแรก ห้ามเป็น static initializer: ลำดับ static ข้าม partial file ไม่รับประกัน
    /// (เคยพังจริงตอนทดสอบ 0.5.0 — LauncherVersion ยังเป็น null ทำให้ User-Agent ผิดรูป
    /// แล้ว MainWindow เปิดไม่ขึ้นทั้งตัว ตัวติดตั้งจึงย้อนกลับ)
    /// </summary>
    private static readonly Lazy<HttpClient> UpdateHttp = new(CreateUpdateHttp);

    private AlertPlayer? _alertPlayer;
    private LauncherUpdateCoordinator? _updates;
    private LauncherSettings _deviceSettings = LauncherSettings.Load();
    private string? _musicAppliedDevice;
    private bool _musicRouted;
    private bool _musicUnsupportedLogged;
    private bool _musicMissingLogged;
    private bool _healthyMarkerWritten;
    private string _updatePosUrl = new LauncherSettings().PosUrl;
    private string _updateChannel = "prod";

    private static HttpClient CreateUpdateHttp()
    {
        var http = new HttpClient { Timeout = TimeSpan.FromMinutes(20) };
        var version = typeof(MainWindow).Assembly.GetName().Version is { } v ? $"{v.Major}.{v.Minor}.{v.Build}" : "0.0.0";
        // TryAdd: header ผิดรูปต้องไม่มีทางทำให้หน้าต่างหลักเปิดไม่ขึ้น
        http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", $"StoreOSLauncher/{version}");
        return http;
    }

    /// <summary>hook 1 — เรียกจาก constructor</summary>
    private void InitDeviceFeatures()
    {
        _alertPlayer = new AlertPlayer(_audioCatalog, () => _deviceSettings, Log);
        _updates = new LauncherUpdateCoordinator(
            LauncherVersion,
            AppContext.BaseDirectory,
            UpdatePaths.Default(),
            UpdateHttp.Value,
            Log);
        _updates.StateChanged += (_, state) => Dispatcher.InvokeAsync(() => OnUpdateStateChanged(state));
        Closed += (_, _) =>
        {
            _musicTimer.Stop();
            _updateTimer.Stop();
            _alertPlayer?.Dispose();
        };
    }

    /// <summary>hook 2 — เรียกหลังตั้ง Web.Source (WebView2 พร้อมแล้ว)</summary>
    private void StartDeviceFeatures(string posUrl, string channel)
    {
        _updatePosUrl = posUrl;
        _updateChannel = channel;

        try
        {
            Web.CoreWebView2.Environment.ProcessInfosChanged += (_, _) => ApplyMusicRouting();
        }
        catch (Exception)
        {
            // WebView2 runtime เก่าที่ไม่มีอีเวนต์นี้ — ตัวจับเวลาด้านล่างยังครอบอยู่
        }
        _musicTimer.Tick += (_, _) => ApplyMusicRouting();
        _musicTimer.Start();
        ApplyMusicRouting();

        ReportLastUpdateResult();
        if (App.PostUpdateVersion is null)
        {
            UpdateDownloader.CleanupOlderThanOrEqual(UpdatePaths.Default(), LauncherVersion);
        }

        _updateTimer.Tick += async (_, _) => await CheckForUpdatesAsync();
        _updateTimer.Start();
        _suspendSignals.Resumed += (_, _) => Dispatcher.InvokeAsync(async () => await CheckForUpdatesAsync());
        // รอให้เครื่องเปิด POS เสร็จก่อน ค่อยตรวจครั้งแรก (ไม่แย่งเน็ต/ดิสก์ตอนเปิดร้าน)
        _ = Task.Delay(TimeSpan.FromMinutes(2)).ContinueWith(
            _ => Dispatcher.InvokeAsync(async () => await CheckForUpdatesAsync()),
            TaskScheduler.Default);
    }

    /// <summary>hook 3 — ข้อความของช่อง storeos.device; true = จัดการแล้ว ไม่ต้องส่งต่อ</summary>
    private bool TryHandleDeviceMessage(CoreWebView2WebMessageReceivedEventArgs e)
    {
        string? raw;
        try
        {
            raw = e.WebMessageAsJson;
        }
        catch (Exception)
        {
            return false;
        }

        var request = DeviceBridgeProtocol.Parse(raw);
        if (request is null) return false;
        if (!IsTrustedSource(e.Source)) return true; // ของช่องนี้แต่มาจากที่อื่น — ทิ้งเงียบ

        switch (request.Type)
        {
            case DeviceBridgeProtocol.HelloRequest:
                PostDevice(DeviceBridgeProtocol.Hello(LauncherVersion, Capabilities()));
                PostUpdateStatus();
                break;
            case DeviceBridgeProtocol.AlertPlay:
                _alertPlayer?.Play(request.Sound ?? AlertSoundIds.Order);
                break;
            case DeviceBridgeProtocol.AlertTest:
                var result = _alertPlayer?.Play(AlertSoundIds.Order);
                Log("info", "alert_test", result?.Played == true
                    ? $"ทดสอบเสียงแจ้งเตือนออก {result.DeviceName}"
                    : $"ทดสอบเสียงแจ้งเตือนไม่สำเร็จ: {result?.Error}");
                break;
            case DeviceBridgeProtocol.SpeakersGet:
                PostSpeakers();
                break;
            case DeviceBridgeProtocol.SpeakersSet:
                SaveSpeakers(request);
                break;
            case DeviceBridgeProtocol.UpdateCheck:
                _ = CheckForUpdatesAsync();
                break;
            case DeviceBridgeProtocol.UpdateInstall:
                ConfirmAndInstallUpdate();
                break;
        }
        return true;
    }

    /// <summary>hook 4 — รุ่นที่เพิ่งติดตั้งต้องบอกตัวติดตั้งว่า "เปิดได้จริง" ไม่งั้นโดนย้อนกลับ</summary>
    private void MarkHealthyAfterUpdate(bool navigationSucceeded)
    {
        if (_healthyMarkerWritten || !navigationSucceeded || App.PostUpdateVersion is not { } version) return;
        try
        {
            var paths = UpdatePaths.Default();
            Directory.CreateDirectory(paths.Root);
            File.WriteAllText(paths.HealthyMarker(version), DateTimeOffset.Now.ToString("O"));
            _healthyMarkerWritten = true;
            Log("info", "update_healthy", $"Launcher {version} เปิดหน้า POS ได้ — ยืนยันการอัปเดต");
        }
        catch (Exception ex)
        {
            Log("warn", "update_healthy_write_failed", $"เขียนไฟล์ยืนยันการอัปเดตไม่สำเร็จ: {ex.GetType().Name}");
        }
    }

    private IEnumerable<string> Capabilities()
    {
        yield return "alert-player";
        yield return "speakers";
        if (_audioRouter.IsSupported) yield return "music-routing";
        if (_updates?.Enabled == true) yield return "self-update";
    }

    private void PostDevice(string json)
    {
        try
        {
            Web.CoreWebView2?.PostWebMessageAsJson(json);
        }
        catch (Exception)
        {
            // หน้าเว็บกำลังเปลี่ยนหน้า — รอบหน้าหน้าเว็บจะถาม hello ใหม่เอง
        }
    }

    private IReadOnlyList<AudioOutputDevice> SafeDevices()
    {
        try
        {
            return _audioCatalog.ListOutputs();
        }
        catch (Exception)
        {
            return [];
        }
    }

    private void PostSpeakers() =>
        PostDevice(DeviceBridgeProtocol.Speakers(SafeDevices(), _deviceSettings, _audioRouter.IsSupported));

    private void SaveSpeakers(DeviceRequest request)
    {
        try
        {
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            // อ่านไฟล์ล่าสุดก่อนเสมอ — สวิตช์คำปลุกอาจเพิ่งถูกเปลี่ยนจากหน้าเว็บอีกทาง
            var updated = LauncherSettings.Load().WithSpeakers(request.AlertDeviceId, request.AlertVolume, request.MusicDeviceId);
            updated.Save(localAppData);
            _deviceSettings = updated;
            _musicMissingLogged = false;
            Log("info", "speakers_changed", "เปลี่ยนลำโพงเสียงแจ้งเตือน/เพลงของเครื่องนี้");
        }
        catch (Exception ex)
        {
            Log("warn", "speakers_save_failed", $"บันทึกค่าลำโพงไม่สำเร็จ: {ex.GetType().Name}");
        }
        ApplyMusicRouting();
        PostSpeakers();
    }

    /// <summary>
    /// ตั้งลำโพงของเพลงให้ process ของ WebView2 — ค่าเริ่มต้น (null) = ไม่แตะอะไรเลย
    /// ตั้งไว้แล้วค่อยเปลี่ยนกลับเป็นค่าเริ่มต้น = ล้างค่าให้ process ที่เคยตั้ง
    /// </summary>
    private void ApplyMusicRouting()
    {
        var desired = _deviceSettings.MusicOutputDeviceId;
        if (desired is null && !_musicRouted) return;

        if (!_audioRouter.IsSupported)
        {
            if (!_musicUnsupportedLogged)
            {
                _musicUnsupportedLogged = true;
                Log("warn", "music_routing_unsupported", "Windows เครื่องนี้ไม่รองรับการแยกลำโพงของเพลง — ให้ตั้งใน Volume mixer แทน");
            }
            return;
        }

        if (desired is not null && SafeDevices().All(d => !string.Equals(d.Id, desired, StringComparison.OrdinalIgnoreCase)))
        {
            // ลำโพงเพลงถูกถอด — ปล่อยให้ Windows ใช้ลำโพงหลักไปก่อน เสียบกลับเมื่อไหร่รอบถัดไปตั้งให้ใหม่
            if (!_musicMissingLogged)
            {
                _musicMissingLogged = true;
                Log("warn", "music_device_missing", "ลำโพงเพลงที่เลือกไม่อยู่ — ใช้ลำโพงหลักของ Windows ชั่วคราว");
            }
            desired = null;
        }

        if (!string.Equals(desired, _musicAppliedDevice, StringComparison.OrdinalIgnoreCase)) _musicRoutedPids.Clear();

        IEnumerable<uint> pids;
        try
        {
            var env = Web.CoreWebView2.Environment;
            pids = env.GetProcessInfos().Select(p => (uint)p.ProcessId)
                .Append(Web.CoreWebView2.BrowserProcessId)
                .Distinct()
                .ToList();
        }
        catch (Exception)
        {
            return;
        }

        foreach (var pid in pids)
        {
            if (_musicRoutedPids.Contains(pid)) continue;
            if (_audioRouter.TrySetProcessOutput(pid, desired)) _musicRoutedPids.Add(pid);
        }

        _musicAppliedDevice = desired;
        _musicRouted = desired is not null;
    }

    private async Task CheckForUpdatesAsync()
    {
        if (_updates is null || !_updates.Enabled) return;
        await _updates.CheckAndDownloadAsync(_updatePosUrl, _updateChannel, CancellationToken.None);
    }

    private void PostUpdateStatus()
    {
        var state = _updates?.State ?? new UpdateState("idle", null, null);
        PostDevice(DeviceBridgeProtocol.UpdateStatus(state.State, LauncherVersion, state.Version, state.Error));
    }

    private void OnUpdateStateChanged(UpdateState state)
    {
        PostUpdateStatus();
        switch (state.State)
        {
            case "downloading":
                ShowUpdateBar($"กำลังดาวน์โหลด Launcher รุ่นใหม่ {state.Version}…", showButtons: false);
                break;
            case "ready":
                ShowUpdateBar($"มี Launcher รุ่นใหม่ {state.Version} — จะติดตั้งเองตอนเปิดโปรแกรมครั้งถัดไป", showButtons: true);
                break;
            case "installing":
                ShowUpdateBar($"กำลังติดตั้ง {state.Version} — โปรแกรมจะเปิดใหม่เอง", showButtons: false);
                break;
            default:
                if (UpdatePanel.Tag as string != "result") UpdatePanel.Visibility = Visibility.Collapsed;
                break;
        }
    }

    private void ShowUpdateBar(string text, bool showButtons, string? tag = null)
    {
        UpdateText.Text = text;
        UpdateNowButton.Visibility = showButtons ? Visibility.Visible : Visibility.Collapsed;
        UpdateLaterButton.Visibility = Visibility.Visible;
        UpdateLaterButton.Content = showButtons ? "ภายหลัง" : "ปิด";
        UpdatePanel.Tag = tag;
        UpdatePanel.Visibility = Visibility.Visible;
    }

    private void OnUpdateNowClick(object sender, RoutedEventArgs e) => ConfirmAndInstallUpdate();

    private void OnUpdateLaterClick(object sender, RoutedEventArgs e)
    {
        UpdatePanel.Tag = null;
        UpdatePanel.Visibility = Visibility.Collapsed;
    }

    /// <summary>ติดตั้งตอนนี้ — ต้องให้คนยืนยันเสมอ (ปิดโปรแกรมกลางการขายไม่ได้)</summary>
    private void ConfirmAndInstallUpdate()
    {
        if (_updates is null || _updates.State.State != "ready") return;
        var answer = MessageBox.Show(
            this,
            $"ติดตั้ง StoreOS Launcher {_updates.State.Version} ตอนนี้เลยไหม?\n\n" +
            "โปรแกรมจะปิดแล้วเปิดใหม่เองภายในประมาณ 30 วินาที\n" +
            "ถ้ากำลังคิดเงินลูกค้าอยู่ ให้กด \"ไม่\" แล้วติดตั้งทีหลัง (หรือปล่อยให้ติดตั้งเองตอนเปิดโปรแกรมครั้งถัดไป)",
            "อัปเดต StoreOS Launcher",
            MessageBoxButton.YesNo,
            MessageBoxImage.Question,
            MessageBoxResult.No);
        if (answer != MessageBoxResult.Yes) return;

        if (_updates.TryStartInstall(new SystemUpdateProcessOps(), Environment.ProcessId))
        {
            // ปิดผ่าน Close() เพื่อให้ OnClosing คืนไมโครโฟน/ส่ง log ก่อน — ตัวติดตั้งรอให้ process นี้จบเอง
            Close();
        }
    }

    /// <summary>ผลของการติดตั้งรอบก่อน (ตัวติดตั้งเขียนไว้) — log ขึ้นเซิร์ฟเวอร์ และบอกคนหน้าร้านถ้าล้ม</summary>
    private void ReportLastUpdateResult()
    {
        var paths = UpdatePaths.Default();
        var result = paths.ReadResult();
        if (result is null) return;
        paths.ClearResult();

        var level = result.Outcome == "installed" ? "info" : "warn";
        Log(level, $"update_{result.Outcome}", $"ผลการอัปเดต Launcher {result.Version}: {result.Outcome}{(result.Error is null ? "" : $" ({result.Error})")}");
        if (result.Outcome == "installed")
        {
            ShowUpdateBar($"อัปเดตเป็น Launcher {result.Version} แล้ว", showButtons: false, tag: "result");
        }
        else if (result.Outcome == "rolled_back")
        {
            ShowUpdateBar($"ติดตั้ง Launcher {result.Version} ไม่สำเร็จ — กลับมาใช้รุ่นเดิมแล้ว (ใช้งานต่อได้ตามปกติ)", showButtons: false, tag: "result");
        }
    }
}
