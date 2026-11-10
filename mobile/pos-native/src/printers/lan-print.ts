import type { RefObject } from 'react';
import type { View } from 'react-native';
import { hasInk, rasterEscPos } from '../domain/raster';
import { runPrintJob } from '../domain/printing';
import type { SavedLanPrinter } from '../domain/lan-printer';

/**
 * Captures a rendered paper view and sends it once to a LAN/WiFi ESC/POS printer.
 * Native bridges are loaded only when printing, so screens open even if a module is missing.
 * Thai text is sent as an image so the printer's built-in code pages do not matter.
 */
export async function printViewToLan(view: RefObject<View | null>, printer: SavedLanPrinter) {
  const { captureRef } = await import('react-native-view-shot');
  const { decode } = await import('fast-png');
  const { toByteArray } = await import('base64-js');
  const { sendTcp } = await import('./tcp');
  let png: ReturnType<typeof decode>;
  try { png = decode(toByteArray(await captureRef(view, { result: 'base64', format: 'png', width: printer.dots }))); }
  catch { throw new Error('เตรียมภาพใบพิมพ์ไม่สำเร็จ ยังไม่ได้ส่งไปที่เครื่องพิมพ์ กรุณาลองใหม่'); }
  if (png.width !== printer.dots || png.palette) throw new Error('ภาพใบพิมพ์มีขนาดหรือรูปแบบไม่ตรงกับเครื่องพิมพ์');
  // A blank capture (seen with some off-screen/modal views) would feed empty paper; stop before sending.
  if (!hasInk(png)) throw new Error('ภาพใบพิมพ์ว่างเปล่า ยังไม่ได้ส่งไปที่เครื่องพิมพ์ ปิดแล้วเปิดใบเสร็จใหม่ก่อนลองอีกครั้ง');
  const bytes = rasterEscPos(png, printer.cut);
  return runPrintJob(() => sendTcp(printer.host, printer.port, bytes));
}
