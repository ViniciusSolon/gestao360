# Gestão 360° — MVP (CRM)

MVP do escopo "Plataforma de Gestão 360°": **leads, funil Kanban, atividades, indicadores e propostas simples em PDF**,
como SaaS multi-empresa com assinatura e **painel interno para controlar os clientes**.

* Decisões de linguagem e arquitetura: [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md)
* Auditoria (race conditions, idempotência, segurança, testes, refatoração): [`AUDITORIA.md`](AUDITORIA.md)
* Relatório de segurança em PDF: `docs/security-audit/relatorio-auditoria-seguranca.pdf`

## O que tem no MVP

| Área | Funcionalidades |
|---|---|
| Conta | Cadastro da empresa (trial 14 dias), login, convites com papéis (owner/admin/gerente/vendedor), limite de usuários por plano |
| CRM | Leads com pontuação/MQL calculados no servidor, funil Kanban com etapas personalizáveis (arrastar e soltar), histórico, motivo de perda |
| Atividades | Agenda de tarefas/ligações/reuniões (link de videochamada https), conclusão, atrasadas |
| Catálogo | Produtos com NCM, tributo estimado, foto (https), ativo/inativo |
| Propostas | Itens do catálogo, desconto limitado por papel, frete, condições, numeração sequencial, envio/aceite/recusa, **PDF** |
| Indicadores | Leads, MQLs, ganhos, valor vendido, ticket médio, conversão, ciclo de vendas, previsão, receita por vendedor e canal, oportunidades paradas — cada número mostra sua origem |
| Assinatura | Planos Starter/Pro/Business, checkout (Stripe ou gateway fake em dev), webhook assinado e idempotente |
| Plataforma (`/admin`) | MRR, clientes por status, busca, detalhe, suspender/reativar, trocar plano, estender trial, auditoria |

Fora do MVP (roadmap do PDF): WhatsApp, e-mail marketing, VoIP, IA generativa, ERP (pedidos, estoque, financeiro, PCP, MRP, RH).

## Rodar localmente (sem Docker)

Pré-requisitos: Node 22 e PostgreSQL 16 (dois clusters: um para dev e **outro só para testes**).

```bash
npm install
```

```bash
psql "postgres://postgres@127.0.0.1:5433/postgres" -v db=gestao360 -v owner_pw="$(openssl rand -hex 16)" -v app_pw="$(openssl rand -hex 16)" -v platform_pw="$(openssl rand -hex 16)" -f scripts/db-bootstrap.sql
```

Copie `apps/api/.env.example` para `apps/api/.env` e preencha as senhas usadas acima, um `BILLING_WEBHOOK_SECRET` (`openssl rand -hex 24`) e a `PLATFORM_MFA_KEY` (`openssl rand -hex 32`).

```bash
npm run db:migrate
```

```bash
PLATFORM_ADMIN_PASSWORD='uma-senha-longa-aqui' npm -w apps/api run platform:create-admin -- voce@empresa.com "Seu Nome" superadmin
```

O comando imprime **uma única vez** o link `otpauth://` (cadastre no Google Authenticator, Authy ou 1Password) e 8 códigos de recuperação. O login do painel exige senha **e** código. Rodar o comando de novo para o mesmo e-mail troca senha, segredo e códigos e derruba as sessões abertas.

```bash
npm run dev:api
```

```bash
npm run dev:web
```

App dos clientes: http://localhost:5173 · Painel da plataforma: http://localhost:5173/admin

### Variáveis de segurança

| Variável | Para quê | Valor seguro |
|---|---|---|
| `NODE_ENV` | Padrão `production` (falha segura) | `development` só na sua máquina |
| `API_SURFACE` | `tenant` (padrão), `platform` ou `all` | Produção: processos separados; `all` só em dev |
| `DATABASE_PLATFORM_URL` | Credencial BYPASSRLS | Só no painel e no worker, **nunca** na API pública |
| `PLATFORM_MFA_KEY` | Cifra os segredos TOTP | 64 hex, guardada em cofre |
| `TRUST_PROXY` | Quantos proxies há na frente (para ler o IP real) | `false` sem proxy; `1` atrás do nginx; nunca `true` |
| `AUTH_RATE_LIMIT_PER_MIN` / `AUTH_EMAIL_LIMIT_PER_15MIN` | Tentativas de login por IP e por e-mail (no Postgres) | 10 / 20 |
| `ENABLE_FAKE_CHECKOUT` | Botão "Simular pagamento" | Só `true` em development com gateway fake |

## Rodar com Docker

```bash
cp .env.example .env   # e preencha
docker compose up --build
```

## Testes

Os testes de integração chamam as rotas de verdade contra um Postgres de teste real (só gateway e e-mail são simulados).
Eles exigem um cluster **dedicado** (o setup recusa um cluster que tenha o banco de dev):

```bash
docker compose --profile test up -d postgres-test
```

Comando único para rodar tudo (use depois de toda alteração feita por IA):

```bash
npm run typecheck && npm test
```

## Estrutura

```
apps/api/src
  app.ts              Fastify, CSRF por Origin, tratamento de erros
  config.ts           validação de ambiente (recusa segredos fracos)
  db/                 pools por papel (app com RLS / plataforma), migrations SQL
  auth/               sessão, guards de papel
  lib/                preço, limites atômicos, idempotência, crypto, escape HTML
  modules/            auth, users, pipeline, leads, activities, products,
                      proposals, dashboard, billing, webhooks, platform
  billing/            gateway (Stripe/Fake), sincronização de assinatura
  jobs/               fila Postgres (SKIP LOCKED) e worker
apps/api/test         testes de integração por fluxo
apps/web/src          React: pages/ (app do cliente) e admin/ (painel interno)
```
