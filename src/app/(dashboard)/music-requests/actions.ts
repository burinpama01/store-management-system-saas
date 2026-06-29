"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { listStoreMusicQueue, decideMusicRequest } from "@/modules/music-requests/repository";
import type { MusicRequest, MusicDecisionAction } from "@/modules/music-requests/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISIONS: MusicDecisionAction[] = ["approve", "reject", "play", "skip"];

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

export async function listMusicRequestsAction(): Promise<{
  requests: MusicRequest[];
  error: string | null;
}> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();
    const res = await listStoreMusicQueue(ctx.storeId);
    if (res.error) return { requests: [], error: res.error.userMessage };
    return { requests: res.data, error: null };
  } catch (e) {
    return { requests: [], error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function decideMusicRequestAction(
  requestId: string,
  action: MusicDecisionAction,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    await getStoreContext();
    if (!UUID_RE.test(requestId)) return { error: "คำขอไม่ถูกต้อง" };
    if (!DECISIONS.includes(action)) return { error: "การกระทำไม่ถูกต้อง" };

    const res = await decideMusicRequest(requestId, action);
    if (res.error) return { error: res.error.userMessage };
    revalidatePath("/music-requests", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
