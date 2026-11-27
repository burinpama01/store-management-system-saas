import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("สั่งออนไลน์จากหน้าสมาชิก", () => {
  it("หน้าอยู่ใต้ /member/<slug>/order (cookie สมาชิก path นี้) + ยังไม่ล็อกอินกลับหน้าสมาชิก", () => {
    const page = read("src/app/member/[storeSlug]/order/page.tsx");
    expect(page).toContain("const member = await getMemberSessionByStoreId(site.storeId);");
    expect(page).toContain("if (!member) redirect(`/member/${encodeURIComponent(storeSlug)}`);");
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
    expect(read("src/app/member/[storeSlug]/page.tsx")).toContain("if (ordering?.ok) onlineOrderHref = `/member/${encodeURIComponent(storeSlug)}/order`;");
    expect(read("src/app/member/[storeSlug]/MemberPortal.tsx")).toContain('{ key: "order", icon: "🛵", label: "สั่งออนไลน์"');
  });
});
