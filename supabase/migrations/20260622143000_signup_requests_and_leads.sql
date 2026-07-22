alter table public.nexor_records drop constraint if exists nexor_records_record_type_check;
alter table public.nexor_records
  add constraint nexor_records_record_type_check check (
    record_type in (
      'task',
      'project',
      'client',
      'lead',
      'finance',
      'production',
      'habit',
      'employee',
      'calendar_event',
      'notification',
      'setting'
    )
  );

create table if not exists public.nexor_signup_requests (
  id uuid primary key default gen_random_uuid(),
  business_name text,
  responsible_name text,
  document text,
  email text not null,
  whatsapp text,
  access_username text,
  password_note text not null,
  responsible_photo_data_url text not null,
  status text not null default 'pendente' check (status in ('pendente', 'aprovado', 'reprovado')),
  decision_note text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_client_id uuid references public.nexor_clients(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists nexor_signup_requests_pending_email_idx
  on public.nexor_signup_requests (lower(email))
  where status = 'pendente';

create index if not exists nexor_signup_requests_status_created_idx
  on public.nexor_signup_requests (status, created_at desc);

drop trigger if exists set_nexor_signup_requests_updated_at on public.nexor_signup_requests;
create trigger set_nexor_signup_requests_updated_at
before update on public.nexor_signup_requests
for each row execute function nexor_private.set_updated_at();

alter table public.nexor_signup_requests enable row level security;

grant select, insert, update, delete on public.nexor_signup_requests to service_role;
grant select, update on public.nexor_signup_requests to authenticated;

drop policy if exists "signup_requests_admin_read" on public.nexor_signup_requests;
create policy "signup_requests_admin_read"
on public.nexor_signup_requests
for select
to authenticated
using (nexor_private.is_active_admin(auth.uid()));

drop policy if exists "signup_requests_admin_update" on public.nexor_signup_requests;
create policy "signup_requests_admin_update"
on public.nexor_signup_requests
for update
to authenticated
using (nexor_private.is_active_admin(auth.uid()))
with check (nexor_private.is_active_admin(auth.uid()));

comment on table public.nexor_signup_requests is 'Pending Nexor self-registration requests. Public submissions are accepted only through the server API; admin users approve or reject them.';
