-- A Edge Function nexor-admin-user ainda estava gravando a senha em texto
-- puro em nexor_user_password_notes (savePasswordNote), apesar da migration
-- de 21/07 ja ter dito que essa gravacao tinha sido retirada. Confirmado que
-- o app nunca le essa tabela para contas na nuvem (revealUserPassword() so
-- usa o campo local plainPassword, que nunca e populado a partir dela) --
-- ou seja, e seguro parar de gravar e limpar de novo sem perder nenhuma
-- funcionalidade.
delete from public.nexor_user_password_notes;
