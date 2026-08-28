"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * F0 · Task 4 — Device-aware entry (client side)
 *
 * server (`landingPathsForCurrentUser` ใน guards.ts) คำนวณ map ของหน้าแรก
 * ตามสิทธิ์มาให้แล้ว — client จำแนกอุปกรณ์ครั้งเดียวด้วย matchMedia แล้ว replace
 * ไปตาม map เท่านั้น ห้ามรับ/ส่ง redirect URL ที่ client สร้างเอง
 *
 * หมายเหตุ boundary: type/lookup ด้านล่างเทียบเท่า `selectLandingPath` + `EntryFormFactor`
 * ใน `src/modules/auth/guards.ts` แต่ต้องประกาศซ้ำที่นี่เพราะ guards.ts เป็น server module
 * (นำเข้า next/headers + Supabase server client) — ห้าม import เข้า client bundle
 */
type EntryFormFactor = "mobile" | "tablet" | "desktop";
type LandingPaths = Readonly<Record<EntryFormFactor, string>>;

/**
 * จำแนก form factor จาก matchMedia ด้วย breakpoint contract เดียวทั้งระบบ:
 * mobile <768 · tablet 768–1279 · desktop ≥1280
 */
function pickFormFactor(match: (query: string) => boolean): EntryFormFactor {
  if (match("(min-width: 1280px)")) return "desktop";
  if (match("(min-width: 768px)")) return "tablet";
  return "mobile";
}

/** no-JS/redirect fail: แสดงลิงก์ fallback (= หน้าแรกแบบเดิมจาก server) เสมอ */
export function DeviceAwareEntry({ paths, fallback }: { paths: LandingPaths; fallback: string }) {
  const router = useRouter();
  const [replaced, setReplaced] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const media = (query: string) => window.matchMedia(query).matches;
    const form = pickFormFactor(media);
    router.replace(paths[form]);
    setReplaced(true);
  }, [paths, router]);

  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100dvh", padding: "1rem" }}>
      <p style={{ display: "grid", gap: "0.75rem", justifyItems: "center", textAlign: "center" }}>
        {replaced ? "กำลังเปิดหน้าของคุณ…" : "กำลังตรวจอุปกรณ์…"}
        <a
          href={fallback}
          style={{ color: "var(--tenant-primary, #0f766e)", fontWeight: 700, minHeight: "2.75rem", display: "inline-flex", alignItems: "center" }}
        >
          ไปหน้าแรกต่อ หากไม่ย้ายไปเอง
        </a>
      </p>
    </main>
  );
}
