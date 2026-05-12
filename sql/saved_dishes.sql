-- Выполни в Supabase SQL Editor (если проект уже создан).

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
