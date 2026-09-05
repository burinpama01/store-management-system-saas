using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace StoreOS.Launcher.Services;

/// <summary>
/// Print Hub auto-provision — ดึง config ล่าสุดของ "เครื่องนี้" ตอนเปิด Launcher
///
/// ปัญหาที่แก้: เครื่องร้านเจอ `Hub token rejected (401)` แล้วแก้เองไม่ได้ ต้องให้คน
/// ไปกดสร้าง token ใหม่ในหน้าตั้งค่าแล้วก๊อปไฟล์มาวางเองทุกครั้ง
///
/// วิธี: Launcher เรียก /api/print/hub/provision ผ่าน session ของผู้ใช้ที่ล็อกอินอยู่
/// ใน WebView2 (fetch จากในหน้าเว็บ จึงมี cookie ติดไปเอง) แล้วเขียน config ให้ถ้าได้
/// token ใหม่มา ฝั่ง server เป็นคนตัดสินว่าต้องออกใบใหม่ไหม — ถ้าของเดิมยังใช้ได้
/// จะตอบ rotated=false แล้วเราไม่แตะไฟล์เลย
///
/// คลาสนี้แยก logic ที่ test ได้ออกจาก WebView2/ไฟล์จริง
/// </summary>
public static class HubConfigProvisioner
{
    /// <summary>
    /// ตัวระบุเครื่องที่เสถียรและไม่ใช่ข้อมูลส่วนบุคคล
    /// ใช้ MachineGuid ของ Windows แล้ว hash ทับอีกชั้น เพื่อไม่ส่งค่าดิบของเครื่องขึ้น server
    /// </summary>
    public static string DeviceId(string? machineGuid, string? machineName)
    {
        var seed = string.IsNullOrWhiteSpace(machineGuid)
            // ไม่มี MachineGuid (สิทธิ์ไม่พอ/registry เพี้ยน) ก็ยังต้องได้ค่าที่คงที่ต่อเครื่อง
            ? $"name:{machineName ?? "unknown"}"
            : $"guid:{machineGuid}";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(seed));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    /// <summary>
    /// JavaScript ที่รันในหน้าเว็บของ POS (จึงมี session cookie ติดไปด้วย)
    /// คืนผลเป็น JSON string เสมอ เพื่อให้ฝั่ง native แยก "เรียกไม่ได้" กับ "server ปฏิเสธ" ออกจากกัน
    /// </summary>
    public static string BuildProvisionScript(string deviceId, string deviceLabel, string? currentToken)
    {
        var payload = JsonSerializer.Serialize(new
        {
            deviceId,
            deviceLabel,
            currentToken,
        });
        // ห่อ try/catch ให้ ExecuteScriptAsync ไม่คืน undefined ตอน network ล้ม
        return $$"""
        (async () => {
          try {
            const res = await fetch('/api/print/hub/provision', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              cache: 'no-store',
              body: JSON.stringify({{payload}})
            });
            const text = await res.text();
            return JSON.stringify({ status: res.status, body: text });
          } catch (e) {
            return JSON.stringify({ status: 0, body: '' });
          }
        })()
        """;
    }

    public sealed record ProvisionOutcome(bool Rotated, string? ConfigJson, string Reason);

    /// <summary>
    /// แปลผลที่ได้จากหน้าเว็บเป็นสิ่งที่ native ต้องทำต่อ
    /// fail closed: อะไรที่อ่านไม่ออก = ไม่แตะ config เดิม (ของเดิมอาจยังใช้ได้อยู่)
    /// </summary>
    public static ProvisionOutcome Interpret(string? scriptResult)
    {
        if (string.IsNullOrWhiteSpace(scriptResult)) return new(false, null, "no_result");

        try
        {
            // ExecuteScriptAsync คืนค่าเป็น JSON ของ JS value → string ของเราถูก quote อีกชั้น
            var unwrapped = JsonSerializer.Deserialize<string>(scriptResult);
            if (string.IsNullOrWhiteSpace(unwrapped)) return new(false, null, "no_result");

            using var envelope = JsonDocument.Parse(unwrapped);
            var status = envelope.RootElement.TryGetProperty("status", out var s) ? s.GetInt32() : 0;
            var body = envelope.RootElement.TryGetProperty("body", out var b) ? b.GetString() : null;

            if (status == 0) return new(false, null, "network_error");
            if (status == 401) return new(false, null, "not_signed_in");
            if (status == 403) return new(false, null, "no_permission");
            if (status != 200 || string.IsNullOrWhiteSpace(body)) return new(false, null, $"http_{status}");

            using var payload = JsonDocument.Parse(body);
            var root = payload.RootElement;
            if (!root.TryGetProperty("ok", out var ok) || !ok.GetBoolean()) return new(false, null, "server_rejected");

            var rotated = root.TryGetProperty("rotated", out var r) && r.GetBoolean();
            if (!rotated) return new(false, null, "already_valid");

            if (!root.TryGetProperty("config", out var config) || config.ValueKind != JsonValueKind.Object)
            {
                return new(false, null, "missing_config");
            }
            return new(true, config.GetRawText(), "rotated");
        }
        catch (JsonException)
        {
            return new(false, null, "unreadable");
        }
    }

    /// <summary>
    /// เขียน config ลงไฟล์แบบ atomic (เขียนไฟล์ชั่วคราวแล้ว move ทับ)
    /// กันไฟล์พังครึ่ง ๆ ถ้าไฟดับ/ปิดเครื่องกลางคัน ซึ่งจะทำให้ Hub อ่าน config ไม่ออกเลย
    /// </summary>
    public static void WriteConfigAtomic(string configPath, string configJson)
    {
        var directory = Path.GetDirectoryName(configPath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        var temp = configPath + ".tmp";
        File.WriteAllText(temp, configJson, new UTF8Encoding(false));
        File.Move(temp, configPath, overwrite: true);
    }
}
