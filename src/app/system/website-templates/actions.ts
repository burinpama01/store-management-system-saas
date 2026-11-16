"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, requireSystemAccess } from "@/modules/auth/guards";
import { themeSchema } from "@/modules/store-website/schema";
import { TEMPLATE_ID_RE, type TemplateBusiness, type TemplateStyle } from "@/modules/store-website/templates";
import { upsertLibraryTemplate } from "@/modules/store-website/template-library";
import { updateWebsiteDomain } from "@/modules/store-website/repository";
import { logSystemEvent } from "@/modules/system/event-log";

const BUSINESSES: TemplateBusiness[] = ["cafe", "restaurant", "grocery"];
const STYLES: TemplateStyle[] = ["minimal", "cute", "luxury"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function systemUser() {
  try {
    return await requireSystemAccess();
  } catch (e) {
    if (e instanceof AuthorizationError) return null;
    throw e;
  }
}

/** เพิ่ม/แก้เทมเพลตในคลังรายเดือน — เผยแพร่แล้วร้าน Enterprise ทุกร้านเลือกใช้ได้ทันที (ไม่ต้อง deploy) */
export async function saveLibraryTemplateAction(fd: FormData): Promise<void> {
  const user = await systemUser();
  if (!user) return;
  const id = String(fd.get("id") ?? "").trim().toLowerCase();
  const name = String(fd.get("name") ?? "").trim().slice(0, 60);
  const business = String(fd.get("business") ?? "") as TemplateBusiness;
  const style = String(fd.get("style") ?? "") as TemplateStyle;
  const description = String(fd.get("description") ?? "").trim().slice(0, 160);
  const isPublished = fd.get("isPublished") === "on";
  if (!TEMPLATE_ID_RE.test(id) || !name || !BUSINESSES.includes(business) || !STYLES.includes(style)) return;
  const theme = themeSchema.safeParse({
    style,
    primary: String(fd.get("primary") ?? ""),
    accent: String(fd.get("accent") ?? ""),
    background: String(fd.get("background") ?? ""),
    surface: String(fd.get("surface") ?? ""),
    text: String(fd.get("text") ?? ""),
    font: String(fd.get("font") ?? ""),
    radius: String(fd.get("radius") ?? ""),
  });
  if (!theme.success) return;
  const error = await upsertLibraryTemplate({ id, name, business, style, description, theme: theme.data, isPublished, userId: user.id });
  void logSystemEvent({
    level: error ? "error" : "info",
    source: "store-website.templates",
    action: "saveLibraryTemplate",
    message: error ? `บันทึกเทมเพลตคลังไม่สำเร็จ: ${error}` : `บันทึกเทมเพลตคลัง ${id}${isPublished ? " (เผยแพร่)" : " (ร่าง)"}`,
    actorUserId: user.id,
    context: { id, business, style, isPublished },
  });
  revalidatePath("/system/website-templates");
  revalidatePath("/website");
}

/** ผู้ดูแลต่อโดเมนใน Vercel เองแล้ว (กรณีเซิร์ฟเวอร์ไม่มี VERCEL_TOKEN) → ตั้งสถานะโดเมนร้าน */
export async function setDomainStatusAction(fd: FormData): Promise<void> {
  const user = await systemUser();
  if (!user) return;
  const storeId = String(fd.get("storeId") ?? "");
  const status = String(fd.get("status") ?? "");
  if (!UUID_RE.test(storeId) || !["pending", "active", "error"].includes(status)) return;
  const note = String(fd.get("note") ?? "").trim().slice(0, 300) || null;
  const result = await updateWebsiteDomain(storeId, { custom_domain_status: status as "pending" | "active" | "error", custom_domain_note: note }, { checked: true, requireDomain: true });
  void logSystemEvent({
    level: result.error ? "error" : "info",
    source: "store-website.domains",
    action: "setDomainStatus",
    message: result.error ? `ตั้งสถานะโดเมนไม่สำเร็จ: ${result.error}` : `ผู้ดูแลตั้งสถานะโดเมนร้านเป็น ${status}`,
    storeId,
    actorUserId: user.id,
    context: { status },
  });
  revalidatePath("/system/website-templates");
}
