import { expect, it } from 'vitest';
import { rasterEscPos, validateLanTarget } from '../src/domain/raster';
it('packs pixels MSB-first, pads white, and composites transparent pixels on white', () => {
  const result = rasterEscPos({ width: 3, height: 1, channels: 4, depth: 8, data: [0,0,0,255, 0,0,0,0, 255,255,255,255] });
  expect([...result]).toEqual([27,64,29,118,48,0,1,0,1,0,128,27,100,4]);
});
it('rejects invalid images and sends only explicitly entered private network destinations', () => {
  expect(() => rasterEscPos({ width: 384, height: 2, channels: 4, depth: 8, data: [] })).toThrow();
  for (const host of ['127.0.0.1', '8.8.8.8', '192.168.1.256', 'localhost', '192.168.01.1']) expect(() => validateLanTarget(host, 9100)).toThrow();
  expect(() => validateLanTarget('192.168.1.20', 9100)).not.toThrow();
  expect(() => validateLanTarget('10.0.0.20', 0)).toThrow();
});
