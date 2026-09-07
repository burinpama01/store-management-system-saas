"use client";

import { useEffect, useRef, useState } from "react";
import type { ShopScene } from "./landing-shop-scene";

export function LandingPlayground() {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<ShopScene | null>(null);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    let disposed = false;
    let loading = false;
    let inRange = false;
    let generation = 0;
    function stop() {
      generation++;
      scene.current?.dispose();
      scene.current = null;
      setReady(false);
    }
    async function load() {
      if (disposed || loading || scene.current || motion.matches || connection?.saveData || !inRange) return;
      loading = true;
      const current = generation;
      try {
        const { createShopScene } = await import("./landing-shop-scene");
        if (disposed || current !== generation || motion.matches) return;
        scene.current = createShopScene(container!);
        setPaused(false);
        setReady(true);
      } catch {
        // WebGL is optional: keep the complete HTML illustration and all page content.
        stop();
      } finally { loading = false; }
    }
    const observer = new IntersectionObserver(([entry]) => {
      inRange = entry.isIntersecting;
      if (inRange) void load();
    }, { rootMargin: "120px" });
    observer.observe(container);
    const onMotion = () => { if (motion.matches) stop(); else void load(); };
    const onUnavailable = () => stop();
    motion.addEventListener("change", onMotion);
    container.addEventListener("shop-scene-unavailable", onUnavailable);
    return () => {
      disposed = true;
      generation++;
      observer.disconnect();
      motion.removeEventListener("change", onMotion);
      container.removeEventListener("shop-scene-unavailable", onUnavailable);
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  return (
    <div className="play-playground" role="group" aria-label="ร้านจำลองสามมิติ StoreOS">
      <div className="play-orbit play-orbit-one" aria-hidden="true" />
      <div className="play-orbit play-orbit-two" aria-hidden="true" />
      <span className="play-scene-caption"><i aria-hidden="true" /> ร้านของคุณ เป็นระบบขึ้นได้</span>
      <div className={`play-shop-fallback${ready ? " is-hidden" : ""}`} aria-hidden="true">
        <div className="play-shop-roof" /><div className="play-shop-sign">StoreOS</div>
        <div className="play-shop-awning" /><div className="play-shop-window" /><div className="play-shop-door" />
      </div>
      <div ref={host} className="play-scene" aria-hidden="true" />
      <div className="play-float-card play-order-card"><span className="play-card-symbol" aria-hidden="true">✓</span><div><strong>รับออเดอร์ได้ทันที</strong><span>จากโต๊ะ ส่งตรงถึงครัว</span></div></div>
      <div className="play-float-card play-report-card"><span className="play-mini-chart" aria-hidden="true"><i /><i /><i /><i /></span><div><strong>เห็นภาพรวมร้าน</strong><span>ครบทุกวัน ในที่เดียว</span></div></div>
      <span className="play-scene-label">ภาพจำลองร้าน เพื่อให้ลองเล่น</span>
      {ready ? <div className="play-scene-controls" aria-label="ควบคุมมุมมองร้านสามมิติ">
        <button type="button" onClick={() => scene.current?.rotate(-1)} aria-label="หมุนร้านไปทางซ้าย">↶</button>
        <button type="button" onClick={() => scene.current?.rotate(0)}>มุมเริ่มต้น</button>
        <button type="button" onClick={() => scene.current?.rotate(1)} aria-label="หมุนร้านไปทางขวา">↷</button>
        <button type="button" aria-pressed={paused} onClick={() => { const next = !paused; scene.current?.pause(next); setPaused(next); }}>{paused ? "เล่นต่อ" : "หยุดภาพ"}</button>
      </div> : <p className="play-static-note">ร้านเล็ก ร้านใหญ่ จัดการได้ในที่เดียว</p>}
    </div>
  );
}
