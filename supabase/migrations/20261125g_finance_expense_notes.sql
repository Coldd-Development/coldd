-- Finances (2026-11-25): expenses get free-form notes, and expenses imported from a
-- bank statement keep a bank reference (date, amount, description) so importing an
-- overlapping statement again never adds the same purchase twice. "note" is shown as
-- "Reason" on the page.
alter table public.finance_expenses add column if not exists notes text check (notes is null or char_length(notes) <= 1000);
alter table public.finance_expenses add column if not exists bank_ref text unique;
alter table public.finance_expenses drop constraint if exists finance_expenses_source_check;
alter table public.finance_expenses add constraint finance_expenses_source_check check (source in ('manual', 'sheet', 'bank'));
