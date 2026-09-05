import { withDataClient } from "@/shared/services/data-client";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { DEFAULT_THEME } from "@/modules/theme/presets";
import { mapError } from "@/shared/utils/error";
import type { Store, Table, ReceiptSettings, Printer, QrOrderingMode, TableOpenPolicy } from "@/modules/stores/types";
import { parseServiceButtons } from "@/modules/qr-ordering/types";
import type { ServiceButtonConfig } from "@/modules/qr-ordering/types";
import type { Database } from "@/server/integrations/supabase/database.types";
import { parseSetupProfileOrNull, type StoreSetupProfile } from "@/modules/onboarding/setup-profile";

// Privileged printer upserts (service client) live in printer-admin-repository.ts
// so this repository stays user-scoped (RLS) end to end.

type StoreRow = Database["public"]["Tables"]["stores"]["Row"];
type TableRow = Database["public"]["Tables"]["tables"]["Row"];
type PrinterRow = Database["public"]["Tables"]["printers"]["Row"];

function mapStore(row: StoreRow): Store {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    setupProfile: parseSetupProfileOrNull(row.setup_profile),
    address: row.address ?? undefined,
    phone: row.phone ?? undefined,
    logoUrl: row.logo_url ?? undefined,
    currencyCode: row.currency_code,
    timezone: row.timezone,
    locale: row.locale,
    isActive: row.is_active,
    buffetEnabled: row.buffet_enabled,
    qrOrderingEnabled: row.qr_ordering_enabled,
    unifiedPosEnabled: row.unified_pos_enabled ?? false,
    kitchenQueueEnabled: row.kitchen_queue_enabled ?? false,
    voiceCommandEnabled: row.voice_command_enabled ?? false,
    voiceAiFallbackEnabled: row.voice_ai_fallback_enabled ?? false,
    qrOrderingMode: row.qr_ordering_mode,
    tableOpenPolicy: row.table_open_policy,
    serviceButtons: parseServiceButtons(row.qr_service_buttons),
    musicRequestEnabled: row.music_request_enabled,
    musicLicenseStatus: row.music_license_status,
    musicLicenseApprovedAt: row.music_license_approved_at ?? undefined,
    musicLicenseNote: row.music_license_note ?? undefined,
    dineInDurationMinutes: row.dine_in_duration_minutes,
    dineInNoExpiry: row.dine_in_no_expiry,
    themePresetId: row.theme_preset_id ?? DEFAULT_THEME.presetId,
    themePrimaryColor: row.theme_primary_color ?? DEFAULT_THEME.primaryColor,
    themePrimaryStrongColor: row.theme_primary_strong_color ?? DEFAULT_THEME.primaryStrongColor,
    themePrimarySoftColor: row.theme_primary_soft_color ?? DEFAULT_THEME.primarySoftColor,
    themeAccentColor: row.theme_accent_color ?? DEFAULT_THEME.accentColor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTable(row: TableRow): Table {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    number: row.number,
    label: row.label ?? undefined,
    seats: row.seats ?? undefined,
    isActive: row.is_active,
    qrEnabled: row.qr_enabled,
    currentSessionId: row.current_session_id ?? undefined,
    sessionStartedAt: row.session_started_at ?? undefined,
    sessionExpiresAt: row.session_expires_at ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** minutes = null → เปิดโต๊ะแบบไม่จับเวลา (session_expires_at = null) */
export async function openTableSession(
  storeId: string,
  tableId: string,
  minutes: number | null,
) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("open_table_session", {
    p_store_id: storeId,
    p_table_id: tableId,
    p_minutes: minutes,
  });
  if (error) return { data: null, error: mapError(error) };
  return { data: data as string | null, error: null };
}

export async function closeTableSession(storeId: string, tableId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("close_table_session", {
    p_store_id: storeId,
    p_table_id: tableId,
  });
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

/** Single table by id (incl. session window), scoped to store. */
export async function getTable(tableId: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("tables")
    .select("*")
    .eq("id", tableId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) return { data: null, error: mapError(error) };
  return { data: data ? mapTable(data) : null, error: null };
}

function mapPrinter(row: PrinterRow): Printer {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    name: row.name,
    type: row.type,
    isDefault: row.is_default,
    ipAddress: row.ip_address ?? undefined,
    port: row.port ?? undefined,
    usbVendorId: row.usb_vendor_id ?? undefined,
    usbProductId: row.usb_product_id ?? undefined,
    bluetoothDeviceId: row.bluetooth_device_id ?? undefined,
    hubBluetoothPort: row.hub_bluetooth_port ?? undefined,
    hubUsbEnabled: row.hub_usb_enabled ?? false,
    hubUsbName: row.hub_usb_name ?? undefined,
    hubUsbBindingPolicy: row.hub_usb_binding_policy ?? "auto_single",
    // แสดงให้ผู้ใช้เห็นว่าระบบจำเครื่องไหนไว้ — ส่งเฉพาะชื่อคิว ไม่ส่ง pnp id/serial ออกหน้าเว็บ
    hubUsbIdentityQueueName:
      row.hub_usb_identity && typeof row.hub_usb_identity === "object" && !Array.isArray(row.hub_usb_identity)
        ? ((row.hub_usb_identity as Record<string, unknown>).queueName as string | undefined) ?? undefined
        : undefined,
    paperWidth: row.paper_width,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getStore(storeId: string) {
  return withDataClient<Store>(async (supabase) => {
    const { data, error } = await supabase
      .from("stores")
      .select("*")
      .eq("id", storeId)
      .single();
    return { data: data ? mapStore(data) : null, error };
  });
}

export async function listActiveStores(organizationId: string) {
  return withDataClient<Store[]>(
    async (supabase) => {
      const { data, error } = await supabase
        .from("stores")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("is_active", true)
        .order("name");
      return { data: data ? data.map(mapStore) : null, error };
    },
    { defaultData: [] },
  );
}

export async function listBranchStores(organizationId: string) {
  return listActiveStores(organizationId);
}

export interface UpdateStoreInput {
  name?: string;
  address?: string | null;
  phone?: string | null;
  logoUrl?: string | null;
  currencyCode?: string;
  timezone?: string;
  locale?: string;
  buffetEnabled?: boolean;
  qrOrderingEnabled?: boolean;
  qrOrderingMode?: QrOrderingMode;
  tableOpenPolicy?: TableOpenPolicy;
  musicRequestEnabled?: boolean;
  dineInDurationMinutes?: number;
  dineInNoExpiry?: boolean;
  themePresetId?: string;
  themePrimaryColor?: string;
  themePrimaryStrongColor?: string;
  themePrimarySoftColor?: string;
  themeAccentColor?: string;
}

export async function updateStoreSetupProfile(
  storeId: string,
  organizationId: string,
  profile: StoreSetupProfile,
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("stores")
    .update({
      setup_profile: profile,
      updated_at: new Date().toISOString(),
    })
    .eq("id", storeId)
    .eq("organization_id", organizationId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}
export async function updateStore(storeId: string, organizationId: string, input: UpdateStoreInput) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("stores")
    .update({
      name: input.name,
      address: input.address,
      phone: input.phone,
      logo_url: input.logoUrl,
      currency_code: input.currencyCode,
      timezone: input.timezone,
      locale: input.locale,
      buffet_enabled: input.buffetEnabled,
      qr_ordering_enabled: input.qrOrderingEnabled,
      qr_ordering_mode: input.qrOrderingMode,
      table_open_policy: input.tableOpenPolicy,
      music_request_enabled: input.musicRequestEnabled,
      dine_in_duration_minutes: input.dineInDurationMinutes,
      dine_in_no_expiry: input.dineInNoExpiry,
      theme_preset_id: input.themePresetId,
      theme_primary_color: input.themePrimaryColor,
      theme_primary_strong_color: input.themePrimaryStrongColor,
      theme_primary_soft_color: input.themePrimarySoftColor,
      theme_accent_color: input.themeAccentColor,
      updated_at: new Date().toISOString(),
    })
    .eq("id", storeId)
    .eq("organization_id", organizationId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

/** อัปเดตปุ่มเรียกบริการ (ข้อความ + เปิด/ปิด) ของร้าน */
export async function updateStoreServiceButtons(
  storeId: string,
  organizationId: string,
  buttons: ServiceButtonConfig[],
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("stores")
    .update({
      qr_service_buttons: buttons as unknown as Database["public"]["Tables"]["stores"]["Update"]["qr_service_buttons"],
      updated_at: new Date().toISOString(),
    })
    .eq("id", storeId)
    .eq("organization_id", organizationId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function listStoreTables(storeId: string) {
  return withDataClient<Table[]>(
    async (supabase) => {
      const { data, error } = await supabase
        .from("tables")
        .select("*")
        .eq("store_id", storeId)
        .eq("is_active", true)
        .order("number");
      return { data: data ? data.map(mapTable) : null, error };
    },
    { defaultData: [] },
  );
}

/** All tables (incl. inactive) for the management page. */
export async function listManagedTables(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("tables")
    .select("*")
    .eq("store_id", storeId)
    .order("number");
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map(mapTable), error: null };
}

export interface TableInput {
  number: string;
  label?: string;
  seats?: number;
  isActive: boolean;
  qrEnabled: boolean;
}

export async function createTable(storeId: string, organizationId: string, input: TableInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("tables")
    .insert({
      store_id: storeId,
      organization_id: organizationId,
      number: input.number,
      label: input.label ?? null,
      seats: input.seats ?? null,
      is_active: input.isActive,
      qr_enabled: input.qrEnabled,
    })
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapTable(data), error: null };
}

export async function updateTable(id: string, storeId: string, input: TableInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("tables")
    .update({
      number: input.number,
      label: input.label ?? null,
      seats: input.seats ?? null,
      is_active: input.isActive,
      qr_enabled: input.qrEnabled,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("store_id", storeId)
    .select()
    .single();
  if (error || !data) return { data: null, error: mapError(error ?? new Error("ไม่พบโต๊ะ")) };
  return { data: mapTable(data), error: null };
}

export async function deleteTable(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("tables").delete().eq("id", id).eq("store_id", storeId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function getTableByNumber(storeId: string, number: string) {
  return withDataClient<Table>(async (supabase) => {
    const { data, error } = await supabase
      .from("tables")
      .select("*")
      .eq("store_id", storeId)
      .eq("number", number)
      .single();
    return { data: data ? mapTable(data) : null, error };
  });
}

export async function getReceiptSettings(storeId: string) {
  return withDataClient<ReceiptSettings | null>(
    async (supabase) => {
      const { data, error } = await supabase
        .from("receipt_settings")
        .select("*")
        .eq("store_id", storeId)
        .maybeSingle();
      if (!data) return { data: null, error };
      return {
        data: {
          id: data.id,
          storeId: data.store_id,
          organizationId: data.organization_id,
          storeName: data.store_name,
          address: data.address ?? undefined,
          phone: data.phone ?? undefined,
          taxId: data.tax_id ?? undefined,
          showTaxId: data.show_tax_id,
          showQrPayment: data.show_qr_payment,
          promptpayId: data.promptpay_id ?? undefined,
          headerText: data.header_text ?? undefined,
          footerText: data.footer_text ?? undefined,
          logoUrl: data.logo_url ?? undefined,
          footerImageUrl: data.footer_image_url ?? undefined,
          footerImageLabel: data.footer_image_label ?? undefined,
          // ค่าเริ่มต้น true — ร้านเก่าที่ยังไม่เคยตั้งค่าได้พฤติกรรมปลอดภัยไว้ก่อน
          hideFooterImageWithSystemQr: data.footer_image_hide_with_system_qr ?? true,
          autoPrintReceipt: data.auto_print_receipt,
          autoPrintStationTickets: data.auto_print_station_tickets,
          paperWidth: data.paper_width,
          printCopies: data.print_copies,
          showVatBreakdown: data.show_vat_breakdown,
          vatRate: data.vat_rate,
          updatedAt: data.updated_at,
        },
        error: null,
      };
    },
    { allowNull: true },
  );
}

export async function getPrinter(printerId: string, storeId: string, organizationId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("printers")
    .select("*")
    .eq("id", printerId)
    .eq("store_id", storeId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { data: null, error: mapError(error) };
  return { data: data ? mapPrinter(data) : null, error: null };
}

export async function listPrinters(storeId: string, organizationId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("printers")
    .select("*")
    .eq("store_id", storeId)
    .eq("organization_id", organizationId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) return { data: [], error: mapError(error) };
  return { data: (data ?? []).map(mapPrinter), error: null };
}

export async function updateTableStatus(
  tableId: string,
  status: Table["status"],
  sessionId: string | null,
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("tables")
    .update({
      status,
      current_session_id: sessionId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", tableId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}
