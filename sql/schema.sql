-- Выполни в Supabase: SQL Editor → New query → вставь → Run.
-- Таблицы простые: профиль пользователя (по Telegram id) и приёмы пищи.

create table if not exists public.profiles (
  telegram_user_id bigint primary key,
  name text,
  age smallint not null check (age between 10 and 120),
  height_cm smallint not null check (height_cm between 80 and 250),
  weight_kg numeric(5, 2) not null check (weight_kg between 20 and 400),
  target_weight_kg numeric(5, 2),
  target_weeks smallint,
  gender text not null check (gender in ('male', 'female')),
  goal text not null check (goal in ('lose', 'maintain', 'gain')),
  daily_calorie_target int not null check (daily_calorie_target between 800 and 6000),
  updated_at timestamptz not null default now()
);

alter table if exists public.profiles add column if not exists name text;
alter table if exists public.profiles add column if not exists target_weight_kg numeric(5, 2);
alter table if exists public.profiles add column if not exists target_weeks smallint;

create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null references public.profiles (telegram_user_id) on delete cascade,
  raw_text text not null,
  calories int not null check (calories between 0 and 20000),
  protein_g numeric(6, 2) not null,
  fat_g numeric(6, 2) not null,
  carbs_g numeric(6, 2) not null,
  log_date date not null,
  eaten_at timestamptz not null default now()
);

create index if not exists meals_user_log_date on public.meals (telegram_user_id, log_date desc);

-- Сохранённые блюда (библиотека порций)
create table if not exists public.saved_dishes (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null references public.profiles (telegram_user_id) on delete cascade,
  title text not null,
  portion_grams numeric(8, 2),
  calories int not null check (calories between 0 and 20000),
  protein_g numeric(6, 2) not null,
  fat_g numeric(6, 2) not null,
  carbs_g numeric(6, 2) not null,
  created_at timestamptz not null default now(),
  constraint saved_title_len check (char_length(title) <= 200)
);

create index if not exists saved_dishes_user_created on public.saved_dishes (telegram_user_id, created_at desc);
