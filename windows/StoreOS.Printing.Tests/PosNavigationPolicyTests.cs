using StoreOS.PosLauncher;
using Xunit;

namespace StoreOS.Printing.Tests;

public class PosNavigationPolicyTests
{
    [Theory]
    [InlineData("https://www.store-os.online/pos", NavigationDecision.Allow)]
    [InlineData("https://www.store-os.online/pos/grocery", NavigationDecision.Allow)]
    [InlineData("https://www.store-os.online/catalog", NavigationDecision.Allow)]
    [InlineData("https://www.store-os.online/settings/receipt", NavigationDecision.Allow)]
    [InlineData("https://www.store-os.online/login?next=%2Fpos", NavigationDecision.Allow)]
    [InlineData("https://www.store-os.online/", NavigationDecision.Allow)]
    [InlineData("https://www.store-os.online/attendance", NavigationDecision.Allow)]
    [InlineData("https://www.store-os.online/settings/store", NavigationDecision.Allow)]
    [InlineData("https://evil.example.com/pos", NavigationDecision.Block)]
    [InlineData("http://www.store-os.online/pos", NavigationDecision.Block)]
    [InlineData("https://user@www.store-os.online/pos", NavigationDecision.Block)]
    [InlineData("http://localhost:3000/pos", NavigationDecision.Block)]
    [InlineData("javascript:alert(1)", NavigationDecision.Block)]
    [InlineData("about:blank", NavigationDecision.Allow)]
    [InlineData("https://www.store-os.online/device-login", NavigationDecision.Allow)]
    [InlineData("https://www.store-os.online/api/device-login/complete", NavigationDecision.Allow)]
    [InlineData("https://www.store-os.online/dashboard", NavigationDecision.Allow)]
    [InlineData("https://www.store-os.online/pos/display", NavigationDecision.Allow)]
    [InlineData("https://www.store-os.online/player/_", NavigationDecision.Allow)]
    public void ProdNavigation(string url, NavigationDecision expected) => Assert.Equal(expected, PosNavigationPolicy.Decide(url, "prod"));

    [Fact]
    public void LocalhostOnlyOnDevChannel() =>
        Assert.Equal(NavigationDecision.Allow, PosNavigationPolicy.Decide("http://localhost:3000/pos", "dev"));

    [Theory]
    [InlineData("https://www.store-os.online/pos", true)]
    [InlineData("https://www.store-os.online/settings/receipt", true)]
    [InlineData("https://www.store-os.online/catalog", true)]
    [InlineData("https://www.store-os.online/login", false)]   // หน้าเข้าระบบสั่งพิมพ์ไม่ได้
    [InlineData("https://www.store-os.online/attendance", true)]     // หน้าหลังร้านสั่งพิมพ์ได้ (QR/เดลิเวอรี auto-print)
    [InlineData("https://www.store-os.online/device-login", false)]
    [InlineData("https://www.store-os.online/onboarding", false)]
    [InlineData("https://www.store-os.online/suspended", false)]
    [InlineData("https://www.store-os.online/account-inactive", false)]
    [InlineData("https://www.store-os.online/api/print/enqueue", false)]
    [InlineData("https://www.store-os.online/", false)]
    [InlineData("https://evil.example.com/pos", false)]
    [InlineData("http://www.store-os.online/pos", false)]
    [InlineData(null, false)]
    public void TrustedMessageSource(string? source, bool trusted) =>
        Assert.Equal(trusted, PosNavigationPolicy.IsTrustedMessageSource(source, "prod"));

    [Fact]
    public void LocalhostMessagesOnlyOnDevChannel()
    {
        Assert.True(PosNavigationPolicy.IsTrustedMessageSource("http://localhost:3000/pos", "dev"));
        Assert.False(PosNavigationPolicy.IsTrustedMessageSource("http://localhost:3000/pos", "prod"));
    }

    [Fact]
    public void TabsMapToPaths()
    {
        Assert.Equal(PosTab.Settings, PosNavigationPolicy.TabFor("https://www.store-os.online/catalog?x=1"));
        Assert.Equal(PosTab.Pos, PosNavigationPolicy.TabFor("https://www.store-os.online/pos"));
        Assert.Equal(PosTab.None, PosNavigationPolicy.TabFor("https://www.store-os.online/login"));
        Assert.Equal(PosTab.Settings, PosNavigationPolicy.TabFor("https://www.store-os.online/dashboard"));
        Assert.Equal(PosTab.Settings, PosNavigationPolicy.TabFor("https://www.store-os.online/attendance"));
        Assert.Equal(PosTab.Settings, PosNavigationPolicy.TabFor("https://www.store-os.online/player/_"));
        Assert.True(PosNavigationPolicy.IsTrustedMessageSource("https://www.store-os.online/pos/display", "prod"));
        Assert.Equal("https://www.store-os.online/settings", PosNavigationPolicy.UrlFor(PosTab.Settings, "https://www.store-os.online/"));
    }
}
