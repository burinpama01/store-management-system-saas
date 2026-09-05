using StoreOS.Launcher;
using Xunit;

namespace StoreOS.Launcher.Tests;

/// <summary>
/// ISSUE-001 — Launcher เปิดมาแล้วเจอ 404 บนเครื่องร้าน
///
/// สาเหตุ: ค่าเริ่มต้นชี้ไป /pos/unified ซึ่ง "ไม่ใช่ route" — โฟลเดอร์
/// src/app/pos/unified/ มีแต่ component ไม่มี page.tsx หน้าจริงคือ /pos
/// (UnifiedPosWorkspace ถูก compose อยู่ข้างใน /pos อีกที)
/// </summary>
public class LauncherSettingsTests
{
    [Fact]
    public void Default_pos_url_uses_the_canonical_pos_route()
    {
        Assert.Equal("https://www.store-os.online/pos", new LauncherSettings().PosUrl);
    }

    [Fact]
    public void Default_pos_url_never_points_at_a_non_route()
    {
        // /pos/unified ไม่มี page.tsx = 404 เสมอ ห้ามกลับมาเป็นค่าเริ่มต้นอีก
        Assert.DoesNotContain("/pos/unified", new LauncherSettings().PosUrl);
    }

    [Fact]
    public void Default_pos_url_is_https_on_the_canonical_domain()
    {
        var uri = new Uri(new LauncherSettings().PosUrl);
        Assert.Equal(Uri.UriSchemeHttps, uri.Scheme);
        Assert.Equal("www.store-os.online", uri.Host);
    }

    [Fact]
    public void Dev_tools_are_off_by_default()
    {
        Assert.False(new LauncherSettings().AllowDevTools);
    }
}
