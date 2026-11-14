import type { Product } from '@/modules/catalog/types';
import { buildCartItemKey, type Cart } from '@/modules/pos/types';
import type { NativeCheckoutInput, NativeProduct } from './contracts';
export const satang = (amount: number) => Math.round(amount * 100);
function productImage(value?: string): string | null {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function nativeProduct(product: Product): NativeProduct {
  return { id: product.id, name: product.name, categoryId: product.categoryId, imageUrl: productImage(product.imageUrl), priceSatang: satang(product.basePrice), available: product.isActive && product.availableForPos && !product.outOfStock,
    variants: product.variants.filter(v => v.isActive).map(v => ({ id: v.id, name: v.name, priceSatang: satang(v.priceAdjustment) })),
    groups: product.modifierGroups.map(g => ({ id: g.id, name: g.name, min: Math.max(g.isRequired ? 1 : 0, g.minSelections ?? 0), max: g.selectionType === 'single' ? 1 : g.maxSelections || g.options.length, options: g.options.filter(o => o.isActive).map(o => ({ id: o.id, name: o.name, priceSatang: satang(o.priceAdjustment) })) })) };
}
export function authoritativeCart(storeId: string, input: NativeCheckoutInput, products: Product[]): Cart {
  const items = input.lines.map(line => {
    const product = products.find(p => p.id === line.productId && p.storeId === storeId);
    if (!product || !product.isActive || !product.availableForPos || product.outOfStock) throw new Error('สินค้าไม่พร้อมขาย');
    const choices = nativeProduct(product);
    const variant = product.variants.find(v => v.id === line.variantId && v.isActive) ?? null;
    if ((line.variantId && !variant) || (choices.variants.length > 0 && !variant)) throw new Error('กรุณาเลือกตัวเลือกสินค้าใหม่');
    if (new Set(line.optionIds).size !== line.optionIds.length) throw new Error('ตัวเลือกซ้ำ');
    const modifiers = product.modifierGroups.flatMap(group => group.options.filter(o => o.isActive && line.optionIds.includes(o.id)).map(option => ({ modifierGroupId: group.id, modifierGroupName: group.name, option: { id: option.id, name: option.name, priceAdjustment: option.priceAdjustment } })));
    if (modifiers.length !== line.optionIds.length) throw new Error('ตัวเลือกสินค้าไม่ถูกต้อง');
    for (const group of choices.groups) { const count = modifiers.filter(m => m.modifierGroupId === group.id).length; if (count < group.min || count > group.max) throw new Error('จำนวนตัวเลือกสินค้าไม่ถูกต้อง'); }
    const price = satang(product.basePrice) + satang(variant?.priceAdjustment ?? 0) + modifiers.reduce((sum, m) => sum + satang(m.option.priceAdjustment), 0);
    if (!Number.isSafeInteger(price) || price < 0) throw new Error('ราคาสินค้าไม่ถูกต้อง');
    return { key: buildCartItemKey({ productId: product.id, variantId: variant?.id ?? null, modifierOptionIds: line.optionIds, note: line.note }), productId: product.id, productName: product.name, categoryId: product.categoryId, variant, modifiers, quantity: line.quantity, unitPrice: price / 100, totalPrice: price * line.quantity / 100, note: line.note };
  });
  const total = items.reduce((sum, item) => sum + satang(item.totalPrice), 0) / 100;
  return { storeId, items, subtotal: total, discount: 0, total };
}
