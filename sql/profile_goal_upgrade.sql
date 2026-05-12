alter table if exists public.profiles add column if not exists name text;
alter table if exists public.profiles add column if not exists target_weight_kg numeric(5, 2);
alter table if exists public.profiles add column if not exists target_weeks smallint;
