// ลิงก์สั้นใน SMS ภารกิจสะสม: /m/<slug> → หน้าสมาชิกของร้านพร้อมรหัสลิงก์ที่ใช้งานอยู่
// (ลิงก์หน้าสมาชิกจริงมีรหัสยาว ใส่ใน SMS แล้วเปลืองเครดิต)
import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { getActiveMemberPortalLinkForStore } from "@/modules/customers/member-repository";

export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ storeSlug: string }> }): Promise<Response> {
  const { storeSlug } = await params;
  const home = new URL("/", request.url);
  if (!SLUG_RE.test(storeSlug)) return NextResponse.redirect(home);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- อ่านคอลัมน์ไม่กี่ตัว ไม่ต้องพึ่ง type
  const db: any = await createSupabaseServiceClient();
  const { data: store } = await db.from("stores").select("id, slug, is_active").eq("slug", storeSlug).maybeSingle();
  if (!store || store.is_active !== true) return NextResponse.redirect(home);

  const link = await getActiveMemberPortalLinkForStore(store.id);
  if (!link.data?.token) return NextResponse.redirect(new URL(`/s/${store.slug}`, request.url));

  const target = new URL(`/member/${store.slug}`, request.url);
  target.searchParams.set("code", link.data.token);
  return NextResponse.redirect(target);
}
