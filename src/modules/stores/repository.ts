import { withDataClient } from "@/shared/services/data-client";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { Store, Table, ReceiptSettings, Printer } from "@/modules/stores/types";
import type { Database } from "@/server/integrations/supabase/database.types";

type StoreRow = Database["public"]["Tables"]["stores"]["Row"];
type TableRow = Database["public"]["Tables"]["tables"]["Row"];
type PrinterRow = Database["public"]["Tables"]["printers"]["Row"];

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
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
          paperWidth: data.paper_width,
          printCopies: data.print_copies,
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
