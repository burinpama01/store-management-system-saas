import { describe, expect, it, vi } from "vitest";
import { loadAllRows } from "@/modules/reports/pagination";

describe("loadAllRows", () => {
  it("อ่านต่อทุกหน้าจนพบหน้าสุดท้ายที่สั้นกว่า page size", async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [1, 2], error: null })
      .mockResolvedValueOnce({ data: [3, 4], error: null })
      .mockResolvedValueOnce({ data: [5], error: null });

    await expect(loadAllRows(loadPage, 2)).resolves.toEqual([1, 2, 3, 4, 5]);
    expect(loadPage).toHaveBeenNthCalledWith(1, 0, 1);
    expect(loadPage).toHaveBeenNthCalledWith(2, 2, 3);
    expect(loadPage).toHaveBeenNthCalledWith(3, 4, 5);
  });

  it("โยน error ทันทีโดยไม่คืนรายงานบางส่วน", async () => {
    const failure = new Error("page unavailable");
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [1, 2], error: null })
      .mockResolvedValueOnce({ data: null, error: failure });

    await expect(loadAllRows(loadPage, 2)).rejects.toBe(failure);
  });
});
