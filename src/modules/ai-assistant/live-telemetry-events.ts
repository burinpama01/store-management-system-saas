// PR3-Live (diagnostics) — คำศัพท์กลางของ telemetry โหมดเสียงสด
//
// ทำไมต้องมีไฟล์นี้: เวลาหน้าร้านบอกว่า "พูดแล้ว AI ไม่ตอบ" เราต้องตอบได้จาก log ว่าพังตรงไหน
// (คำปลุก / ไมค์ / ด่านสิทธิ์ / provider / SDP / WebRTC / tool / ตะกร้า / ลำโพง / การปิด)
// โดยไม่ต้องเดา และไม่ต้องเก็บเสียงหรือข้อความของลูกค้า
//
// ไฟล์นี้ถูก import ทั้งฝั่ง browser และ server จึงต้องมีแต่ค่าคงที่ล้วน ห้ามมี dependency
//
// กฎเหล็ก (บังคับด้วย schema ที่ route + test privacy):
//   - ไม่มี transcript / เสียง / args ดิบ / token / secret ในทุก event
//   - ชื่อ event เป็น allowlist ปิด — ของที่ไม่รู้จักถูกปฏิเสธ ไม่ใช่เก็บไว้เงียบ ๆ
//   - ผู้ส่งฝั่ง browser ไม่มีสิทธิ์บอกว่าตัวเองเป็นใคร (org/store/user มาจาก session ของ server)

/** stage = "ช่วงของเส้นทาง" ที่ event เกิด — ใช้กรอง timeline ให้เหลือเฉพาะจุดที่สนใจ */
export const LIVE_TELEMETRY_STAGES = [
  "wake",
  "mic",
  "session",
  "provider",
  "webrtc",
  "audio",
  "tool",
  "cart",
  "stop",
] as const;
export type LiveTelemetryStage = (typeof LIVE_TELEMETRY_STAGES)[number];

/** result = ผลของ event นั้น ๆ (ไม่ใช่ผลของทั้งเซสชัน) */
export const LIVE_TELEMETRY_RESULTS = ["started", "success", "failed", "blocked", "ended"] as const;
export type LiveTelemetryResult = (typeof LIVE_TELEMETRY_RESULTS)[number];

/**
 * ชื่อ event ทั้งหมดที่ระบบยอมรับ (dot notation ให้ค้นง่ายใน /system/logs)
 *
 * เพิ่มชื่อใหม่ต้องเพิ่มที่นี่ที่เดียว — route ตรวจด้วยรายการนี้ ถ้าไม่มีชื่อ = 400
 * (กันคนเผลอยิง event มั่ว ๆ ขึ้น production แล้ว log กลายเป็นขยะที่อ่านไม่ออก)
 */
