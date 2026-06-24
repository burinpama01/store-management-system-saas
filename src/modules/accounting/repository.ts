import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type {
  AccountingCategory,
  Transaction,
  CashLedgerEntry,
  TransactionType,
  CashflowSummary,
} from "./types";
import type { Database } from "@/server/integrations/supabase/database.types";

type CategoryRow = Database["public"]["Tables"]["accounting_categories"]["Row"];
type TransactionRow = Database["public"]["Tables"]["transactions"]["Row"];
type LedgerRow = Database["public"]["Tables"]["cash_ledger_entries"]["Row"];

function mapCategory(row: CategoryRow): AccountingCategory {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    name: row.name,
    type: row.type as TransactionType,
    isDefault: row.is_default,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    type: row.type as TransactionType,
    categoryId: row.category_id,
    categoryName: row.category_name,
    amount: row.amount,
    note: row.note ?? undefined,
    date: row.date,
    createdByUserId: row.created_by_user_id,
    orderId: row.order_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLedger(row: LedgerRow): CashLedgerEntry {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    type: row.type as CashLedgerEntry["type"],
    amount: row.amount,
    balanceAfter: row.balance_after,
    transactionId: row.transaction_id ?? undefined,
    orderId: row.order_id ?? undefined,
    note: row.note ?? undefined,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

// --- Categories ---

export async function listAccountingCategories(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounting_categories")
    .select("*")
    .eq("store_id", storeId)
    .order("sort_order");
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map(mapCategory), error: null };
}

export interface CreateAccountingCategoryInput {
  storeId: string;
  organizationId: string;
  name: string;
  type: Extract<TransactionType, "income" | "expense">;
  isDefault?: boolean;
  sortOrder?: number;
}

export async function createAccountingCategory(input: CreateAccountingCategoryInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounting_categories")
    .insert({
      store_id: input.storeId,
      organization_id: input.organizationId,
      name: input.name,
      type: input.type,
      is_default: input.isDefault ?? false,
      sort_order: input.sortOrder ?? 100,
    })
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapCategory(data), error: null };
}

export async function getDefaultAccountingCategory(
  storeId: string,
  type: TransactionType,
  preferredName?: string,
) {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("accounting_categories")
    .select("*")
    .eq("store_id", storeId)
    .eq("type", type)
    .eq("is_default", true)
    .order("sort_order");

  if (preferredName) query = query.eq("name", preferredName);

  const { data, error } = await query.limit(1).maybeSingle();
  if (error) return { data: null, error: mapError(error) };
  if (data) return { data: mapCategory(data), error: null };

  const fallback = await supabase
    .from("accounting_categories")
    .select("*")
    .eq("store_id", storeId)
    .eq("type", type)
    .order("sort_order")
    .limit(1)
    .maybeSingle();
  if (fallback.error) return { data: null, error: mapError(fallback.error) };
  return { data: fallback.data ? mapCategory(fallback.data) : null, error: null };
}

// --- Transactions ---

export interface CreateTransactionInput {
  storeId: string;
  organizationId: string;
  type: TransactionType;
  categoryId: string;
  categoryName: string;
  amount: number;
  note?: string;
  date: string;
  createdByUserId: string;
  orderId?: string;
}

export async function createTransaction(input: CreateTransactionInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("transactions")
    .insert({
      store_id: input.storeId,
      organization_id: input.organizationId,
      type: input.type,
      category_id: input.categoryId,
      category_name: input.categoryName,
      amount: input.amount,
      note: input.note ?? null,
      date: input.date,
      created_by_user_id: input.createdByUserId,
      order_id: input.orderId ?? null,
    })
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapTransaction(data), error: null };
}

export async function getTransaction(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("id", id)
    .eq("store_id", storeId)
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapTransaction(data), error: null };
}

export async function deleteTransaction(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("transactions")
    .delete()
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export interface ListTransactionsOpts {
  dateFrom?: string;
  dateTo?: string;
  type?: TransactionType | "all";
  page?: number;
  pageSize?: number;
}

export async function listTransactions(storeId: string, opts: ListTransactionsOpts = {}) {
  const supabase = await createSupabaseServerClient();
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 20);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let q = supabase
    .from("transactions")
    .select("*", { count: "exact" })
    .eq("store_id", storeId)
    .order("date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (opts.dateFrom) q = q.gte("date", opts.dateFrom);
  if (opts.dateTo) q = q.lte("date", opts.dateTo);
  if (opts.type && opts.type !== "all") q = q.eq("type", opts.type);

  const { data, error, count } = await q;
  if (error) return { data: null, count: 0, error: mapError(error) };
  return { data: (data ?? []).map(mapTransaction), count: count ?? 0, error: null };
}

export async function getTransactionSummary(
  storeId: string,
  dateFrom: string,
  dateTo: string,
): Promise<CashflowSummary> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("transactions")
    .select("type, amount")
    .eq("store_id", storeId)
    .gte("date", dateFrom)
    .lte("date", dateTo);

  if (error) {
    return { storeId, dateFrom, dateTo, openingBalance: 0, totalIncome: 0, totalExpense: 0, netCashflow: 0, closingBalance: 0 };
  }

  const rows = data ?? [];
  const totalIncome = rows
    .filter((r) => r.type === "income")
    .reduce((sum, r) => sum + r.amount, 0);
  const totalExpense = rows
    .filter((r) => r.type === "expense")
    .reduce((sum, r) => sum + r.amount, 0);
  const netCashflow = totalIncome - totalExpense;

  return {
    storeId,
    dateFrom,
    dateTo,
    openingBalance: 0,
    totalIncome,
    totalExpense,
    netCashflow,
    closingBalance: 0 + netCashflow,
  };
}

// --- Cash Ledger ---

export async function getLatestCashBalance(storeId: string): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("cash_ledger_entries")
    .select("balance_after")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  return data?.balance_after ?? 0;
}

export interface AddCashLedgerInput {
  storeId: string;
  organizationId: string;
  type: CashLedgerEntry["type"];
  amount: number;
  balanceAfter: number;
  transactionId?: string;
  orderId?: string;
  note?: string;
  createdByUserId: string;
}

export async function addCashLedgerEntry(input: AddCashLedgerInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("cash_ledger_entries")
    .insert({
      store_id: input.storeId,
      organization_id: input.organizationId,
      type: input.type,
      amount: input.amount,
      balance_after: input.balanceAfter,
      transaction_id: input.transactionId ?? null,
      order_id: input.orderId ?? null,
      note: input.note ?? null,
      created_by_user_id: input.createdByUserId,
    })
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapLedger(data), error: null };
}

export async function listCashLedgerEntries(storeId: string, opts: { limit?: number } = {}) {
  const supabase = await createSupabaseServerClient();
  const limit = Math.min(opts.limit ?? 50, 500);
  const { data, error } = await supabase
    .from("cash_ledger_entries")
    .select("*")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map(mapLedger), error: null };
}
