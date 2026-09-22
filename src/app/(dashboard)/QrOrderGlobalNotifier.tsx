"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import { managedRealtimeSubscription } from "@/shared/realtime/realtime-client";
import {
  getBluetoothPrinterName,
  isBluetoothPrinterConnected,
} from "@/modules/printing/bluetooth-client";
import {
  getUsbPrinterName,
  isUsbPrinterConnected,
} from "@/modules/printing/usb-client";
import { autoPrintReceipt, selectHubReceiptPrinter } from "@/modules/printing/receipt-printer";
import { describeStationPrintResult, dispatchOrderStationTickets } from "@/modules/printing/station-print-client";
import { isNewKitchenQrOrderEvent } from "@/modules/qr-ordering/incoming-order";
import type { EscPosReceiptInput } from "@/modules/printing/escpos";
import type { ReceiptData } from "@/modules/printing/types";
import type { Printer } from "@/modules/stores/types";
import type { Database, Json } from "@/server/integrations/supabase/database.types";
import { useRepeatingAlert } from "@/shared/notifications/alert-sound";
import { qrOrderAnnouncement } from "@/shared/notifications/announcement-text";

const AUTO_PRINT_KEY = "qrOrderAutoPrintEnabled";
const QR_PENDING_POLL_MS = 15_000;

/** แถวจาก /api/qr/pending (กรองสถานีครัวฝั่งเซิร์ฟเวอร์แล้ว) */
interface PendingQrOrder {
  id: string;
  orderNumber: string;
  tableNumber: string | null;
  createdAt: string;
  items: OrderItemRow[];
}

type OrderInsertPayload = Pick<
  Database["public"]["Tables"]["orders"]["Row"],
  "id" | "order_number" | "qr_order_source" | "table_bill_key" | "table_number" | "total" | "created_at"
>;

type OrderItemRow = Pick<
  Database["public"]["Tables"]["order_items"]["Row"],
  | "id"
  | "order_id"
  | "product_name"
  | "variant_name"
  | "kitchen_station_id"
  | "kitchen_station_name"
  | "modifiers"
  | "quantity"
  | "unit_price"
  | "total_price"
  | "note"
>;

interface IncomingOrderItem {
  id: string;
  productName: string;
  variantName?: string;
  kitchenStationId?: string;
  kitchenStationName?: string;
  modifierNames: string[];
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  note?: string;
}

interface IncomingQrOrder {
  id: string;
  orderNumber: string;
  tableNumber?: string;
  total: number;
  createdAt: string;
  items: IncomingOrderItem[];
}

interface PrinterState {
  connected: boolean;
  label: string;
}

interface StationPrinter {
  id: string;
  name: string;
  printerId?: string;
}

interface Props {
  storeId: string;
  storeName: string;
  qrOrderingEnabled: boolean;
  canManageQr: boolean;
  canViewEveryKitchenStation: boolean;
  assignedKitchenStationIds: string[];
  /** Active kitchen stations with their bound network printers, for per-station routing. */
  stationPrinters: StationPrinter[];
  /** Store setting: auto-print per-station tickets to their printers when an order arrives. */
  autoPrintStationTickets: boolean;
  receiptPaperWidth: "58mm" | "80mm";
  /** Store printers, so the whole-order receipt can enqueue to the Hub (iPad-safe). */
  receiptPrinters: Printer[];
  /** stores.notification_voice_enabled — อ่านออกเสียงแทน beep */
  voiceEnabled?: boolean;
}

function readAutoPrintPreference() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(AUTO_PRINT_KEY) === "true";
}

function getPrinterState(): PrinterState {
  if (isBluetoothPrinterConnected()) {
    return { connected: true, label: getBluetoothPrinterName() ?? "Bluetooth printer" };
  }
  if (isUsbPrinterConnected()) {
    return { connected: true, label: getUsbPrinterName() ?? "USB printer" };
  }
  return { connected: false, label: "ไม่ได้เชื่อมต่อเครื่องพิมพ์" };
}

function extractModifierNames(value: Json): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((modifier) => {
      if (!modifier || typeof modifier !== "object") return null;
      const option = (modifier as { option?: { name?: unknown } }).option;
      return typeof option?.name === "string" ? option.name : null;
    })
    .filter((name): name is string => Boolean(name));
}