export const LIVE_TELEMETRY_EVENTS = [
  // คำปลุกจากเครื่อง (Windows Standby) → ปลายทาง
  "wake.detected",
  "wake.route_started",
  "wake.route_live",
  "wake.route_busy",
  "wake.route_unavailable",
  "wake.route_failed",

  // ไมโครโฟน (ADR-008 เจ้าของไมค์คนเดียวต่อหน้าจอ)
  "mic.claim_started",
  "mic.claimed",
  "mic.claim_failed",
  "mic.released",

  // วงจรชีวิตเซสชันเสียงสด
  "live.requested",
  "live.access_granted",
  "live.access_denied",
  "live.session_create_started",
  "live.session_created",
  "live.session_create_failed",
  "live.stop_requested",
  "live.stopped",
  "live.stop_failed",
  "live.idle_timeout",
  "live.expired",
  "live.network_lost",
  "live.cap_reached",

  // provider (สร้าง ephemeral client secret ฝั่ง server)
  "provider.client_secret_started",
  "provider.client_secret_created",
  "provider.client_secret_failed",

  // WebRTC
  "webrtc.offer_created",
  "webrtc.sdp_exchange_started",
  "webrtc.sdp_exchange_succeeded",
  "webrtc.sdp_exchange_failed",
  "webrtc.connection_state_changed",
  "webrtc.ice_state_changed",
  "webrtc.data_channel_open",
  "webrtc.data_channel_closed",
  "webrtc.data_channel_error",

  // เสียงตอบของผู้ช่วย (จุดที่เคยเงียบแบบไม่มีร่องรอย)
  "audio.remote_track_received",
  "audio.attach_started",
  "audio.play_started",
  "audio.play_succeeded",
  "audio.play_blocked",
  "audio.play_failed",
  "audio.closed",

  // เส้นทาง tool (ฝั่ง server)
  "tool.received",
  "tool.token_verified",
  "tool.token_rejected",
  "tool.rate_limited",
  "tool.cap_reached",
  "tool.not_allowed",
  "tool.dispatch_started",
  "tool.dispatch_succeeded",
  "tool.dispatch_denied",
  "tool.dispatch_failed",

  // ผลลัพธ์ที่ลงตะกร้าจริงบนหน้าขาย (server รู้แค่ว่า tool ผ่าน ไม่รู้ว่า apply สำเร็จไหม)
  "cart.apply_started",
  "cart.apply_succeeded",
  "cart.apply_failed",
  // AI "กดปุ่มคิดเงิน" ให้ (ไม่ได้สร้าง payment เอง) — ต้องเห็นใน timeline ว่าใครเป็นคนเปิดจอ
  "cart.checkout_opened",
] as const;
export type LiveTelemetryEventName = (typeof LIVE_TELEMETRY_EVENTS)[number];

/**
 * เหตุผลการจบเซสชันแบบ normalize ชุดเดียว — ห้ามใช้ string กระจัดกระจาย
 * (ค่าพวกนี้ถูกใช้ทั้งใน event `live.stopped` และข้อความที่ผู้ใช้เห็น)
 */
export const LIVE_STOP_REASONS = [
  "user",
  "idle",
  "expired",
  "cap",
  "network",
  "provider",
  "webrtc",
  "tab_close",
  "unmount",
  "access_revoked",
  "error",
] as const;
export type LiveStopReason = (typeof LIVE_STOP_REASONS)[number];

/**
 * ฟิลด์ต้องห้าม — ถ้าโผล่มาใน payload ให้ **ปฏิเสธทั้งก้อน** ไม่ใช่ strip เงียบ ๆ
 * เพื่อให้คนเขียนโค้ดรู้ทันทีตอน dev ว่าเผลอส่งของที่ห้ามเก็บ
 */
export const LIVE_TELEMETRY_FORBIDDEN_KEYS = [
  "sessiontoken",
  "ephemeraltoken",
  "apikey",
  "api_key",
  "authorization",
  "secret",
  "token",
  "rawaudio",
  "audio",
  "audioblob",
  "transcript",
  "usertext",
  "utterance",
  "args",
  "rawargs",
  "modelrawresponse",
  "response",
  "text",
  "message",
  "query",
  "productphrase",
] as const;

/** เพดานรูปทรงของ payload (บังคับที่ route) — กันทั้ง log ท่วมและ metadata ที่ลึกจนอ่านไม่ออก */
export const LIVE_TELEMETRY_LIMITS = {
  maxBodyBytes: 16 * 1024,
  maxEventsPerRequest: 50,
  maxMetadataKeys: 10,
  maxMetadataKeyLength: 40,
  maxMetadataValueLength: 120,
  maxReasonLength: 64,
  /** จำนวน event ที่ buffer ฝั่ง browser เก็บไว้ให้เปิด DevTools ดูได้ */
  clientBufferSize: 100,
} as const;

export function isLiveTelemetryEventName(value: unknown): value is LiveTelemetryEventName {
  return typeof value === "string" && (LIVE_TELEMETRY_EVENTS as readonly string[]).includes(value);
}

/** คีย์ต้องห้ามเทียบแบบไม่สนตัวพิมพ์/ขีดล่าง — `Session_Token` ต้องโดนเหมือน `sessionToken` */
export function isForbiddenTelemetryKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return (LIVE_TELEMETRY_FORBIDDEN_KEYS as readonly string[]).some((forbidden) =>
    normalized === forbidden.replace(/[_-]/g, ""));
}
