/**
 * สถานะการเป็นพนักงาน (ลาออกแล้วหรือยัง) — ใช้ร่วมกัน: ตัดสิทธิ์เข้าระบบ + ตัดผู้รับแจ้งเตือน
 *   ลาออกแล้ว = มี "วันออกงาน" ในโปรไฟล์ของสาขานั้น และวันนี้ (เวลาสาขา) เลยวันนั้นแล้ว
 *   วันออกงานเองยังนับว่าทำงานอยู่
 */
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export function storeLocalDate(now: Date, timeZone: string | null | undefined): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isEmploymentEnded(endDate: string | null | undefined, today: string): boolean {
  return !!endDate && endDate < today;
}

export interface MembershipLike {
  id: string;
  organization_id: string;
  store_id: string | null;
  role: string;
}

/**
 * สมาชิกภาพที่ต้องตัดเพราะลาออกแล้ว
 *   ผูกสาขา: โปรไฟล์ของสาขานั้นเลยวันออกงานแล้ว
 *   ระดับองค์กร: ไม่ใช่เจ้าของ และมีโปรไฟล์ในองค์กรนั้นอย่างน้อย 1 สาขา ซึ่งเลยวันออกงานแล้วทุกสาขา
 *   (เจ้าของกิจการไม่ถูกตัดเด็ดขาด)
 */
export function resignedMembershipIds(
  memberships: readonly MembershipLike[],
  profiles: readonly { store_id: string; employment_end_date: string | null }[],
  stores: readonly { id: string; organization_id: string; timezone: string | null }[],
  now: Date,
): Set<string> {
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const endedAt = (storeId: string, end: string | null) => {
    const store = storeById.get(storeId);
    return isEmploymentEnded(end, storeLocalDate(now, store?.timezone));
  };
  const out = new Set<string>();
  for (const m of memberships) {
    if (m.role === "owner" || m.role === "super_admin") continue;
    if (m.store_id) {
      const p = profiles.find((x) => x.store_id === m.store_id);
      if (p && endedAt(m.store_id, p.employment_end_date)) out.add(m.id);
      continue;
    }
    const inOrg = profiles.filter((p) => storeById.get(p.store_id)?.organization_id === m.organization_id);
    if (inOrg.length > 0 && inOrg.every((p) => endedAt(p.store_id, p.employment_end_date))) out.add(m.id);
  }
  return out;
}

/**
 * userId ที่ลาออกจากสาขานี้แล้ว (service client) — ใช้ตัดผู้รับแจ้งเตือน
 * เจ้าของกิจการไม่อยู่ในผลลัพธ์เด็ดขาด (แม้มีโปรไฟล์พนักงานที่ตั้งวันออกงานไว้)
 * อ่านไม่ได้ = throw ให้ผู้เรียก log แล้วส่งแบบไม่ตัดใคร (แจ้งเตือนเกินดีกว่าหายเงียบ)
 */
export async function listResignedUserIds(storeId: string, now: Date = new Date()): Promise<Set<string>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- อ่านด้วย service client
  const db: any = await createSupabaseServiceClient();
  const [storeRes, profRes] = await Promise.all([
    db.from("stores").select("timezone, organization_id").eq("id", storeId).maybeSingle(),
    db.from("employee_profiles").select("user_id, employment_end_date").eq("store_id", storeId).not("employment_end_date", "is", null),
  ]);
  if (storeRes.error) throw new Error(storeRes.error.message);
  if (profRes.error) throw new Error(profRes.error.message);
  const today = storeLocalDate(now, storeRes.data?.timezone);
  const ended = ((profRes.data ?? []) as { user_id: string; employment_end_date: string | null }[])
    .filter((p) => isEmploymentEnded(p.employment_end_date, today))
    .map((p) => p.user_id);
  if (ended.length === 0) return new Set();
  const { data: owners, error: ownerErr } = await db
    .from("memberships")
    .select("user_id")
    .eq("organization_id", storeRes.data?.organization_id ?? "")
    .eq("role", "owner")
    .in("user_id", ended);
  if (ownerErr) throw new Error(ownerErr.message);
  const ownerIds = new Set(((owners ?? []) as { user_id: string }[]).map((o) => o.user_id));
  return new Set(ended.filter((id) => !ownerIds.has(id)));
}
