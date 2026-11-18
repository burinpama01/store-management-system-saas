import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const portal = readFileSync("src/app/member/[storeSlug]/MemberPortal.tsx", "utf8");
const missions = readFileSync("src/app/member/[storeSlug]/MemberMissionsCard.tsx", "utf8");

describe("หน้าสมาชิก v2 (แถบล่าง 5 ช่อง สไตล์ StoreOS)", () => {
  it("แถบล่าง: หน้าแรก / ภารกิจ / รหัสสมาชิก (ปุ่มกลาง) / คูปอง / สมาชิก — แสดงเฉพาะเมื่อล็อกอิน", () => {
    for (const key of ['key: "home"', 'key: "missions"', 'key: "code"', 'key: "coupons"', 'key: "member"']) expect(portal).toContain(key);
    expect(portal).toContain('aria-label="เมนูหลักสมาชิก"');
    expect(portal).toMatch(/\{customer && \(\s*<nav/);
  });
  it("ฟีเจอร์เดิมยังอยู่ครบในแท็บใหม่: รับแต้มจากใบเสร็จ, รหัส 5 นาที, แพ็ก, ระดับ, แลกแต้ม, ออกจากระบบ, รายละเอียดคูปอง", () => {
    expect(portal).toContain("claimReceiptPoints");
    expect(portal).toContain("<MemberRedeemCodeCard storeSlug={storeSlug} portalCode={portalCode} />");
    expect(portal).toContain("<MemberPassesCard");
    expect(portal).toContain("<MemberTierCard view={tierView} coupons={tierCoupons} />");
    expect(portal).toContain("action={redeemReward}");
    expect(portal).toContain("action={signOut}");
    expect(portal).toContain("setDetail(redemption)");
  });
  it("สีตามธีมร้าน (ไม่ hard-code) + ไม่ลอกชื่อเฉพาะของแอปต้นแบบ", () => {
    expect(portal).toContain('"--tenant-primary": primary');
    expect(portal).toContain('"--color-brand": primary');
    expect(portal).not.toMatch(/blue code|blueplus/i);
    expect(readFileSync("src/app/member/[storeSlug]/MemberTierCard.tsx", "utf8")).not.toContain("red-600");
  });
  it("หน้าแรกใช้การ์ดภารกิจโหมดย่อ ไปแท็บภารกิจเมื่อแตะ", () => {
    expect(portal).toContain('mode="home" onSeeAll={() => go("missions")}');
    expect(missions).toContain('if (mode === "home") {');
  });
});

describe("หลังรีวิว", () => {
  it("การ์ดแพ็ก mount ค้างทุกแท็บ (QR ชำระแพ็กไม่หายเมื่อสลับแท็บ)", () => {
    expect(portal).toContain('<div id="member-passes" className={view === "member" ? "" : "hidden"}>');
  });
  it("แยกคูปองพร้อมใช้จากสถานะจริง ไม่ใช่ข้อความป้าย และไม่เรียก Date.now ระหว่าง render", () => {
    expect(portal).toContain("function isRedemptionReady(");
    expect(portal).not.toContain('redemptionStatusBadge(r).label === "ใช้ได้"');
    expect(portal).toContain("const [renderNow] = useState(() => Date.now());");
  });
  it("ช่องกรอกหน้าเข้าสู่ระบบ 16px กัน iOS ซูม · ไอคอน emoji ไม่ถูกอ่านซ้ำ", () => {
    expect(portal.split("style={{ fontSize: 16 }}").length - 1).toBeGreaterThanOrEqual(4);
    expect(portal.split('aria-hidden="true"').length - 1).toBeGreaterThanOrEqual(3);
  });
});
