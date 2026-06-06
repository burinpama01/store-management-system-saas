import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  listTransactions,
  listAccountingCategories,
  getTransactionSummary,
  getLatestCashBalance,
} from "@/modules/accounting/repository";
import { AccountingManager } from "./AccountingManager";

export const dynamic = "force-dynamic";

export default async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("cashflow.view")) redirect("/dashboard");

  const params = await searchParams;
  const today = new Date().toISOString().split("T")[0];
  const monthStart = today.slice(0, 7) + "-01";
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isValidDate = (s: string) => DATE_RE.test(s) && !isNaN(Date.parse(s));
  const dateFrom = isValidDate(params.dateFrom ?? "") ? params.dateFrom : monthStart;
  const dateTo = isValidDate(params.dateTo ?? "") ? params.dateTo : today;
  const VALID_TYPES = ["all", "income", "expense", "cash_adjustment"];
  const typeFilter = VALID_TYPES.includes(params.type ?? "") ? params.type : "all";
  const page = Math.max(1, parseInt(params.page ?? "1") || 1);

  const [txRes, catsRes, summary, cashBalance] = await Promise.all([
    listTransactions(ctx.storeId, {
      dateFrom,
      dateTo,
      type: typeFilter as "all" | "income" | "expense" | "cash_adjustment",
      page,
      pageSize: 20,
    }),
    listAccountingCategories(ctx.storeId),
    getTransactionSummary(ctx.storeId, dateFrom, dateTo),
    getLatestCashBalance(ctx.storeId),
  ]);

  return (
    <AccountingManager
      storeId={ctx.storeId}
      canManage={resolved.can("cashflow.manage")}
      initialTransactions={txRes.data ?? []}
      totalCount={txRes.count}
      categories={catsRes.data ?? []}
      summary={summary}
      cashBalance={cashBalance}
      dateFrom={dateFrom}
      dateTo={dateTo}
      typeFilter={typeFilter}
      page={page}
    />
  );
}
