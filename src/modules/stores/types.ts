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
  dineInDurationMinutes: number;
  themePresetId: string;
  themePrimaryColor: string;
  themePrimaryStrongColor: string;
  themePrimarySoftColor: string;
  themeAccentColor: string;
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
  paperWidth: "58mm" | "80mm";
  createdAt: string;
  updatedAt: string;
}
