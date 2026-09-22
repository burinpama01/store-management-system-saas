// P3 — tool เมนู/สินค้า: ชุดแรกที่ค่า before มีความหมายจริง
//
// ต่างจากบัญชี (สร้างของใหม่ ไม่มีสถานะเดิม) ตรงที่การแก้เมนูคือการ **ทับของเดิม**
// ค่าเดิมจึงต้องขึ้นการ์ดทุกตัว ไม่ใช่เพื่อความสวยงาม แต่เพราะลายนิ้วมือของ proposal
// นับ `changes[].before` เป็นตัวจับว่า "โลกเปลี่ยนไประหว่างที่ผู้ใช้ดูการ์ดอยู่"
// — ถ้าไม่ใส่ ราคาที่คนอื่นเพิ่งแก้จะถูกทับเงียบ ๆ โดยไม่มีใครรู้
//
// เมนูผูกกับ POS/QR/เดลิเวอรีและตะกร้าที่เปิดค้างอยู่ จึงเป็นงานที่ "แก้ผิดแล้วเห็นผล
// ทันทีที่หน้าร้าน" ทุก tool ที่เขียนในไฟล์นี้จึงมี plan() ทั้งหมด ไม่มีตัวไหนทำทันที

import { z } from "zod";
import type { Product } from "@/modules/catalog/types";
import type { ToolRegistry } from "../foundation";
import type { Prerequisite, ProposalDraft } from "../proposal";
import { BACK_OFFICE_ASSISTANT_PERMISSION } from "./back-office-access";

export interface CatalogCategoryRef {
  readonly id: string;
  readonly name: string;
}

export interface CatalogToolDeps {
  /** หาเมนูจากคำที่คนพูด (ใช้ resolver ชุดเดียวกับหน้าขาย รวม alias ที่ร้านสอนไว้) */
  resolveProduct: (storeId: string, query: string) => Promise<
    | { readonly status: "found"; readonly product: Product }
    | { readonly status: "ambiguous"; readonly candidates: readonly { readonly id: string; readonly name: string }[] }
    | { readonly status: "not_found" }
  >;
  getProduct: (productId: string, storeId: string) => Promise<Product | null>;
  listCategories: (storeId: string) => Promise<readonly CatalogCategoryRef[]>;
  updateProduct: (
    productId: string,
    storeId: string,
    patch: { name?: string; basePrice?: number; isActive?: boolean; outOfStock?: boolean },
  ) => Promise<void>;
  createProduct: (input: {
    storeId: string;
    organizationId: string;
    categoryId: string;
    name: string;
    basePrice: number;
  }) => Promise<{ id: string }>;
}

const thb = (value: number) => `${value.toLocaleString("th-TH")} บาท`;

const ProductRefArgs = z.object({ product: z.string().min(1).max(120) }).strict();

const UpdatePriceArgs = z.object({
  product: z.string().min(1).max(120),
  price: z.number().positive().max(1_000_000),
}).strict();

const CreateProductArgs = z.object({
  name: z.string().min(1).max(120),
  price: z.number().nonnegative().max(1_000_000).optional(),
}).strict();

const AvailabilityArgs = z.object({
  product: z.string().min(1).max(120),
  /** ของหมดวันนี้ (ยังอยู่ในเมนู) vs ปิดขายถาวร — คนละเรื่องกัน ห้ามรวบ */
  state: z.enum(["out_of_stock", "back_in_stock", "hide", "show"]),
}).strict();

/**
 * เมนูที่หาไม่เจอ/กำกวม = prerequisite ไม่ใช่ error
 *
 * "ลาเต้" ที่ตรงสามเมนูเป็นเรื่องปกติของร้านกาแฟ การตอบว่า error แล้วให้พิมพ์ใหม่
 * คือการโยนงานกลับให้ผู้ใช้ ทั้งที่เรารู้อยู่แล้วว่าตัวเลือกมีอะไรบ้าง
 */
