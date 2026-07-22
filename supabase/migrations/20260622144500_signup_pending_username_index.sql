create unique index if not exists nexor_signup_requests_pending_username_idx
  on public.nexor_signup_requests (lower(access_username))
  where status = 'pendente' and access_username is not null and access_username <> '';
