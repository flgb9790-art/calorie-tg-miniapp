-- Будущий этап: память ассистента и пользовательские предпочтения.
-- Этот скрипт не требуется для MVP coach/recipe, но подготавливает базу
-- для истории диалога, персональных настроек и логов веса.

create table if not exists public.assistant_threads (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null references public.profiles (telegram_user_id) on delete cascade,
  title text,
  mode text not null default 'coach' check (mode in ('coach', 'recipes')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assistant_threads_user_updated
  on public.assistant_threads (telegram_user_id, updated_at desc);

create table if not exists public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.assistant_threads (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  mode text check (mode in ('coach', 'recipes')),
  content text not null,
  payload_json jsonb,
  created_at timestamptz not null default now()
);

create index if not exists assistant_messages_thread_created
  on public.assistant_messages (thread_id, created_at asc);

create table if not exists public.user_preferences (
  telegram_user_id bigint primary key references public.profiles (telegram_user_id) on delete cascade,
  disliked_products text[] not null default '{}',
  allergies text[] not null default '{}',
  preferred_cuisine text[] not null default '{}',
  diet_style text,
  cooking_time_max_min smallint,
  notes text,
  updated_at timestamptz not null default now()
);

create table if not exists public.weight_logs (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null references public.profiles (telegram_user_id) on delete cascade,
  weight_kg numeric(5, 2) not null check (weight_kg between 20 and 400),
  logged_at timestamptz not null default now(),
  note text
);

create index if not exists weight_logs_user_logged_at
  on public.weight_logs (telegram_user_id, logged_at desc);
