import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("สั่งออนไลน์จากหน้าสมาชิก", () => {
  it("หน้าอยู่ใต้ /member/<slug>/order (cookie สมาชิก path นี้) + ยังไม่ล็อกอินกลับหน้าสมาชิก", () => {
    const page = read("src/app/member/[storeSlug]/order/page.tsx");
    expect(page).toContain("const member = await getMemberSessionByStoreId(site.storeId);");
    expect(page).toContain("if (!member) redirect(memberHref);");
    expect(page).toContain("member={{ name: member.name, phone: member.phone ?? \"\"");
  });

  it("เก็บปลายทาง: ข้าม OTP เฉพาะเมื่อ server ยืนยันว่าเบอร์ตรงกับสมาชิกที่ล็อกอิน (cookie)", () => {
    const actions = read("src/app/s/[slug]/order/actions.ts");
    expect(actions).toContain("const member = await getMemberSessionByStoreId(store.storeId).catch(() => null);");
    expect(actions).toContain("normalizeThaiPhone(member.phone) === input.customerPhone");
    expect(actions).toContain("if (!memberVerified) {");
  });

  it("หน้าสั่ง: กรอกชื่อ/เบอร์ให้ + ซ่อน OTP เมื่อใช้เบอร์สมาชิก + ปุ่มกลับหน้าสมาชิก", () => {
    const app = read("src/app/s/[slug]/order/OrderApp.tsx");
    expect(app).toContain('useState(props.member?.name ?? "")');
    expect(app).toContain("const needOtp = useCod && Boolean(props.cod?.requireOtp) && !memberPhoneVerified;");
    expect(app).toContain("props.member?.backHref");
  });

  it("หน้าสมาชิกมีปุ่ม สั่งออนไลน์ เมื่อร้านเปิดสั่งออนไลน์และล็อกอินแล้ว", () => {
    expect(read("src/app/member/[storeSlug]/page.tsx")).toContain('if (ordering?.ok) onlineOrderHref = `/member/${encodeURIComponent(storeSlug)}/order${portalCode ? `?code=${encodeURIComponent(portalCode)}` : ""}`;');
    expect(read("src/app/member/[storeSlug]/MemberPortal.tsx")).toContain('{ key: "order", icon: "🛵", label: "สั่งออนไลน์"');
  });
  it("ข้าม OTP ได้เฉพาะในเงื่อนไข memberVerified — verifyCodOtp ยังถูกเรียกเมื่อไม่มีสมาชิก/เบอร์ไม่ตรง", () => {
    const actions = read("src/app/s/[slug]/order/actions.ts");
    const verified = actions.indexOf("const memberVerified = Boolean(member?.phone && normalizeThaiPhone(member.phone) === input.customerPhone);");
    const guard = actions.indexOf("if (!memberVerified) {", verified);
    const otp = actions.indexOf("await verifyCodOtp(", guard);
    expect(verified).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(verified);
    expect(otp).toBeGreaterThan(guard);
    // ไม่มีเส้นทางอื่นที่ข้าม verifyCodOtp
    expect(actions.match(/await verifyCodOtp\(/g)?.length).toBe(1);
  });

  it("cookie สมาชิกผูก path /member/<slug> — server action จาก /s/<slug>/order ไม่ได้ cookie จึงยังต้อง OTP", () => {
    const repo = read("src/modules/customers/member-repository.ts");
    expect(repo).toMatch(/path: `\/member\/\$\{/);
    expect(repo).toContain("httpOnly: true");
  });

  it("หน้าสั่งเทียบเบอร์สมาชิกด้วย normalizeThaiPhone แบบเดียวกับ server (+66 / 0)", () => {
    const app = read("src/app/s/[slug]/order/OrderApp.tsx");
    expect(app).toContain('normalizeThaiPhone(phone) === normalizeThaiPhone(props.member?.phone ?? "")');
  });
});
