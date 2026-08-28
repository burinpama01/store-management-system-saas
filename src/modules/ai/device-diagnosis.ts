// Task 10/D (v0.34.1) — Device AI diagnosis (D1: explain an error deterministically).
// Input is redacted through the Task 9 allowlist; output is advice-only with
// requiresConfirmation forced true; failures must give the caller a manual path.
import { redactDeviceDiagnosisInput, type RedactedDeviceInput } from "./redaction";
import { generateDeviceAdvice } from "./gateway";

export type DeviceDiagnosisRequest = Readonly<{
  errorCode: string;
  platform: string;
  channel: string;
  printerModel?: string;
}>;

export type DeviceDiagnosisResult =
  | { ok: true; advice: { summary: string; steps: string[]; requiresConfirmation: boolean }; model: string }
  | { ok: false; reason: "ai_disabled" | "ai_timeout" | "quota_denied" | "error"; error?: string; manualPath: string };

export function buildManualPath(reason: NonNullable<Extract<DeviceDiagnosisResult, { ok: false }>["reason"]>): string {
  switch (reason) {
    case "ai_disabled":
      return "ระบบ AI ยังไม่เปิดใช้ — ทำตามขั้นตอนใน Device Center ด้วยตัวเองได้ตามปกติ";
    case "ai_timeout":
      return "AI ตอบช้าเกินไป — ลองใหม่อีกครั้ง หรือทำตามขั้นตอนแนะนำในหน้านี้ก่อน";
    case "quota_denied":
      return "ครบโควตา AI ขององค์กรแล้ว — ใช้ขั้นตอนแนะนำแบบ manual ต่อได้ตามปกติ";
    default:
      return "เกิดข้อผิดพลาด — ลองใหม่ หรือทำตามขั้นตอนแนะนำในหน้านี้";
  }
}

/** D1: redact → generate advice. AI output is advice-only (requiresConfirmation). */
export async function diagnoseDeviceError(
  raw: DeviceDiagnosisRequest,
  options: { approvedModelId: string },
): Promise<{ redacted: RedactedDeviceInput; advice: { summary: string; steps: string[]; requiresConfirmation: boolean }; model: string }> {
  const redacted = redactDeviceDiagnosisInput({
    errorCode: raw.errorCode,
    platform: raw.platform,
    channel: raw.channel,
    printerModel: raw.printerModel,
  });
  const { advice } = await generateDeviceAdvice(redacted, options.approvedModelId);
  // AI output is advice-only: the confirmation flag is ALWAYS forced true here,
  // regardless of what the model returned (plan contract).
  return { redacted, advice: { ...advice, requiresConfirmation: true }, model: options.approvedModelId };
}