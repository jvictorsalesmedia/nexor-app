create extension if not exists pgcrypto;

create schema if not exists nexor_private;

create table if not exists public.nexor_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  gender text not null default 'neutral' check (gender in ('male', 'female', 'neutral')),
  app_role text not null default 'colaborador' check (app_role in ('admin', 'gestor', 'colaborador', 'cliente')),
  status text not null default 'ativo' check (status in ('ativo', 'inativo')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.nexor_profiles
  add column if not exists gender text not null default 'neutral' check (gender in ('male', 'female', 'neutral'));

alter table public.nexor_profiles drop constraint if exists nexor_profiles_app_role_check;
alter table public.nexor_profiles
  add constraint nexor_profiles_app_role_check check (app_role in ('admin', 'gestor', 'colaborador', 'cliente'));

create table if not exists public.nexor_user_password_notes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  password_note text not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.nexor_clients (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  business_name text not null,
  responsible_name text not null,
  document text,
  email text not null,
  whatsapp text,
  access_username text not null unique,
  slug text not null unique,
  monthly_value numeric(12,2) not null default 0,
  subscription_status text not null default 'pendente' check (subscription_status in ('pago', 'pendente', 'atrasado')),
  payment_due_date date,
  last_payment_date date,
  notes text,
  login_blocked boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nexor_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  record_type text not null check (
    record_type in (
      'task',
      'project',
      'client',
      'finance',
      'production',
      'habit',
      'employee',
      'calendar_event',
      'notification',
      'setting'
    )
  ),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nexor_audit_log (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  record_type text,
  record_id uuid,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.nexor_whatsapp_inbox (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete set null,
  phone text,
  message text not null,
  parsed_type text,
  parsed_data jsonb not null default '{}'::jsonb,
  status text not null default 'novo' check (status in ('novo', 'processado', 'erro')),
  created_at timestamptz not null default now()
);

create index if not exists nexor_records_owner_type_idx on public.nexor_records(owner_id, record_type);
create index if not exists nexor_records_data_gin_idx on public.nexor_records using gin(data);
create index if not exists nexor_audit_owner_created_idx on public.nexor_audit_log(owner_id, created_at desc);
create index if not exists nexor_whatsapp_owner_created_idx on public.nexor_whatsapp_inbox(owner_id, created_at desc);
create index if not exists nexor_clients_slug_idx on public.nexor_clients(slug);
create index if not exists nexor_clients_auth_user_idx on public.nexor_clients(auth_user_id);

create or replace function nexor_private.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_nexor_profiles_updated_at on public.nexor_profiles;
create trigger set_nexor_profiles_updated_at
before update on public.nexor_profiles
for each row execute function nexor_private.set_updated_at();

drop trigger if exists set_nexor_user_password_notes_updated_at on public.nexor_user_password_notes;
create trigger set_nexor_user_password_notes_updated_at
before update on public.nexor_user_password_notes
for each row execute function nexor_private.set_updated_at();

drop trigger if exists set_nexor_clients_updated_at on public.nexor_clients;
create trigger set_nexor_clients_updated_at
before update on public.nexor_clients
for each row execute function nexor_private.set_updated_at();

drop trigger if exists set_nexor_records_updated_at on public.nexor_records;
create trigger set_nexor_records_updated_at
before update on public.nexor_records
for each row execute function nexor_private.set_updated_at();

create or replace function nexor_private.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.nexor_profiles (id, email, full_name, gender)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'gender', 'neutral')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_nexor_profile_on_signup on auth.users;
create trigger create_nexor_profile_on_signup
after insert on auth.users
for each row execute function nexor_private.create_profile_for_new_user();

create or replace function nexor_private.is_active_admin(user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.nexor_profiles p
    where p.id = user_id
      and p.app_role = 'admin'
      and p.status = 'ativo'
  );
$$;

create or replace function nexor_private.business_days_late(due_date date, check_date date default current_date)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when due_date is null or check_date <= due_date then 0
    else (
      select count(*)::integer
      from generate_series(due_date + 1, check_date, interval '1 day') day_item
      where extract(isodow from day_item) < 6
    )
  end;
$$;

create or replace function nexor_private.client_access_allowed(user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1
    from public.nexor_clients c
    where c.auth_user_id = user_id
      and (
        c.login_blocked
        or (
          c.subscription_status <> 'pago'
          and nexor_private.business_days_late(c.payment_due_date, current_date) > 1
        )
      )
  );
$$;

create or replace function nexor_private.is_active_user(user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.nexor_profiles p
    where p.id = user_id
      and p.status = 'ativo'
      and (
        p.app_role <> 'cliente'
        or nexor_private.client_access_allowed(user_id)
      )
  );
$$;

alter table public.nexor_profiles enable row level security;
alter table public.nexor_user_password_notes enable row level security;
alter table public.nexor_clients enable row level security;
alter table public.nexor_records enable row level security;
alter table public.nexor_audit_log enable row level security;
alter table public.nexor_whatsapp_inbox enable row level security;

revoke all on schema nexor_private from public;
grant usage on schema nexor_private to authenticated;
grant execute on function nexor_private.is_active_admin(uuid) to authenticated;
grant execute on function nexor_private.is_active_user(uuid) to authenticated;
grant execute on function nexor_private.client_access_allowed(uuid) to authenticated;
grant execute on function nexor_private.business_days_late(date, date) to authenticated;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.nexor_profiles to authenticated;
grant select, insert, update, delete on public.nexor_user_password_notes to authenticated;
grant select, insert, update, delete on public.nexor_clients to authenticated;
grant select, insert, update, delete on public.nexor_records to authenticated;
grant select, insert, update, delete on public.nexor_audit_log to authenticated;
grant select, insert, update, delete on public.nexor_whatsapp_inbox to authenticated;

drop policy if exists "profiles_select_own_or_admin" on public.nexor_profiles;
create policy "profiles_select_own_or_admin"
on public.nexor_profiles
for select
to authenticated
using (
  id = auth.uid()
  or nexor_private.is_active_admin(auth.uid())
);

drop policy if exists "profiles_update_own_or_admin" on public.nexor_profiles;
drop policy if exists "profiles_update_admin_only" on public.nexor_profiles;
create policy "profiles_update_admin_only"
on public.nexor_profiles
for update
to authenticated
using (nexor_private.is_active_admin(auth.uid()))
with check (nexor_private.is_active_admin(auth.uid()));

drop policy if exists "password_notes_admin_only" on public.nexor_user_password_notes;
create policy "password_notes_admin_only"
on public.nexor_user_password_notes
for all
to authenticated
using (nexor_private.is_active_admin(auth.uid()))
with check (nexor_private.is_active_admin(auth.uid()));

drop policy if exists "clients_select_own_or_admin" on public.nexor_clients;
create policy "clients_select_own_or_admin"
on public.nexor_clients
for select
to authenticated
using (
  auth_user_id = auth.uid()
  or nexor_private.is_active_admin(auth.uid())
);

drop policy if exists "clients_admin_write" on public.nexor_clients;
create policy "clients_admin_write"
on public.nexor_clients
for all
to authenticated
using (nexor_private.is_active_admin(auth.uid()))
with check (nexor_private.is_active_admin(auth.uid()));

drop policy if exists "records_owner_crud" on public.nexor_records;
create policy "records_owner_crud"
on public.nexor_records
for all
to authenticated
using (owner_id = auth.uid() and nexor_private.is_active_user(auth.uid()))
with check (owner_id = auth.uid() and nexor_private.is_active_user(auth.uid()));

drop policy if exists "audit_owner_read_insert" on public.nexor_audit_log;
create policy "audit_owner_read_insert"
on public.nexor_audit_log
for all
to authenticated
using (owner_id = auth.uid() and nexor_private.is_active_user(auth.uid()))
with check (owner_id = auth.uid() and nexor_private.is_active_user(auth.uid()));

drop policy if exists "whatsapp_owner_read" on public.nexor_whatsapp_inbox;
create policy "whatsapp_owner_read"
on public.nexor_whatsapp_inbox
for select
to authenticated
using (owner_id = auth.uid() and nexor_private.is_active_user(auth.uid()));

drop policy if exists "whatsapp_owner_update" on public.nexor_whatsapp_inbox;
create policy "whatsapp_owner_update"
on public.nexor_whatsapp_inbox
for update
to authenticated
using (owner_id = auth.uid() and nexor_private.is_active_user(auth.uid()))
with check (owner_id = auth.uid() and nexor_private.is_active_user(auth.uid()));

comment on table public.nexor_records is 'Flexible per-user Nexor records. Each login owns its own data through owner_id and RLS.';
comment on table public.nexor_whatsapp_inbox is 'Incoming WhatsApp messages to be parsed into Nexor records by an Edge Function.';
comment on table public.nexor_user_password_notes is 'Admin-only notes for initial passwords defined inside Nexor. Do not use as a general password store.';
comment on table public.nexor_clients is 'Nexor customer accounts. Each client has a login, subscription status, individual slug and isolated workspace records.';

-- After creating the first Supabase Auth user for jvgsales72@gmail.com, run:
-- update public.nexor_profiles set app_role = 'admin' where email = 'jvgsales72@gmail.com';
