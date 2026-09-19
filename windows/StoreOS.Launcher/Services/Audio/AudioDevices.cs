using NAudio.CoreAudioApi;

namespace StoreOS.Launcher.Services.Audio;

/// <summary>ลำโพงหนึ่งตัวของ Windows ที่เลือกเป็นปลายทางเสียงได้</summary>
public sealed record AudioOutputDevice(string Id, string Name, bool IsDefault);

public interface IAudioDeviceCatalog
{
    /// <summary>ลำโพงที่ใช้งานได้ตอนนี้ (Active) — ถอดสาย/ปิดอยู่จะไม่อยู่ในรายการ</summary>
    IReadOnlyList<AudioOutputDevice> ListOutputs();
}

/// <summary>
/// ตัดสินว่าจะเล่นออกลำโพงไหน — pure เพื่อทดสอบได้โดยไม่ต้องมีการ์ดเสียง
///
/// กติกา: ไม่ได้เลือก (null) = ลำโพงหลักของ Windows · เลือกไว้แต่ตอนนี้ไม่อยู่ (ถอดสาย)
/// = ถอยไปลำโพงหลักและบอกผู้เรียกว่า "ถอย" เพื่อ log/แจ้งหน้าเว็บ — เสียงแจ้งเตือนต้องไม่เงียบ
/// </summary>
public static class AudioDeviceResolver
{
    public static (AudioOutputDevice? Device, bool FellBack) Resolve(
        string? requestedId,
        IReadOnlyList<AudioOutputDevice> devices)
    {
        var fallback = devices.FirstOrDefault(d => d.IsDefault);
        if (string.IsNullOrWhiteSpace(requestedId)) return (fallback, false);

        var match = devices.FirstOrDefault(d => string.Equals(d.Id, requestedId, StringComparison.OrdinalIgnoreCase));
        return match is not null ? (match, false) : (fallback, true);
    }
}

/// <summary>ลิสต์ลำโพงจริงผ่าน Core Audio (ได้ชื่อที่ผู้ใช้เห็นใน Windows ไม่ต้องขอสิทธิ์ไมค์แบบเว็บ)</summary>
public sealed class WasapiDeviceCatalog : IAudioDeviceCatalog
{
    public IReadOnlyList<AudioOutputDevice> ListOutputs()
    {
        using var enumerator = new MMDeviceEnumerator();
        string? defaultId = null;
        try
        {
            using var def = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            defaultId = def.ID;
        }
        catch (Exception)
        {
            // เครื่องไม่มีลำโพงเลย — ยังคืนรายการว่างได้ ไม่ใช่เหตุให้ Launcher ล้ม
        }

        var result = new List<AudioOutputDevice>();
        foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            using (device)
            {
                result.Add(new AudioOutputDevice(device.ID, device.FriendlyName, device.ID == defaultId));
            }
        }
        return result;
    }

    /// <summary>เปิดอุปกรณ์ตาม id (null = ลำโพงหลัก) — ผู้เรียกต้อง Dispose</summary>
    public static MMDevice? Open(string? deviceId)
    {
        var enumerator = new MMDeviceEnumerator();
        try
        {
            return deviceId is null
                ? enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia)
                : enumerator.GetDevice(deviceId);
        }
        catch (Exception)
        {
            return null;
        }
    }
}
