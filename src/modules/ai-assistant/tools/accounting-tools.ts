// P2 — tool บัญชี: tool ชุดแรกที่ใช้ชั้นยืนยันจริง
//
// เลือกบัญชีเป็นเรื่องแรกก่อนเมนู/QR เพราะ schema เล็ก ผลลัพธ์ตรวจง่าย ผิดแล้วลบได้
// และเป็นที่ที่ "ให้ AI อ่านข้อมูลเดิมมาเสนอ" เห็นผลชัดที่สุด
//
// สิ่งที่ทำให้ใช้งานจริงได้ ไม่ใช่แค่สั่งการ: พูดว่า "ลงค่าน้ำแข็ง 450" แล้วต้องไม่ย้อนถาม
// ว่าหมวดไหน ถ้าร้านเคยลงค่าน้ำแข็งมาแล้ว 31 ครั้ง — ระบบไปดูเองว่าเคยลงหมวดอะไร
//
// และเมื่อร้านยังไม่มีหมวดที่เข้าเค้าเลย ต้อง **เสนอสร้างให้ตรงนั้น** ไม่ใช่ตอบว่าลงไม่ได้
// (หลักการกลาง "ไม่มีให้เพิ่ม ไม่ใช่ข้าม")

import { z } from "zod";
import type { AccountingCategory, Transaction, TransactionType } from "@/modules/accounting/types";
import type { ToolRegistry, TrustedContext } from "../foundation";
import type { Prerequisite, ProposalDraft } from "../proposal";

export interface AccountingToolDeps {
  listCategories: (storeId: string) => Promise<readonly AccountingCategory[]>;
  /** ประวัติล่าสุดของร้าน ใช้เดาหมวดและเทียบว่ายอดผิดปกติไหม */
  listRecentTransactions: (storeId: string, limit: number) => Promise<readonly Transaction[]>;
  createTransaction: (input: {
    storeId: string;
    organizationId: string;
    type: TransactionType;
    categoryId: string;
    categoryName: string;
    amount: number;
    note?: string;
    date: string;
    createdByUserId: string;
  }) => Promise<{ id: string }>;
}

