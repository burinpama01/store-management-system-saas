import type { NativeBootstrap, NativeDeliveryOrder } from '../../../src/modules/native-pos/contracts';
export const demo: NativeBootstrap = {
  userId: 'demo-user', stores: [{ id: 'demo-store', name: 'StoreOS Café · ข้อมูลสาธิต' }], store: { id: 'demo-store', name: 'StoreOS Café · ข้อมูลสาธิต' }, permissions: { sell: true, delivery: true },
  categories: [{ id: 'coffee', name: 'กาแฟ' }, { id: 'tea', name: 'ชาและเครื่องดื่ม' }, { id: 'bakery', name: 'เบเกอรี' }],
  products: [
    ['espresso', 'เอสเปรสโซ', 'coffee', 5500], ['americano', 'อเมริกาโน', 'coffee', 6500], ['latte', 'ลาเต้', 'coffee', 7500], ['cappuccino', 'คาปูชิโน', 'coffee', 7500], ['matcha', 'มัทฉะลาเต้', 'tea', 8500], ['thai-tea', 'ชาไทย', 'tea', 6500], ['cocoa', 'โกโก้', 'tea', 7500], ['lemon', 'ชามะนาว', 'tea', 6000], ['croissant', 'ครัวซองต์เนยสด', 'bakery', 8500], ['brownie', 'บราวนี', 'bakery', 7500], ['cheesecake', 'ชีสเค้ก', 'bakery', 12000], ['cookie', 'คุกกี้ช็อกโกแลต', 'bakery', 4500],
  ].map(([id, name, categoryId, priceSatang]) => ({ id: String(id), name: String(name), categoryId: String(categoryId), priceSatang: Number(priceSatang), available: true, variants: [], groups: categoryId === 'bakery' ? [] : [{ id: 'sweetness', name: 'ความหวาน', min: 1, max: 1, options: [{ id: 'normal', name: 'หวานปกติ', priceSatang: 0 }, { id: 'less', name: 'หวานน้อย', priceSatang: 0 }, { id: 'none', name: 'ไม่หวาน', priceSatang: 0 }] }] })),
};
export const demoDelivery: NativeDeliveryOrder[] = [{ id: 'demo-jdc-1', externalId: 'JDC-DEMO-001', internalOrderId: null, number: 'JDC-DEMO-001', status: 'received', totalSatang: 15000, createdAt: '2026-09-09T09:10:00Z', lines: [{ key: 'latte', productId: 'latte', name: 'ลาเต้', quantity: 2, unitSatang: 7500, variantId: null, optionIds: [], note: 'หวานน้อย' }] }];
