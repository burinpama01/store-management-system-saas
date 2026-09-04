"use client";

// U9 — Unified POS workspace shell (R2)
//
// หน้า /pos คือ "หน้าขาย" อยู่แล้ว การมีแท็บ ขาย/โต๊ะ/ครัว/บิล อยู่บนแถบหัวตลอดเวลา
// จึงกินความสูงไปกับสิ่งที่แคชเชียร์ไม่ได้แตะทุกบิล — หน้าขายแสดงเต็มพื้นที่เสมอ
// ส่วนโต๊ะ/ครัว/บิลยุบไปอยู่หลังปุ่ม "โต๊ะ" ปุ่มเดียว กดแล้วเปิดเป็น dialog
//
// panel ทั้งสามยังคง mounted ตลอดแม้ dialog ปิดอยู่ (ซ่อนด้วย hidden) เพราะ
// KitchenQueuePanel ถือ subscription realtime และ BillsPanel ถือผลที่โหลดมาแล้ว
// ถ้า unmount ทุกครั้งที่ปิด dialog คิวครัวจะขาดช่วงและต้องโหลดใหม่ทุกครั้ง

import { useCallback, useEffect, useRef, useState } from "react";
import { TablesPanel } from "./TablesPanel";
import { KitchenQueuePanel } from "./KitchenQueuePanel";
import { BillsPanel } from "./BillsPanel";
import { VoicePosController } from "./VoicePosController";
import { VoiceCartBridgeProvider } from "./voice-cart-bridge";
import { PrintQueueAlert } from "@/modules/printing/PrintQueueAlert";
import { POS_TOPBAR_ACTIONS_ID } from "@/modules/pos/topbar-slot";
import { emitPosCommand } from "@/modules/pos/section-bus";
import type { UnifiedPosWorkspaceProps, UnifiedTableSummary } from "./types";

/** ยังรับชื่อแท็บชุดเดิมจากคำสั่งเสียง — "sell" = ปิด dialog กลับหน้าขาย */
type TabId = "sell" | "tables" | "kitchen" | "bills";

/** ส่วนที่อยู่ใน dialog หลังปุ่มโต๊ะ */
type SectionId = "tables" | "kitchen" | "bills";

const SECTIONS: ReadonlyArray<{ readonly id: SectionId; readonly label: string }> = [
  { id: "tables", label: "โต๊ะ" },
  { id: "kitchen", label: "ครัว" },
  { id: "bills", label: "บิล" },
];

const SECTION_ORDER: ReadonlyArray<SectionId> = SECTIONS.map((s) => s.id);

