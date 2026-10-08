-- General reviews: site-wide reviews that are not tied to any product (shown on /reviews,
-- never counted in a product's rating). product_id becomes optional; byline is the
-- "Role or company" line under the reviewer's name; avatar_url is an optional picture.
-- The rating triggers (recompute_product_rating, reviews_stats_trigger) already ignore a
-- null product_id.
alter table public.reviews alter column product_id drop not null;
alter table public.reviews add column if not exists byline text;
alter table public.reviews add column if not exists avatar_url text;
