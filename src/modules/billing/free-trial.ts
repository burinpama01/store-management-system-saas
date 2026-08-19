/**
 * แคมเปญ "ทดลอง Enterprise ฟรี 30 วัน" — แทนโปร Premium ฟรี 30 วันเดิม
 * ใช้ได้ครั้งเดียวตลอดกาลต่อผู้ใช้/ต่อกิจการ และเปิด-ปิดเป็นช่วงเวลาโดย super-admin
 */

export const FREE_TRIAL_PROMO_CODE = "enterprise_free_30d_once";
export const FREE_TRIAL_DAYS = 30;
export const FREE_TRIAL_PLAN = "enterprise" as const;
export const FREE_TRIAL_LABEL = "Enterprise ฟรี 30 วัน (ใช้ได้ 1 ครั้ง)";

export type FreeTrialUnavailableReason =
  | "campaign_closed"
  | "already_redeemed"
  | "active_subscription";

/** ช่วงเวลาแคมเปญที่ super-admin ตั้งไว้ (null = ไม่กำหนดขอบด้านนั้น) */
export interface FreeTrialCampaign {
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

export interface FreeTrialOffer {
  available: boolean;
  /** แคมเปญเปิดรับอยู่ไหม (แยกจากสิทธิ์รายบัญชี) */
  campaignOpen: boolean;
  campaignEndsAt: string | null;
  days: number;
  plan: typeof FREE_TRIAL_PLAN;
  promotionCode: typeof FREE_TRIAL_PROMO_CODE;
  promotionLabel: string;
  unavailableReason: FreeTrialUnavailableReason | null;
}

function toTime(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/** แคมเปญเปิดอยู่เมื่อเปิดสวิตช์ และ `now` อยู่ในช่วงเวลาที่กำหนด */
export function isFreeTrialCampaignOpen(
  campaign: FreeTrialCampaign,
  now: Date = new Date(),
): boolean {
  if (!campaign.enabled) return false;
  const at = now.getTime();
  const startsAt = toTime(campaign.startsAt);
  const endsAt = toTime(campaign.endsAt);
  if (startsAt !== null && at < startsAt) return false;
  if (endsAt !== null && at > endsAt) return false;
  return true;
}

export function computeFreeTrialExpiry(now: Date = new Date()): string {
  const next = new Date(now.getTime());
  next.setUTCDate(next.getUTCDate() + FREE_TRIAL_DAYS);
  return next.toISOString();
}

export function buildFreeTrialOffer(input: {
  campaign: FreeTrialCampaign;
  alreadyRedeemed: boolean;
  activeSubscription?: boolean;
  now?: Date;
}): FreeTrialOffer {
  const campaignOpen = isFreeTrialCampaignOpen(input.campaign, input.now ?? new Date());
  const available = campaignOpen && !input.alreadyRedeemed && !input.activeSubscription;

  return {
    available,
    campaignOpen,
    campaignEndsAt: input.campaign.endsAt,
    days: FREE_TRIAL_DAYS,
    plan: FREE_TRIAL_PLAN,
    promotionCode: FREE_TRIAL_PROMO_CODE,
    promotionLabel: FREE_TRIAL_LABEL,
    unavailableReason: !campaignOpen
      ? "campaign_closed"
      : input.alreadyRedeemed
        ? "already_redeemed"
        : input.activeSubscription
          ? "active_subscription"
          : null,
  };
}

/** ข้อความไทยอธิบายสาเหตุที่กดรับสิทธิ์ไม่ได้ */
export function describeFreeTrialRejection(reason: FreeTrialUnavailableReason | string | null): string {
  switch (reason) {
    case "already_redeemed":
      return "สิทธิ์ทดลองฟรี 30 วันนี้ถูกใช้ไปแล้ว";
    case "active_subscription":
      return "บัญชีนี้มีแพ็กเกจที่ยังใช้งานอยู่แล้ว";
    case "campaign_closed":
      return "โปรโมชั่นทดลองฟรี 30 วันปิดรับแล้ว";
    case "not_member":
      return "ไม่พบสิทธิ์ในกิจการนี้";
    default:
      return "เปิดใช้งานทดลองฟรี 30 วันไม่สำเร็จ";
  }
}
