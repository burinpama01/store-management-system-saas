"use client";

// U10 — Kitchen queue panel ของ unified shell (v0.37.1)
// คิวครัวแบบเรียลไทม์บน U3 shared realtime layer (tracker: dedupe per item / reconnect
// refetch / polling fallback 5s) — ห้ามสร้าง realtime layer ที่สอง
//
// กฎความจริงของข้อมูล (server truth เสมอ):
//   - เริ่มจาก snapshot ที่ server compose ให้ (initialItems)
//   - event จาก realtime เดิน version หน้าเท่านั้น (dedupe ชั้น tracker + ชั้น state)
//   - transition แบบ optimistic: แสดงสถานะเป้าหมายทันที + ส่ง expected fulfillment_version
//     ผ่าน server action → governed RPC (U5)
//   - conflict (up_stale_version / up_invalid_state_transition) → refetch snapshot จาก
//     server action แล้วแสดงตามความจริง — ห้าม overwrite server state ด้วย state ท้องถิ่น
//   - ผลสำเร็จของ action ปรับ version จากผลลัพธ์ RPC เท่านั้น (ถ้า realtime นำ version
//     ใหม่กว่ามาก่อน จะไม่ถอยหลัง)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import {
  createUnifiedPosItemTracker,
  parseOrderItemRealtimePayload,
  type UnifiedPosItemEvent,
} from "@/modules/unified-pos/realtime";
import {
  UNIFIED_POS_ERROR_CODES,
  effectiveItemState,
  type EffectiveItemState,
  type FulfillmentStatus,
} from "@/modules/unified-pos/contracts";
import { advanceKitchenItemAction, fetchKitchenQueueAction } from "./actions";
import { KitchenItemCard } from "./KitchenItemCard";
import { KITCHEN_STATE_LABEL, type UnifiedKitchenItem } from "./kitchen-types";

/** error code ที่ถือเป็น conflict — client ต้อง refetch จาก server ห้ามแก้ท้องถิ่น */
const CONFLICT_CODES: ReadonlySet<string> = new Set([
  UNIFIED_POS_ERROR_CODES.stale_version,
  UNIFIED_POS_ERROR_CODES.invalid_state_transition,
]);

type StateFilter = "all" | EffectiveItemState;
type TableFilter = "all" | string;
type Notice = { tone: "error" | "info"; message: string } | null;

const CONFLICT_NOTICE =
  "รายการนี้ถูกอัปเดตจากเครื่องอื่นก่อนหน้า — โหลดสถานะล่าสุดจากระบบแล้ว ตรวจสอบและกดซ้ำได้อีกครั้ง";

export interface KitchenQueuePanelProps {
  readonly storeId: string;
  readonly initialItems: readonly UnifiedKitchenItem[];
}

