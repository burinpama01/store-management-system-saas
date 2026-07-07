import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { notifyOwnerNow } from "./dispatcher";

/**
 * สแกนโต๊ะบุฟเฟต์ที่ session ใกล้หมดเวลา แล้วแจ้งเตือนเจ้าของ (เรียกจาก cron)
 * กันแจ้งซ้ำต่อรอบเปิดโต๊ะด้วย tables.buffet_expiry_notified_at — เปิดโต๊ะรอบใหม่
 * (session_started_at ใหม่กว่า) จะแจ้งได้อีกครั้งเอง
 */
export async function notifyBuffetExpiringSoon(
  warnWithinMinutes = 15,
): Promise<{ notified: number }> {
  const supabase = await createSupabaseServiceClient();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const cutoffIso = new Date(now + warnWithinMinutes * 60_000).toISOString();

  const { data: tables, error } = await supabase
    .from("tables")
    .select(
      "id, organization_id, store_id, number, label, session_started_at, session_expires_at, buffet_expiry_notified_at",
    )
    .gt("session_expires_at", nowIso)
    .lte("session_expires_at", cutoffIso);
  if (error || !tables || tables.length === 0) return { notified: 0 };

  const candidates = tables.filter(
    (t) =>
      !t.buffet_expiry_notified_at ||
      (t.session_started_at !== null && t.buffet_expiry_notified_at < t.session_started_at),
  );
  if (candidates.length === 0) return { notified: 0 };

  // เฉพาะโต๊ะที่เป็นบุฟเฟต์จริง (มี buffet session เปิดอยู่)
  const tableIds = candidates.map((t) => t.id);
  const { data: sessions } = await supabase
    .from("buffet_sessions")
    .select("table_id")
    .eq("status", "open")
    .in("table_id", tableIds);
  const buffetTableIds = new Set((sessions ?? []).map((s) => s.table_id));

  let notified = 0;
  for (const t of candidates) {
    if (!buffetTableIds.has(t.id) || !t.session_expires_at) continue;
    const minutesLeft = Math.max(
      0,
      Math.round((Date.parse(t.session_expires_at) - now) / 60_000),
    );
    const tableLabel = t.label ?? t.number ?? "-";

    await notifyOwnerNow({
      type: "buffet_expiring",
      organizationId: t.organization_id,
      storeId: t.store_id,
      title: "บุฟเฟต์ใกล้หมดเวลา",
      message: `โต๊ะ ${tableLabel} จะหมดเวลาในอีก ${minutesLeft} นาที`,
      metadata: { tableId: t.id, tableLabel, minutesLeft },
    });

    await supabase
      .from("tables")
      .update({ buffet_expiry_notified_at: new Date().toISOString() })
      .eq("id", t.id);
    notified += 1;
  }

  return { notified };
}
