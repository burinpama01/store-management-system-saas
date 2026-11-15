import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { memberPhoneKey } from "@/modules/members/phone-key";
import {
  MEMBER_REDEEM_CODE_TTL_SECONDS,
  generateMemberRedeemCode,
  hashMemberRedeemCode,
  issueStatusMessage,
  normalizeMemberRedeemCodeInput,
  verifyStatusMessage,
} from "@/modules/members/redeem-code";
import { canUseMemberPrivileges } from "@/modules/members/access";
import { buildSettingsTabs } from "@/app/(dashboard)/settings/settings-tabs";
import { resolvePermissions } from "@/modules/auth/permission-resolver";
import type { BillingPlan, BillingState, BillingStatus } from "@/modules/billing/types";

const read = (path: string) => readFileSync(path, "utf8");
const MIGRATION = "supabase/migrations/20261115120000_member_identity_redeem_codes.sql";

function state(plan: BillingPlan, status: BillingStatus = "active", currentPeriodEnd = "2099-01-01T00:00:00Z"): BillingState {
  return { plan, status, currentPeriodEnd, cancelAtPeriodEnd: false, trialEnd: null };
}

describe("memberPhoneKey — เบอร์เดียวกัน = คนเดียวกันทุกสาขา", () => {
  it("เหลือแต่ตัวเลขและตัดขีด/ช่องว่าง/วงเล็บ", () => {
    expect(memberPhoneKey("081-234-5678")).toBe("0812345678");
    expect(memberPhoneKey(" (081) 234 5678 ")).toBe("0812345678");
  });

  it("แปลงรหัสประเทศไทยเป็น 0 นำหน้า", () => {
    expect(memberPhoneKey("+66812345678")).toBe("0812345678");
    expect(memberPhoneKey("66812345678")).toBe("0812345678");
    expect(memberPhoneKey("0066812345678")).toBe("0812345678");
  });

  it("เบอร์บ้าน 9 หลักยังเป็นคีย์ได้", () => {
    expect(memberPhoneKey("02-123-4567")).toBe("021234567");
  });

  it("ไม่มีเบอร์หรือสั้น/ยาวผิดปกติ = ไม่มี identity", () => {
    expect(memberPhoneKey(null)).toBeNull();
    expect(memberPhoneKey("")).toBeNull();
    expect(memberPhoneKey("1234")).toBeNull();
    expect(memberPhoneKey("1".repeat(16))).toBeNull();
  });

  it("กฎตรงกับฟังก์ชัน SQL member_phone_key", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("create or replace function public.member_phone_key(p_phone text)");
    expect(sql).toContain("when d ~ '^0066[0-9]{9}$' then '0' || substr(d, 5)");
    expect(sql).toContain("when d ~ '^66[0-9]{9}$' then '0' || substr(d, 3)");
    expect(sql).toContain("when length(d) between 9 and 15 then d");
    expect(sql).toContain("regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')");
  });
});

describe("รหัสใช้สิทธิ์ 6 หลัก", () => {
  it("อายุ 5 นาทีตามที่ผู้ใช้กำหนด", () => {
    expect(MEMBER_REDEEM_CODE_TTL_SECONDS).toBe(300);
  });

  it("สุ่มได้ตัวเลข 6 หลักเสมอ (รวมเลข 0 นำหน้า)", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateMemberRedeemCode()).toMatch(/^[0-9]{6}$/);
    }
  });

  it("hash ผูกกับองค์กร — รหัสเดียวกันต่างองค์กรได้ hash ต่างกัน", () => {
    const a = hashMemberRedeemCode("org-a", "123456");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMemberRedeemCode("org-a", "123456")).toBe(a);
    expect(hashMemberRedeemCode("org-b", "123456")).not.toBe(a);
  });

  it("รับค่าที่แคชเชียร์พิมพ์/สแกน", () => {
    expect(normalizeMemberRedeemCodeInput("482913")).toBe("482913");
    expect(normalizeMemberRedeemCodeInput(" 482 913 ")).toBe("482913");
    expect(normalizeMemberRedeemCodeInput("482-913")).toBe("482913");
    expect(normalizeMemberRedeemCodeInput("48291")).toBeNull();
    expect(normalizeMemberRedeemCodeInput("0812345678")).toBeNull();
    expect(normalizeMemberRedeemCodeInput("abc123")).toBeNull();
    expect(normalizeMemberRedeemCodeInput(null)).toBeNull();
  });

  it("ข้อความผิดพลาดเป็นภาษาไทยและบอกครั้งที่เหลือ", () => {
    expect(verifyStatusMessage("invalid", 3)).toContain("เหลือ 3 ครั้ง");
    expect(verifyStatusMessage("locked")).toContain("10 นาที");
    expect(issueStatusMessage("no_phone")).toContain("เบอร์โทรศัพท์");
  });
});

describe("Enterprise เท่านั้น", () => {
  it("enterprise ที่ใช้งานอยู่ใช้ได้", () => {
    expect(canUseMemberPrivileges(state("enterprise"))).toBe(true);
  });

  it("แพ็กเกจอื่นใช้ไม่ได้ แม้มีสะสมแต้ม", () => {
    expect(canUseMemberPrivileges(state("premium"))).toBe(false);
    expect(canUseMemberPrivileges(state("free"))).toBe(false);
  });

  it("enterprise ที่ถูกยกเลิกใช้ไม่ได้", () => {
    expect(canUseMemberPrivileges(state("enterprise", "canceled"))).toBe(false);
  });

  it("แท็บตั้งค่าโชว์เฉพาะ owner/admin ของร้าน Enterprise", () => {
    const hrefs = (role: "owner" | "admin" | "manager" | "cashier", plan: BillingPlan) =>
      buildSettingsTabs(resolvePermissions(role, [], "org", "store"), state(plan)).map((tab) => tab.href);
    expect(hrefs("owner", "enterprise")).toContain("/settings/member-privileges");
    expect(hrefs("admin", "enterprise")).toContain("/settings/member-privileges");
    expect(hrefs("manager", "enterprise")).not.toContain("/settings/member-privileges");
    expect(hrefs("cashier", "enterprise")).not.toContain("/settings/member-privileges");
    expect(hrefs("owner", "premium")).not.toContain("/settings/member-privileges");
  });
});

