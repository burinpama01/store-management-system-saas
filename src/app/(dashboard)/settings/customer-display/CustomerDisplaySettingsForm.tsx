"use client";

import { useActionState, useMemo, useState } from "react";
import {
  CUSTOMER_DISPLAY_SLIDE_LIMIT,
  DEFAULT_CUSTOMER_DISPLAY_SETTINGS,
  type CustomerDisplayAdSlide,
  type CustomerDisplaySettings,
  type CustomerDisplayMediaFit,
  type CustomerDisplayMediaType,
} from "@/modules/settings/customer-display";
import { upsertCustomerDisplaySettingsAction } from "./actions";

type SlideDraft = CustomerDisplayAdSlide;

const field = "form-input disabled:bg-[var(--surface-muted)] disabled:text-[var(--muted)]";
const singleSlotImageRecommendation =
  "ขนาดรูปภาพที่แนะนำ: 1080 x 1920 px สำหรับโฆษณาเต็มพื้นที่ด้านขวา เลือก cover เพื่อเต็มกรอบ หรือ contain เพื่อไม่ครอปภาพ";
const splitSlotImageRecommendation =
  "ขนาดรูปภาพที่แนะนำ: 1200 x 900 px ต่อช่องสำหรับโหมดแบ่งครึ่งบน/ล่าง เลือก cover เพื่อเต็มกรอบ หรือ contain เพื่อเห็นทั้งภาพ";

export function CustomerDisplaySettingsForm({
  settings,
  storeName,
  loadError,
}: {
  settings: CustomerDisplaySettings | null;
  storeName: string;
  loadError: string | null;
}) {
  const initial = settings ?? DEFAULT_CUSTOMER_DISPLAY_SETTINGS;
  const [state, formAction, isPending] = useActionState(upsertCustomerDisplaySettingsAction, { error: null, saved: false });
  const [adEnabled, setAdEnabled] = useState(initial.adEnabled);
  const [adLayout, setAdLayout] = useState(initial.adLayout);
  const [topSlotEnabled, setTopSlotEnabled] = useState(initial.topSlotEnabled);
  const [bottomSlotEnabled, setBottomSlotEnabled] = useState(initial.bottomSlotEnabled);
  const [topSlides, setTopSlides] = useState<SlideDraft[]>(initial.topSlides);
  const [bottomSlides, setBottomSlides] = useState<SlideDraft[]>(initial.bottomSlides);

  const topSlidesJson = useMemo(() => JSON.stringify(topSlides), [topSlides]);
  const bottomSlidesJson = useMemo(() => JSON.stringify(bottomSlides), [bottomSlides]);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="topSlidesJson" value={topSlidesJson} />
      <input type="hidden" name="bottomSlidesJson" value={bottomSlidesJson} />

      <section className="section-card space-y-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="label-muted">จอลูกค้า</p>
            <h2 className="panel-title">โฆษณาด้านขวา</h2>
            <p className="text-sm text-[var(--muted)]">
              ตั้งค่าสื่อโปรโมชันของ {storeName} สำหรับพื้นที่ด้านขวาบนหน้าจอลูกค้า
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
            <input
              type="checkbox"
              name="adEnabled"
              value="1"
              checked={adEnabled}
              onChange={(event) => setAdEnabled(event.target.checked)}
            />
            เปิดโฆษณา
          </label>
        </div>

        {loadError ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
            โหลดการตั้งค่าเดิมไม่สำเร็จ: {loadError}
          </p>
        ) : null}
        {state.error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
            {state.error}
          </p>
        ) : null}
        {state.saved ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700">
            บันทึกการตั้งค่าจอลูกค้าแล้ว
          </p>
        ) : null}

        <div className="grid gap-4 md:grid-cols-3">
          <label className="space-y-1 text-sm font-semibold text-[var(--text)]">
            รูปแบบพื้นที่
            <select
              className={field}
              name="adLayout"
              value={adLayout}
              onChange={(event) => setAdLayout(event.target.value as "single" | "split")}
              disabled={!adEnabled}
            >
              <option value="single">แสดงเต็มพื้นที่</option>
              <option value="split">แบ่งครึ่งบน/ล่าง</option>
            </select>
          </label>
          <label className="space-y-1 text-sm font-semibold text-[var(--text)]">
            เปลี่ยนภาพทุกกี่วินาที
            <input
              className={field}
              type="number"
              name="slideIntervalSeconds"
              min={3}
              max={60}
              defaultValue={initial.slideIntervalSeconds}
              disabled={!adEnabled}
            />
          </label>
          <div className="grid gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm">
            <label className="inline-flex items-center gap-2 font-semibold">
              <input
                type="checkbox"
                name="topSlotEnabled"
                value="1"
                checked={topSlotEnabled}
                onChange={(event) => setTopSlotEnabled(event.target.checked)}
                disabled={!adEnabled}
              />
              เปิดช่องบน
            </label>
            <label className="inline-flex items-center gap-2 font-semibold">
              <input
                type="checkbox"
                name="bottomSlotEnabled"
                value="1"
                checked={bottomSlotEnabled}
                onChange={(event) => setBottomSlotEnabled(event.target.checked)}
                disabled={!adEnabled}
              />
              เปิดช่องล่าง
            </label>
          </div>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <SlideEditor
          title="ภาพสไลด์ช่องบน"
          description="ใช้กับโหมดเต็มพื้นที่หรือครึ่งบนเมื่อเลือกแบ่งครึ่ง"
          slot="top"
          disabled={!adEnabled || !topSlotEnabled}
          slides={topSlides}
          recommendation={adLayout === "split" ? splitSlotImageRecommendation : singleSlotImageRecommendation}
          onChange={setTopSlides}
        />
        <SlideEditor
          title="วิดีโอ / ภาพเคลื่อนไหวช่องล่าง"
          description="รองรับรูปภาพ, GIF/WebP/APNG และวิดีโอ URL"
          slot="bottom"
          disabled={!adEnabled || !bottomSlotEnabled}
          slides={bottomSlides}
          recommendation={splitSlotImageRecommendation}
          onChange={setBottomSlides}
        />
      </div>

      <div className="flex justify-end">
        <button type="submit" className="btn-primary" disabled={isPending}>
          {isPending ? "กำลังบันทึก..." : "บันทึกการตั้งค่า"}
        </button>
      </div>
    </form>
  );
}

