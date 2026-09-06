using StoreOS.Voice;

using Xunit;

namespace StoreOS.Voice.Tests;

/// <summary>
/// สิทธิ์ที่หน้าเว็บใน Launcher ขอได้
///
/// เจตนา: อนุญาตเฉพาะสิ่งที่ StoreOS ใช้จริง และเฉพาะคำขอจาก origin ของตัวเอง
/// เพื่อไม่ให้พนักงานหน้าร้านต้องตัดสินใจเรื่องสิทธิ์ที่กดผิดแล้วพังทั้งเครื่อง
/// </summary>
public class WebViewPermissionPolicyTests
{
    private static readonly Uri Own = new("https://www.store-os.online/pos");

    [Theory]
    [InlineData(WebPermission.Microphone)]
    [InlineData(WebPermission.Camera)]
    [InlineData(WebPermission.Geolocation)]
    public void สิ่งที่แอปใช้จริงจาก_origin_ตัวเอง_อนุญาต(WebPermission permission)
    {
        var decision = WebViewPermissionPolicy.Decide(permission, "https://www.store-os.online/pos", Own);

        Assert.Equal(WebPermissionDecision.Allow, decision);
    }

    [Theory]
    [InlineData(WebPermission.Notifications)]
    [InlineData(WebPermission.ClipboardRead)]
    [InlineData(WebPermission.OtherSensors)]
    [InlineData(WebPermission.Unknown)]
    public void สิ่งที่แอปไม่ได้ใช้_ปฏิเสธแม้มาจาก_origin_ตัวเอง(WebPermission permission)
    {
        var decision = WebViewPermissionPolicy.Decide(permission, "https://www.store-os.online/pos", Own);

        Assert.Equal(WebPermissionDecision.Deny, decision);
    }

    [Theory]
    [InlineData("https://evil.example/pos")]
    [InlineData("http://www.store-os.online/pos")]
    [InlineData("https://www.store-os.online:8443/pos")]
    [InlineData(null)]
    public void ไมโครโฟนจากที่อื่น_ปฏิเสธเสมอ(string? uri)
    {
        // หน้าอื่นที่หลุดเข้ามาใน WebView2 ต้องไม่ได้ไมค์ของเครื่องร้าน
        var decision = WebViewPermissionPolicy.Decide(WebPermission.Microphone, uri, Own);

        Assert.Equal(WebPermissionDecision.Deny, decision);
    }

    [Fact]
    public void ยังไม่รู้ปลายทางที่อนุญาต_ปฏิเสธทุกอย่าง()
    {
        Assert.Equal(
            WebPermissionDecision.Deny,
            WebViewPermissionPolicy.Decide(WebPermission.Microphone, "https://www.store-os.online/pos", null));
    }
}
