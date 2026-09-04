// @vitest-environment jsdom
// P7 — คิวคำสั่งหลายรายการ: ทำทีละรายการ, ห้ามเปิด dialog ซ้อน, ข้ามกลางแล้วของเดิมต้องอยู่
// ⚠️ ต้องมี header jsdom — static-import @testing-library/* บน node env คือ hang จน timeout
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useMemo, useRef, useState } from "react";
import "../setup/react";
import { addToCart, emptyCart } from "@/modules/pos/cart";
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
import type { AiVoiceIntentEnvelope } from "@/modules/voice-pos/ai-intent-schema";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

function product(over: Partial<Product> = {}): Product {
  return {
    id: "p-latte",
    storeId: "store-1",
    organizationId: "org-1",
    categoryId: "cat-1",
    name: "ลาเต้",
    description: undefined,
    basePrice: 50,
    imageUrl: undefined,
    isActive: true,
    availableForPos: true,
    availableForQr: true,
    sortOrder: 0,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    variants: [],
    modifierGroups: [],
    ...over,
  };
}

const LATTE = product();
const AMERICANO = product({ id: "p-americano", name: "อเมริกาโน่" });
/** ชาเย็นต้องเลือกความหวานก่อน — ตัวที่ทำให้คิวต้องหยุดรอคน */
const THAI_TEA = product({
  id: "p-tea",
  name: "ชาเย็น",
  modifierGroups: [
    {
      id: "g-sweet",
      productId: "p-tea",
      name: "ความหวาน",
      selectionType: "single",
      isRequired: true,
      minSelections: 1,
      maxSelections: 1,
      sortOrder: 0,
      options: [
        { id: "o-less", modifierGroupId: "g-sweet", name: "หวานน้อย", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 0 },
        { id: "o-normal", modifierGroupId: "g-sweet", name: "หวานปกติ", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 1 },
      ],
    },
  ],
});

const CATALOG = [LATTE, AMERICANO, THAI_TEA];

class FakeSpeech {
  private handlers: VoiceSpeechHandlers | null = null;
  readonly adapter: VoiceSpeechAdapter = {
    isSupported: () => true,
    start: (handlers: VoiceSpeechHandlers): VoiceSpeechSession => {
      this.handlers = handlers;
      handlers.onState?.("listening");
      return {
        isActive: () => true,
        stop: () => handlers.onState?.("idle"),
        cancel: () => handlers.onState?.("idle"),
      };
    },
  };
  emitFinal(transcript: string) {
    this.handlers?.onFinal(transcript, 0.9);
  }
}

/** นับจำนวน dialog ที่ "เปิดอยู่จริง" — invariant คือห้ามเกิน 1 */
let openDialogs = 0;

function renderQueue(envelope: AiVoiceIntentEnvelope) {
  openDialogs = 0;
  const fake = new FakeSpeech();
  render(
    <VoiceCartBridgeProvider>
      <HarnessWithSpeech envelope={envelope} fake={fake} />
    </VoiceCartBridgeProvider>,
  );
  return {
    fake,
    speak: async (phrase: string) => {
      fireEvent.click(screen.getByTestId("voice-mic"));
      await act(async () => fake.emitFinal(phrase));
    },
    cartText: () => screen.getByTestId("cart").textContent ?? "",
  };
}

/** เหมือน Harness แต่ฉีด adapter เสียงปลอมเข้าไปด้วย */
function HarnessWithSpeech({ envelope, fake }: { envelope: AiVoiceIntentEnvelope; fake: FakeSpeech }) {
  const [cart, setCart] = useState<Cart>(() => emptyCart("store-1"));
  const [picker, setPicker] = useState<VoicePickerSnapshot | null>(null);
  const pickerProductRef = useRef<string | null>(null);
  const cartRef = useRef(cart);
  cartRef.current = cart;

  const api = useMemo<VoiceCartApi>(
    () => ({
      getSnapshot: () => ({ cart: cartRef.current, products: CATALOG, locked: false }),
      commit: (next) => setCart(next),
      openProduct: (productId) => {
        const found = CATALOG.find((p) => p.id === productId);
        if (!found || found.modifierGroups.length === 0) return false;
        openDialogs += 1;
        pickerProductRef.current = productId;
        setPicker({
          productName: found.name,
          needsVariant: false,
          missingRequiredGroups: ["ความหวาน"],
          choices: ["หวานน้อย", "หวานปกติ"],
          pendingChoices: ["หวานน้อย", "หวานปกติ"],
        });
        return true;
      },
      getPicker: () => picker,
      selectPickerChoice: (phrase) => {
        const hit = ["หวานน้อย", "หวานปกติ"].find((name) => phrase.includes(name));
        if (!hit) return null;
        setPicker((current) => (current ? { ...current, missingRequiredGroups: [], pendingChoices: [] } : current));
        return hit;
      },
      confirmPicker: () => {
        const productId = pickerProductRef.current;
        const found = CATALOG.find((p) => p.id === productId);
        if (!found) return { ok: false, message: "ไม่พบสินค้า" };
        openDialogs -= 1;
        setPicker(null);
        pickerProductRef.current = null;
        setCart((current) => addToCart(current, { product: found, variant: null, modifiers: [], quantity: 1 }));
        return { ok: true, message: `เพิ่ม ${found.name} แล้ว` };
      },
    }),
    [picker],
  );
  useRegisterVoiceCart(api);

  return (
    <>
      <ul data-testid="cart">
        {cart.items.map((item) => (
          <li key={item.key}>{`${item.productName} x${item.quantity}`}</li>
        ))}
      </ul>
      {picker ? <div role="dialog" aria-label={picker.productName}>{picker.productName}</div> : null}
      <VoicePosController
        voiceEnabled
        aiFallbackEnabled
        allowedCommands={[]}
        onSelectTab={() => {}}
        adapter={fake.adapter}
        requestAiIntent={async () => ({ ok: true, envelope })}
      />
    </>
  );
}

