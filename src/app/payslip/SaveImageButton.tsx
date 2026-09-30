"use client";

import { useRef, useState } from "react";

export function SaveImageButton({ fileName }: { fileName: string }) {
  const saving = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveImage() {
    if (saving.current) return;
    saving.current = true;
    setIsSaving(true);
    setError(null);
    try {
      const content = document.getElementById("payslip-image-content");
      if (!content) throw new Error("Payslip content unavailable");
      await document.fonts.ready;
      const { toBlob } = await import("html-to-image");
      const blob = await toBlob(content, {
        backgroundColor: "#ffffff",
        pixelRatio: 2,
        width: Math.max(content.clientWidth, content.scrollWidth),
      });
      if (!blob) throw new Error("Image rendering failed");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
        // Let the browser begin the download before releasing the image.
        window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
    } catch {
      setError("บันทึกภาพไม่สำเร็จ กรุณาลองอีกครั้ง");
    } finally {
      saving.current = false;
      setIsSaving(false);
    }
  }

  return (
    <div className="print:hidden">
      <button
        type="button"
        onClick={saveImage}
        disabled={isSaving}
        aria-busy={isSaving}
        className="min-h-11 cursor-pointer rounded-lg border border-orange-500 px-4 py-2 text-sm font-semibold text-orange-700 hover:bg-orange-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 disabled:cursor-wait disabled:opacity-60"
      >
        {isSaving ? "กำลังบันทึกภาพ…" : "บันทึกเป็นภาพ"}
      </button>
      {error && <p role="alert" className="mt-2 max-w-64 text-sm text-red-700">{error}</p>}
    </div>
  );
}
