export type BillingPlan = "free" | "starter" | "standard" | "premium" | "enterprise";

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
}

export interface PlanFeatures {
  maxStores: number;
  maxMembers: number;
  buffetManagement: boolean;
  stockManagement: boolean;
  advancedPrinting: boolean;
  qrOrdering: boolean;
  lineNotify: boolean;
  attendanceGps: boolean;
  advancedReports: boolean;
  advancedPermissions: boolean;
  multiBranchReporting: boolean;
  apiIntegration: boolean;
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
  buffetManagement: "บุฟเฟต์",
  stockManagement: "จัดการสต็อก",
  advancedPrinting: "ปริ้นขั้นสูง",
  qrOrdering: "QR Ordering",
  lineNotify: "LINE Notify",
  attendanceGps: "GPS ลงเวลา",
  advancedReports: "รายงานขั้นสูง",
  advancedPermissions: "สิทธิ์ขั้นสูง",
  multiBranchReporting: "รายงานหลายสาขา",
  apiIntegration: "API Integration",
};

export const PLAN_LABELS: Record<BillingPlan, string> = {
  free: "Free",
  starter: "Starter",
  standard: "Standard",
  premium: "Premium",
  enterprise: "Enterprise",
};

const PLAN_FEATURES: Record<BillingPlan, PlanFeatures> = {
  free: {
    maxStores: 1,
    maxMembers: 3,
    buffetManagement: false,
    stockManagement: false,
    advancedPrinting: false,
    qrOrdering: false,
    lineNotify: false,
    attendanceGps: false,
    advancedReports: false,
    advancedPermissions: false,
    multiBranchReporting: false,
    apiIntegration: false,
  },
  starter: {
    maxStores: 1,
    maxMembers: 10,
    buffetManagement: false,
    stockManagement: false,
    advancedPrinting: false,
    qrOrdering: false,
    lineNotify: false,
    attendanceGps: false,
    advancedReports: false,
    advancedPermissions: false,
    multiBranchReporting: false,
    apiIntegration: false,
  },
  standard: {
    maxStores: 3,
    maxMembers: 30,
    buffetManagement: true,
    stockManagement: true,
    advancedPrinting: true,
    qrOrdering: false,
    lineNotify: false,
    attendanceGps: false,
    advancedReports: true,
    advancedPermissions: false,
    multiBranchReporting: false,
    apiIntegration: false,
  },
  premium: {
    maxStores: 10,
    maxMembers: 100,
    buffetManagement: true,
    stockManagement: true,
    advancedPrinting: true,
    qrOrdering: true,
    lineNotify: true,
    attendanceGps: true,
    advancedReports: true,
    advancedPermissions: true,
    multiBranchReporting: false,
    apiIntegration: false,
  },
  enterprise: {
    maxStores: Infinity,
    maxMembers: Infinity,
    buffetManagement: true,
    stockManagement: true,
    advancedPrinting: true,
    qrOrdering: true,
    lineNotify: true,
    attendanceGps: true,
    advancedReports: true,
    advancedPermissions: true,
    multiBranchReporting: true,
    apiIntegration: true,
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

export function getPlanFeatures(state: BillingState): PlanFeatures {
  if (!isAccessAllowed(state)) return PLAN_FEATURES.free;
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
