// @vitest-environment jsdom
// U9 — unified POS shell: server gate + workspace tabs (ทำงานบน jsdom ตาม pattern U0.5)
// ⚠️ ต้องมี header jsdom ทุกครั้ง — static-import @testing-library/* บน node env คือ hang จน timeout
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../setup/react";
import type { Table } from "@/modules/stores/types";
import {
  resolveUnifiedPosSurface,
  toUnifiedTableSummaries,
  type UnifiedPosWorkspaceProps,
  type UnifiedTableSummary,
} from "@/app/pos/unified/types";
import { UnifiedPosWorkspace } from "@/app/pos/unified/UnifiedPosWorkspace";

// U10 — แท็บครัวเป็น KitchenQueuePanel จริง (มี realtime wiring) — stub browser client
// เพื่อไม่ให้ unit test สร้าง supabase client จริง (env ไม่มีใน jsdom)
vi.mock("@/server/integrations/supabase/client", () => ({
  getSupabaseBrowserClient: () => {
    // channel stub แบบ chain — subscribe ขึ้น SUBSCRIBED ทันที (unit test ไม่ทดสอบ realtime จริง)
    const makeChannel = (): {
      on: () => typeof channel;
      subscribe: (callback: (status: string) => void) => { unsubscribe: () => void };
    } => {
      const channel = {
        on: () => channel,
        subscribe: (callback: (status: string) => void) => {
          callback("SUBSCRIBED");
          return { unsubscribe: () => {} };
        },
      };
      return channel;
    };
    return {
      channel: () => makeChannel(),
      removeChannel: async () => ({}),
    };
  },
}));

// U11 — แท็บบิลเป็น BillsPanel จริง (server actions) — mock actions กัน import โมดูล
// server (auth/session/supabase service) เข้ามาใน jsdom; พฤติกรรมแท็บบิลทดสอบเต็มใน
// unified-pos-bill.test.tsx
vi.mock("@/app/pos/unified/actions", () => ({
  fetchKitchenQueueAction: vi.fn(),
  advanceKitchenItemAction: vi.fn(),
  fetchUnifiedPosTableBillAction: vi.fn().mockResolvedValue({ bill: null, error: null }),
  settleUnifiedPosBillAction: vi.fn(),
  reprintUnifiedPosReceiptAction: vi.fn(),
}));

