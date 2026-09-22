// P4 — tool เปิด-ปิด QR Order: ที่ที่หลักการ "ไม่มีให้เพิ่ม ไม่ใช่ข้าม" โดนทดสอบหนักสุด
//
// "เปิด QR ให้ทุกเมนู" ดูเหมือนคำสั่งเดียว แต่ในร้านจริงมันชนเงื่อนไขทันที: เมนูจะเปิด
// บน QR ได้ต้องผูกสถานีครัวก่อน (catalog/actions.ts) และร้านอาจยังไม่มีสถานีสักอัน
//
// ทางที่ง่ายคือข้ามเมนูที่ไม่ผ่านแล้วรายงานทีหลัง — ซึ่งผิด เพราะคนสั่งจะเหลือเมนูเปิด
// ครึ่ง ๆ โดยไม่รู้ว่าทำไม และต้องไปไล่หาเองว่าขาดอะไร กลายเป็นว่าใช้ผู้ช่วยแล้วงานเพิ่ม
//
// ที่ทำแทน: รวบทุกเมนูที่ยังขาดสถานีมาเสนอในจอเดียว ให้เลือกทีเดียวจบ (มีปุ่มใช้ค่า
// เดียวกันทั้งหมดในการ์ด) และถ้าร้านยังไม่มีสถานีเลย ก็เสนอสร้างก่อน

import { z } from "zod";
import type { Product } from "@/modules/catalog/types";
import type { ToolRegistry } from "../foundation";
import type { Prerequisite, ProposalDraft } from "../proposal";
import { BACK_OFFICE_ASSISTANT_PERMISSION } from "./back-office-access";

export interface QrStationRef {
  readonly id: string;
  readonly name: string;
}

export interface QrToolDeps {
  /** เมนูทั้งร้าน (รวมที่ปิดอยู่) — ต้องรู้ทั้งหมดเพื่อบอกจำนวนที่กระทบได้ตรง */
  listProducts: (storeId: string) => Promise<readonly Product[]>;
  listStations: (storeId: string) => Promise<readonly QrStationRef[]>;
  setProductQrVisibility: (productId: string, storeId: string, visible: boolean) => Promise<void>;
  assignProductStation: (productId: string, storeId: string, stationId: string) => Promise<void>;
  /** สวิตช์ QR ระดับร้าน — เปิดเมนูอย่างเดียวไม่พอถ้าสวิตช์ร้านปิดอยู่ */
  getStoreQrEnabled: (storeId: string) => Promise<boolean>;
  setStoreQrEnabled: (storeId: string, enabled: boolean) => Promise<void>;
}

const BulkArgs = z.object({
  /** all = ทุกเมนูในร้าน · category = เฉพาะหมวดที่ระบุ */
  scope: z.enum(["all", "category"]),
  categoryId: z.string().max(64).optional(),
  visible: z.boolean(),
}).strict();

/** เมนูที่ถูกซ่อน/ไม่ได้ขายหน้าร้านอยู่แล้ว ไม่ควรถูกลากมาเปิดบน QR โดยไม่ได้ตั้งใจ */
function inScope(product: Product, args: z.infer<typeof BulkArgs>): boolean {
  if (!product.isActive) return false;
  if (args.scope === "category") return product.categoryId === args.categoryId;
  return true;
}

