import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { logSystemEvent } from "@/modules/system/event-log";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { canUseMemberPrivileges } from "@/modules/members/access";
import { parseWebsiteDocument, type WebsiteDocument } from "./schema";
import type { CustomDomainStatus } from "./domains";
import {
  activeFestival,
  parseFestivalSettings,
  toFestivalView,
  type FestivalSettings,
  type FestivalView,
  type LunarFestivalDate,
} from "./festivals";

type Result<T> = { data: T; error: null } | { data: null; error: string };

// ตารางใหม่ยังไม่อยู่ใน database.types (แบบเดียวกับ operations/repository.ts)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

export interface WebsiteProduct {
  id: string;
  name: string;
  price: number;
  imageUrl: string | null;
  categoryName: string;
}

export interface WebsitePassPlan {
  id: string;
  name: string;
  credits: number;
  price: number;
  validDays: number | null;
}

/** ข้อมูลที่ตัวเรนเดอร์ต้องใช้ (ไม่มีข้อมูลส่วนบุคคลของลูกค้า) */
export interface WebsiteRenderData {
  store: {
    id: string;
    name: string;
    slug: string;
    logoUrl: string | null;
    address: string | null;
    phone: string | null;
    closingTime: string | null;
  };
  products: WebsiteProduct[];
  passPlans: WebsitePassPlan[];
  /** ลิงก์หน้าสมาชิกเดิม (มี token ของร้าน) — null = ร้านยังไม่สร้าง QR สมาชิก */
  memberUrl: string | null;
  /** ลิงก์หน้าสั่งออนไลน์ (S2) — null = ร้านไม่เปิดสั่งออนไลน์ */
  orderUrl?: string | null;
}

