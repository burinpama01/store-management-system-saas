export type BillingPlan = "free" | "starter" | "standard" | "premium" | "business" | "enterprise";

export type BillingStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid"
  | "canceled"
  | "paused";

export interface BillingState {
  plan: BillingPlan;
  status: BillingStatus;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
  /** Selected seats/stores/features when plan = "business" (build-your-own). */
  business?: BusinessPlanConfig | null;
}

/** A tenant-selected Business plan configuration (build-your-own). */
export interface BusinessPlanConfig {
  /** จำนวนที่นั่ง (สมาชิก/พนักงานที่ใช้ระบบได้) */
  seats: number;
  /** จำนวนสาขา */
  stores: number;
  /** ฟีเจอร์ที่เลือกเปิดใช้ */
  features: FeatureKey[];
}

export interface PlanFeatures {
  maxStores: number;
  maxMembers: number;
  groceryPos: boolean;
  couponManagement: boolean;
  loyaltyPoints: boolean;
  buffetManagement: boolean;
  stockManagement: boolean;
  advancedPrinting: boolean;
  qrOrdering: boolean;
  customerDisplay: boolean;
  offlinePos: boolean;
  lineNotify: boolean;
  attendanceGps: boolean;
  advancedReports: boolean;
  advancedPermissions: boolean;
  multiBranchReporting: boolean;
  apiIntegration: boolean;
  musicRequest: boolean;
}

export type FeatureKey = keyof PlanFeatures;

export const DEFAULT_BILLING_STATE: BillingState = {
  plan: "free",
  status: "active",
  currentPeriodEnd: "2099-12-31T23:59:59Z",
  cancelAtPeriodEnd: false,
  trialEnd: null,
};

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  maxStores: "จำนวนสาขา",
  maxMembers: "จำนวนสมาชิก",
  groceryPos: "Grocery POS",
  couponManagement: "คูปอง",
  loyaltyPoints: "สะสมแต้ม",
  buffetManagement: "บุฟเฟต์",
  stockManagement: "จัดการสต็อก",
  advancedPrinting: "ปริ้นขั้นสูง",
  qrOrdering: "QR Ordering",
  customerDisplay: "จอลูกค้า",
  offlinePos: "Offline POS",
  lineNotify: "LINE Notify",
  attendanceGps: "GPS ลงเวลา",
  advancedReports: "รายงานขั้นสูง",
  advancedPermissions: "สิทธิ์ขั้นสูง",
  multiBranchReporting: "รายงานหลายสาขา",
  apiIntegration: "API Integration",
  musicRequest: "ขอเพลง",
};

export const PLAN_LABELS: Record<BillingPlan, string> = {
  free: "Free",
  starter: "Starter",
  standard: "Standard",
  premium: "Premium",
  business: "Business",
  enterprise: "Enterprise",
};

/** Boolean features a Business tenant can toggle on individually. */
export const BUSINESS_SELECTABLE_FEATURES: Exclude<FeatureKey, "maxStores" | "maxMembers">[] = [
  "groceryPos",
  "couponManagement",
  "loyaltyPoints",
  "buffetManagement",
  "stockManagement",
  "advancedPrinting",
  "qrOrdering",
  "customerDisplay",
  "offlinePos",
  "lineNotify",
  "attendanceGps",
  "advancedReports",
  "advancedPermissions",
  "multiBranchReporting",
  "apiIntegration",
  "musicRequest",
];

/** Builds the effective feature set for a Business config (pure). */
export function businessConfigToPlanFeatures(config: BusinessPlanConfig): PlanFeatures {
  const features: PlanFeatures = {
    ...PLAN_FEATURES.free,
    maxStores: Math.max(1, config.stores),
    maxMembers: Math.max(1, config.seats),
  };
  for (const key of config.features) {
    if ((BUSINESS_SELECTABLE_FEATURES as FeatureKey[]).includes(key)) {
      features[key as Exclude<FeatureKey, "maxStores" | "maxMembers">] = true;
    }
  }
  return features;
}

