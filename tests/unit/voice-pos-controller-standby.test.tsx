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
import type { VoiceFeedback } from "@/modules/voice-pos/feedback";

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
    setStandby: (enabled: boolean) => calls.push(`setStandby:${enabled}`),
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

/**
 * ตัวเล่นเสียงจำลองที่ "ยังพูดไม่จบ" จนกว่าจะสั่ง — ของจริงใช้เวลาหลายวินาที
 * และไมค์จะเปิดอีกครั้งก็ต่อเมื่อพูดจบ ซึ่งเป็นหัวใจของเรื่องเวลาที่ทดสอบอยู่
 */
function createFakeFeedback() {
  let pending: (() => void) | null = null;
  return {
    player: {
      cue: () => {},
      speak: (_text: string, onEnd?: () => void) => {
        pending = onEnd ?? null;
      },
      stop: () => {},
    } satisfies VoiceFeedback,
    /** ระบบพูดจบแล้ว → ปุ่มจะเปิดไมค์รอบใหม่ตรงนี้ */
    finishSpeaking: () => {
      const done = pending;
      pending = null;
      done?.();
    },
  };
}

function renderVoicePos(now?: () => number, feedback?: VoiceFeedback) {
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
        feedback={feedback}
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
    /** แยกสองจังหวะ เพื่อทดสอบเวลาที่ผ่านไประหว่าง "ไมค์เปิด" กับ "ผู้ใช้พูดจบ" */
    wake: () => act(() => host.wake()),
    say: async (phrase: string) => act(async () => speech.emitFinal(phrase)),
    qty: () => Number(screen.getByTestId("cart-qty").textContent),
  };
}

describe("VoicePosController — คำสั่งจากคำปลุก", () => {
  it("คำสั่งเพิ่มของจากคำปลุกลงมือทันที ไม่มีขั้นยืนยันคั่นอีกแล้ว", async () => {
    // การ์ดยืนยัน 8 วินาทีถูกถอดออก: ระบบพูดข้อเสนอออกลำโพงก่อนแล้วค่อยเปิดไมค์
    // พอพูดจบเวลาก็เกือบหมด คนที่มือไม่ว่างจึงยืนยันไม่ทันแทบทุกครั้ง
    const pos = renderVoicePos();

    await pos.wakeAndSay("เพิ่มลาเต้ 2 แก้ว");

    expect(pos.qty()).toBe(2);
    expect(screen.queryByTestId("voice-standby-proposal")).toBeNull();
    // สิ่งที่มาแทนความปลอดภัยของการยืนยันคือการย้อนกลับ ซึ่งต้องมีให้เห็นทันที
    expect(screen.getByRole("button", { name: /^ย้อนกลับ:/ })).toBeTruthy();
  });

  it("พูดว่า “ย้อนกลับ” แล้วตะกร้าต้องกลับเป็นใบเดิม", async () => {
    const pos = renderVoicePos();
    await pos.wakeAndSay("เพิ่มลาเต้ 2 แก้ว");

    await pos.wakeAndSay("ย้อนกลับ");

    expect(pos.qty()).toBe(0);
  });

  it("พูดว่า “ยกเลิก” ก็ย้อนกลับได้ ทั้งที่ parser ถือเป็นคำต้องห้าม", async () => {
    // "ยกเลิก" อยู่ใน denylist (tier D) ถ้าปล่อยให้ไหลตามปกติจะกลายเป็น
    // "คำสั่งนี้ต้องทำบนหน้าจอ" แทนที่จะย้อนตะกร้า — ต้องอ่านคำสั่งย้อนก่อนเสมอ
    const pos = renderVoicePos();
    await pos.wakeAndSay("เพิ่มลาเต้ 2 แก้ว");

    await pos.wakeAndSay("ยกเลิก");

    expect(pos.qty()).toBe(0);
  });

  it("หน้าต่างย้อนกลับเริ่มนับใหม่ตอนไมค์เปิดอีกครั้ง", async () => {
    // นี่คือต้นเหตุเดียวกับที่ทำให้การ์ดยืนยันเดิมใช้ไม่ได้:
    // นาฬิกาเดินอยู่ระหว่างที่ระบบยังพูดผลออกลำโพง ผู้ใช้จึงพูดตอบไม่ทัน
    let now = 1_000_000;
    const speaker = createFakeFeedback();
    const pos = renderVoicePos(() => now, speaker.player);
    await pos.wakeAndSay("เพิ่มลาเต้ 2 แก้ว");

    now += 5_000;              // ระบบพูดผลออกลำโพงจนเกือบหมดหน้าต่างเดิม (6 วินาที)
    act(() => speaker.finishSpeaking()); // พูดจบ → ไมค์เปิดอีกครั้ง → เริ่มนับใหม่
    now += 4_000;              // ผู้ใช้พูดจบ — เกิน 6 วินาทีนับจากตอนแก้ตะกร้าไปแล้ว
    await pos.say("ย้อนกลับ");

    expect(pos.qty()).toBe(0);
  });

  it("ต่อเวลาได้ครั้งเดียว — ตะกร้าที่แก้ไปนานแล้วต้องย้อนไม่ได้", async () => {
    let now = 1_000_000;
    const speaker = createFakeFeedback();
    const pos = renderVoicePos(() => now, speaker.player);
    await pos.wakeAndSay("เพิ่มลาเต้ 2 แก้ว");

    now += 5_000;
    act(() => speaker.finishSpeaking()); // ต่อเวลาครั้งแรก
    await pos.say("อะไรสักอย่างที่ไม่ใช่คำสั่ง");
    now += 5_000;
    act(() => speaker.finishSpeaking()); // ครั้งที่สองต้องไม่ต่อให้อีก
    now += 4_000;
    await pos.say("ย้อนกลับ");

    expect(pos.qty()).toBe(2);
  });

  it("สั่งจากคำปลุกแล้วต้องเปิดไมค์ต่อ เพื่อสั่งคำถัดไปโดยไม่ต้องแตะจอ", async () => {
    // หัวใจของฟีเจอร์: คนที่มือไม่ว่างต้องจบงานด้วยเสียงล้วน
    const pos = renderVoicePos();

    await pos.wakeAndSay("เพิ่มลาเต้ 2 แก้ว");

    expect(pos.host.calls).toContain("extended:sess000001");
    expect(pos.host.calls).not.toContain("ended:sess000001:completed");
  });

  it("กดปุ่มพูดเองยังทำงานทันทีเหมือนเดิม", async () => {
    const pos = renderVoicePos();

    await pos.tapAndSay("เพิ่มลาเต้ 2 แก้ว");

    expect(pos.qty()).toBe(2);
    expect(screen.queryByTestId("voice-standby-proposal")).toBeNull();
  });

  it("คำสั่งต้องห้ามยังถูกปฏิเสธเหมือนเดิม แม้ไม่มีขั้นยืนยันแล้ว", async () => {
    const pos = renderVoicePos();

    await pos.wakeAndSay("ชำระเงิน");

    expect(pos.qty()).toBe(0);
  });
});
