// @vitest-environment jsdom
// U21 — สินค้าที่มีตัวเลือกบังคับ: เสียงต้อง "เด้ง dialog" แล้วรับคำสั่งเลือก/ยืนยันต่อได้
// และคำว่า "ตะกร้า" กับ "ออเดอร์" ต้องพาไปที่แผงเดียวกัน
// ⚠️ ต้องมี header jsdom ทุกครั้ง — static-import @testing-library/* บน node env คือ hang จน timeout
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useMemo, useRef, useState } from "react";
import "../setup/react";
import { emptyCart } from "@/modules/pos/cart";
import type { Cart } from "@/modules/pos/types";
import type { Product } from "@/modules/catalog/types";
import { VoicePosController } from "@/app/pos/unified/VoicePosController";
import {
  useRegisterVoiceCart,
  VoiceCartBridgeProvider,
  type VoiceCartApi,
  type VoicePickerSnapshot,
} from "@/app/pos/unified/voice-cart-bridge";
import type {
  VoiceSpeechAdapter,
  VoiceSpeechHandlers,
  VoiceSpeechSession,
} from "@/modules/voice-pos/speech-adapter";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

/** ชาเย็น: มีความหวานเป็นตัวเลือก "บังคับ" เหมือนเมนูจริงของร้าน */
const THAI_TEA: Product = {
  id: "p-tea",
  storeId: "store-1",
  organizationId: "org-1",
  categoryId: "cat-1",
  name: "ชาเย็น",
  description: undefined,
  basePrice: 40,
  imageUrl: undefined,
  isActive: true,
  availableForPos: true,
  availableForQr: true,
  sortOrder: 0,
  createdAt: "2026-06-17T00:00:00.000Z",
  updatedAt: "2026-06-17T00:00:00.000Z",
  variants: [],
  modifierGroups: [
    {
      id: "g-sweet",
      productId: "p-tea",
      name: "ความหวาน",
      selectionType: "single",
      isRequired: true,
      minSelections: 1,
      maxSelections: 1,
      sortOrder: 1,
      options: [
        { id: "o-less", modifierGroupId: "g-sweet", name: "หวานน้อย", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 1 },
        { id: "o-normal", modifierGroupId: "g-sweet", name: "หวานปกติ", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 2 },
      ],
    },
  ],
};

function createFakeAdapter() {
  let handlers: VoiceSpeechHandlers | null = null;
  let active = false;
  const session: VoiceSpeechSession = {
    isActive: () => active,
    stop: () => {},
    cancel: () => {
      active = false;
    },
  };
  const adapter: VoiceSpeechAdapter = {
    isSupported: () => true,
    start: (h) => {
      handlers = h;
      active = true;
      h.onState?.("listening");
      return session;
    },
  };
  return {
    adapter,
    emitFinal(transcript: string) {
      active = false;
      handlers?.onFinal(transcript, 0.95);
      handlers?.onState?.("idle");
    },
  };
}

/**
 * หน้าขายจำลอง: มี dialog ตัวเลือก + แผงออเดอร์ เหมือน PosTerminal ย่อส่วน
 * ใช้ ref เป็นแหล่งความจริงเหมือนของจริง เพราะผู้เรียกอ่านสถานะต่อทันทีในจังหวะเดียวกัน
 */
function FakeSellSurface() {
  const cartRef = useRef<Cart>(emptyCart("store-1"));
  const orderPanelRef = useRef(false);
  const pickerRef = useRef<string | null>(null);
  const chosenRef = useRef<string | null>(null);
  // ref = แหล่งความจริงสำหรับการอ่านทันที, state = สิ่งที่เรนเดอร์ (ห้ามอ่าน ref ตอน render)
  const [view, setView] = useState({ orderPanel: false, picker: false, chosen: "-", cartCount: 0 });
  const rerender = () =>
    setView({
      orderPanel: orderPanelRef.current,
      picker: pickerRef.current !== null,
      chosen: chosenRef.current ?? "-",
      cartCount: cartRef.current.items.length,
    });

  const api = useMemo<VoiceCartApi>(
    () => ({
      getSnapshot: () => ({ cart: cartRef.current, products: [THAI_TEA], locked: false }),
      commit: (next: Cart) => {
        cartRef.current = next;
        rerender();
      },
      openOrderPanel: () => {
        orderPanelRef.current = true;
        rerender();
      },
      openProduct: (productId: string) => {
        if (productId !== THAI_TEA.id) return false;
        pickerRef.current = productId;
        rerender();
        return true;
      },
      getPicker: (): VoicePickerSnapshot | null =>
        pickerRef.current
          ? {
              productName: THAI_TEA.name,
              needsVariant: false,
              missingRequiredGroups: chosenRef.current ? [] : ["ความหวาน"],
              choices: ["หวานน้อย", "หวานปกติ"],
            }
          : null,
      selectPickerChoice: (phrase: string) => {
        const option = THAI_TEA.modifierGroups[0].options.find((o) => o.name.startsWith(phrase.trim()));
        if (!option) return null;
        chosenRef.current = option.name;
        rerender();
        return option.name;
      },
      confirmPicker: () => {
        if (!pickerRef.current) return { ok: false, message: "ยังไม่มีหน้าต่างตัวเลือกเปิดอยู่" };
        if (!chosenRef.current) return { ok: false, message: "ยังต้องเลือก ความหวาน" };
        pickerRef.current = null;
        rerender();
        return { ok: true, message: `เพิ่ม ${THAI_TEA.name} ลงตะกร้าแล้ว` };
      },
    }),
    [],
  );
  useRegisterVoiceCart(api);

  return (
    <div>
      <span data-testid="order-panel">{view.orderPanel ? "เปิด" : "ปิด"}</span>
      <span data-testid="picker">{view.picker ? "เปิด" : "ปิด"}</span>
      <span data-testid="chosen">{view.chosen}</span>
      <span data-testid="cart-count">{view.cartCount}</span>
    </div>
  );
}

