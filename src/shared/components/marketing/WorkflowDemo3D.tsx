"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import "./workflow-demo-3d.css";

const TITLES = ["หน้าขาย POS", "สั่งอาหารผ่าน QR", "สต็อกสินค้า", "ลงเวลาพนักงาน", "รายงานยอดขาย", "จัดการหลายสาขา"];

function Window({ title, children }: { title: string; children: ReactNode }) {
  return <div className="wf-window"><div className="wf-window-bar"><span className="wf-window-dots"><i /><i /><i /></span><strong>{title}</strong><span>StoreOS</span></div>{children}</div>;
}

function Cup({ light = false }: { light?: boolean }) {
  return <span className={`wf-cup${light ? " wf-cup-light" : ""}`}><i /></span>;
}

function Notice({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return <div className={`wf-notice ${className}`}><span className="wf-check">✓</span><div><strong>{title}</strong><small>{children}</small></div></div>;
}

function PosDemo() {
  return <><Window title="ขายหน้าร้าน"><div className="wf-pos-layout"><div className="wf-pos-menu"><div className="wf-pills"><b>เครื่องดื่ม</b><span>เบเกอรี</span></div><div className="wf-products">{["ลาเต้", "มัทฉะ", "อเมริกาโน", "โกโก้"].map((name, index) => <div className="wf-product" key={name}><div className={`wf-product-art wf-art-${index}`}><Cup light={index % 2 === 0} /></div><strong>{name}</strong><span>฿{[65, 75, 55, 65][index]}</span></div>)}</div></div><div className="wf-receipt"><span className="wf-label">ออเดอร์ #001</span><h4>โต๊ะ 04</h4><div><span>ลาเต้ × 1</span><b>65</b></div><div><span>มัทฉะ × 1</span><b>75</b></div><div className="wf-receipt-total"><span>รวม</span><b>฿140</b></div><span className="wf-button-look">รับชำระเงิน</span></div></div></Window><Notice title="จบการขายในไม่กี่ขั้น">รับออเดอร์ → ชำระ → พิมพ์ใบเสร็จ</Notice></>;
}

function QrDemo() {
  return <><div className="wf-phone"><span className="wf-phone-speaker" /><div className="wf-phone-header"><span>StoreOS CAFE</span><h4>วันนี้รับอะไรดี?</h4><small>โต๊ะ 04 · เมนูของร้าน</small></div><div className="wf-phone-menu">{["ลาเต้เย็น", "มัทฉะลาเต้", "โกโก้เย็น"].map((name, i) => <div key={name}><Cup light={i === 0} /><span><strong>{name}</strong><small>฿{i === 1 ? 75 : 65}</small></span><b>+</b></div>)}</div><div className="wf-phone-cart"><span>ตะกร้า · 2 รายการ</span><strong>฿140 →</strong></div></div><div className="wf-qr-card"><span className="wf-label">แค่สแกน ก็เลือกอร่อยได้</span><div className="wf-qr-art"><svg viewBox="0 0 100 100" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M5 5h28v28H5zm6 6v16h16V11zM67 5h28v28H67zm6 6v16h16V11zM5 67h28v28H5zm6 6v16h16V73z"/><path d="M16 16h6v6h-6zm62 0h6v6h-6zM16 78h6v6h-6zM43 5h10v16H43zm0 27h16v10H43zM5 43h16v10H5zm22 0h10v16H27zm16 5h10v21H43zm16 0h15v10H59zm21-5h15v16H80zM59 65h10v15H59zm16 0h20v10H75zM43 80h10v15H43zm16 5h16v10H59zm22-4h14v14H81z"/></svg></div><strong>สแกน · เลือก · สั่ง</strong><small>QR ภาพประกอบเท่านั้น</small></div><Notice title="ส่งตรงถึงครัว" className="wf-notice-qr">ทีมเห็นออเดอร์เดียวกันทันที</Notice></>;
}

function StockDemo() {
  return <><Window title="สต็อกสินค้า"><div className="wf-stock-summary"><span className="wf-label">Stock Pool ที่ใช้งานอยู่</span><h4>สต็อกกลาง ใช้ร่วมกันได้</h4><span className="wf-status">หลายตัวเลือกสินค้า</span></div><div className="wf-stock-list">{[{name:"น้ำดื่ม",qty:"48",unit:"ขวด",level:78},{name:"นมกล่อง",qty:"24",unit:"กล่อง",level:60},{name:"น้ำส้ม",qty:"4",unit:"ขวด",level:16}].map((item,i)=><div className="wf-stock-row" key={item.name}><span className={`wf-stock-icon wf-art-${i}`}><span /></span><div><strong>{item.name}</strong><div className="wf-meter"><i style={{width:`${item.level}%`}} /></div></div><span><b>{item.qty}</b><small>{item.unit}</small></span></div>)}</div></Window><div className="wf-stock-alert"><span>!</span><div><strong>เตือนสต็อกต่ำ</strong><small>น้ำส้ม · เกณฑ์เตือน 5 ขวด</small></div></div></>;
}

function AttendanceDemo() {
  return <><Window title="การเข้างาน"><div className="wf-attendance"><div className="wf-shift"><span className="wf-label">สถานะวันนี้</span><h4>กำลังทำงาน</h4><strong>เข้างาน 09:00 น.</strong><div className="wf-week">{["จ","อ","พ","พฤ","ศ","ส","อา"].map((day,i)=><span className={i===2?"is-today":""} key={day}>{day}<b>{12+i}</b></span>)}</div></div><div className="wf-staff">{["พนักงาน A","พนักงาน B","พนักงาน C"].map((name,i)=><div key={name}><span className="wf-avatar">{["A","B","C"][i]}</span><span><strong>{name}</strong><small>{["ครบ","มาสาย","ลา"][i]}</small></span><b>{["✓","◷","−"][i]}</b></div>)}</div></div></Window><div className="wf-clock"><span className="wf-clock-hand"/><span className="wf-clock-hand wf-clock-minute"/><i/><b>เวลาเข้างาน</b></div><Notice title="ลงชื่อเข้าและออกงาน">ดูปฏิทิน วันลา และวันหยุดร้าน</Notice></>;
}

function ReportsDemo() {
  return <><Window title="รายงาน"><div className="wf-report-top"><div><span className="wf-label">ยอดขายรวม · ตัวอย่าง 7 วัน</span><h4>฿12,450<span>.00</span></h4></div><span className="wf-status">ส่งออก CSV</span></div><div className="wf-chart"><div className="wf-chart-grid"/>{[38,56,43,74,61,89,78].map((height,i)=><div className="wf-chart-column" key={i}><span style={{height:`${height}%`}}/><small>{["จ","อ","พ","พฤ","ศ","ส","อา"][i]}</small></div>)}</div><div className="wf-report-stats"><span>ออร์เดอร์<b>86</b></span><span>เฉลี่ย/ออร์เดอร์<b>฿144.77</b></span><span>สินค้าขายดี<b>ลาเต้เย็น</b></span></div></Window><div className="wf-report-float"><span className="wf-donut"/><div><span className="wf-label">ช่องทางชำระเงิน</span><strong>เงินสด · โอนเงิน · บัตร</strong></div></div></>;
}

function ShopIcon() {
  return <span className="wf-shop-icon"><i/><b/><em/></span>;
}

function BranchesDemo() {
  return <><div className="wf-branch-network"><div className="wf-branch-hq"><span className="wf-hq-mark">S</span><div><span className="wf-label">สาขาในองค์กร</span><h4>เลือกสาขา</h4><small>สลับจากแถบด้านข้างของระบบ</small></div></div><svg className="wf-branch-lines" viewBox="0 0 440 230" preserveAspectRatio="none" aria-hidden="true"><path d="M220 0V75M65 135V75H375V135M220 75V160"/></svg><div className="wf-branch-nodes">{["สาขา A","สาขา B","สาขา C"].map((name,i)=><div className={`wf-branch-node wf-branch-${i}`} key={name}><ShopIcon/><strong>{name}</strong><span><i/> {i === 0 ? "สาขาปัจจุบัน" : "เปิดใช้งานอยู่"}</span></div>)}</div></div><Notice title="ข้อมูลแยกตามสาขา">ระบบจำสาขาที่กำลังใช้งาน</Notice></>;
}

const DEMOS = [PosDemo, QrDemo, StockDemo, AttendanceDemo, ReportsDemo, BranchesDemo];

export function WorkflowDemo3D({ step }: { step: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    const sync = () => setRunning(visible && !paused && !document.hidden && !motion.matches);
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }, { threshold: 0.15 });
    observer.observe(element);
    document.addEventListener("visibilitychange", sync);
    motion.addEventListener("change", sync);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      motion.removeEventListener("change", sync);
    };
  }, [paused]);
  const Demo = DEMOS[step] ?? PosDemo;
  const title = TITLES[step] ?? TITLES[0];
  return <div ref={container} className={`workflow-demo wf-demo-${step}`} data-running={running} role="group" aria-label={`ภาพจำลอง UI 3D: ${title} ข้อมูลตัวอย่าง`}>
    <div className="wf-demo-ground" aria-hidden="true" />
    <div className="wf-stage" aria-hidden="true"><Demo/></div>
    <div className="wf-demo-caption"><span>UI จำลอง · ข้อมูลตัวอย่าง</span><button className="wf-motion-control" type="button" aria-pressed={paused} onClick={() => { setRunning(false); setPaused(!paused); }}>{paused ? "เล่นอนิเมชันต่อ" : "หยุดอนิเมชัน"}</button></div>
  </div>;
}
