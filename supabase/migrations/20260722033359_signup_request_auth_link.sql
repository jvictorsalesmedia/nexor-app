-- Liga cada pré-cadastro ao usuário Auth criado já no momento da submissão
-- (a senha escolhida pela pessoa vai direto para o Supabase Auth, nunca é
-- guardada em texto puro por nós). A aprovação passa a ativar essa conta já
-- existente em vez de criar uma nova via convite por email.
alter table public.nexor_signup_requests
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;
