// PR2 — MVP POS tools (6 ตัว) สำหรับช่องทางข้อความ
//
// กฎที่ล็อกไว้ (ADR-009 / plan v2 §5):
//   - จับคู่สินค้าผ่าน resolveAiVoiceCommand ของ Voice POS เท่านั้น — ห้าม query catalog คนละชุด
//     และห้ามเชื่อ product/variant/option id ที่มาจากโมเดล (id ทุกตัวมาจาก resolver ที่อ่านสินค้าจริง)
//   - tool ฝั่ง server ไม่แตะตะกร้าโดยตรง: ตะกร้าเป็น state ในเครื่องของหน้าขาย (voice-cart-bridge)
//     tool ตรวจ/อนุมัติ แล้วคืน "คำสั่งที่ให้ client ผลักเข้าตะกร้าผ่าน applyVoiceCartIntent เดิม"
//   - tool ที่ requiresActiveCart ต้องได้ CartBinding ที่ server ตรวจแล้วจาก dispatcher เท่านั้น
//   - ไม่มี import ของ provider AI ในไฟล์นี้ (ADR-002) — ล้วนเป็น business logic ที่ทดสอบได้โดยไม่มี network

import { z } from "zod";
import type { ToolRegistry, CartBinding, TrustedContext } from "../foundation";
import { resolveAiVoiceCommand } from "@/modules/voice-pos/intent-resolver";
import type { AiVoiceCommand } from "@/modules/voice-pos/ai-intent-schema";
import { resolveVoiceProductPhrase, type VoiceProductAlias } from "@/modules/voice-pos/cart";
import type { VoiceIntent } from "@/modules/voice-pos/types";
import type { Product } from "@/modules/catalog/types";
import { VOICE_MAX_QUANTITY, VOICE_MIN_QUANTITY } from "@/modules/voice-pos/parser";

/** ชื่อ tool ของ MVP — ใช้เป็น allowedTools ของ assistant session */
export const MVP_TOOL_NAMES = [
  "pos.search_product",
  "catalog.search",
  "pos.get_current_order",
  "pos.add_item",
  "pos.add_items",
  "pos.remove_item",
  "pos.change_quantity",
  "pos.open_checkout",
] as const;

export type MvpToolName = (typeof MVP_TOOL_NAMES)[number];

/** catalog ที่ tool ใช้จับคู่ — โหลดจาก repository เดิมที่หน้าขายใช้ (ชุดเดียวกับ Voice POS) */
export interface PosToolCatalog {
  readonly products: readonly Product[];
  readonly aliases: readonly VoiceProductAlias[];
}

export interface PosToolDeps {
  readonly loadCatalog: (storeId: string) => Promise<PosToolCatalog>;
}

// ── รูปทรง args/result ────────────────────────────────────────────────────────
const ActiveCartIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const CartVersionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const PhraseSchema = z.string().min(1).max(120);
const ProductRefSchema = z.object({ id: z.string().min(1), name: z.string().min(1) }).strict();

const SearchResultSchema = z.object({
  status: z.enum(["matched", "ambiguous", "not_found"]),
  product: ProductRefSchema.nullish(),
  price: z.number().nullish(),
  outOfStock: z.boolean().nullish(),
  candidates: z.array(ProductRefSchema).max(5).nullish(),
  note: z.string().max(200).nullish(),
}).strict();

/** intent ตะกร้าที่ resolver เดิมคืน — ต้อง serialize ได้และตรงกับ VoiceIntent จริง */
const CartIntentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pos.add_item"), productPhrase: z.string().min(1), quantity: z.number().int() }).strict(),
  z.object({ type: z.literal("pos.set_quantity"), productPhrase: z.string().min(1), quantity: z.number().int() }).strict(),
  z.object({ type: z.literal("pos.increase_item"), productPhrase: z.string().min(1), delta: z.number().int() }).strict(),
  z.object({ type: z.literal("pos.decrease_item"), productPhrase: z.string().min(1), delta: z.number().int() }).strict(),
  z.object({ type: z.literal("pos.remove_item"), productPhrase: z.string().min(1) }).strict(),
]);

/** จำนวนรายการสูงสุดต่อหนึ่งประโยค — พูดยาวกว่านี้ในร้านจริงแทบไม่มี และกัน args บวม */
export const MAX_BATCH_ITEMS = 10;

const CartCommandResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("apply"), intent: CartIntentSchema, productName: z.string().min(1) }).strict(),
  /**
   * หลายรายการในประโยคเดียว — คืนเป็นชุดเดียว (client ผลักเข้าตะกร้าเรียงตามลำดับที่พูด)
   * กติกา: ต้อง resolve ได้ครบทุกรายการเท่านั้นจึงจะคืน apply_batch
   * ถ้ามีรายการใดกำกวม/ไม่พบ/ต้องเลือกตัวเลือก จะคืน clarification แทนทั้งชุด — ไม่ใส่ตะกร้าบางส่วน
   * (ของครึ่ง ๆ กลาง ๆ ในตะกร้าคือสิ่งที่แก้ยากที่สุดหน้าร้าน)
   */
  z.object({
    status: z.literal("apply_batch"),
    items: z.array(z.object({ intent: CartIntentSchema, productName: z.string().min(1) }).strict()).min(1).max(MAX_BATCH_ITEMS),
  }).strict(),
  /** คำสั่งที่ให้หน้าจอทำต่อเอง (ไม่แตะตะกร้า/ไม่แตะเงิน) — วันนี้มีแค่เปิดหน้าจอรับชำระเดิม */
  z.object({
    status: z.literal("client_action"),
    action: z.literal("open_checkout"),
    announcement: z.string().min(1).max(200),
  }).strict(),
  z.object({
    status: z.literal("clarification"),
    reason: z.enum(["ambiguous", "needs_option", "needs_quantity", "not_found", "unavailable", "unsupported"]),
    productId: z.string().min(1).nullish(),
    productName: z.string().min(1).nullish(),
    note: z.string().max(200).nullish(),
    candidates: z.array(ProductRefSchema).max(5).nullish(),
  }).strict(),
]);

const CurrentOrderResultSchema = z.object({
  activeCartId: z.string().min(1),
  cartVersion: CartVersionSchema,
  itemCount: z.number().int().min(0).max(9999),
  total: z.number().min(0),
  locked: z.boolean(),
  announcement: z.string().min(1).max(300),
}).strict();

/** args ของ tool ที่ต้องผูกตะกร้า — binding ถูกตรวจโดย dispatcher ก่อน execute เสมอ */
function requireCartBinding(args: { activeCartId: string }, binding: CartBinding | null): CartBinding {
  if (!binding || binding.activeCartId !== args.activeCartId) {
    // กันพลาดอีกชั้น: binding ที่ได้ต้องชี้ตะกร้าใบเดียวกับ args เสมอ
    throw new Error("Cart binding mismatch");
  }
  return binding;
}

type CartIntentType = "pos.add_item" | "pos.set_quantity" | "pos.increase_item" | "pos.decrease_item" | "pos.remove_item";
type CartIntent = Extract<VoiceIntent, { type: CartIntentType }>;

function isCartIntent(intent: VoiceIntent): intent is CartIntent {
  switch (intent.type) {
    case "pos.add_item":
    case "pos.set_quantity":
    case "pos.increase_item":
    case "pos.decrease_item":
    case "pos.remove_item":
      return true;
    default:
      return false;
  }
}

/** เรียก resolver เดิม 1 ทาง แล้วแปลงผลเป็น tool result (ไม่มี side effect กับตะกร้า) */
async function resolveCartCommand(
  command: AiVoiceCommand,
  deps: PosToolDeps,
  context: TrustedContext,
): Promise<z.infer<typeof CartCommandResultSchema>> {
  const catalog = await deps.loadCatalog(context.storeId);
  const resolved = resolveAiVoiceCommand(command, { products: catalog.products, productAliases: catalog.aliases });
  switch (resolved.status) {
    case "apply": {
      // resolver อาจคืน intent อื่น (เช่น clear_search) — tool ตะกร้ารับเฉพาะ 5 intent ตะกร้าเท่านั้น
      if (!isCartIntent(resolved.intent)) {
        return { status: "clarification", reason: "unsupported", note: "คำสั่งนี้ยังไม่รองรับในโหมดข้อความ" };
      }
      return { status: "apply", intent: resolved.intent, productName: resolved.productName };
    }
    case "needs_option":
      return { status: "clarification", reason: "needs_option", productId: resolved.productId, productName: resolved.productName, note: resolved.note };
    case "needs_quantity":
      return { status: "clarification", reason: "needs_quantity", productName: resolved.productName };
    case "ambiguous":
      return { status: "clarification", reason: "ambiguous", candidates: resolved.candidates.slice(0, 5).map((p) => ({ id: p.id, name: p.name })) };
    case "not_found":
      return { status: "clarification", reason: "not_found", note: resolved.note };
    case "unavailable":
      return { status: "clarification", reason: "unavailable", productName: resolved.productName };
    default:
      return { status: "clarification", reason: "unsupported", note: "คำสั่งนี้ยังไม่รองรับในโหมดข้อความ" };
  }
}

