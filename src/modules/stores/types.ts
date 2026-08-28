import type { StoreSetupProfile } from "@/modules/onboarding/setup-profile";
import type { ServiceButtonConfig } from "@/modules/qr-ordering/types";

export type QrOrderingMode = "table_bound" | "session_printed";

export type TableOpenPolicy = "staff_only" | "customer_self";

export type MusicLicenseStatus =
  | "not_requested"
  | "pending"
  | "approved"
  | "rejected"
  | "expired";

export interface Store {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  address?: string;
  phone?: string;
  logoUrl?: string;
  currencyCode: string;
  timezone: string;
  locale: string;
  isActive: boolean;
  buffetEnabled: boolean;
  qrOrderingEnabled: boolean;
  qrOrderingMode: QrOrderingMode;
  tableOpenPolicy: TableOpenPolicy;
  serviceButtons: ServiceButtonConfig[];
  musicRequestEnabled: boolean;
  musicLicenseStatus: MusicLicenseStatus;
  musicLicenseApprovedAt?: string;
  musicLicenseNote?: string;
  dineInDurationMinutes: number;
  /** เปิดโต๊ะแบบไม่จับเวลาโดยดีฟอลต์ */
  dineInNoExpiry: boolean;
  themePresetId: string;
  themePrimaryColor: string;
  themePrimaryStrongColor: string;
  themePrimarySoftColor: string;
  themeAccentColor: string;
  /** F1: โปรไฟล์ตอบ 3 คำถาม setup — null = legacy (ยังไม่ตอบ) ห้ามตีความเป็น false */
  setupProfile?: StoreSetupProfile | null;
  createdAt: string;
  updatedAt: string;
}

export interface Table {
  id: string;
  storeId: string;
  organizationId: string;
  number: string;
  label?: string;
  seats?: number;
  isActive: boolean;
  qrEnabled: boolean;
  currentSessionId?: string;
  sessionStartedAt?: string;
  sessionExpiresAt?: string;
  status: TableStatus;
  createdAt: string;
  updatedAt: string;
}

export type TableStatus = "available" | "occupied" | "reserved" | "cleaning";

export interface ReceiptSettings {
  id: string;
  storeId: string;
  organizationId: string;
  storeName: string;
  address?: string;
  phone?: string;
  taxId?: string;
  showTaxId: boolean;
  showQrPayment: boolean;
  promptpayId?: string;
  headerText?: string;
  footerText?: string;
  logoUrl?: string;
  footerImageUrl?: string;
  autoPrintReceipt: boolean;
  autoPrintStationTickets: boolean;
  paperWidth: "58mm" | "80mm";
  printCopies: number;
  /** พิมพ์บรรทัดแยกมูลค่าสินค้า/VAT ท้ายใบเสร็จ (VAT รวมในราคาแล้ว) */
  showVatBreakdown: boolean;
  vatRate: number;
  updatedAt: string;
}

export type PrinterType = "browser" | "usb" | "bluetooth" | "ip" | "escpos";

export interface Printer {
  id: string;
  storeId: string;
  organizationId: string;
  name: string;
  type: PrinterType;
  isDefault: boolean;
  ipAddress?: string;
  port?: number;
  usbVendorId?: string;
  usbProductId?: string;
  bluetoothDeviceId?: string;
  /** Cashier-PC Bluetooth SPP COM port (e.g. "COM5") for Hub-routed BT printing. */
  hubBluetoothPort?: string;
  paperWidth: "58mm" | "80mm";
  createdAt: string;
  updatedAt: string;
}