export interface StoreWebsite {
  storeId: string;
  slug: string;
  isEnabled: boolean;
  templateId: string;
  draft: WebsiteDocument;
  published: WebsiteDocument | null;
  publishedAt: string | null;
  updatedAt: string;
  festivalSettings: FestivalSettings;
  /** S4 โดเมนของร้านเอง */
  customDomain: string | null;
  customDomainStatus: CustomDomainStatus;
  customDomainNote: string | null;
  customDomainCheckedAt: string | null;
  /** เวลาตั้ง/เปลี่ยนโดเมนล่าสุด (กันเปลี่ยนรัว) */
  domainChangedAt: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */
function mapWebsite(row: any): StoreWebsite | null {
  const draft = parseWebsiteDocument(row.draft_document);
  if (draft.error !== null) return null;
  const published = row.published_document ? parseWebsiteDocument(row.published_document) : null;
  return {
    storeId: row.store_id,
    slug: row.slug,
    isEnabled: Boolean(row.is_enabled),
    templateId: row.template_id,
    draft: draft.data,
    published: published && published.error === null ? published.data : null,
    publishedAt: row.published_at ?? null,
    updatedAt: row.updated_at,
    festivalSettings: parseFestivalSettings(row.festival_settings),
    customDomain: row.custom_domain ?? null,
    customDomainStatus: (["none", "pending", "active", "error"].includes(row.custom_domain_status) ? row.custom_domain_status : "none") as CustomDomainStatus,
    customDomainNote: row.custom_domain_note ?? null,
    customDomainCheckedAt: row.custom_domain_checked_at ?? null,
    domainChangedAt: row.custom_domain_changed_at ?? null,
  };
}

function bangkokToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** วันที่เทศกาลจันทรคติที่ซูเปอร์แอดมินยืนยันแล้ว (ปีที่แล้ว–ปีหน้า) */
export async function loadVerifiedLunarDates(): Promise<LunarFestivalDate[]> {
  const db: LooseClient = await createSupabaseServiceClient();
  const year = Number(bangkokToday().slice(0, 4));
  const { data } = await db
    .from("website_festival_dates")
    .select("festival_key, year, starts_on, ends_on")
    .eq("verified", true)
    .gte("year", year - 1)
    .lte("year", year + 1);
  return (data ?? []).map((row: any) => ({
    festivalKey: row.festival_key,
    year: Number(row.year),
    startsOn: row.starts_on,
    endsOn: row.ends_on,
  }));
}

/** โหลดข้อมูลร้านสำหรับเรนเดอร์ (service client — ใช้ทั้งหน้าเว็บสาธารณะและพรีวิวในหลังร้าน) */
export async function loadWebsiteRenderData(storeId: string): Promise<WebsiteRenderData | null> {
  const db: LooseClient = await createSupabaseServiceClient();
  const [storeRes, productsRes, categoriesRes, plansRes, linkRes, orderingRes, siteRes] = await Promise.all([
    db.from("stores").select("id, name, slug, logo_url, address, phone, closing_time, is_active").eq("id", storeId).maybeSingle(),
    db
      .from("products")
      .select("id, name, base_price, image_url, category_id, sort_order, out_of_stock")
      .eq("store_id", storeId)
      .eq("is_active", true)
      .order("sort_order")
      .order("name")
      .limit(300),
    db.from("categories").select("id, name").eq("store_id", storeId),
    db
      .from("prepaid_pass_plans")
      .select("id, name, credits, price, valid_days, sale_product_id")
      .eq("store_id", storeId)
      .eq("is_active", true)
      .order("price"),
    db
      .from("customer_member_portal_links")
      .select("token")
      .eq("store_id", storeId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from("store_online_order_settings").select("enabled").eq("store_id", storeId).maybeSingle(),
    db.from("store_websites").select("slug").eq("store_id", storeId).maybeSingle(),
  ]);
  const store = storeRes.data;
  if (!store || !store.is_active) return null;
  const categoryNames = new Map((categoriesRes.data ?? []).map((c: any) => [c.id, c.name]));
  // สินค้าขายแพ็กแสดงในบล็อกแพ็ก ไม่ซ้ำในเมนู
  const saleProductIds = new Set((plansRes.data ?? []).map((p: any) => p.sale_product_id));
  return {
    store: {
      id: store.id,
      name: store.name,
      slug: store.slug,
      logoUrl: store.logo_url ?? null,
      address: store.address ?? null,
      phone: store.phone ?? null,
      closingTime: store.closing_time ?? null,
    },
    products: (productsRes.data ?? [])
      .filter((p: any) => !p.out_of_stock && !saleProductIds.has(p.id))
      .map((p: any) => ({
        id: p.id,
        name: p.name,
        price: Number(p.base_price),
        imageUrl: p.image_url ?? null,
        categoryName: categoryNames.get(p.category_id) ?? "",
      })),
    passPlans: (plansRes.data ?? []).map((p: any) => ({
      id: p.id,
      name: p.name,
      credits: Number(p.credits),
      price: Number(p.price),
      validDays: p.valid_days ?? null,
    })),
    memberUrl: linkRes.data?.token ? `/member/${store.slug}?code=${encodeURIComponent(linkRes.data.token)}` : null,
    // ลิงก์เว็บร้านใช้ slug ของเว็บ (store_websites.slug) ไม่ใช่ stores.slug
    orderUrl: orderingRes.data?.enabled && siteRes.data?.slug ? `/s/${siteRes.data.slug}/order` : null,
  };
}

/**
 * หน้าเว็บสาธารณะ: เฉพาะเว็บที่เปิดอยู่ + มีฉบับเผยแพร่ + องค์กรยังเป็น Enterprise
 * (หมด Enterprise = เว็บปิดเอง ข้อมูลยังอยู่ เปิดกลับได้เมื่อต่ออายุ)
 */
export async function getPublishedWebsite(
  slug: string,
): Promise<{ document: WebsiteDocument; data: WebsiteRenderData; festival: FestivalView | null } | null> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data: row } = await db
    .from("store_websites")
    .select("*")
    .eq("slug", slug.toLowerCase())
    .eq("is_enabled", true)
    .maybeSingle();
  if (!row?.published_document) return null;
  const parsed = parseWebsiteDocument(row.published_document);
  if (parsed.error !== null) return null;
  const billing = (await getOrganizationBillingState(row.organization_id)) ?? DEFAULT_BILLING_STATE;
  if (!canUseMemberPrivileges(billing)) return null;
  const settings = parseFestivalSettings(row.festival_settings);
  const [data, lunar] = await Promise.all([
    loadWebsiteRenderData(row.store_id),
    settings.auto ? loadVerifiedLunarDates() : Promise.resolve([] as LunarFestivalDate[]),
  ]);
  if (!data) return null;
  const festival = toFestivalView(activeFestival(bangkokToday(), settings, lunar), settings);
  return { document: parsed.data, data, festival };
}

