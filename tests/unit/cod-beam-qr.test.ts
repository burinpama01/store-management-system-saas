import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codBeamReferencePrefix } from "@/modules/online-orders/cod-beam";

const read = (p: string) => readFileSync(p, "utf8");

describe("R3b เก็บปลายทางด้วย Beam QR", () => {
  const mod = read("src/modules/online-orders/cod-beam.ts");

  it("ไม่ผูก online_order_id (กัน trigger เลื่อนออเดอร์เป็น paid/LATE_PAID)", () => {
    const create = mod.slice(mod.indexOf("createBeamQrPayment({"), mod.indexOf("});", mod.indexOf("createBeamQrPayment({")));
    expect(create).not.toContain("onlineOrderId");
    expect(create).toContain("clientRequestId: `cod-${order.id}-${round}`");
  });

  it("อ้างอิงรายการชำระต่อออเดอร์ + ตรวจว่า QR เป็นของออเดอร์นี้ก่อนปิดบิล", () => {
    expect(codBeamReferencePrefix("abc")).toBe("beam:cod-abc-");
    expect(mod).toContain("startsWith(codBeamReferencePrefix(order.id))");
  });

  it("จ่ายแล้ว: ผูกบิล → ปิดบิล (method other, BEAM:) → ยืนยัน → สำเร็จ codMethod beam · ปิดล้มคืนการผูก", () => {
    const at = (s: string) => mod.indexOf(s);
    expect(at("claimBeamPaymentForOrder({")).toBeLessThan(at("addPaymentAndClose(billId"));
    expect(at("addPaymentAndClose(billId")).toBeLessThan(at("finalizeBeamPaymentForOrder({"));
    expect(at("finalizeBeamPaymentForOrder({")).toBeLessThan(at('performOnlineOrderTransition(g, order.id, "completed", { codMethod: "beam"'));
    expect(mod).toContain("releaseBeamPaymentClaim({");
    expect(mod).toContain("reference: `BEAM:${gatewayPaymentId}`");
  });

  it("คนส่งตำแหน่ง staff ใช้ได้: claim/release/finalize รับ service client (RLS update เฉพาะ cashier+)", () => {
    const beam = read("src/modules/payments/beam-service.ts");
    expect(beam.match(/const supabase = input\.client \?\? \(await createSupabaseServerClient\(\)\);/g)!.length).toBeGreaterThanOrEqual(5);
    expect(mod.match(/client: service/g)!.length).toBeGreaterThanOrEqual(5);
  });

  it("transition-service: codMethod beam ต้องเห็นบิลปิดแล้ว (ไม่ปิดซ้ำ)", () => {
    const svc = read("src/modules/online-orders/transition-service.ts");
    expect(svc).toContain('if (bill?.status !== "paid") return { ok: false, error: "ยังไม่ได้รับเงินผ่าน Beam');
  });

  it("หน้าคนส่ง: QR เฉพาะงานของฉัน · หน้าร้าน: ต้อง pos.use", () => {
    const rider = read("src/app/rider/actions.ts");
    const start = rider.slice(rider.indexOf("export async function startRiderCodQrAction"));
    expect(start).toContain('if (order.riderUserId !== g.user.id) return { qr: null, error: "งานนี้ไม่ใช่ของคุณ" };');
    const queue = read("src/app/(dashboard)/website/orders/actions.ts");
    const q = queue.slice(queue.indexOf("export async function startCodQrAction"));
    expect(q).toContain('if (!g.resolved.can("pos.use"))');
  });

  it("UI: ตัวเลือก Beam QR + หน้าจอ QR ใช้ทั้ง 3 ที่", () => {
    expect(read("src/app/(dashboard)/website/orders/CodControls.tsx")).toContain('onPick("beam")');
    for (const f of ["src/app/rider/RiderApp.tsx", "src/app/pos/OnlineOrderTickets.tsx", "src/app/(dashboard)/website/orders/OnlineOrdersBoard.tsx"]) {
      expect(read(f)).toContain("<CodBeamQrPanel");
    }
  });
});