function toReceiptData(storeName: string, order: IncomingQrOrder): ReceiptData & EscPosReceiptInput {
  const printedAt = new Date().toISOString();
  const items = order.items.map((item) => ({
    name: item.productName,
    variantName: item.variantName,
    modifierNames: item.modifierNames,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    totalPrice: item.totalPrice,
    note: item.note,
  }));
  return {
    storeName,
    orderNumber: order.orderNumber,
    tableNumber: order.tableNumber,
    items,
    subtotal: order.total,
    discount: 0,
    total: order.total,
    payments: [],
    paymentStatus: "unpaid",
    showTaxId: false,
    showQrPayment: false,
    paperWidth: "58mm",
    printCopies: 1,
    printedAt,
  };
}

async function printQrKitchenOrder(storeName: string, order: IncomingQrOrder, printers: Printer[]) {
  const receipt = toReceiptData(storeName, order);
  // Enqueue to the Hub for a Hub-capable default printer (works on iPad),
  // else fall back to a directly-connected browser printer (BT/USB/PDF).
  return autoPrintReceipt({ printers, escpos: receipt, browser: receipt });
}

function mapIncomingItems(rows: OrderItemRow[]): IncomingOrderItem[] {
  return rows.map((row) => ({
    id: row.id,
    productName: row.product_name,
    variantName: row.variant_name ?? undefined,
    kitchenStationId: row.kitchen_station_id ?? undefined,
    kitchenStationName: row.kitchen_station_name ?? undefined,
    modifierNames: extractModifierNames(row.modifiers),
    quantity: row.quantity,
    unitPrice: row.unit_price,
    totalPrice: row.total_price,
    note: row.note ?? undefined,
  }));
}

