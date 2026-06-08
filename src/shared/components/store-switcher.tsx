"use client";

import { useTransition } from "react";
import { setCurrentStore } from "@/app/(dashboard)/actions";
import type { Database } from "@/server/integrations/supabase/database.types";

type StoreRow = Database["public"]["Tables"]["stores"]["Row"];

interface Props {
  stores: StoreRow[];
  currentStoreId: string;
}

export function StoreSwitcher({ stores, currentStoreId }: Props) {
  const [isPending, startTransition] = useTransition();

  if (stores.length === 0) {
    return <span className="text-sm text-[var(--color-text-muted)]">ไม่มีร้านค้า</span>;
  }

  if (stores.length === 1) {
    return (
      <span className="store-switch max-w-full">
        <span className="store-dot">S</span>
        <span className="store-meta">
          <b>{stores[0].name}</b>
          <span>สาขาปัจจุบัน</span>
        </span>
      </span>
    );
  }

  return (
    <span className="store-switch max-w-full">
      <span className="store-dot">S</span>
      <span className="store-meta">
        <b>เลือกร้าน</b>
        <span>{stores.length} สาขา</span>
      </span>
      <select
        value={currentStoreId}
        disabled={isPending}
        onChange={(e) => {
          const id = e.target.value;
          startTransition(async () => {
            await setCurrentStore(id);
          });
        }}
        className="min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-sm font-bold text-[var(--ink)] shadow-none disabled:opacity-50"
      >
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </span>
  );
}