/**
 * คำสั่ง remove ผ่าน resolver ชั้นล่างเดียวกัน (resolveVoiceProductPhrase) โดยตรง
 * เหตุผล: resolveAiVoiceCommand ปัด remove ที่ไม่ระบุจำนวนเป็น needs_quantity เสมอ
 * (normalizeAiCommandQuantity คืน null สำหรับ remove — พฤติกรรมเดิมของเสียงที่ PR2
 * additive-only จึงแก้ไม่ได้) ทั้งที่การลบไม่ต้องใช้จำนวน — จึงจำลองเกตเดิมของ resolver
 * (not_found/ambiguous/needs_option/unavailable) บน resolver ตัวเดียวกัน
 */
async function resolveRemoveCommand(
  productPhrase: string,
  deps: PosToolDeps,
  context: TrustedContext,
): Promise<z.infer<typeof CartCommandResultSchema>> {
  const catalog = await deps.loadCatalog(context.storeId);
  const resolution = resolveVoiceProductPhrase(productPhrase, catalog.products, catalog.aliases);
  if (resolution.status === "not_found") {
    return { status: "clarification", reason: "not_found", note: "ไม่พบสินค้านี้ในเมนู" };
  }
  if (resolution.status === "ambiguous") {
    return { status: "clarification", reason: "ambiguous", candidates: resolution.candidates.slice(0, 5).map((p) => ({ id: p.id, name: p.name })) };
  }
  const { product, unknownPhrase, missingRequiredGroups, needsVariant } = resolution.selection;
  if (product.outOfStock === true) {
    return { status: "clarification", reason: "unavailable", productName: product.name };
  }
  if (needsVariant || missingRequiredGroups.length > 0 || unknownPhrase) {
    const missing = [...(needsVariant ? ["ตัวเลือกสินค้า"] : []), ...missingRequiredGroups].join(" / ");
    return {
      status: "clarification",
      reason: "needs_option",
      productId: product.id,
      productName: product.name,
      note: missing ? `ยังต้องเลือก ${missing}` : "ยังต้องเลือกตัวเลือกสินค้า",
    };
  }
  return { status: "apply", intent: { type: "pos.remove_item", productPhrase }, productName: product.name };
}

function cartRefArgs() {
  return { activeCartId: ActiveCartIdSchema, cartVersion: CartVersionSchema };
}

/**
 * resolve ทุกรายการของคำสั่งชุดเดียว แล้วตัดสินแบบ "ครบหรือไม่เอาเลย"
 *
 * เหตุผลที่ไม่ commit บางส่วน: ถ้าพูด "อเมริกาโน่สอง ลาเต้สาม" แล้วลาเต้กำกวม การใส่
 * อเมริกาโน่ไปก่อนแล้วถามต่อ จะทำให้พนักงานไม่รู้ว่าตะกร้ามีอะไรไปแล้วบ้าง — ถามให้จบก่อนดีกว่า
 */
