"use client";

// U9 — Unified POS workspace shell (R2)
// แท็บ ขาย/โต๊ะ/ครัว/บิล แชร์ "บริบทที่เลือก" (โต๊ะ/ออร์เดอร์) แต่ state ของแต่ละแท็บ
// (รวมถึง dialog) เป็นของใครของมัน — panel ทุกแท็บคง mounted ไว้ด้วย hidden เพื่อให้
// draft/dialog ไม่หายตอนสลับแท็บ และจัดโฟกัสกลับที่ tab trigger เสมอ

import { useCallback, useRef, useState } from "react";
import { TablesPanel } from "./TablesPanel";
import { KitchenQueuePanel } from "./KitchenQueuePanel";
import { BillsPanel } from "./BillsPanel";
import { VoicePosController } from "./VoicePosController";
import { VoiceCartBridgeProvider } from "./voice-cart-bridge";
import type { UnifiedPosWorkspaceProps, UnifiedTableSummary } from "./types";

type TabId = "sell" | "tables" | "kitchen" | "bills";

const TABS: ReadonlyArray<{ readonly id: TabId; readonly label: string }> = [
  { id: "sell", label: "ขาย" },
  { id: "tables", label: "โต๊ะ" },
  { id: "kitchen", label: "ครัว" },
  { id: "bills", label: "บิล" },
];

const TAB_ORDER: ReadonlyArray<TabId> = TABS.map((t) => t.id);

