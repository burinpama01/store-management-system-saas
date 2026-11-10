import { validateLanTarget } from './raster';

export const LAN_PRINTER_KEY = 'storeos.lanPrinter.v1';
export type PaperDots = 384 | 576;
export interface SavedLanPrinter { host: string; port: number; dots: PaperDots; cut: boolean }
export interface KeyValueStorage { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> }

/** Validates user input; throws a Thai message the settings screen shows as-is. */
export function makeLanPrinter(host: string, port: number, dots: number, cut: boolean): SavedLanPrinter {
  const cleanHost = host.trim();
  validateLanTarget(cleanHost, port);
  if (dots !== 384 && dots !== 576) throw new Error('ขนาดกระดาษไม่ถูกต้อง');
  return { host: cleanHost, port, dots, cut: cut === true };
}

/** A corrupt or tampered stored value is ignored rather than sent to the network. */
export function parseSavedLanPrinter(raw: string | null): SavedLanPrinter | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SavedLanPrinter>;
    return makeLanPrinter(String(value.host ?? ''), Number(value.port), Number(value.dots), value.cut === true);
  } catch { return null; }
}

export async function loadLanPrinter(storage: KeyValueStorage) {
  try { return parseSavedLanPrinter(await storage.getItem(LAN_PRINTER_KEY)); } catch { return null; }
}
export async function saveLanPrinter(storage: KeyValueStorage, printer: SavedLanPrinter) {
  const valid = makeLanPrinter(printer.host, printer.port, printer.dots, printer.cut);
  await storage.setItem(LAN_PRINTER_KEY, JSON.stringify(valid));
  return valid;
}
export const clearLanPrinter = (storage: KeyValueStorage) => storage.removeItem(LAN_PRINTER_KEY);
export const lanPrinterLabel = (p: SavedLanPrinter) => `${p.host}:${p.port} · ${p.dots === 576 ? '80 mm' : '58 mm'}${p.cut ? ' · ตัดกระดาษ' : ''}`;

export function lanPrintMessage(state: 'confirmed' | 'submitted' | 'unknown', error?: string) {
  // TCP 9100 printers send no acknowledgement today, so 'confirmed' only applies to a future driver that does.
  if (state === 'confirmed') return 'เครื่องพิมพ์ยืนยันว่าพิมพ์แล้ว';
  if (state === 'submitted') return 'ส่งใบเสร็จไปที่เครื่องพิมพ์ WiFi แล้ว ตรวจว่ากระดาษออกครบ ระบบไม่ส่งซ้ำอัตโนมัติ';
  return `ไม่ทราบผลการพิมพ์ ตรวจเครื่องก่อนกดพิมพ์ซ้ำ เพราะบางส่วนอาจพิมพ์ไปแล้ว${error ? ` (${error})` : ''}`;
}
