const DEFAULT_SMSKUB_API_URL = "https://console.sms-kub.com/api/campaigns";
const SMSKUB_BASE = "https://console.sms-kub.com";

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function buildOtpMessage(code: string) {
  return `รหัส OTP สำหรับร้านของคุณคือ ${code} รหัสนี้หมดอายุใน 10 นาที`;
}

async function readProviderMessage(response: Response) {
  try {
    const payload = (await response.json()) as { message?: unknown } | null;
    return typeof payload?.message === "string" ? payload.message : null;
  } catch {
    return null;
  }
}

export async function sendSmskubOtp(phone: string, code: string) {
  const apiKey = requireEnv("SMSKUB_API_KEY");
  const senderName = process.env.SMSKUB_SENDER_NAME?.trim() || undefined;
  const apiUrl = process.env.SMSKUB_API_URL?.trim() || DEFAULT_SMSKUB_API_URL;
  const message = buildOtpMessage(code);

  const response = await fetch(apiUrl, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "Content-Type": "application/json",
      key: apiKey,
    },
    body: JSON.stringify({
      name: "StoreOS OTP",
      message,
      to: [phone],
      from: senderName,
      is_schedule: false,
      frequency: "onetime",
    }),
  });

  if (!response.ok) {
    // provider ตอบ message กลับมาเสมอ (เช่น "your package is expired") —
    // เก็บไว้ใน error เพื่อให้ log ระบุสาเหตุได้ทันที ไม่ต้องยิงทดสอบเอง
    const detail = await readProviderMessage(response);
    throw new Error(
      `SMSKUB send failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  return { ok: true };
}

type ProviderOtpConfig = { apiKey: string; project: string };

function providerOtpConfig(): ProviderOtpConfig | null {
  const apiKey = process.env.SMSKUB_API_KEY?.trim();
  const project = process.env.SMSKUB_OTP_PROJECT?.trim();
  if (!apiKey || !project) return null;
  return { apiKey, project };
}

async function callProviderOtp(
  path: string,
  body: Record<string, string>,
  config: ProviderOtpConfig,
) {
  const response = await fetch(`${SMSKUB_BASE}${path}`, {
    method: "POST",
    headers: {
      key: config.apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    code?: unknown;
    message?: unknown;
    data?: { validate?: unknown } | null;
  } | null;
  return { ok: response.ok, status: response.status, payload };
}

/** ขอ OTP จากบริการ OTP v2 ของ SMSKUB — ผู้ให้บริการเป็นฝ่ายสร้างและส่งรหัสให้ลูกค้าเอง */
export async function requestProviderOtp(phone: string) {
  const config = providerOtpConfig();
  if (!config) throw new Error("Missing SMSKUB_OTP_PROJECT");
  const { ok, payload } = await callProviderOtp(
    "/api/v2/otp/request",
    { phone, project: config.project },
    config,
  );
  if (!ok || payload?.code !== 200) {
    const detail = typeof payload?.message === "string" ? payload.message : null;
    throw new Error(
      `SMSKUB otp request failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return { ok: true };
}

/** ตรวจรหัส OTP กับบริการ OTP v2 — คืน true เฉพาะผู้ให้บริการยืนยันว่าถูกต้อง
 * contract จริง (ยืนยันกับ API แล้ว): รหัสผิด/ไม่มีคำขอ ตอบ HTTP 4xx เช่น
 * {code:401,message:"OTP not request"} → ถือเป็น "รหัสผิด" ให้นับ attempts
 * ส่วน 5xx/network error = provider ล้ม → throw เพื่อไม่ลงโทษลูกค้า */
export async function verifyProviderOtp(phone: string, code: string) {
  const config = providerOtpConfig();
  if (!config) throw new Error("Missing SMSKUB_OTP_PROJECT");
  const { ok, status, payload } = await callProviderOtp(
    "/api/v2/otp/verify",
    { phone, otp: code, project: config.project },
    config,
  );
  if (status >= 500) {
    const detail = typeof payload?.message === "string" ? payload.message : null;
    throw new Error(`SMSKUB otp verify failed (${status})${detail ? `: ${detail}` : ""}`);
  }
  return Boolean(ok && payload?.code === 200 && payload?.data?.validate === true);
}

export type MemberOtpDelivery =
  | { channel: "campaigns" }
  | { channel: "otp_v2" };

/**
 * ส่ง OTP ให้ลูกค้าโดยมี fallback:
 * 1. ช่องทางหลัก: SMS แคมเปญ (v1) ด้วยรหัสที่เราสร้างเอง
 * 2. ถ้า v1 ล้ม (เช่น แพ็กเกจหมดอายุ): ใช้บริการ OTP v2 ที่ผู้ให้บริการ
 *    สร้าง/ส่ง/ตรวจรหัสให้ — รหัสที่ลูกค้าได้รับจะไม่ใช่รหัสที่เราสุ่มไว้
 *
 * คืนช่องทางที่ส่งสำเร็จจริง เพื่อให้ฝั่งตรวจรหัสรู้ว่าต้องตรวจกับฐานข้อมูลเรา
 * หรือกับผู้ให้บริการ
 */
export async function deliverMemberOtp(
  phone: string,
  code: string,
): Promise<MemberOtpDelivery> {
  let campaignError: unknown;
  try {
    await sendSmskubOtp(phone, code);
    return { channel: "campaigns" };
  } catch (error) {
    campaignError = error;
  }

  try {
    await requestProviderOtp(phone);
    return { channel: "otp_v2" };
  } catch (fallbackError) {
    // ทั้งสองช่องทางล้ม — แนบสาเหตุของทั้งคู่เพื่อให้ log บอกได้ว่าต้องแก้อะไรบ้าง
    // (เช่น v1 หมดอายุ + v2 ไม่ได้ตั้ง SMSKUB_OTP_PROJECT)
    const fallbackMessage =
      fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
    const campaignMessage =
      campaignError instanceof Error ? campaignError.message : String(campaignError);
    throw new Error(`${campaignMessage} (fallback ผ่าน OTP v2 ก็ล้ม: ${fallbackMessage})`);
  }
}