async function resolveBatchAddCommand(
  items: readonly { productPhrase: string; quantity: number; optionPhrases: string[] }[],
  deps: PosToolDeps,
  context: TrustedContext,
): Promise<z.infer<typeof CartCommandResultSchema>> {
  const resolvedItems: { intent: z.infer<typeof CartIntentSchema>; productName: string }[] = [];
  for (const item of items) {
    const resolved = await resolveCartCommand(
      { intent: "pos.add_item", productPhrase: item.productPhrase, quantity: item.quantity, optionPhrases: item.optionPhrases },
      deps,
      context,
    );
    if (resolved.status !== "apply") {
      // บอกด้วยว่าติดที่รายการไหน ไม่งั้น model จะถามกว้าง ๆ แล้วผู้ใช้ต้องเดาเอง
      const note = resolved.status === "clarification" && resolved.note
        ? `${resolved.note} (รายการ "${item.productPhrase}")`
        : `ติดที่รายการ "${item.productPhrase}"`;
      return resolved.status === "clarification" ? { ...resolved, note: note.slice(0, 200) } : resolved;
    }
    resolvedItems.push({ intent: resolved.intent, productName: resolved.productName });
  }
  if (resolvedItems.length === 0) {
    return { status: "clarification", reason: "unsupported", note: "ไม่มีรายการให้เพิ่ม" };
  }
  return { status: "apply_batch", items: resolvedItems };
}

