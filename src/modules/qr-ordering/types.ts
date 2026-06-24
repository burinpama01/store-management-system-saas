import type { SelectedModifier } from "@/modules/pos/types";

export type PrepStatus = "new" | "preparing" | "served" | "done";
export type ServiceRequestType = "call_staff" | "request_bill";
export type ServiceRequestStatus = "pending" | "resolved";

export interface QrOrderLine {
  id: string;
  productName: string;
  variantName?: string;
  kitchenStationId?: string;
  kitchenStationName?: string;
  modifiers: SelectedModifier[];
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  note?: string;
}

/** A QR order as seen by the customer (tracking) and the restaurant (board). */
export interface QrOrderView {
  id: string;
  orderNumber: string;
  status: "draft" | "open" | "pending_payment" | "paid" | "refunded" | "voided" | "cancelled";
  prepStatus: PrepStatus;
  tableId?: string;
  tableNumber?: string;
  total: number;
  note?: string;
  items: QrOrderLine[];
  createdAt: string;
  paidAt?: string;
}

export interface ServiceRequest {
  id: string;
  storeId: string;
  tableId: string;
  tableNumber: string;
  type: ServiceRequestType;
  status: ServiceRequestStatus;
  note?: string;
  createdAt: string;
  resolvedAt?: string;
}

export const PREP_STATUS_LABEL: Record<PrepStatus, string> = {
  new: "ออร์เดอร์ใหม่",
  preparing: "กำลังเตรียม",
  served: "เสิร์ฟแล้ว",
  done: "เสร็จสิ้น",
};

export const SERVICE_REQUEST_LABEL: Record<ServiceRequestType, string> = {
  call_staff: "เรียกพนักงาน",
  request_bill: "ขอเช็คบิล",
};
