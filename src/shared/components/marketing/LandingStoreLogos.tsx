"use client";

import { useState } from "react";
import type { LandingStore } from "@/modules/stores/landing-repository";

function StoreLogo({ store }: { store: LandingStore }) {
  const [failed, setFailed] = useState(false);
  return (
    <li className="play-store">
      <span className="play-store-logo" aria-hidden="true">
        {store.logoUrl && !failed ? (
          // eslint-disable-next-line @next/next/no-img-element -- uploaded store logos use varied external storage hosts
          <img src={store.logoUrl} alt="" width={48} height={48} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        ) : <span>{Array.from(store.name.trim())[0] ?? "S"}</span>}
      </span>
      <strong>{store.name}</strong>
    </li>
  );
}

export function LandingStoreLogos({ stores }: { stores: LandingStore[] }) {
  if (stores.length === 0) return null;
  return (
    <section className="play-stores" aria-labelledby="store-showcase-title">
      <div className="play-stores-heading">
        <span className="play-eyebrow">เติบโตไปด้วยกัน</span>
        <h2 id="store-showcase-title">ร้านที่กำลังใช้งาน StoreOS</h2>
        <p>ส่วนหนึ่งของร้านที่มีเมนูพร้อมขายและมีออเดอร์ในช่วง 7 วันที่ผ่านมา</p>
      </div>
      <ul>{stores.map((store) => <StoreLogo key={store.slug} store={store} />)}</ul>
    </section>
  );
}
