import { withDataClient } from "@/shared/services/data-client";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { DEFAULT_THEME } from "@/modules/theme/presets";
import { mapError } from "@/shared/utils/error";
import type { Store, Table, ReceiptSettings, Printer, QrOrderingMode, TableOpenPolicy } from "@/modules/stores/types";
import type { Database } from "@/server/integrations/supabase/database.types";

type StoreRow = Database["public"]["Tables"]["stores"]["Row"];
type TableRow = Database["public"]["Tables"]["tables"]["Row"];
type PrinterRow = Database["public"]["Tables"]["printers"]["Row"];

export interface NetworkPrinterInput {
  id?: string;
  name: string;
  ipAddress: string;
  port: number;
  paperWidth: "58mm" | "80mm";
  isDefault?: boolean;
}

export interface HubBluetoothPrinterInput {
  id?: string;
  name: string;
  /** Cashier-PC Bluetooth SPP COM port, already validated (e.g. "COM5"). */
  comPort: string;
  paperWidth: "58mm" | "80mm";
  isDefault?: boolean;
}

function mapStore(row: StoreRow): Store {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    address: row.address ?? undefined,
    phone: row.phone ?? undefined,
    logoUrl: row.logo_url ?? undefined,
    currencyCode: row.currency_code,
    timezone: row.timezone,
    locale: row.locale,
    isActive: row.is_active,
    buffetEnabled: row.buffet_enabled,
    qrOrderingEnabled: row.qr_ordering_enabled,
    qrOrderingMode: row.qr_ordering_mode,
    tableOpenPolicy: row.table_open_policy,
    musicRequestEnabled: row.music_request_enabled,
    musicLicenseStatus: row.music_license_status,
    musicLicenseApprovedAt: row.music_license_approved_at ?? undefined,
    musicLicenseNote: row.music_license_note ?? undefined,
    dineInDurationMinutes: row.dine_in_duration_minutes,
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

export async function openTableSession(storeId: string, tableId: string, minutes: number) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("open_table_session", {
    p_store_id: storeId,
    p_table_id: tableId,
    p_minutes: minutes,
  });
  if (error) return { data: null, error: mapError(error) };
  return { data: data as string, error: null };
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
  themePresetId?: string;
  themePrimaryColor?: string;
  themePrimaryStrongColor?: string;
  themePrimarySoftColor?: string;
  themeAccentColor?: string;
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

export async function upsertNetworkPrinter(
  storeId: string,
  organizationId: string,
  input: NetworkPrinterInput,
) {
  const supabase = await createSupabaseServiceClient();
  const now = new Date().toISOString();

  const payload = {
    store_id: storeId,
    organization_id: organizationId,
    name: input.name,
    type: "ip" as const,
    is_default: Boolean(input.isDefault),
    ip_address: input.ipAddress,
    port: input.port,
    usb_vendor_id: null,
    usb_product_id: null,
    bluetooth_device_id: null,
    paper_width: input.paperWidth,
    updated_at: now,
  };

  const query = input.id
    ? supabase
      .from("printers")
      .update(payload)
      .eq("id", input.id)
      .eq("store_id", storeId)
      .eq("organization_id", organizationId)
      .select("*")
      .single()
    : supabase
      .from("printers")
      .insert(payload)
      .select("*")
      .single();

  const { data, error } = await query;
  if (error) return { data: null, error: mapError(error) };
  const savedPrinter = mapPrinter(data);

  if (input.isDefault) {
    const { error: clearError } = await supabase
      .from("printers")
      .update({ is_default: false, updated_at: now })
      .eq("store_id", storeId)
      .eq("organization_id", organizationId)
      .neq("id", savedPrinter.id);
    if (clearError) return { data: null, error: mapError(clearError) };
  }

  return { data: savedPrinter, error: null };
}

/**
 * Saves a Bluetooth printer that prints through the Print Hub: it is paired to
 * the cashier PC as a Windows Bluetooth SPP COM port. Stored as a `bluetooth`
 * printer with `hub_bluetooth_port` set, so the enqueue endpoint can route
 * tablet/iOS jobs to it (which cannot reach Web Bluetooth).
 */
export async function upsertHubBluetoothPrinter(
  storeId: string,
  organizationId: string,
  input: HubBluetoothPrinterInput,
) {
  const supabase = await createSupabaseServiceClient();
  const now = new Date().toISOString();

  const payload = {
    store_id: storeId,
    organization_id: organizationId,
    name: input.name,
    type: "bluetooth" as const,
    is_default: Boolean(input.isDefault),
    ip_address: null,
    port: null,
    usb_vendor_id: null,
    usb_product_id: null,
    bluetooth_device_id: null,
    hub_bluetooth_port: input.comPort,
    paper_width: input.paperWidth,
    updated_at: now,
  };

  const query = input.id
    ? supabase
      .from("printers")
      .update(payload)
      .eq("id", input.id)
      .eq("store_id", storeId)
      .eq("organization_id", organizationId)
      .select("*")
      .single()
    : supabase
      .from("printers")
      .insert(payload)
      .select("*")
      .single();

  const { data, error } = await query;
  if (error) return { data: null, error: mapError(error) };
  const savedPrinter = mapPrinter(data);

  if (input.isDefault) {
    const { error: clearError } = await supabase
      .from("printers")
      .update({ is_default: false, updated_at: now })
      .eq("store_id", storeId)
      .eq("organization_id", organizationId)
      .neq("id", savedPrinter.id);
    if (clearError) return { data: null, error: mapError(clearError) };
  }

  return { data: savedPrinter, error: null };
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
