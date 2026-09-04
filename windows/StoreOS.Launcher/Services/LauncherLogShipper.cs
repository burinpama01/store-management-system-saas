using System.Collections.Concurrent;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace StoreOS.Launcher.Services;

/// <summary>เหตุการณ์หนึ่งบรรทัดที่ Launcher จะส่งกลับเซิร์ฟเวอร์</summary>
public sealed record LauncherLogEntry(
    [property: JsonPropertyName("at")] string At,
    [property: JsonPropertyName("level")] string Level,
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("context")] IReadOnlyDictionary<string, object>? Context);

/// <summary>ค่าเชื่อมต่อของร้าน อ่านจาก print-hub.config.json ที่ตัวติดตั้ง Print Hub วางไว้</summary>
public sealed record HubCredentials(string ServerUrl, string StoreId, string HubToken);

/// <summary>
/// ส่ง log ของ Launcher กลับเซิร์ฟเวอร์เพื่อไล่ปัญหาบนเครื่องร้านที่เราเข้าไปดูไม่ได้
///
/// กฎที่ยึด:
///   * ส่งเป็นก้อน (batch) ตามรอบ ไม่ยิงทีละบรรทัด — เน็ตร้านมักไม่นิ่ง
///   * ส่งไม่สำเร็จต้องไม่ทำให้ POS สะดุด: คิวมีเพดาน ล้นแล้วทิ้งของเก่าและนับไว้
///   * ห้ามส่งโทเค็น/เนื้องานพิมพ์ — ค่าที่ใส่ context ต้องเป็นสถานะ/ตัวเลขเท่านั้น
///     (ฝั่งเซิร์ฟเวอร์ยังกลบซ้ำอีกชั้น แต่ต้นทางต้องไม่ใส่มาตั้งแต่แรก)
/// </summary>
public sealed class LauncherLogShipper : IAsyncDisposable
{
    public const int MaxQueued = 200;
    public const int MaxPerRequest = 50;

    private readonly ConcurrentQueue<LauncherLogEntry> _queue = new();
    private readonly HttpClient _http;
    private readonly HubCredentials? _credentials;
    private readonly string _launcherVersion;
    private int _droppedByOverflow;

    public LauncherLogShipper(HubCredentials? credentials, string launcherVersion, HttpClient? http = null)
    {
        _credentials = credentials;
        _launcherVersion = launcherVersion;
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
    }

    public int QueuedCount => _queue.Count;
    public int DroppedByOverflow => _droppedByOverflow;

    /// <summary>บันทึกเหตุการณ์ลงคิว (ไม่บล็อก ไม่โยน exception ให้ UI)</summary>
    public void Enqueue(string level, string code, string message, IReadOnlyDictionary<string, object>? context = null)
    {
        _queue.Enqueue(new LauncherLogEntry(
            DateTimeOffset.Now.ToString("o"),
            level,
            code,
            message.Length > 300 ? message[..300] : message,
            context));

        // คิวล้น = ทิ้งของเก่าสุด แต่ต้องนับไว้ ไม่ใช่หายเงียบ
        while (_queue.Count > MaxQueued && _queue.TryDequeue(out _))
        {
            Interlocked.Increment(ref _droppedByOverflow);
        }
    }

    /// <summary>ดึงออกจากคิวได้มากสุดหนึ่งก้อน (แยกออกมาเพื่อให้ทดสอบได้โดยไม่ต้องมีเครือข่าย)</summary>
    public List<LauncherLogEntry> TakeBatch(int max = MaxPerRequest)
    {
        var batch = new List<LauncherLogEntry>();
        while (batch.Count < max && _queue.TryDequeue(out var entry))
        {
            batch.Add(entry);
        }
        return batch;
    }

    /// <summary>ส่งก้อนถัดไป คืน true เมื่อเซิร์ฟเวอร์รับแล้ว</summary>
    public async Task<bool> FlushAsync(CancellationToken cancellationToken = default)
    {
        if (_credentials is null) return false;
        var batch = TakeBatch();
        if (batch.Count == 0) return true;

        var payload = new
        {
            storeId = _credentials.StoreId,
            hubToken = _credentials.HubToken,
            launcherVersion = _launcherVersion,
            entries = batch,
        };

        try
        {
            var response = await _http.PostAsJsonAsync(
                $"{_credentials.ServerUrl.TrimEnd('/')}/api/launcher/logs",
                payload,
                cancellationToken);
            if (response.IsSuccessStatusCode) return true;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            // เน็ตร้านหลุดเป็นเรื่องปกติ — เก็บกลับเข้าคิวแล้วลองใหม่รอบหน้า
        }

        foreach (var entry in batch) _queue.Enqueue(entry);
        return false;
    }

    /// <summary>
    /// อ่าน storeId/hubToken จาก config ของ Print Hub บนเครื่องเดียวกัน
    /// (ไม่สร้างความลับชุดที่สองให้ต้องหมุนเวียนเพิ่ม — ดูเหตุผลใน api/launcher/logs)
    /// </summary>
    public static HubCredentials? ReadHubCredentials(string configPath)
    {
        try
        {
            if (!File.Exists(configPath)) return null;
            // ตัวติดตั้งบางรอบเขียนไฟล์พร้อม BOM — ตัดออกก่อน parse
            var json = File.ReadAllText(configPath).TrimStart('﻿');
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var serverUrl = root.TryGetProperty("serverUrl", out var s) ? s.GetString() : null;
            var storeId = root.TryGetProperty("storeId", out var st) ? st.GetString() : null;
            var hubToken = root.TryGetProperty("hubToken", out var t) ? t.GetString() : null;
            if (string.IsNullOrWhiteSpace(serverUrl) || string.IsNullOrWhiteSpace(storeId) || string.IsNullOrWhiteSpace(hubToken))
            {
                return null;
            }
            return new HubCredentials(serverUrl!, storeId!, hubToken!);
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            return null;
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            await FlushAsync();
        }
        catch
        {
            // ปิดโปรแกรมต้องไม่ค้างเพราะส่ง log ไม่ได้
        }
        _http.Dispose();
    }
}
