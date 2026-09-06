// @vitest-environment jsdom
// สั่งหลายเมนูรวดเดียวต้องขึ้นครบทุกรายการ
// อาการจากเครื่องจริง: "พูดหลายเมนูขึ้นแค่เมนูเดียว" — เพราะแตกเป็นหลายคำสั่งได้เฉพาะทาง AI
// ซึ่งวิ่งก็ต่อเมื่อ parser ปกติฟังไม่ออกเลย และ flag ของ AI ยังปิดอยู่ทุกร้าน
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
} from "@/app/pos/unified/voice-cart-bridge";
import type {
  VoiceSpeechAdapter,
  VoiceSpeechHandlers,
} from "@/modules/voice-pos/speech-adapter";
import type { StandbyBridgeEvent } from "@/modules/voice-pos/standby-contract";
import type { WindowsVoiceHostAdapter } from "@/modules/voice-pos/windows-host";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

function product(id: string, name: string): Product {
  return {
    id,
    storeId: "store-1",
    organizationId: "org-1",
    categoryId: "cat-1",
    name,
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
  };
}

const MENU: readonly Product[] = [
  product("p1", "ลาเต้"),
  product("p2", "ชาเย็น"),
  product("p3", "อเมริกาโน่"),
];

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

function createFakeHost() {
  const listeners = new Set<(event: StandbyBridgeEvent) => void>();
  const host: WindowsVoiceHostAdapter = {
    available: true,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeHealth: () => () => {},
    requestHealth: () => {},
    setStandby: () => {},
    commandStarted: () => {},
    commandExtended: () => {},
    commandEnded: () => {},
    dispose: () => listeners.clear(),
  };
  return {
    host,
    wake: () =>
      listeners.forEach((listener) =>
        listener({ kind: "start-listening", sessionId: "sess000001", phraseId: "hello_storeos" }),
      ),
  };
}

function FakeSellSurface() {
  const [cart, setCart] = useState<Cart>(() => emptyCart("store-1"));
  const snapshotRef = useRef({ cart, products: MENU, locked: false });
  useEffect(() => {
    snapshotRef.current = { cart, products: MENU, locked: false };
  }, [cart]);
  const api = useMemo<VoiceCartApi>(
    () => ({
      getSnapshot: () => snapshotRef.current,
      commit: (next: Cart) => setCart(next),
    }),
    [],
  );
  useRegisterVoiceCart(api);
  return (
    <span data-testid="cart">
      {cart.items.map((item) => `${item.productName}x${item.quantity}`).join("|")}
    </span>
  );
}

function renderVoicePos() {
  const speech = createFakeAdapter();
  const host = createFakeHost();
  render(
    <VoiceCartBridgeProvider>
      <FakeSellSurface />
      <VoicePosController
        voiceEnabled
        allowedCommands={[]}
        onSelectTab={vi.fn()}
        adapter={speech.adapter}
        standbyHost={host.host}
      />
    </VoiceCartBridgeProvider>,
  );
  return {
    tapAndSay: async (phrase: string) => {
      fireEvent.click(screen.getByTestId("voice-mic"));
      await act(async () => speech.say(phrase));
    },
    wakeAndSay: async (phrase: string) => {
      act(() => host.wake());
      await act(async () => speech.say(phrase));
    },
    cart: () => screen.getByTestId("cart").textContent,
  };
}

describe("สั่งหลายเมนูในประโยคเดียว", () => {
  it("กดปุ่มพูดสองเมนู ต้องขึ้นทั้งสองรายการพร้อมจำนวนที่ถูก", async () => {
    const pos = renderVoicePos();

    await pos.tapAndSay("เพิ่มลาเต้สองแก้วและชาเย็นหนึ่งแก้ว");

    expect(pos.cart()).toBe("ลาเต้x2|ชาเย็นx1");
  });

  it("ท่อนหลังที่ละคำว่า 'เพิ่ม' ไว้ก็ต้องขึ้น", async () => {
    const pos = renderVoicePos();

    await pos.tapAndSay("เพิ่มลาเต้กับอเมริกาโน่");

    expect(pos.cart()).toBe("ลาเต้x1|อเมริกาโน่x1");
  });

  it("เมนูเดียวยังทำงานเหมือนเดิม", async () => {
    const pos = renderVoicePos();

    await pos.tapAndSay("เพิ่มลาเต้ 3 แก้ว");

    expect(pos.cart()).toBe("ลาเต้x3");
  });

  it("มาจากคำปลุกก็ขึ้นครบทั้งชุดทันที ไม่มีขั้นยืนยันคั่น", async () => {
    // ถามยืนยันหลังคำปลุกคือการทำลายเหตุผลของฟีเจอร์ ซึ่งมีไว้ให้คนมือไม่ว่าง
    const pos = renderVoicePos();

    await pos.wakeAndSay("เพิ่มลาเต้สองแก้วและชาเย็นหนึ่งแก้ว");

    expect(pos.cart()).toBe("ลาเต้x2|ชาเย็นx1");
    expect(screen.queryByTestId("voice-standby-proposal")).toBeNull();
  });
});
