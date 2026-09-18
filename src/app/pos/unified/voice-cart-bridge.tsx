"use client";

// U15 — สะพานเดียวระหว่างปุ่มเสียง (อยู่ที่ header ของ shell) กับตะกร้าของหน้าขาย
// (PosTerminal ถูก compose มาเป็น children ของ shell จึงอยู่ใต้ provider นี้เสมอเมื่อ flag เปิด)
//
// ข้อบังคับ:
//   - เสียงห้ามมีตะกร้าเป็นของตัวเอง — อ่าน/เขียนผ่าน API ที่หน้าขายลงทะเบียนไว้เท่านั้น
//   - ไม่มี provider (เส้นทาง legacy) = hook ทั้งหมดเป็น no-op ไม่พังและไม่เปลี่ยนพฤติกรรมเดิม

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { Cart } from "@/modules/pos/types";
import type { Product } from "@/modules/catalog/types";

export interface VoiceCartSnapshot {
  readonly cart: Cart;
  readonly products: readonly Product[];
  /** ตะกร้าถูกล็อก (สร้างออร์เดอร์แล้ว/กำลังชำระ) */
  readonly locked: boolean;
}

/** ตัวเลือกที่ dialog ของสินค้ากำลังรออยู่ (U21) */
export interface VoicePickerSnapshot {
  readonly productName: string;
  /** ยังต้องเลือกอะไรอีกไหมถึงจะกดเพิ่มได้ */
  readonly needsVariant: boolean;
  readonly missingRequiredGroups: readonly string[];
  readonly choices: readonly string[];
  /**
   * ตัวเลือกของเฉพาะ "สิ่งที่ยังต้องเลือกจริง" — กลุ่มที่มีค่าเริ่มต้นให้แล้ว
   * (เช่น ความหวาน 100%) ต้องไม่ถูกอ่านออกมา ไม่งั้นเสียงจะสั่งให้เลือกสิ่งที่
   * เลือกไว้อยู่แล้ว ทำให้พนักงานสับสนว่ายังขาดอะไรกันแน่
   */
  readonly pendingChoices: readonly string[];
}

export interface VoiceCartApi {
  readonly getSnapshot: () => VoiceCartSnapshot;
  /** ใช้สัญญาเดิมของหน้าขาย (commitCart) — เสียงไม่ตั้ง state เอง */
  readonly commit: (cart: Cart) => void;
  /** ล้างคำค้นหาในหน้าขาย ถ้าหน้านั้นมีช่องค้นหา */
  readonly clearSearch?: () => void;
  /** U21 — เปิดแผงตะกร้า/ออเดอร์ (ปุ่มเดียวกับที่พนักงานกดบนมือถือ) */
  readonly openOrderPanel?: () => void;
  /** U21 — เปิด dialog ของสินค้า (ใช้เมื่อสินค้ามีตัวเลือกบังคับ) */
  readonly openProduct?: (productId: string) => boolean;
  /** U21 — สถานะ dialog ตัวเลือกที่เปิดอยู่ (null = ไม่มี) */
  readonly getPicker?: () => VoicePickerSnapshot | null;
  /** U21 — เลือกตัวเลือกจากคำพูด คืนชื่อที่เลือกได้ (null = ไม่ตรงอะไรเลย) */
  readonly selectPickerChoice?: (phrase: string) => string | null;
  /** U21 — ยืนยันเพิ่มลงตะกร้าตามตัวเลือกที่เลือกไว้ */
  readonly confirmPicker?: () => { readonly ok: boolean; readonly message: string };
}

interface VoiceCartBridgeValue {
  readonly register: (api: VoiceCartApi | null) => void;
  readonly getApi: () => VoiceCartApi | null;
  /** แจ้งเมื่อหน้าขายลงทะเบียน/ถอนตะกร้า — ปุ่มที่ขึ้นกับ "ตะกร้าพร้อมไหม" ต้อง render ใหม่ตาม */
  readonly subscribe: (listener: () => void) => () => void;
}

const VoiceCartBridgeContext = createContext<VoiceCartBridgeValue | null>(null);

export function VoiceCartBridgeProvider({ children }: { readonly children: ReactNode }) {
  const apiRef = useRef<VoiceCartApi | null>(null);
  const listenersRef = useRef(new Set<() => void>());
  const value = useMemo<VoiceCartBridgeValue>(
    () => ({
      register: (api) => {
        if (apiRef.current === api) return;
        apiRef.current = api;
        // เดิมเปลี่ยนแค่ ref เงียบ ๆ: ปุ่ม AI Live/ผู้ช่วยอ่านค่าตอน render ก่อนหน้าขายลงทะเบียน
        // แล้วค้างเป็นสีเทา ("หน้าขายยังไม่พร้อม") จนกว่าจะมีอะไรอื่นมาทำให้ render ใหม่
        for (const listener of listenersRef.current) listener();
      },
      getApi: () => apiRef.current,
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
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

const noopSubscribe = () => () => {};

/** ตะกร้าของหน้าขายพร้อมให้ผู้ช่วยใช้หรือยัง — render ใหม่เองเมื่อหน้าขายลงทะเบียน/ถอน */
export function useVoiceCartReady(): boolean {
  const bridge = useContext(VoiceCartBridgeContext);
  const subscribe = useCallback((listener: () => void) => bridge?.subscribe(listener) ?? noopSubscribe(), [bridge]);
  const getSnapshot = useCallback(() => (bridge?.getApi() ?? null) !== null, [bridge]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
