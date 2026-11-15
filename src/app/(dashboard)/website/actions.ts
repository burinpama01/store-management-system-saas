"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { canUseMemberPrivileges } from "@/modules/members/access";
import { isOpsManagerRole } from "@/modules/operations/access";
import {
  createStoreWebsite,
  getStoreWebsite,
  getWebsiteVersion,
  isSlugTaken,
  publishStoreWebsite,
  updateStoreWebsite,
} from "@/modules/store-website/repository";
import { normalizeSlug, parseWebsiteDocument, validateSlug, type WebsiteDocument } from "@/modules/store-website/schema";
import { documentFromTemplate, findTemplate } from "@/modules/store-website/templates";
import { FESTIVALS, festivalSettingsSchema, type FestivalSettings } from "@/modules/store-website/festivals";
import { logSystemEvent } from "@/modules/system/event-log";

type ActionResult = { ok: boolean; error: string | null };

const LOCK = "เว็บไซต์ร้านใช้ได้เฉพาะแพ็กเกจ Enterprise";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function guard() {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!isOpsManagerRole(resolved.role)) return { error: "เฉพาะเจ้าของหรือแอดมินที่แก้เว็บไซต์ร้านได้" as const };
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseMemberPrivileges(billing)) return { error: LOCK };
  return { user, ctx, error: null };
}

function log(
  level: "info" | "warn" | "error",
  action: string,
  message: string,
  g: { user: { id: string }; ctx: { organizationId: string; storeId: string } },
  context?: Record<string, unknown>,
) {
  void logSystemEvent({
    level,
    source: "store-website",
    action,
    message,
    organizationId: g.ctx.organizationId,
    storeId: g.ctx.storeId,
    actorUserId: g.user.id,
    context,
  });
}

function revalidateSite(slug: string | null | undefined) {
  if (slug) revalidatePath(`/s/${slug}`);
  revalidatePath("/website");
}

export async function createWebsiteAction(rawSlug: string, templateId: string): Promise<ActionResult> {
  try {
    const g = await guard();
    if (g.error !== null) return { ok: false, error: g.error };
    const slug = normalizeSlug(rawSlug);
    const invalid = validateSlug(slug);
    if (invalid) return { ok: false, error: invalid };
    const template = findTemplate(templateId);
    if (!template) return { ok: false, error: "เลือกเทมเพลต" };
    if (await isSlugTaken(slug, g.ctx.storeId)) return { ok: false, error: "ลิงก์นี้มีร้านอื่นใช้แล้ว" };
    const document = documentFromTemplate(template, g.ctx.storeName ?? "ร้านของเรา");
    const result = await createStoreWebsite({
      storeId: g.ctx.storeId,
      organizationId: g.ctx.organizationId,
      slug,
      templateId,
      document,
      userId: g.user.id,
    });
    log(result.error ? "error" : "info", "createWebsite", result.error ? `สร้างเว็บไม่สำเร็จ: ${result.error}` : "สร้างเว็บไซต์ร้าน", g, { slug, templateId });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidatePath("/website");
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "สร้างเว็บไม่สำเร็จ" };
  }
}

export async function saveDraftAction(document: WebsiteDocument): Promise<ActionResult> {
  try {
    const g = await guard();
    if (g.error !== null) return { ok: false, error: g.error };
    const parsed = parseWebsiteDocument(document);
    if (parsed.error !== null) return { ok: false, error: parsed.error };
    const result = await updateStoreWebsite(g.ctx.storeId, { draft_document: parsed.data }, g.user.id);
    if (result.error !== null) {
      log("error", "saveDraft", `บันทึกฉบับร่างไม่สำเร็จ: ${result.error}`, g);
      return { ok: false, error: result.error };
    }
    log("info", "saveDraft", "บันทึกฉบับร่างเว็บไซต์", g, { blocks: parsed.data.blocks.length });
    revalidatePath("/website");
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" };
  }
}

/** เปลี่ยนเทมเพลต = เปลี่ยนธีม (สี/ฟอนต์/สไตล์) — บล็อกและเนื้อหาของร้านอยู่ครบ */
export async function applyTemplateThemeAction(templateId: string, document: WebsiteDocument): Promise<ActionResult & { document?: WebsiteDocument }> {
  try {
    const g = await guard();
    if (g.error !== null) return { ok: false, error: g.error };
    const template = findTemplate(templateId);
    if (!template) return { ok: false, error: "ไม่พบเทมเพลต" };
    const parsed = parseWebsiteDocument({ ...document, theme: template.theme });
    if (parsed.error !== null) return { ok: false, error: parsed.error };
    const result = await updateStoreWebsite(g.ctx.storeId, { draft_document: parsed.data, template_id: templateId }, g.user.id);
    log(result.error ? "error" : "info", "applyTemplate", result.error ? `เปลี่ยนเทมเพลตไม่สำเร็จ: ${result.error}` : "เปลี่ยนเทมเพลตเว็บไซต์", g, { templateId });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidatePath("/website");
    return { ok: true, error: null, document: parsed.data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "เปลี่ยนเทมเพลตไม่สำเร็จ" };
  }
}

