/**
 * เช็คว่ายังมีใคร "ค้างกะ" อยู่ในสาขานี้ของวันนั้นอีกไหม
 *
 * ใช้ service client ตั้งใจ: คนที่กดออกงานคือ staff/cashier ซึ่ง RLS ไม่ให้อ่านแถวของเพื่อนร่วมงาน
 * ถ้าใช้ client ของผู้ใช้จะได้ 0 เสมอ แล้วทุกคนกลายเป็น "คนสุดท้าย" — ผลลัพธ์ที่ผิดแบบเงียบ ๆ
 * ผลลัพธ์ไม่ถูกส่งคืนหน้าจอ ใช้เป็นตัวตัดสินอย่างเดียวว่าจะส่งสรุปยอดถึงเจ้าของหรือยัง
 */
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export interface CountOpenShiftsInput {
  readonly storeId: string;
  readonly organizationId: string;
  /** วันของกะ (YYYY-MM-DD ตามเวลาร้าน) — กะของวันอื่นที่ลืมกดออกต้องไม่บล็อกวันนี้ */
  readonly date: string;
  /** แถวของคนที่เพิ่งกดออกไป กันกรณีสถานะยังไม่ทันอัปเดต */
  readonly excludeRecordId?: string;
}

export interface DailySummaryNotificationClaimInput {
  readonly storeId: string;
  readonly organizationId: string;
  readonly date: string;
  readonly attendanceRecordId: string;
}

export interface CompleteDailySummaryNotificationInput {
  readonly storeId: string;
  readonly organizationId: string;
  readonly date: string;
  readonly delivered: boolean;
}

/**
 * จำนวนคนที่ยังไม่กดออกงานในสาขานี้ของวันนั้น
 * คืน null เมื่ออ่านไม่ได้ — ผู้เรียกต้องตัดสินใจเองว่าจะถือว่า "ไม่แน่ใจ" แปลว่าอะไร
 */
export async function countOpenShiftsInStore(input: CountOpenShiftsInput): Promise<number | null> {
  const supabase = await createSupabaseServiceClient();
  let query = supabase
    .from("attendance_records")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", input.organizationId)
    .eq("store_id", input.storeId)
    .eq("date", input.date)
    .eq("status", "active");
  if (input.excludeRecordId) query = query.neq("id", input.excludeRecordId);

  const { count, error } = await query;
  if (error) return null;
  return count ?? 0;
}

/**
 * จองสิทธิ์ส่งสรุปตอนปิดกะหนึ่งครั้งต่อร้าน/วัน
 * unique index ในฐานข้อมูลเป็นตัวตัด race ระหว่าง after() หลายคำขอแบบ atomic
 */
export async function claimDailySummaryNotification(
  input: DailySummaryNotificationClaimInput,
): Promise<boolean> {
  const supabase = await createSupabaseServiceClient();
  // ตารางเพิ่มใน migration รอบนี้ จึง cast ชั่วคราวจนกว่าจะ regenerate database types รอบถัดไป
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = supabase.from("daily_summary_notification_log") as any;
  const { error } = await table.insert({
    organization_id: input.organizationId,
    store_id: input.storeId,
    summary_date: input.date,
    attendance_record_id: input.attendanceRecordId,
    delivery_status: "claimed",
  });
  if (!error) return true;
  if ((error as { code?: string }).code === "23505") return false;
  throw error;
}

/**
 * เก็บผลลัพธ์เพื่อ audit เท่านั้น ไม่ลบ claim เมื่อส่งล้มเหลว เพราะ provider อาจส่งสำเร็จบางช่องทางแล้ว
 * การ retry อัตโนมัติในสถานะไม่แน่นอนอาจทำให้เจ้าของได้ข้อความซ้ำ
 */
export async function completeDailySummaryNotification(
  input: CompleteDailySummaryNotificationInput,
): Promise<void> {
  const supabase = await createSupabaseServiceClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = supabase.from("daily_summary_notification_log") as any;
  const { error } = await table
    .update({
      delivery_status: input.delivered ? "sent" : "failed",
      completed_at: new Date().toISOString(),
    })
    .eq("organization_id", input.organizationId)
    .eq("store_id", input.storeId)
    .eq("summary_date", input.date);
  if (error) throw error;
}
