// @vitest-environment jsdom
// U15 — Undo 6 วินาที: snapshot คืนตะกร้าใบเดิมเป๊ะ และคำสั่งใหม่ทำให้ token เดิมใช้ไม่ได้
// ⚠️ ต้องมี header jsdom ทุกครั้ง — static-import @testing-library/* บน node env คือ hang จน timeout
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useMemo, useRef, useState } from "react";
import "../setup/react";
import { addToCart, emptyCart } from "@/modules/pos/cart";
import type { Cart } from "@/modules/pos/types";
import type { Product } from "@/modules/catalog/types";
import { VoicePosController } from "@/app/pos/unified/VoicePosController";
import {
  useRegisterVoiceCart,
  VoiceCartBridgeProvider,
  type VoiceCartApi,
} from "@/app/pos/unified/voice-cart-bridge";
import {
  consumeVoiceUndoToken,
  createVoiceUndoToken,
  isVoiceUndoTokenValid,
  VOICE_UNDO_WINDOW_MS,
} from "@/modules/voice-pos/undo";
import type {
  VoiceSpeechAdapter,
  VoiceSpeechHandlers,
  VoiceSpeechSession,
} from "@/modules/voice-pos/speech-adapter";

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

/** หน้าขายจำลอง: ถือ cart จริงและลงทะเบียน API ให้ปุ่มเสียงเหมือน PosTerminal */
function FakeSellSurface({ locked = false }: { readonly locked?: boolean }) {
  const [cart, setCart] = useState<Cart>(() => emptyCart("store-1"));
  const snapshotRef = useRef({ cart, products: [LATTE] as readonly Product[], locked });
  useEffect(() => {
    snapshotRef.current = { cart, products: [LATTE], locked };
  }, [cart, locked]);
  const api = useMemo<VoiceCartApi>(
    () => ({
      getSnapshot: () => snapshotRef.current,
      commit: (next: Cart) => setCart(next),
    }),
    [],
  );
  useRegisterVoiceCart(api);
  return (
    <div>
      <span data-testid="cart-count">{cart.items.length}</span>
      <span data-testid="cart-qty">{cart.items[0]?.quantity ?? 0}</span>
      <span data-testid="cart-total">{cart.total}</span>
    </div>
  );
}