/** ข้อความจากทุก live region รวมกัน (ปุ่มมีของตัวเอง, ตัวควบคุมมีของ undo) */
function statusText(): string {
  return screen
    .getAllByRole("status")
    .map((node) => node.textContent ?? "")
    .join(" ");
}

function renderVoicePos() {
  const fake = createFakeAdapter();
  const selectTab = vi.fn();
  render(
    <VoiceCartBridgeProvider>
      <FakeSellSurface />
      <VoicePosController voiceEnabled allowedCommands={[]} onSelectTab={selectTab} adapter={fake.adapter} />
    </VoiceCartBridgeProvider>,
  );
  const speak = (phrase: string) => {
    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitFinal(phrase));
  };
  return { speak, selectTab };
}

describe("U21 — คำศัพท์ตะกร้า/ออเดอร์", () => {
  it.each(["เปิดตะกร้า", "เปิดออเดอร์", "เปิดออร์เดอร์", "ไปที่ตะกร้า"])(
    '"%s" เปิดแผงออเดอร์เดียวกัน',
    (phrase) => {
      const { speak } = renderVoicePos();
      expect(screen.getByTestId("order-panel")).toHaveTextContent("ปิด");

      speak(phrase);

      expect(screen.getByTestId("order-panel")).toHaveTextContent("เปิด");
      expect(statusText()).toContain("เปิดออเดอร์แล้ว");
    },
  );
});

describe("U21 — สินค้าที่ต้องเลือกตัวเลือก", () => {
  it("พูดชื่อสินค้าที่มีตัวเลือกบังคับ → เด้ง dialog แทนการปฏิเสธ", () => {
    const { speak, selectTab } = renderVoicePos();

    speak("เพิ่มชาเย็นลงออเดอร์");

    expect(screen.getByTestId("picker")).toHaveTextContent("เปิด");
    expect(screen.getByTestId("cart-count")).toHaveTextContent("0");
    expect(selectTab).toHaveBeenCalledWith("sell");
    expect(statusText()).toContain("หวานน้อย");
  });

  it('เลือกตัวเลือกด้วยเสียง แล้ว "ยืนยัน" เพื่อเพิ่มลงตะกร้า', () => {
    const { speak } = renderVoicePos();

    speak("เพิ่มชาเย็น");
    speak("เลือกหวานน้อย");
    expect(screen.getByTestId("chosen")).toHaveTextContent("หวานน้อย");
    expect(statusText()).toContain("ยืนยัน");

    speak("ยืนยัน");
    expect(screen.getByTestId("picker")).toHaveTextContent("ปิด");
    expect(statusText()).toContain("ลงตะกร้าแล้ว");
  });

  it("พูดตัวเลือกที่ไม่มี → บอกรายการที่เลือกได้ และไม่ยืนยันให้", () => {
    const { speak } = renderVoicePos();

    speak("เพิ่มชาเย็น");
    speak("เลือกหวานมากที่สุด");
    expect(screen.getByTestId("chosen")).toHaveTextContent("-");
    expect(statusText()).toContain("ไม่พบตัวเลือกที่พูด");

    speak("ยืนยัน");
    expect(statusText()).toContain("ยังต้องเลือก");
    expect(screen.getByTestId("picker")).toHaveTextContent("เปิด");
  });

  it('พูด "เลือก…" ตอนไม่มี dialog เปิด → บอกให้พูดชื่อสินค้าก่อน', () => {
    const { speak } = renderVoicePos();

    speak("เลือกหวานน้อย");

    expect(statusText()).toContain("ยังไม่มีหน้าต่างตัวเลือก");
  });
});
