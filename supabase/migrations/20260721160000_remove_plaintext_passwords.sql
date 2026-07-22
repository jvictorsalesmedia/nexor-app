-- Fecha o buraco de senha em texto puro: criação/edição de cliente e de
-- usuário de equipe passaram a usar convite/recuperação de senha por email
-- (api/admin-client.js), então a tabela nexor_user_password_notes não é mais
-- escrita. Isso purga o que já existia lá — os hashes de senha no próprio
-- Supabase Auth continuam intactos, essa tabela era só uma cópia de
-- conveniência em texto puro para o admin ver depois.
delete from public.nexor_user_password_notes;

-- O formulário público de pré-cadastro ("Solicitar acesso") não pede mais
-- senha (api/signup-request.js) — a pessoa aprovada recebe convite por email
-- como qualquer outro cliente criado manualmente.
alter table public.nexor_signup_requests alter column password_note drop not null;
update public.nexor_signup_requests set password_note = null;