/** จำนวนรายการย้อนหลังที่ดึงมาเดาหมวด — มากกว่านี้ไม่ได้แม่นขึ้นแต่ egress โตขึ้น */
const HISTORY_LIMIT = 200;
/** ต่ำกว่านี้ถือว่าเดาไม่ได้ ต้องให้คนเลือกเอง */
const MIN_HISTORY_HITS = 1;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ตัดช่องว่าง/ตัวพิมพ์ ให้ "น้ำแข็ง " กับ "น้ำแข็ง" นับเป็นคำเดียวกัน */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function relatedToNote(transactionNote: string | undefined, query: string): boolean {
  if (!transactionNote) return false;
  const a = normalize(transactionNote);
  const b = normalize(query);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

export interface CategorySuggestion {
  readonly categoryId: string;
  readonly categoryName: string;
  /** เคยใช้กับคำอธิบายคล้ายกันกี่ครั้ง — เลขนี้โชว์ในการ์ดเพื่อให้คนตัดสินใจได้ */
  readonly timesUsed: number;
  readonly lastUsedAt: string | null;
  readonly amounts: readonly number[];
}

/**
 * เดาหมวดจากประวัติของร้านเอง — ไม่ใช่จากความรู้ทั่วไปของโมเดล
 *
 * ร้านหนึ่งอาจลงค่าน้ำแข็งเป็น "วัตถุดิบ" อีกร้านเป็น "ของใช้สิ้นเปลือง" — ความรู้ทั่วไป
 * ตอบแทนร้านไม่ได้ และเดาผิดในเรื่องเงินคือเรื่องใหญ่กว่าการถามเพิ่มหนึ่งครั้ง
 */
export function suggestCategoryFromHistory(
  history: readonly Transaction[],
  type: TransactionType,
  note: string,
): CategorySuggestion | null {
  const tally = new Map<string, { name: string; count: number; last: string | null; amounts: number[] }>();
  for (const transaction of history) {
    if (transaction.type !== type || !relatedToNote(transaction.note, note)) continue;
    const entry = tally.get(transaction.categoryId)
      ?? { name: transaction.categoryName, count: 0, last: null, amounts: [] };
    entry.count += 1;
    entry.amounts.push(transaction.amount);
    if (!entry.last || transaction.date > entry.last) entry.last = transaction.date;
    tally.set(transaction.categoryId, entry);
  }
  let best: CategorySuggestion | null = null;
  for (const [categoryId, entry] of tally) {
    if (entry.count < MIN_HISTORY_HITS) continue;
    // ใช้บ่อยกว่าชนะ; เท่ากันให้ตัวที่ใช้ล่าสุดชนะ (ร้านเปลี่ยนวิธีลงบัญชีได้)
    if (!best || entry.count > best.timesUsed || (entry.count === best.timesUsed && (entry.last ?? "") > (best.lastUsedAt ?? ""))) {
      best = { categoryId, categoryName: entry.name, timesUsed: entry.count, lastUsedAt: entry.last, amounts: entry.amounts };
    }
  }
  return best;
}

const TransactionArgs = z.object({
  type: z.enum(["income", "expense"]),
  amount: z.number().positive().max(10_000_000),
  note: z.string().min(1).max(200),
  date: z.string().regex(DATE_RE).optional(),
}).strict();

const thb = (value: number) => `${value.toLocaleString("th-TH")} บาท`;

export function registerAccountingTools(registry: ToolRegistry, deps: AccountingToolDeps): void {
  registry.register({
    name: "accounting.list_categories",
    risk: "read",
    permissions: ["cashflow.record"],
    args: z.object({ type: z.enum(["income", "expense"]).optional() }).strict(),
    result: z.object({
      categories: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })),
    }).strict(),
    execute: async (args, context) => {
      const { type } = args as { type?: TransactionType };
      const categories = await deps.listCategories(context.storeId);
      return {
        categories: categories
          .filter((category) => !type || category.type === type)
          .map((category) => ({ id: category.id, name: category.name, type: category.type })),
      };
    },
  });

  registry.register({
    name: "accounting.suggest_category",
    risk: "read",
    permissions: ["cashflow.record"],
    args: z.object({ type: z.enum(["income", "expense"]), note: z.string().min(1).max(200) }).strict(),
    result: z.object({
      suggestion: z.object({
        categoryId: z.string(),
        categoryName: z.string(),
        timesUsed: z.number(),
        lastUsedAt: z.string().nullable(),
      }).nullable(),
    }).strict(),
    execute: async (args, context) => {
      const { type, note } = args as { type: TransactionType; note: string };
      const history = await deps.listRecentTransactions(context.storeId, HISTORY_LIMIT);
      const best = suggestCategoryFromHistory(history, type, note);
      return {
        suggestion: best
          ? { categoryId: best.categoryId, categoryName: best.categoryName, timesUsed: best.timesUsed, lastUsedAt: best.lastUsedAt }
          : null,
      };
    },
  });

  registry.register({
    name: "accounting.create_transaction",
    risk: "safe_write",
    permissions: ["cashflow.record"],
    args: TransactionArgs,
    result: z.object({ id: z.string(), categoryId: z.string(), categoryName: z.string() }).strict(),

    /**
     * จังหวะเสนอ — อ่านอย่างเดียว ไม่เขียนอะไรทั้งสิ้น
     *
     * ลำดับการหาหมวด: คำตอบที่ผู้ใช้เลือกในการ์ด → ประวัติของร้าน → ให้เลือกเอง
     * ไม่มีหมวดของประเภทนั้นเลย = เสนอ "สร้างหมวดก่อน" ไม่ใช่ตอบว่าลงไม่ได้
     */
    plan: async (rawArgs, context, answers): Promise<ProposalDraft> => {
      const args = rawArgs as z.infer<typeof TransactionArgs>;
      const date = args.date ?? new Date().toISOString().slice(0, 10);
      const [categories, history] = await Promise.all([
        deps.listCategories(context.storeId),
        deps.listRecentTransactions(context.storeId, HISTORY_LIMIT),
      ]);
      const ofType = categories.filter((category) => category.type === args.type);
      const kindLabel = args.type === "expense" ? "รายจ่าย" : "รายรับ";

      const chosen = ofType.find((category) => category.id === answers.category);
      const suggested = chosen ? null : suggestCategoryFromHistory(history, args.type, args.note);
      const resolved = chosen
        ?? (suggested ? ofType.find((category) => category.id === suggested.categoryId) : undefined);

      const prerequisites: Prerequisite[] = [];
      if (ofType.length === 0) {
        prerequisites.push({
          kind: "create",
          need: `หมวด${kindLabel}`,
          createTool: "accounting.create_category",
          reason: `ร้านยังไม่มีหมวด${kindLabel}สักหมวด ต้องสร้างก่อนจึงจะลงรายการได้`,
        });
      } else if (!resolved) {
        prerequisites.push({
          kind: "choose",
          need: `หมวด${kindLabel}`,
          subjects: [{ id: "category", label: args.note }],
          options: ofType.map((category) => ({ id: category.id, label: category.name })),
        });
      }

      const warnings: string[] = [];
      // ยอดที่ห่างจากที่ร้านเคยลงมาก ๆ มักเป็นการพิมพ์/ฟังผิดหลักพัน ซึ่งเป็นความผิดพลาด
      // ที่เจอบ่อยที่สุดของการสั่งด้วยเสียง — เตือนไว้ แต่ไม่บล็อก เพราะยอดสูงจริงก็มี
      const seen = suggested?.amounts ?? [];
      if (seen.length >= 3) {
        const max = Math.max(...seen);
        const min = Math.min(...seen);
        if (args.amount > max * 3 || args.amount * 3 < min) {
          warnings.push(`ยอดนี้ต่างจากที่ร้านเคยลง (${thb(min)}–${thb(max)}) ค่อนข้างมาก`);
        }
      }

      const changes = [
        { label: "ประเภท", before: null, after: kindLabel },
        { label: "หมวด", before: null, after: resolved?.name ?? "— ยังไม่ได้เลือก —" },
        { label: "รายละเอียด", before: null, after: args.note },
        { label: "จำนวนเงิน", before: null, after: thb(args.amount) },
        { label: "วันที่", before: null, after: date },
      ];
      const reason = chosen
        ? "หมวดที่คุณเลือก"
        : suggested
          ? `หมวดเลือกจากประวัติ ${suggested.timesUsed} ครั้ง`
          : "ยังไม่ได้เลือกหมวด";

      return {
        summary: `บันทึก${kindLabel} ${args.note} ${thb(args.amount)} (${reason})`,
        changes,
        affectedCount: 1,
        warnings,
        prerequisites,
      };
    },

    execute: async (rawArgs, context, _cartBinding, answers) => {
      const args = rawArgs as z.infer<typeof TransactionArgs>;
      const date = args.date ?? new Date().toISOString().slice(0, 10);
      const categories = await deps.listCategories(context.storeId);
      const ofType = categories.filter((category) => category.type === args.type);
      const chosen = ofType.find((category) => category.id === answers.category);
      let resolved = chosen;
      if (!resolved) {
        const history = await deps.listRecentTransactions(context.storeId, HISTORY_LIMIT);
        const suggested = suggestCategoryFromHistory(history, args.type, args.note);
        resolved = suggested ? ofType.find((category) => category.id === suggested.categoryId) : undefined;
      }
      // ถึงตรงนี้แล้วยังไม่มีหมวด = prerequisite ถูกข้ามมาได้ ซึ่งไม่ควรเกิด
      // ปฏิเสธเสียงดังดีกว่าเดาหมวดให้ เพราะเป็นเรื่องเงินของร้าน
      if (!resolved) throw new Error("Accounting category unresolved");
      const created = await deps.createTransaction({
        storeId: context.storeId,
        organizationId: context.organizationId,
        type: args.type,
        categoryId: resolved.id,
        categoryName: resolved.name,
        amount: args.amount,
        note: args.note,
        date,
        createdByUserId: context.userId,
      });
      return { id: created.id, categoryId: resolved.id, categoryName: resolved.name };
    },
  });
}

export const ACCOUNTING_TOOL_NAMES = [
  "accounting.list_categories",
  "accounting.suggest_category",
  "accounting.create_transaction",
] as const;

export type AccountingToolName = (typeof ACCOUNTING_TOOL_NAMES)[number];
export type { TrustedContext };
