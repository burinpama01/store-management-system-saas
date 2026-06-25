const DEFAULT_SMSKUB_API_URL = "https://console.sms-kub.com/api/campaigns";

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function buildOtpMessage(code: string) {
  return `รหัส OTP สำหรับร้านของคุณคือ ${code} รหัสนี้หมดอายุใน 10 นาที`;
}

export async function sendSmskubOtp(phone: string, code: string) {
  const apiKey = requireEnv("SMSKUB_API_KEY");
  const senderName = process.env.SMSKUB_SENDER_NAME?.trim() || undefined;
  const apiUrl = process.env.SMSKUB_API_URL?.trim() || DEFAULT_SMSKUB_API_URL;
  const message = buildOtpMessage(code);

  const response = await fetch(apiUrl, {
    method: "POST",
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
    throw new Error(`SMSKUB send failed (${response.status})`);
  }

  return { ok: true };
}
