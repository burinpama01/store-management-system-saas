import type { OrderingStore } from "@/modules/online-orders/public";

/** props ของ OrderApp จากร้านที่เปิดสั่งออนไลน์ — ใช้ทั้งหน้าเว็บร้าน (/s/<slug>/order) และหน้าสมาชิก (/member/<slug>/order) */
export function orderAppStoreProps(store: OrderingStore) {
  return {
    slug: store.slug,
    storeName: store.storeName,
    storePhone: store.phone,
    pickupEnabled: store.settings.pickupEnabled,
    deliveryEnabled: store.settings.deliveryEnabled,
    minOrder: store.settings.minOrder,
    prepMinutes: store.settings.prepMinutes,
    deliveryRadiusKm: store.settings.deliveryRadiusKm,
    deliveryFreeKm: store.settings.deliveryFreeKm,
    cod:
      store.settings.codEnabled && store.settings.deliveryEnabled
        ? { maxPerBill: store.settings.codMaxPerBill, requireOtp: store.settings.codRequireOtp }
        : null,
    // จุดเริ่มแผนที่ปักหมุด = ย่านร้าน — ปัด 3 ตำแหน่ง (~100 ม.) พิกัดร้านมาจากจุดลงเวลา ไม่เปิดเผยละเอียดบนหน้าสาธารณะ
    storeOrigin:
      store.settings.originLat !== null && store.settings.originLng !== null
        ? { lat: Math.round(store.settings.originLat * 1000) / 1000, lng: Math.round(store.settings.originLng * 1000) / 1000 }
        : null,
  };
}
