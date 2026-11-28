"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import type { StoreAdPackage } from "@/modules/ad-self-serve/rules";
import { checkStoreAdMedia } from "@/modules/ad-self-serve/orders";
import { confirmAdMediaAction, createAdOrderAction } from "./actions";

const baht = (n: number) => `${n.toLocaleString("th-TH", { maximumFractionDigits: 2 })} ฿`;
// iOS ซูมเมื่อช่องกรอกเล็กกว่า 16px
const input16 = { fontSize: 16 } as const;
const BUCKET = "product-images";

function extensionOf(file: File): string {
  const fromName = file.name.includes(".") ? file.name.split(".").pop() ?? "" : "";
  if (fromName) return fromName.toLowerCase();
  const map: Record<string, string> = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  return map[file.type] ?? "";
}

/** อ่านความยาววิดีโอในเครื่อง (ไม่อัปโหลดก่อน) */
function readVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const done = (value: number) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : NaN);
    video.onerror = () => done(NaN);
    window.setTimeout(() => done(NaN), 15_000);
    video.src = url;
  });
}

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface Props {
  slug: string;
  storeName: string;
  packages: StoreAdPackage[];
  terms: string;
  allowVideo: boolean;
  allowImage: boolean;
  maxVideoSeconds: number;
  autoPublish: boolean;
  slotsInUse: number;
  maxConcurrent: number;
  nextFreeAt: string | null;
  payMode: "beam" | "slip";
}