/** ลงทะเบียน MVP tools ทั้ง 6 ตัว — registry environment คุม dev-only tool ตาม PR1 เดิม */
export function registerPosTools(registry: ToolRegistry, deps: PosToolDeps): void {
  // 1) pos.search_product / 2) catalog.search — ค้นหาด้วย resolveVoiceProductPhrase + alias เดิม (read)
  const searchExecute = async (rawArgs: unknown, context: TrustedContext) => {
    const args = rawArgs as { query: string };
    const catalog = await deps.loadCatalog(context.storeId);
    const resolution = resolveVoiceProductPhrase(args.query, catalog.products, catalog.aliases);
    if (resolution.status === "not_found") {
      return { status: "not_found", note: "ไม่พบสินค้าที่ค้นหา" };
    }
    if (resolution.status === "ambiguous") {
      return { status: "ambiguous", candidates: resolution.candidates.slice(0, 5).map((p) => ({ id: p.id, name: p.name })) };
    }
    const { product } = resolution.selection;
    return {
      status: "matched",
      product: { id: product.id, name: product.name },
      price: product.basePrice,
      outOfStock: product.outOfStock === true,
      note: product.outOfStock === true ? "สินค้านี้ของหมดอยู่ในขณะนี้" : null,
    };
  };
  const searchArgs = z.object({ query: PhraseSchema }).strict();
  const searchBase = { risk: "read" as const, permissions: ["pos.use" as const], args: searchArgs, result: SearchResultSchema, execute: searchExecute };
  registry.register({ ...searchBase, name: "pos.search_product" });
  registry.register({ ...searchBase, name: "catalog.search" });

  // 3) pos.get_current_order — ต้องมี binding ที่ server ตรวจแล้ว; สรุปที่ client ส่งมาพร้อมการยืนยัน binding
  registry.register({
    name: "pos.get_current_order",
    risk: "read",
    permissions: ["pos.use"],
    requiresActiveCart: true,
    args: z.object({
      ...cartRefArgs(),
      summary: z.object({
        itemCount: z.number().int().min(0).max(9999),
        total: z.number().min(0),
        locked: z.boolean(),
      }).strict(),
    }).strict(),
    result: CurrentOrderResultSchema,
    execute: async (args, _context, binding) => {
      const validated = requireCartBinding(args as { activeCartId: string }, binding);
      const summary = (args as { summary: { itemCount: number; total: number; locked: boolean } }).summary;
      return {
        activeCartId: validated.activeCartId,
        cartVersion: validated.cartVersion,
        itemCount: summary.itemCount,
        total: summary.total,
        locked: summary.locked,
        announcement: `ตะกร้าปัจจุบัน ${summary.itemCount} รายการ ยอดรวม ${summary.total}`,
      };
    },
  });

  // 4) pos.add_item — คืนคำสั่งให้ client ผลักเข้าตะกร้าผ่าน applyVoiceCartIntent เดิม
  registry.register({
    name: "pos.add_item",
    risk: "safe_write",
    permissions: ["pos.use"],
    requiresActiveCart: true,
    args: z.object({
      ...cartRefArgs(),
      productPhrase: PhraseSchema,
      quantity: z.number().int().min(VOICE_MIN_QUANTITY).max(VOICE_MAX_QUANTITY),
      optionPhrases: z.array(PhraseSchema).max(8),
    }).strict(),
    result: CartCommandResultSchema,
    execute: async (args, context, binding) => {
      requireCartBinding(args as { activeCartId: string }, binding);
      const input = args as { productPhrase: string; quantity: number; optionPhrases: string[] };
      return resolveCartCommand(
        { intent: "pos.add_item", productPhrase: input.productPhrase, quantity: input.quantity, optionPhrases: input.optionPhrases },
        deps,
        context,
      );
    },
  });

  // 5) pos.add_items — หลายรายการในประโยคเดียว (ลด latency/tool call และไม่ใส่ตะกร้าครึ่ง ๆ กลาง ๆ)
  registry.register({
    name: "pos.add_items",
    risk: "safe_write",
    permissions: ["pos.use"],
    requiresActiveCart: true,
    args: z.object({
      ...cartRefArgs(),
      items: z.array(z.object({
        productPhrase: PhraseSchema,
        quantity: z.number().int().min(VOICE_MIN_QUANTITY).max(VOICE_MAX_QUANTITY),
        optionPhrases: z.array(PhraseSchema).max(8),
      }).strict()).min(1).max(MAX_BATCH_ITEMS),
    }).strict(),
    result: CartCommandResultSchema,
    execute: async (args, context, binding) => {
      requireCartBinding(args as { activeCartId: string }, binding);
      const input = args as { items: { productPhrase: string; quantity: number; optionPhrases: string[] }[] };
      return resolveBatchAddCommand(input.items, deps, context);
    },
  });

  // 6) pos.remove_item
  registry.register({
    name: "pos.remove_item",
    risk: "safe_write",
    permissions: ["pos.use"],
    requiresActiveCart: true,
    args: z.object({ ...cartRefArgs(), productPhrase: PhraseSchema }).strict(),
    result: CartCommandResultSchema,
    execute: async (args, context, binding) => {
      requireCartBinding(args as { activeCartId: string }, binding);
      const input = args as { productPhrase: string };
      return resolveRemoveCommand(input.productPhrase, deps, context);
    },
  });

  // 7) pos.change_quantity — set/increase/decrease ผ่าน intent เดิมของ resolver
  registry.register({
    name: "pos.change_quantity",
    risk: "safe_write",
    permissions: ["pos.use"],
    requiresActiveCart: true,
    args: z.object({
      ...cartRefArgs(),
      productPhrase: PhraseSchema,
      mode: z.enum(["set", "increase", "decrease"]),
      quantity: z.number().int().min(VOICE_MIN_QUANTITY).max(VOICE_MAX_QUANTITY),
    }).strict(),
    result: CartCommandResultSchema,
    execute: async (args, context, binding) => {
      requireCartBinding(args as { activeCartId: string }, binding);
      const input = args as { productPhrase: string; mode: "set" | "increase" | "decrease"; quantity: number };
      const intent: AiVoiceCommand["intent"] =
        input.mode === "set" ? "pos.set_quantity" : input.mode === "increase" ? "pos.increase_item" : "pos.decrease_item";
      return resolveCartCommand(
        { intent, productPhrase: input.productPhrase, quantity: input.quantity, optionPhrases: [] },
        deps,
        context,
      );
    },
  });

  // 8) pos.open_checkout — "กดปุ่มคิดเงิน" แทนพนักงาน ไม่มากกว่านั้น
  //
  // ขอบเขตที่จงใจล็อกไว้ (เจ้าของสั่ง): AI ห้ามสร้าง payment / ห้ามสร้าง QR / ห้ามยืนยันชำระเงิน
  // tool นี้จึงไม่แตะ payment ใด ๆ เลย แค่คืนคำสั่งให้หน้าจอเปิดแผงรับชำระ "ตัวเดิม" ของ POS
  // จากนั้นทุกอย่าง (เตรียม QR / จอลูกค้า / ปุ่มยืนยัน) เป็นโค้ดเดิมที่พนักงานใช้อยู่ทุกวัน
  registry.register({
    name: "pos.open_checkout",
    risk: "safe_write",
    permissions: ["pos.use"],
    requiresActiveCart: true,
    args: z.object({ ...cartRefArgs() }).strict(),
    result: CartCommandResultSchema,
    execute: async (args, _context, binding) => {
      requireCartBinding(args as { activeCartId: string }, binding);
      return { status: "client_action", action: "open_checkout", announcement: "เปิดหน้าจอรับชำระให้แล้ว" };
    },
  });

}
