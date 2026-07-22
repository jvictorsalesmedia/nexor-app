# Nexor

Nexor e um app web premium para organizacao, rotina, projetos, tarefas, financeiro, habitos e equipe.

## Deploy Rapido

Este pacote e estatico. A Vercel consegue publicar diretamente a partir de `index.html`.

1. Suba estes arquivos para um repositorio GitHub.
2. Importe o repositorio na Vercel.
3. Defina o diretório raiz como a pasta que contem `index.html`.
4. Publique.

## Supabase

A pasta `supabase/migrations` contem a estrutura inicial de banco com RLS por usuario. Use em um projeto Supabase dedicado ao Nexor.

Com Supabase configurado, os logins deixam de ficar presos ao navegador: o admin cria usuarios no painel **Usuarios / acessos**, cada usuario recebe usuario de acesso, senha, link `/cliente/nome-do-negocio` e uma base zerada pelo `owner_id`.

A aba **Clientes** continua sendo o cadastro de clientes de prestacao de servico dentro da conta logada.

Importante: desde abril de 2026, novos projetos Supabase podem nao expor tabelas publicas automaticamente na Data API. A migration ja inclui `GRANT` para `authenticated` e RLS nas tabelas.

As APIs em `api/admin-client.js` e `api/resolve-client-login.js` rodam no servidor da Vercel. Elas criam usuarios no Supabase Auth, resolvem o usuario de acesso e aplicam bloqueio por assinatura.

## Variaveis

Veja `.env.example`.

## GitHub

Arquivos principais para commitar:

- `index.html`
- `nexor-logo-transparent.png`
- `nexor-mark-transparent.png`
- `package.json`
- `vercel.json`
- `.env.example`
- `api/**`
- `supabase/**`