function productPrerequisite(
  resolution: Awaited<ReturnType<CatalogToolDeps["resolveProduct"]>>,
  query: string,
): Prerequisite | null {
  if (resolution.status === "found") return null;
  if (resolution.status === "ambiguous") {
    return {
      kind: "choose",
      need: "เมนู",
      subjects: [{ id: "product", label: query }],
      options: resolution.candidates.map((candidate) => ({ id: candidate.id, label: candidate.name })),
    };
  }
  return {
    kind: "create",
    need: "เมนู",
    createTool: "catalog.create_product",
    reason: `ไม่พบเมนูที่ตรงกับ “${query}” ในร้านนี้`,
  };
}

/** หาเมนูโดยให้คำตอบของผู้ใช้ชนะการเดาเสมอ */
async function resolveWithAnswer(
  deps: CatalogToolDeps,
  storeId: string,
  query: string,
  answers: Readonly<Record<string, string>>,
): Promise<{ product: Product | null; prerequisite: Prerequisite | null }> {
  const picked = answers.product;
  if (picked) {
    const product = await deps.getProduct(picked, storeId);
    if (product) return { product, prerequisite: null };
  }
  const resolution = await deps.resolveProduct(storeId, query);
  return {
    product: resolution.status === "found" ? resolution.product : null,
    prerequisite: productPrerequisite(resolution, query),
  };
}

