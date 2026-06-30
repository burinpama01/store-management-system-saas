"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { normalizeNetworkPrinterEndpoint } from "@/modules/printing/network-printer";
import { validateHubBluetoothPort } from "@/modules/printing/print-hub";
import { RECEIPT_MESSAGE_MAX_LENGTH } from "@/modules/settings/receipt-limits";
import { upsertReceiptSettings } from "@/modules/settings/repository";
import { upsertHubBluetoothPrinter, upsertNetworkPrinter } from "@/modules/stores/repository";

/** Accepts only http(s) image URLs within a sane length (Supabase public URL or pasted link). */
function isValidImageUrl(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

export async function upsertReceiptSettingsAction(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.manage_store");
    const { ctx } = await getStoreContext();

    const storeName = (formData.get("storeName") as string | null)?.trim() ?? "";
    const address = (formData.get("address") as string | null)?.trim() || undefined;
    const phone = (formData.get("phone") as string | null)?.trim() || undefined;
    const taxId = (formData.get("taxId") as string | null)?.trim() || undefined;
    const showTaxId = formData.get("showTaxId") === "1";
    const showQrPayment = formData.get("showQrPayment") === "1";
    const promptpayId = (formData.get("promptpayId") as string | null)?.trim() || undefined;
    const headerText = (formData.get("headerText") as string | null)?.trim() || undefined;
    const footerText = (formData.get("footerText") as string | null)?.trim() || undefined;
    const logoUrl = (formData.get("logoUrl") as string | null)?.trim() || undefined;
    const footerImageUrl = (formData.get("footerImageUrl") as string | null)?.trim() || undefined;
    const autoPrintReceipt = formData.get("autoPrintReceipt") === "1";
    const autoPrintStationTickets = formData.get("autoPrintStationTickets") === "1";
    const paperWidth = formData.get("paperWidth") as "58mm" | "80mm" | null;
    const printCopiesRaw = formData.get("printCopies") as string | null;

    if (!storeName) return { error: "กรุณาระบุชื่อร้านในใบเสร็จ" };
    if (storeName.length > 100) return { error: "ชื่อร้านในใบเสร็จยาวเกิน 100 ตัวอักษร" };
    if (taxId && (taxId.length > 13 || !/^\d+$/.test(taxId)))
      return { error: "เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข ไม่เกิน 13 หลัก" };
    if (promptpayId && (promptpayId.length > 13 || !/^\d+$/.test(promptpayId)))
      return { error: "PromptPay ID ต้องเป็นตัวเลข ไม่เกิน 13 หลัก" };
    if (showQrPayment && !promptpayId) return { error: "กรุณาระบุหมายเลข PromptPay" };
    if (headerText && headerText.length > RECEIPT_MESSAGE_MAX_LENGTH)
      return { error: `ข้อความส่วนหัวยาวเกิน ${RECEIPT_MESSAGE_MAX_LENGTH} ตัวอักษร` };
    if (footerText && footerText.length > RECEIPT_MESSAGE_MAX_LENGTH)
      return { error: `ข้อความส่วนท้ายยาวเกิน ${RECEIPT_MESSAGE_MAX_LENGTH} ตัวอักษร` };
    if (logoUrl && !isValidImageUrl(logoUrl)) return { error: "ลิงก์โลโก้หัวใบเสร็จไม่ถูกต้อง" };
    if (footerImageUrl && !isValidImageUrl(footerImageUrl)) return { error: "ลิงก์รูปท้ายใบเสร็จไม่ถูกต้อง" };
    if (!paperWidth || !["58mm", "80mm"].includes(paperWidth))
      return { error: "ความกว้างกระดาษไม่ถูกต้อง" };
    const printCopies = parseInt(printCopiesRaw ?? "", 10);
    if (!Number.isInteger(printCopies) || printCopies < 1 || printCopies > 5)
      return { error: "จำนวนสำเนาต้องอยู่ระหว่าง 1–5" };

    const result = await upsertReceiptSettings(ctx.storeId, ctx.organizationId, {
      storeName,
      address,
      phone,
      taxId,
      showTaxId,
      showQrPayment,
      promptpayId,
      headerText,
      footerText,
      logoUrl,
      footerImageUrl,
      autoPrintReceipt,
      autoPrintStationTickets,
      paperWidth,
      printCopies,
    });

    if (result.error) return { error: result.error.userMessage };

    revalidatePath("/settings/receipt");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function saveNetworkPrinterAction(
  _prev: { error: string | null; saved?: boolean },
  formData: FormData,
): Promise<{ error: string | null; saved?: boolean }> {
  try {
    await requirePermission("settings.manage_printer");
    const { ctx } = await getStoreContext();

    const id = (formData.get("printerId") as string | null)?.trim() || undefined;
    const name = (formData.get("name") as string | null)?.trim() ?? "";
    const ipAddress = (formData.get("ipAddress") as string | null)?.trim() ?? "";
    const portRaw = (formData.get("port") as string | null)?.trim() ?? "";
    const paperWidthRaw = (formData.get("paperWidth") as string | null)?.trim() ?? "";
    const isDefault = formData.get("isDefault") === "on";

    if (!name) return { error: "กรุณาระบุชื่อเครื่องพิมพ์" };
    if (!ipAddress) return { error: "กรุณาระบุ IP เครื่องพิมพ์" };
    const port = portRaw ? Number(portRaw) : 9100;
    if (!Number.isInteger(port)) return { error: "พอร์ตต้องเป็นตัวเลขจำนวนเต็ม" };
    if (paperWidthRaw !== "58mm" && paperWidthRaw !== "80mm") return { error: "ขนาดกระดาษไม่ถูกต้อง" };

    let endpoint: { host: string; port: number };
    try {
      endpoint = normalizeNetworkPrinterEndpoint({ host: ipAddress, port });
    } catch {
      return { error: "IP/พอร์ตไม่ถูกต้อง ต้องเป็น Private LAN เช่น 192.168.x.x, 10.x.x.x หรือ 172.16-31.x.x" };
    }

    const result = await upsertNetworkPrinter(ctx.storeId, ctx.organizationId, {
      id,
      name,
      ipAddress: endpoint.host,
      port: endpoint.port,
      paperWidth: paperWidthRaw,
      isDefault,
    });
    if (result.error) return { error: result.error.userMessage };

    revalidatePath("/settings/receipt");
    return { error: null, saved: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function saveHubBluetoothPrinterAction(
  _prev: { error: string | null; saved?: boolean },
  formData: FormData,
): Promise<{ error: string | null; saved?: boolean }> {
  try {
    await requirePermission("settings.manage_printer");
    const { ctx } = await getStoreContext();

    const id = (formData.get("printerId") as string | null)?.trim() || undefined;
    const name = (formData.get("name") as string | null)?.trim() ?? "";
    const comPortRaw = (formData.get("comPort") as string | null)?.trim() ?? "";
    const paperWidthRaw = (formData.get("paperWidth") as string | null)?.trim() ?? "";
    const isDefault = formData.get("isDefault") === "on";

    if (!name) return { error: "กรุณาระบุชื่อเครื่องพิมพ์" };
    if (paperWidthRaw !== "58mm" && paperWidthRaw !== "80mm") return { error: "ขนาดกระดาษไม่ถูกต้อง" };

    const portCheck = validateHubBluetoothPort(comPortRaw);
    if (portCheck.error || !portCheck.device) {
      return { error: portCheck.error ?? "พอร์ต COM ไม่ถูกต้อง" };
    }

    const result = await upsertHubBluetoothPrinter(ctx.storeId, ctx.organizationId, {
      id,
      name,
      comPort: portCheck.device,
      paperWidth: paperWidthRaw,
      isDefault,
    });
    if (result.error) return { error: result.error.userMessage };

    revalidatePath("/settings/receipt");
    return { error: null, saved: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