const PLAN_FEATURES: Record<Exclude<BillingPlan, "business">, PlanFeatures> = {
  free: {
    maxStores: 1,
    maxMembers: 1,
    groceryPos: false,
    couponManagement: false,
    loyaltyPoints: false,
    buffetManagement: false,
    stockManagement: false,
    advancedPrinting: false,
    qrOrdering: false,
    customerDisplay: false,
    offlinePos: false,
    lineNotify: false,
    attendanceGps: false,
    advancedReports: false,
    advancedPermissions: false,
    multiBranchReporting: false,
    apiIntegration: false,
    musicRequest: false,
  },
  starter: {
    maxStores: 1,
    maxMembers: 3,
    groceryPos: true,
    couponManagement: false,
    loyaltyPoints: false,
    buffetManagement: false,
    stockManagement: false,
    advancedPrinting: false,
    qrOrdering: false,
    customerDisplay: false,
    offlinePos: false,
    lineNotify: false,
    attendanceGps: false,
    advancedReports: false,
    advancedPermissions: false,
    multiBranchReporting: false,
    apiIntegration: false,
    musicRequest: false,
  },
  standard: {
    maxStores: 3,
    maxMembers: 10,
    groceryPos: true,
    couponManagement: false,
    loyaltyPoints: false,
    buffetManagement: true,
    stockManagement: true,
    advancedPrinting: true,
    qrOrdering: false,
    customerDisplay: false,
    offlinePos: false,
    lineNotify: false,
    attendanceGps: false,
    advancedReports: true,
    advancedPermissions: false,
    multiBranchReporting: false,
    apiIntegration: false,
    musicRequest: false,
  },
  premium: {
    maxStores: 5,
    maxMembers: 50,
    groceryPos: true,
    couponManagement: true,
    loyaltyPoints: true,
    buffetManagement: true,
    stockManagement: true,
    advancedPrinting: true,
    qrOrdering: true,
    customerDisplay: false,
    offlinePos: true,
    lineNotify: true,
    attendanceGps: true,
    advancedReports: true,
    advancedPermissions: true,
    multiBranchReporting: false,
    apiIntegration: false,
    musicRequest: false,
  },
  enterprise: {
    maxStores: Infinity,
    maxMembers: Infinity,
    groceryPos: true,
    couponManagement: true,
    loyaltyPoints: true,
    buffetManagement: true,
    stockManagement: true,
    advancedPrinting: true,
    qrOrdering: true,
    customerDisplay: true,
    offlinePos: true,
    lineNotify: true,
    attendanceGps: true,
    advancedReports: true,
    advancedPermissions: true,
    multiBranchReporting: true,
    apiIntegration: true,
    musicRequest: true,
  },
};

export function isAccessAllowed(state: BillingState): boolean {
  switch (state.status) {
    case "active":
    case "trialing":
      return true;
    case "past_due":
      return true; // grace access — show billing warning in UI
    case "incomplete":
    case "incomplete_expired":
    case "unpaid":
    case "canceled":
    case "paused":
      return false;
    default: {
      const _exhaustive: never = state.status;
      void _exhaustive;
      return false;
    }
  }
}

/** Plans that are paid per period and lose their features when the window lapses. */
function isExpiringPlan(plan: BillingPlan): boolean {
  return plan === "starter" || plan === "standard" || plan === "premium" || plan === "business";
}

/**
 * Enterprise ปกติเป็นสัญญาที่ไม่มีวันหมด แต่สิทธิ์ "ทดลอง Enterprise ฟรี 30 วัน"
 * ถูกบันทึกเป็น status='trialing' และต้องหมดอายุจริงเมื่อพ้น current_period_end.
 */
export function isExpiringState(state: BillingState): boolean {
  if (state.plan === "enterprise") return state.status === "trialing";
  return isExpiringPlan(state.plan);
}

/** True when the paid window is still valid at `now`. Duplicated from pricing.ts
 * (isSubscriptionCurrent) because importing it here would be a circular import. */
function isPeriodCurrent(currentPeriodEnd: string, now: Date): boolean {
  const exp = new Date(currentPeriodEnd);
  return !Number.isNaN(exp.getTime()) && exp.getTime() > now.getTime();
}

export function getPlanFeatures(state: BillingState, now: Date = new Date()): PlanFeatures {
  if (!isAccessAllowed(state)) return PLAN_FEATURES.free;
  // Expired paid plans degrade to free everywhere — including public surfaces
  // (QR ordering, music player) and API/webhook/notification paths that are not
  // behind the dashboard billing-redirect gate.
  if (isExpiringState(state) && !isPeriodCurrent(state.currentPeriodEnd, now)) {
    return PLAN_FEATURES.free;
  }
  if (state.plan === "business") {
    // No stored config (e.g. plan set manually without a purchase) = free features.
    return state.business ? businessConfigToPlanFeatures(state.business) : PLAN_FEATURES.free;
  }
  return PLAN_FEATURES[state.plan] ?? PLAN_FEATURES.free;
}

export function getFeatureLimit(
  state: BillingState,
  feature: Extract<FeatureKey, "maxStores" | "maxMembers">,
): number {
  return getPlanFeatures(state)[feature];
}

export function explainFeatureLock(
  state: BillingState,
  feature: FeatureKey,
): string | null {
  const features = getPlanFeatures(state);
  const value = features[feature];
  if (typeof value === "number") return null;
  if (value) return null;
  return `${FEATURE_LABELS[feature]} ถูกจำกัดในแพ็กเกจ ${PLAN_LABELS[state.plan]}`;
}

export function canUseFeature(
  state: BillingState,
  feature: keyof PlanFeatures,
): boolean {
  const features = getPlanFeatures(state);
  const val = features[feature];
  return typeof val === "boolean" ? val : (val as number) > 0;
}
