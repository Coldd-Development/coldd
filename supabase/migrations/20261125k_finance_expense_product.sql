-- Optional "Associated product" on an expense (e.g. thumbnails or a commission for one product).
alter table public.finance_expenses add column if not exists product_id uuid references public.products(id) on delete set null;