// storeId ใช้ตั้งแต่ U10 (คิวครัว: realtime scope + server action) — แท็บอื่นจะใช้ต่อใน U11+
export function UnifiedPosWorkspace({
  storeId,
  storeName,
  tables,
  sell,
  kitchenInitialItems,
  voiceEnabled = false,
  voiceCommands = [],
  voiceAliases = [],
  voiceProductAliases = [],
  voiceAdapter,
}: UnifiedPosWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<TabId>("sell");
  /** บริบทร่วมของทุกแท็บ — โต๊ะที่เลือกจากแท็บโต๊ะ (ขยายเป็น order context ใน U10+) */
  const [selectedTable, setSelectedTable] = useState<UnifiedTableSummary | null>(null);
  const triggerRefs = useRef(new Map<TabId, HTMLButtonElement | null>());

  const selectTab = useCallback((id: TabId) => {
    setActiveTab(id);
    // โฟกัสกลับที่ tab trigger เสมอ — click/Enter อยู่แล้ว แต่ปุ่มลูกศร/Home/End ต้องย้ายโฟกัสตาม
    triggerRefs.current.get(id)?.focus();
  }, []);

  const onTablistKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const currentIndex = TAB_ORDER.indexOf(activeTab);
      let nextIndex: number | null = null;
      switch (event.key) {
        case "ArrowRight":
          nextIndex = (currentIndex + 1) % TAB_ORDER.length;
          break;
        case "ArrowLeft":
          nextIndex = (currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = TAB_ORDER.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      selectTab(TAB_ORDER[nextIndex]);
    },
    [activeTab, selectTab],
  );

  const handleSelectTable = useCallback((table: UnifiedTableSummary) => {
    setSelectedTable((current) => (current?.id === table.id ? current : table));
  }, []);

  return (
    <VoiceCartBridgeProvider>
    {/* เต็มจอพอดี: หัวข้อ + แท็บคงที่ ส่วน panel ที่เปิดอยู่กินที่เหลือทั้งหมด
        การเลื่อนเกิดขึ้นภายใน panel เท่านั้น (รายการเมนู/คิว/บิล) ไม่ใช่ทั้งหน้า */}
    <section
      aria-label={`POS รวม — ${storeName}`}
      className="unified-pos-workspace flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-1 pb-2">
        <h1 className="min-w-0 truncate text-sm font-semibold text-gray-700">
          {storeName}
          <span className="ml-2 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800">
            POS รวม
          </span>
        </h1>
        {/* U14 — ปุ่มสั่งงานด้วยเสียง (Tier A): mount เฉพาะเมื่อ stores.voice_command_enabled = true
            (flag ปิด = ไม่ mount เลย จึงไม่มี hook ของ router/speech ทำงานในเส้นทางเดิม) */}
        {voiceEnabled ? (
          <VoicePosController
            voiceEnabled
            allowedCommands={voiceCommands}
            aliases={voiceAliases}
            productAliases={voiceProductAliases}
            onSelectTab={selectTab}
            adapter={voiceAdapter}
          />
        ) : null}
      </header>

      <div
        role="tablist"
        aria-label="ส่วนของ POS รวม"
        onKeyDown={onTablistKeyDown}
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-gray-200"
      >
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                triggerRefs.current.set(tab.id, node);
              }}
              type="button"
              role="tab"
              id={`unified-tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`unified-panel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => selectTab(tab.id)}
              className={`min-h-11 shrink-0 rounded-t-lg px-4 py-2 text-sm font-semibold transition-colors motion-reduce:transition-none ${
                isActive
                  ? "border-b-2 border-orange-500 text-orange-700"
                  : "border-b-2 border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ทุก panel คง mounted — hidden ตัดออกจาก a11y tree/tab order โดย state ไม่หาย */}
      <div
        role="tabpanel"
        id="unified-panel-sell"
        aria-labelledby="unified-tab-sell"
        hidden={activeTab !== "sell"}
        tabIndex={-1}
        data-voice-focus="cart"
        className={`min-w-0 flex-1 flex-col overflow-hidden pt-3 ${activeTab === "sell" ? "flex" : "hidden"}`}
      >
        <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm text-gray-700 ring-1 ring-gray-200">
          <span className="font-medium">บริบท:</span>
          {selectedTable ? (
            <>
              <span>
                โต๊ะที่เลือก: <strong>{selectedTable.number}</strong>
                {selectedTable.label ? ` (${selectedTable.label})` : ""}
              </span>
              <button
                type="button"
                onClick={() => setSelectedTable(null)}
                className="min-h-8 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 transition-colors motion-reduce:transition-none"
              >
                ล้างโต๊ะที่เลือก
              </button>
            </>
          ) : (
            <span className="text-gray-500">ยังไม่เลือกโต๊ะ — ขายหน้าร้าน/เลือกได้ที่แท็บโต๊ะ</span>
          )}
        </div>
        {/* min-h-0 จำเป็นกับ flex child ทุกชั้น ไม่งั้นลูกที่ scroll ได้จะดันความสูงจนล้นจอ */}
        <div className="min-h-0 flex-1">{sell}</div>
      </div>

      <div
        role="tabpanel"
        id="unified-panel-tables"
        aria-labelledby="unified-tab-tables"
        hidden={activeTab !== "tables"}
        className={`min-w-0 flex-1 overflow-y-auto pt-3 ${activeTab === "tables" ? "block" : "hidden"}`}
      >
        <TablesPanel
          tables={tables}
          selectedTableId={selectedTable?.id ?? null}
          onSelectTable={handleSelectTable}
        />
      </div>

      <div
        role="tabpanel"
        id="unified-panel-kitchen"
        aria-labelledby="unified-tab-kitchen"
        hidden={activeTab !== "kitchen"}
        className={`min-w-0 flex-1 overflow-y-auto pt-3 ${activeTab === "kitchen" ? "block" : "hidden"}`}
      >
        {/* U10 — คิวครัวจริง: state ของแท็บนี้อยู่ใน KitchenQueuePanel (คง mounted ตามกติกา shell) */}
        <KitchenQueuePanel storeId={storeId} initialItems={kitchenInitialItems} />
      </div>

      <div
        role="tabpanel"
        id="unified-panel-bills"
        aria-labelledby="unified-tab-bills"
        hidden={activeTab !== "bills"}
        className={`min-w-0 flex-1 overflow-y-auto pt-3 ${activeTab === "bills" ? "block" : "hidden"}`}
      >
        {/* U11 — แท็บบิลจริง: บิลจาก server + settlement→print intent (replay-safe) */}
        <BillsPanel selectedTable={selectedTable} />
      </div>
    </section>
    </VoiceCartBridgeProvider>
  );
}
