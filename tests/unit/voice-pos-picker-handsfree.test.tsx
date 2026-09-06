// @vitest-environment jsdom
// คำสั่งเสียงต้องจบได้ด้วยเสียงล้วน — ห้ามจบด้วย "เปิด dialog แล้วให้ไปกดเอง"
// ⚠️ ต้องมี header jsdom ทุกครั้ง — static-import @testing-library/* บน node env คือ hang จน timeout
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEffect, useMemo, useRef, useState } from "react";
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
} from "@/modules/voice-pos/speech-adapter";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

/** สินค้าที่มีตัวเลือก — สั่งด้วยเสียงแล้วหน้าขายจะเปิด dialog ให้ */
const LATTE: Product = {
  id: "p1",
  storeId: "store-1",
  organizationId: "org-1",
  categoryId: "cat-1",
  name: "ลาเต้",
  description: undefined,
  basePrice: 100,
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
      id: "g1",
      productId: "p1",
      name: "ความหวาน",
      selectionType: "single",
      isRequired: true,
      minSelections: 1,
      maxSelections: 1,
      sortOrder: 0,
      options: [
        { id: "o1", groupId: "g1", name: "หวานปกติ", priceDelta: 0, isDefault: true, sortOrder: 0 },
        { id: "o2", groupId: "g1", name: "หวานน้อย", priceDelta: 0, isDefault: false, sortOrder: 1 },
      ],
    },
  ],
};

function createFakeAdapter() {
  let handlers: VoiceSpeechHandlers | null = null;
  const adapter: VoiceSpeechAdapter = {
    isSupported: () => true,
    start: (h) => {
      handlers = h;
      h.onState?.("listening");
      return { isActive: () => true, stop: () => {}, cancel: () => {} };
    },
  };
  return {
    adapter,
    say(transcript: string) {
      handlers?.onFinal(transcript, 0.95);
      handlers?.onState?.("idle");
    },
  };
}

/**
 * หน้าขายจำลองที่มี dialog ตัวเลือกเหมือนของจริง
 * ตัวแปรสำคัญคือ missingRequiredGroups — "ไม่มีอะไรต้องเลือกแล้ว" คือกรณีที่พังอยู่
 */
function FakeSellSurface({ missing }: { readonly missing: readonly string[] }) {
  const [cart, setCart] = useState<Cart>(() => emptyCart("store-1"));
  const [pickerOpen, setPickerOpen] = useState(false);
  const stateRef = useRef({ cart, pickerOpen });
  useEffect(() => {
    stateRef.current = { cart, pickerOpen };
  }, [cart, pickerOpen]);

  const api = useMemo<VoiceCartApi>(
    () => ({
      getSnapshot: () => ({ cart: stateRef.current.cart, products: [LATTE], locked: false }),
      commit: (next: Cart) => setCart(next),
      openProduct: () => {
        setPickerOpen(true);
        stateRef.current.pickerOpen = true;
        return true;
      },
      getPicker: (): VoicePickerSnapshot | null =>
        stateRef.current.pickerOpen
          ? {
              productName: LATTE.name,
              needsVariant: false,
              missingRequiredGroups: [...missing],
              pendingChoices: [...missing],
              choices: ["หวานปกติ", "หวานน้อย"],
            }
          : null,
      selectPickerChoice: (phrase: string) => (phrase.includes("น้อย") ? "หวานน้อย" : null),
      confirmPicker: () => {
        setPickerOpen(false);
        stateRef.current.pickerOpen = false;
        setCart((current) => ({
          ...current,
          items: [
            ...current.items,
            {
              id: "line-1",
              productId: LATTE.id,
              productName: LATTE.name,
              variantId: undefined,
              variantName: undefined,
              unitPrice: LATTE.basePrice,
              quantity: 1,
              modifiers: [],
              lineTotal: LATTE.basePrice,
            } as Cart["items"][number],
          ],
        }));
        return { ok: true, message: "เพิ่ม ลาเต้ ลงตะกร้าแล้ว" };
      },
    }),
    [missing],
  );

  useRegisterVoiceCart(api);
  return (
    <>
      <span data-testid="cart-count">{cart.items.length}</span>
      <span data-testid="picker-open">{pickerOpen ? "open" : "closed"}</span>
    </>
  );
}

function renderPos(missing: readonly string[]) {
  const speech = createFakeAdapter();
  render(
    <VoiceCartBridgeProvider>
      <FakeSellSurface missing={missing} />
      <VoicePosController
        voiceEnabled
        allowedCommands={[]}
        onSelectTab={vi.fn()}
        adapter={speech.adapter}
      />
    </VoiceCartBridgeProvider>,
  );
  return {
    say: async (phrase: string) => {
      fireEvent.click(screen.getByTestId("voice-mic"));
      await act(async () => speech.say(phrase));
    },
    cartCount: () => Number(screen.getByTestId("cart-count").textContent),
    pickerOpen: () => screen.getByTestId("picker-open").textContent === "open",
  };
}

describe("สั่งเมนูด้วยเสียงต้องจบได้โดยไม่ต้องแตะจอ", () => {
  it("ไม่มีตัวเลือกที่ต้องเลือกแล้ว = เพิ่มลงตะกร้าให้เลย ไม่ทิ้ง dialog ค้างให้กด", async () => {
    // อาการที่เจอจากเครื่องจริง: "สั่งเมนูแล้วส่ง dialog มาให้กด ซึ่งผิดคอนเซ็ป"
    const pos = renderPos([]);

    await pos.say("เพิ่มลาเต้");

    expect(pos.cartCount()).toBe(1);
    expect(pos.pickerOpen()).toBe(false);
  });

  it("ยังมีตัวเลือกบังคับ = เปิด dialog ไว้ แต่ต้องบอกให้พูด ไม่ใช่บอกให้กด", async () => {
    const pos = renderPos(["ความหวาน"]);

    await pos.say("เพิ่มลาเต้");

    expect(pos.pickerOpen()).toBe(true);
    expect(pos.cartCount()).toBe(0);
    // ข้อความที่ปุ่มประกาศต้องชวนให้พูดต่อ ไม่ใช่ชี้ไปที่หน้าจอ
    const message = screen.getByRole("status").textContent ?? "";
    expect(message).toContain("พูด");
    expect(message).not.toContain("กดเพิ่ม");
  });

  it("เลือกตัวเลือกด้วยเสียงแล้วยืนยันด้วยเสียงได้จนจบ", async () => {
    const pos = renderPos(["ความหวาน"]);
    await pos.say("เพิ่มลาเต้");

    await pos.say("เลือกหวานน้อย");
    await pos.say("ยืนยัน");

    expect(pos.cartCount()).toBe(1);
    expect(pos.pickerOpen()).toBe(false);
  });
});
