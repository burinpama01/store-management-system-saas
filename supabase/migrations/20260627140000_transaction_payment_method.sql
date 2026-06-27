-- Record whether a manual income/expense was paid by cash or bank transfer.
-- Only cash entries touch the cash drawer (cash_ledger_entries); transfers still count in
-- the income/expense (P&L) totals but must not move the cash-in-drawer balance.
-- Existing rows default to 'cash', preserving the previous behaviour.

alter table transactions
  add column if not exists payment_method text not null default 'cash'
    check (payment_method in ('cash', 'transfer'));
