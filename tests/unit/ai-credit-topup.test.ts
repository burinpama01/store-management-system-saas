import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_FEATURE_LABELS, labelAiFeature } from "@/modules/ai/quota";

const root = process.cwd();
const migrationPath = "supabase/migrations/20260905000009_ai_credit_topups.sql";

function migration(): string {
  expect(existsSync(join(root, migrationPath))).toBe(true);
  return readFileSync(join(root, migrationPath), "utf8").toLowerCase().replace(/\s+/g, " ");
}

describe("โควตา AI รวมทุกฟีเจอร์", () => {
  it("ครอบคลุมทุกฟีเจอร์ที่เรียกโควตาจริง", () => {
    // ต้องตรงกับ feature key ที่ route แต่ละตัวส่งเข้า reserveQuota
    expect(Object.keys(AI_FEATURE_LABELS).sort()).toEqual(["aiAssistant", "aiVision", "aiVoiceIntent"]);
  });

  it("ฟีเจอร์ที่ไม่รู้จักยังแสดงชื่อ key เดิมแทนที่จะหาย", () => {
    expect(labelAiFeature("aiVision")).toBe("สแกนเมนูด้วย AI");
    expect(labelAiFeature("aiSomethingNew")).toBe("aiSomethingNew");
  });
});

describe("migration เครดิต AI", () => {
  it("แยกที่มาของโควตาเป็นรายเดือน/เครดิต", () => {
    const sql = migration();
    expect(sql).toContain("add column if not exists source text not null default 'monthly'");
    expect(sql).toContain("check (source in ('monthly', 'credit'))");
  });

  it("ยอดเครดิตห้ามติดลบ และหักได้เฉพาะเมื่อยอดพอทั้งก้อน", () => {
    const sql = migration();
    expect(sql).toContain("tokens_remaining bigint not null default 0 check (tokens_remaining >= 0)");
    expect(sql).toContain("where organization_id = p_organization_id and tokens_remaining >= p_max_tokens");
  });

  it("นับโควตาฟรีรายเดือนรวมทุกฟีเจอร์ (ไม่กรอง feature) และไม่นับส่วนที่หักเครดิต", () => {
    const sql = migration();
    expect(sql).toMatch(
      /select coalesce\(sum\(tokens_reserved\), 0\) into v_used from public\.ai_quota_reservations where organization_id = p_organization_id and source = 'monthly' and date_trunc\('month', created_at\) = date_trunc\('month', now\(\)\)/,
    );
    expect(sql).not.toMatch(/into v_used from public\.ai_quota_reservations where[^;]*feature = p_feature/);
  });

  it("กันสลิปซ้ำด้วย unique index เฉพาะใบที่ผ่านแล้ว", () => {
    const sql = migration();
    expect(sql).toContain("create unique index if not exists ai_credit_topups_slip_ref_verified_idx on public.ai_credit_topups (slip_ref) where status = 'verified' and slip_ref is not null");
  });

  it("เปิด RLS ทุกตารางใหม่ และให้อ่านได้เฉพาะองค์กรตัวเอง", () => {
    const sql = migration();
    for (const table of ["ai_credit_balances", "ai_credit_packs", "ai_credit_topups"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    expect(sql).toContain(
      "using (organization_id in (select organization_id from public.memberships where user_id = auth.uid()))",
    );
  });

  it("ไม่ให้ client เรียก add_ai_credit ได้เอง", () => {
    const sql = migration();
    expect(sql).toContain("revoke execute on function public.add_ai_credit(uuid, bigint) from public");
    expect(sql).not.toMatch(/grant execute on function public\.add_ai_credit[^;]*to authenticated/);
  });
});
