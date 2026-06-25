"use client";

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { useActionState, useMemo, useState } from "react";
import {
  CUSTOMER_DISPLAY_SLIDE_LIMIT,
  DEFAULT_CUSTOMER_DISPLAY_SETTINGS,
  type CustomerDisplayAdSlide,
  type CustomerDisplaySettings,
  type CustomerDisplayMediaFit,
  type CustomerDisplayMediaType,
} from "@/modules/settings/customer-display";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import { compressImage } from "@/shared/services/image";
import { createCustomerDisplayMediaUploadAction, upsertCustomerDisplaySettingsAction } from "./actions";
import { Button } from "@/shared/components/ui";

type SlideDraft = CustomerDisplayAdSlide;

const field = "form-input disabled:bg-[var(--surface-muted)] disabled:text-[var(--muted)]";
const singleSlotImageRecommendation =
  "ขนาดรูปภาพที่แนะนำ: 1080 x 1920 px สำหรับโฆษณาเต็มพื้นที่ด้านขวา เลือก cover เพื่อเต็มกรอบ หรือ contain เพื่อไม่ครอปภาพ";
const splitSlotImageRecommendation =
  "ขนาดรูปภาพที่แนะนำ: 1200 x 900 px ต่อช่องสำหรับโหมดแบ่งครึ่งบน/ล่าง เลือก cover เพื่อเต็มกรอบ หรือ contain เพื่อเห็นทั้งภาพ";
const compressibleCustomerDisplayImageTypes = new Set(["image/jpeg", "image/png"]);

