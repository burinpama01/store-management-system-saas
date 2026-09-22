export type PlatformBillingOrder = {
  id: string;
  organization_id: string;
  submitted_by: string;
  plan: "starter" | "standard" | "premium" | "business" | "enterprise";
  /** "custom" = Enterprise ตามข้อเสนอรายบัญชี อายุอยู่ใน term_days/term_ends_at */
  duration: "30d" | "1y" | "custom";
  amount: number;
  discount_code_id: string | null;
  discount_amount: number;
  business_seats: number | null;
  business_stores: number | null;
  business_features: string[];
  /** อายุที่แอดมินกำหนดให้บัญชีนี้ (null ทั้งคู่ = แพ็กเกจปกติ ใช้ duration) */
  term_days: number | null;
  term_ends_at: string | null;
  method: "beam" | "slip";
  environment: "test" | "live";
  credentials_encrypted: string | null;
  receiver_account: string | null;
  qr_payload: string | null;
  qr_image: string | null;
  charge_id: string | null;
  creation_attempted: boolean;
  status: "creating" | "pending" | "failed" | "paid" | "test_paid";
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  new_expiry: string | null;
};

export type BillingOrderView = Pick<PlatformBillingOrder,
  "id" | "plan" | "duration" | "amount" | "method" | "environment" | "qr_payload" | "qr_image" | "status" | "expires_at" | "new_expiry">;

export function billingOrderView(order: PlatformBillingOrder): BillingOrderView {
  const { id, plan, duration, amount, method, environment, qr_payload, qr_image, status, expires_at, new_expiry } = order;
  return { id, plan, duration, amount: Number(amount), method, environment, qr_payload, qr_image, status, expires_at, new_expiry };
}