export function registerQrTools(registry: ToolRegistry, deps: QrToolDeps): void {
  registry.register({
    name: "qr.bulk_set_visibility",
    risk: "sensitive",
    permissions: [BACK_OFFICE_ASSISTANT_PERMISSION],
    args: BulkArgs,
    result: z.object({
      changed: z.number(),
      stationsAssigned: z.number(),
      storeSwitchTurnedOn: z.boolean(),
    }).strict(),

    // plan ไม่ใช้ answers: การตอบสถานีไม่เปลี่ยน "จำนวนเมนูที่จะถูกเปิด" ซึ่งเป็นสิ่งที่
    // การ์ดบอก — สถานีถูกนำไปใช้ตอน execute ผลคือตอบแล้วยืนยันได้เลย ไม่ต้องออกการ์ดใหม่
    plan: async (rawArgs, context): Promise<ProposalDraft> => {
      const args = rawArgs as z.infer<typeof BulkArgs>;
      const [products, stations, storeEnabled] = await Promise.all([
        deps.listProducts(context.storeId),
        deps.listStations(context.storeId),
        deps.getStoreQrEnabled(context.storeId),
      ]);
      const targets = products.filter((product) => inScope(product, args) && product.availableForQr !== args.visible);

      const changes = [{
        label: args.visible ? "เปิดขายบน QR" : "ปิดขายบน QR",
        before: `${products.filter((product) => product.availableForQr).length} เมนู`,
        after: `${targets.length} เมนูจะถูก${args.visible ? "เปิด" : "ปิด"}`,
      }];
      const prerequisites: Prerequisite[] = [];
      const warnings: string[] = [];

      if (args.visible) {
        // ปิดไม่ต้องมีสถานี — เงื่อนไขนี้เป็นของการ "เปิด" เท่านั้น
        const missingStation = targets.filter((product) => !product.kitchenStationId);
        if (missingStation.length > 0) {
          if (stations.length === 0) {
            prerequisites.push({
              kind: "create",
              need: "สถานีครัว",
              createTool: "kitchen.create_station",
              reason: `เมนูจะเปิดบน QR ได้ต้องผูกสถานีครัว แต่ร้านยังไม่มีสถานีสักอัน (${missingStation.length} เมนูรออยู่)`,
            });
          } else {
            // ทุกเมนูที่ขาดขึ้นพร้อมกันในรายการเดียว — ไม่ทยอยถามทีละตัว
            prerequisites.push({
              kind: "choose",
              need: "สถานีครัว",
              subjects: missingStation.map((product) => ({ id: product.id, label: product.name })),
              options: stations.map((station) => ({ id: station.id, label: station.name })),
            });
          }
        }
        if (!storeEnabled) {
          changes.push({ label: "สวิตช์ QR ของร้าน", before: "ปิดอยู่", after: "เปิด" });
        }
      }

      if (targets.length === 0) {
        warnings.push(`ไม่มีเมนูที่ต้องเปลี่ยน — ทุกเมนูในขอบเขตนี้${args.visible ? "เปิด" : "ปิด"}อยู่แล้ว`);
      }

      return {
        summary: args.visible
          ? `เปิดขายบน QR ${targets.length} เมนู`
          : `ปิดขายบน QR ${targets.length} เมนู`,
        changes,
        affectedCount: targets.length,
        warnings,
        prerequisites,
      };
    },

    execute: async (rawArgs, context, _cartBinding, answers) => {
      const args = rawArgs as z.infer<typeof BulkArgs>;
      const [products, storeEnabled] = await Promise.all([
        deps.listProducts(context.storeId),
        deps.getStoreQrEnabled(context.storeId),
      ]);
      const targets = products.filter((product) => inScope(product, args) && product.availableForQr !== args.visible);

      let stationsAssigned = 0;
      if (args.visible) {
        for (const product of targets) {
          if (product.kitchenStationId) continue;
          const stationId = answers[product.id];
          // ถึงตรงนี้แล้วยังไม่มีสถานี = prerequisite ถูกข้ามมาได้ ซึ่งไม่ควรเกิด
          // ปฏิเสธทั้งชุดดีกว่าเปิดครึ่ง ๆ แล้วปล่อยร้านไว้ในสถานะที่ไม่มีใครสั่ง
          if (!stationId) throw new Error("Kitchen station unresolved for bulk QR");
          await deps.assignProductStation(product.id, context.storeId, stationId);
          stationsAssigned += 1;
        }
      }
      for (const product of targets) {
        await deps.setProductQrVisibility(product.id, context.storeId, args.visible);
      }
      const shouldTurnOnStore = args.visible && !storeEnabled && targets.length > 0;
      if (shouldTurnOnStore) await deps.setStoreQrEnabled(context.storeId, true);

      return { changed: targets.length, stationsAssigned, storeSwitchTurnedOn: shouldTurnOnStore };
    },
  });
}

export const QR_TOOL_NAMES = ["qr.bulk_set_visibility"] as const;
