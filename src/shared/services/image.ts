/** Pure: scaled dimensions so the longest side is at most maxDim (no upscaling). */
export function computeResizedDimensions(
  width: number,
  height: number,
  maxDim: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxDim || longest === 0) return { width, height };
  const scale = maxDim / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * Client-side downscale + JPEG re-encode of an image file via canvas, so large
 * photos upload small and load fast. Returns a compressed Blob.
 */
export async function compressImage(
  file: File,
  opts?: { maxDim?: number; quality?: number },
): Promise<Blob> {
  const maxDim = opts?.maxDim ?? 1024;
  const quality = opts?.quality ?? 0.82;

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("อ่านไฟล์รูปไม่สำเร็จ"));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("ไฟล์นี้ไม่ใช่รูปภาพที่อ่านได้"));
    el.src = dataUrl;
  });

  const { width, height } = computeResizedDimensions(img.naturalWidth, img.naturalHeight, maxDim);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("เบราว์เซอร์ไม่รองรับการย่อรูป");
  ctx.drawImage(img, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality),
  );
  if (!blob) throw new Error("ย่อรูปไม่สำเร็จ");
  return blob;
}
