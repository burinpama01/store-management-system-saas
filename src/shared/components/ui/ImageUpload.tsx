"use client";

import { useState } from "react";
import { uploadStoreImageAction } from "@/modules/storage/image-actions";
import { compressImage } from "@/shared/services/image";

/**
 * Image field: upload a photo (auto-resized/compressed client-side, then uploaded via a server
 * action) to the product-images bucket, or paste a URL. Emits the final URL via a hidden input
 * named `name` so it submits with the surrounding form. `organizationId`/`storeId` are accepted
 * for call-site compatibility but the upload path is derived from the session server-side.
 */
export function ImageUpload({
  name,
  defaultValue,
  label = "รูปภาพ",
}: {
  name: string;
  defaultValue?: string;
  organizationId: string;
  storeId: string;
  label?: string;
}) {
  const [url, setUrl] = useState(defaultValue ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const blob = await compressImage(file);
      const fd = new FormData();
      fd.append("file", blob, "image.jpg");
      const result = await uploadStoreImageAction(fd);
      if (result.error || !result.url) {
        setError(result.error ?? "อัปโหลดไม่สำเร็จ");
        return;
      }
      setUrl(result.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "อัปโหลดไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-gray-700">{label}</label>
      <input type="hidden" name={name} value={url} />
      <div className="flex items-start gap-3">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="h-16 w-16 shrink-0 rounded border border-gray-200 object-cover" />
        ) : (
          <div className="grid h-16 w-16 shrink-0 place-items-center rounded border border-dashed border-gray-300 text-[10px] text-gray-400">
            ไม่มีรูป
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <input
            type="file"
            accept="image/*"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
            className="block w-full text-xs"
          />
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="หรือวาง URL รูป"
            className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </div>
      </div>
      {busy && <p className="text-xs text-[var(--muted)]">กำลังย่อ + อัปโหลดรูป...</p>}
      {error && <p className="alert-danger text-xs">{error}</p>}
    </div>
  );
}
