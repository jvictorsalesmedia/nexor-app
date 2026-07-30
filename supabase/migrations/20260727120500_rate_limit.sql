-- Rate limit generico reusavel por qualquer endpoint publico (bucket +
-- identificador). Usado inicialmente por api/forgot-password.js (evitar que
-- qualquer um derrube a senha de uma conta sem limite) e
-- api/resolve-client-login.js (evitar varredura de usuarios validos).
create table if not exists public.nexor_rate_limits (
  id bigint generated always as identity primary key,
  bucket text not null,
  identifier text not null,
  attempts int not null default 1,
  window_start timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket, identifier)
);

alter table public.nexor_rate_limits enable row level security;
-- Sem policy publica: so o service_role (que ja ignora RLS) grava/le aqui,
-- os endpoints publicos usam a chave de servico pra chamar a funcao abaixo.

-- UPSERT atomico (uma unica instrucao, sem race condition de ler-e-depois-
-- escrever): incrementa attempts dentro da janela, ou reseta pra 1 se a
-- janela ja expirou. Retorna se a tentativa atual e permitida e, se nao for,
-- quantos segundos faltam pra janela liberar de novo.
create or replace function public.nexor_check_rate_limit(
  p_bucket text,
  p_identifier text,
  p_max int,
  p_window_seconds int
)
returns table (allowed boolean, retry_after_seconds int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts int;
  v_window_start timestamptz;
begin
  insert into public.nexor_rate_limits (bucket, identifier, attempts, window_start, updated_at)
  values (p_bucket, p_identifier, 1, now(), now())
  on conflict (bucket, identifier) do update
    set attempts = case
          when nexor_rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
            then 1
          else nexor_rate_limits.attempts + 1
        end,
        window_start = case
          when nexor_rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
            then now()
          else nexor_rate_limits.window_start
        end,
        updated_at = now()
  returning nexor_rate_limits.attempts, nexor_rate_limits.window_start
    into v_attempts, v_window_start;

  if v_attempts > p_max then
    return query select
      false,
      greatest(0, p_window_seconds - extract(epoch from (now() - v_window_start))::int);
  else
    return query select true, 0;
  end if;
end;
$$;

revoke all on function public.nexor_check_rate_limit(text, text, int, int) from public;
grant execute on function public.nexor_check_rate_limit(text, text, int, int) to service_role;
