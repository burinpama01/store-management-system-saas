"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { selectLandingPath, type EntryFormFactor } from "@/modules/auth/guards";

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

/**
 * Device-aware entry (F0 · Task 4): server ส่ง map ของหน้าแรกตามสิทธิ์มาให้แล้ว
 * (`landingPathsForCurrentUser`) — client แค่จำแนกอุปกรณ์ครั้งเดียวแล้ว replace
 * ไปตาม map ห้ามรับ/ส่ง redirect URL ที่ client สร้างเอง
 *
 * no-JS/redirect fail: แสดงลิงก์ fallback (= หน้าแรกแบบเดิมจาก server) เสมอ
 */
export function DeviceAwareEntry({ paths, fallback }: { paths: LandingPaths; fallback: string }) {
  const router = useRouter();
  const [replaced, setReplaced] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const media = (query: string) => window.matchMedia(query).matches;
    const form = pickFormFactor(media);
    router.replace(selectLandingPath(paths, form));
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