function makeTable(overrides: Partial<Table> = {}): Table {
  return {
    id: "eeeeeeee-0000-0000-0000-000000000001",
    storeId: "cccccccc-0000-0000-0000-000000000001",
    organizationId: "aaaaaaaa-0000-0000-0000-000000000001",
    number: "1",
    label: "Window seat",
    seats: 4,
    isActive: true,
    qrEnabled: false,
    status: "available",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProps(overrides: Partial<UnifiedPosWorkspaceProps> = {}): UnifiedPosWorkspaceProps {
  return {
    storeId: "cccccccc-0000-0000-0000-000000000001",
    storeName: "Main Branch",
    tables: toUnifiedTableSummaries([
      makeTable(),
      makeTable({ id: "eeeeeeee-0000-0000-0000-000000000002", number: "2", label: "Center", status: "occupied" }),
    ]),
    sell: <div data-testid="legacy-sell-surface">legacy sell surface (stub)</div>,
    kitchenInitialItems: [],
    ...overrides,
  };
}

/** deep-freeze ตาม pattern ของ unified-pos-contracts.test.ts (Object.freeze + mutate guard) */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function activateTab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("resolveUnifiedPosSurface (server gate ของ /pos)", () => {
  it("flag false / ไม่มี store row / flag ขาด → legacy เสมอ (fail closed ไปพฤติกรรมเดิม)", () => {
    expect(resolveUnifiedPosSurface({ unifiedPosEnabled: false })).toBe("legacy");
    expect(resolveUnifiedPosSurface(null)).toBe("legacy");
    expect(resolveUnifiedPosSurface(undefined)).toBe("legacy");
    expect(resolveUnifiedPosSurface({})).toBe("legacy");
  });

  it("flag true → unified", () => {
    expect(resolveUnifiedPosSurface({ unifiedPosEnabled: true })).toBe("unified");
  });
});

describe("toUnifiedTableSummaries", () => {
  it("map Table → summary แบบตัด field ที่ U9 ไม่ใช้ และรับ readonly array ได้", () => {
    const tables: readonly Table[] = [makeTable()];
    const summaries = toUnifiedTableSummaries(tables);
    expect(summaries).toEqual([
      {
        id: "eeeeeeee-0000-0000-0000-000000000001",
        number: "1",
        label: "Window seat",
        seats: 4,
        status: "available",
        sessionStartedAt: undefined,
      },
    ]);
  });
});

describe("UnifiedPosWorkspace (flag true surface)", () => {
  it("render shell ครบ 4 แท็บ ขาย/โต๊ะ/ครัว/บิล พร้อม aria wiring ของ tab/tabpanel", () => {
    render(<UnifiedPosWorkspace {...makeProps()} />);
    const tablist = screen.getByRole("tablist", { name: "ส่วนของ POS รวม" });
    expect(tablist).toBeInTheDocument();
    for (const label of ["ขาย", "โต๊ะ", "ครัว", "บิล"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
    for (const panelId of ["unified-panel-sell", "unified-panel-tables", "unified-panel-kitchen", "unified-panel-bills"]) {
      const panel = document.getElementById(panelId);
      expect(panel).not.toBeNull();
      expect(panel).toHaveAttribute("role", "tabpanel");
    }
    // แท็บขายถูกเลือกเป็นค่าเริ่มต้น และแสดง sell surface ที่ server compose ให้
    expect(screen.getByRole("tab", { name: "ขาย" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("legacy-sell-surface")).toBeVisible();
  });

  it("แท็บครัวเป็นคิวครัวจริง (U10) — หัวข้อ + สถานะการเชื่อมต่อ และคิวว่างมี empty state / แท็บบิลเป็นบิลจริง (U11 — ยังไม่เลือกโต๊ะ)", () => {
    render(<UnifiedPosWorkspace {...makeProps()} />);
    activateTab("ครัว");
    expect(screen.getByRole("heading", { name: "คิวครัว" })).toBeVisible();
    expect(screen.getByText(/ยังไม่มีรายการในคิวครัว/)).toBeVisible();
    expect(screen.getByText("เรียลไทม์")).toBeVisible();

    activateTab("บิล");
    expect(screen.getByRole("heading", { name: "บิลและการพิมพ์" })).toBeVisible();
    // U11 — empty state เมื่อยังไม่เลือกโต๊ะ (บิลแสดงจาก server เมื่อเลือกโต๊ะแล้ว)
    expect(screen.getByText(/เลือกโต๊ะจากแท็บโต๊ะเพื่อดูบิล/)).toBeVisible();
  });

  it("สลับแท็บแล้วโฟกัสกลับที่ tab trigger (ArrowRight/Home/End) และ panel แสดงตามแท็บ", () => {
    render(<UnifiedPosWorkspace {...makeProps()} />);
    const sellTab = screen.getByRole("tab", { name: "ขาย" });
    sellTab.focus();
    const tablist = screen.getByRole("tablist", { name: "ส่วนของ POS รวม" });

    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    const tablesTab = screen.getByRole("tab", { name: "โต๊ะ" });
    expect(tablesTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tablesTab);
    expect(screen.getByRole("tabpanel", { name: "โต๊ะ" })).toBeVisible();
    expect(screen.getByTestId("legacy-sell-surface")).not.toBeVisible();

    fireEvent.keyDown(tablist, { key: "End" });
    expect(screen.getByRole("tab", { name: "บิล" })).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "บิล" }));

    fireEvent.keyDown(tablist, { key: "Home" });
    expect(document.activeElement).toBe(sellTab);
  });

  it("บริบทโต๊ะแชร์ข้ามแท็บ: เลือกโต๊ะที่แท็บโต๊ะ → ชิปในแท็บขายตามทันที และล้างได้", () => {
    render(<UnifiedPosWorkspace {...makeProps()} />);
    activateTab("โต๊ะ");
    expect(screen.getByText("โต๊ะ 1")).toBeVisible();
    expect(screen.getByText("โต๊ะ 2")).toBeVisible();

    fireEvent.click(screen.getAllByRole("button", { name: "เลือกโต๊ะ" })[0]);
    activateTab("ขาย");
    expect(screen.getByText(/โต๊ะที่เลือก:/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "ล้างโต๊ะที่เลือก" }));
    expect(screen.getByText("ยังไม่เลือกโต๊ะ — ขายหน้าร้าน/เลือกได้ที่แท็บโต๊ะ")).toBeVisible();
  });

  it("dialog เป็นของแท็บโต๊ะเท่านั้น (isolated per tab) — สลับแท็บไม่หายและไม่ปนไปแท็บอื่น", () => {
    render(<UnifiedPosWorkspace {...makeProps()} />);
    activateTab("โต๊ะ");
    fireEvent.click(screen.getAllByRole("button", { name: "รายละเอียด" })[0]);
    const dialog = screen.getByRole("dialog", { name: "รายละเอียดโต๊ะ 1" });
    expect(dialog).toBeVisible();

    // สลับไปแท็บขาย — dialog อยู่ใน panel ที่ถูก hidden จึงไม่แสดงแต่ state คงอยู่
    activateTab("ขาย");
    expect(screen.getByRole("dialog", { name: "รายละเอียดโต๊ะ 1", hidden: true })).not.toBeVisible();

    // กลับมาแท็บโต๊ะ — dialog ยังเปิดเหมือนเดิม และปิดได้ด้วย Escape
    activateTab("โต๊ะ");
    expect(screen.getByRole("dialog", { name: "รายละเอียดโต๊ะ 1" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "รายละเอียดโต๊ะ 1", hidden: true })).not.toBeInTheDocument();
  });

  it("typed immutable props guard: deep-freeze props แล้ว render ได้ และ mutate ไม่เปลี่ยนค่า", () => {
    const tables: readonly UnifiedTableSummary[] = Object.freeze([
      Object.freeze({ ...toUnifiedTableSummaries([makeTable()])[0] }),
    ]);
    const props: UnifiedPosWorkspaceProps = deepFreeze(makeProps({ tables }));
    render(<UnifiedPosWorkspace {...props} />);
    activateTab("โต๊ะ");
    expect(screen.getByText("โต๊ะ 1")).toBeVisible();

    const summary = tables[0] as unknown as { number: string };
    try {
      summary.number = "999";
    } catch {
      // runtime ที่ strict อาจโยน TypeError — เป้าหมายคือค่าไม่เปลี่ยน
    }
    expect(summary.number).toBe("1");
  });
});
