import type { NativeLine, NativeProduct } from '../../../../src/modules/native-pos/contracts';

export function quickSaleLine(product: NativeProduct): NativeLine | null {
  if (!product.available || product.variants.length || product.groups.length) return null;
  return { key: JSON.stringify([product.id, null, [], '']), productId: product.id, name: product.name,
    quantity: 1, unitSatang: product.priceSatang, variantId: null, optionIds: [], note: '', choiceLabel: '' };
}

export function saleLayout(width: number, fontScale = 1, measuredCatalogWidth?: number, height = 1000) {
  const compact = height < 500;
  const wide = (width >= 820 || (compact && width >= 600)) && fontScale < 1.5;
  const sidebarWidth = compact ? 72 : 88;
  const cartWidth = width < 820 ? 260 : 350;
  const catalogWidth = Math.max(128, measuredCatalogWidth ?? width - (wide ? sidebarWidth + cartWidth : 0) - 32);
  const columns = Math.max(1, Math.floor((catalogWidth + 12) / (Math.max(148, 148 * fontScale) + 12)));
  return { wide, compact, sidebarWidth, cartWidth, catalogWidth, columns, cardWidth: Math.floor((catalogWidth - (columns - 1) * 12) / columns) };
}
