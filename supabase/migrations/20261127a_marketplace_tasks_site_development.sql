-- Site development tasks (reported issues, bugs) are not about one product: they keep
-- product_id empty and use the marketplace key 'sitedev'. Every other task names a product.
alter table public.marketplace_tasks alter column product_id drop not null;
alter table public.marketplace_tasks add constraint marketplace_tasks_product_or_sitedev check (product_id is not null or marketplace = 'sitedev');
