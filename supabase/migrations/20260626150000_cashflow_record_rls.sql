-- Align cashflow write RLS with the app permission. Recording income/expense is gated in the
-- app by `cashflow.record` (cashier, staff, manager, admin, owner all hold it), but the storage
-- policies required manager+ (transactions) and cashier+ (cash ledger). That blocked cashiers
-- from recording transactions and staff from writing the matching cash-ledger entry, so an
-- expense could not be saved on production. Use the permission directly (overrides respected).

drop policy if exists "transactions: manager+ can write" on transactions;
create policy "transactions: cashflow recorders can insert"
  on transactions for insert
  with check (auth_user_has_permission(organization_id, store_id, 'cashflow.record'));

drop policy if exists "cash_ledger: cashier+ can insert" on cash_ledger_entries;
create policy "cash_ledger: cashflow recorders can insert"
  on cash_ledger_entries for insert
  with check (auth_user_has_permission(organization_id, store_id, 'cashflow.record'));
