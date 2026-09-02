"use client";

// U15 — สะพานเดียวระหว่างปุ่มเสียง (อยู่ที่ header ของ shell) กับตะกร้าของหน้าขาย
// (PosTerminal ถูก compose มาเป็น children ของ shell จึงอยู่ใต้ provider นี้เสมอเมื่อ flag เปิด)
//
// ข้อบังคับ:
//   - เสียงห้ามมีตะกร้าเป็นของตัวเอง — อ่าน/เขียนผ่าน API ที่หน้าขายลงทะเบียนไว้เท่านั้น
//   - ไม่มี provider (เส้นทาง legacy) = hook ทั้งหมดเป็น no-op ไม่พังและไม่เปลี่ยนพฤติกรรมเดิม

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { Cart } from "@/modules/pos/types";
import type { Product } from "@/modules/catalog/types";

export interface VoiceCartSnapshot {
  readonly cart: Cart;
  readonly products: readonly Product[];
  /** ตะกร้าถูกล็อก (สร้างออร์เดอร์แล้ว/กำลังชำระ) */
  readonly locked: boolean;
}

export interface VoiceCartApi {
  readonly getSnapshot: () => VoiceCartSnapshot;
  /** ใช้สัญญาเดิมของหน้าขาย (commitCart) — เสียงไม่ตั้ง state เอง */
  readonly commit: (cart: Cart) => void;
  /** ล้างคำค้นหาในหน้าขาย ถ้าหน้านั้นมีช่องค้นหา */
  readonly clearSearch?: () => void;
}

interface VoiceCartBridgeValue {
  readonly register: (api: VoiceCartApi | null) => void;
  readonly getApi: () => VoiceCartApi | null;
}

const VoiceCartBridgeContext = createContext<VoiceCartBridgeValue | null>(null);

export function VoiceCartBridgeProvider({ children }: { readonly children: ReactNode }) {
  const apiRef = useRef<VoiceCartApi | null>(null);
  const value = useMemo<VoiceCartBridgeValue>(
    () => ({
      register: (api) => {
        apiRef.current = api;
      },
      getApi: () => apiRef.current,
    }),
    [],
  );
  return <VoiceCartBridgeContext.Provider value={value}>{children}</VoiceCartBridgeContext.Provider>;
}

/** หน้าขายเรียกเพื่อบอกว่า "ตะกร้าอยู่ที่นี่" — ไม่มี provider = ไม่ทำอะไรเลย */
export function useRegisterVoiceCart(api: VoiceCartApi | null): void {
  const bridge = useContext(VoiceCartBridgeContext);
  useEffect(() => {
    if (!bridge) return;
    bridge.register(api);
    return () => bridge.register(null);
  }, [bridge, api]);
}

/** ฝั่งเสียงเรียกเพื่อขอ API ล่าสุด (null = หน้าขายยังไม่พร้อม) */
export function useVoiceCartApi(): () => VoiceCartApi | null {
  const bridge = useContext(VoiceCartBridgeContext);
  return useMemo(() => () => bridge?.getApi() ?? null, [bridge]);
}
