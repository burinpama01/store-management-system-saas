import type { Environment } from "./foundation";

/** จำนวนเต็มบวกจาก env — ค่าผิดรูป/ต่ำกว่าขั้นต่ำ = ใช้ค่าเริ่มต้นเสมอ (fail-closed ฝั่ง config) */
function readPositiveInt(raw: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) return fallback;
  return parsed;
}

/** ทศนิยมในช่วงที่กำหนดจาก env — ค่าผิดรูป/นอกช่วง = ค่าเริ่มต้น */
function readNumberInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/** รับเฉพาะ environment จาก server composition root ห้ามรับจาก request */
export function readAssistantConfig(env: Readonly<Record<string, string | undefined>>) {
  const environment: Environment = env.NODE_ENV === "development" || env.NODE_ENV === "test" ? env.NODE_ENV : "production";
  return {
    environment,
    enabled: env.AI_ASSISTANT_ENABLED === "true" && env.AI_ASSISTANT_KILL_SWITCH !== "true",
    // PR3-Live (M2) — one-press Live conversation: ปิดเป็นค่าเริ่มต้น และ kill switch กลาง
    // ยังคุมทุกช่องทาง (เปิด LIVE_ENABLED แต่ติด KILL_SWITCH = ปิดเสมอ)
    liveEnabled: env.AI_ASSISTANT_LIVE_ENABLED === "true" && env.AI_ASSISTANT_KILL_SWITCH !== "true",
    // pilot org เดียวก่อน (CSV ของ org id) — คำนวณเป็น lowercase set เทียบ org id แบบไม่สนตัวพิมพ์
    livePilotOrgIds: (env.AI_ASSISTANT_LIVE_PILOT_ORG_IDS ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id.length > 0),
    // caps ตาม plan v2 §11 — hard caps ตั้งแต่ Live PR แรก (ไม่รอ billing phase)
    liveMaxSessionMinutes: readPositiveInt(env.AI_ASSISTANT_LIVE_MAX_SESSION_MINUTES, 15, 1),
    liveMaxToolCallsPerSession: readPositiveInt(env.AI_ASSISTANT_LIVE_MAX_TOOL_CALLS_PER_SESSION, 40, 1),
    liveMaxConcurrentSessionsPerStore: readPositiveInt(env.AI_ASSISTANT_LIVE_MAX_CONCURRENT_SESSIONS_PER_STORE, 2, 1),
    // โหมดวินิจฉัย (diagnostics) — เปิดเฉพาะร้านที่กำลังทดสอบหน้าร้าน ไม่ใช่ทุก org
    // ปิดอยู่ = ไม่มี event ละเอียดของ WebRTC/เสียง/ตะกร้าขึ้น server (audit เดิมยังครบเหมือนเดิม)
    liveDiagnosticsEnabled: env.AI_ASSISTANT_LIVE_DIAGNOSTICS_ENABLED === "true"
      && env.AI_ASSISTANT_KILL_SWITCH !== "true",
    // model ที่ PoC พิสูจน์ tool round-trip กับ API จริงแล้ว (artifacts/realtime-tool-poc.log)
    liveModel: env.AI_ASSISTANT_LIVE_MODEL?.trim() || "gpt-realtime-2.1-mini",
    // ความเร็วเสียงพูดของผู้ช่วย (provider รับ 0.25–1.5) — ร้านนำร่องบอกว่า 1.0 เร็วเกินจนฟังภาษาไทยไม่ทัน
    liveSpeechSpeed: readNumberInRange(env.AI_ASSISTANT_LIVE_SPEECH_SPEED, 0.85, 0.25, 1.5),
    // เก็บบทสนทนา (คำพูดพนักงาน / คำตอบผู้ช่วย / tool ที่เรียก) ลง ai_live_conversation_turns
    // ปิดเป็นค่าเริ่มต้น เปิดเฉพาะช่วงทดสอบ — ในเสียงอาจมีชื่อ/เบอร์ลูกค้า
    liveTranscriptsEnabled: env.AI_ASSISTANT_LIVE_TRANSCRIPTS_ENABLED === "true"
      && env.AI_ASSISTANT_KILL_SWITCH !== "true",
    liveTranscriptRetentionDays: readPositiveInt(env.AI_ASSISTANT_LIVE_TRANSCRIPT_RETENTION_DAYS, 30, 1),
    // ตัวถอดเสียงฝั่งผู้ใช้ (เปิดเฉพาะตอนเก็บบทสนทนา — model หลักฟังเสียงตรงอยู่แล้ว ไม่ต้องพึ่งข้อความนี้)
    liveTranscribeModel: env.AI_ASSISTANT_LIVE_TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe",
    // PR3 — mutation ปลดได้เฉพาะ env เป็น "true" แบบตรงตัว แต่ใน production ยังต้องผ่าน
    // เกต durable store ของ dispatcher อีกชั้น (env เดียวไม่พอ — ดู checkpoint หัวข้อปลด mutation)
    mutationsEnabled: env.AI_ASSISTANT_MUTATIONS_ENABLED === "true",
  };
}
