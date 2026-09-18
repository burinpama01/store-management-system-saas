// @vitest-environment jsdom

// ⚠️ ต้องมี header jsdom ทุกครั้ง — static-import @testing-library/* บน node env คือ hang จน timeout
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../setup/react";
import {
  VoiceCartBridgeProvider,
  useRegisterVoiceCart,
  useVoiceCartReady,
  type VoiceCartApi,
} from "@/app/pos/unified/voice-cart-bridge";
import { emptyCart } from "@/modules/pos/cart";

// 2026-09-18 — ปุ่ม AI Live ค้างสีเทาที่เครื่องร้าน: ปุ่มอ่าน "ตะกร้าพร้อมไหม" จาก ref ตอน render
// ถ้าหน้าขายลงทะเบียนตะกร้าทีหลัง ปุ่มไม่รู้และค้างเป็น disabled จนกว่าจะมีอย่างอื่นทำให้ render ใหม่

const api: VoiceCartApi = {
  getSnapshot: () => ({ cart: emptyCart("store"), products: [], locked: false }),
  commit: () => {},
};

function ReadyBadge() {
  return <span data-testid="ready">{useVoiceCartReady() ? "ready" : "not-ready"}</span>;
}

function Sell({ mounted }: { mounted: boolean }) {
  return mounted ? <Registrar /> : null;
}

function Registrar() {
  useRegisterVoiceCart(api);
  return null;
}

function Harness({ mounted }: { mounted: boolean }) {
  return (
    <VoiceCartBridgeProvider>
      <ReadyBadge />
      <Sell mounted={mounted} />
    </VoiceCartBridgeProvider>
  );
}

describe("useVoiceCartReady", () => {
  it("เปลี่ยนเป็นพร้อมเองเมื่อหน้าขายลงทะเบียนทีหลัง และกลับเป็นไม่พร้อมเมื่อหน้าขายถูกถอด", () => {
    const view = render(<Harness mounted={false} />);
    expect(screen.getByTestId("ready").textContent).toBe("not-ready");
    act(() => view.rerender(<Harness mounted />));
    expect(screen.getByTestId("ready").textContent).toBe("ready");
    act(() => view.rerender(<Harness mounted={false} />));
    expect(screen.getByTestId("ready").textContent).toBe("not-ready");
  });

  it("ไม่มี provider (เส้นทางเดิม) = ไม่พร้อม ไม่พัง", () => {
    render(<ReadyBadge />);
    expect(screen.getByTestId("ready").textContent).toBe("not-ready");
  });
});
