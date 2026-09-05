using StoreOS.Launcher.Services;
using Xunit;

namespace StoreOS.Launcher.Tests;

/// <summary>
/// ISSUE-002 — จอลูกค้าเปิดเป็นหน้าต่างลอย ไม่ผูกกับ Launcher
///
/// Launcher จะ "รับ" หน้าต่างลูกไว้เป็นของตัวเอง (owner) เฉพาะ URL ที่ผ่าน allowlist นี้
/// เท่านั้น เพื่อไม่ให้ไปคว้าหน้าต่างของเว็บอื่นมาปิดผิดตัว — จึงต้อง fail closed:
/// อะไรที่ไม่แน่ใจ = ไม่รับ ปล่อยให้ WebView2 จัดการตามปกติ
/// </summary>
public class CustomerDisplayNavigationTests
{
    private static readonly Uri Base = new("https://www.store-os.online/pos");

    [Fact]
    public void Accepts_customer_display_on_the_same_origin()
    {
        Assert.True(CustomerDisplayNavigation.TryResolve(Base, "https://www.store-os.online/pos/display", out var resolved));
        Assert.Equal("https://www.store-os.online/pos/display", resolved!.ToString());
    }

    [Fact]
    public void Accepts_customer_display_with_query_string()
    {
        // เปิดจอลูกค้าพร้อมพารามิเตอร์ (เช่น เลือกจอ) ต้องยังผ่าน
        Assert.True(CustomerDisplayNavigation.TryResolve(Base, "https://www.store-os.online/pos/display?screen=2", out _));
    }

    [Theory]
    [InlineData("https://evil.example.com/pos/display")]      // คนละ origin
    [InlineData("http://www.store-os.online/pos/display")]     // ไม่ใช่ https
    [InlineData("https://www.store-os.online/pos")]            // path อื่น
    [InlineData("https://www.store-os.online/settings")]       // path อื่น
    [InlineData("https://www.store-os.online/pos/display/../admin")] // พยายามหลุดออกจาก path
    [InlineData("javascript:alert(1)")]                        // scheme อันตราย
    [InlineData("not a url")]                                  // malformed
    [InlineData("")]
    [InlineData(null)]
    public void Rejects_everything_else(string? requested)
    {
        Assert.False(CustomerDisplayNavigation.TryResolve(Base, requested, out var resolved));
        Assert.Null(resolved);
    }

    [Fact]
    public void Rejects_when_base_uri_is_missing()
    {
        Assert.False(CustomerDisplayNavigation.TryResolve(null, "https://www.store-os.online/pos/display", out _));
    }

    [Fact]
    public void Host_comparison_ignores_case()
    {
        Assert.True(CustomerDisplayNavigation.TryResolve(Base, "https://WWW.STORE-OS.ONLINE/pos/display", out _));
    }

    [Fact]
    public void Works_for_any_base_host_not_just_production()
    {
        // เครื่องทดสอบอาจชี้โดเมนอื่น — กฎคือ "same-origin กับที่ Launcher เปิดอยู่"
        var staging = new Uri("https://store-os-manage.vercel.app/pos");
        Assert.True(CustomerDisplayNavigation.TryResolve(staging, "https://store-os-manage.vercel.app/pos/display", out _));
        Assert.False(CustomerDisplayNavigation.TryResolve(staging, "https://www.store-os.online/pos/display", out _));
    }
}
