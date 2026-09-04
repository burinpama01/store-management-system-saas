import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { Role, PermissionKey } from "@/modules/tenants/types";
import type { Database, Json } from "@/server/integrations/supabase/database.types";
import {
  normalizeCustomerDisplaySettingsInput,
  type CustomerDisplaySettings,
  type CustomerDisplaySettingsInput,
} from "./customer-display";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ReceiptSettingsRow = Database["public"]["Tables"]["receipt_settings"]["Row"];
type CustomerDisplaySettingsRow = Database["public"]["Tables"]["customer_display_settings"]["Row"];
type MembershipRow = Database["public"]["Tables"]["memberships"]["Row"];
type OverrideRow = Database["public"]["Tables"]["membership_permission_overrides"]["Row"];

export interface ReceiptSettings {
  id: string;
  storeId: string;
  organizationId: string;
  storeName: string;
  address?: string;
  phone?: string;
  taxId?: string;
  showTaxId: boolean;
  showQrPayment: boolean;
  promptpayId?: string;
  headerText?: string;
  footerText?: string;
  logoUrl?: string;
  footerImageUrl?: string;
  /** ข้อความกำกับใต้รูป QR ท้ายใบเสร็จ */
  footerImageLabel?: string;
  /** ซ่อนรูปท้ายใบเมื่อใบนั้นมี QR ของระบบ (ค่าเริ่มต้น true) */
  hideFooterImageWithSystemQr: boolean;
  autoPrintReceipt: boolean;
  autoPrintStationTickets: boolean;
  paperWidth: "58mm" | "80mm";
  printCopies: number;
  showVatBreakdown: boolean;
  vatRate: number;
  updatedAt: string;
}

function mapReceiptSettings(row: ReceiptSettingsRow): ReceiptSettings {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    storeName: row.store_name,
    address: row.address ?? undefined,
    phone: row.phone ?? undefined,
    taxId: row.tax_id ?? undefined,
    showTaxId: row.show_tax_id,
    showQrPayment: row.show_qr_payment,
    promptpayId: row.promptpay_id ?? undefined,
    headerText: row.header_text ?? undefined,
    footerText: row.footer_text ?? undefined,
    logoUrl: row.logo_url ?? undefined,
    footerImageUrl: row.footer_image_url ?? undefined,
    footerImageLabel: row.footer_image_label ?? undefined,
    // ร้านที่ยังไม่เคยตั้งค่า = true (ปลอดภัยไว้ก่อน ไม่ให้ QR ซ้อนกันจนสแกนผิดอัน)
    hideFooterImageWithSystemQr: row.footer_image_hide_with_system_qr ?? true,
    autoPrintReceipt: row.auto_print_receipt,
    autoPrintStationTickets: row.auto_print_station_tickets,
    paperWidth: row.paper_width,
    printCopies: row.print_copies,
    showVatBreakdown: row.show_vat_breakdown,
    vatRate: row.vat_rate,
    updatedAt: row.updated_at,
  };
}

function mapCustomerDisplaySettings(row: CustomerDisplaySettingsRow): CustomerDisplaySettings {
  const normalized = normalizeCustomerDisplaySettingsInput({
    adEnabled: row.ad_enabled,
    adLayout: row.ad_layout,
    topSlotEnabled: row.top_slot_enabled,
    bottomSlotEnabled: row.bottom_slot_enabled,
    slideIntervalSeconds: row.slide_interval_seconds,
    topSlides: row.top_slides,
    bottomSlides: row.bottom_slides,
  });
  return {
    ...normalized,
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    updatedAt: row.updated_at,
  };
}

