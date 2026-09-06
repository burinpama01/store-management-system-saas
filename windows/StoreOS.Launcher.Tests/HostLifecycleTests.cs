using StoreOS.Launcher;
using StoreOS.Launcher.Services;

using Xunit;

namespace StoreOS.Launcher.Tests;

/// <summary>
/// W1 — เปลือกโปรแกรมและวงจรชีวิต (แผน v1)
/// RED ที่แผนกำหนด: config origin ผิด, เปิดซ้ำ, และคืนทรัพยากรตอนปิด
/// </summary>
public class SingleInstanceGuardTests
{
    [Fact]
    public void ตัวที่สองบน_channel_เดียวกันคว้าสิทธิ์ไม่ได้()
    {
        var channel = "test-" + Guid.NewGuid().ToString("n")[..8];

        using var first = SingleInstanceGuard.TryAcquire(channel);
        var second = SingleInstanceGuard.TryAcquire(channel);

        Assert.NotNull(first);
        Assert.Null(second);
    }

    [Fact]
    public void ปล่อยแล้วเปิดใหม่ได้()
    {
        var channel = "test-" + Guid.NewGuid().ToString("n")[..8];

        var first = SingleInstanceGuard.TryAcquire(channel);
        first!.Dispose();
        using var again = SingleInstanceGuard.TryAcquire(channel);

        Assert.NotNull(again);
    }

    [Fact]
    public void คนละ_channel_เปิดพร้อมกันได้()
    {
        var suffix = Guid.NewGuid().ToString("n")[..8];

        using var prod = SingleInstanceGuard.TryAcquire("prod-" + suffix);
        using var dev = SingleInstanceGuard.TryAcquire("dev-" + suffix);

        Assert.NotNull(prod);
        Assert.NotNull(dev);
    }

    [Theory]
    [InlineData(null, @"Local\StoreOSLauncher-prod")]
    [InlineData("", @"Local\StoreOSLauncher-prod")]
    [InlineData("dev", @"Local\StoreOSLauncher-dev")]
    // ชื่อ mutex ที่มี '\' หรืออักขระแปลกจะโยน exception ตั้งแต่ตอนเปิดโปรแกรม
    [InlineData(@"a\b/c:d*", @"Local\StoreOSLauncher-abcd")]
    public void ชื่อ_mutex_ถูกกรองให้ปลอดภัยเสมอ(string? channel, string expected)
    {
        Assert.Equal(expected, SingleInstanceGuard.MutexName(channel));
    }

    [Fact]
    public void ปล่อยซ้ำได้โดยไม่พัง()
    {
        var guard = SingleInstanceGuard.TryAcquire("test-" + Guid.NewGuid().ToString("n")[..8]);

        guard!.Dispose();
        guard.Dispose();
    }
}

public class PosUrlPolicyTests
{
    [Theory]
    [InlineData("https://www.store-os.online/pos", "prod", true)]
    [InlineData("https://store-os.online/pos", "prod", true)]
    // เว็บอื่น = ห้าม แม้จะเป็น https (Launcher เปิดเต็มจอ ผู้ใช้ไม่เห็นแถบที่อยู่)
    [InlineData("https://store-os.online.evil.example/pos", "prod", false)]
    [InlineData("https://store-management-system-saas.vercel.app/pos", "prod", false)]
    // http ธรรมดาบนอินเทอร์เน็ต = ห้าม (ดักฟัง/แก้กลางทางได้)
    [InlineData("http://www.store-os.online/pos", "prod", false)]
    // user-info เป็นเทคนิคหลอกตาแบบคลาสสิก
    [InlineData("https://www.store-os.online@evil.example/pos", "prod", false)]
    [InlineData("ไม่ใช่ url", "prod", false)]
    [InlineData(null, "prod", false)]
    public void โฮสต์นอกรายการต้องถูกปฏิเสธ(string? url, string channel, bool expected)
    {
        Assert.Equal(expected, LauncherSettings.IsAllowedPosUrl(url, channel));
    }

    [Fact]
    public void localhost_เปิดได้เฉพาะ_channel_dev()
    {
        Assert.True(LauncherSettings.IsAllowedPosUrl("http://localhost:3000/pos", "dev"));
        Assert.False(LauncherSettings.IsAllowedPosUrl("http://localhost:3000/pos", "prod"));
    }

    [Fact]
    public void ค่าที่ใช้ไม่ได้ต้องถอยไปใช้ที่อยู่มาตรฐาน_ไม่ใช่เปิดไม่ขึ้น()
    {
        var settings = new LauncherSettings { PosUrl = "https://evil.example/pos" };

        var resolved = settings.ResolvePosUrl(out var rejected);

        Assert.True(rejected);
        Assert.Equal("https://www.store-os.online/pos", resolved);
    }

    [Fact]
    public void ค่าที่ถูกต้องต้องถูกใช้ตามนั้น()
    {
        var settings = new LauncherSettings { PosUrl = "https://store-os.online/pos?device=1" };

        var resolved = settings.ResolvePosUrl(out var rejected);

        Assert.False(rejected);
        Assert.Equal("https://store-os.online/pos?device=1", resolved);
    }

    [Fact]
    public void ค่าเริ่มต้นของ_channel_และโหมดคำปลุก()
    {
        var settings = new LauncherSettings();

        Assert.Equal("prod", settings.Channel);
        // ต้องปิดไว้ก่อน — เปิดทีละเครื่องระหว่าง pilot เท่านั้น
        Assert.False(settings.VoiceStandbyEnabled);
    }
}

public class WebViewProfileTests
{
    [Fact]
    public void โฟลเดอร์ข้อมูลอยู่ใต้_localappdata_และแยกตาม_channel()
    {
        var prod = WebViewProfile.UserDataFolder(@"C:\Users\x\AppData\Local", "prod");
        var dev = WebViewProfile.UserDataFolder(@"C:\Users\x\AppData\Local", "dev");

        Assert.Equal(@"C:\Users\x\AppData\Local\StoreOSLauncher\webview2\prod", prod);
        Assert.NotEqual(prod, dev);
    }

    [Fact]
    public void ชื่อ_channel_แปลก_ต้องไม่หลุดออกนอกโฟลเดอร์()
    {
        var path = WebViewProfile.UserDataFolder(@"C:\Users\x\AppData\Local", @"..\..\Windows");

        Assert.Equal(@"C:\Users\x\AppData\Local\StoreOSLauncher\webview2\Windows", path);
    }
}