// storeId ใช้ตั้งแต่ U10 (คิวครัว: realtime scope + server action)
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
  /** null = ปิด dialog (เห็นหน้าขายเต็มจอ) */
  const [openSection, setOpenSection] = useState<SectionId | null>(null);
  /** บริบทร่วม — โต๊ะที่เลือกจากส่วนโต๊ะ ใช้ต่อในบิล/หน้าขาย */
  const [selectedTable, setSelectedTable] = useState<UnifiedTableSummary | null>(null);
  const triggerRefs = useRef(new Map<SectionId, HTMLButtonElement | null>());
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const selectSection = useCallback((id: SectionId) => {
    setOpenSection(id);
    triggerRefs.current.get(id)?.focus();
  }, []);

  /** คำสั่งเสียงยังพูดชื่อแท็บเดิมได้ — "ขาย" = ปิด dialog */
  const selectTab = useCallback((id: TabId) => {
    if (id === "sell") {
      setOpenSection(null);
      return;
    }
    setOpenSection(id);
  }, []);

  const closeSection = useCallback(() => {
    setOpenSection(null);
    openerRef.current?.focus();
  }, []);

  // Escape ปิด dialog ได้จากทุกที่ในนั้น + ลูกศรสลับส่วนแบบเดียวกับแท็บเดิม
  const onDialogKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeSection();
        return;
      }
      if (!openSection) return;
      const currentIndex = SECTION_ORDER.indexOf(openSection);
      let nextIndex: number | null = null;
      switch (event.key) {
        case "ArrowRight":
          nextIndex = (currentIndex + 1) % SECTION_ORDER.length;
          break;
        case "ArrowLeft":
          nextIndex = (currentIndex - 1 + SECTION_ORDER.length) % SECTION_ORDER.length;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = SECTION_ORDER.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      selectSection(SECTION_ORDER[nextIndex]);
    },
    [closeSection, openSection, selectSection],
  );

  // เปิด dialog แล้วโฟกัสไปที่ปุ่มส่วนที่เลือก (คำสั่งเสียงก็เปิดทางนี้)
  useEffect(() => {
    if (!openSection) return;
    const frame = requestAnimationFrame(() => triggerRefs.current.get(openSection)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [openSection]);

  const handleSelectTable = useCallback((table: UnifiedTableSummary) => {
    setSelectedTable((current) => (current?.id === table.id ? current : table));
  }, []);

  return (
    <VoiceCartBridgeProvider>
      {/* เต็มจอพอดี: แถบหัวคงที่ ส่วนหน้าขายกินที่เหลือทั้งหมด
          การเลื่อนเกิดขึ้นภายในหน้าขายเท่านั้น (รายการเมนู/ออร์เดอร์) ไม่ใช่ทั้งหน้า */}
      <section
        aria-label={`POS — ${storeName}`}
        className="unified-pos-workspace flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      >
        {/* ชื่อร้านไม่โชว์ซ้ำบนจอ — หน้า POS ไม่ต้องย้ำว่าอยู่ร้านไหนทุกวินาที
            แต่ยังต้องมีหัวข้อให้ screen reader รู้ว่ากำลังอยู่ที่ไหน */}
        <h1 className="sr-only">{storeName} — POS</h1>

        {/* งานพิมพ์ที่ระบบไม่รู้ผลต้องเห็นตรงที่คนยืนอยู่หน้าเครื่องพิมพ์ ไม่ใช่แค่หน้าตั้งค่า
            เป็นการ์ดลอย (fixed) จึงไม่กินความสูงของหน้าขายที่ต้องพอดีจอ */}
        <PrintQueueAlert />

        {/* มือถือ: ปุ่มเสียง (ตัวใหญ่กดง่าย) + ปุ่มโต๊ะ อยู่แถวบน ปุ่มที่เหลือได้บรรทัด
            เต็มของตัวเอง — ถ้าอัดแถวเดียวช่องที่เหลือจะแคบราว 40px จนกดไม่ได้จริง
            เดสก์ท็อปมีที่พอ จึงรวมเป็นแถวเดียว */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 px-2 py-1 sm:flex-nowrap">
          {/* U14 — ปุ่มสั่งงานด้วยเสียง: mount เฉพาะเมื่อ stores.voice_command_enabled = true
              (flag ปิด = ไม่ mount เลย จึงไม่มี hook ของ router/speech ทำงานในเส้นทางเดิม)
              อยู่หัวแถวแทนที่โลโก้+ชื่อร้านเดิม และบนมือถือทำให้ใหญ่กดง่าย */}
          {voiceEnabled ? (
            <VoicePosController
              className="shrink-0"
              voiceEnabled
              allowedCommands={voiceCommands}
              aliases={voiceAliases}
              productAliases={voiceProductAliases}
              onSelectTab={selectTab}
              adapter={voiceAdapter}
            />
          ) : null}

          {/* ปุ่มเดียวคุมทุกอย่างที่ไม่ใช่การขาย: ผังโต๊ะ / คิวครัว / บิล */}
          <button
            ref={openerRef}
            type="button"
            onClick={() => selectSection("tables")}
            aria-haspopup="dialog"
            aria-expanded={openSection !== null}
            className="min-h-11 shrink-0 rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 motion-reduce:transition-none"
          >
            🍽️ <span className="hidden sm:inline">โต๊ะ / ครัว / บิล</span>
            <span className="sm:hidden">โต๊ะ</span>
            {selectedTable ? (
              <span className="ml-1 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-bold text-orange-800">
                {selectedTable.number}
              </span>
            ) : null}
          </button>

          {/* ที่วางปุ่มของหน้าขาย — PosTerminal ยิงปุ่มมาลงที่นี่ด้วย portal
              ทำให้แถบหัวเหลือแถวเดียวแทนที่จะเป็นสองแถวซ้อนกัน */}
          <div
            id={POS_TOPBAR_ACTIONS_ID}
            /* justify-end + overflow-x-auto จะดันส่วนที่ล้นไปทางซ้ายซึ่งเลื่อนไปหาไม่ได้
               จึงชิดขวาเฉพาะจอที่กว้างพอ (ไม่ล้น) ส่วนจอเล็กเรียงจากซ้ายแล้วเลื่อนได้ */
            className="flex w-full min-w-0 items-center gap-2 overflow-x-auto sm:ml-auto sm:w-auto sm:flex-1 sm:basis-0 sm:justify-end"
          />
        </div>

        {/* หน้าขายแสดงเต็มพื้นที่ที่เหลือเสมอ ไม่ต้องสลับแท็บ */}
        <div
          data-voice-focus="cart"
          className="flex min-w-0 flex-1 flex-col overflow-hidden pt-1"
        >
          {/* โชว์เฉพาะตอนที่เลือกโต๊ะไว้จริง — "ยังไม่เลือกโต๊ะ" คือค่าปกติของการขาย
              หน้าร้าน การกินไปหนึ่งแถวเพื่อบอกว่าไม่มีอะไรพิเศษไม่คุ้มความสูง */}
          {selectedTable && (
            <div className="mb-1 flex shrink-0 flex-wrap items-center gap-2 px-2 text-xs text-gray-600">
              <span className="font-medium">บริบท:</span>
              <span>
                โต๊ะที่เลือก: <strong>{selectedTable.number}</strong>
                {selectedTable.label ? ` (${selectedTable.label})` : ""}
              </span>
              <button
                type="button"
                onClick={() => setSelectedTable(null)}
                className="min-h-8 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 transition-colors hover:bg-gray-50 motion-reduce:transition-none"
              >
                ล้างโต๊ะที่เลือก
              </button>
            </div>
          )}
          {/* min-h-0 จำเป็นกับ flex child ทุกชั้น ไม่งั้นลูกที่ scroll ได้จะดันความสูงจนล้นจอ */}
          <div className="min-h-0 flex-1">{sell}</div>
        </div>

        {/* dialog โต๊ะ/ครัว/บิล — คง mounted เสมอเพื่อไม่ให้ realtime ของคิวครัวขาดช่วง
            ซ่อนด้วย hidden จึงหลุดออกจาก a11y tree และ tab order ตอนปิด */}
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="โต๊ะ ครัว และบิล"
          hidden={openSection === null}
          onKeyDown={onDialogKeyDown}
          className={`fixed inset-0 z-[80] flex-col bg-black/40 ${openSection ? "flex" : "hidden"}`}
        >
          {/* คลิกพื้นหลังเพื่อปิด — ปุ่มเปล่าที่ screen reader ข้าม (มีปุ่ม "ปิด" จริงด้านบน) */}
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={closeSection}
            className="absolute inset-0 h-full w-full cursor-default"
          />
          <div className="relative mt-auto flex h-[92dvh] min-h-0 flex-col rounded-t-2xl bg-white shadow-2xl sm:mx-auto sm:my-auto sm:h-[85dvh] sm:w-[min(56rem,94vw)] sm:rounded-2xl">
            <div className="flex shrink-0 items-center gap-1 border-b border-gray-200 px-2 py-1">
              <div role="tablist" aria-label="ส่วนของ POS" className="flex min-w-0 gap-1 overflow-x-auto">
                {SECTIONS.map((section) => {
                  const isActive = section.id === openSection;
                  return (
                    <button
                      key={section.id}
                      ref={(node) => {
                        triggerRefs.current.set(section.id, node);
                      }}
                      type="button"
                      role="tab"
                      id={`unified-tab-${section.id}`}
                      aria-selected={isActive}
                      aria-controls={`unified-panel-${section.id}`}
                      tabIndex={isActive ? 0 : -1}
                      onClick={() => selectSection(section.id)}
                      className={`min-h-11 shrink-0 rounded-t-lg px-4 py-2 text-sm font-semibold transition-colors motion-reduce:transition-none ${
                        isActive
                          ? "border-b-2 border-orange-500 text-orange-700"
                          : "border-b-2 border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                      }`}
                    >
                      {section.label}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={closeSection}
                className="ml-auto min-h-11 shrink-0 rounded-lg px-3 text-xs font-semibold text-gray-500 hover:text-gray-800"
              >
                ปิด
              </button>
            </div>

            {/* งานโต๊ะที่เดิมเป็นปุ่มแยกบนแถบหัว — ย้ายมาอยู่ในที่เดียวกับผังโต๊ะ
                (คำสั่งวิ่งไป PosTerminal ผ่าน section-bus เพราะ modal เป็น state ของมัน) */}
            <div className="flex shrink-0 flex-wrap gap-2 border-b border-gray-100 px-3 py-2">
              <button
                type="button"
                onClick={() => {
                  closeSection();
                  emitPosCommand("open-table");
                }}
                className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50"
              >
                🍽️ เปิดโต๊ะ
              </button>
              <button
                type="button"
                onClick={() => {
                  closeSection();
                  emitPosCommand("settle-table");
                }}
                className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50"
              >
                🧾 เช็คบิลโต๊ะ
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <div
                role="tabpanel"
                id="unified-panel-tables"
                aria-labelledby="unified-tab-tables"
                hidden={openSection !== "tables"}
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
                hidden={openSection !== "kitchen"}
              >
                {/* U10 — คิวครัวจริง: คง mounted ไว้เสมอเพื่อไม่ให้ realtime ขาดช่วง */}
                <KitchenQueuePanel storeId={storeId} initialItems={kitchenInitialItems} />
              </div>

              <div
                role="tabpanel"
                id="unified-panel-bills"
                aria-labelledby="unified-tab-bills"
                hidden={openSection !== "bills"}
              >
                {/* U11 — บิลจริงจาก server + settlement→print intent (replay-safe) */}
                <BillsPanel selectedTable={selectedTable} />
              </div>
            </div>
          </div>
        </div>
      </section>
    </VoiceCartBridgeProvider>
  );
}
