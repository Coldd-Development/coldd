-- Homepage reviews: pinned ones show first (1, 2, ...); the rest of the three slots fill with the
-- newest glowing reviews. First pins (2026-11-25): the "10 out of 10" and "Really clean VFX" BuiltByBit reviews.
alter table public.reviews add column if not exists home_pin smallint;
comment on column public.reviews.home_pin is 'Homepage reviews: pinned reviews show first, in this order; the rest of the three slots fill with the newest glowing reviews.';
