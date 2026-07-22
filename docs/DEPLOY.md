# Deploy do Nexor

## Estado deste pacote

Este diretorio ja esta pronto para deploy estatico:

- `index.html` e a entrada publica do site.
- `api/config.js` entrega para o frontend apenas a URL e a chave publica do Supabase.
- `api/admin-client.js` cria, edita, bloqueia/libera e exclui usuarios de acesso usando Supabase Auth Admin no servidor.
- `api/resolve-client-login.js` resolve `/cliente/slug` + usuario de acesso para login no Supabase Auth.
- `vercel.json` define configuracao basica para Vercel.
- `supabase/migrations/20260618100000_nexor_core.sql` cria o banco inicial com RLS.
- `supabase/functions/whatsapp-webhook` prepara o webhook de WhatsApp.

## GitHub

Nesta sessao, o conector GitHub nao tem nenhuma conta/repo instalado e o computador nao tem `git`/`gh` no PATH.

Para publicar:

1. Crie um repositorio chamado `nexor`.
2. Suba todos os arquivos desta pasta `outputs`.
3. Use `main` como branch padrao.

## Vercel

Nesta sessao, a CLI `vercel` nao esta no PATH e nao apareceu conector de deploy direto.

Para publicar:

1. Entre na Vercel.
2. Clique em **Add New > Project**.
3. Importe o repositorio GitHub `nexor`.
4. Framework: **Other**.
5. Build command: vazio.
6. Output directory: vazio.
7. Deploy.

Variaveis para cadastrar na Vercel:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` ou `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

`SUPABASE_SERVICE_ROLE_KEY` deve ficar apenas como variavel privada da Vercel para as rotas em `api/`. Nunca use prefixo publico como `NEXT_PUBLIC_` ou `VITE_` nessa chave.

## Supabase

Projeto encontrado na conta: `Artes-Lion-Manager` (`hhzhrwauixyzvblzqrrt`).

Recomendado: criar um projeto novo chamado `Nexor`, para nao misturar dados com outro sistema.

Depois de escolher o projeto:

1. Rode a migration `supabase/migrations/20260618100000_nexor_core.sql`.
2. Crie o usuario `jvgsales72@gmail.com` no Supabase Auth.
3. Promova esse usuario a admin:

```sql
update public.nexor_profiles
set app_role = 'admin'
where email = 'jvgsales72@gmail.com';
```

4. Cadastre `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` na Vercel.
5. Deploy da Edge Function `whatsapp-webhook`, se for usar WhatsApp.

Depois disso, qualquer usuario criado pelo painel **Usuarios / acessos** fica disponivel em qualquer dispositivo pelo link `/cliente/slug-do-negocio`.

## Observacoes de seguranca

- Nao coloque `service_role` no frontend.
- Use apenas a anon/publishable key no navegador.
- As tabelas publicas estao com RLS ativado.
- As policies isolam os dados por `auth.uid()`.
- Usuarios inativos ficam bloqueados no app e nas policies dos registros.
- Clientes com login bloqueado ou mensalidade com atraso maior que 1 dia util perdem acesso aos registros pela RLS.
- A tabela `nexor_user_password_notes` existe para o admin visualizar a senha inicial definida no Nexor. Em producao rigorosa, prefira redefinicao de senha em vez de guardar senha visivel.
