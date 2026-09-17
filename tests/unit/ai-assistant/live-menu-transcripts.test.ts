import { describe, expect, it, vi } from "vitest";
import type { Product } from "@/modules/catalog/types";
import {
  buildMenuInstructions,
  buildTranscriptionPrompt,
  describeProductOptions,
} from "@/modules/ai-assistant/menu-context";
import {
  buildLiveTranscriptRows,
  recordLiveTranscriptTurns,
  stringifyForTranscript,
  truncateTranscript,
} from "@/modules/ai-assistant/live-transcripts";
import { parseRealtimeEvent } from "@/modules/ai-assistant/ui/live-webrtc";

// 2026-09-17 — ให้ AI รู้จักเมนูของร้าน + บันทึกบทสนทนาไว้วิเคราะห์

function product(overrides: Partial<Product> & { id: string; name: string }): Product {
  return {
    storeId: "store",
    organizationId: "org",
    categoryId: "cat",
    basePrice: 50,
    isActive: true,
    availableForPos: true,
    availableForQr: true,
    sortOrder: 0,
    variants: [],
    modifierGroups: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
const variant = (id: string, name: string) => ({ id, productId: "p", name, priceAdjustment: 0, trackStock: false, isActive: true, sortOrder: 0 });
const option = (id: string, name: string, isDefault = false, isActive = true) => ({ id, modifierGroupId: "g", name, priceAdjustment: 0, isDefault, isActive, sortOrder: 0 });

const latte = product({
  id: "lt",
  name: "ลาเต้",
  sortOrder: 1,
  variants: [variant("h", "ร้อน"), variant("i", "เย็น")],
  modifierGroups: [
    { id: "g1", productId: "lt", name: "ความหวาน", selectionType: "single", isRequired: true, minSelections: 1, maxSelections: 1, sortOrder: 0, options: [option("o1", "หวานน้อย"), option("o2", "หวาน 100%", true)] },
    { id: "g2", productId: "lt", name: "นม", selectionType: "single", isRequired: true, minSelections: 1, maxSelections: 1, sortOrder: 1, options: [option("o3", "นมโอ๊ต"), option("o4", "นมวัว")] },
  ],
});
const cocoa = product({ id: "cc", name: "โกโก้", sortOrder: 2, outOfStock: true });
const hidden = product({ id: "hd", name: "เมนูลับ", availableForPos: false });

describe("menu context", () => {
  it("บอกกลุ่มบังคับ/ค่าเริ่มต้นตามที่หน้าขายใส่จริง", () => {
    expect(describeProductOptions(latte)).toEqual([
      { group: "ตัวเลือกสินค้า", required: true, multiple: false, options: ["ร้อน", "เย็น"], defaults: [] },
      { group: "ความหวาน", required: true, multiple: false, options: ["หวานน้อย", "หวาน 100%"], defaults: ["หวาน 100%"] },
      { group: "นม", required: true, multiple: false, options: ["นมโอ๊ต", "นมวัว"], defaults: [] },
    ]);
  });

  it("ตัวเลือกที่ปิดใช้งานไม่ถูกบอก model", () => {
    const withInactive = product({
      id: "x",
      name: "ชา",
      modifierGroups: [{ id: "g", productId: "x", name: "ขนาด", selectionType: "single", isRequired: false, minSelections: 0, maxSelections: 1, sortOrder: 0, options: [option("a", "เล็ก"), option("b", "ใหญ่", false, false)] }],
    });
    expect(describeProductOptions(withInactive)[0]?.options).toEqual(["เล็ก"]);
  });

  it("instructions มีทุกเมนูที่ขายได้ บอกของหมด และไม่รวมเมนูที่ไม่ขายหน้าร้าน", () => {
    const text = buildMenuInstructions([cocoa, hidden, latte]);
    expect(text).not.toBeNull();
    expect(text).toContain("- ลาเต้ | ตัวเลือกสินค้า (ต้องเลือก): ร้อน/เย็น | ความหวาน (ต้องเลือก, ค่าเริ่มต้น หวาน 100%): หวานน้อย/หวาน 100%");
    expect(text).toContain("- โกโก้ [ของหมด]");
    expect(text).not.toContain("เมนูลับ");
    expect(text!.indexOf("ลาเต้")).toBeLessThan(text!.indexOf("โกโก้"));
    expect(buildMenuInstructions([hidden])).toBeNull();
  });

  it("ร้านเมนูเยอะ = ตัดตามเพดานแล้วบอกให้ค้นหาเมนูที่ไม่อยู่ในรายการ", () => {
    const many = Array.from({ length: 50 }, (_, index) => product({ id: `p${index}`, name: `เมนูทดสอบลำดับที่ ${index}`, sortOrder: index }));
    const text = buildMenuInstructions(many, 600)!;
    expect(text.length).toBeLessThan(800);
    expect(text).toMatch(/ยังมีอีก \d+ เมนู/);
    expect(text).toContain("pos_search_product");
  });

  it("prompt ตัวถอดเสียงมีชื่อเมนูและตัวเลือกไม่ซ้ำ และไม่เกินเพดาน", () => {
    const prompt = buildTranscriptionPrompt([latte, cocoa])!;
    expect(prompt).toContain("ลาเต้");
    expect(prompt).toContain("หวานน้อย");
    expect(prompt.split("ร้อน").length - 1).toBe(1);
    expect(buildTranscriptionPrompt([latte], 70)!.length).toBeLessThanOrEqual(70);
    expect(buildTranscriptionPrompt([])).toBeNull();
  });
});

describe("live transcripts", () => {
  const identity = { organizationId: "org-1", storeId: "store-1", userId: "user-1", sessionId: "sess-1234" };

  it("แถวมี identity จาก server + วันหมดอายุตาม retention และตัดข้อความว่างทิ้ง", () => {
    const rows = buildLiveTranscriptRows(identity, [
      { role: "user", content: "  ลาเต้เย็น  ", clientSeq: 3, providerItemId: "item_1" },
      { role: "assistant", content: "   " },
    ], { retentionDays: 30, now: Date.parse("2026-09-17T00:00:00Z") });
    expect(rows).toEqual([{
      organization_id: "org-1",
      store_id: "store-1",
      user_id: "user-1",
      session_id: "sess-1234",
      role: "user",
      client_seq: 3,
      content: "ลาเต้เย็น",
      tool: null,
      provider_item_id: "item_1",
      metadata: null,
      expires_at: "2026-10-17T00:00:00.000Z",
    }]);
  });

  it("ข้อความยาวถูกตัด และ JSON ที่ serialize ไม่ได้ไม่ทำให้พัง", () => {
    expect(truncateTranscript("ก".repeat(5000)).length).toBe(4000);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(stringifyForTranscript(circular)).toBe("");
  });

  it("แถวซ้ำ (ส่งซ้ำ) ข้ามได้ไม่ทำให้แถวอื่นหาย / error อื่นโยนให้ผู้เรียกกลืน / กวาดของหมดอายุเป็นครั้งคราว", async () => {
    const inserted: unknown[] = [];
    const lt = vi.fn(async () => ({ error: null }));
    const insert = vi.fn(async (row: { content: string }) => {
      if (row.content === "ซ้ำ") return { error: { code: "23505", message: "duplicate" } };
      inserted.push(row);
      return { error: null };
    });
    const client = { from: vi.fn(() => ({ insert, delete: () => ({ lt }) })) };
    const stored = await recordLiveTranscriptTurns(client as never, identity, [
      { role: "user", content: "ซ้ำ" },
      { role: "assistant", content: "ได้เลยค่ะ" },
    ], { retentionDays: 30, random: () => 0 });
    expect(stored).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(lt).toHaveBeenCalledTimes(1);

    const failing = { from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: { code: "42P01", message: "missing table" } })) })) };
    await expect(recordLiveTranscriptTurns(failing as never, identity, [{ role: "user", content: "x" }], { retentionDays: 30, random: () => 1 }))
      .rejects.toThrow("live transcript insert failed");
  });

  it("แปลง event ถอดเสียงของ GA เป็นสัญญาณ transcript (ว่าง = เมิน)", () => {
    expect(parseRealtimeEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: " ลาเต้เย็น " }))
      .toEqual({ kind: "transcript", role: "user", itemId: "item_1", text: "ลาเต้เย็น" });
    expect(parseRealtimeEvent({ type: "response.output_audio_transcript.done", item_id: "item_2", transcript: "ร้อนหรือเย็นคะ" }))
      .toEqual({ kind: "transcript", role: "assistant", itemId: "item_2", text: "ร้อนหรือเย็นคะ" });
    expect(parseRealtimeEvent({ type: "response.output_audio_transcript.done", transcript: "" })).toBeNull();
    expect(parseRealtimeEvent({ type: "conversation.item.input_audio_transcription.completed" })).toBeNull();
  });
});