export async function getReceiptSettings(storeId: string, organizationId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("receipt_settings")
    .select("*")
    .eq("store_id", storeId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { data: null, error: mapError(error) };
  return { data: data ? mapReceiptSettings(data) : null, error: null };
}

export async function getCustomerDisplaySettings(storeId: string, organizationId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("customer_display_settings")
    .select("*")
    .eq("store_id", storeId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { data: null, error: mapError(error) };
  return { data: data ? mapCustomerDisplaySettings(data) : null, error: null };
}

export interface ReceiptSettingsInput {
  storeName: string;
  address?: string;
  phone?: string;
  taxId?: string;
  showTaxId: boolean;
  showQrPayment: boolean;
  promptpayId?: string;
  headerText?: string;
  footerText?: string;
  logoUrl?: string;
  footerImageUrl?: string;
  /** ข้อความกำกับใต้รูป QR ท้ายใบเสร็จ */
  footerImageLabel?: string;
  /** ซ่อนรูปท้ายใบเมื่อใบนั้นมี QR ของระบบ (กัน QR ซ้อนกันจนสแกนผิดอัน) */
  hideFooterImageWithSystemQr?: boolean;
  autoPrintReceipt?: boolean;
  autoPrintStationTickets?: boolean;
  paperWidth: "58mm" | "80mm";
  printCopies: number;
  showVatBreakdown?: boolean;
  vatRate?: number;
}

export async function upsertReceiptSettings(
  storeId: string,
  organizationId: string,
  input: ReceiptSettingsInput,
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("receipt_settings").upsert(
    {
      organization_id: organizationId,
      store_id: storeId,
      store_name: input.storeName,
      address: input.address ?? null,
      phone: input.phone ?? null,
      tax_id: input.taxId ?? null,
      show_tax_id: input.showTaxId,
      show_qr_payment: input.showQrPayment,
      promptpay_id: input.promptpayId ?? null,
      header_text: input.headerText ?? null,
      footer_text: input.footerText ?? null,
      logo_url: input.logoUrl ?? null,
      footer_image_url: input.footerImageUrl ?? null,
      footer_image_label: input.footerImageLabel ?? null,
      footer_image_hide_with_system_qr: input.hideFooterImageWithSystemQr ?? true,
      auto_print_receipt: input.autoPrintReceipt ?? false,
      auto_print_station_tickets: input.autoPrintStationTickets ?? false,
      paper_width: input.paperWidth,
      print_copies: input.printCopies,
      show_vat_breakdown: input.showVatBreakdown ?? false,
      vat_rate: input.vatRate ?? 7,
    },
    { onConflict: "store_id" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function upsertCustomerDisplaySettings(
  storeId: string,
  organizationId: string,
  input: CustomerDisplaySettingsInput,
) {
  const normalized = normalizeCustomerDisplaySettingsInput(input);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("customer_display_settings").upsert(
    {
      organization_id: organizationId,
      store_id: storeId,
      ad_enabled: normalized.adEnabled,
      ad_layout: normalized.adLayout,
      top_slot_enabled: normalized.topSlotEnabled,
      bottom_slot_enabled: normalized.bottomSlotEnabled,
      slide_interval_seconds: normalized.slideIntervalSeconds,
      top_slides: normalized.topSlides as unknown as Json,
      bottom_slides: normalized.bottomSlides as unknown as Json,
    },
    { onConflict: "store_id" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export interface MemberWithEmail {
  membershipId: string;
  userId: string;
  email: string;
  storeId: string | null;
  role: Role;
  joinedAt: string | null;
  invitedAt: string;
  overrides: Array<{ permissionKey: PermissionKey; granted: boolean }>;
}

function mapOverrideCompact(row: OverrideRow): { permissionKey: PermissionKey; granted: boolean } {
  return { permissionKey: row.permission_key as PermissionKey, granted: row.granted };
}

export async function listStoreMemberships(organizationId: string, storeId: string) {
  // F01: validate IDs before interpolating into PostgREST .or() filter string
  if (!UUID_RE.test(storeId) || !UUID_RE.test(organizationId)) {
    return { data: null, error: mapError(new Error("Invalid store or organization ID")) };
  }

  const supabase = await createSupabaseServerClient();
  const serviceClient = await createSupabaseServiceClient();

  // Load memberships first; then scope overrides to the returned membership IDs (F07)
  const mbRes = await supabase
    .from("memberships")
    .select("*")
    .eq("organization_id", organizationId)
    .or(`store_id.eq.${storeId},store_id.is.null`)
    .not("joined_at", "is", null)
    .order("role")
    .order("created_at");

  if (mbRes.error) return { data: null, error: mapError(mbRes.error) };

  const rows: MembershipRow[] = mbRes.data ?? [];
  const membershipIds = rows.map((r) => r.id);

  // F07: scope overrides to only the memberships we loaded (not entire org)
  const overrideRows: OverrideRow[] =
    membershipIds.length > 0
      ? ((
          await supabase
            .from("membership_permission_overrides")
            .select("*")
            .in("membership_id", membershipIds)
        ).data ?? [])
      : [];

  // F06: fetch emails per-user via getUserById instead of dumping all-project users
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const emailMap = new Map<string, string>();
  if (userIds.length > 0) {
    const emailResults = await Promise.all(
      userIds.map((id) => serviceClient.auth.admin.getUserById(id)),
    );
    for (const result of emailResults) {
      const u = result.data?.user;
      if (u) emailMap.set(u.id, u.email ?? u.id);
    }
  }

  const overridesByMembership = new Map<string, OverrideRow[]>();
  for (const o of overrideRows) {
    const existing = overridesByMembership.get(o.membership_id);
    if (existing) existing.push(o);
    else overridesByMembership.set(o.membership_id, [o]);
  }

  const members: MemberWithEmail[] = rows.map((r) => ({
    membershipId: r.id,
    userId: r.user_id,
    email: emailMap.get(r.user_id) ?? r.user_id,
    storeId: r.store_id,
    role: r.role as Role,
    joinedAt: r.joined_at,
    invitedAt: r.invited_at,
    overrides: (overridesByMembership.get(r.id) ?? []).map(mapOverrideCompact),
  }));

  return { data: members, error: null };
}

export async function updateMemberRole(
  membershipId: string,
  organizationId: string,
  newRole: Role,
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("memberships")
    .update({ role: newRole, updated_at: new Date().toISOString() })
    .eq("id", membershipId)
    .eq("organization_id", organizationId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function removeMember(membershipId: string, organizationId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("memberships")
    .delete()
    .eq("id", membershipId)
    .eq("organization_id", organizationId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}
