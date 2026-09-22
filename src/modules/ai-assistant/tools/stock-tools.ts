// P5 — tool สต็อก
//
// จุดที่ต่างจาก tool อื่น: จำนวนคงเหลือที่ "ขายได้จริง" ไม่ใช่ตัวเลขในคอลัมน์เดียว
// ร้านที่ใช้ stock pool จะมีของกลางที่หลายตัวเลือกแบ่งกันใช้ — อ่าน stockQuantity
// ตรง ๆ แล้วเอามาโชว์จะได้เลขที่ไม่ตรงกับความจริงที่หน้าร้านเห็น
//
// ตัวเลขผิดในการ์ดยืนยันแย่กว่าไม่มีการ์ดเลย เพราะคนจะกดยืนยันโดยเชื่อเลขนั้น
// deps จึงต้องคืน "จำนวนที่ขายได้จริง" มาให้ ไม่ใช่ให้ tool ไปคำนวณเอง

import { z } from "zod";
import type { ToolRegistry } from "../foundation";
import type { Prerequisite, ProposalDraft } from "../proposal";
import { BACK_OFFICE_ASSISTANT_PERMISSION } from "./back-office-access";

export interface StockVariantRef {
  readonly variantId: string;
  readonly productId: string;
  readonly productName: string;
  readonly variantName: string;
  /** จำนวนที่ขายได้จริง (คิด stock pool แล้ว) — undefined = ตัวเลือกนี้ไม่ได้นับสต็อก */
  readonly available: number | undefined;
  readonly trackStock: boolean;
}

export interface StockToolDeps {
  /** ตัวเลือกทั้งหมดของเมนูที่ตรงกับคำค้น — กำกวมแล้วให้คนเลือก ไม่เดาให้ */
  findVariants: (storeId: string, query: string) => Promise<readonly StockVariantRef[]>;
  getVariant: (storeId: string, variantId: string) => Promise<StockVariantRef | null>;
  setVariantStock: (variantId: string, storeId: string, quantity: number) => Promise<void>;
}

const AdjustArgs = z.object({
  product: z.string().min(1).max(120),
  quantity: z.number().int().min(0).max(1_000_000),
}).strict();

const CheckArgs = z.object({ product: z.string().min(1).max(120) }).strict();

const countLabel = (value: number | undefined) => (value === undefined ? "ไม่ได้นับสต็อก" : `${value}`);

/** เลือกตัวเลือกให้ชัดก่อนเสมอ — "ปรับสต็อกลาเต้" ในร้านที่มีร้อน/เย็นคือคำสั่งที่ยังไม่ครบ */
async function resolveVariant(
  deps: StockToolDeps,
  storeId: string,
  query: string,
  answers: Readonly<Record<string, string>>,
): Promise<{ variant: StockVariantRef | null; prerequisite: Prerequisite | null }> {
  const picked = answers.variant;
  if (picked) {
    const variant = await deps.getVariant(storeId, picked);
    if (variant) return { variant, prerequisite: null };
  }
  const matches = await deps.findVariants(storeId, query);
  if (matches.length === 1) return { variant: matches[0], prerequisite: null };
  if (matches.length === 0) {
    return {
      variant: null,
      prerequisite: {
        kind: "create",
        need: "สินค้า",
        createTool: "catalog.create_product",
        reason: `ไม่พบสินค้าที่ตรงกับ “${query}” ในร้านนี้`,
      },
    };
  }
  return {
    variant: null,
    prerequisite: {
      kind: "choose",
      need: "ตัวเลือกสินค้า",
      subjects: [{ id: "variant", label: query }],
      options: matches.map((match) => ({
        id: match.variantId,
        label: `${match.productName} · ${match.variantName} (คงเหลือ ${countLabel(match.available)})`,
      })),
    },
  };
}

export function registerStockTools(registry: ToolRegistry, deps: StockToolDeps): void {
  registry.register({
    name: "stock.check",
    risk: "read",
    permissions: [BACK_OFFICE_ASSISTANT_PERMISSION],
    args: CheckArgs,
    result: z.object({
      variants: z.array(z.object({
        variantId: z.string(), productName: z.string(), variantName: z.string(),
        available: z.number().nullable(), trackStock: z.boolean(),
      })),
    }).strict(),
    execute: async (rawArgs, context) => {
      const args = rawArgs as z.infer<typeof CheckArgs>;
      const matches = await deps.findVariants(context.storeId, args.product);
      return {
        variants: matches.map((match) => ({
          variantId: match.variantId,
          productName: match.productName,
          variantName: match.variantName,
          available: match.available ?? null,
          trackStock: match.trackStock,
        })),
      };
    },
  });

  registry.register({
    name: "stock.adjust",
    risk: "sensitive",
    permissions: [BACK_OFFICE_ASSISTANT_PERMISSION],
    args: AdjustArgs,
    result: z.object({ variantId: z.string(), quantity: z.number() }).strict(),

    plan: async (rawArgs, context, answers): Promise<ProposalDraft> => {
      const args = rawArgs as z.infer<typeof AdjustArgs>;
      const { variant, prerequisite } = await resolveVariant(deps, context.storeId, args.product, answers);
      if (!variant) {
        return {
          summary: `ปรับสต็อก “${args.product}” เป็น ${args.quantity}`,
          changes: [], affectedCount: 0, warnings: [],
          prerequisites: prerequisite ? [prerequisite] : [],
        };
      }
      const warnings: string[] = [];
      if (!variant.trackStock) {
        // เปิดนับสต็อกเป็นการเปลี่ยนพฤติกรรมการขายของเมนูนั้น ไม่ใช่แค่ตั้งตัวเลข
        warnings.push("ตัวเลือกนี้ยังไม่ได้เปิดนับสต็อก — ตั้งจำนวนแล้วระบบจะเริ่มตัดสต็อกทุกครั้งที่ขาย");
      }
      if (args.quantity === 0) warnings.push("ตั้งเป็น 0 = ขายต่อไม่ได้จนกว่าจะเติม");
      return {
        summary: `${variant.productName} · ${variant.variantName}: คงเหลือ ${countLabel(variant.available)} → ${args.quantity}`,
        // จำนวนเดิมต้องอยู่ใน before — เป็นตัวจับว่ามีการขาย/เติมเกิดขึ้นระหว่างที่การ์ดค้างอยู่
        changes: [{ label: "คงเหลือ", before: countLabel(variant.available), after: `${args.quantity}` }],
        affectedCount: 1,
        warnings,
        prerequisites: [],
      };
    },

    execute: async (rawArgs, context, _cartBinding, answers) => {
      const args = rawArgs as z.infer<typeof AdjustArgs>;
      const { variant } = await resolveVariant(deps, context.storeId, args.product, answers);
      if (!variant) throw new Error("Stock variant unresolved");
      await deps.setVariantStock(variant.variantId, context.storeId, args.quantity);
      return { variantId: variant.variantId, quantity: args.quantity };
    },
  });
}

export const STOCK_TOOL_NAMES = ["stock.check", "stock.adjust"] as const;
