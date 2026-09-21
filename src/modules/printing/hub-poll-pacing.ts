/**
 * จังหวะการ poll ของ Print Hub — server เป็นคนสั่ง ไม่ใช่เครื่องร้านตั้งเอง
 *
 * ที่มา: Hub เดิม poll ทุก 1.5 วินาทีตลอด 24 ชม. ไม่ว่าร้านจะเปิดหรือปิด คิดเป็น
 * ~1.7 ล้าน request/เดือน ต่อเครื่องเดียว
 *
 * รุ่นแรกของไฟล์นี้ตัดสินจากสัญญาณใน DB (พนักงานลงเวลา / รอบเงินสด / ออเดอร์ล่าสุด)
 * ซึ่งต้อง query 3 ครั้งต่อการ poll หนึ่งครั้ง แคชต่อ instance แทบไม่ช่วยเพราะ
 * serverless สร้าง instance ใหม่บ่อย ผลคือ Active CPU ของทั้งโปรเจคพุ่งจนโดน
 * ระงับบริการ (12 ชม. จากเพดาน 4 ชม.) — การรู้ว่า "ร้านเปิดไหม" ไม่คุ้มกับราคานั้น
 *
 * รุ่นนี้ตัดสินจากสิ่งที่ Hub ส่งมาเองในคำขอ (ไม่แตะ DB เลย): เพิ่งได้งานไปพิมพ์ไหม
 * และว่างมานานแค่ไหนแล้ว ซึ่งเป็นตัวแทนของ "ร้านกำลังขายอยู่ไหม" ที่ดีพอ ๆ กัน
 * และมีราคาเป็นศูนย์
 */

/** ร้านกำลังขายอยู่ — เท่ากับพฤติกรรมเดิมทุกประการ */
export const HUB_POLL_ACTIVE_MS = 1_500;
/**
 * คิวว่างแต่เพิ่งมีงานไม่นาน
 *
 * เคยตั้งไว้ 10 วินาทีด้วยเหตุผลว่า "ว่างแปลว่าไม่มีใครรอ" ซึ่งผิด และที่ร้านเจอจริง
 * ว่าพิมพ์ช้ากว่าปกติมาก: ใบที่ออกหลังคิวว่างคือใบที่ลูกค้ายืนรออยู่ตรงหน้าเคาน์เตอร์
 * พอดี ค่านี้จึงต้องอยู่ในระดับที่คนหน้าร้านไม่ทันสังเกต
 */
export const HUB_POLL_IDLE_MS = 2_000;
/**
 * เงียบมานานจนถือว่าร้านปิดแล้ว
 *
 * 60 วินาทีเดิมยาวเกินไปเมื่ออ่านสถานะผิด ค่านี้คือค่าที่ทำงานตอนเราเดาผิด
 * จึงต้อง "แย่แต่ไม่พัง"
 */
export const HUB_POLL_CLOSED_MS = 15_000;

/**
 * เงียบเกินเท่าไรจึงถือว่าร้านปิด
 *
 * 2 ชั่วโมงไม่มีงานพิมพ์สักใบ = ไม่ใช่ช่วงพักระหว่างลูกค้าแล้ว ถ้าเดาผิดก็แค่
 * ใบแรกของวันช้าไป 15 วินาที ซึ่ง busy window ฝั่ง Hub ดึงกลับมาทันทีหลังจากนั้น
 */
export const HUB_QUIET_UNTIL_CLOSED_MS = 2 * 60 * 60 * 1000;

export type HubActivityReason = "jobs" | "recent" | "quiet";

export interface HubPacingInput {
  /** poll รอบนี้เคลมงานได้กี่ใบ */
  claimedJobs: number;
  /**
   * Hub ว่างมากี่มิลลิวินาทีแล้ว (นับจากงานที่มันพิมพ์ล่าสุด)
   * Hub รุ่นเก่าไม่ส่งค่านี้ = null = ไม่รู้ ต้องถือว่าร้านเปิดไว้ก่อน
   */
  idleMs: number | null;
}

export interface HubPollPacing {
  nextPollMs: number;
  reason: HubActivityReason;
}

/**
 * แปลงสถานะที่ Hub รายงานมาเป็นจังหวะ poll รอบถัดไป
 *
 * ไม่รู้ = ถือว่าร้านเปิด เสมอ — พลาดทางนี้แค่เปลือง request ส่วนพลาดอีกทางคือ
 * ใบเสร็จออกช้าต่อหน้าลูกค้า
 */
export function resolveHubPollPacing(input: HubPacingInput): HubPollPacing {
  if (input.claimedJobs > 0) return { nextPollMs: HUB_POLL_ACTIVE_MS, reason: "jobs" };
  if (input.idleMs === null) return { nextPollMs: HUB_POLL_IDLE_MS, reason: "recent" };
  if (input.idleMs >= HUB_QUIET_UNTIL_CLOSED_MS) {
    return { nextPollMs: HUB_POLL_CLOSED_MS, reason: "quiet" };
  }
  return { nextPollMs: HUB_POLL_IDLE_MS, reason: "recent" };
}

/** ค่า idleMs ที่ Hub ส่งมา — ปฏิเสธค่าที่ใช้ไม่ได้แทนการเดา */
export function sanitizeHubIdleMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}
