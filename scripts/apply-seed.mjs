/**
 * Apply seed data to remote Supabase project
 * node scripts/apply-seed.mjs
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const env = {};
  const content = readFileSync(".env.local", "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv();
const supabase = createClient(env["NEXT_PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"], {
  auth: { autoRefreshToken: false, persistSession: false },
});

// user_id ของ owner@demo.com ที่สร้างไปแล้ว
const OWNER_USER_ID = "cd14fdd5-1cc6-455b-9aca-b81c844d54b4";
const ORG_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const STORE_ID = "cccccccc-0000-0000-0000-000000000001";

async function upsert(table, data, label) {
  const { error } = await supabase.from(table).upsert(data, { onConflict: "id", ignoreDuplicates: true });
  if (error) console.error(`❌ ${label}:`, error.message);
  else console.log(`✅ ${label}`);
}

async function run() {
  const now = new Date().toISOString();

  // Organization
  await upsert("organizations", [{
    id: ORG_ID,
    name: "Demo Restaurant Co.",
    slug: "demo-restaurant",
    owner_id: OWNER_USER_ID,
  }], "organizations");

  // Subscription
  await upsert("subscriptions", [{
    id: "bbbbbbbb-0000-0000-0000-000000000001",
    organization_id: ORG_ID,
    plan: "free",
    status: "active",
    current_period_start: new Date().toISOString().slice(0, 10),
    current_period_end: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    cancel_at_period_end: false,
  }], "subscriptions");

  // Store
  await upsert("stores", [{
    id: STORE_ID,
    organization_id: ORG_ID,
    name: "Main Branch",
    slug: "main-branch",
    address: "123 Demo Street, Bangkok",
    phone: "0812345678",
    currency_code: "THB",
    timezone: "Asia/Bangkok",
    locale: "th-TH",
    is_active: true,
    buffet_enabled: false,
    qr_ordering_enabled: false,
  }], "stores");

  // Membership (owner, org-level)
  await upsert("memberships", [{
    id: "dddddddd-0000-0000-0000-000000000001",
    organization_id: ORG_ID,
    store_id: null,
    user_id: OWNER_USER_ID,
    role: "owner",
    invited_at: now,
    joined_at: now,
  }], "memberships");

  // Tables
  await upsert("tables", [
    { id: "eeeeeeee-0000-0000-0000-000000000001", organization_id: ORG_ID, store_id: STORE_ID, number: "1", label: "Window seat", seats: 4, is_active: true, qr_enabled: false, status: "available" },
    { id: "eeeeeeee-0000-0000-0000-000000000002", organization_id: ORG_ID, store_id: STORE_ID, number: "2", label: "Center", seats: 2, is_active: true, qr_enabled: false, status: "available" },
    { id: "eeeeeeee-0000-0000-0000-000000000003", organization_id: ORG_ID, store_id: STORE_ID, number: "3", label: "Bar", seats: 4, is_active: true, qr_enabled: false, status: "available" },
  ], "tables");

  // Accounting categories
  await upsert("accounting_categories", [
    { id: "ffffffff-0000-0000-0000-000000000001", organization_id: ORG_ID, store_id: STORE_ID, name: "ยอดขาย POS", type: "income", is_default: true, sort_order: 1 },
    { id: "ffffffff-0000-0000-0000-000000000002", organization_id: ORG_ID, store_id: STORE_ID, name: "รายรับอื่นๆ", type: "income", is_default: true, sort_order: 2 },
    { id: "ffffffff-0000-0000-0000-000000000003", organization_id: ORG_ID, store_id: STORE_ID, name: "ค่าวัตถุดิบ", type: "expense", is_default: true, sort_order: 3 },
    { id: "ffffffff-0000-0000-0000-000000000004", organization_id: ORG_ID, store_id: STORE_ID, name: "ค่าแรง", type: "expense", is_default: true, sort_order: 4 },
    { id: "ffffffff-0000-0000-0000-000000000005", organization_id: ORG_ID, store_id: STORE_ID, name: "ค่าสาธารณูปโภค", type: "expense", is_default: true, sort_order: 5 },
    { id: "ffffffff-0000-0000-0000-000000000006", organization_id: ORG_ID, store_id: STORE_ID, name: "ค่าใช้จ่ายอื่นๆ", type: "expense", is_default: true, sort_order: 6 },
    { id: "ffffffff-0000-0000-0000-000000000007", organization_id: ORG_ID, store_id: STORE_ID, name: "ปรับยอดเงินสด", type: "cash_adjustment", is_default: true, sort_order: 7 },
  ], "accounting_categories");

  // Catalog categories (hex-only UUIDs)
  const CAT_DRINK  = "11111111-1111-0000-0000-000000000001";
  const CAT_FOOD   = "11111111-1111-0000-0000-000000000002";
  const CAT_SWEET  = "11111111-1111-0000-0000-000000000003";
  const P1 = "22222222-2222-0000-0000-000000000001";
  const P2 = "22222222-2222-0000-0000-000000000002";
  const P3 = "22222222-2222-0000-0000-000000000003";
  const P4 = "22222222-2222-0000-0000-000000000004";
  const P5 = "22222222-2222-0000-0000-000000000005";
  const P6 = "22222222-2222-0000-0000-000000000006";
  const G1 = "44444444-4444-0000-0000-000000000001";
  const G2 = "44444444-4444-0000-0000-000000000002";
  const G3 = "44444444-4444-0000-0000-000000000003";
  const G4 = "44444444-4444-0000-0000-000000000004";

  await upsert("categories", [
    { id: CAT_DRINK, organization_id: ORG_ID, store_id: STORE_ID, name: "เครื่องดื่ม", sort_order: 1, is_active: true },
    { id: CAT_FOOD,  organization_id: ORG_ID, store_id: STORE_ID, name: "อาหาร",      sort_order: 2, is_active: true },
    { id: CAT_SWEET, organization_id: ORG_ID, store_id: STORE_ID, name: "ของหวาน",   sort_order: 3, is_active: true },
  ], "categories");

  // Products
  await upsert("products", [
    { id: P1, organization_id: ORG_ID, store_id: STORE_ID, category_id: CAT_DRINK, name: "กาแฟดำ",          base_price: 45,  is_active: true, available_for_pos: true, available_for_qr: false, sort_order: 1 },
    { id: P2, organization_id: ORG_ID, store_id: STORE_ID, category_id: CAT_DRINK, name: "ลาเต้",           base_price: 55,  is_active: true, available_for_pos: true, available_for_qr: false, sort_order: 2 },
    { id: P3, organization_id: ORG_ID, store_id: STORE_ID, category_id: CAT_DRINK, name: "ชาเย็น",          base_price: 40,  is_active: true, available_for_pos: true, available_for_qr: false, sort_order: 3 },
    { id: P4, organization_id: ORG_ID, store_id: STORE_ID, category_id: CAT_FOOD,  name: "ข้าวผัดกุ้ง",    base_price: 120, is_active: true, available_for_pos: true, available_for_qr: false, sort_order: 1 },
    { id: P5, organization_id: ORG_ID, store_id: STORE_ID, category_id: CAT_FOOD,  name: "ผัดกะเพราหมูสับ", base_price: 100, is_active: true, available_for_pos: true, available_for_qr: false, sort_order: 2 },
    { id: P6, organization_id: ORG_ID, store_id: STORE_ID, category_id: CAT_SWEET, name: "วาฟเฟิลราดน้ำผึ้ง", base_price: 85, is_active: true, available_for_pos: true, available_for_qr: false, sort_order: 1 },
  ], "products");

  // Variants
  await upsert("product_variants", [
    { id: "33333333-3333-0000-0000-000000000001", product_id: P1, name: "เล็ก (S)", price_adjustment: 0,  is_active: true, sort_order: 1 },
    { id: "33333333-3333-0000-0000-000000000002", product_id: P1, name: "ใหญ่ (L)", price_adjustment: 10, is_active: true, sort_order: 2 },
    { id: "33333333-3333-0000-0000-000000000003", product_id: P2, name: "เล็ก (S)", price_adjustment: 0,  is_active: true, sort_order: 1 },
    { id: "33333333-3333-0000-0000-000000000004", product_id: P2, name: "ใหญ่ (L)", price_adjustment: 15, is_active: true, sort_order: 2 },
  ], "product_variants");

  // Modifier groups
  await upsert("modifier_groups", [
    { id: G1, product_id: P1, name: "ความหวาน",      selection_type: "single",   is_required: true,  min_selections: 1, max_selections: 1, sort_order: 1 },
    { id: G2, product_id: P2, name: "ความหวาน",      selection_type: "single",   is_required: true,  min_selections: 1, max_selections: 1, sort_order: 1 },
    { id: G3, product_id: P3, name: "ความหวาน",      selection_type: "single",   is_required: true,  min_selections: 1, max_selections: 1, sort_order: 1 },
    { id: G4, product_id: P4, name: "ตัวเลือกเพิ่ม", selection_type: "multiple", is_required: false, min_selections: 0, max_selections: 3, sort_order: 1 },
  ], "modifier_groups");

  // Modifier options
  await upsert("modifier_options", [
    { id: "55555555-5555-0000-0000-000000000001", modifier_group_id: G1, name: "ไม่หวาน",   price_adjustment: 0,  is_default: false, is_active: true, sort_order: 1 },
    { id: "55555555-5555-0000-0000-000000000002", modifier_group_id: G1, name: "หวานน้อย",  price_adjustment: 0,  is_default: false, is_active: true, sort_order: 2 },
    { id: "55555555-5555-0000-0000-000000000003", modifier_group_id: G1, name: "หวานปกติ",  price_adjustment: 0,  is_default: true,  is_active: true, sort_order: 3 },
    { id: "55555555-5555-0000-0000-000000000004", modifier_group_id: G1, name: "หวานมาก",   price_adjustment: 0,  is_default: false, is_active: true, sort_order: 4 },
    { id: "55555555-5555-0000-0000-000000000005", modifier_group_id: G2, name: "ไม่หวาน",   price_adjustment: 0,  is_default: false, is_active: true, sort_order: 1 },
    { id: "55555555-5555-0000-0000-000000000006", modifier_group_id: G2, name: "หวานน้อย",  price_adjustment: 0,  is_default: false, is_active: true, sort_order: 2 },
    { id: "55555555-5555-0000-0000-000000000007", modifier_group_id: G2, name: "หวานปกติ",  price_adjustment: 0,  is_default: true,  is_active: true, sort_order: 3 },
    { id: "55555555-5555-0000-0000-000000000008", modifier_group_id: G3, name: "หวานน้อย",  price_adjustment: 0,  is_default: false, is_active: true, sort_order: 1 },
    { id: "55555555-5555-0000-0000-000000000009", modifier_group_id: G3, name: "หวานปกติ",  price_adjustment: 0,  is_default: true,  is_active: true, sort_order: 2 },
    { id: "55555555-5555-0000-0000-000000000010", modifier_group_id: G4, name: "เพิ่มไข่ดาว", price_adjustment: 15, is_default: false, is_active: true, sort_order: 1 },
    { id: "55555555-5555-0000-0000-000000000011", modifier_group_id: G4, name: "เพิ่มผักบุ้ง", price_adjustment: 10, is_default: false, is_active: true, sort_order: 2 },
    { id: "55555555-5555-0000-0000-000000000012", modifier_group_id: G4, name: "ข้าวเพิ่ม",   price_adjustment: 20, is_default: false, is_active: true, sort_order: 3 },
  ], "modifier_options");

  console.log("\n✅ Seed data applied successfully");
  console.log("   Email:    owner@demo.com");
  console.log("   Password: Demo1234!");
}

run().catch((e) => { console.error(e); process.exit(1); });