describe("migration P0 — ความปลอดภัย", () => {
  const sql = read(MIGRATION);

  it("สวิตช์ต่อสาขาปิดเป็นค่าเริ่มต้น", () => {
    expect(sql).toContain("add column if not exists member_code_enabled boolean not null default false");
  });

  it("ตารางรหัสและการเดาไม่เปิดให้ anon/authenticated", () => {
    for (const table of ["member_redeem_codes", "member_redeem_attempts"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
      expect(sql).toContain(`revoke all on table public.${table} from anon;`);
      expect(sql).toContain(`revoke all on table public.${table} from authenticated;`);
    }
    expect(sql).toContain("alter table public.member_verifications enable row level security;");
    expect(sql).toContain("alter table public.member_identities enable row level security;");
  });

  it("RPC เรียกได้เฉพาะ service_role", () => {
    expect(sql.match(/coalesce\(auth\.role\(\), ''\) <> 'service_role'/g)?.length).toBe(2);
    expect(sql).toContain("revoke all on function public.issue_member_redeem_code(uuid, uuid, text, integer) from public, anon, authenticated;");
    expect(sql).toContain("revoke all on function public.verify_member_redeem_code(uuid, uuid, text, integer) from public, anon, authenticated;");
  });

  it("รหัสใช้ได้ครั้งเดียว ล็อกแถว และรหัสใหม่ยกเลิกรหัสเก่า", () => {
    expect(sql).toContain("for update;");
    expect(sql).toContain("set used_at = now(), used_store_id = p_store_id, used_by = p_user_id");
    expect(sql).toContain("set revoked_at = now()");
    expect(sql).toContain("redeem_code_id uuid not null unique");
  });

  it("ล็อกการเดาสุ่ม 5 ครั้ง/พนักงาน หรือ 15 ครั้ง/สาขา ใน 10 นาที", () => {
    expect(sql).toContain("if v_user_fail >= 5 or v_store_fail >= 15 then");
    expect(sql).toContain("created_at > now() - interval '10 minutes'");
  });

  it("ไม่เก็บรหัสจริง เก็บเฉพาะ sha256", () => {
    expect(sql).toContain("code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$')");
    expect(sql).not.toMatch(/\bcode text\b/);
  });

  it("trigger ผูก identity ทุกครั้งที่สร้างลูกค้า/เปลี่ยนเบอร์ และ migration รันซ้ำได้", () => {
    expect(sql).toContain("drop trigger if exists customers_link_member_identity on public.customers;");
    expect(sql).toContain("before insert or update of phone, organization_id on public.customers");
    expect(sql).toContain('drop policy if exists "member_identities: org member can read"');
  });

  it("เบอร์ (phone_key) ไม่เปิดให้พนักงานอ่านตรง และลูกค้าต้นทางต้องอยู่องค์กรเดียวกัน", () => {
    expect(sql).toContain("revoke all on table public.member_identities from authenticated;");
    expect(sql).not.toContain("grant select on table public.member_identities to authenticated");
    expect(sql).toContain("if not found or v_source.organization_id <> v_store.organization_id then");
  });
});

describe("ทางเข้าโค้ด", () => {
  it("POS ยืนยันรหัสต้องมีสิทธิ์ pos.use + Enterprise และบันทึก log ทุกเส้นทาง", () => {
    const src = read("src/app/pos/actions.ts");
    const start = src.indexOf("export async function verifyPosMemberCodeAction");
    const body = src.slice(start, src.indexOf("export interface RewardProductLine"));
    expect(body).toContain('await requirePermission("pos.use")');
    expect(body).toContain("canUseMemberPrivileges(billing)");
    expect(body).toContain("normalizeMemberRedeemCodeInput(rawCode)");
    expect(body).toContain('message: crossBranch ? "ยืนยันสมาชิกด้วยรหัส (ข้ามสาขา)" : "ยืนยันสมาชิกด้วยรหัส"');
    expect(body.match(/logSystemEvent\(/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("หน้าสมาชิกออกรหัสได้เฉพาะคนที่ล็อกอินและสาขาเปิดสวิตช์", () => {
    const src = read("src/app/member/[storeSlug]/actions.ts");
    const body = src.slice(src.indexOf("export async function issueMemberRedeemCodeAction"));
    expect(body).toContain("if (!portalData.customer)");
    expect(body).toContain("if (!portalData.memberCodeEnabled)");
    expect(body).toContain('message: "ออกรหัสสมาชิก 5 นาที"');
  });

  it("ช่องกรอกรหัสบน POS ใช้ font 16px แบบ inline กัน iOS ซูม", () => {
    const src = read("src/app/pos/PosTerminal.tsx");
    const box = src.slice(src.indexOf("function MemberCodeVerifyBox"), src.indexOf("function MemberSheetSection"));
    expect(box).toContain("style={{ fontSize: 16 }}");
    // ไม่ให้ Safari บน iPad เด้ง OTP จาก SMS ของเครื่องร้าน — รหัสมาจากมือถือลูกค้า
    expect(box).toContain('autoComplete="off"');
  });
});
