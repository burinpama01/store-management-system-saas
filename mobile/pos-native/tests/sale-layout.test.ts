import { expect, it } from 'vitest';
import { quickSaleLine, saleLayout } from '../src/domain/sale-layout';
import { demo } from '../src/demo';

it('adds only available simple products with no choices in one tap', () => {
  const simple = { ...demo.products[0], variants: [], groups: [], available: true };
  const line = quickSaleLine(simple);
  expect(line).toMatchObject({ productId: simple.id, quantity: 1, unitSatang: simple.priceSatang, variantId: null, optionIds: [] });
  expect(line?.key).toBe(JSON.stringify([simple.id, null, [], '']));
  expect(quickSaleLine({ ...simple, available: false })).toBeNull();
  expect(quickSaleLine({ ...simple, variants: [{ id: 'large', name: 'Large', priceSatang: 100 }] })).toBeNull();
  expect(quickSaleLine({ ...simple, groups: [{ id: 'g', name: 'Choice', min: 0, max: 1, options: [] }] })).toBeNull();
});

it('fits menu cards and cart in phone, tablet and enlarged text layouts', () => {
  for (const width of [320, 375, 390, 430, 768, 834, 1024, 1366]) {
    for (const scale of [1, 1.6, 2]) {
      const layout = saleLayout(width, scale);
      expect(layout.cardWidth).toBeGreaterThanOrEqual(128);
      expect(layout.cardWidth * layout.columns + (layout.columns - 1) * 12).toBeLessThanOrEqual(layout.catalogWidth);
    }
  }
  expect(saleLayout(390).wide).toBe(false);
  expect(saleLayout(834).wide).toBe(true);
  expect(saleLayout(834, 2).wide).toBe(false);
  expect(saleLayout(640, 1, undefined, 360)).toMatchObject({ wide: true, compact: true, cartWidth: 260, sidebarWidth: 72 });
  expect(saleLayout(1024, 1, 280).cardWidth).toBeLessThanOrEqual(280);
});
