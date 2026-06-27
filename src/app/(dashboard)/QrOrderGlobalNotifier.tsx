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
import { printReceiptAuto } from "@/modules/printing/print-router";
import { buildStationTicketJobs } from "@/modules/printing/station-routing";
import { enqueueStationTickets } from "@/modules/printing/station-print-client";
import type { EscPosReceiptInput } from "@/modules/printing/escpos";
import type { ReceiptData } from "@/modules/printing/types";
import type { Database, Json } from "@/server/integrations/supabase/database.types";

const AUTO_PRINT_KEY = "qrOrderAutoPrintEnabled";

type OrderInsertPayload = Pick<
  Database["public"]["Tables"]["orders"]["Row"],
  "id" | "order_number" | "qr_order_source" | "table_number" | "total" | "created_at"
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

function playOrderSound() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.12;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => ctx.close();
  } catch {
    /* browser audio can be blocked before user interaction */
  }
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

async function printQrKitchenOrder(storeName: string, order: IncomingQrOrder) {
  if (!isBluetoothPrinterConnected() && !isUsbPrinterConnected()) {
    throw new Error("Printer is not connected");
  }
  const receipt = toReceiptData(storeName, order);
  await printReceiptAuto(receipt, receipt);
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

  useEffect(() => {
    if (!qrOrderingEnabled || !canManageQr) return;
    const client = getSupabaseBrowserClient();
    const unsubscribe = managedRealtimeSubscription<OrderInsertPayload>({
      client,
      table: "orders",
      filter: `store_id=eq.${storeId}`,
      onEvent: (payload) => {
        if (payload.eventType !== "INSERT" || !payload.new?.qr_order_source) return;
        const order = payload.new;
        if (seenOrderIds.current.has(order.id)) return;
        seenOrderIds.current.add(order.id);
        void fetchVisibleOrder(order).then(async (visibleOrder) => {
          if (!visibleOrder) return;
          playOrderSound();
          setOrders((prev) => [...prev, visibleOrder]);

          // Multi-printer routing: split the order into per-station tickets and
          // enqueue each to its station's network printer via the Print Hub.
          // Only the all-station (manager) view drives this to avoid each staff
          // client double-enqueuing the same order.
          if (autoPrintStationTickets && canViewEveryKitchenStation && stationPrinters.some((s) => s.printerId)) {
            const { jobs } = buildStationTicketJobs({
              orderNumber: visibleOrder.orderNumber,
              tableNumber: visibleOrder.tableNumber,
              paperWidth: receiptPaperWidth,
              printedAt: visibleOrder.createdAt,
              items: visibleOrder.items.map((item) => ({
                name: item.productName,
                variantName: item.variantName,
                modifierNames: item.modifierNames,
                quantity: item.quantity,
                note: item.note,
                kitchenStationId: item.kitchenStationId,
              })),
              stations: stationPrinters,
            });
            if (jobs.length > 0) {
              setPrintStatus(`กำลังพิมพ์ตั๋ว ${jobs.length} สถานี`);
              void enqueueStationTickets(jobs).then((res) => {
                setPrintStatus(
                  res.failed.length === 0
                    ? `พิมพ์ตั๋วครัว ${res.printed} สถานีแล้ว`
                    : `พิมพ์ตั๋ว ${res.printed} สำเร็จ, ล้มเหลว ${res.failed.length}`,
                );
              });
            }
          }

          if (!readAutoPrintPreference()) return;
          const latestPrinterState = getPrinterState();
          setPrinterState(latestPrinterState);
          if (!latestPrinterState.connected) {
            setPrintStatus("เปิดพิมพ์อัตโนมัติอยู่ แต่เครื่องพิมพ์ยังไม่เชื่อมต่อ");
            return;
          }
          try {
            setPrintStatus("กำลังสั่งพิมพ์ออร์เดอร์ QR");
            await printQrKitchenOrder(storeName, visibleOrder);
            setPrintStatus("สั่งพิมพ์ออร์เดอร์ QR แล้ว");
          } catch (error) {
            setPrintStatus(error instanceof Error ? error.message : "สั่งพิมพ์ไม่สำเร็จ");
          }
        });
      },
    });
    return unsubscribe;
  }, [
    allowedStationIds,
    autoPrintStationTickets,
    canManageQr,
    canViewEveryKitchenStation,
    fetchVisibleOrder,
    qrOrderingEnabled,
    receiptPaperWidth,
    stationPrinters,
    storeId,
    storeName,
  ]);

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
