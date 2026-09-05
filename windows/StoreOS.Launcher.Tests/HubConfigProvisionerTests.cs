using System.IO;
using System.Text.Json;
using StoreOS.Launcher.Services;
using Xunit;

namespace StoreOS.Launcher.Tests;

/// <summary>
/// Print Hub auto-provision — เครื่องร้านต้องหาย 401 ได้เองตอนเปิด Launcher
/// โดยไม่ไปเตะเครื่องอื่นหลุด และไม่เขียนทับ config ดี ๆ ทิ้ง
/// </summary>
public class HubConfigProvisionerTests
{
    private static string Wrap(object envelope) =>
        JsonSerializer.Serialize(JsonSerializer.Serialize(envelope));

    [Fact]
    public void Device_id_is_stable_for_the_same_machine()
    {
        var first = HubConfigProvisioner.DeviceId("abc-123", "CASHIER-PC");
        var second = HubConfigProvisioner.DeviceId("abc-123", "CASHIER-PC");
        Assert.Equal(first, second);
    }

    [Fact]
    public void Device_id_differs_between_machines()
    {
        Assert.NotEqual(
            HubConfigProvisioner.DeviceId("abc-123", "PC-A"),
            HubConfigProvisioner.DeviceId("def-456", "PC-B"));
    }

    [Fact]
    public void Device_id_never_leaks_the_raw_machine_guid()
    {
        var id = HubConfigProvisioner.DeviceId("abc-123", "CASHIER-PC");
        Assert.DoesNotContain("abc-123", id);
        Assert.Equal(64, id.Length); // sha256 hex
    }

    [Fact]
    public void Device_id_still_works_without_a_machine_guid()
    {
        var id = HubConfigProvisioner.DeviceId(null, "CASHIER-PC");
        Assert.Equal(64, id.Length);
        Assert.Equal(id, HubConfigProvisioner.DeviceId(null, "CASHIER-PC"));
    }

    [Fact]
    public void Script_sends_the_device_and_current_token()
    {
        var script = HubConfigProvisioner.BuildProvisionScript("dev-1", "CASHIER-PC", "tok-old");
        Assert.Contains("/api/print/hub/provision", script);
        Assert.Contains("dev-1", script);
        Assert.Contains("tok-old", script);
        Assert.Contains("no-store", script);
    }

    [Fact]
    public void Rotated_response_yields_config_to_write()
    {
        var body = JsonSerializer.Serialize(new
        {
            ok = true,
            rotated = true,
            config = new { serverUrl = "https://www.store-os.online", storeId = "s1", hubToken = "new", pollIntervalMs = 2500 },
        });
        var outcome = HubConfigProvisioner.Interpret(Wrap(new { status = 200, body }));

        Assert.True(outcome.Rotated);
        Assert.Contains("\"hubToken\"", outcome.ConfigJson);
        Assert.Equal("rotated", outcome.Reason);
    }

    [Fact]
    public void Valid_token_means_do_not_touch_the_config()
    {
        var body = JsonSerializer.Serialize(new { ok = true, rotated = false, config = (object?)null });
        var outcome = HubConfigProvisioner.Interpret(Wrap(new { status = 200, body }));

        Assert.False(outcome.Rotated);
        Assert.Null(outcome.ConfigJson);
        Assert.Equal("already_valid", outcome.Reason);
    }

    [Theory]
    [InlineData(401, "not_signed_in")]
    [InlineData(403, "no_permission")]
    [InlineData(0, "network_error")]
    [InlineData(500, "http_500")]
    public void Failures_never_overwrite_the_existing_config(int status, string expectedReason)
    {
        var outcome = HubConfigProvisioner.Interpret(Wrap(new { status, body = "" }));
        Assert.False(outcome.Rotated);
        Assert.Null(outcome.ConfigJson);
        Assert.Equal(expectedReason, outcome.Reason);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not json")]
    public void Unreadable_results_are_fail_closed(string? result)
    {
        var outcome = HubConfigProvisioner.Interpret(result);
        Assert.False(outcome.Rotated);
        Assert.Null(outcome.ConfigJson);
    }

    [Fact]
    public void Server_saying_not_ok_is_rejected()
    {
        var body = JsonSerializer.Serialize(new { ok = false, reason = "provision_failed" });
        var outcome = HubConfigProvisioner.Interpret(Wrap(new { status = 200, body }));
        Assert.False(outcome.Rotated);
        Assert.Equal("server_rejected", outcome.Reason);
    }

    [Fact]
    public void Rotated_without_config_is_treated_as_failure()
    {
        var body = JsonSerializer.Serialize(new { ok = true, rotated = true });
        var outcome = HubConfigProvisioner.Interpret(Wrap(new { status = 200, body }));
        Assert.False(outcome.Rotated);
        Assert.Equal("missing_config", outcome.Reason);
    }

    [Fact]
    public void Config_is_written_atomically_and_replaces_the_old_one()
    {
        var dir = Path.Combine(Path.GetTempPath(), "storeos-hub-test-" + Guid.NewGuid().ToString("N"));
        var path = Path.Combine(dir, "print-hub.config.json");
        try
        {
            HubConfigProvisioner.WriteConfigAtomic(path, "{\"hubToken\":\"one\"}");
            Assert.Equal("{\"hubToken\":\"one\"}", File.ReadAllText(path));

            HubConfigProvisioner.WriteConfigAtomic(path, "{\"hubToken\":\"two\"}");
            Assert.Equal("{\"hubToken\":\"two\"}", File.ReadAllText(path));

            // ไม่ทิ้งไฟล์ชั่วคราวไว้
            Assert.False(File.Exists(path + ".tmp"));
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Config_is_written_without_a_bom()
    {
        var dir = Path.Combine(Path.GetTempPath(), "storeos-hub-test-" + Guid.NewGuid().ToString("N"));
        var path = Path.Combine(dir, "print-hub.config.json");
        try
        {
            HubConfigProvisioner.WriteConfigAtomic(path, "{\"a\":1}");
            var bytes = File.ReadAllBytes(path);
            // Node อ่าน JSON ที่มี BOM ไม่ออก — ตัวติดตั้งเก่าเคยพลาดตรงนี้มาแล้ว
            Assert.False(bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF);
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    /// <summary>
    /// เครื่องร้าน 2026-09-05: Launcher เปิดมาเจอหน้าล็อกอินก่อนเสมอ
    /// ผลตอนนั้นคือ not_signed_in ซึ่ง "ห้าม" นับว่าจบ ไม่งั้นล็อกอินเสร็จแล้วไม่มีใครขอ token ใหม่
    /// </summary>
    [Theory]
    [InlineData(401, "not_signed_in")]
    [InlineData(0, "network_error")]
    public void ยังไม่ล็อกอินหรือเน็ตหลุด_ต้องไม่ถือว่าจบ(int status, string expected)
    {
        var raw = JsonSerializer.Serialize(
            JsonSerializer.Serialize(new { status, body = "" }));
        Assert.Equal(expected, HubConfigProvisioner.Interpret(raw).Reason);
    }
}