/** หลังร้าน (สิทธิ์ผู้ใช้) */
export async function getStoreWebsite(storeId: string): Promise<StoreWebsite | null> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data } = await db.from("store_websites").select("*").eq("store_id", storeId).maybeSingle();
  return data ? mapWebsite(data) : null;
}

export async function isSlugTaken(slug: string, exceptStoreId: string): Promise<boolean> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db.from("store_websites").select("store_id").eq("slug", slug.toLowerCase()).maybeSingle();
  return Boolean(data && data.store_id !== exceptStoreId);
}

function rlsZero(data: unknown[] | null) {
  return !data || data.length === 0;
}

export async function createStoreWebsite(input: {
  storeId: string;
  organizationId: string;
  slug: string;
  templateId: string;
  document: WebsiteDocument;
  userId: string;
}): Promise<Result<true>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("store_websites")
    .insert({
      store_id: input.storeId,
      organization_id: input.organizationId,
      slug: input.slug,
      template_id: input.templateId,
      draft_document: input.document,
      updated_by: input.userId,
    })
    .select("store_id");
  if (error) return { data: null, error: error.code === "23505" ? "ลิงก์นี้มีร้านอื่นใช้แล้ว" : error.message };
  if (rlsZero(data)) return { data: null, error: "ไม่มีสิทธิ์สร้างเว็บของสาขานี้" };
  return { data: true, error: null };
}

export async function updateStoreWebsite(
  storeId: string,
  patch: {
    draft_document?: WebsiteDocument;
    template_id?: string;
    slug?: string;
    is_enabled?: boolean;
    festival_settings?: FestivalSettings;
  },
  userId: string,
): Promise<Result<true>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("store_websites")
    .update({ ...patch, updated_by: userId })
    .eq("store_id", storeId)
    .select("store_id");
  if (error) return { data: null, error: error.code === "23505" ? "ลิงก์นี้มีร้านอื่นใช้แล้ว" : error.message };
  if (rlsZero(data)) return { data: null, error: "ไม่มีสิทธิ์แก้เว็บของสาขานี้" };
  return { data: true, error: null };
}

/** เผยแพร่ฉบับร่าง + เก็บประวัติ */
export async function publishStoreWebsite(storeId: string, organizationId: string, document: WebsiteDocument, userId: string): Promise<Result<string>> {
  const db: LooseClient = await createSupabaseServerClient();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("store_websites")
    .update({ published_document: document, published_at: now, updated_by: userId })
    .eq("store_id", storeId)
    .select("slug");
  if (error) return { data: null, error: error.message };
  if (rlsZero(data)) return { data: null, error: "ไม่มีสิทธิ์เผยแพร่เว็บของสาขานี้" };
  // เผยแพร่สำเร็จแล้ว — ประวัติพังไม่ทำให้การเผยแพร่ล้ม แต่ต้องบันทึกไว้ให้รู้ว่าย้อนฉบับนี้ไม่ได้
  const { error: versionError } = await db
    .from("store_website_versions")
    .insert({ store_id: storeId, organization_id: organizationId, document, published_by: userId });
  if (versionError) {
    void logSystemEvent({
      level: "warn",
      source: "store-website",
      action: "publishVersionHistory",
      message: `เผยแพร่แล้วแต่บันทึกประวัติฉบับไม่สำเร็จ: ${versionError.message}`,
      organizationId,
      storeId,
      actorUserId: userId,
    });
  }
  return { data: String(data[0].slug), error: null };
}

