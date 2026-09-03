import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * หน้า POS ต้องพอดีจอเสมอ — ทั้งหน้าไม่เลื่อน เลื่อนได้เฉพาะรายการเมนู (และแผงออร์เดอร์)
 * เทสต์ชุดนี้ยึด "โซ่ความสูง" ไว้: พ่อสูงเท่าจอ → ลูกทุกชั้น h-full/flex-1 + min-h-0 →
 * มีตัวเลื่อนเฉพาะกล่องที่ตั้งใจ. ถ้าชั้นใดชั้นหนึ่งหลุด ทั้งหน้าจะกลับมาเลื่อนอีก
 * (อาการเดิม: shell รวมวาง POS สูง 100vh ต่อจากหัวข้อ+แท็บ จึงล้นจอ)
 */
describe("POS เต็มจอ — ไม่มีการเลื่อนทั้งหน้า", () => {
  const page = read("src/app/pos/page.tsx");
  const terminal = read("src/app/pos/PosTerminal.tsx");
  const workspace = read("src/app/pos/unified/UnifiedPosWorkspace.tsx");

  it("หน้า /pos สูงเท่าจอและไม่เลื่อนทั้งหน้า ทั้งเส้นทาง legacy และ POS รวม", () => {
    const wrappers = page.match(/style=\{themeStyle\}[^>]*>/g) ?? [];
    expect(wrappers.length).toBe(2);
    for (const wrapper of wrappers) {
      expect(wrapper).toContain("h-dvh");
      expect(wrapper).toContain("overflow-hidden");
    }
  });

  it("PosTerminal สูงตามกล่องแม่ (h-full) ไม่ผูก 100vh ตายตัว", () => {
    expect(terminal).toContain('className="storeos-pos flex h-full min-h-0 flex-col overflow-hidden');
    // h-screen บนรากของ POS คือต้นเหตุเดิมที่ดันให้ทั้งหน้าเลื่อนเมื่ออยู่ใน shell รวม
    expect(terminal).not.toContain('className="storeos-pos flex h-screen');
  });

  it("รายการเมนูเป็นกล่องที่เลื่อนได้ ส่วนหมวดหมู่/หัวข้ออยู่กับที่", () => {
    expect(terminal).toContain('{/* Product grid */}\n        <div className="flex-1 overflow-y-auto p-3">');
    expect(terminal).toContain('className="shrink-0 flex gap-2 overflow-x-auto border-b');
  });

  it("shell รวมเป็นคอลัมน์เต็มความสูง แถวแท็บคงที่", () => {
    expect(workspace).toContain('className="unified-pos-workspace flex h-full min-h-0 min-w-0 flex-col overflow-hidden"');
    expect(workspace).toContain('className="flex shrink-0 items-center gap-2 border-b border-gray-200 pr-2"');
  });

  it("ไม่มีหัวข้อสองชั้น — ชื่อร้านโชว์ที่แถบหัวของ PosTerminal ที่เดียว", () => {
    // shell เคยมี header ของตัวเอง (ชื่อร้าน + ป้าย POS รวม) ซ้อนบน topbar ของ POS
    // ที่โชว์ชื่อร้านอยู่แล้ว = เสียความสูงไปหนึ่งแถวเปล่า ๆ
    expect(workspace).not.toContain("<header");
    expect(workspace).toContain('<h1 className="sr-only">');
    // ปุ่มเสียงต้องใช้ได้ทุกแท็บ จึงย้ายมาอยู่ท้ายแถวแท็บ ไม่ใช่หายไป
    expect(workspace).toContain("<VoicePosController");
  });

  it("แท็บที่เปิดอยู่กินที่เหลือทั้งหมด แท็บที่ปิดถูกซ่อนด้วยคลาส hidden", () => {
    // [hidden] มี specificity เท่ากับ .flex — พึ่งแอตทริบิวต์อย่างเดียวไม่พอ
    // ต้องสลับคลาส display ตามสถานะ ไม่งั้นแท็บที่ปิดจะโผล่ทับกัน
    for (const tab of ["sell", "tables", "kitchen", "bills"]) {
      expect(workspace).toContain(`activeTab === "${tab}" ?`);
      expect(workspace).toContain(`activeTab !== "${tab}"`);
    }
    expect(workspace).toContain('flex-1 flex-col overflow-hidden pt-2');
    expect(workspace).toContain('flex-1 overflow-y-auto pt-3');
  });

  it("แผง POS ในแท็บขายได้รับ min-h-0 (ไม่งั้นตัวเลื่อนข้างในจะดันความสูงจนล้นจอ)", () => {
    expect(workspace).toContain('<div className="min-h-0 flex-1">{sell}</div>');
  });

  it("ลูกค้า/คูปอง/จอลูกค้า พับเป็นปุ่ม ไม่กินความสูงของช่องรายการในออร์เดอร์", () => {
    // แผงเต็มแบบเดิมกินท้ายแผงออร์เดอร์จนช่องรายการเหลือแค่ไม่กี่บรรทัด
    expect(terminal).not.toContain("checkoutTools");
    expect(terminal).toContain("onOpenCustomerTools");
    expect(terminal).toContain('title="ลูกค้า / คูปอง / จอลูกค้า"');
    // ต้องนับเป็น utility sheet ด้วย ไม่งั้น drawer ออร์เดอร์บนมือถือจะยังกินโฟกัสทับ
    expect(terminal).toContain("ticketPanelOpen || billHistoryPanelOpen || customerToolsOpen");
  });

  it("ปุ่มที่พับยังโชว์ลูกค้า/คูปองที่เลือกไว้ (ข้อมูลต้องไม่หายไปกับการพับ)", () => {
    expect(terminal).toContain("selectedCustomerName={selectedCustomer?.name ?? null}");
    expect(terminal).toContain("selectedCustomerName || appliedCoupon");
  });

  it("หัวแผงออร์เดอร์เป็นแถวเดียว และส่วนลดท้ายบิลพับเป็นปุ่ม", () => {
    // เดิมหัวแผงซ้อนสามแถว (154px) กินความสูงพอ ๆ กับช่องรายการเอง
    expect(terminal).toContain('title="ตั๋วที่เปิดค้างไว้"');
    expect(terminal).toContain("onOpenDiscountTools");
    expect(terminal).toContain('title="ส่วนลดท้ายบิล"');
    expect(terminal).toContain("<BillDiscountPanel");
    // sheet ของส่วนลดต้องนับเป็น utility sheet ด้วย ไม่งั้น drawer มือถือกินโฟกัสทับ
    expect(terminal).toContain("|| discountFormOpen || tableMenuOpen;");
  });

  it("แถบด้านบนเหลือแถวเดียว — ปุ่มของหน้าขายไปอยู่แถวเดียวกับแท็บ", () => {
    // เดิมแถบแท็บกับแถบหัวของ POS เป็นสองแถวซ้อนกัน
    expect(workspace).toContain("POS_TOPBAR_ACTIONS_ID");
    expect(terminal).toContain("createPortal(posActionButtons, topbarHost)");
    // ไม่มี shell รวม (เปิด POS เดี่ยว) ต้องยังมีแถบหัวของตัวเองให้กดปุ่มได้
    expect(terminal).toContain('<header className="topbar');
  });

  it("แถบหัวไม่มีโลโก้/ชื่อร้าน — ที่ตรงนั้นเป็นปุ่มสั่งงานด้วยเสียงแทน", () => {
    expect(terminal).not.toContain('className="store-dot shrink-0"');
    expect(terminal).not.toContain("ขายหน้าร้าน · POS");
    expect(workspace).toContain("<VoicePosController");
  });

  it("ปุ่มโต๊ะเหลือปุ่มเดียว เปิดเมนูเลือกเปิดโต๊ะ/เช็คบิลโต๊ะ", () => {
    expect(terminal).toContain("tableMenuOpen");
    expect(terminal).toContain('title="โต๊ะ"');
    expect(terminal).toContain("setShowTableOpen(true)");
    expect(terminal).toContain("setShowTableBill(true)");
    // สองปุ่มเดิมบนแถบหัวต้องไม่กลับมา
    expect(terminal).not.toContain('aria-label="เปิดโต๊ะ"');
    expect(terminal).not.toContain('aria-label="เช็คบิลโต๊ะ"');
  });

  it("รายการในออร์เดอร์เป็นตัวเลื่อนเดียว — aside ไม่เลื่อนซ้อน", () => {
    expect(terminal).toMatch(/<aside className="hidden [^"]*min-h-0 overflow-hidden/);
    expect(terminal).toContain('<div className="flex-1 overflow-y-auto">');
  });
});