export function registerCatalogTools(registry: ToolRegistry, deps: CatalogToolDeps): void {
  registry.register({
    name: "catalog.get_product",
    risk: "read",
    permissions: [BACK_OFFICE_ASSISTANT_PERMISSION],
    args: ProductRefArgs,
    result: z.object({
      product: z.object({
        id: z.string(), name: z.string(), basePrice: z.number(),
        isActive: z.boolean(), outOfStock: z.boolean(),
        availableForPos: z.boolean(), availableForQr: z.boolean(),
      }).nullable(),
      candidates: z.array(z.object({ id: z.string(), name: z.string() })),
    }).strict(),
    execute: async (rawArgs, context) => {
      const args = rawArgs as z.infer<typeof ProductRefArgs>;
      const resolution = await deps.resolveProduct(context.storeId, args.product);
      if (resolution.status === "found") {
        const product = resolution.product;
        return {
          product: {
            id: product.id, name: product.name, basePrice: product.basePrice,
            isActive: product.isActive, outOfStock: product.outOfStock ?? false,
            availableForPos: product.availableForPos, availableForQr: product.availableForQr,
          },
          candidates: [],
        };
      }
      return {
        product: null,
        candidates: resolution.status === "ambiguous"
          ? resolution.candidates.map((candidate) => ({ id: candidate.id, name: candidate.name }))
          : [],
      };
    },
  });

  registry.register({
    name: "catalog.create_product",
    risk: "sensitive",
    permissions: [BACK_OFFICE_ASSISTANT_PERMISSION],
    args: CreateProductArgs,
    result: z.object({ id: z.string(), name: z.string(), price: z.number() }).strict(),

    /**
     * "เพิ่มเมนู X" ในแผงหลังร้าน = เพิ่มรายการเข้าระบบ ไม่ใช่เพิ่มลงตะกร้า
     * (การเพิ่มลงตะกร้าเป็นงานของหน้า POS — ตัวแปลคำสั่งตีเส้นนี้ไว้ก่อนถึงที่นี่)
     */
    plan: async (rawArgs, context, answers): Promise<ProposalDraft> => {
      const args = rawArgs as z.infer<typeof CreateProductArgs>;
      const [categories, existing] = await Promise.all([
        deps.listCategories(context.storeId),
        deps.resolveProduct(context.storeId, args.name),
      ]);

      const prerequisites: Prerequisite[] = [];
      const chosen = categories.find((category) => category.id === answers.category);
      if (categories.length === 0) {
        prerequisites.push({
          kind: "create",
          need: "หมวดเมนู",
          createTool: "catalog.create_category",
          reason: "ร้านยังไม่มีหมวดเมนูสักหมวด เมนูใหม่ต้องอยู่ในหมวด",
        });
      } else if (!chosen) {
        prerequisites.push({
          kind: "choose",
          need: "หมวดเมนู",
          subjects: [{ id: "category", label: args.name }],
          options: categories.map((category) => ({ id: category.id, label: category.name })),
        });
      }

      const warnings: string[] = [];
      // กันสร้างซ้ำ — ชื่อชนของเดิมเป็นเรื่องที่เกิดง่ายมากเวลาสั่งด้วยเสียง
      if (existing.status === "found") {
        warnings.push(`มีเมนูชื่อ “${existing.product.name}” อยู่แล้ว — สร้างใหม่จะได้สองรายการ`);
      } else if (existing.status === "ambiguous") {
        warnings.push(`มีเมนูชื่อใกล้เคียงอยู่แล้ว ${existing.candidates.length} รายการ`);
      }
      if (args.price === undefined) {
        warnings.push("ยังไม่ได้ตั้งราคา — จะสร้างเป็น 0 บาท แก้ทีหลังได้ที่หน้าเมนู หรือพูดใหม่พร้อมราคา");
      }

      return {
        summary: `เพิ่มเมนูใหม่ “${args.name}”`,
        // เมนูใหม่ไม่มีสถานะเดิม before จึงเป็น null ทุกช่อง (ต่างจากการแก้ของที่มีอยู่)
        changes: [
          { label: "ชื่อเมนู", before: null, after: args.name },
          { label: "หมวด", before: null, after: chosen?.name ?? "— ยังไม่ได้เลือก —" },
          { label: "ราคา", before: null, after: thb(args.price ?? 0) },
          { label: "ช่องทางขาย", before: null, after: "หน้าร้าน (POS) — เปิด QR ทีหลังได้" },
        ],
        affectedCount: 1,
        warnings,
        prerequisites,
      };
    },

    execute: async (rawArgs, context, _cartBinding, answers) => {
      const args = rawArgs as z.infer<typeof CreateProductArgs>;
      const categories = await deps.listCategories(context.storeId);
      const chosen = categories.find((category) => category.id === answers.category);
      // ถึงตรงนี้แล้วยังไม่มีหมวด = prerequisite ถูกข้ามมาได้ ซึ่งไม่ควรเกิด
      if (!chosen) throw new Error("Catalog category unresolved");
      const created = await deps.createProduct({
        storeId: context.storeId,
        organizationId: context.organizationId,
        categoryId: chosen.id,
        name: args.name,
        basePrice: args.price ?? 0,
      });
      return { id: created.id, name: args.name, price: args.price ?? 0 };
    },
  });

  registry.register({
    name: "catalog.update_price",
    risk: "sensitive",
    permissions: [BACK_OFFICE_ASSISTANT_PERMISSION],
    args: UpdatePriceArgs,
    result: z.object({ id: z.string(), name: z.string(), price: z.number() }).strict(),

    plan: async (rawArgs, context, answers): Promise<ProposalDraft> => {
      const args = rawArgs as z.infer<typeof UpdatePriceArgs>;
      const { product, prerequisite } = await resolveWithAnswer(deps, context.storeId, args.product, answers);
      if (!product) {
        return {
          summary: `เปลี่ยนราคา “${args.product}” เป็น ${thb(args.price)}`,
          changes: [],
          affectedCount: 0,
          warnings: [],
          prerequisites: prerequisite ? [prerequisite] : [],
        };
      }
      const warnings: string[] = [];
      // ขึ้น/ลงเกินเท่าตัวมักเป็นการฟังเลขผิด (60 กับ 600) — เตือนแต่ไม่บล็อก
      if (args.price > product.basePrice * 2 || args.price * 2 < product.basePrice) {
        warnings.push(`ราคาต่างจากเดิมมาก (${thb(product.basePrice)} → ${thb(args.price)})`);
      }
      if (product.availableForQr) warnings.push("เมนูนี้เปิดขายบน QR อยู่ ราคาใหม่จะมีผลกับลูกค้าทันที");
      return {
        summary: `เปลี่ยนราคา ${product.name} เป็น ${thb(args.price)}`,
        // ราคาเดิมอยู่ใน before — เป็นตัวจับว่ามีคนอื่นแก้ราคาระหว่างที่การ์ดค้างอยู่
        changes: [{ label: "ราคา", before: thb(product.basePrice), after: thb(args.price) }],
        affectedCount: 1,
        warnings,
        prerequisites: [],
      };
    },

    execute: async (rawArgs, context, _cartBinding, answers) => {
      const args = rawArgs as z.infer<typeof UpdatePriceArgs>;
      const { product } = await resolveWithAnswer(deps, context.storeId, args.product, answers);
      if (!product) throw new Error("Catalog product unresolved");
      await deps.updateProduct(product.id, context.storeId, { basePrice: args.price });
      return { id: product.id, name: product.name, price: args.price };
    },
  });

  registry.register({
    name: "catalog.set_availability",
    risk: "safe_write",
    permissions: [BACK_OFFICE_ASSISTANT_PERMISSION],
    args: AvailabilityArgs,
    result: z.object({ id: z.string(), name: z.string(), state: z.string() }).strict(),

    plan: async (rawArgs, context, answers): Promise<ProposalDraft> => {
      const args = rawArgs as z.infer<typeof AvailabilityArgs>;
      const { product, prerequisite } = await resolveWithAnswer(deps, context.storeId, args.product, answers);
      if (!product) {
        return {
          summary: `ปรับสถานะขาย “${args.product}”`,
          changes: [], affectedCount: 0, warnings: [],
          prerequisites: prerequisite ? [prerequisite] : [],
        };
      }
      const outNow = product.outOfStock ?? false;
      // "ของหมดวันนี้" กับ "ซ่อนออกจากเมนู" คนละเรื่อง — การ์ดต้องบอกให้ชัดว่ากำลังทำอันไหน
      const isStockState = args.state === "out_of_stock" || args.state === "back_in_stock";
      const label = isStockState ? "ของหมดวันนี้" : "แสดงในเมนู";
      const before = isStockState ? (outNow ? "ของหมด" : "มีขาย") : (product.isActive ? "แสดงอยู่" : "ซ่อนอยู่");
      const after = args.state === "out_of_stock" ? "ของหมด"
        : args.state === "back_in_stock" ? "มีขาย"
          : args.state === "hide" ? "ซ่อนอยู่" : "แสดงอยู่";
      return {
        summary: `${product.name}: ${before} → ${after}`,
        changes: [{ label, before, after }],
        affectedCount: 1,
        warnings: before === after ? ["สถานะนี้เป็นค่าปัจจุบันอยู่แล้ว"] : [],
        prerequisites: [],
      };
    },

    execute: async (rawArgs, context, _cartBinding, answers) => {
      const args = rawArgs as z.infer<typeof AvailabilityArgs>;
      const { product } = await resolveWithAnswer(deps, context.storeId, args.product, answers);
      if (!product) throw new Error("Catalog product unresolved");
      const patch = args.state === "out_of_stock" ? { outOfStock: true }
        : args.state === "back_in_stock" ? { outOfStock: false }
          : args.state === "hide" ? { isActive: false } : { isActive: true };
      await deps.updateProduct(product.id, context.storeId, patch);
      return { id: product.id, name: product.name, state: args.state };
    },
  });
}

export const CATALOG_TOOL_NAMES = [
  "catalog.get_product",
  "catalog.create_product",
  "catalog.update_price",
  "catalog.set_availability",
] as const;
