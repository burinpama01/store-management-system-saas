import { expect, it, vi } from 'vitest';
import { LAN_PRINTER_KEY, clearLanPrinter, lanPrintMessage, lanPrinterLabel, loadLanPrinter, makeLanPrinter, parseSavedLanPrinter, saveLanPrinter } from '../src/domain/lan-printer';

function memory(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { data, getItem: vi.fn(async (k: string) => data[k] ?? null), setItem: vi.fn(async (k: string, v: string) => { data[k] = v; }), removeItem: vi.fn(async (k: string) => { delete data[k]; }) };
}
it('accepts only private IPv4 targets, valid ports and supported paper widths', () => {
  expect(makeLanPrinter(' 192.168.1.20 ', 9100, 576, true)).toEqual({ host: '192.168.1.20', port: 9100, dots: 576, cut: true });
  expect(() => makeLanPrinter('8.8.8.8', 9100, 384, false)).toThrow('ภายใน');
  expect(() => makeLanPrinter('printer.local', 9100, 384, false)).toThrow();
  expect(() => makeLanPrinter('10.0.0.5', 0, 384, false)).toThrow('Port');
  expect(() => makeLanPrinter('10.0.0.5', 9100, 500, false)).toThrow('กระดาษ');
});
it('saves, reloads and forgets the receipt printer', async () => {
  const store = memory();
  await saveLanPrinter(store, { host: '172.16.0.9', port: 9100, dots: 384, cut: false });
  expect(JSON.parse(store.data[LAN_PRINTER_KEY])).toEqual({ host: '172.16.0.9', port: 9100, dots: 384, cut: false });
  expect(await loadLanPrinter(store)).toEqual({ host: '172.16.0.9', port: 9100, dots: 384, cut: false });
  await clearLanPrinter(store); expect(await loadLanPrinter(store)).toBeNull();
});
it('ignores corrupt or tampered stored values instead of sending to them', async () => {
  for (const raw of ['{', '{"host":"1.1.1.1","port":9100,"dots":384}', '{"host":"192.168.1.2","port":"x","dots":384}', '{"host":"192.168.1.2","port":9100,"dots":999}']) expect(parseSavedLanPrinter(raw)).toBeNull();
  const broken = { getItem: async () => { throw new Error('storage'); }, setItem: async () => undefined, removeItem: async () => undefined };
  expect(await loadLanPrinter(broken)).toBeNull();
});
it('describes print results without implying confirmation the printer cannot give', () => {
  expect(lanPrinterLabel({ host: '192.168.1.2', port: 9100, dots: 576, cut: true })).toBe('192.168.1.2:9100 · 80 mm · ตัดกระดาษ');
  expect(lanPrintMessage('submitted')).toContain('ไม่ส่งซ้ำอัตโนมัติ');
  expect(lanPrintMessage('unknown', 'timeout')).toContain('ตรวจเครื่องก่อนกดพิมพ์ซ้ำ');
});

import { hasInk } from '../src/domain/raster';
it('detects a blank capture so empty paper is never sent', () => {
  const white = { width: 2, height: 1, channels: 4, data: [255, 255, 255, 255, 255, 255, 255, 255] };
  const ink = { width: 2, height: 1, channels: 4, data: [255, 255, 255, 255, 0, 0, 0, 255] };
  const transparent = { width: 1, height: 1, channels: 4, data: [0, 0, 0, 0] };
  expect(hasInk(white)).toBe(false); expect(hasInk(ink)).toBe(true); expect(hasInk(transparent)).toBe(false);
});