function renderVoicePos(options: { readonly locked?: boolean } = {}) {
  const fake = createFakeAdapter();
  const selectTab = vi.fn();
  render(
    <VoiceCartBridgeProvider>
      <FakeSellSurface locked={options.locked} />
      <VoicePosController
        voiceEnabled
        allowedCommands={[]}
        onSelectTab={selectTab}
        adapter={fake.adapter}
      />
    </VoiceCartBridgeProvider>,
  );
  const speak = (phrase: string) => {
    fireEvent.click(screen.getByTestId("voice-mic"));
    act(() => fake.emitFinal(phrase));
  };
  return { speak, selectTab };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("voice cart + undo (state machine ล้วน)", () => {
  it("token หมดอายุตามหน้าต่าง 6 วินาที", () => {
    const token = createVoiceUndoToken({
      id: "t1",
      previousCart: emptyCart("store-1"),
      label: "เพิ่มลาเต้",
      now: 1000,
    });
    expect(token.expiresAt).toBe(1000 + VOICE_UNDO_WINDOW_MS);
    expect(isVoiceUndoTokenValid(token, 1000 + VOICE_UNDO_WINDOW_MS - 1)).toBe(true);
    expect(isVoiceUndoTokenValid(token, 1000 + VOICE_UNDO_WINDOW_MS)).toBe(false);
  });

  it("ใช้ token หมดอายุ = ไม่คืนตะกร้า และไม่ throw", () => {
    const token = createVoiceUndoToken({ id: "t1", previousCart: emptyCart("store-1"), label: "x", now: 0 });
    expect(consumeVoiceUndoToken(token, VOICE_UNDO_WINDOW_MS + 1).status).toBe("expired");
    expect(consumeVoiceUndoToken(null, 0).status).toBe("expired");
  });

  it("คืนตะกร้าใบเดิมเป๊ะ (snapshot ทั้งใบ)", () => {
    const previous = addToCart(emptyCart("store-1"), { product: LATTE, variant: null, modifiers: [], quantity: 3 });
    const token = createVoiceUndoToken({ id: "t1", previousCart: previous, label: "x", now: 0 });
    const outcome = consumeVoiceUndoToken(token, 1000);
    expect(outcome.status).toBe("restored");
    if (outcome.status === "restored") expect(outcome.cart).toEqual(previous);
  });
});

describe("VoicePosController — voice cart กับ Undo บนหน้าจอ", () => {
  it("voice cart: พูดเพิ่มสินค้า → ตะกร้าเปลี่ยน และมีปุ่มย้อนกลับ", () => {
    const { speak, selectTab } = renderVoicePos();

    speak("เพิ่มลาเต้ 2 แก้ว");

    expect(screen.getByTestId("cart-qty")).toHaveTextContent("2");
    expect(screen.getByTestId("cart-total")).toHaveTextContent("200");
    expect(screen.getByRole("button", { name: /ย้อนกลับ/ })).toBeInTheDocument();
    expect(selectTab).toHaveBeenCalledWith("sell");
  });

  it("undo: กดย้อนกลับแล้วตะกร้ากลับเป็นใบก่อนหน้า และปุ่มหายไป", () => {
    const { speak } = renderVoicePos();

    speak("เพิ่มลาเต้ 2 แก้ว");
    fireEvent.click(screen.getByRole("button", { name: /ย้อนกลับ/ }));

    expect(screen.getByTestId("cart-count")).toHaveTextContent("0");
    expect(screen.queryByRole("button", { name: /ย้อนกลับ/ })).toBeNull();
  });

  it("undo: คำสั่งใหม่ทำให้ token เดิมใช้ไม่ได้ (ย้อนได้แค่ครั้งล่าสุด)", () => {
    const { speak } = renderVoicePos();

    speak("เพิ่มลาเต้ 2 แก้ว");
    speak("เพิ่มอีก 3 ลาเต้");
    expect(screen.getByTestId("cart-qty")).toHaveTextContent("5");

    fireEvent.click(screen.getByRole("button", { name: /ย้อนกลับ/ }));
    // ย้อนได้เฉพาะการเปลี่ยนแปลงล่าสุด → กลับไปที่ 2 ไม่ใช่ 0
    expect(screen.getByTestId("cart-qty")).toHaveTextContent("2");
  });

  it("undo: พ้น 6 วินาทีแล้วปุ่มย้อนกลับหายไปเอง", () => {
    vi.useFakeTimers();
    const { speak } = renderVoicePos();

    speak("เพิ่มลาเต้ 2 แก้ว");
    expect(screen.getByRole("button", { name: /ย้อนกลับ/ })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(VOICE_UNDO_WINDOW_MS + 100);
    });

    expect(screen.queryByRole("button", { name: /ย้อนกลับ/ })).toBeNull();
    expect(screen.getByTestId("cart-qty")).toHaveTextContent("2");
  });

  it("blocked payment: คำสั่งการเงินไม่แตะตะกร้าและไม่มีปุ่มย้อนกลับ", () => {
    const { speak } = renderVoicePos();

    speak("เพิ่มลาเต้ 2 แก้ว");
    fireEvent.click(screen.getByRole("button", { name: /ย้อนกลับ/ }));

    for (const phrase of ["ชำระเงิน", "เช็คบิล", "ล้างตะกร้า", "ให้ส่วนลด 50 บาท"]) {
      speak(phrase);
      expect(screen.getByTestId("cart-count"), phrase).toHaveTextContent("0");
      expect(screen.queryByRole("button", { name: /ย้อนกลับ/ }), phrase).toBeNull();
    }
  });

  it("ตะกร้าถูกล็อก → เสียงแก้ไม่ได้ และแจ้งให้ทำบนหน้าจอ", () => {
    const { speak } = renderVoicePos({ locked: true });

    speak("เพิ่มลาเต้ 2 แก้ว");

    expect(screen.getByTestId("cart-count")).toHaveTextContent("0");
    expect(screen.queryByRole("button", { name: /ย้อนกลับ/ })).toBeNull();
  });

  it("ไม่พบสินค้า → ตะกร้าไม่เปลี่ยนและไม่มี token ค้าง", () => {
    const { speak } = renderVoicePos();

    speak("เพิ่มยานอวกาศ");

    expect(screen.getByTestId("cart-count")).toHaveTextContent("0");
    expect(screen.queryByRole("button", { name: /ย้อนกลับ/ })).toBeNull();
  });
});
