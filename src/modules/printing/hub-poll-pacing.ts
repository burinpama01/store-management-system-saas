/**
 * จังหวะการ poll ของ Print Hub — server เป็นคนสั่ง ไม่ใช่เครื่องร้านตั้งเอง
 *
 * ที่มา: Hub เดิม poll ทุก 1.5 วินาทีตลอด 24 ชม. ไม่ว่าร้านจะเปิดหรือปิด คิดเป็น
 * ~1.7 ล้าน request/เดือน ต่อเครื่องเดียว ซึ่งทะลุโควตา Vercel free tier (1M)
 * และโดน pause ทั้งโปรเจค = ทุกร้านใช้งานไม่ได้
 *
 * แนวคิด: ส่ง `nextPollMs` กลับไปกับ response ของ /api/print/hub/poll ที่ Hub
 * เรียกอยู่แล้ว (ไม่เปลือง request เพิ่มแม้แต่ครั้งเดียว) โดยดูจากสัญญาณว่าร้าน
 * "มีคนอยู่" จริงไหม — พนักงานลงเวลาเข้างานค้างอยู่ / รอบเงินสดเปิดอยู่ /
 * เพิ่งมีออเดอร์
 *
 * กติกาที่ห้ามพัง: การพิมพ์ต้องไม่ขึ้นกับการลงเวลา ถ้าพนักงานลืมลงเวลาหรือ query
 * ล้ม ต้องคืนค่า ACTIVE (ถี่) เสมอ — อย่างแย่ที่สุดคือเปลือง request ไม่ใช่
 * ใบเสร็จไม่ออก ฝั่ง Hub ยังมี busy window ของตัวเองที่ดึงกลับมา 250ms ทันที
 * ที่มีงานจริง ค่านี้จึงกระทบแค่ "ตอนไม่มีอะไรให้พิมพ์"
 */

/** ร้านเปิดและมีงานเข้าอยู่ — เท่ากับพฤติกรรมเดิมทุกประการ */
export const HUB_POLL_ACTIVE_MS = 1_500;
/** ร้านเปิดอยู่แต่คิวว่าง — ใบเสร็จช้าสุด 10 วิ ก่อน busy window จะดึงกลับมาถี่ */
export const HUB_POLL_IDLE_MS = 10_000;
/** ไม่มีสัญญาณว่าร้านเปิด (นอกเวลาทำการ) */
export const HUB_POLL_CLOSED_MS = 60_000;

/** ถือว่า "เพิ่งมีออเดอร์" ภายในกี่มิลลิวินาที */
export const RECENT_ORDER_WINDOW_MS = 30 * 60 * 1000;

/**
 * อายุสูงสุดของการลงเวลาที่ยังนับว่า "คนนั้นอยู่ที่ร้านจริง"
 *
 * ระบบไม่มี auto clock-out (ไม่มี cron ปิดกะสิ้นวัน) แถวที่พนักงานลืมกดออกงาน
 * จึงค้าง clock_out_at = null ถาวร ถ้านับตรง ๆ staffOnDuty จะเป็น true ตลอดกาล
 * และ Hub จะไม่เข้าโหมดร้านปิดอีกเลย — ดีไซน์พังเงียบโดยไม่มีใครรู้
 *
 * 16 ชั่วโมงเผื่อกะยาวสุดที่เป็นไปได้จริง (เปิดร้านถึงปิดร้าน + ปิดยอด) ไว้เต็มที่แล้ว
 * เกินกว่านี้แปลว่าลืมกด ไม่ใช่ยังทำงานอยู่
 */
export const STAFF_SHIFT_MAX_MS = 16 * 60 * 60 * 1000;

export type HubActivityReason = "jobs" | "staff" | "cashSession" | "recentOrder" | "idle";

export interface HubActivitySignals {
  /** poll รอบนี้เคลมงานได้กี่ใบ */
  claimedJobs: number;
  /** มีพนักงานลงเวลาเข้างานแล้วยังไม่ออก */
  staffOnDuty: boolean;
  /** มีรอบเงินสดที่เปิดอยู่ */
  cashSessionOpen: boolean;
  /** มีออเดอร์ภายใน RECENT_ORDER_WINDOW_MS */
  recentOrder: boolean;
  /** query สัญญาณล้มเหลว — ต้อง fail-safe เป็น ACTIVE */
  signalsUnavailable?: boolean;
}

export interface HubPollPacing {
  nextPollMs: number;
  reason: HubActivityReason;
}

/**
 * แปลงสัญญาณเป็นจังหวะ poll รอบถัดไป
 *
 * ลำดับความสำคัญ: มีงานพิมพ์ > มีคนอยู่ที่ร้าน > ปิด
 * `signalsUnavailable` ชนะทุกอย่าง เพราะไม่รู้ = ต้องถือว่าร้านเปิด
 */
export function resolveHubPollPacing(signals: HubActivitySignals): HubPollPacing {
  if (signals.signalsUnavailable) {
    return { nextPollMs: HUB_POLL_ACTIVE_MS, reason: "jobs" };
  }
  if (signals.claimedJobs > 0) {
    return { nextPollMs: HUB_POLL_ACTIVE_MS, reason: "jobs" };
  }
  if (signals.staffOnDuty) {
    return { nextPollMs: HUB_POLL_IDLE_MS, reason: "staff" };
  }
  if (signals.cashSessionOpen) {
    return { nextPollMs: HUB_POLL_IDLE_MS, reason: "cashSession" };
  }
  if (signals.recentOrder) {
    return { nextPollMs: HUB_POLL_IDLE_MS, reason: "recentOrder" };
  }
  return { nextPollMs: HUB_POLL_CLOSED_MS, reason: "idle" };
}
