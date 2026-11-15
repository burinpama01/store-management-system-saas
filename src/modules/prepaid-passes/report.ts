import { createSupabaseServerClient } from "@/server/integrations/supabase/server";

export interface PassReportPlanRow {
  planId: string;
  planName: string;
  sold: number;
  soldValue: number;
  creditsUsed: number;
  valueRecognized: number;
}

export interface PassReport {
  from: string;
  to: string;
  sold: {
    countAll: number;
    valueAll: number;
    countPos: number;
    valuePos: number;
    countOnline: number;
    valueOnline: number;
    creditsUsed: number;
    /** รายได้ที่รับรู้จากการใช้สิทธิ์ = มูลค่าต่อสิทธิ์ × สิทธิ์ที่ใช้ (หักที่คืนจาก void แล้ว) */
    valueRecognized: number;
    creditsExpired: number;
    valueExpired: number;
    countVoided: number;
    valueVoided: number;
  };
  outstanding: { passes: number; credits: number; value: number; expiring7d: number };
  byPlan: PassReportPlanRow[];
}

const n = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- ผลจาก RPC ใหม่ (ยังไม่อยู่ใน database.types) */
export function mapPassReport(raw: any): PassReport {
  const sold = raw?.sold ?? {};
  const outstanding = raw?.outstanding ?? {};
  return {
    from: String(raw?.from ?? ""),
    to: String(raw?.to ?? ""),
    sold: {
      countAll: n(sold.count_all),
      valueAll: n(sold.value_all),
      countPos: n(sold.count_pos),
      valuePos: n(sold.value_pos),
      countOnline: n(sold.count_online),
      valueOnline: n(sold.value_online),
      creditsUsed: n(sold.credits_used),
      valueRecognized: n(sold.value_recognized),
      creditsExpired: n(sold.credits_expired),
      valueExpired: n(sold.value_expired),
      countVoided: n(sold.count_voided),
      valueVoided: n(sold.value_voided),
    },
    outstanding: {
      passes: n(outstanding.passes),
      credits: n(outstanding.credits),
      value: n(outstanding.value),
      expiring7d: n(outstanding.expiring_7d),
    },
    byPlan: (Array.isArray(raw?.by_plan) ? raw.by_plan : []).map((row: any) => ({
      planId: String(row.plan_id ?? ""),
      planName: String(row.plan_name ?? ""),
      sold: n(row.sold),
      soldValue: n(row.sold_value),
      creditsUsed: n(row.credits_used),
      valueRecognized: n(row.value_recognized),
    })),
  };
}

export async function getPassReport(
  storeId: string,
  from: string,
  to: string,
): Promise<{ data: PassReport | null; error: string | null }> {
  const db: any = await createSupabaseServerClient();
  const { data, error } = await db.rpc("prepaid_pass_report", { p_store_id: storeId, p_from: from, p_to: to });
  if (error) return { data: null, error: error.message };
  return { data: mapPassReport(data), error: null };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
