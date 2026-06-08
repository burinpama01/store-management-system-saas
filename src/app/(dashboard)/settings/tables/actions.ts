"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { createTable, updateTable, deleteTable } from "@/modules/stores/repository";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

function parseInput(formData: FormData): { error: string } | {
  number: string; label?: string; seats?: number; isActive: boolean; qrEnabled: boolean;
} {
  const number = String(formData.get("number") ?? "").trim();
  if (!number || number.length > 20) return { error: "เลขโต๊ะไม่ถูกต้อง (1–20 ตัวอักษร)" };
  const label = String(formData.get("label") ?? "").trim().slice(0, 50) || undefined;
  const seatsRaw = String(formData.get("seats") ?? "").trim();
  let seats: number | undefined;
  if (seatsRaw) {
    const n = parseInt(seatsRaw, 10);
    if (isNaN(n) || n < 0 || n > 100) return { error: "จำนวนที่นั่งไม่ถูกต้อง (0–100)" };
    seats = n;
  }
  return {
    number,
    label,
    seats,
    isActive: formData.get("isActive") === "on",
    qrEnabled: formData.get("qrEnabled") === "on",
  };
}

export async function saveTableAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.view");
    const { ctx } = await getStoreContext();
    const parsed = parseInput(formData);
    if ("error" in parsed) return { error: parsed.error };

    const id = String(formData.get("id") ?? "").trim();
    if (id) {
      if (!UUID_RE.test(id)) return { error: "โต๊ะไม่ถูกต้อง" };
      const res = await updateTable(id, ctx.storeId, parsed);
      if (res.error) return { error: res.error.userMessage };
    } else {
      const res = await createTable(ctx.storeId, ctx.organizationId, parsed);
      if (res.error) return { error: res.error.userMessage };
    }
    revalidatePath("/settings/tables", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteTableAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.view");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(id)) return { error: "โต๊ะไม่ถูกต้อง" };
    const res = await deleteTable(id, ctx.storeId);
    if (res.error) return { error: res.error.userMessage };
    revalidatePath("/settings/tables", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
