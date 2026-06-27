import type { ReceiptData } from "./types";

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
  orderNumber: string;
  tableNumber?: string;
  paperWidth: "58mm" | "80mm";
  printedAt: string;
  items: StationRoutingItem[];
  /** Active stations in display order; only those with a printerId can receive a ticket. */
  stations: StationRoutingStation[];
}

export interface StationTicketJob {
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
      printerId: station.printerId,
      stationId: station.id,
      stationName: station.name,
      receipt: toKitchenReceipt(input, station.name, items),
    });
  }

  return { jobs, unroutedItemCount };
}
