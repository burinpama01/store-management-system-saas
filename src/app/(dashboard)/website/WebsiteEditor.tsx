"use client";

/* eslint-disable @next/next/no-img-element -- รูปจาก storage ของร้าน */
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type MouseEvent as ReactMouseEvent } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { QrCode } from "@/shared/components/ui/QrCode";
import { uploadStoreImageAction } from "@/modules/storage/image-actions";
import type { StoreWebsite, WebsiteRenderData, WebsiteVersionSummary } from "@/modules/store-website/repository";
import {
  DELIVERY_APPS,
  MAX_BLOCKS,
  SOCIAL_PLATFORMS,
  isAllowedDeliveryUrl,
  parseWebsiteDocument,
  type WebsiteBlock,
  type WebsiteDocument,
} from "@/modules/store-website/schema";
import {
  BLOCK_LABELS,
  DELIVERY_APP_LABELS,
  SOCIAL_LABELS,
  STYLE_LABELS,
  emptyBlock,
  type WebsiteTemplate,
} from "@/modules/store-website/templates";
import { WebsiteRenderer } from "@/modules/store-website/WebsiteRenderer";
import { festivalPreview, type FestivalView } from "@/modules/store-website/festivals";
import { FestivalPanel, type UpcomingFestival } from "./FestivalPanel";
import { PosterEditor } from "./PosterEditor";
import { nowMs } from "@/shared/utils/time";
import {
  applyTemplateThemeAction,
  publishWebsiteAction,
  restoreVersionAction,
  saveDraftAction,
  setWebsiteEnabledAction,
  updateSlugAction,
} from "./actions";

const INPUT = { fontSize: 16 } as const;

