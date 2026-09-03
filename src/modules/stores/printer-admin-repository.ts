import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { Printer } from "@/modules/stores/types";
import type { Database } from "@/server/integrations/supabase/database.types";

// Privileged printer writes (service client) live outside stores/repository.ts
// on purpose: repository functions must stay user-scoped (RLS), while these are
// only reachable from server actions that already ran
// requirePermission("settings.manage_printer").

type PrinterRow = Database["public"]["Tables"]["printers"]["Row"];

export interface NetworkPrinterInput {
  id?: string;
  name: string;
  ipAddress: string;
  port: number;
  paperWidth: "58mm" | "80mm";
  isDefault?: boolean;
}

export interface HubUsbPrinterInput {
  id?: string;
  name: string;
  /**
   * ชื่อเครื่องพิมพ์ของ Windows บนพีซีแคชเชียร์ (ผ่าน validateHubUsbPrinterName แล้ว)
   * null = โหมดตรวจจับอัตโนมัติ — Hub เลือกเครื่องพิมพ์ USB ที่เสียบอยู่เองทุกครั้งที่พิมพ์
   */
  windowsPrinterName: string | null;
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
    paperWidth: row.paper_width,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

/**
 * Saves a USB printer that prints through the Print Hub: the printer is plugged
 * into the cashier PC with a cable and the Hub writes raw ESC/POS to it through
 * the Windows spooler. Stored as a `usb` printer with `hub_usb_enabled` set,
 * which keeps it apart from the older `usb` printers that print directly from
 * the browser with WebUSB (those keep their existing behaviour).
 *
 * `windowsPrinterName: null` = ตรวจจับอัตโนมัติ: ย้ายสายไปพอร์ต USB อื่นหรือเปลี่ยน
 * เครื่องพิมพ์ ก็ยังพิมพ์ได้โดยไม่ต้องตั้งค่าใหม่.
 */
export async function upsertHubUsbPrinter(
  storeId: string,
  organizationId: string,
  input: HubUsbPrinterInput,
) {
  const supabase = await createSupabaseServiceClient();
  const now = new Date().toISOString();

  const payload = {
    store_id: storeId,
    organization_id: organizationId,
    name: input.name,
    type: "usb" as const,
    is_default: Boolean(input.isDefault),
    ip_address: null,
    port: null,
    usb_vendor_id: null,
    usb_product_id: null,
    bluetooth_device_id: null,
    hub_bluetooth_port: null,
    hub_usb_enabled: true,
    hub_usb_name: input.windowsPrinterName,
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
 * Task 10/D (v0.34.1) — Atomic success recording for shared device profiles.
 * Call ONLY from the server after a cloud-verified test print bound to the AI
 * request; never trust a client boolean.
 */
export async function recordDeviceProfileSuccess(platform: string, printerModel: string, channel: string) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.rpc("record_device_profile_success", {
    p_platform: platform,
    p_printer_model: printerModel,
    p_channel: channel,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}