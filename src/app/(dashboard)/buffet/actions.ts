"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import {
  createBuffetSession,
  updateGuestCount,
  closeBuffetSession,
  listStoreTables,
} from "@/modules/buffet/repository";
import { openTableSession, getStore } from "@/modules/stores/repository";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  // Enforce feature flag in every action — page-level redirect is UX only, not security.
  const storeRow = stores.find((s) => s.id === ctx.storeId);
  if (!storeRow?.buffet_enabled) throw new Error("ร้านค้านี้ยังไม่เปิดใช้งานโหมดบุฟเฟต์");
  return { user, ctx };
}

function revalidate() {
  revalidatePath("/buffet", "page");
}

export async function createSessionAction(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();

    const tableId = (formData.get("tableId") as string | null)?.trim() ?? "";
    const packageName = (formData.get("packageName") as string | null)?.trim() ?? "";
    const priceRaw = formData.get("pricePerGuest") as string | null;
    const guestRaw = formData.get("guestCount") as string | null;

    if (tableId && !UUID_RE.test(tableId)) return { error: "โต๊ะไม่ถูกต้อง" };
    if (!packageName) return { error: "กรุณาระบุชื่อแพ็กเกจ" };
    if (packageName.length > 100) return { error: "ชื่อแพ็กเกจยาวเกิน 100 ตัวอักษร" };

    const price = parseFloat(priceRaw ?? "");
    if (isNaN(price) || price < 0 || price > 100_000)
      return { error: "ราคาต่อคนไม่ถูกต้อง (0–100,000)" };

    const guestCount = parseInt(guestRaw ?? "", 10);
    if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 500)
      return { error: "จำนวนผู้เข้าร่วมไม่ถูกต้อง (1–500)" };

    // Verify tableId belongs to this store (B-05)
    if (tableId) {
      const tablesRes = await listStoreTables(ctx.storeId);
      if (!tablesRes.data?.find((t) => t.id === tableId))
        return { error: "ไม่พบโต๊ะนี้ในร้านค้า" };
    }

    const result = await createBuffetSession({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      tableId: tableId || undefined,
      packageName,
      pricePerGuest: Math.round(price * 100) / 100,
      guestCount,
    });
    if (result.error) return { error: result.error.userMessage };

    // Open a timed table session (QR validity) from the package duration, fallback to store default.
    if (tableId) {
      const durationRaw = parseInt((formData.get("durationMinutes") as string | null) ?? "", 10);
      let minutes = Number.isInteger(durationRaw) && durationRaw >= 15 && durationRaw <= 600 ? durationRaw : 0;
      if (!minutes) {
        const storeRes = await getStore(ctx.storeId);
        minutes = storeRes.data?.dineInDurationMinutes ?? 120;
      }
      await openTableSession(ctx.storeId, tableId, minutes);
    }

    revalidate();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function updateGuestCountAction(
  id: string,
  guestCount: number,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();

    if (!UUID_RE.test(id)) return { error: "ID ไม่ถูกต้อง" };
    if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 500)
      return { error: "จำนวนผู้เข้าร่วมไม่ถูกต้อง (1–500)" };

    const result = await updateGuestCount(id, ctx.storeId, guestCount);
    if (result.error) return { error: result.error.userMessage };

    revalidate();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function closeSessionAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();

    if (!UUID_RE.test(id)) return { error: "ID ไม่ถูกต้อง" };

    // Atomic close — repository enforces status="open" guard; no pre-check needed (B-01).
    const result = await closeBuffetSession(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };

    revalidate();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
