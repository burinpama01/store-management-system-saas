// @vitest-environment jsdom
// W6 — คำสั่งที่มาจากคำปลุกต้องยืนยันก่อนแตะตะกร้า
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
  VoiceSpeechSession,
} from "@/modules/voice-pos/speech-adapter";
import type { StandbyBridgeEvent, VoiceHostHealth } from "@/modules/voice-pos/standby-contract";
import type { WindowsVoiceHostAdapter } from "@/modules/voice-pos/windows-host";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

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
  modifierGroups: [],
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

function createFakeHost() {
  const listeners = new Set<(event: StandbyBridgeEvent) => void>();
  const healthListeners = new Set<(health: VoiceHostHealth) => void>();
  const calls: string[] = [];
  const host: WindowsVoiceHostAdapter = {
    available: true,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeHealth: (listener) => {
      healthListeners.add(listener);
      return () => healthListeners.delete(listener);
    },
    requestHealth: () => calls.push("requestHealth"),
    commandStarted: (sessionId) => calls.push(`started:${sessionId}`),
    commandExtended: (sessionId) => calls.push(`extended:${sessionId}`),
    commandEnded: (sessionId, outcome) => calls.push(`ended:${sessionId}:${outcome}`),
    dispose: () => listeners.clear(),
  };
  return {
    host,
    calls,
    wake: () =>
      listeners.forEach((listener) =>
        listener({ kind: "start-listening", sessionId: "sess000001", phraseId: "sawatdee_os" }),
      ),
  };
}

function FakeSellSurface() {
  const [cart, setCart] = useState<Cart>(() => emptyCart("store-1"));
  const snapshotRef = useRef({ cart, products: [LATTE] as readonly Product[], locked: false });
  useEffect(() => {
    snapshotRef.current = { cart, products: [LATTE], locked: false };
  }, [cart]);
  const api = useMemo<VoiceCartApi>(
    () => ({
      getSnapshot: () => snapshotRef.current,
      commit: (next: Cart) => setCart(next),
    }),
    [],
  );
  useRegisterVoiceCart(api);
  return <span data-testid="cart-qty">{cart.items[0]?.quantity ?? 0}</span>;
}

function renderVoicePos(now?: () => number) {
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
        now={now}
      />
    </VoiceCartBridgeProvider>,
  );

  return {
    host,
    /** พูดหลังกดปุ่มเอง */
    tapAndSay: async (phrase: string) => {
      fireEvent.click(screen.getByTestId("voice-mic"));
      await act(async () => speech.emitFinal(phrase));
    },
    /** พูดหลังถูกปลุกด้วยคำปลุก */
    wakeAndSay: async (phrase: string) => {
      act(() => host.wake());
      await act(async () => speech.emitFinal(phrase));
    },
    qty: () => Number(screen.getByTestId("cart-qty").textContent),
  };
}

describe("VoicePosController — คำสั่งจากคำปลุก", () => {
  it("คำสั่งเพิ่มของจากคำปลุกต้องยังไม่แตะตะกร้า", async () => {
    const pos = renderVoicePos();

    await pos.wakeAndSay("เพิ่มลาเต้ 2 แก้ว");

    expect(pos.qty()).toBe(0);
    // การ์ดยืนยันต้องบอก "สิ่งที่ระบบจะทำ" + เวลาที่เหลือเป็นตัวเลข + คำเตือนว่ายังไม่แตะตะกร้า
    const card = screen.getByTestId("voice-standby-proposal");
    expect(card.textContent).toContain("เพิ่ม ลาเต้ 2");
    expect(card.textContent).toContain("ตะกร้ายังไม่เปลี่ยนจนกว่าจะยืนยัน");
    expect(screen.getByTestId("voice-standby-countdown").textContent).toContain("เหลือ 8 วินาที");
  });

  it("กดปุ่มยืนยันแล้วจึงเข้าตะกร้า", async () => {
    const pos = renderVoicePos();
    await pos.wakeAndSay("เพิ่มลาเต้ 2 แก้ว");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^ยืนยัน:/ }));
    });

    expect(pos.qty()).toBe(2);
    expect(screen.queryByTestId("voice-standby-proposal")).toBeNull();
  });

  it("พูดว่า “ยืนยัน” ก็ทำงานเหมือนกดปุ่ม", async () => {
    const pos = renderVoicePos();
    await pos.wakeAndSay("เพิ่มลาเต้ 2 แก้ว");

    await pos.wakeAndSay("ยืนยัน");

    expect(pos.qty()).toBe(2);
  });

  it("พูดคำอื่นไม่ใช่การยืนยัน — ตะกร้าต้องไม่ขยับ", async () => {
    const pos = renderVoicePos();
    await pos.wakeAndSay("เพิ่มลาเต้ 2 แก้ว");

    await pos.wakeAndSay("ตกลงว่าจะเอาอย่างนั้น");

    expect(pos.qty()).toBe(0);
  });

  it("กดยกเลิกแล้วตะกร้าต้องไม่ถูกแตะเลย", async () => {
    const pos = renderVoicePos();
    await pos.wakeAndSay("เพิ่มลาเต้ 2 แก้ว");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^ยกเลิก:/ }));
    });

    expect(pos.qty()).toBe(0);
    expect(screen.queryByTestId("voice-standby-proposal")).toBeNull();
  });

  it("ข้อเสนอหมดอายุแล้วยืนยันไม่ได้อีก", async () => {
    let now = 1_000_000;
    const pos = renderVoicePos(() => now);
    await pos.wakeAndSay("เพิ่มลาเต้ 2 แก้ว");

    now += 8_001;
    await pos.wakeAndSay("ยืนยัน");

    expect(pos.qty()).toBe(0);
  });

  it("กด Esc = ยกเลิกข้อเสนอโดยไม่แตะตะกร้า", async () => {
    const pos = renderVoicePos();
    await pos.wakeAndSay("เพิ่มลาเต้ 2 แก้ว");

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });

    expect(pos.qty()).toBe(0);
    expect(screen.queryByTestId("voice-standby-proposal")).toBeNull();
  });

  it("กดปุ่มพูดเองยังทำงานทันทีเหมือนเดิม ไม่มีขั้นตอนยืนยันเพิ่ม", async () => {
    const pos = renderVoicePos();

    await pos.tapAndSay("เพิ่มลาเต้ 2 แก้ว");

    expect(pos.qty()).toBe(2);
    expect(screen.queryByTestId("voice-standby-proposal")).toBeNull();
  });
});
