import type { NativeDeliveryStatus } from '../../../../src/modules/native-pos/contracts';
export function availableDeliveryActions(status: NativeDeliveryStatus): NativeDeliveryStatus[] {
  return status === 'received' ? ['accepted', 'cancelled'] : status === 'accepted' ? ['preparing'] : status === 'preparing' ? ['ready'] : [];
}
export function deliveryLabel(status: NativeDeliveryStatus): string {
  return ({ received: 'รอรับออเดอร์', accepted: 'รับแล้ว', preparing: 'กำลังเตรียม', ready: 'พร้อมให้ไรเดอร์รับ', completed: 'ส่งต่อแล้ว / ปิดงานจาก JDC', cancelled: 'ยกเลิกแล้ว' })[status] ?? status;
}
