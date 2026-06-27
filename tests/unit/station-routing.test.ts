import { describe, it, expect } from "vitest";
import { buildStationTicketJobs, type StationRoutingInput } from "@/modules/printing/station-routing";

const baseInput: Omit<StationRoutingInput, "items" | "stations"> = {
  orderNumber: "260626-0001",
  tableNumber: "5",
  paperWidth: "80mm",
  printedAt: "2026-06-26T10:00:00.000Z",
};

const stations = [
  { id: "bar", name: "บาร์น้ำ", printerId: "printer-bar" },
  { id: "hot", name: "ครัวร้อน", printerId: "printer-hot" },
  { id: "cold", name: "ครัวเย็น" }, // no printer bound
];

describe("buildStationTicketJobs", () => {
  it("routes each station's items to that station's printer", () => {
    const { jobs } = buildStationTicketJobs({
      ...baseInput,
      stations,
      items: [
        { name: "ชาเย็น", modifierNames: [], quantity: 2, kitchenStationId: "bar" },
        { name: "ผัดกะเพรา", modifierNames: ["เผ็ดมาก"], quantity: 1, note: "ไข่ดาว", kitchenStationId: "hot" },
        { name: "โค้ก", modifierNames: [], quantity: 3, kitchenStationId: "bar" },
      ],
    });

    expect(jobs).toHaveLength(2);
    const bar = jobs.find((j) => j.stationId === "bar")!;
    expect(bar.printerId).toBe("printer-bar");
    expect(bar.receipt.ticketMode).toBe("kitchen");
    expect(bar.receipt.stationName).toBe("บาร์น้ำ");
    expect(bar.receipt.items.map((i) => i.name)).toEqual(["ชาเย็น", "โค้ก"]);
    // No prices on kitchen tickets.
    expect(bar.receipt.items.every((i) => i.totalPrice === 0 && i.unitPrice === 0)).toBe(true);

    const hot = jobs.find((j) => j.stationId === "hot")!;
    expect(hot.printerId).toBe("printer-hot");
    expect(hot.receipt.items[0]?.modifierNames).toEqual(["เผ็ดมาก"]);
    expect(hot.receipt.items[0]?.note).toBe("ไข่ดาว");
  });

  it("preserves the station ordering passed in", () => {
    const { jobs } = buildStationTicketJobs({
      ...baseInput,
      stations,
      items: [
        { name: "ผัดกะเพรา", modifierNames: [], quantity: 1, kitchenStationId: "hot" },
        { name: "ชาเย็น", modifierNames: [], quantity: 1, kitchenStationId: "bar" },
      ],
    });
    expect(jobs.map((j) => j.stationId)).toEqual(["bar", "hot"]);
  });

  it("counts items with no station or an unbound station as unrouted", () => {
    const { jobs, unroutedItemCount } = buildStationTicketJobs({
      ...baseInput,
      stations,
      items: [
        { name: "น้ำเปล่า", modifierNames: [], quantity: 2 }, // no station
        { name: "สลัด", modifierNames: [], quantity: 1, kitchenStationId: "cold" }, // station w/o printer
        { name: "ชาเย็น", modifierNames: [], quantity: 4, kitchenStationId: "bar" },
      ],
    });

    expect(unroutedItemCount).toBe(3); // 2 water + 1 salad
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.stationId).toBe("bar");
  });

  it("returns no jobs when nothing can be routed", () => {
    const { jobs, unroutedItemCount } = buildStationTicketJobs({
      ...baseInput,
      stations,
      items: [{ name: "น้ำเปล่า", modifierNames: [], quantity: 1 }],
    });
    expect(jobs).toHaveLength(0);
    expect(unroutedItemCount).toBe(1);
  });
});