export async function updateSlugAction(rawSlug: string): Promise<ActionResult & { slug?: string }> {
  try {
    const g = await guard();
    if (g.error !== null) return { ok: false, error: g.error };
    const slug = normalizeSlug(rawSlug);
    const invalid = validateSlug(slug);
    if (invalid) return { ok: false, error: invalid };
    const current = await getStoreWebsite(g.ctx.storeId);
    if (!current) return { ok: false, error: "ยังไม่ได้สร้างเว็บ" };
    if (current.slug === slug) return { ok: true, error: null, slug };
    if (await isSlugTaken(slug, g.ctx.storeId)) return { ok: false, error: "ลิงก์นี้มีร้านอื่นใช้แล้ว" };
    const result = await updateStoreWebsite(g.ctx.storeId, { slug }, g.user.id);
    log(result.error ? "error" : "info", "updateSlug", result.error ? `เปลี่ยนลิงก์ไม่สำเร็จ: ${result.error}` : "เปลี่ยนลิงก์เว็บไซต์", g, { from: current.slug, to: slug });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidateSite(current.slug);
    revalidateSite(slug);
    return { ok: true, error: null, slug };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "เปลี่ยนลิงก์ไม่สำเร็จ" };
  }
}

/** เผยแพร่ฉบับร่างที่บันทึกล่าสุด (ส่งเอกสารมาด้วย = บันทึกแล้วเผยแพร่ในครั้งเดียว) */
export async function publishWebsiteAction(document: WebsiteDocument): Promise<ActionResult> {
  try {
    const g = await guard();
    if (g.error !== null) return { ok: false, error: g.error };
    const parsed = parseWebsiteDocument(document);
    if (parsed.error !== null) return { ok: false, error: parsed.error };
    const saved = await updateStoreWebsite(g.ctx.storeId, { draft_document: parsed.data }, g.user.id);
    if (saved.error !== null) return { ok: false, error: saved.error };
    const result = await publishStoreWebsite(g.ctx.storeId, g.ctx.organizationId, parsed.data, g.user.id);
    log(result.error ? "error" : "info", "publishWebsite", result.error ? `เผยแพร่ไม่สำเร็จ: ${result.error}` : "เผยแพร่เว็บไซต์ร้าน", g, { blocks: parsed.data.blocks.length });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidateSite(result.data);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "เผยแพร่ไม่สำเร็จ" };
  }
}

export async function setWebsiteEnabledAction(enabled: boolean): Promise<ActionResult> {
  try {
    const g = await guard();
    if (g.error !== null) return { ok: false, error: g.error };
    const current = await getStoreWebsite(g.ctx.storeId);
    if (!current) return { ok: false, error: "ยังไม่ได้สร้างเว็บ" };
    if (enabled && !current.published) return { ok: false, error: "กดเผยแพร่อย่างน้อยหนึ่งครั้งก่อนเปิดเว็บ" };
    const result = await updateStoreWebsite(g.ctx.storeId, { is_enabled: enabled }, g.user.id);
    log(result.error ? "error" : "info", "setWebsiteEnabled", result.error ? `เปลี่ยนสถานะเว็บไม่สำเร็จ: ${result.error}` : enabled ? "เปิดเว็บไซต์ร้าน" : "ปิดเว็บไซต์ร้าน", g, { enabled });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidateSite(current.slug);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" };
  }
}

/** ย้อนกลับเป็นฉบับที่เคยเผยแพร่ (ใส่เป็นฉบับร่าง — ยังต้องกดเผยแพร่) */
export async function restoreVersionAction(versionId: string): Promise<ActionResult & { document?: WebsiteDocument }> {
  try {
    const g = await guard();
    if (g.error !== null) return { ok: false, error: g.error };
    if (!UUID_RE.test(versionId)) return { ok: false, error: "ข้อมูลไม่ถูกต้อง" };
    const document = await getWebsiteVersion(g.ctx.storeId, versionId);
    if (!document) return { ok: false, error: "ไม่พบฉบับที่เลือก" };
    const result = await updateStoreWebsite(g.ctx.storeId, { draft_document: document }, g.user.id);
    log(result.error ? "error" : "info", "restoreVersion", result.error ? `ย้อนฉบับไม่สำเร็จ: ${result.error}` : "ย้อนฉบับเว็บไซต์เป็นฉบับร่าง", g, { versionId });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidatePath("/website");
    return { ok: true, error: null, document };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "ย้อนฉบับไม่สำเร็จ" };
  }
}

/** ตั้งค่าเทศกาล (S1) — เปลี่ยนชุดตกแต่งอัตโนมัติ / แสดงล่วงหน้า / ปิดบางเทศกาล */
export async function saveFestivalSettingsAction(settings: FestivalSettings): Promise<ActionResult> {
  try {
    const g = await guard();
    if (g.error !== null) return { ok: false, error: g.error };
    const parsed = festivalSettingsSchema.safeParse(settings);
    if (!parsed.success) return { ok: false, error: "ตั้งค่าเทศกาลไม่ถูกต้อง" };
    const known = new Set(FESTIVALS.map((f) => f.key));
    if (parsed.data.disabled.some((key) => !known.has(key))) return { ok: false, error: "มีเทศกาลที่ไม่รู้จัก" };
    if (Object.keys(parsed.data.greetings ?? {}).some((key) => !known.has(key))) {
      return { ok: false, error: "มีเทศกาลที่ไม่รู้จักในข้อความทักทาย" };
    }
    const current = await getStoreWebsite(g.ctx.storeId);
    if (!current) return { ok: false, error: "ยังไม่ได้สร้างเว็บ" };
    const result = await updateStoreWebsite(g.ctx.storeId, { festival_settings: parsed.data }, g.user.id);
    log(result.error ? "error" : "info", "saveFestivalSettings", result.error ? `บันทึกเทศกาลไม่สำเร็จ: ${result.error}` : "บันทึกการตั้งค่าเทศกาล", g, {
      auto: parsed.data.auto,
      leadDays: parsed.data.leadDays,
      disabled: parsed.data.disabled.length,
    });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidateSite(current.slug);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" };
  }
}
