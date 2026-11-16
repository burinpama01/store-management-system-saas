"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  MAX_POSTER_ELEMENTS,
  POSTER_ASPECTS,
  POSTER_STICKERS,
  type PosterElement,
  type WebsiteBlock,
} from "@/modules/store-website/schema";
import { PosterElementView, cssUrl } from "@/modules/store-website/WebsiteRenderer";

type PosterBlock = Extract<WebsiteBlock, { type: "poster" }>;

const ASPECT: Record<string, string> = { "1:1": "1 / 1", "4:5": "4 / 5", "16:9": "16 / 9" };
const INPUT = { fontSize: 16 } as const;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

let seq = 0;
const newId = (kind: string) => `${kind[0]}${Date.now().toString(36)}${(seq = (seq + 1) % 1000).toString(36)}`.slice(0, 40);

/**
 * ตัวแก้โปสเตอร์วางอิสระ — ลากชิ้นงานบนพื้นที่ (เมาส์/นิ้ว ผ่าน pointer events)
 * ตำแหน่งเก็บเป็น % ของโปสเตอร์ จึงหน้าตาเหมือนกันทุกขนาดจอ
 */
export function PosterEditor({
  block,
  onChange,
  ImageField,
}: {
  block: PosterBlock;
  onChange: (next: PosterBlock) => void;
  ImageField: (props: { label: string; value: string; onChange: (url: string) => void }) => React.ReactNode;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; startX: number; startY: number; elX: number; elY: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(block.elements[0]?.id ?? null);
  const selected = block.elements.find((e) => e.id === selectedId) ?? null;

  const setElement = (id: string, patch: Partial<PosterElement>) =>
    onChange({ ...block, elements: block.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)) });

  const add = (element: Omit<PosterElement, "id">) => {
    if (block.elements.length >= MAX_POSTER_ELEMENTS) return;
    const id = newId(element.kind);
    onChange({ ...block, elements: [...block.elements, { ...element, id }] });
    setSelectedId(id);
  };

  const layer = (id: string, delta: number) => {
    const index = block.elements.findIndex((e) => e.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= block.elements.length) return;
    const elements = [...block.elements];
    [elements[index], elements[target]] = [elements[target], elements[index]];
    onChange({ ...block, elements });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>, element: PosterElement) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(element.id);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { id: element.id, startX: event.clientX, startY: event.clientY, elX: element.x, elY: element.y };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!d || !rect || rect.width === 0 || rect.height === 0) return;
    const x = clamp(round1(d.elX + ((event.clientX - d.startX) / rect.width) * 100), 0, 100);
    const y = clamp(round1(d.elY + ((event.clientY - d.startY) / rect.height) * 100), 0, 100);
    setElement(d.id, { x, y });
  };
  const endDrag = () => {
    drag.current = null;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs text-[var(--color-text-muted)]">สัดส่วน</span>
        {POSTER_ASPECTS.map((aspect) => (
          <button
            key={aspect}
            type="button"
            className={`rounded border px-2 py-1 text-xs ${block.aspect === aspect ? "border-[var(--color-brand)] font-semibold" : "border-[var(--color-border)]"}`}
            onClick={() => onChange({ ...block, aspect })}
          >
            {aspect}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1 text-xs">
          พื้นหลัง <input type="color" value={block.background} onChange={(e) => onChange({ ...block, background: e.target.value })} />
        </label>
      </div>

      <div
        ref={canvasRef}
        className="relative mx-auto w-full max-w-[360px] touch-none select-none overflow-hidden rounded-lg border border-[var(--color-border)]"
        style={{
          aspectRatio: ASPECT[block.aspect] ?? "4 / 5",
          containerType: "inline-size",
          backgroundColor: block.background,
          backgroundImage: block.backgroundImageUrl ? cssUrl(block.backgroundImageUrl) : undefined,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
        onPointerDown={() => setSelectedId(null)}
        aria-label="พื้นที่โปสเตอร์ — ลากชิ้นงานเพื่อย้าย"
      >
        {block.elements.map((element) => (
          <PosterElementView key={element.id} element={element} />
        ))}
        {/* กรอบจับลากซ้อนบนชิ้นงานแต่ละชิ้น */}
        {block.elements.map((element) => (
          <div
            key={`h-${element.id}`}
            role="button"
            tabIndex={0}
            aria-label={`ย้าย${element.kind === "text" ? `ข้อความ ${element.text || "(ว่าง)"}` : element.kind === "sticker" ? `สติกเกอร์ ${element.sticker ?? ""}` : "รูป"}`}
            onPointerDown={(e) => onPointerDown(e, element)}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 5 : 1;
              const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
              const m = moves[e.key];
              if (!m) return;
              e.preventDefault();
              setElement(element.id, { x: clamp(element.x + m[0], 0, 100), y: clamp(element.y + m[1], 0, 100) });
            }}
            className={`absolute cursor-move rounded ${selectedId === element.id ? "outline-2 outline-dashed outline-[var(--color-brand)]" : "hover:outline-1 hover:outline-dashed hover:outline-black/40"}`}
            style={{
              left: `${element.x}%`,
              top: `${element.y}%`,
              width: `${element.w}%`,
              minHeight: "8%",
              transform: `translate(-50%, -50%) rotate(${element.rotate}deg)`,
              outlineStyle: selectedId === element.id ? "dashed" : undefined,
            }}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-1">
        <button type="button" className="btn-secondary text-xs" disabled={block.elements.length >= MAX_POSTER_ELEMENTS}
          onClick={() => add({ kind: "text", x: 50, y: 50, w: 70, rotate: 0, text: "ข้อความ", size: 7, color: "#1f2328", bold: true, align: "center" })}>
          + ข้อความ
        </button>
        <button type="button" className="btn-secondary text-xs" disabled={block.elements.length >= MAX_POSTER_ELEMENTS}
          onClick={() => add({ kind: "sticker", x: 50, y: 50, w: 18, rotate: 0, sticker: "⭐" })}>
          + สติกเกอร์
        </button>
        <button type="button" className="btn-secondary text-xs" disabled={block.elements.length >= MAX_POSTER_ELEMENTS}
          onClick={() => add({ kind: "image", x: 50, y: 50, w: 50, rotate: 0, imageUrl: "" })}>
          + รูป
        </button>
        <span className="self-center text-xs text-[var(--color-text-muted)]">{block.elements.length}/{MAX_POSTER_ELEMENTS} ชิ้น</span>
      </div>

      {selected ? (
        <div className="space-y-2 rounded-lg border border-[var(--color-border)] p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-semibold">{selected.kind === "text" ? "ข้อความ" : selected.kind === "sticker" ? "สติกเกอร์" : "รูป"}</span>
            <div className="flex gap-1 text-xs">
              <button type="button" className="btn-secondary text-xs" onClick={() => layer(selected.id, 1)} aria-label="ไว้หน้า">ไว้หน้า</button>
              <button type="button" className="btn-secondary text-xs" onClick={() => layer(selected.id, -1)} aria-label="ไว้หลัง">ไว้หลัง</button>
              <button type="button" className="text-xs text-red-600" onClick={() => { onChange({ ...block, elements: block.elements.filter((e) => e.id !== selected.id) }); setSelectedId(null); }}>ลบ</button>
            </div>
          </div>
          {selected.kind === "text" && (
            <>
              <textarea className="input w-full" style={INPUT} rows={2} maxLength={120} value={selected.text ?? ""} onChange={(e) => setElement(selected.id, { text: e.target.value })} />
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-1">สี <input type="color" value={selected.color ?? "#1f2328"} onChange={(e) => setElement(selected.id, { color: e.target.value })} /></label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(selected.bold)} onChange={(e) => setElement(selected.id, { bold: e.target.checked })} />ตัวหนา</label>
                <select className="input" style={INPUT} value={selected.align ?? "center"} onChange={(e) => setElement(selected.id, { align: e.target.value as "left" | "center" | "right" })}>
                  <option value="left">ชิดซ้าย</option>
                  <option value="center">กึ่งกลาง</option>
                  <option value="right">ชิดขวา</option>
                </select>
              </div>
              <label className="block text-xs">ขนาดตัวอักษร
                <input type="range" min={2} max={30} step={0.5} className="w-full" value={selected.size ?? 6} onChange={(e) => setElement(selected.id, { size: Number(e.target.value) })} />
              </label>
            </>
          )}
          {selected.kind === "sticker" && (
            <div className="flex flex-wrap gap-1">
              {POSTER_STICKERS.map((sticker) => (
                <button key={sticker} type="button" className={`rounded border px-2 py-1 text-lg ${selected.sticker === sticker ? "border-[var(--color-brand)]" : "border-transparent"}`} onClick={() => setElement(selected.id, { sticker })}>
                  {sticker}
                </button>
              ))}
            </div>
          )}
          {selected.kind === "image" && (
            <ImageField label="รูป (PNG พื้นใสจะสวยที่สุด)" value={selected.imageUrl ?? ""} onChange={(imageUrl) => setElement(selected.id, { imageUrl })} />
          )}
          <label className="block text-xs">ความกว้าง
            <input type="range" min={5} max={100} className="w-full" value={selected.w} onChange={(e) => setElement(selected.id, { w: Number(e.target.value) })} />
          </label>
          <label className="block text-xs">หมุน ({selected.rotate}°)
            <input type="range" min={-180} max={180} className="w-full" value={selected.rotate} onChange={(e) => setElement(selected.id, { rotate: Number(e.target.value) })} />
          </label>
          <p className="text-xs text-[var(--color-text-muted)]">ลากเพื่อย้าย · ปุ่มลูกศรเลื่อนทีละนิด (Shift = ทีละมาก)</p>
        </div>
      ) : (
        <p className="text-xs text-[var(--color-text-muted)]">แตะชิ้นงานบนโปสเตอร์เพื่อแก้ไข</p>
      )}

      <ImageField label="รูปพื้นหลัง (ไม่บังคับ)" value={block.backgroundImageUrl ?? ""} onChange={(backgroundImageUrl) => onChange({ ...block, backgroundImageUrl })} />
    </div>
  );
}