export function KitchenQueuePanel({ storeId, initialItems }: KitchenQueuePanelProps) {
  const [items, setItems] = useState<UnifiedKitchenItem[]>(() => [...initialItems]);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [live, setLive] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [tableFilter, setTableFilter] = useState<TableFilter>("all");

  // latest-ref ให้ event callback อ่านข้อมูลล่าสุดได้โดยไม่ผูก effect กับ items ทุก render
  const itemsRef = useRef(items);
  const pendingIdsRef = useRef<ReadonlySet<string>>(new Set<string>());
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPending = useCallback((next: ReadonlySet<string>) => {
    pendingIdsRef.current = next;
    setPendingIds(next);
  }, []);

  /**
   * ดึง snapshot จาก server (ผ่าน server action เดียวกับ initial data)
   * ความผิดพลาดของ background refetch (offline/ชั่วคราว) เงียบไว้ — polling/reconnect
   * รอบถัดไปจะลองใหม่เอง; ส่วน error ของการกดปุ่มมี toast ของตัวเอง
   */
  const refetchNow = useCallback(async () => {
    try {
      const result = await fetchKitchenQueueAction();
      if (result.error) return;
      setItems(result.items); // server truth — ทับ state ท้องถิ่นทั้งชุด
    } catch {
      // offline/pending navigation — รอรอบถัดไป (poll 5s / reconnect / window online)
    }
  }, []);

  /** debounce ของ refetch — collapse event ที่พุ่งพร้อมกัน (เช่น INSERT หลายแถว) */
  const scheduleRefetch = useCallback(
    (delayMs: number) => {
      if (refetchTimer.current !== null) return; // มีตัวรออยู่แล้ว
      refetchTimer.current = setTimeout(() => {
        refetchTimer.current = null;
        void refetchNow();
      }, delayMs);
    },
    [refetchNow],
  );

  const handleRealtimeEvent = useCallback(
    (event: UnifiedPosItemEvent) => {
      if (event.eventType === "DELETE") {
        // แถวถูกลบ (เช่น cascade ตอนยกเลิกออร์เดอร์) — snapshot เท่านั้นที่รู้ความจริงทั้งชุด
        scheduleRefetch(0);
        return;
      }
      const existing = itemsRef.current.find((it) => it.itemId === event.itemId);
      if (!existing) {
        // item ที่ยังไม่เคยเห็น (เช่น INSERT จากออเดอร์ที่เพิ่งส่ง) — ดึง snapshot รอบเดียว
        scheduleRefetch(100);
        return;
      }
      // dedupe ชั้น state (tracker กัน stale ให้ชั้นแรกแล้ว) — ยอมรับเฉพาะ version ใหม่กว่า
      setItems((current) =>
        current.map((it) => {
          if (it.itemId !== event.itemId) return it;
          if (event.fulfillmentVersion <= it.fulfillmentVersion) return it;
          // envelope 7 field ไม่มี voided_reason — คงเหตุผลเดิมไว้จน snapshot ถัดไป
          return {
            ...it,
            fulfillmentStatus: event.fulfillmentStatus,
            voided: event.voided,
            fulfillmentVersion: event.fulfillmentVersion,
          };
        }),
      );
    },
    [scheduleRefetch],
  );

  // U3 wiring — channel เดียวต่อ panel, tracker จัดการ dedupe/reconnect/poll ให้
  useEffect(() => {
    const client = getSupabaseBrowserClient();
    const tracker = createUnifiedPosItemTracker({
      onItemEvent: handleRealtimeEvent,
      // reconnect (DISCONNECTED → SUBSCRIBED) — ต้อง refetch เพราะอาจพลาด event ระหว่างหลุด
      onSnapshotRefetchRequired: () => scheduleRefetch(0),
      // polling fallback ทุก 5s ขณะไม่ SUBSCRIBED (มาจาก tracker — ไม่ duplicate timer เอง)
      onPollTick: () => scheduleRefetch(0),
    });

    const channel = client.channel("unified-pos-kitchen-order-items");
    channel.on(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "postgres_changes" as any,
      { event: "*", schema: "public", table: "order_items" },
      (payload: unknown) => {
        // order_items ไม่มีคอลัมน์ store_id — storeId มาจาก context (RLS scope ผ่าน orders)
        const event = parseOrderItemRealtimePayload(payload, { storeId });
        if (event) tracker.handleEvent(event);
      },
    );
    channel.subscribe((status: string) => {
      if (status === "SUBSCRIBED") {
        setLive(true);
        tracker.setConnectionStatus("SUBSCRIBED");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        setLive(false);
        tracker.setConnectionStatus("DISCONNECTED");
      }
    });

    // เสริมความทนทาน: browser แจ้งว่าเน็ตกลับมา → ดึง snapshot ทันที
    // (ครอบเคส channel status ของ supabase-js กลับมาช้ากว่าการเชื่อมเน็ตจริง)
    const onOnline = () => scheduleRefetch(0);
    window.addEventListener("online", onOnline);

    return () => {
      window.removeEventListener("online", onOnline);
      if (refetchTimer.current !== null) {
        clearTimeout(refetchTimer.current);
        refetchTimer.current = null;
      }
      void client.removeChannel(channel).catch(() => {});
      tracker.dispose();
    };
  }, [storeId, handleRealtimeEvent, scheduleRefetch]);

  /** revert optimistic — แต่ห้ามถอย version ที่ realtime นำมาให้แล้ว (server truth ชนะ) */
  const revertToSnapshot = useCallback((item: UnifiedKitchenItem) => {
    setItems((current) =>
      current.map((it) => {
        if (it.itemId !== item.itemId) return it;
        if (it.fulfillmentVersion > item.fulfillmentVersion) return it;
        return item;
      }),
    );
  }, []);

  const handleAdvance = useCallback(
    (item: UnifiedKitchenItem, to: FulfillmentStatus) => {
      if (pendingIdsRef.current.has(item.itemId)) return; // กันดับเบิ้ล action
      const pending = new Set(pendingIdsRef.current);
      pending.add(item.itemId);
      setPending(pending);

      // optimistic — แสดงสถานะเป้าหมายทันที (version ยังไม่เปลี่ยนจน server ยืนยัน)
      setItems((current) =>
        current.map((it) => (it.itemId === item.itemId ? { ...it, fulfillmentStatus: to } : it)),
      );

      void (async () => {
        let result: Awaited<ReturnType<typeof advanceKitchenItemAction>>;
        try {
          result = await advanceKitchenItemAction(item.orderId, item.itemId, item.fulfillmentVersion, to);
        } catch {
          // เช่น offline — revert ท้องถิ่นแล้วให้ polling/reconnect ดึงความจริงเอง
          revertToSnapshot(item);
          setNotice({ tone: "error", message: "เชื่อมต่อระบบไม่ได้ — สัญญาณกลับมาแล้วจะโหลดสถานะล่าสุดให้เอง" });
          setPending(removePending(pendingIdsRef.current, item.itemId));
          return;
        }

        if (result.ok) {
          setItems((current) =>
            current.map((it) => {
              if (it.itemId !== item.itemId) return it;
              // realtime อาจนำ version ใหม่กว่ามาก่อนผล action — ห้ามถอยหลัง
              if (result.fulfillmentVersion < it.fulfillmentVersion) return it;
              return {
                ...it,
                fulfillmentStatus: result.fulfillmentStatus,
                fulfillmentVersion: result.fulfillmentVersion,
              };
            }),
          );
        } else if (CONFLICT_CODES.has(result.code)) {
          // conflict — refetch จาก server และแสดงตามความจริง (ห้าม overwrite ด้วย state ท้องถิ่น)
          setNotice({ tone: "info", message: CONFLICT_NOTICE });
          await refetchNow();
        } else {
          revertToSnapshot(item);
          setNotice({ tone: "error", message: result.message || "เปลี่ยนสถานะไม่สำเร็จ กรุณาลองใหม่" });
        }
        setPending(removePending(pendingIdsRef.current, item.itemId));
      })();
    },
    [refetchNow, setPending, revertToSnapshot],
  );

  // ── derived view ────────────────────────────────────────────────────────────
  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const timeDiff = new Date(a.orderCreatedAt).getTime() - new Date(b.orderCreatedAt).getTime();
      if (timeDiff !== 0) return timeDiff; // เก่าสุดก่อนตามคิวครัว
      if (a.orderNumber !== b.orderNumber) return a.orderNumber < b.orderNumber ? -1 : 1;
      return a.itemId < b.itemId ? -1 : 1;
    });
  }, [items]);

  const tableOptions = useMemo(() => {
    const numbers = new Set<string>();
    for (const item of items) numbers.add(item.tableNumber ?? "-");
    return [...numbers].sort((a, b) => a.localeCompare(b, "th", { numeric: true }));
  }, [items]);

  const visibleItems = useMemo(
    () =>
      sortedItems.filter((item) => {
        if (stateFilter !== "all" && effectiveItemState(item) !== stateFilter) return false;
        if (tableFilter !== "all" && (item.tableNumber ?? "-") !== tableFilter) return false;
        return true;
      }),
    [sortedItems, stateFilter, tableFilter],
  );

  return (
    <section aria-label="คิวครัวแบบเรียลไทม์" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id="unified-kitchen-title" className="text-sm font-semibold text-gray-700">
            คิวครัว
          </h2>
          <span
            title={
              live
                ? "เชื่อมต่อเรียลไทม์สำเร็จ"
                : "ไม่ได้เชื่อมต่อเรียลไทม์ — สำรองด้วยการโหลดสถานะซ้ำทุก 5 วินาที"
            }
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
              live ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${live ? "bg-green-500 animate-pulse" : "bg-gray-400"}`}
            />
            {live ? "เรียลไทม์" : "ออฟไลน์"}
          </span>
        </div>
        <p aria-live="polite" className="text-xs text-gray-500">
          แสดง {visibleItems.length} จาก {items.length} รายการ
        </p>
      </div>

      {notice ? (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={`flex items-start justify-between gap-2 rounded-lg px-3 py-2 text-sm ${
            notice.tone === "error" ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-700"
          }`}
        >
          <p>{notice.message}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="min-h-8 shrink-0 rounded-md border border-current/30 px-2 py-0.5 text-xs hover:bg-white/60"
          >
            ปิด
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-3">
        <label className="space-y-1">
          <span className="block text-xs font-semibold uppercase tracking-wide text-gray-500">สถานะ</span>
          <select
            className="form-input min-h-10"
            value={stateFilter}
            onChange={(event) => setStateFilter(event.target.value as StateFilter)}
          >
            <option value="all">ทุกสถานะ</option>
            {(Object.keys(KITCHEN_STATE_LABEL) as EffectiveItemState[]).map((state) => (
              <option key={state} value={state}>
                {KITCHEN_STATE_LABEL[state]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-xs font-semibold uppercase tracking-wide text-gray-500">โต๊ะ</span>
          <select
            className="form-input min-h-10"
            value={tableFilter}
            onChange={(event) => setTableFilter(event.target.value)}
          >
            <option value="all">ทุกโต๊ะ</option>
            {tableOptions.map((number) => (
              <option key={number} value={number}>
                {number === "-" ? "ไม่ระบุโต๊ะ" : `โต๊ะ ${number}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {sortedItems.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-400">
          ยังไม่มีรายการในคิวครัว — ออร์เดอร์ที่ส่งจาก QR หรือหน้าร้านจะขึ้นที่นี่แบบเรียลไทม์
        </p>
      ) : visibleItems.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-400">
          ไม่มีรายการที่ตรงกับตัวกรอง
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visibleItems.map((item) => (
            <KitchenItemCard
              key={item.itemId}
              item={item}
              pending={pendingIds.has(item.itemId)}
              onAdvance={handleAdvance}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function removePending(current: ReadonlySet<string>, itemId: string): ReadonlySet<string> {
  const next = new Set(current);
  next.delete(itemId);
  return next;
}