export function QrOrderGlobalNotifier({
  storeId,
  storeName,
  qrOrderingEnabled,
  canManageQr,
  canViewEveryKitchenStation,
  assignedKitchenStationIds,
  stationPrinters,
  autoPrintStationTickets,
  receiptPaperWidth,
  receiptPrinters,
  voiceEnabled = false,
}: Props) {
  const router = useRouter();
  const seenOrderIds = useRef(new Set<string>());
  const [orders, setOrders] = useState<IncomingQrOrder[]>([]);
  const [autoPrintEnabled, setAutoPrintEnabled] = useState(false);
  const [printerState, setPrinterState] = useState<PrinterState>(() => ({
    connected: false,
    label: "กำลังตรวจเครื่องพิมพ์",
  }));
  const [printStatus, setPrintStatus] = useState<string | null>(null);
  const allowedStationIds = useMemo(
    () => new Set(assignedKitchenStationIds),
    [assignedKitchenStationIds],
  );
  const currentOrder = orders[0] ?? null;
  // เสียงเตือนดังซ้ำจนกว่าจะปิด dialog ออร์เดอร์ QR
  // ประโยคที่พูดต้องไม่มีข้อมูลลูกค้าหรือยอดเงิน — ลำโพงอยู่หน้าร้าน ลูกค้าได้ยินด้วย
  useRepeatingAlert(Boolean(currentOrder), "order", {
    announcement: currentOrder ? qrOrderAnnouncement(currentOrder.tableNumber, orders.length) : null,
    voiceEnabledByStore: voiceEnabled,
  });

  useEffect(() => {
    const preferenceTimer = window.setTimeout(() => {
      setAutoPrintEnabled(readAutoPrintPreference());
    }, 0);
    const update = () => setPrinterState(getPrinterState());
    update();
    const id = window.setInterval(update, 5000);
    return () => {
      window.clearTimeout(preferenceTimer);
      window.clearInterval(id);
    };
  }, []);

  function setAutoPrintPreference(next: boolean) {
    setAutoPrintEnabled(next);
    window.localStorage.setItem(AUTO_PRINT_KEY, String(next));
  }

  const fetchVisibleOrder = useCallback(async (order: OrderInsertPayload): Promise<IncomingQrOrder | null> => {
    if (!canViewEveryKitchenStation && assignedKitchenStationIds.length === 0) return null;
    const client = getSupabaseBrowserClient();
    let itemQuery = client
      .from("order_items")
      .select("id, order_id, product_name, variant_name, kitchen_station_id, kitchen_station_name, modifiers, quantity, unit_price, total_price, note")
      .eq("order_id", order.id);
    if (!canViewEveryKitchenStation) {
      itemQuery = itemQuery.in("kitchen_station_id", assignedKitchenStationIds);
    }
    const { data, error } = await itemQuery;
    if (error) return canViewEveryKitchenStation
      ? {
          id: order.id,
          orderNumber: order.order_number,
          tableNumber: order.table_number ?? undefined,
          total: order.total,
          createdAt: order.created_at,
          items: [],
        }
      : null;

    const items = mapIncomingItems((data ?? []) as OrderItemRow[]);
    const visibleItems = canViewEveryKitchenStation
      ? items
      : items.filter((item) =>
          item.kitchenStationId ? allowedStationIds.has(item.kitchenStationId) : false,
        );
    if (!canViewEveryKitchenStation && visibleItems.length === 0) return null;
    return {
      id: order.id,
      orderNumber: order.order_number,
      tableNumber: order.table_number ?? undefined,
      total: visibleItems.reduce((sum, item) => sum + item.totalPrice, 0),
      createdAt: order.created_at,
      items: visibleItems,
    };
  }, [allowedStationIds, assignedKitchenStationIds, canViewEveryKitchenStation]);

  // เด้ง dialog + ส่งตั๋วครัว/พิมพ์อัตโนมัติ — ใช้ร่วมกันทั้งทาง realtime และ polling
  // (seenOrderIds กันเด้งซ้ำเมื่อทั้งสองทางเจอออเดอร์เดียวกัน)
  const announceOrder = useCallback(async (visibleOrder: IncomingQrOrder) => {
    setOrders((prev) => [...prev, visibleOrder]);

    // Multi-printer routing: split the order into per-station tickets and
    // enqueue each to its station's network printer via the Print Hub.
    // ทุกจอยิงได้ — คีย์ (ออเดอร์, สถานี) ทำให้ server ออกตั๋วใบเดียว
    if (autoPrintStationTickets && stationPrinters.some((s) => s.printerId)) {
      setPrintStatus("กำลังส่งตั๋วครัว");
      void dispatchOrderStationTickets({
        orderId: visibleOrder.id,
        orderNumber: visibleOrder.orderNumber,
        tableNumber: visibleOrder.tableNumber,
        paperWidth: receiptPaperWidth,
        items: visibleOrder.items.map((item) => ({
          name: item.productName,
          variantName: item.variantName,
          modifierNames: item.modifierNames,
          quantity: item.quantity,
          note: item.note,
          kitchenStationId: item.kitchenStationId,
        })),
        stations: stationPrinters,
      }).then((res) => {
        if (res) setPrintStatus(describeStationPrintResult(res));
      });
    }

    if (!readAutoPrintPreference()) return;
    const hubPrinter = selectHubReceiptPrinter(receiptPrinters);
    const latestPrinterState = getPrinterState();
    setPrinterState(latestPrinterState);
    if (!hubPrinter && !latestPrinterState.connected) {
      setPrintStatus("เปิดพิมพ์อัตโนมัติอยู่ แต่ยังไม่มีเครื่องพิมพ์ (ตั้งเครื่องพิมพ์หลักในตั้งค่า หรือเชื่อม BT/USB)");
      return;
    }
    try {
      setPrintStatus("กำลังสั่งพิมพ์ออร์เดอร์ QR");
      const printResult = await printQrKitchenOrder(storeName, visibleOrder, receiptPrinters);
      setPrintStatus(
        printResult.hubOnline === false
          ? "ส่งเข้าคิวแล้ว แต่ Hub (เครื่องแคชเชียร์) ออฟไลน์ — จะพิมพ์เมื่อเปิดเครื่อง"
          : hubPrinter
            ? "ส่งออร์เดอร์ QR เข้าคิว Hub แล้ว"
            : "สั่งพิมพ์ออร์เดอร์ QR แล้ว",
      );
    } catch (error) {
      setPrintStatus(error instanceof Error ? error.message : "สั่งพิมพ์ไม่สำเร็จ");
    }
  }, [autoPrintStationTickets, receiptPaperWidth, receiptPrinters, stationPrinters, storeName]);

  useEffect(() => {
    if (!qrOrderingEnabled || !canManageQr) return;
    const client = getSupabaseBrowserClient();
    const unsubscribe = managedRealtimeSubscription<OrderInsertPayload>({
      client,
      table: "orders",
      filter: `store_id=eq.${storeId}`,
      onEvent: (payload) => {
        // ข้ามบิลรวมโต๊ะ (table_bill_key) — รายการเป็นของรอบที่ครัวทำไปแล้ว ห้ามเด้ง/พิมพ์ซ้ำ
        if (!isNewKitchenQrOrderEvent(payload) || !payload.new) return;
        const order = payload.new;
        if (seenOrderIds.current.has(order.id)) return;
        seenOrderIds.current.add(order.id);
        void fetchVisibleOrder(order).then((visibleOrder) => {
          if (visibleOrder) void announceOrder(visibleOrder);
        });
      },
    });
    return unsubscribe;
  }, [announceOrder, canManageQr, fetchVisibleOrder, qrOrderingEnabled, storeId]);

  // ทางสำรองแบบเดียวกับเดลิเวอรี: poll ออเดอร์ที่ครัวยังไม่รับ — realtime ของ orders ไม่ส่งเหตุการณ์
  // ในบางจอ (เช่น POS) ทำให้ dialog ไม่เด้ง; รอบแรกตั้ง baseline ไม่เด้งของที่ค้างอยู่ก่อนเปิดหน้า
  const pollBaselined = useRef(false);
  const pollPending = useCallback(async () => {
    let list: PendingQrOrder[];
    try {
      const res = await fetch("/api/qr/pending", { cache: "no-store" });
      if (!res.ok) return;
      list = ((await res.json()) as { orders?: PendingQrOrder[] }).orders ?? [];
    } catch {
      return;
    }
    const fresh = list.filter((order) => !seenOrderIds.current.has(order.id));
    for (const order of fresh) seenOrderIds.current.add(order.id);
    if (!pollBaselined.current) {
      pollBaselined.current = true;
      return;
    }
    for (const order of fresh) {
      const items = mapIncomingItems(order.items);
      void announceOrder({
        id: order.id,
        orderNumber: order.orderNumber,
        tableNumber: order.tableNumber ?? undefined,
        total: items.reduce((sum, item) => sum + item.totalPrice, 0),
        createdAt: order.createdAt,
        items,
      });
    }
  }, [announceOrder]);

  useEffect(() => {
    if (!qrOrderingEnabled || !canManageQr) return;
    void pollPending();
    const id = window.setInterval(() => {
      // แท็บ/แอปอยู่เบื้องหลังไม่ต้อง poll (push ของแอปดูแลแทน) — ประหยัดโควตา Vercel/Supabase
      if (document.visibilityState === "hidden") return;
      void pollPending();
    }, QR_PENDING_POLL_MS);
    return () => window.clearInterval(id);
  }, [canManageQr, pollPending, qrOrderingEnabled]);

  if (!qrOrderingEnabled || !canManageQr) return null;

  return (
    <>
      {autoPrintEnabled && !printerState.connected && (
        <div className="fixed bottom-3 right-3 z-40 max-w-xs rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 shadow-sm">
          เครื่องพิมพ์ QR order ไม่ได้เชื่อมต่อ
        </div>
      )}

      {currentOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="qr-order-alert-title"
            className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-5 shadow-xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="qr-order-alert-title" className="text-lg font-bold text-gray-950">
                  มีออร์เดอร์ QR ใหม่
                </h2>
                <p className="mt-1 text-sm text-gray-600">
                  โต๊ะ {currentOrder.tableNumber ?? "-"} · #{currentOrder.orderNumber}
                </p>
              </div>
              {orders.length > 1 && (
                <span className="rounded-full bg-orange-100 px-2.5 py-1 text-xs font-semibold text-orange-700">
                  +{orders.length - 1}
                </span>
              )}
            </div>

            {currentOrder.items.length > 0 && (
              <ul className="mt-4 max-h-48 space-y-2 overflow-y-auto text-sm">
                {currentOrder.items.map((item) => (
                  <li key={item.id} className="rounded-lg bg-gray-50 px-3 py-2">
                    <div className="flex justify-between gap-3">
                      <span className="font-medium text-gray-800">
                        {item.quantity}× {item.productName}
                      </span>
                      <span className="text-xs text-sky-700">
                        {item.kitchenStationName ?? "Kitchen"}
                      </span>
                    </div>
                    {item.note && <p className="mt-1 text-xs italic text-gray-500">{item.note}</p>}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <label className="flex items-center justify-between gap-3 text-sm font-medium text-gray-800">
                <span>พิมพ์อัตโนมัติเมื่อมีออร์เดอร์ใหม่</span>
                <input
                  type="checkbox"
                  checked={autoPrintEnabled}
                  onChange={(event) => setAutoPrintPreference(event.target.checked)}
                />
              </label>
              <p className={`mt-2 text-xs ${printerState.connected ? "text-emerald-700" : "text-amber-700"}`}>
                เครื่องพิมพ์: {printerState.label}
              </p>
              {printStatus && <p className="mt-1 text-xs text-gray-600">{printStatus}</p>}
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="btn-secondary min-h-11 px-4 text-sm"
                onClick={() => setOrders((prev) => prev.slice(1))}
              >
                ปิด
              </button>
              <button
                type="button"
                className="btn-primary min-h-11 px-4 text-sm"
                onClick={() => {
                  setOrders([]);
                  router.push("/qr-orders");
                }}
              >
                ไปหน้ารายการออเดอร์
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
