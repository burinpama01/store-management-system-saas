"use server";

/**
 * พนักงานขอเบิกเงิน / ยกเลิกคำขอ (B2) — ตรวจเพดานฝั่ง server ทุกครั้ง · log ทุกขั้น
 */
import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { logSystemEvent } from "@/modules/system/event-log";
import { getAdvanceAvailability } from "@/modules/hr/advanced/salary-advance-service";
import { getSalaryAdvance, insertSalaryAdvance, updateSalaryAdvanceFrom } from "@/modules/hr/advanced/repository";
import { formatBaht, listStoreManagerUserIds, pushPayrollNotification } from "@/modules/hr/advanced/notify";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function done() {
  revalidatePath("/my-advance", "page");
  revalidatePath("/staff", "page");
}

export async function requestSalaryAdvanceAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("attendance.clock")) return { error: "ไม่มีสิทธิ์" };
    const amount = Math.round(parseFloat(String(formData.get("amount") ?? "").replace(/,/g, "")) * 100) / 100;
    const reason = String(formData.get("reason") ?? "").trim().slice(0, 200);
    if (!(amount > 0)) return { error: "ใส่จำนวนเงินที่ต้องการเบิก" };

    const av = await getAdvanceAvailability({ organizationId: ctx.organizationId, storeId: ctx.storeId, userId: user.id });
    if (!av.enabled) return { error: "ร้านนี้ยังไม่เปิดให้เบิกเงิน" };
    if (!av.hasProfile) return { error: "ยังไม่ได้ตั้งค่าจ้างของคุณ — ติดต่อผู้จัดการ" };
    if (av.cap.blockedReason) return { error: av.cap.blockedReason };
    if (amount > av.cap.available) return { error: `เบิกได้ไม่เกิน ${formatBaht(av.cap.available)} (ตามค่าแรงจากวันที่มาทำงานแล้ว)` };

    const created = await insertSalaryAdvance({
      organization_id: ctx.organizationId,
      store_id: ctx.storeId,
      user_id: user.id,
      status: "pending",
      requested_amount: amount,
      reason: reason || null,
      cycle_start: av.cycle.start,
      requested_by: user.id,
    });
    if (created.error || !created.data) return { error: "ส่งคำขอไม่สำเร็จ กรุณาลองใหม่" };
    // ตรวจซ้ำหลังบันทึก: สองคำขอผ่านการตรวจพร้อมกันแล้วรวมเกินเพดาน = ยกเลิกคำขอนี้
    const after = await getAdvanceAvailability({ organizationId: ctx.organizationId, storeId: ctx.storeId, userId: user.id });
    if (after.cap.overLimit) {
      await updateSalaryAdvanceFrom(ctx.storeId, created.data.id, "pending", { status: "cancelled", decision_note: "เกินเพดาน (ส่งซ้อนกัน)" });
      return { error: "มีคำขออื่นส่งพร้อมกันจนเกินเพดาน — ตรวจยอดเบิกได้แล้วลองใหม่" };
    }

    await logSystemEvent({
      level: "info",
      source: "hr.salary-advance",
      action: "requestSalaryAdvanceAction",
      message: `ขอเบิกเงิน ${formatBaht(amount)} (เบิกได้ ${formatBaht(av.cap.available)})`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { advanceId: created.data.id, amount, available: av.cap.available, earned: av.earned, cycleStart: av.cycle.start },
    });
    await pushPayrollNotification({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      userIds: (await listStoreManagerUserIds(ctx.organizationId, ctx.storeId)).filter((id) => id !== user.id),
      kind: "advance_requested",
      dedupeKey: created.data.id,
      title: `${av.employeeName} ขอเบิกเงิน ${formatBaht(amount)}`,
      message: `ค่าแรงจากวันที่มาแล้ว ${formatBaht(av.earned)} · อนุมัติได้ที่หน้าพนักงาน แท็บเงินเดือน${reason ? ` · เหตุผล: ${reason}` : ""}`,
    }).catch(() => undefined);
    done();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function cancelSalaryAdvanceAction(id: string): Promise<{ error: string | null }> {
  try {
    const { user, ctx } = await getResolvedCurrentPermissions();
    if (!UUID_RE.test(id)) return { error: "คำขอไม่ถูกต้อง" };
    const adv = await getSalaryAdvance(ctx.storeId, id);
    if (!adv || adv.userId !== user.id) return { error: "ไม่พบคำขอ" };
    const r = await updateSalaryAdvanceFrom(ctx.storeId, id, "pending", { status: "cancelled", decided_by: user.id, decided_at: new Date().toISOString() });
    if (r.error) return { error: "ยกเลิกไม่สำเร็จ" };
    if (!r.data) return { error: "คำขอนี้ถูกดำเนินการไปแล้ว" };
    await logSystemEvent({
      level: "info",
      source: "hr.salary-advance",
      action: "cancelSalaryAdvanceAction",
      message: `ยกเลิกคำขอเบิก ${formatBaht(adv.requestedAmount)}`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { advanceId: id },
    });
    done();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