function SlideEditor({
  title,
  description,
  slot,
  disabled,
  slides,
  recommendation,
  onChange,
}: {
  title: string;
  description: string;
  slot: "top" | "bottom";
  disabled: boolean;
  slides: SlideDraft[];
  recommendation: string;
  onChange: (slides: SlideDraft[]) => void;
}) {
  function updateSlide(index: number, patch: Partial<SlideDraft>) {
    onChange(slides.map((slide, itemIndex) => (itemIndex === index ? { ...slide, ...patch } : slide)));
  }

  function addSlide(mediaType: CustomerDisplayMediaType) {
    onChange([
      ...slides,
      {
        id: `${slot}-${Date.now()}`,
        slot,
        mediaType,
        url: "",
        title: "",
        description: "",
        fit: "cover",
      },
    ]);
  }

  return (
    <section className="section-card space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="panel-title">{title}</h3>
          <p className="text-sm text-[var(--muted)]">{description}</p>
          <p className="text-xs font-semibold text-[var(--muted)]">
            {slides.length}/{CUSTOMER_DISPLAY_SLIDE_LIMIT} สไลด์
          </p>
          <p className="mt-2 max-w-xl rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs leading-5 text-[var(--muted)]">
            {recommendation}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => addSlide("image")}
            disabled={disabled || slides.length >= CUSTOMER_DISPLAY_SLIDE_LIMIT}
          >
            เพิ่มภาพ
          </button>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => addSlide("video")}
            disabled={disabled || slides.length >= CUSTOMER_DISPLAY_SLIDE_LIMIT}
          >
            เพิ่มวิดีโอ
          </button>
        </div>
      </div>

      {slides.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-muted)] p-4 text-sm text-[var(--muted)]">
          ยังไม่มีสไลด์ ระบบจะใช้โฆษณา fallback เดิมบนจอลูกค้า
        </p>
      ) : null}

      <div className="space-y-3">
        {slides.map((slide, index) => (
          <div key={slide.id || index} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
            <div className="grid gap-3 md:grid-cols-[140px_1fr]">
              <label className="space-y-1 text-xs font-semibold text-[var(--text)]">
                ประเภท
                <select
                  className={field}
                  value={slide.mediaType}
                  onChange={(event) => updateSlide(index, { mediaType: event.target.value as CustomerDisplayMediaType })}
                  disabled={disabled}
                >
                  <option value="image">ภาพ / GIF</option>
                  <option value="video">วิดีโอ</option>
                </select>
              </label>
              <label className="space-y-1 text-xs font-semibold text-[var(--text)]">
                URL สื่อ
                <input
                  className={field}
                  value={slide.url}
                  onChange={(event) => updateSlide(index, { url: event.target.value })}
                  placeholder={slide.mediaType === "video" ? "https://.../promo.mp4" : "https://.../promo.gif"}
                  disabled={disabled}
                />
              </label>
              <label className="space-y-1 text-xs font-semibold text-[var(--text)]">
                การจัดภาพ
                <select
                  className={field}
                  value={slide.fit}
                  onChange={(event) => updateSlide(index, { fit: event.target.value as CustomerDisplayMediaFit })}
                  disabled={disabled}
                >
                  <option value="cover">เต็มกรอบ</option>
                  <option value="contain">เห็นทั้งภาพ</option>
                </select>
              </label>
              <label className="space-y-1 text-xs font-semibold text-[var(--text)]">
                หัวข้อบนสไลด์
                <input
                  className={field}
                  value={slide.title ?? ""}
                  onChange={(event) => updateSlide(index, { title: event.target.value })}
                  placeholder="โปรโมชันวันนี้"
                  disabled={disabled}
                />
              </label>
              <label className="space-y-1 text-xs font-semibold text-[var(--text)] md:col-span-2">
                รายละเอียด
                <input
                  className={field}
                  value={slide.description ?? ""}
                  onChange={(event) => updateSlide(index, { description: event.target.value })}
                  placeholder="สมัครสมาชิก รับแต้มทุกบิล"
                  disabled={disabled}
                />
              </label>
            </div>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                className="text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-40"
                onClick={() => onChange(slides.filter((_, itemIndex) => itemIndex !== index))}
                disabled={disabled}
              >
                ลบสไลด์
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
