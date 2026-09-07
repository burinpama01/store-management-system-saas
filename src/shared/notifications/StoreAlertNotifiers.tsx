import {
  listAssignedKitchenStationIdsForUser,
  listKitchenStations,
} from "@/modules/qr-ordering/kitchen-stations";
import { getReceiptSettings } from "@/modules/settings/repository";
import { listPrinters } from "@/modules/stores/repository";
import { QrOrderGlobalNotifier } from "@/app/(dashboard)/QrOrderGlobalNotifier";
import { DeliveryGlobalNotifier } from "@/app/(dashboard)/DeliveryGlobalNotifier";
import { NotificationGlobalNotifier } from "@/app/(dashboard)/NotificationGlobalNotifier";

interface Props {
  storeId: string;
  organizationId: string;
  storeName: string;
  userId: string;
  role: string;
  qrOrderingEnabled: boolean;
  canManageQr: boolean;
  canViewNotifications: boolean;
  /** stores.notification_voice_enabled — ค่าเริ่มต้นเสียงพูดของร้าน (เครื่องปรับทับได้) */
  voiceEnabled: boolean;
}

/**
 * ชุดตัวเด้งออเดอร์/แจ้งเตือนกลาง — เดิมประกอบอยู่ใน (dashboard)/layout.tsx ที่เดียว
 *
 * ทำไมต้องแยกออกมา: หน้า POS อยู่นอก route group (dashboard) จึงไม่เคยได้ตัวเด้งพวกนี้เลย
 * เครื่องที่รัน Launcher ซึ่งเปิดค้างที่ /pos ตลอดวันจึงไม่รู้ว่ามีออเดอร์เดลิเวอรี/QR เข้า
 * ต้องเดินออกจาก POS ไปหน้าแดชบอร์ดก่อนถึงจะเห็น
 *
 * ตั้งใจให้เป็น component ไม่ใช่ layout ของ /pos เพราะ layout จะครอบ /pos/display
 * ซึ่งเป็นจอที่หันหาลูกค้า — เด้ง dialog ออเดอร์ตรงนั้นคือโชว์ข้อมูลร้านให้ลูกค้าดู
 */
export async function StoreAlertNotifiers({
  storeId,
  organizationId,
  storeName,
  userId,
  role,
  qrOrderingEnabled,
  canManageQr,
  canViewNotifications,
  voiceEnabled,
}: Props) {
  const assignedKitchenStationIds =
    canManageQr && qrOrderingEnabled && role === "staff"
      ? (await listAssignedKitchenStationIdsForUser(storeId, userId)).data ?? []
      : [];

  const [stationsForPrinting, receiptSettingsForPrinting, printersForPrinting] = canManageQr
    ? await Promise.all([
        listKitchenStations(storeId),
        getReceiptSettings(storeId, organizationId),
        listPrinters(storeId, organizationId),
      ])
    : [{ data: [] }, { data: null }, { data: [] }];

  const receiptPrinters = printersForPrinting.data ?? [];
  const stationPrinters = (stationsForPrinting.data ?? [])
    .filter((station) => station.printerId)
    .map((station) => ({ id: station.id, name: station.name, printerId: station.printerId }));
  const deliveryStationPrinters = (stationsForPrinting.data ?? [])
    .filter((station) => station.printerId)
    .map((station) => ({ id: station.id, name: station.name, printerId: station.printerId as string }));
  const autoPrintStationTickets = Boolean(receiptSettingsForPrinting.data?.autoPrintStationTickets);
  const receiptPaperWidth = receiptSettingsForPrinting.data?.paperWidth === "58mm" ? "58mm" : "80mm";

  return (
    <>
      {canViewNotifications && (
        <NotificationGlobalNotifier storeId={storeId} voiceEnabled={voiceEnabled} />
      )}
      <QrOrderGlobalNotifier
        storeId={storeId}
        storeName={storeName}
        qrOrderingEnabled={qrOrderingEnabled}
        canManageQr={canManageQr}
        canViewEveryKitchenStation={role !== "staff"}
        assignedKitchenStationIds={assignedKitchenStationIds}
        stationPrinters={stationPrinters}
        autoPrintStationTickets={autoPrintStationTickets}
        receiptPaperWidth={receiptPaperWidth}
        receiptPrinters={receiptPrinters}
        voiceEnabled={voiceEnabled}
      />
      <DeliveryGlobalNotifier
        storeId={storeId}
        canManage={canManageQr}
        storeName={storeName}
        stationPrinters={deliveryStationPrinters}
        paperWidth={receiptPaperWidth}
        printers={receiptPrinters}
        autoPrintOnArrival={autoPrintStationTickets}
        voiceEnabled={voiceEnabled}
      />
    </>
  );
}
