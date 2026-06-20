import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  listTransactions,
  listAccountingCategories,
  getTransactionSummary,
  getLatestCashBalance,
} from "@/modules/accounting/repository";
import { listCashSessions } from "@/modules/cashflow/repository";
import { getStore } from "@/modules/stores/repository";
import { AccountingManager } from "./AccountingManager";
import { CashSessionsHistory } from "./CashSessionsHistory";

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
  const canManageCashflow = resolved.can("cashflow.manage");
  const validTypes = canManageCashflow
    ? ["all", "income", "expense", "cash_adjustment"]
    : ["all", "income", "expense"];
  const typeFilter = validTypes.includes(params.type ?? "") ? params.type : "all";
  const page = Math.max(1, parseInt(params.page ?? "1") || 1);

  const [txRes, catsRes, summary, cashBalance, cashSessionsRes, storeRes] = await Promise.all([
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
    listCashSessions(ctx.storeId, { limit: 30 }),
    getStore(ctx.storeId),
  ]);

  const currency = storeRes.data?.currencyCode ?? "THB";

  return (
    <>
      <AccountingManager
        storeId={ctx.storeId}
        canManage={canManageCashflow}
        canRecord={resolved.can("cashflow.record")}
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
      <div className="page-shell pt-0">
        <CashSessionsHistory sessions={cashSessionsRes.data ?? []} currency={currency} />
      </div>
    </>
  );
}
