using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using StoreOS.Launcher.Services.Update;
using Xunit;

namespace StoreOS.Launcher.Tests;

public class LauncherUpdateTests : IDisposable
{
    private const string Prefix = LauncherUpdatePolicy.AllowedDownloadPrefix;
    private readonly string _root = Path.Combine(Path.GetTempPath(), "storeos-update-tests-" + Guid.NewGuid().ToString("N"));

    public LauncherUpdateTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (Exception)
        {
            // temp ของเทสต์ — ลบไม่ได้ไม่เป็นไร
        }
    }

    private static string Url(string v) => $"{Prefix}{v}/storeos-launcher-{v}.zip";

    private static string ManifestJson(string version, string? url = null, string? sha = null, long size = 1000) =>
        $$"""{"version":"{{version}}","url":"{{url ?? Url(version)}}","sha256":"{{sha ?? new string('a', 64)}}","size":{{size}},"notes":"แก้บั๊ก"}""";

    [Fact]
    public void Manifest_AcceptsOnlyOurReleaseForThatExactVersion()
    {
        Assert.NotNull(LauncherUpdatePolicy.ParseManifest(ManifestJson("0.5.1")));
        Assert.Null(LauncherUpdatePolicy.ParseManifest(ManifestJson("0.5.1", url: Url("0.5.0")))); // tag ไม่ตรงรุ่น
        Assert.Null(LauncherUpdatePolicy.ParseManifest(ManifestJson("0.5.1", url: "https://evil.example/storeos-launcher-0.5.1.zip")));
        Assert.Null(LauncherUpdatePolicy.ParseManifest(ManifestJson("0.5.1", url: Url("0.5.1").Replace("https://", "http://"))));
        Assert.Null(LauncherUpdatePolicy.ParseManifest(ManifestJson("0.5.1", sha: "xyz")));
        Assert.Null(LauncherUpdatePolicy.ParseManifest(ManifestJson("0.5.1", size: 0)));
        Assert.Null(LauncherUpdatePolicy.ParseManifest(ManifestJson("0.5.1", size: LauncherUpdatePolicy.MaxPackageBytes + 1)));
        Assert.Null(LauncherUpdatePolicy.ParseManifest(ManifestJson("latest")));
        Assert.Null(LauncherUpdatePolicy.ParseManifest("not json"));
    }

    [Fact]
    public void Versions_OnlyMoveForward()
    {
        Assert.True(LauncherUpdatePolicy.IsNewer("0.5.0", "0.5.1"));
        Assert.True(LauncherUpdatePolicy.IsNewer("0.5.9", "0.10.0"));
        Assert.False(LauncherUpdatePolicy.IsNewer("0.5.0", "0.5.0"));
        Assert.False(LauncherUpdatePolicy.IsNewer("0.5.0", "0.4.9"));
        Assert.False(LauncherUpdatePolicy.IsNewer("0.5.0", "garbage"));
    }

    [Fact]
    public void ManifestUrl_UsesThePosOrigin()
    {
        Assert.Equal(
            "https://www.store-os.online/api/launcher/latest?channel=prod",
            LauncherUpdatePolicy.ManifestUrl("https://www.store-os.online/pos", "prod"));
    }

    [Fact]
    public void OnlyTheStandardInstallUpdatesItself()
    {
        var local = Path.Combine(_root, "LocalAppData");
        Assert.True(LauncherUpdatePolicy.IsManagedInstall(Path.Combine(local, "StoreOS", "Launcher") + "\\", local));
        Assert.False(LauncherUpdatePolicy.IsManagedInstall(@"D:\build\StoreOS.Launcher\bin", local));
    }

    [Fact]
    public void ApplyArgs_RoundTrip()
    {
        var options = new ApplyOptions(@"C:\Users\x\AppData\Local\StoreOS\Launcher", @"C:\u\staging-0.5.1\app", 4242, "0.5.1");
        Assert.Equal(options, UpdateApplier.ParseArgs(UpdateApplier.BuildArgs(options)));
        Assert.Null(UpdateApplier.ParseArgs(["--post-update", "0.5.1"]));
        Assert.Null(UpdateApplier.ParseArgs(["--apply-update", "--install-dir", "x"]));
    }

    private (byte[] Zip, string Sha) BuildPackage(string version)
    {
        using var ms = new MemoryStream();
        using (var archive = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, content) in new[] { ("app/StoreOS.Launcher.exe", $"exe {version}"), ("app/vosk-model/conf", "m"), ("install.cmd", "x") })
            {
                using var writer = new StreamWriter(archive.CreateEntry(name).Open());
                writer.Write(content);
            }
        }
        var bytes = ms.ToArray();
        return (bytes, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
    }

    private sealed class FakeHandler(byte[] body) : HttpMessageHandler
    {
        public int Calls { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(body) });
        }
    }

    [Fact]
    public async Task Download_VerifiesHash_StagesApp_AndIsIdempotent()
    {
        var (zip, sha) = BuildPackage("0.5.1");
        var paths = new UpdatePaths(Path.Combine(_root, "updates"));
        var handler = new FakeHandler(zip);
        var downloader = new UpdateDownloader(new HttpClient(handler), paths);
        var manifest = new UpdateManifest("0.5.1", Url("0.5.1"), sha, zip.Length, null);

        var staged = await downloader.DownloadAndStageAsync(manifest, CancellationToken.None);
        Assert.True(File.Exists(Path.Combine(staged.AppDir, UpdatePaths.ExeName)));
        Assert.Equal(staged, paths.ReadPending());
        Assert.False(File.Exists(paths.ZipPath("0.5.1"))); // แตกแล้วลบ zip

        await downloader.DownloadAndStageAsync(manifest, CancellationToken.None);
        Assert.Equal(1, handler.Calls); // staged อยู่แล้ว ไม่โหลดซ้ำ
    }

    [Fact]
    public async Task Download_WithWrongHash_IsDiscarded()
    {
        var (zip, _) = BuildPackage("0.5.1");
        var paths = new UpdatePaths(Path.Combine(_root, "updates"));
        var downloader = new UpdateDownloader(new HttpClient(new FakeHandler(zip)), paths);
        var manifest = new UpdateManifest("0.5.1", Url("0.5.1"), new string('0', 64), zip.Length, null);

        var ex = await Assert.ThrowsAsync<UpdateException>(() => downloader.DownloadAndStageAsync(manifest, CancellationToken.None));
        Assert.Equal("sha256_mismatch", ex.Code);
        Assert.Null(paths.ReadPending());
        Assert.False(Directory.Exists(paths.StagingDir("0.5.1")));
        Assert.Empty(Directory.GetFiles(paths.Root, "*.zip*"));
    }

    private sealed class FakeOps(Func<string, IReadOnlyList<string>, bool> writesHealthy) : IUpdateProcessOps
    {
        public List<string> Started { get; } = new();
        public List<int> Killed { get; } = new();
        public bool WaitForExit(int pid, TimeSpan timeout) => true;

        public int? Start(string exePath, IReadOnlyList<string> args)
        {
            Started.Add($"{File.ReadAllText(exePath)} {string.Join(' ', args)}".Trim());
            HealthyWritten = writesHealthy(exePath, args);
            return 777;
        }

        public bool HealthyWritten { get; private set; }
        public bool WaitForFile(string path, TimeSpan timeout) => HealthyWritten;
        public void Kill(int pid) => Killed.Add(pid);
    }

    private (string Install, string StagingApp, UpdatePaths Paths) PrepareInstall()
    {
        var install = Path.Combine(_root, "Local", "StoreOS", "Launcher");
        Directory.CreateDirectory(install);
        File.WriteAllText(Path.Combine(install, UpdatePaths.ExeName), "exe 0.5.0");
        File.WriteAllText(Path.Combine(install, "old-only.dll"), "x");

        var paths = new UpdatePaths(Path.Combine(_root, "updates"));
        var stagingApp = paths.StagingAppDir("0.5.1");
        Directory.CreateDirectory(Path.Combine(stagingApp, "vosk-model"));
        File.WriteAllText(Path.Combine(stagingApp, UpdatePaths.ExeName), "exe 0.5.1");
        File.WriteAllText(Path.Combine(stagingApp, "vosk-model", "conf"), "m");
        paths.WritePending(new StagedUpdate("0.5.1", stagingApp));
        return (install, stagingApp, paths);
    }

    [Fact]
    public void Apply_SwapsFolder_AndStartsNewVersion_WhenHealthy()
    {
        var (install, stagingApp, paths) = PrepareInstall();
        var ops = new FakeOps((_, args) => args.Contains("--post-update"));

        var result = UpdateApplier.Run(new ApplyOptions(install, stagingApp, 1, "0.5.1"), paths, ops);

        Assert.Equal("installed", result.Outcome);
        Assert.Equal("exe 0.5.1", File.ReadAllText(Path.Combine(install, UpdatePaths.ExeName)));
        Assert.True(File.Exists(Path.Combine(install, "vosk-model", "conf")));
        Assert.False(File.Exists(Path.Combine(install, "old-only.dll"))); // ไม่มีไฟล์รุ่นเก่าค้างปน
        Assert.True(File.Exists(Path.Combine(UpdatePaths.PreviousDir(install), "old-only.dll"))); // สำรองไว้
        Assert.Equal(["exe 0.5.1 --post-update 0.5.1"], ops.Started);
        Assert.Null(paths.ReadPending());
        Assert.Equal("installed", paths.ReadResult()!.Outcome);
    }

    [Fact]
    public void Apply_RollsBack_WhenNewVersionNeverReportsHealthy()
    {
        var (install, stagingApp, paths) = PrepareInstall();
        var ops = new FakeOps((_, _) => false);

        var result = UpdateApplier.Run(new ApplyOptions(install, stagingApp, 1, "0.5.1"), paths, ops);

        Assert.Equal("rolled_back", result.Outcome);
        Assert.Equal("health_timeout", result.Error);
        Assert.Equal("exe 0.5.0", File.ReadAllText(Path.Combine(install, UpdatePaths.ExeName)));
        Assert.True(File.Exists(Path.Combine(install, "old-only.dll")));
        Assert.Equal([777], ops.Killed);
        Assert.Equal("exe 0.5.0 --update-rolled-back 0.5.1", ops.Started[^1]); // เปิดรุ่นเดิมกลับมาเสมอ
        Assert.Equal("0.5.1", paths.ReadRolledBackVersion()); // ไม่ลองรุ่นนี้ซ้ำ
        Assert.Null(paths.ReadPending());
    }

    [Fact]
    public void Apply_WithMissingStaging_LeavesInstallUntouched_AndRestartsIt()
    {
        var (install, _, paths) = PrepareInstall();
        var ops = new FakeOps((_, _) => false);

        var result = UpdateApplier.Run(new ApplyOptions(install, Path.Combine(_root, "nope"), 1, "0.5.1"), paths, ops);

        Assert.Equal("failed", result.Outcome);
        Assert.Equal("exe 0.5.0", File.ReadAllText(Path.Combine(install, UpdatePaths.ExeName)));
        Assert.Equal(["exe 0.5.0"], ops.Started);
    }
}
