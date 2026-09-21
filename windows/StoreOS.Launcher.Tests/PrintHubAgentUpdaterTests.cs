using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using StoreOS.Launcher.Services;
using Xunit;

namespace StoreOS.Launcher.Tests;

/// <summary>
/// Launcher อัปเดตไฟล์ agent ของ Print Hub ให้เครื่องร้าน
///
/// สิ่งที่ห้ามพังเด็ดขาด: ร้านต้องไม่ตื่นมาเจอ Print Hub ที่รันไม่ได้ ทุกทางที่ล้มเหลว
/// จึงต้องจบลงด้วย agent ตัวเดิมที่ใช้งานได้ และ config ของร้านต้องไม่ถูกแตะ
/// </summary>
public class PrintHubAgentUpdaterTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "storeos-hub-update-" + Guid.NewGuid().ToString("N"));

    public PrintHubAgentUpdaterTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { /* best effort */ }
        GC.SuppressFinalize(this);
    }

    private string AgentPath => Path.Combine(_root, "print-hub.mjs");
    private string ConfigPath => Path.Combine(_root, "print-hub.config.json");

    private void InstallExistingAgent(string content = "// agent เดิม")
    {
        File.WriteAllText(AgentPath, content, Encoding.UTF8);
        File.WriteAllText(ConfigPath, "{\"hubToken\":\"เดิมห้ามหาย\"}", Encoding.UTF8);
    }

    private static byte[] BuildZip(string agentContent)
    {
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            var entry = zip.CreateEntry("storeos-print-hub/print-hub.mjs");
            using var stream = entry.Open();
            var bytes = Encoding.UTF8.GetBytes(agentContent);
            stream.Write(bytes, 0, bytes.Length);
        }
        return buffer.ToArray();
    }

    private static string Sha256Hex(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    /// <summary>HttpClient ปลอม: ตอบ manifest ที่ URL หนึ่ง และไฟล์ zip ที่อีก URL หนึ่ง</summary>
    private static HttpClient FakeHttp(string manifestJson, byte[]? zip, HttpStatusCode zipStatus = HttpStatusCode.OK) =>
        new(new StubHandler(manifestJson, zip, zipStatus));

    private sealed class StubHandler(string manifestJson, byte[]? zip, HttpStatusCode zipStatus) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("agent-latest", StringComparison.Ordinal))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(manifestJson, Encoding.UTF8, "application/json"),
                });
            }
            if (zip is null) return Task.FromResult(new HttpResponseMessage(zipStatus));
            return Task.FromResult(new HttpResponseMessage(zipStatus) { Content = new ByteArrayContent(zip) });
        }
    }

    /// <summary>ตัวคุม agent ปลอม — จำว่าถูกสั่งหยุด/เริ่มกี่ครั้ง</summary>
    private sealed class FakeTask(bool stopSucceeds = true, bool startSucceeds = true)
    {
        public int Stops { get; private set; }
        public int Starts { get; private set; }
        public bool StopAndWait(TimeSpan timeout)
        {
            Stops += 1;
            return stopSucceeds;
        }
        public bool Start()
        {
            Starts += 1;
            return startSucceeds;
        }
    }

    private PrintHubAgentUpdater NewUpdater(HttpClient http, FakeTask task) =>
        new(http, task.StopAndWait, task.Start, _root);

    private static string Manifest(string version, byte[] zip, string? sha = null, long? size = null) =>
        JsonSerializer.Serialize(new
        {
            version,
            url = "https://www.store-os.online/downloads/storeos-print-hub.zip",
            sha256 = sha ?? Sha256Hex(zip),
            size = size ?? zip.LongLength,
            notes = "ทดสอบ",
        });

    [Fact]
    public async Task Skips_when_installed_version_is_unknown()
    {
        InstallExistingAgent();
        var zip = BuildZip("// ใหม่");
        var updater = NewUpdater(FakeHttp(Manifest("1.4.0", zip), zip), new FakeTask());

        var result = await updater.EnsureLatestAsync(null, "https://x.test/api/print/hub/agent-latest", default);

        Assert.Equal(PrintHubUpdateOutcome.UpToDate, result.Outcome);
        Assert.Equal("// agent เดิม", File.ReadAllText(AgentPath));
    }

    [Fact]
    public async Task Skips_when_agent_is_not_installed_on_this_machine()
    {
        var zip = BuildZip("// ใหม่");
        var updater = NewUpdater(FakeHttp(Manifest("1.4.0", zip), zip), new FakeTask());

        var result = await updater.EnsureLatestAsync("1.3.1", "https://x.test/api/print/hub/agent-latest", default);

        Assert.Equal(PrintHubUpdateOutcome.UpToDate, result.Outcome);
        Assert.False(File.Exists(AgentPath));
    }

    [Fact]
    public async Task Does_nothing_when_versions_match()
    {
        InstallExistingAgent();
        var zip = BuildZip("// ใหม่");
        var task = new FakeTask();
        var updater = NewUpdater(FakeHttp(Manifest("1.4.0", zip), zip), task);

        var result = await updater.EnsureLatestAsync("1.4.0", "https://x.test/api/print/hub/agent-latest", default);

        Assert.Equal(PrintHubUpdateOutcome.UpToDate, result.Outcome);
        Assert.Equal(0, task.Stops);
        Assert.Equal("// agent เดิม", File.ReadAllText(AgentPath));
    }

    [Fact]
    public async Task Rejects_package_whose_hash_does_not_match()
    {
        InstallExistingAgent();
        var zip = BuildZip("// ใหม่");
        var wrongSha = new string('a', 64);
        var updater = NewUpdater(FakeHttp(Manifest("1.4.0", zip, sha: wrongSha), zip), new FakeTask());

        var result = await updater.EnsureLatestAsync("1.3.1", "https://x.test/api/print/hub/agent-latest", default);

        Assert.Equal(PrintHubUpdateOutcome.Failed, result.Outcome);
        // ของเดิมต้องอยู่ครบ — ไฟล์ที่ตรวจไม่ผ่านห้ามแตะ agent ที่ใช้งานได้
        Assert.Equal("// agent เดิม", File.ReadAllText(AgentPath));
    }

    [Fact]
    public async Task Rejects_manifest_that_is_not_https()
    {
        InstallExistingAgent();
        var zip = BuildZip("// ใหม่");
        var manifest = JsonSerializer.Serialize(new
        {
            version = "1.4.0",
            url = "http://insecure.test/storeos-print-hub.zip",
            sha256 = Sha256Hex(zip),
            size = zip.LongLength,
        });
        var updater = NewUpdater(FakeHttp(manifest, zip), new FakeTask());

        var result = await updater.EnsureLatestAsync("1.3.1", "https://x.test/api/print/hub/agent-latest", default);

        Assert.Equal(PrintHubUpdateOutcome.Failed, result.Outcome);
        Assert.Equal("// agent เดิม", File.ReadAllText(AgentPath));
    }

    [Fact]
    public async Task Does_not_overwrite_when_the_agent_cannot_be_stopped()
    {
        InstallExistingAgent();
        var zip = BuildZip("// ใหม่");
        var task = new FakeTask(stopSucceeds: false);
        var updater = NewUpdater(FakeHttp(Manifest("1.4.0", zip), zip), task);

        var result = await updater.EnsureLatestAsync("1.3.1", "https://x.test/api/print/hub/agent-latest", default);

        Assert.Equal(PrintHubUpdateOutcome.Failed, result.Outcome);
        Assert.Equal("// agent เดิม", File.ReadAllText(AgentPath));
        Assert.Equal(0, task.Starts);
    }

    [Fact]
    public async Task Replaces_only_the_agent_file_and_restarts_the_task()
    {
        InstallExistingAgent();
        var zip = BuildZip("// agent ใหม่ 1.4.0");
        var task = new FakeTask();
        var updater = NewUpdater(FakeHttp(Manifest("1.4.0", zip), zip), task);

        var result = await updater.EnsureLatestAsync("1.3.1", "https://x.test/api/print/hub/agent-latest", default);

        Assert.Equal(PrintHubUpdateOutcome.Updated, result.Outcome);
        Assert.Equal("1.4.0", result.Version);
        Assert.Equal("// agent ใหม่ 1.4.0", File.ReadAllText(AgentPath));
        // config ของร้านต้องไม่ถูกแตะ — token อยู่ในนั้น
        Assert.Contains("เดิมห้ามหาย", File.ReadAllText(ConfigPath));
        Assert.Equal(1, task.Stops);
        Assert.Equal(1, task.Starts);
    }

    [Fact]
    public async Task Restores_the_previous_agent_when_the_task_will_not_start_again()
    {
        InstallExistingAgent();
        var zip = BuildZip("// agent ใหม่");
        var task = new FakeTask(startSucceeds: false);
        var updater = NewUpdater(FakeHttp(Manifest("1.4.0", zip), zip), task);

        var result = await updater.EnsureLatestAsync("1.3.1", "https://x.test/api/print/hub/agent-latest", default);

        Assert.Equal(PrintHubUpdateOutcome.Failed, result.Outcome);
        Assert.Equal("// agent เดิม", File.ReadAllText(AgentPath));
    }

    [Fact]
    public void Install_root_matches_the_installer_layout()
    {
        Assert.Equal(
            Path.Combine("C:\\Users\\x\\AppData\\Local", "StoreOSPrintHub"),
            PrintHubAgentUpdater.DefaultInstallRoot("C:\\Users\\x\\AppData\\Local"));
    }
}
