using System.IO;
using System.Text.Json;
using StoreOS.Launcher.Services;
using Xunit;

namespace StoreOS.Launcher.Tests;

/// <summary>
/// log ที่ส่งกลับเซิร์ฟเวอร์ต้อง: ไม่ทำให้ POS สะดุด, ไม่ท่วมเน็ตร้าน และไม่มีความลับติดไป
/// </summary>
public class LauncherLogShipperTests
{
    private static LauncherLogShipper NewShipper() =>
        new(new HubCredentials("https://example.test", "store-1", "token"), "0.1.0");

    [Fact]
    public void Queue_is_capped_and_overflow_is_counted_not_silent()
    {
        var shipper = NewShipper();

        for (var i = 0; i < LauncherLogShipper.MaxQueued + 25; i++)
        {
            shipper.Enqueue("info", "tick", $"event {i}");
        }

        Assert.Equal(LauncherLogShipper.MaxQueued, shipper.QueuedCount);
        Assert.Equal(25, shipper.DroppedByOverflow);
    }

    [Fact]
    public void Batch_size_is_bounded_so_one_request_stays_small()
    {
        var shipper = NewShipper();
        for (var i = 0; i < 120; i++) shipper.Enqueue("info", "tick", "x");

        var batch = shipper.TakeBatch();

        Assert.Equal(LauncherLogShipper.MaxPerRequest, batch.Count);
    }

    [Fact]
    public void Long_messages_are_truncated_at_the_source()
    {
        var shipper = NewShipper();
        shipper.Enqueue("error", "hub_start_failed", new string('x', 5000));

        var entry = Assert.Single(shipper.TakeBatch());

        Assert.Equal(300, entry.Message.Length);
    }

    [Fact]
    public void Entries_serialize_with_the_field_names_the_server_expects()
    {
        var shipper = NewShipper();
        shipper.Enqueue("warn", "webview2_missing", "ไม่พบ WebView2", new Dictionary<string, object> { ["taskState"] = "Missing" });

        var json = JsonSerializer.Serialize(shipper.TakeBatch());

        Assert.Contains("\"code\":\"webview2_missing\"", json);
        Assert.Contains("\"level\":\"warn\"", json);
        Assert.Contains("\"context\":{\"taskState\":\"Missing\"}", json);
    }

    [Fact]
    public void Reading_hub_credentials_tolerates_missing_and_broken_config()
    {
        var dir = Directory.CreateTempSubdirectory().FullName;
        var missing = Path.Combine(dir, "print-hub.config.json");
        Assert.Null(LauncherLogShipper.ReadHubCredentials(missing));

        File.WriteAllText(missing, "{ not json");
        Assert.Null(LauncherLogShipper.ReadHubCredentials(missing));

        File.WriteAllText(missing, "{\"serverUrl\":\"https://x\",\"storeId\":\"s\"}");
        Assert.Null(LauncherLogShipper.ReadHubCredentials(missing)); // ขาด hubToken

        File.WriteAllText(missing, "{\"serverUrl\":\"https://x\",\"storeId\":\"s\",\"hubToken\":\"t\"}");
        var credentials = LauncherLogShipper.ReadHubCredentials(missing);
        Assert.NotNull(credentials);
        Assert.Equal("s", credentials!.StoreId);
    }

    [Fact]
    public async Task Flush_without_credentials_does_not_throw()
    {
        var shipper = new LauncherLogShipper(null, "0.1.0");
        shipper.Enqueue("info", "launcher_started", "เปิดโปรแกรม");

        var sent = await shipper.FlushAsync();

        Assert.False(sent);
        Assert.Equal(1, shipper.QueuedCount); // เก็บไว้รอจนกว่าจะติดตั้ง Print Hub
    }
}
