// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POS_TILE_SIZE_KEY,
  getTileSnapshot,
  nextTileSize,
  parseTileSize,
  subscribeTileSize,
  writeTileSize,
} from "@/modules/pos/tile-size";

describe("POS tile size (เล็ก/กลาง/ใหญ่ ต่อเครื่อง)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("ค่าแปลก/ไม่มีค่า = กลาง", () => {
    expect(parseTileSize(null)).toBe("md");
    expect(parseTileSize("huge")).toBe("md");
    expect(parseTileSize("sm")).toBe("sm");
    expect(parseTileSize("lg")).toBe("lg");
  });

  it("แตะวน เล็ก → กลาง → ใหญ่ → เล็ก", () => {
    expect(nextTileSize("sm")).toBe("md");
    expect(nextTileSize("md")).toBe("lg");
    expect(nextTileSize("lg")).toBe("sm");
  });

  it("เขียนแล้วจำใน localStorage และแจ้ง subscriber", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeTileSize(onChange);
    writeTileSize("lg");
    expect(window.localStorage.getItem(POS_TILE_SIZE_KEY)).toBe("lg");
    expect(getTileSnapshot()).toBe("lg");
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    writeTileSize("sm");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("storage เขียนไม่ได้ (โหมดส่วนตัว) → ยังสลับได้ในหน้านี้", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    writeTileSize("sm");
    expect(getTileSnapshot()).toBe("sm");
    vi.restoreAllMocks();
    writeTileSize("md"); // เขียนได้อีกครั้ง → กลับไปใช้ค่าใน storage
    expect(getTileSnapshot()).toBe("md");
  });
});