export function AdOrderForm(props: Props) {
  const router = useRouter();
  const [packageId, setPackageId] = useState(props.packages[0]?.id ?? "");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [accept, setAccept] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // ใช้ id เดิมตลอดการเปิดหน้า → กดซ้ำ/อัปโหลดล้มแล้วกดใหม่ = คำสั่งเดิม
  const requestIdRef = useRef<string | null>(null);

  const pkg = props.packages.find((p) => p.id === packageId) ?? null;
  const full = props.slotsInUse >= props.maxConcurrent;
  const accept_ = [props.allowVideo ? "video/mp4,video/webm,video/quicktime" : "", props.allowImage ? "image/jpeg,image/png,image/webp,image/gif" : ""]
    .filter(Boolean)
    .join(",");
  const mediaLabel = props.allowVideo && props.allowImage ? "วิดีโอหรือรูป" : props.allowVideo ? "วิดีโอ" : "รูป";
  const nextFree = useMemo(
    () =>
      props.nextFreeAt
        ? new Date(props.nextFreeAt).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" })
        : null,
    [props.nextFreeAt],
  );

  async function pickFile(next: File | null) {
    setError(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setDuration(null);
    setFile(null);
    if (!next) return;
    const mediaType = next.type.startsWith("video/") ? "video" : next.type.startsWith("image/") ? "image" : null;
    const d = mediaType === "video" ? await readVideoDuration(next) : null;
    const check = checkStoreAdMedia(props, { mediaType, extension: extensionOf(next), sizeBytes: next.size, durationSeconds: d });
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setFile(next);
    setDuration(d);
    setPreview(URL.createObjectURL(next));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file || !pkg || busy) return;
    setError(null);
    const mediaType = file.type.startsWith("video/") ? "video" : "image";
    try {
      setBusy("กำลังสร้างคำสั่ง...");
      const created = await createAdOrderAction(props.slug, {
        clientRequestId: (requestIdRef.current ??= newRequestId()),
        packageId: pkg.id,
        advertiserName: name,
        advertiserPhone: phone,
        acceptTerms: accept,
        mediaType,
        extension: extensionOf(file),
        sizeBytes: file.size,
        durationSeconds: duration,
      });
      if (!created.ok || !created.token) {
        setError(created.error ?? "สร้างคำสั่งไม่สำเร็จ");
        return;
      }
      if (created.upload) {
        setBusy("กำลังอัปโหลดไฟล์... (อย่าปิดหน้านี้)");
        const { error: uploadError } = await getSupabaseBrowserClient()
          .storage.from(BUCKET)
          .uploadToSignedUrl(created.upload.path, created.upload.token, file, {
            contentType: created.upload.contentType,
            cacheControl: created.upload.cacheControl,
          });
        if (uploadError) {
          setError(`อัปโหลดไม่สำเร็จ: ${uploadError.message} — กดอีกครั้งเพื่อลองใหม่`);
          return;
        }
        setBusy("กำลังตรวจไฟล์...");
        const confirmed = await confirmAdMediaAction(created.token);
        if (!confirmed.ok) {
          setError(confirmed.error ?? "ตรวจไฟล์ไม่สำเร็จ");
          return;
        }
      }
      setBusy("กำลังไปหน้าชำระเงิน...");
      router.push(`/ads/${encodeURIComponent(props.slug)}/o/${created.token}`);
    } catch {
      setError("เชื่อมต่อไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setBusy((current) => (current === "กำลังไปหน้าชำระเงิน..." ? current : null));
    }
  }

  return (
    <main className="min-h-screen bg-stone-50 text-stone-800">
      <div className="mx-auto max-w-md space-y-4 px-4 py-6">
        <header className="rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 p-5 text-white shadow">
          <p className="text-xs opacity-80">ลงโฆษณาบนจอร้าน</p>
          <h1 className="mt-1 text-xl font-bold">{props.storeName}</h1>
          <p className="mt-2 text-sm opacity-90">
            {props.autoPublish ? "จ่ายแล้วขึ้นจอภายในไม่กี่นาที" : "จ่ายแล้วร้านตรวจก่อนขึ้นจอ"} · ช่องว่าง {Math.max(0, props.maxConcurrent - props.slotsInUse)}/{props.maxConcurrent}
          </p>
        </header>

        {full ? (
          <p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            ช่องโฆษณาเต็มแล้ว{nextFree ? ` — ว่างอีกครั้งประมาณ ${nextFree}` : ""} ลองกลับมาใหม่ภายหลัง
          </p>
        ) : null}

        <form onSubmit={submit} className="space-y-4">
          <section className="rounded-2xl border border-stone-200 bg-white p-4">
            <h2 className="font-semibold">① เลือกแพ็ก</h2>
            <div className="mt-3 grid grid-cols-1 gap-2">
              {props.packages.map((p) => (
                <label
                  key={p.id}
                  className={`flex cursor-pointer items-center justify-between rounded-xl border px-4 py-3 ${
                    p.id === packageId ? "border-blue-600 bg-blue-50" : "border-stone-200"
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <input type="radio" name="package" checked={p.id === packageId} onChange={() => setPackageId(p.id)} className="h-5 w-5" />
                    <span>
                      <span className="block font-semibold">{p.name}</span>
                      <span className="block text-xs text-stone-500">แสดงบนจอ {p.days} วัน</span>
                    </span>
                  </span>
                  <span className="text-lg font-bold">{baht(p.price)}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="space-y-3 rounded-2xl border border-stone-200 bg-white p-4">
            <h2 className="font-semibold">② ข้อมูลและไฟล์โฆษณา</h2>
            <label className="block text-sm font-medium">
              ชื่อร้าน / ผู้ลงโฆษณา
              <input
                className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2"
                style={input16}
                value={name}
                maxLength={80}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block text-sm font-medium">
              เบอร์โทร (ร้านติดต่อกลับได้)
              <input
                className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2"
                style={input16}
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                maxLength={15}
                required
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
            <div className="text-sm font-medium">
              ไฟล์{mediaLabel}
              <label className="mt-1 flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-stone-300 bg-stone-50 p-3 text-center">
                {preview && file?.type.startsWith("video/") ? (
                  <video src={preview} className="max-h-56 w-full rounded-lg bg-black object-contain" muted playsInline controls />
                ) : preview ? (
                  // eslint-disable-next-line @next/next/no-img-element -- ตัวอย่างไฟล์ในเครื่อง
                  <img src={preview} alt="ตัวอย่างโฆษณา" className="max-h-56 w-full rounded-lg object-contain" />
                ) : (
                  <span className="text-stone-500">แตะเพื่อเลือก{mediaLabel}</span>
                )}
                <input type="file" accept={accept_} className="sr-only" onChange={(e) => void pickFile(e.target.files?.[0] ?? null)} />
              </label>
              <span className="mt-1 block text-xs font-normal text-stone-500">
                {props.allowVideo ? `วิดีโอยาวไม่เกิน ${props.maxVideoSeconds} วินาที ไม่เกิน 50 MB` : ""}
                {props.allowVideo && props.allowImage ? " · " : ""}
                {props.allowImage ? "รูปไม่เกิน 10 MB" : ""} · แสดงสลับกับโฆษณาของร้าน
              </span>
            </div>
            <label className="flex items-start gap-2 rounded-lg bg-stone-50 p-3 text-sm">
              <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
              <span>
                ยอมรับเงื่อนไขของร้าน: <span className="text-stone-600">{props.terms}</span>
                <span className="mt-1 block text-xs text-stone-500">
                  เงินค่าโฆษณาโอนเข้าบัญชีร้านโดยตรง หากร้านถอดหรือไม่อนุมัติ ติดต่อร้านเรื่องเงินคืน
                </span>
              </span>
            </label>
          </section>

          {error ? (
            <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={!file || !pkg || !accept || !name.trim() || !phone.trim() || full || Boolean(busy)}
            className="min-h-12 w-full rounded-xl bg-blue-600 px-4 text-base font-semibold text-white disabled:opacity-50"
          >
            {busy ?? (pkg ? `ไปจ่ายเงิน ${baht(pkg.price)}` : "เลือกแพ็ก")}
          </button>
          <p className="text-center text-xs text-stone-500">
            {props.payMode === "beam" ? "จ่ายด้วย QR พร้อมเพย์ ยืนยันอัตโนมัติ" : "โอนพร้อมเพย์ของร้านแล้วแนบสลิป ตรวจอัตโนมัติ"} · ชำระภายใน 30 นาที
          </p>
        </form>
      </div>
    </main>
  );
}
