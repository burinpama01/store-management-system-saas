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
  /** dialog ที่ปิดอยู่ถูกตั้ง hidden จึงหลุดจาก a11y tree — ตรวจสถานะจาก DOM ตรง ๆ */
  function sectionDialog(): HTMLElement {
    const node = document.querySelector<HTMLElement>('[aria-label="โต๊ะ ครัว และบิล"]');
    if (!node) throw new Error("ไม่พบ dialog โต๊ะ/ครัว/บิล");
    return node;
  }

  /** เปิด dialog "โต๊ะ / ครัว / บิล" แล้วเลือกส่วนที่ต้องการ */
  function openSection(name: string) {
    fireEvent.click(screen.getByRole("button", { name: /โต๊ะ \/ ครัว \/ บิล/ }));
    fireEvent.click(screen.getByRole("tab", { name }));
  }

  it("หน้าขายแสดงเต็มพื้นที่เสมอ — โต๊ะ/ครัว/บิล อยู่หลังปุ่มเดียว ไม่ใช่แท็บบนแถบหัว", () => {
    render(<UnifiedPosWorkspace {...makeProps()} />);

    // หน้าขายไม่ใช่แท็บอีกต่อไป จึงไม่ต้องกดอะไรก่อนถึงจะขายได้
    expect(screen.getByTestId("legacy-sell-surface")).toBeVisible();
    expect(screen.queryByRole("tab", { name: "ขาย" })).not.toBeInTheDocument();

    // ปุ่มเดียวคุมทั้งสามส่วน และ dialog ยังปิดอยู่ตอนเริ่ม
    const opener = screen.getByRole("button", { name: /โต๊ะ \/ ครัว \/ บิล/ });
    expect(opener).toHaveAttribute("aria-haspopup", "dialog");
    expect(opener).toHaveAttribute("aria-expanded", "false");
    expect(sectionDialog().hidden).toBe(true);
  });

  it("กดปุ่มโต๊ะ → dialog เปิดที่ส่วนโต๊ะ พร้อมทางลัดเปิดโต๊ะ/เช็คบิลโต๊ะ", () => {
    render(<UnifiedPosWorkspace {...makeProps()} />);
    fireEvent.click(screen.getByRole("button", { name: /โต๊ะ \/ ครัว \/ บิล/ }));

    expect(screen.getByRole("dialog", { name: "โต๊ะ ครัว และบิล" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "โต๊ะ" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("โต๊ะ 1")).toBeVisible();
    // งานโต๊ะที่เดิมเป็นปุ่มแยกบนแถบหัว ย้ายมาอยู่ที่เดียวกับผังโต๊ะ
    expect(screen.getByRole("button", { name: /เปิดโต๊ะ/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /เช็คบิลโต๊ะ/ })).toBeVisible();
  });

  it("ทางลัดเปิดโต๊ะ/เช็คบิลโต๊ะ ยิงคำสั่งไป PosTerminal แล้วปิด dialog", () => {
    const commands: string[] = [];
    const listener = (event: Event) => commands.push((event as CustomEvent<string>).detail);
    window.addEventListener("storeos:pos-command", listener);
    try {
      render(<UnifiedPosWorkspace {...makeProps()} />);
      fireEvent.click(screen.getByRole("button", { name: /โต๊ะ \/ ครัว \/ บิล/ }));
      fireEvent.click(screen.getByRole("button", { name: /เปิดโต๊ะ/ }));
      expect(commands).toEqual(["open-table"]);
      expect(sectionDialog().hidden).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: /โต๊ะ \/ ครัว \/ บิล/ }));
      fireEvent.click(screen.getByRole("button", { name: /เช็คบิลโต๊ะ/ }));
      expect(commands).toEqual(["open-table", "settle-table"]);
    } finally {
      window.removeEventListener("storeos:pos-command", listener);
    }
  });

  it("ส่วนครัวเป็นคิวครัวจริง (U10) และส่วนบิลเป็นบิลจริง (U11)", () => {
    render(<UnifiedPosWorkspace {...makeProps()} />);
    openSection("ครัว");
    expect(screen.getByRole("heading", { name: "คิวครัว" })).toBeVisible();
    expect(screen.getByText(/ยังไม่มีรายการในคิวครัว/)).toBeVisible();
    expect(screen.getByText("เรียลไทม์")).toBeVisible();

    openSection("บิล");
    expect(screen.getByRole("heading", { name: "บิลและการพิมพ์" })).toBeVisible();
    expect(screen.getByText(/เลือกโต๊ะจากแท็บโต๊ะเพื่อดูบิล/)).toBeVisible();
  });

  it("ลูกศร/Home/End สลับส่วนใน dialog และโฟกัสตามไปที่ tab trigger", () => {
    render(<UnifiedPosWorkspace {...makeProps()} />);
    fireEvent.click(screen.getByRole("button", { name: /โต๊ะ \/ ครัว \/ บิล/ }));
    const dialog = screen.getByRole("dialog", { name: "โต๊ะ ครัว และบิล" });

    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    const kitchenTab = screen.getByRole("tab", { name: "ครัว" });
    expect(kitchenTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(kitchenTab);

    fireEvent.keyDown(dialog, { key: "End" });
    expect(screen.getByRole("tab", { name: "บิล" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(dialog, { key: "Home" });
    expect(screen.getByRole("tab", { name: "โต๊ะ" })).toHaveAttribute("aria-selected", "true");
  });

  it("Escape ปิด dialog แล้วโฟกัสกลับที่ปุ่มที่เปิดมัน", () => {
    render(<UnifiedPosWorkspace {...makeProps()} />);
    const opener = screen.getByRole("button", { name: /โต๊ะ \/ ครัว \/ บิล/ });
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "โต๊ะ ครัว และบิล" }), { key: "Escape" });

    expect(sectionDialog().hidden).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it("เลือกโต๊ะแล้วบริบทตามไปหน้าขาย และเลขโต๊ะขึ้นบนปุ่ม", () => {
    render(<UnifiedPosWorkspace {...makeProps()} />);
    fireEvent.click(screen.getByRole("button", { name: /โต๊ะ \/ ครัว \/ บิล/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "เลือกโต๊ะ" })[0]);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "โต๊ะ ครัว และบิล" }), { key: "Escape" });

    expect(screen.getByText(/โต๊ะที่เลือก:/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "ล้างโต๊ะที่เลือก" }));
    // ไม่เลือกโต๊ะ = ขายหน้าร้าน ซึ่งเป็นค่าปกติ จึงไม่กินแถวไปบอกว่าไม่มีอะไรพิเศษ
    expect(screen.queryByText(/โต๊ะที่เลือก:/)).not.toBeInTheDocument();
  });

  it("คิวครัวคง mounted แม้ปิด dialog — realtime จึงไม่ขาดช่วง", () => {
    render(<UnifiedPosWorkspace {...makeProps()} />);
    openSection("ครัว");
    expect(screen.getByRole("heading", { name: "คิวครัว" })).toBeVisible();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "โต๊ะ ครัว และบิล" }), { key: "Escape" });
    expect(screen.getByRole("heading", { name: "คิวครัว", hidden: true })).toBeInTheDocument();
  });

  it("dialog รายละเอียดโต๊ะเป็นของส่วนโต๊ะ — ปิด dialog หลักแล้ว state ไม่หาย", () => {
    render(<UnifiedPosWorkspace {...makeProps()} />);
    fireEvent.click(screen.getByRole("button", { name: /โต๊ะ \/ ครัว \/ บิล/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "รายละเอียด" })[0]);
    expect(screen.getByRole("dialog", { name: "รายละเอียดโต๊ะ 1" })).toBeVisible();

    openSection("ครัว");
    expect(screen.getByRole("dialog", { name: "รายละเอียดโต๊ะ 1", hidden: true })).not.toBeVisible();

    openSection("โต๊ะ");
    expect(screen.getByRole("dialog", { name: "รายละเอียดโต๊ะ 1" })).toBeVisible();
  });

  it("typed immutable props guard: deep-freeze props แล้ว render ได้ และ mutate ไม่เปลี่ยนค่า", () => {
    const tables: readonly UnifiedTableSummary[] = Object.freeze([
      Object.freeze({ ...toUnifiedTableSummaries([makeTable()])[0] }),
    ]);
    const props: UnifiedPosWorkspaceProps = deepFreeze(makeProps({ tables }));
    render(<UnifiedPosWorkspace {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /โต๊ะ \/ ครัว \/ บิล/ }));
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
