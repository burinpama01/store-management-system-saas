"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * Renders an EMVCo/PromptPay payload string as a scannable QR image (client-side).
 */
export function QrCode({ value, size = 220 }: { value: string; size?: number }) {
  const [state, setState] = useState<{ value: string; src: string | null; error: boolean }>({
    value: "",
    src: null,
    error: false,
  });

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { width: size, margin: 1, errorCorrectionLevel: "M" })
      .then((url) => {
        if (!cancelled) setState({ value, src: url, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ value, src: null, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  const ready = state.value === value;

  if (ready && state.error) {
    return <p className="text-xs text-amber-700">สร้างรูป QR ไม่สำเร็จ</p>;
  }
  if (!ready || !state.src) {
    return (
      <div
        className="animate-pulse rounded-md bg-[var(--surface-muted)]"
        style={{ width: size, height: size }}
        aria-label="กำลังสร้าง QR"
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={state.src}
      alt="PromptPay QR"
      width={size}
      height={size}
      className="rounded-md border border-[var(--border)] bg-white p-2"
    />
  );
}