function ImageField({ label, value, onChange }: { label: string; value: string; onChange: (url: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function upload(file: File) {
    if (file.size > 5 * 1024 * 1024) {
      setError("ไฟล์ใหญ่เกิน 5MB");
      return;
    }
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("file", file);
    const result = await uploadStoreImageAction(form);
    setBusy(false);
    if (result.error || !result.url) setError(result.error ?? "อัปโหลดไม่สำเร็จ");
    else onChange(result.url);
  }
  return (
    <div className="text-sm">
      <span className="block text-xs text-[var(--color-text-muted)]">{label}</span>
      <div className="mt-1 flex items-center gap-2">
        {value ? <img src={value} alt="" className="h-14 w-20 rounded object-cover" /> : <div className="h-14 w-20 rounded bg-black/5" />}
        <label className="btn-secondary cursor-pointer text-xs">
          {busy ? "กำลังอัปโหลด…" : value ? "เปลี่ยนรูป" : "อัปโหลดรูป"}
          <input type="file" accept="image/*" className="hidden" disabled={busy} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        </label>
        {value && <button type="button" className="text-xs text-red-600" onClick={() => onChange("")}>ลบรูป</button>}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function Text({ label, value, onChange, max, multiline = false, placeholder }: { label: string; value: string; onChange: (v: string) => void; max: number; multiline?: boolean; placeholder?: string }) {
  return (
    <label className="block text-sm">
      <span className="block text-xs text-[var(--color-text-muted)]">{label}</span>
      {multiline ? (
        <textarea className="input mt-1 w-full" style={INPUT} rows={4} maxLength={max} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="input mt-1 w-full" style={INPUT} maxLength={max} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function BlockForm({ block, onChange, renderData }: { block: WebsiteBlock; onChange: (b: WebsiteBlock) => void; renderData: WebsiteRenderData }) {
  switch (block.type) {
    case "hero":
      return (
        <div className="space-y-2">
          <Text label="ชื่อที่แสดง" value={block.title} max={80} onChange={(title) => onChange({ ...block, title })} />
          <Text label="คำโปรย" value={block.subtitle} max={160} onChange={(subtitle) => onChange({ ...block, subtitle })} />
          <ImageField label="รูปปก (แนะนำแนวนอน 1200×628 — ใช้เป็นรูปตอนแชร์ลิงก์ด้วย)" value={block.imageUrl ?? ""} onChange={(imageUrl) => onChange({ ...block, imageUrl })} />
          <Check label="แสดงเวลาปิดร้าน" checked={block.showOpenStatus} onChange={(showOpenStatus) => onChange({ ...block, showOpenStatus })} />
        </div>
      );
    case "banner":
      return (
        <div className="space-y-2">
          <ImageField label="รูปโปรโมชัน / แพ็กเกจ" value={block.imageUrl ?? ""} onChange={(imageUrl) => onChange({ ...block, imageUrl })} />
          <Text label="หัวข้อ" value={block.title} max={80} onChange={(title) => onChange({ ...block, title })} />
          <Text label="รายละเอียด" value={block.subtitle} max={160} onChange={(subtitle) => onChange({ ...block, subtitle })} />
          <label className="block text-sm">
            <span className="block text-xs text-[var(--color-text-muted)]">กดแล้วไปที่</span>
            <select className="input mt-1 w-full" style={INPUT} value={block.link.kind} onChange={(e) => onChange({ ...block, link: { ...block.link, kind: e.target.value as "none" | "menu" | "passes" | "member" | "url" } })}>
              <option value="none">ไม่มีลิงก์</option>
              <option value="menu">เมนู</option>
              <option value="passes">แพ็กล่วงหน้า</option>
              <option value="member">หน้าสมาชิก</option>
              <option value="url">ลิงก์ภายนอก</option>
            </select>
          </label>
          {block.link.kind === "url" && (
            <Text label="ลิงก์ (https://...)" value={block.link.url ?? ""} max={500} onChange={(url) => onChange({ ...block, link: { ...block.link, url } })} />
          )}
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm"><span className="block text-xs text-[var(--color-text-muted)]">เริ่มแสดง</span>
              <input type="date" className="input mt-1 w-full" style={INPUT} value={block.startsOn ?? ""} onChange={(e) => onChange({ ...block, startsOn: e.target.value })} /></label>
            <label className="text-sm"><span className="block text-xs text-[var(--color-text-muted)]">หยุดแสดง</span>
              <input type="date" className="input mt-1 w-full" style={INPUT} value={block.endsOn ?? ""} onChange={(e) => onChange({ ...block, endsOn: e.target.value })} /></label>
          </div>
        </div>
      );
    case "passes":
      return (
        <div className="space-y-2">
          <Text label="หัวข้อ" value={block.title} max={80} onChange={(title) => onChange({ ...block, title })} />
          <p className="text-xs text-[var(--color-text-muted)]">
            แสดงแพ็กที่เปิดขายอยู่ ({renderData.passPlans.length} แพ็ก) — ตั้งแพ็กที่ ลูกค้า › แพ็กซื้อล่วงหน้า · ไม่มีแพ็ก = บล็อกนี้ซ่อนเอง
          </p>
        </div>
      );
    case "menu": {
      const selected = new Set(block.productIds);
      return (
        <div className="space-y-2">
          <Text label="หัวข้อ" value={block.title} max={80} onChange={(title) => onChange({ ...block, title })} />
          <div className="flex gap-3 text-sm">
            <label className="flex items-center gap-1"><input type="radio" checked={block.mode === "featured"} onChange={() => onChange({ ...block, mode: "featured" })} />เลือกเมนูแนะนำ</label>
            <label className="flex items-center gap-1"><input type="radio" checked={block.mode === "all"} onChange={() => onChange({ ...block, mode: "all" })} />แสดงทุกเมนู</label>
          </div>
          <Check label="แสดงราคา" checked={block.showPrices} onChange={(showPrices) => onChange({ ...block, showPrices })} />
          {block.mode === "featured" && (
            <div>
              <p className="text-xs text-[var(--color-text-muted)]">เลือกได้สูงสุด 24 เมนู (ไม่เลือก = 8 เมนูแรก)</p>
              <div className="mt-1 grid max-h-48 gap-1 overflow-y-auto rounded border border-[var(--color-border)] p-2 sm:grid-cols-2">
                {renderData.products.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      disabled={!selected.has(p.id) && block.productIds.length >= 24}
                      onChange={(e) =>
                        onChange({ ...block, productIds: e.target.checked ? [...block.productIds, p.id] : block.productIds.filter((id) => id !== p.id) })
                      }
                    />
                    <span className="truncate">{p.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }
    case "member":
      return (
        <div className="space-y-2">
          <Text label="หัวข้อ" value={block.title} max={80} onChange={(title) => onChange({ ...block, title })} />
          <Text label="คำอธิบาย" value={block.description} max={200} onChange={(description) => onChange({ ...block, description })} />
          {!renderData.memberUrl && <p className="text-xs text-amber-700">ร้านยังไม่ได้สร้าง QR สมาชิก (ลูกค้า › QR สมัครสมาชิก) — บล็อกนี้จะซ่อนจนกว่าจะสร้าง</p>}
        </div>
      );
    case "info":
      return (
        <div className="space-y-2">
          <Check label={`แสดงที่อยู่${renderData.store.address ? "" : " (ยังไม่ได้ตั้งที่ ตั้งค่า › ร้านค้า)"}`} checked={block.showAddress} onChange={(showAddress) => onChange({ ...block, showAddress })} />
          <Check label={`แสดงปุ่มโทร${renderData.store.phone ? "" : " (ยังไม่ได้ตั้งเบอร์)"}`} checked={block.showPhone} onChange={(showPhone) => onChange({ ...block, showPhone })} />
          <Text label="เวลาเปิด-ปิด" value={block.hoursText} max={200} multiline placeholder={"ทุกวัน 08:00–20:00\nหยุดวันพุธ"} onChange={(hoursText) => onChange({ ...block, hoursText })} />
          <Text label="ลิงก์ Google Maps" value={block.mapUrl ?? ""} max={500} placeholder="https://maps.app.goo.gl/..." onChange={(mapUrl) => onChange({ ...block, mapUrl })} />
        </div>
      );
    case "social":
      return (
        <div className="space-y-2">
          {block.links.map((link, index) => (
            <div key={index} className="flex gap-2">
              <select className="input" style={INPUT} value={link.platform}
                onChange={(e) => onChange({ ...block, links: block.links.map((l, i) => (i === index ? { ...l, platform: e.target.value as typeof l.platform } : l)) })}>
                {SOCIAL_PLATFORMS.map((p) => <option key={p} value={p}>{SOCIAL_LABELS[p]}</option>)}
              </select>
              <input className="input min-w-0 flex-1" style={INPUT} value={link.url} placeholder="https://"
                onChange={(e) => onChange({ ...block, links: block.links.map((l, i) => (i === index ? { ...l, url: e.target.value } : l)) })} />
              <button type="button" className="text-xs text-red-600" onClick={() => onChange({ ...block, links: block.links.filter((_, i) => i !== index) })}>ลบ</button>
            </div>
          ))}
          {block.links.length < 8 && (
            <button type="button" className="btn-secondary text-xs" onClick={() => onChange({ ...block, links: [...block.links, { platform: "facebook", url: "" }] })}>+ เพิ่มลิงก์</button>
          )}
        </div>
      );
    case "delivery_apps": {
      const byApp = new Map(block.apps.map((a) => [a.app, a.url]));
      return (
        <div className="space-y-2">
          <Text label="หัวข้อ" value={block.title} max={80} onChange={(title) => onChange({ ...block, title })} />
          <p className="text-xs text-[var(--color-text-muted)]">ใส่ลิงก์หน้าร้านของคุณในแต่ละแอป (เว้นว่าง = ไม่แสดง) — ระบบตรวจว่าเป็นลิงก์ของแอปนั้นจริง</p>
          {DELIVERY_APPS.map((app) => {
            const url = byApp.get(app) ?? "";
            const invalid = url !== "" && !isAllowedDeliveryUrl(app, url);
            return (
              <label key={app} className="block text-sm">
                <span className="block text-xs" style={{ color: DELIVERY_APP_LABELS[app].color }}>{DELIVERY_APP_LABELS[app].name}</span>
                <input className={`input mt-1 w-full ${invalid ? "border-red-400" : ""}`} style={INPUT} value={url} placeholder="https://"
                  onChange={(e) => {
                    const next = e.target.value.trim();
                    const rest = block.apps.filter((a) => a.app !== app);
                    onChange({ ...block, apps: next ? [...rest, { app, url: next }] : rest });
                  }} />
                {invalid && <span className="text-xs text-red-600">ไม่ใช่ลิงก์ของ {DELIVERY_APP_LABELS[app].name}</span>}
              </label>
            );
          })}
        </div>
      );
    }
    case "text":
      return (
        <div className="space-y-2">
          <Text label="หัวข้อ" value={block.title} max={80} onChange={(title) => onChange({ ...block, title })} />
          <Text label="ข้อความ" value={block.body} max={1500} multiline onChange={(body) => onChange({ ...block, body })} />
        </div>
      );
    case "poster":
      return <PosterEditor block={block} onChange={onChange} ImageField={ImageField} />;
  }
}

/** ย่อจอกว้างด้วย transform (ใช้ได้ทุกเบราว์เซอร์) แล้วตั้งความสูงกล่องตามเนื้อหาจริง */
function ScaledPreview({ width, scale, children }: { width: number; scale: number; children: React.ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setHeight(el.offsetHeight * scale);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scale]);
  return (
    <div style={{ height, overflow: "hidden" }}>
      <div ref={innerRef} style={{ width, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        {children}
      </div>
    </div>
  );
}

async function downloadQr(url: string, filename: string) {
  const dataUrl = await QRCode.toDataURL(url, { width: 1024, margin: 2, errorCorrectionLevel: "M" });
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

export function WebsiteEditor({
  website,
  renderData,
  templates,
  versions,
  siteBase,
  today,
  currentFestival,
  upcomingFestivals,
  pendingLunarKeys,
}: {
  website: StoreWebsite;
  renderData: WebsiteRenderData;
  templates: WebsiteTemplate[];
  versions: WebsiteVersionSummary[];
  siteBase: string;
  today: string;
  /** เทศกาลที่แสดงบนเว็บจริงตอนนี้ (null = ไม่มี) */
  currentFestival: FestivalView | null;
  upcomingFestivals: UpcomingFestival[];
  pendingLunarKeys: string[];
}) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [doc, setDoc] = useState<WebsiteDocument>(website.draft);
  const [dirty, setDirty] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [slug, setSlug] = useState(website.slug);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [previewFestivalKey, setPreviewFestivalKey] = useState<string | null>(null);
  const previewFestival = previewFestivalKey ? festivalPreview(previewFestivalKey, website.festivalSettings) : currentFestival;
  const [pending, startTransition] = useTransition();
  const publicUrl = `${siteBase}/s/${website.slug}`;
  const validation = useMemo(() => parseWebsiteDocument(doc), [doc]);

  // แก้แล้วยังไม่บันทึก → เตือนก่อนปิดแท็บ/รีเฟรช
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // ประวัติการแก้ (เลิกทำ/ทำซ้ำ) — การแก้ต่อเนื่องภายใน 600ms (พิมพ์/ลาก) รวมเป็นขั้นเดียว
  const history = useRef<{ past: WebsiteDocument[]; future: WebsiteDocument[]; lastAt: number }>({ past: [], future: [], lastAt: 0 });
  const [historySize, setHistorySize] = useState({ past: 0, future: 0 });
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  const syncHistory = () => setHistorySize({ past: history.current.past.length, future: history.current.future.length });
  function update(next: WebsiteDocument) {
    const h = history.current;
    const now = nowMs();
    if (now - h.lastAt > 600) h.past = [...h.past.slice(-49), docRef.current];
    h.lastAt = now;
    h.future = [];
    docRef.current = next;
    setDoc(next);
    setDirty(true);
    syncHistory();
  }
  const undo = useCallback(() => {
    const h = history.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future = [docRef.current, ...h.future].slice(0, 50);
    h.lastAt = 0;
    docRef.current = prev;
    setDoc(prev);
    setDirty(true);
    setHistorySize({ past: h.past.length, future: h.future.length });
  }, []);
  const redo = useCallback(() => {
    const h = history.current;
    const [next, ...rest] = h.future;
    if (!next) return;
    h.future = rest;
    h.past = [...h.past.slice(-49), docRef.current];
    h.lastAt = 0;
    docRef.current = next;
    setDoc(next);
    setDirty(true);
    setHistorySize({ past: h.past.length, future: h.future.length });
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // ในช่องพิมพ์ปล่อยให้เบราว์เซอร์เลิกทำตัวอักษรเอง
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (!(event.ctrlKey || event.metaKey) || (key !== "z" && key !== "y")) return;
      event.preventDefault();
      if (key === "y" || event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);
  const [device, setDevice] = useState<"mobile" | "desktop">("mobile");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  function moveTo(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= doc.blocks.length || to >= doc.blocks.length) return;
    const blocks = [...doc.blocks];
    const [item] = blocks.splice(from, 1);
    blocks.splice(to, 0, item);
    update({ ...doc, blocks });
  }
  // แตะบล็อกในพรีวิว → เปิดฟอร์มบล็อกนั้น (ไม่ให้ลิงก์ในพรีวิวพาออกจากหน้า)
  function selectFromPreview(event: ReactMouseEvent<HTMLDivElement>) {
    const el = (event.target as HTMLElement).closest("[data-block-id]");
    const id = el?.getAttribute("data-block-id");
    if ((event.target as HTMLElement).closest("a")) event.preventDefault();
    if (!id) return;
    setOpenId(id);
    window.requestAnimationFrame(() => document.getElementById(`block-row-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }
  function updateBlock(id: string, block: WebsiteBlock) {
    update({ ...doc, blocks: doc.blocks.map((b) => (b.id === id ? block : b)) });
  }
  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= doc.blocks.length) return;
    const blocks = [...doc.blocks];
    [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
    update({ ...doc, blocks });
  }
  function run(task: () => Promise<{ ok: boolean; error: string | null }>, okText: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await task();
      if (!result.ok) setMessage({ tone: "error", text: result.error ?? "ทำรายการไม่สำเร็จ" });
      else {
        setMessage({ tone: "ok", text: okText });
        setDirty(false);
        router.refresh();
      }
    });
  }

  const enabled = website.isEnabled;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
      <div className="space-y-4">
        {/* สถานะ + แชร์ */}
        <div className={`panel space-y-3 p-4 ${enabled ? "border-emerald-300" : ""}`}>
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 font-semibold">
              {enabled ? "🟢 เว็บเปิดอยู่" : "⚪ เว็บปิดอยู่ (ลูกค้ายังไม่เห็น)"}
              {website.publishedAt && <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">เผยแพร่ล่าสุด {new Date(website.publishedAt).toLocaleString("th-TH")}</span>}
            </p>
            <button type="button" className={enabled ? "btn-secondary" : "btn-primary"} disabled={pending || (!enabled && !website.published)}
              onClick={async () => {
                if (enabled && !(await confirm({ title: "ปิดเว็บไซต์ร้าน?", message: "ลูกค้าที่เปิดลิงก์จะเห็นว่าร้านยังไม่เปิดเว็บ", confirmLabel: "ปิดเว็บ", danger: true }))) return;
                run(() => setWebsiteEnabledAction(!enabled), enabled ? "ปิดเว็บแล้ว" : "เปิดเว็บแล้ว");
              }}>
              {enabled ? "ปิดเว็บ" : "เปิดเว็บ"}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-[var(--color-text-muted)]">{siteBase}/s/</span>
            <input className="input w-48" style={INPUT} value={slug} maxLength={40} onChange={(e) => setSlug(e.target.value)} />
            {slug !== website.slug && (
              <button type="button" className="btn-secondary text-xs" disabled={pending} onClick={() => run(() => updateSlugAction(slug), "เปลี่ยนลิงก์แล้ว — ลิงก์เก่าใช้ไม่ได้อีก")}>บันทึกลิงก์</button>
            )}
          </div>
          {website.published && (
            <div className="flex flex-wrap items-center gap-4">
              <QrCode value={publicUrl} size={120} />
              <div className="space-y-2 text-sm">
                <a href={`/s/${website.slug}`} target="_blank" rel="noreferrer" className="block font-semibold text-[var(--color-brand)] underline">{publicUrl}</a>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-secondary text-xs" onClick={() => void navigator.clipboard.writeText(publicUrl).then(() => setMessage({ tone: "ok", text: "คัดลอกลิงก์แล้ว — แปะในเพจ/ไบโอได้เลย" }))}>คัดลอกลิงก์</button>
                  <button type="button" className="btn-secondary text-xs" onClick={() => void downloadQr(publicUrl, `qr-${website.slug}.png`)}>ดาวน์โหลด QR</button>
                </div>
                <p className="text-xs text-[var(--color-text-muted)]">Instagram ใส่ลิงก์ได้ที่ไบโอและสตอรี่ · พิมพ์ QR ติดหน้าร้านได้</p>
              </div>
            </div>
          )}
        </div>

        {/* เทมเพลต */}
        <div className="panel p-4">
          <p className="mb-2 text-sm font-semibold">เทมเพลต (เปลี่ยนสี/ฟอนต์/สไตล์ — เนื้อหาอยู่ครบ)</p>
          <div className="flex flex-wrap gap-2">
            {templates.map((t) => (
              <button key={t.id} type="button" disabled={pending}
                className={`rounded-lg border px-3 py-2 text-left text-xs ${website.templateId === t.id ? "border-[var(--color-brand)] ring-1 ring-[var(--color-brand)]" : "border-[var(--color-border)]"}`}
                onClick={() => startTransition(async () => {
                  const result = await applyTemplateThemeAction(t.id, doc);
                  if (!result.ok || !result.document) setMessage({ tone: "error", text: result.error ?? "เปลี่ยนเทมเพลตไม่สำเร็จ" });
                  else { setDoc(result.document); setDirty(false); setMessage({ tone: "ok", text: `ใช้เทมเพลต ${t.name} แล้ว (ยังต้องกดเผยแพร่)` }); router.refresh(); }
                })}>
                <span className="mr-1 inline-block h-3 w-3 rounded-full align-middle" style={{ background: t.theme.primary }} />
                {t.name} <span className="opacity-60">· {STYLE_LABELS[t.style]}</span>
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-xs">
            {(["primary", "accent", "background", "surface", "text"] as const).map((key) => (
              <label key={key} className="flex items-center gap-1">
                <input type="color" value={doc.theme[key]} onChange={(e) => update({ ...doc, theme: { ...doc.theme, [key]: e.target.value } })} />
                {{ primary: "สีหลัก", accent: "สีรอง", background: "พื้นหลัง", surface: "การ์ด", text: "ตัวอักษร" }[key]}
              </label>
            ))}
          </div>
        </div>

        {/* บล็อก */}
        <div className="panel space-y-2 p-4">
          <p className="text-sm font-semibold">บล็อกบนหน้าเว็บ ({doc.blocks.length}/{MAX_BLOCKS})</p>
          {doc.blocks.map((block, index) => (
            <div
              key={block.id}
              id={`block-row-${block.id}`}
              className={`rounded-lg border ${openId === block.id ? "border-[var(--color-brand)]" : "border-[var(--color-border)]"} ${dragIndex === index ? "opacity-50" : ""}`}
              onDragOver={(e) => {
                if (dragIndex !== null) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) moveTo(dragIndex, index);
                setDragIndex(null);
              }}
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <span
                  draggable
                  onDragStart={(e) => {
                    setDragIndex(index);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", block.id);
                  }}
                  onDragEnd={() => setDragIndex(null)}
                  className="cursor-grab select-none px-1 text-[var(--color-text-muted)]"
                  title="ลากเพื่อจัดลำดับ (มือถือใช้ ↑ ↓)"
                  aria-hidden="true"
                >
                  ⠿
                </span>
                <button type="button" className="min-w-0 flex-1 text-left text-sm font-semibold" onClick={() => setOpenId(openId === block.id ? null : block.id)}>
                  {BLOCK_LABELS[block.type]} {block.hidden && <span className="text-xs font-normal text-[var(--color-text-muted)]">(ซ่อน)</span>}
                </button>
                <button type="button" className="px-1 text-sm" aria-label="เลื่อนขึ้น" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
                <button type="button" className="px-1 text-sm" aria-label="เลื่อนลง" disabled={index === doc.blocks.length - 1} onClick={() => move(index, 1)}>↓</button>
                <button type="button" className="px-1 text-xs" onClick={() => updateBlock(block.id, { ...block, hidden: !block.hidden })}>{block.hidden ? "แสดง" : "ซ่อน"}</button>
                <button type="button" className="px-1 text-xs text-red-600" onClick={() => update({ ...doc, blocks: doc.blocks.filter((b) => b.id !== block.id) })}>ลบ</button>
              </div>
              {openId === block.id && (
                <div className="border-t border-[var(--color-border)] p-3">
                  <BlockForm block={block} renderData={renderData} onChange={(b) => updateBlock(block.id, b)} />
                </div>
              )}
            </div>
          ))}
          {doc.blocks.length < MAX_BLOCKS && (
            <div className="flex flex-wrap gap-1 pt-1">
              {(Object.keys(BLOCK_LABELS) as WebsiteBlock["type"][]).map((type) => (
                <button key={type} type="button" className="btn-secondary text-xs"
                  onClick={() => { const block = emptyBlock(type, renderData.store.name); update({ ...doc, blocks: [...doc.blocks, block] }); setOpenId(block.id); }}>
                  + {BLOCK_LABELS[type]}
                </button>
              ))}
            </div>
          )}
        </div>

        <FestivalPanel
          settings={website.festivalSettings}
          upcoming={upcomingFestivals}
          pendingLunarKeys={pendingLunarKeys}
          previewKey={previewFestivalKey}
          onPreview={setPreviewFestivalKey}
        />

        {versions.length > 0 && (
          <details className="panel p-4 text-sm">
            <summary className="cursor-pointer font-semibold">ฉบับที่เคยเผยแพร่ ({versions.length})</summary>
            <ul className="mt-2 space-y-1">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-2">
                  <span>{new Date(v.createdAt).toLocaleString("th-TH")}</span>
                  <button type="button" className="btn-secondary text-xs" disabled={pending}
                    onClick={() => startTransition(async () => {
                      const result = await restoreVersionAction(v.id);
                      if (!result.ok || !result.document) setMessage({ tone: "error", text: result.error ?? "ย้อนฉบับไม่สำเร็จ" });
                      else { setDoc(result.document); setDirty(false); setMessage({ tone: "ok", text: "ย้อนเป็นฉบับนี้ในฉบับร่างแล้ว — กดเผยแพร่เพื่อใช้จริง" }); router.refresh(); }
                    })}>
                    ใช้ฉบับนี้
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* พรีวิว + ปุ่ม */}
      <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" disabled={pending || !dirty || validation.error !== null} onClick={() => run(() => saveDraftAction(doc), "บันทึกฉบับร่างแล้ว")}>
            บันทึกร่าง
          </button>
          <button type="button" className="btn-primary" disabled={pending || validation.error !== null}
            onClick={() => run(() => publishWebsiteAction(doc), enabled ? "เผยแพร่แล้ว — ลูกค้าเห็นภายในไม่กี่วินาที" : "เผยแพร่แล้ว — กด “เปิดเว็บ” เพื่อให้ลูกค้าเห็น")}>
            {pending ? "กำลังบันทึก…" : "เผยแพร่"}
          </button>
          <button type="button" className="btn-secondary" disabled={historySize.past === 0} onClick={undo} title="เลิกทำ (Ctrl+Z)" aria-label="เลิกทำ">↶</button>
          <button type="button" className="btn-secondary" disabled={historySize.future === 0} onClick={redo} title="ทำซ้ำ (Ctrl+Shift+Z)" aria-label="ทำซ้ำ">↷</button>
          {dirty && <span className="self-center text-xs text-amber-700">มีการแก้ที่ยังไม่บันทึก</span>}
        </div>
        {validation.error !== null && <p className="alert-danger text-sm" role="alert">{validation.error}</p>}
        {message && (
          <p className={`rounded-lg border px-3 py-2 text-sm ${message.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-700"}`} role="status">
            {message.text}
          </p>
        )}
        <div className="flex justify-center gap-1">
          <button type="button" className={device === "mobile" ? "btn-primary text-xs" : "btn-secondary text-xs"} onClick={() => setDevice("mobile")}>📱 มือถือ</button>
          <button type="button" className={device === "desktop" ? "btn-primary text-xs" : "btn-secondary text-xs"} onClick={() => setDevice("desktop")}>🖥️ คอมพิวเตอร์</button>
        </div>
        {device === "mobile" ? (
          <div className="mx-auto w-full max-w-[380px] rounded-[32px] bg-[#121110] p-2.5 shadow-xl">
            <div className="h-[640px] cursor-pointer overflow-y-auto rounded-[24px]" aria-label="พรีวิวเว็บไซต์ร้าน — แตะบล็อกเพื่อแก้" onClickCapture={selectFromPreview}>
              <WebsiteRenderer document={doc} data={renderData} today={today} festival={previewFestival} editorMode />
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[380px] overflow-hidden rounded-lg border-[6px] border-[#121110] bg-white shadow-xl">
            {/* จำลองจอกว้าง 1024px แล้วย่อให้พอดีช่อง (368 / 1024) */}
            <div className="h-[420px] cursor-pointer overflow-y-auto overflow-x-hidden" aria-label="พรีวิวจอคอมพิวเตอร์ — แตะบล็อกเพื่อแก้" onClickCapture={selectFromPreview}>
              <ScaledPreview width={1024} scale={0.359}>
                <WebsiteRenderer document={doc} data={renderData} today={today} festival={previewFestival} editorMode />
              </ScaledPreview>
            </div>
          </div>
        )}
        <p className="text-center text-xs text-[var(--color-text-muted)]">
          พรีวิวฉบับร่าง (แตะบล็อกเพื่อแก้) — ลูกค้าเห็นเฉพาะฉบับที่กดเผยแพร่
          {previewFestivalKey ? " · กำลังดูตัวอย่างเทศกาล" : currentFestival ? ` · ตอนนี้แสดงเทศกาล${currentFestival.name}` : ""}
        </p>
      </div>
      {confirmDialog}
    </div>
  );
}
