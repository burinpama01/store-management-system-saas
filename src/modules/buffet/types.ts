export interface BuffetSession {
  id: string;
  organizationId: string;
  storeId: string;
  tableId: string | null;
  packageName: string;
  pricePerGuest: number;
  guestCount: number;
  totalCharge: number;
  startedAt: string;
  endedAt: string | null;
  status: "open" | "closed";
  orderId: string | null;
  createdAt: string;
  updatedAt: string;
}