const envelopeOf = (
  commands: AiVoiceIntentEnvelope["commands"],
): AiVoiceIntentEnvelope => ({
  version: 1,
  outcome: "command_batch",
  commands,
  confidence: "high",
  reasonCode: "matched",
});

const add = (productPhrase: string, quantity: number | null = 1) =>
  ({ intent: "pos.add_item", productPhrase, quantity, optionPhrases: [] }) as AiVoiceIntentEnvelope["commands"][number];

describe("P7 — คิวคำสั่งเสียงหลายรายการ", () => {
  it("สั่งหลายเมนูในประโยคเดียว → เพิ่มครบตามลำดับ", async () => {
    const { speak, cartText } = renderQueue(envelopeOf([add("ลาเต้", 2), add("อเมริกาโน่", 1)]));
    await speak("ลาเต้สองแก้วกับอเมริกาโน่หนึ่งแก้ว");

    expect(cartText()).toContain("ลาเต้ x2");
    expect(cartText()).toContain("อเมริกาโน่ x1");
    expect(screen.getByTestId("voice-command-queue")).toBeTruthy();
  });

  it("รายการที่ต้องเลือกตัวเลือก: เปิด dialog ได้ทีละใบ และของที่เพิ่มไปแล้วยังอยู่", async () => {
    const { speak, cartText } = renderQueue(
      envelopeOf([add("ลาเต้", 1), add("ชาเย็น", 1), add("อเมริกาโน่", 1)]),
    );
    await speak("ลาเต้ ชาเย็น อเมริกาโน่");

    // ลาเต้ลงตะกร้าแล้ว, ชาเย็นหยุดรอเลือก, อเมริกาโน่ยังไม่ถูกแตะ
    expect(cartText()).toContain("ลาเต้ x1");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(openDialogs).toBe(1);
    expect(cartText()).not.toContain("อเมริกาโน่");

    // เลือกตัวเลือกแล้วยืนยัน → dialog ปิดก่อน แล้วคิวค่อยเดินต่อจนจบ
    await speak("เลือกหวานน้อย");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await speak("ยืนยัน");

    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
    expect(openDialogs).toBe(0);
    expect(cartText()).toContain("ชาเย็น x1");
    expect(cartText()).toContain("อเมริกาโน่ x1");
  });

  it("ข้ามรายการที่ค้าง → ของก่อนหน้าคงอยู่ และเดินต่อรายการถัดไป", async () => {
    const { speak, cartText } = renderQueue(
      envelopeOf([add("ลาเต้", 1), add("ชาเย็น", 1), add("อเมริกาโน่", 1)]),
    );
    await speak("ลาเต้ ชาเย็น อเมริกาโน่");
    expect(cartText()).toContain("ลาเต้ x1");

    await act(async () => {
      fireEvent.click(screen.getByText("ข้ามรายการนี้"));
    });

    expect(cartText()).toContain("ลาเต้ x1");
    expect(cartText()).not.toContain("ชาเย็น");
    expect(cartText()).toContain("อเมริกาโน่ x1");
  });

  it("ยกเลิกที่เหลือ: ของที่ commit ไปแล้วยังอยู่", async () => {
    const { speak, cartText } = renderQueue(
      envelopeOf([add("ลาเต้", 1), add("ชาเย็น", 1), add("อเมริกาโน่", 1)]),
    );
    await speak("ลาเต้ ชาเย็น อเมริกาโน่");

    await act(async () => {
      fireEvent.click(screen.getByText("ยกเลิกที่เหลือ"));
    });

    expect(cartText()).toContain("ลาเต้ x1");
    expect(cartText()).not.toContain("อเมริกาโน่");
    expect(screen.queryByText("ข้ามรายการนี้")).toBeNull();
  });

  it("แผงคิวไม่ใช่ dialog — ห้ามแย่ง focus จากหน้าต่างตัวเลือก", async () => {
    const { speak } = renderQueue(envelopeOf([add("ลาเต้", 1), add("อเมริกาโน่", 1)]));
    await speak("ลาเต้ อเมริกาโน่");
    const panel = screen.getByTestId("voice-command-queue");
    expect(panel.getAttribute("role")).not.toBe("dialog");
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
  });

  it("รายการที่ไม่ได้ยินจำนวนถูกทำเครื่องหมายว่าทำไม่ได้ ไม่ใช่เดาเป็น 1", async () => {
    const { speak, cartText } = renderQueue(envelopeOf([add("ลาเต้", null)]));
    await speak("ลาเต้");
    expect(cartText()).not.toContain("ลาเต้ x1");
    expect(screen.getByTestId("voice-command-queue").textContent).toContain("ไม่ได้ยินจำนวน");
  });
});