export interface WebsiteVersionSummary {
  id: string;
  createdAt: string;
}

export async function listWebsiteVersions(storeId: string): Promise<WebsiteVersionSummary[]> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data } = await db
    .from("store_website_versions")
    .select("id, created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(10);
  return (data ?? []).map((row: any) => ({ id: row.id, createdAt: row.created_at }));
}

/** โดเมนนี้มีร้านอื่นใช้แล้วไหม */
export async function isDomainTaken(domain: string, exceptStoreId: string): Promise<boolean> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db.from("store_websites").select("store_id").eq("custom_domain", domain.toLowerCase()).limit(1);
  return Boolean(data && data.length > 0 && data[0].store_id !== exceptStoreId);
}

/**
 * บันทึกโดเมน/สถานะ — ใช้ service client เพราะ trigger กันร้านแก้คอลัมน์โดเมนเอง
 * ผู้เรียกต้องตรวจสิทธิ์ (owner/admin ของสาขา + Enterprise หรือซูเปอร์แอดมิน) ก่อนเสมอ
 */
export async function updateWebsiteDomain(
  storeId: string,
  patch: { custom_domain?: string | null; custom_domain_status: CustomDomainStatus; custom_domain_note: string | null },
  options: { checked?: boolean; requireDomain?: boolean } = {},
): Promise<Result<true>> {
  const db: LooseClient = await createSupabaseServiceClient();
  // checked_at = เวลาตรวจล่าสุด (กันกดตรวจรัว) · changed_at = เวลาตั้ง/ลบโดเมน (กันเปลี่ยนรัว) — ตั้งโดเมนใหม่ล้าง checked_at ให้กดตรวจได้ทันที
  let query = db
    .from("store_websites")
    .update({
      ...patch,
      ...(options.checked ? { custom_domain_checked_at: new Date().toISOString() } : {}),
      ...(patch.custom_domain !== undefined ? { custom_domain_changed_at: new Date().toISOString(), custom_domain_checked_at: null } : {}),
    })
    .eq("store_id", storeId);
  if (options.requireDomain) query = query.not("custom_domain", "is", null);
  const { data, error } = await query.select("store_id");
  if (error) return { data: null, error: error.code === "23505" ? "โดเมนนี้มีร้านอื่นใช้แล้ว" : error.message };
  if (rlsZero(data)) return { data: null, error: options.requireDomain ? "ร้านนี้ยังไม่ได้ตั้งโดเมน" : "ยังไม่ได้สร้างเว็บ" };
  return { data: true, error: null };
}

export interface DomainAdminRow {
  storeId: string;
  storeName: string;
  slug: string;
  domain: string;
  status: CustomDomainStatus;
  note: string | null;
  checkedAt: string | null;
}

/** ซูเปอร์แอดมิน: รายการโดเมนของทุกร้าน */
export async function listCustomDomainsForAdmin(): Promise<DomainAdminRow[]> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db
    .from("store_websites")
    .select("store_id, slug, custom_domain, custom_domain_status, custom_domain_note, custom_domain_checked_at, stores(name)")
    .not("custom_domain", "is", null)
    .order("custom_domain_checked_at", { ascending: false })
    .limit(200);
  return (data ?? []).map((row: any) => ({
    storeId: row.store_id,
    storeName: row.stores?.name ?? "",
    slug: row.slug,
    domain: row.custom_domain,
    status: row.custom_domain_status,
    note: row.custom_domain_note ?? null,
    checkedAt: row.custom_domain_checked_at ?? null,
  }));
}

export async function getWebsiteVersion(storeId: string, versionId: string): Promise<WebsiteDocument | null> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data } = await db.from("store_website_versions").select("document").eq("store_id", storeId).eq("id", versionId).maybeSingle();
  if (!data) return null;
  const parsed = parseWebsiteDocument(data.document);
  return parsed.error === null ? parsed.data : null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