export function CustomerDisplaySettingsForm({
  settings,
  storeName,
  organizationId,
  storeId,
  loadError,
}: {
  settings: CustomerDisplaySettings | null;
  storeName: string;
  organizationId: string;
  storeId: string;
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
  const [uploadingCount, setUploadingCount] = useState(0);

  const topSlidesJson = useMemo(() => JSON.stringify(topSlides), [topSlides]);
  const bottomSlidesJson = useMemo(() => JSON.stringify(bottomSlides), [bottomSlides]);
  const isUploading = uploadingCount > 0;

  function onUploadStart() {
    setUploadingCount((count) => count + 1);
  }

  function onUploadFinish() {
    setUploadingCount((count) => Math.max(0, count - 1));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (isUploading) {
      event.preventDefault();
    }
  }

  return (
    <form action={formAction} className="space-y-5" onSubmit={handleSubmit}>
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
          organizationId={organizationId}
          storeId={storeId}
          onUploadStart={onUploadStart}
          onUploadFinish={onUploadFinish}
          onChange={setTopSlides}
        />
        <SlideEditor
          title="วิดีโอ / ภาพเคลื่อนไหวช่องล่าง"
          description="รองรับรูปภาพ, GIF/WebP/APNG และวิดีโอ URL"
          slot="bottom"
          disabled={!adEnabled || !bottomSlotEnabled}
          slides={bottomSlides}
          recommendation={splitSlotImageRecommendation}
          organizationId={organizationId}
          storeId={storeId}
          onUploadStart={onUploadStart}
          onUploadFinish={onUploadFinish}
          onChange={setBottomSlides}
        />
      </div>

      <div className="flex flex-col items-end gap-2">
        {isUploading ? (
          <p className="text-xs font-medium text-[var(--muted)]" aria-live="polite">
            รอให้อัพโหลดไฟล์เสร็จก่อนบันทึกการตั้งค่า
          </p>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          loading={isPending || isUploading}
          loadingText={isUploading ? "กำลังอัพโหลดไฟล์..." : "กำลังบันทึก..."}
        >
          บันทึกการตั้งค่า
        </Button>
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
  organizationId,
  storeId,
  onUploadStart,
  onUploadFinish,
  onChange,
}: {
  title: string;
  description: string;
  slot: "top" | "bottom";
  disabled: boolean;
  slides: SlideDraft[];
  recommendation: string;
  organizationId: string;
  storeId: string;
  onUploadStart: () => void;
  onUploadFinish: () => void;
  onChange: Dispatch<SetStateAction<SlideDraft[]>>;
}) {
  const [uploadingSlideId, setUploadingSlideId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  function updateSlide(index: number, patch: Partial<SlideDraft>) {
    const slide = slides[index];
    if (!slide) return;
    updateSlideById(slide.id, patch);
  }

  function updateSlideById(slideId: string, patch: Partial<SlideDraft>) {
    onChange((currentSlides) => currentSlides.map((slide) => (slide.id === slideId ? { ...slide, ...patch } : slide)));
  }

  async function uploadSlideFile(index: number, file: File) {
    const slide = slides[index];
    if (!slide) return;
    setUploadError(null);
    setUploadingSlideId(slide.id);
    onUploadStart();
    try {
      const mediaType: CustomerDisplayMediaType = file.type.startsWith("video/") ? "video" : "image";
      const shouldCompress = mediaType === "image" && shouldCompressCustomerDisplayImage(file);
      const uploadBody = shouldCompress ? await compressImage(file) : file;
      const extension = shouldCompress ? "jpg" : safeExtension(file.name, fallbackExtension(file.type, mediaType));
      const signedUpload = await createCustomerDisplayMediaUploadAction({ organizationId, storeId, extension });
      if (signedUpload.error || !signedUpload.path || !signedUpload.token || !signedUpload.publicUrl) {
        setUploadError(signedUpload.error ?? "เตรียมอัพโหลดไฟล์ไม่สำเร็จ");
        return;
      }
      const contentType = shouldCompress ? "image/jpeg" : file.type || fallbackContentType(mediaType);
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.storage
        .from("product-images")
        .uploadToSignedUrl(signedUpload.path, signedUpload.token, uploadBody, { contentType });
      if (error) {
        setUploadError(error.message);
        return;
      }
      updateSlideById(slide.id, { mediaType, url: signedUpload.publicUrl });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "อัพโหลดไฟล์ไม่สำเร็จ");
    } finally {
      setUploadingSlideId(null);
      onUploadFinish();
    }
  }

  function addSlide(mediaType: CustomerDisplayMediaType) {
    onChange((currentSlides) => [
      ...currentSlides,
      {
        id: `${slot}-${crypto.randomUUID()}`,
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
                <span className="block text-[11px] font-medium text-[var(--muted)]">URL จะถูกเติมหลังอัพโหลดสำเร็จ</span>
              </label>
              <label className="space-y-1 text-xs font-semibold text-[var(--text)]">
                อัพโหลดไฟล์
                <input
                  type="file"
                  accept="image/*,video/*"
                  className="block w-full text-xs text-[var(--muted)]"
                  disabled={disabled || uploadingSlideId === slide.id}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadSlideFile(index, file);
                    event.currentTarget.value = "";
                  }}
                />
                {uploadingSlideId === slide.id ? (
                  <span className="block text-[11px] font-medium text-[var(--muted)]">กำลังอัพโหลด...</span>
                ) : null}
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
                onClick={() => onChange((currentSlides) => currentSlides.filter((item) => item.id !== slide.id))}
                disabled={disabled}
              >
                ลบสไลด์
              </button>
            </div>
          </div>
        ))}
      </div>
      {uploadError ? <p className="alert-danger text-xs">{uploadError}</p> : null}
    </section>
  );
}

function shouldCompressCustomerDisplayImage(file: File) {
  if (file.name.toLowerCase().endsWith(".apng")) return false;
  return compressibleCustomerDisplayImageTypes.has(file.type.toLowerCase());
}

function fallbackContentType(mediaType: CustomerDisplayMediaType) {
  return mediaType === "video" ? "video/mp4" : "image/jpeg";
}

function fallbackExtension(fileType: string, mediaType: CustomerDisplayMediaType) {
  switch (fileType.toLowerCase()) {
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/apng":
      return "apng";
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    default:
      return mediaType === "video" ? "mp4" : "jpg";
  }
}

function safeExtension(fileName: string, fallback: string) {
  const extension = fileName.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "");
  return extension || fallback;
}
