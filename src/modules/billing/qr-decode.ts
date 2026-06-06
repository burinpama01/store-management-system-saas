import sharp from "sharp";
import jsQR from "jsqr";

/**
 * Decodes a QR code from an image buffer and returns its raw payload string
 * (e.g. an EMVCo PromptPay payload), or null if no QR is found.
 * Server-only: uses sharp to rasterize and jsqr to decode.
 */
export async function decodeQrPayloadFromImage(buffer: Buffer): Promise<string | null> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const result = jsQR(pixels, info.width, info.height);
  return result?.data ?? null;
}
