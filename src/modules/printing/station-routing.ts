import type { ReceiptData } from "./types";

export const STATION_TICKET_SOURCE_PREFIX = "station_ticket:";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STATION_TICKET_SOURCE_RE = new RegExp(`^station_ticket:(${UUID_PATTERN}):(${UUID_PATTERN})$`, "i");

/**
 * คีย์ของตั๋วสถานี 1 ใบ = (ออเดอร์รอบนั้น, สถานี) — ทุกจอ/ทุกช่องทางที่สั่งพิมพ์ตั๋วเดียวกัน
 * ได้คีย์เดียวกัน → print_jobs_source_key_uq ทำให้ออกครั้งเดียว
 */
export function buildStationTicketSourceKey(orderId: string, stationId: string): string {
  return `${STATION_TICKET_SOURCE_PREFIX}${orderId.toLowerCase()}:${stationId.toLowerCase()}`;
}

export function parseStationTicketSourceKey(key: unknown): { orderId: string; stationId: string } | null {
  if (typeof key !== "string") return null;
  const match = STATION_TICKET_SOURCE_RE.exec(key);
  if (!match) return null;
  return { orderId: match[1].toLowerCase(), stationId: match[2].toLowerCase() };
}

/** One order line as far as station routing cares (no pricing needed). */
export interface StationRoutingItem {
  name: string;
  variantName?: string;
  modifierNames: string[];
  quantity: number;
  note?: string;
  kitchenStationId?: string;
}

/** A kitchen/bar station and the printer its tickets should go to. */
export interface StationRoutingStation {
  id: string;
  name: string;
  printerId?: string;
}

export interface StationRoutingInput {
  /** orders.id ของรอบนี้ — ใส่แล้วตั๋วจะมี sourceKey กันพิมพ์ซ้ำข้ามจอ */
  orderId?: string;
  orderNumber: string;
  tableNumber?: string;
  paperWidth: "58mm" | "80mm";
  printedAt: string;
  items: StationRoutingItem[];
  /** Active stations in display order; only those with a printerId can receive a ticket. */
  stations: StationRoutingStation[];
}

export interface StationTicketJob {
  /** station_ticket:{orderId}:{stationId} — server dedupe ด้วย print_jobs.source_key */
  sourceKey?: string;
  printerId: string;
  stationId: string;
  stationName: string;
  receipt: ReceiptData;
}

export interface StationRoutingResult {
  jobs: StationTicketJob[];
  /** Quantity of items that could not be routed (no station, or station without a printer). */
  unroutedItemCount: number;
}

function toKitchenReceipt(
  input: StationRoutingInput,
  stationName: string,
  items: StationRoutingItem[],
): ReceiptData {
  return {
    storeName: stationName,
    showTaxId: false,
    orderNumber: input.orderNumber,
    tableNumber: input.tableNumber,
    items: items.map((item) => ({
      name: item.name,
      variantName: item.variantName,
      modifierNames: item.modifierNames,
      quantity: item.quantity,
      unitPrice: 0,
      totalPrice: 0,
      note: item.note,
    })),
    subtotal: 0,
    discount: 0,
    total: 0,
    payments: [],
    showQrPayment: false,
    paperWidth: input.paperWidth,
    printCopies: 1,
    printedAt: input.printedAt,
    ticketMode: "kitchen",
    stationName,
  };
}

/**
 * Splits an order into per-station kitchen tickets, each targeted at the
 * printer bound to that station. Items whose station has no printer (or no
 * station at all) are reported as `unroutedItemCount` so the caller can warn
 * or fall back to the cashier printer.
 *
 * Pure and deterministic: station order follows the `stations` array.
 */
export function buildStationTicketJobs(input: StationRoutingInput): StationRoutingResult {
  const stationById = new Map(input.stations.map((station) => [station.id, station]));
  const itemsByStation = new Map<string, StationRoutingItem[]>();
  let unroutedItemCount = 0;

  for (const item of input.items) {
    const station = item.kitchenStationId ? stationById.get(item.kitchenStationId) : undefined;
    if (!station || !station.printerId) {
      unroutedItemCount += item.quantity;
      continue;
    }
    const bucket = itemsByStation.get(station.id);
    if (bucket) bucket.push(item);
    else itemsByStation.set(station.id, [item]);
  }

  const jobs: StationTicketJob[] = [];
  // Preserve the caller's station ordering (already sorted by sort_order).
  for (const station of input.stations) {
    const items = itemsByStation.get(station.id);
    if (!items || items.length === 0 || !station.printerId) continue;
    jobs.push({
      sourceKey: input.orderId ? buildStationTicketSourceKey(input.orderId, station.id) : undefined,
      printerId: station.printerId,
      stationId: station.id,
      stationName: station.name,
      receipt: toKitchenReceipt(input, station.name, items),
    });
  }

  return { jobs, unroutedItemCount };
}
