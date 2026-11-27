import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { themeSchema } from "./schema";
import { TEMPLATE_ID_RE, WEBSITE_TEMPLATES, findTemplate, type TemplateBusiness, type TemplateStyle, type WebsiteTemplate } from "./templates";

/**
 * คลังเทมเพลตรายเดือน (S4) — ตาราง website_templates
 * เทมเพลตในโค้ด (S0) ยังอยู่ครบ · คลังเพิ่มต่อท้าย (เรียงใหม่สุดก่อน) · id ซ้ำกับเทมเพลตในโค้ดไม่ได้
 */

// ตารางใหม่ยังไม่อยู่ใน database.types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

const BUSINESSES: TemplateBusiness[] = ["cafe", "restaurant", "grocery"];
const STYLES: TemplateStyle[] = ["minimal", "cute", "luxury"];

export interface LibraryTemplateRow extends WebsiteTemplate {
  isPublished: boolean;
  updatedAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */
function mapRow(row: any): LibraryTemplateRow | null {
  const theme = themeSchema.safeParse(row.theme);
  if (!theme.success) return null;
  if (!BUSINESSES.includes(row.business) || !STYLES.includes(row.style)) return null;
  return {
    id: row.id,
    name: row.name,
    business: row.business,
    style: row.style,
    description: row.description ?? "",
    theme: { ...theme.data, style: row.style },
    library: true,
    publishedAt: row.published_at ?? null,
    isPublished: Boolean(row.is_published),
    updatedAt: row.updated_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function toTemplate(row: LibraryTemplateRow): WebsiteTemplate {
  return {
    id: row.id,
    name: row.name,
    business: row.business,
    style: row.style,
    description: row.description,
    theme: row.theme,
    library: true,
    publishedAt: row.publishedAt ?? null,
  };
}

/** เทมเพลตคลังที่เผยแพร่แล้ว (ใหม่สุดก่อน) */
export async function listPublishedLibraryTemplates(): Promise<WebsiteTemplate[]> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db
    .from("website_templates")
    .select("*")
    .eq("is_published", true)
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(60);
  return (data ?? [])
    .map(mapRow)
    .filter((t: LibraryTemplateRow | null): t is LibraryTemplateRow => t !== null && !findTemplate(t.id))
    .map(toTemplate);
}

/** เทมเพลตทั้งหมดที่ร้านเลือกได้ = คลังรายเดือน (ใหม่สุดก่อน) + เทมเพลตตั้งต้น */
export async function listAvailableTemplates(): Promise<WebsiteTemplate[]> {
  const library = await listPublishedLibraryTemplates();
  return [...library, ...WEBSITE_TEMPLATES];
}

/** หาเทมเพลตจาก id (ในโค้ดก่อน แล้วคลังที่เผยแพร่) — ใช้ใน server action */
export async function resolveTemplate(id: string): Promise<WebsiteTemplate | null> {
  const builtin = findTemplate(id);
  if (builtin) return builtin;
  if (!TEMPLATE_ID_RE.test(id)) return null;
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db.from("website_templates").select("*").eq("id", id).eq("is_published", true).maybeSingle();
  const row = data ? mapRow(data) : null;
  return row ? toTemplate(row) : null;
}

/** ซูเปอร์แอดมิน: ทุกแถว (รวมฉบับร่าง) */
export async function listLibraryTemplatesForAdmin(): Promise<LibraryTemplateRow[]> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db.from("website_templates").select("*").order("created_at", { ascending: false }).limit(200);
  return (data ?? []).map(mapRow).filter((t: LibraryTemplateRow | null): t is LibraryTemplateRow => t !== null);
}

export async function upsertLibraryTemplate(input: {
  id: string;
  name: string;
  business: TemplateBusiness;
  style: TemplateStyle;
  description: string;
  theme: WebsiteTemplate["theme"];
  isPublished: boolean;
  userId: string;
}): Promise<string | null> {
  if (findTemplate(input.id)) return "รหัสนี้ซ้ำกับเทมเพลตตั้งต้น";
  const db: LooseClient = await createSupabaseServiceClient();
  const { data: existing } = await db.from("website_templates").select("published_at, is_published").eq("id", input.id).maybeSingle();
  const now = new Date().toISOString();
  // วันที่เผยแพร่ = ครั้งแรกที่เปิดเผยแพร่ (ใช้แสดงป้าย “ใหม่” — แก้สีทีหลังไม่ทำให้กลับมาใหม่)
  const publishedAt = input.isPublished ? (existing?.published_at ?? now) : (existing?.published_at ?? null);
  const { error } = await db.from("website_templates").upsert(
    {
      id: input.id,
      name: input.name,
      business: input.business,
      style: input.style,
      description: input.description,
      theme: { ...input.theme, style: input.style },
      is_published: input.isPublished,
      published_at: publishedAt,
      updated_by: input.userId,
      updated_at: now,
      ...(existing ? {} : { created_by: input.userId }),
    },
    { onConflict: "id" },
  );
  return error ? error.message : null;
}
