# AUDITORIA — Gestão 360° (MVP)

Data: 23/11/2026 · Escopo: todo o repositório (`apps/api`, `apps/web`, migrations, Docker/CI).
Stack detectada: TypeScript · Node 22 + Fastify 5 · PostgreSQL 16 com RLS (SQL via `pg`, sem ORM) · sessão em cookie httpOnly (token opaco, hash no banco) · React 18 + Vite · Docker Compose + GitHub Actions.

Os achados abaixo foram **verificados no código** e, quando indicado, **reproduzidos** contra o servidor de desenvolvimento.
Nenhuma correção foi aplicada depois da auditoria: os planos aguardam o seu OK (regra dos prompts).

## Status das correções

Todos os achados de segurança acionáveis foram corrigidos. Suíte: **124 testes passando** (`npm run typecheck && npm test`). Pendentes fora de segurança: RC-01 (posição de etapa, migration `docs/propostas-migrations/003`), RC-02 (chave de idempotência presa) e ID-02 (plano manual × gateway — decisão de negócio).

| Achado | Status | Mudança | Prova |
|---|---|---|---|
| SEC-08 rate limit × X-Forwarded-For | ✅ corrigido | `trustProxy` agora vem de `TRUST_PROXY` (padrão `false`; número de proxies ou lista de IPs; `true` é recusado no startup) — `apps/api/src/config.ts`, `apps/api/src/app.ts`; compose com `TRUST_PROXY: "1"` | `apps/api/test/security.spec.ts` (6 testes; 4 falham com o código antigo); servidor de dev: 12 tentativas com IP forjado → 429 na 11ª |
| SEC-04 + SEC-05 checkout simulado liberado pelos defaults | ✅ corrigido | Rota só registra com `ENABLE_FAKE_CHECKOUT=true` + `NODE_ENV=development` (`apps/api/src/modules/webhooks.ts`); `NODE_ENV` agora tem padrão `production`; gateway fake só aceito em development/test e a flag só com development+fake (`apps/api/src/config.ts`); compose exige `NODE_ENV`/`BILLING_PROVIDER` explícitos e a flag é `false` por padrão | `apps/api/test/security.spec.ts` (+4 testes; o de 404 falha com a condição antiga); servidor sem `.env` recusa subir; teste de fumaça no navegador ok |
| SEC-02 credencial BYPASSRLS no processo público | ✅ corrigido | Migration `apps/api/src/db/migrations/005_webhook_definer.sql` (função `record_billing_webhook`, SECURITY DEFINER, EXECUTE só para `g360_app`); webhook usa essa função com o papel da API (`modules/webhooks.ts`); `DATABASE_PLATFORM_URL` opcional e exigida só com `API_SURFACE=platform|all`, `WORKER_INLINE` ou no worker; padrão `API_SURFACE=tenant` (`config.ts`, `db/db.ts`, `worker.ts`); compose entrega a credencial só a `api-platform` e `worker` | `apps/api/test/security.spec.ts` (+8 testes: API sem a credencial processa webhook, duplicado e simultâneo; g360_app não grava direto; config); 3 falham com o código antigo; migration aplicada no banco de dev |
| SEC-09 painel sem MFA | ✅ corrigido | Migration `008_platform_mfa.sql`; TOTP RFC 6238 com cripto nativa (`lib/totp.ts`), segredo cifrado AES-256-GCM (`PLATFORM_MFA_KEY`), login em 2 etapas com desafio de uso único (5 min/5 tentativas), anti-replay atômico, 8 códigos de recuperação de uso único (`modules/platform.ts`, `lib/platform-admin.ts`, `scripts/create-platform-admin.ts`, `apps/web/src/admin/AdminLayout.tsx`) | `test/security-fixes.spec.ts` (vetores oficiais do RFC, replay, 5 tentativas, recuperação, desafio simultâneo → 1 sessão, admin sem MFA bloqueado) |
| SEC-01 vendedor×vendedor só no código | ✅ corrigido | Migration de policy separada `009_rls_seller_leads.sql` (RESTRICTIVE); `Db.withAuth` fixa empresa, usuário e papel em toda rota autenticada | Testes direto no banco: vendedor só vê os próprios + sem dono; não grava lead de outro; sem papel = vendedor |
| SEC-03 contadores graváveis pela API | ✅ corrigido | Migration `007_plan_counters_definer.sql` (funções no tenant da transação; GRANT revogado); `lib/limits.ts` | `UPDATE tenants SET seats_used=0` como g360_app → permission denied; testes de concorrência de vagas/leads continuam verdes |
| SEC-10 rate limit em memória | ✅ corrigido | Migration `006_auth_throttle.sql` (UPSERT atômico, chave só como hash); limite por IP **e por e-mail** (`AUTH_EMAIL_LIMIT_PER_15MIN`); `@fastify/rate-limit` removido (`lib/throttle.ts`) | Troca de IP mirando o mesmo e-mail → 429; 2 réplicas compartilham o limite; 10 tentativas simultâneas com limite 4 → exatamente 4 passam |
| SEC-11 erro expõe constraint | ✅ corrigido (parcial) | Códigos genéricos (`duplicate`, `invalid_reference`…) em `lib/errors.ts` | Teste sem `users_`/`_uq` no corpo. **Residual:** o cadastro ainda responde 409 para e-mail existente; eliminar a enumeração exige verificação de e-mail no cadastro (mudança de produto) |
| SEC-12 cookies sem prefixo / sem limpeza | ✅ corrigido | `__Host-g360_sid` e `__Secure-g360_admin_sid` com HTTPS (`auth/guards.ts`); limpeza horária no worker (`purgeExpired` em `jobs/runner.ts`) | Cookie sem prefixo não autentica em modo seguro; limpeza remove só o vencido |
| SEC-06 / SEC-07 | ℹ️ sem ação | Informativos (segredo sintético de teste; CSP já aplicada no nginx) | — |

## Os 5 achados de maior risco

| # | Achado | Risco | Arquivo:linha | Evidência |
|---|---|---|---|---|
| 1 | ✅ **CORRIGIDO (SEC-08)** — **Rate limit de login contornável** com `X-Forwarded-For` falso (`trustProxy: true` confia em qualquer cabeçalho). Permite força bruta em senhas de clientes e do painel interno; o IP gravado na auditoria também é forjável | **Alto** | `apps/api/src/app.ts:25` | Reproduzido: 12 tentativas do mesmo IP → 429 na 11ª; variando o cabeçalho → 12×401, nunca 429 |
| 2 | ✅ **CORRIGIDO (SEC-04/05)** — **Checkout "fake" liberado fora de dev**: a rota `/api/webhooks/dev/fake-checkout/:id/complete` (sem autenticação) ativa plano pago sem pagamento sempre que `NODE_ENV=development` + `BILLING_PROVIDER=fake` — e esses são os **defaults do docker-compose**. A validação de startup só bloqueia o fake quando `NODE_ENV=production` | **Alto** (condicional ao deploy) | `apps/api/src/modules/webhooks.ts:57-58`, `docker-compose.yml:40,44`, `apps/api/src/config.ts:51` | Fluxo exercitado no teste de fumaça: owner clica "Simular pagamento" e vira `active` no plano Pro |
| 3 | ✅ **CORRIGIDO (SEC-02)** — **Processo da API dos clientes carrega a credencial BYPASSRLS** (`DATABASE_PLATFORM_URL`) quando `API_SURFACE=all`, que é o **default**. Um RCE/SQLi na API pública daria acesso a todos os tenants | Médio | `apps/api/src/config.ts:27`, `apps/api/src/app.ts:67-87`, `apps/api/src/modules/webhooks.ts:40` | Código; o compose já separa `api`/`api-platform`, mas a API de tenant ainda precisa da credencial por causa do webhook |
| 4 | ✅ **CORRIGIDO (SEC-01)** — **Visibilidade vendedor × vendedor só existe no código**: o RLS isola empresas, não usuários. Uma rota nova que esqueça `leadScope` expõe todos os leads da empresa a vendedores | Médio | `apps/api/src/modules/leads.ts:37-51`, `apps/api/src/db/migrations/002_rls_and_grants.sql:43-46` | Código; proposta em `apps/api/src/db/migrations/009_rls_seller_leads.sql` |
| 5 | ✅ **CORRIGIDO (SEC-09)** — **Painel da plataforma sem MFA** (login só com senha; com o achado 1, a força bruta não é limitada) | Médio | `apps/api/src/modules/platform.ts:40-52` | Código |

---

## Etapa 1 — Testes de integração

| Pergunta | Resposta |
|---|---|
| Ferramenta configurada? | Sim: Vitest (`apps/api/vitest.config.ts`), testes em `apps/api/test/*.spec.ts` |
| Banco de teste separado? | Sim: `gestao360_test` em cluster Postgres **dedicado** (porta 5434 / serviço `postgres-test`). O setup exige nome `*_test`, host local e **recusa** clusters que tenham o banco de dev (`apps/api/test/global-setup.ts:16-36`) |
| Comando único | `npm run typecheck && npm test` |
| Resultado | **85 passando, 0 falhando** (6 arquivos) — rodado em banco local de teste, sem tocar produção |

| Fluxo crítico | Teste batendo na rota real | Só unitário com mock | Sem teste |
|---|---|---|---|
| Cadastro | ✅ `auth.spec.ts` (feliz, inválido, e-mail duplicado, cadastro simultâneo, CSRF) | | |
| Login / logout / sessão | ✅ `auth.spec.ts` | | |
| Convites e limite de usuários | ✅ `auth.spec.ts` (aceite duplo simultâneo, plano cheio) | | |
| Leads / Kanban / atividades | ✅ `crm.spec.ts` | | |
| Propostas (dinheiro) | ✅ `crm.spec.ts` (preço do servidor, desconto por papel, idempotência, concorrência, numeração) | | |
| Checkout de assinatura | ✅ `billing.spec.ts` (gateway simulado) | | |
| Webhooks de pagamento | ✅ `billing.spec.ts` (assinatura, duplicado, simultâneo, fora de ordem) | | |
| Acesso indevido A × B | ✅ `isolation.spec.ts` (rotas + RLS direto no banco) | | |
| Painel da plataforma | ✅ `platform.spec.ts` | | |
| Regras de preço, assinatura HMAC, config | | ✅ `unit.spec.ts` (funções puras, sem mock de banco) | |
| Rota dev de checkout fake | | | ❌ (achado 2) |
| Rate limit por IP real | | | ❌ (achado 1 — testes rodam com limite alto) |
| Adapter Stripe real | | | ❌ não verificado (sem acesso à API da Stripe) |

Frases describe/it para sua validação: [`docs/TESTES.md`](docs/TESTES.md).

---

## Etapa 2 — Confiança no cliente

### 2.1 Regras de negócio no front

| Achado | Risco | Arquivo:linha | Situação / correção |
|---|---|---|---|
| Prévia do total da proposta calculada no navegador | Baixo | `apps/web/src/pages/Proposals.tsx:43-52` | Só exibição, rotulada "o valor final é calculado pelo servidor". O servidor ignora `unitPriceCents`/`totalCents` enviados (teste "preço e tributo vêm do cadastro") |
| Botões escondidos por papel (`can()`), ex.: Equipe, editar produto, assinar plano, ações do painel | Baixo | `apps/web/src/lib/api.ts:108`, `pages/Layout.tsx:23`, `pages/Products.tsx:25`, `pages/Billing.tsx:35`, `admin/AdminTenant.tsx:35` | Só UX. Cada gate tem verificação equivalente no servidor (`guard(deps,'admin'|'manager')`, `sessionOnly(deps,'owner')`, `requireSuperadmin`) e teste 403 |
| Desconto máximo por papel, limite de usuários/leads, pontuação/MQL, status da conta | — | `apps/api/src/lib/pricing.ts`, `lib/limits.ts`, `auth/guards.ts` | Já só no servidor ✅ |

### 2.2 Segredos

| Item | Classificação | Onde | Situação |
|---|---|---|---|
| Variáveis `VITE_*`/`import.meta.env` no front | — | `apps/web/src` | Nenhuma. Bundle (`apps/web/dist`) sem `sk_`, `whsec_`, URLs de banco ✅ |
| `BILLING_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, senhas dos papéis do banco | Secretas | só servidor (`apps/api/.env`, ignorado pelo git) | Sem default no código; compose usa `${VAR:?}`; startup recusa ausentes/fracos ✅ |
| `WEBHOOK_SECRET` de teste fixo | Secreta de teste (sem valor real) | `apps/api/test/helpers.ts:12` | Informativo |
| Defaults `NODE_ENV=development` e `BILLING_PROVIDER=fake` no compose | Não são segredos, mas viram falha | `docker-compose.yml:40,44` | Ver achado 2 |
| Histórico git | — | — | **Não verificado**: repositório sem nenhum commit ainda |
| Precisa rotacionar? | — | — | Nenhuma chave foi publicada. As senhas de dev em `apps/api/.env` nunca saíram da máquina |

### 2.3 Banco exposto (equivalente a Supabase: Postgres com RLS)

Mecanismo: a API conecta como `g360_app` (NOBYPASSRLS) e fixa o tenant por transação (`set_config('app.tenant_id', …, true)` em `apps/api/src/db/db.ts:24`). O equivalente a `auth.uid()` aqui é `app_current_tenant()`. O equivalente à `service_role` é `g360_platform` (BYPASSRLS), **nunca** usado no navegador (o front só fala com `/api`).

| Tabela | RLS | Policy | Em português |
|---|---|---|---|
| `tenants` | ligado | `tenant_isolation` (`id = app_current_tenant()`) | A API só lê a própria empresa; pode inserir só a empresa do contexto (cadastro); só altera `name`, `seats_used`, `leads_count` (GRANT por coluna). Status, plano e trial **só pela plataforma** |
| `users`, `sessions`, `invites`, `pipeline_stages`, `leads`, `lead_events`, `activities`, `products`, `tenant_counters`, `proposals`, `proposal_items`, `idempotency_keys`, `billing_operations`, `subscriptions`, `jobs`, `audit_log` | ligado | `tenant_isolation` (`tenant_id = app_current_tenant()` no USING e no WITH CHECK) | Ler, inserir, alterar e apagar só linhas da própria empresa; inserir linha com `tenant_id` de outra empresa é bloqueado. O que cada operação permite é limitado por GRANT: valores de proposta não têm UPDATE; `subscriptions` só leitura; `jobs` só INSERT; `users.role` muda só via API |
| `webhook_events`, `platform_admins`, `platform_sessions` | ligado | **nenhuma** + nenhum GRANT para `g360_app` | A API dos clientes não consegue nem ler (teste "permission denied") |
| `plans` | desligado | — | Catálogo público, `g360_app` só tem SELECT. Aceitável |
| `schema_migrations` | desligado | — | Sem GRANT para app/plataforma. Aceitável |

| Achado | Risco | Arquivo:linha | Correção proposta |
|---|---|---|---|
| Nenhuma policy `USING (true)` / `WITH CHECK (true)` | — | `002_rls_and_grants.sql` | ✅ |
| Policies não comparam usuário, só empresa (achado 4) | Médio | `002_rls_and_grants.sql:43-46` | Policy RESTRICTIVE por dono do lead (`apps/api/src/db/migrations/009_rls_seller_leads.sql`) |
| `g360_app` pode dar UPDATE em `seats_used`/`leads_count` | Baixo | `002_rls_and_grants.sql:61` | Mover para função `SECURITY DEFINER consume_seat()`/`consume_lead()` e revogar o GRANT de coluna |
| Credencial BYPASSRLS no processo público (achado 3) | Médio | `config.ts:27` | Default `API_SURFACE=tenant`; webhook passar a usar função `SECURITY DEFINER record_webhook_event()` em vez do pool da plataforma |

---

## Etapa 3 — Race conditions (todo "ler, decidir, gravar")

| # | Operação | Arquivo:linha | Se 2 requisições iguais chegarem juntas… | Proteção no banco | Teste simultâneo |
|---|---|---|---|---|---|
| 1 | Cadastro (e-mail/slug) | `modules/auth.ts:66-68` | Duas empresas com o mesmo dono | `users_email_uq`, `tenants.slug UNIQUE` (a) | ✅ |
| 2 | Convite pendente | `modules/users.ts:88` | Dois convites para o mesmo e-mail | `invites_pending_uq` parcial (a) | ✅ |
| 3 | Aceite de convite | `modules/auth.ts:135-141` | Dois usuários, vaga consumida 2× | `UPDATE … WHERE accepted_at IS NULL` + linhas afetadas (b) | ✅ |
| 4 | Vaga do plano (usuários) | `lib/limits.ts:8-16` | Passar do limite do plano | `UPDATE … WHERE seats_used < max_users` (b) | ✅ |
| 5 | Desativar/reativar usuário | `modules/users.ts:39-52` | Vaga devolvida 2× | `SELECT … FOR UPDATE` (c) | ✅ |
| 6 | Cota de leads | `lib/limits.ts:23-31` | Passar do limite de leads | `UPDATE … WHERE leads_count < max_leads` (b) | ✅ |
| 7 | Apagar lead | `modules/leads.ts:179` | Cota devolvida 2× | `DELETE … RETURNING` + linhas afetadas (b) | ✅ |
| 8 | Mover/editar lead | `modules/leads.ts:128,156` | Última gravação apaga a anterior / histórico inconsistente | `FOR UPDATE` (c) | — (serializado, sem efeito duplicado) |
| 9 | Concluir atividade | `modules/activities.ts:119` | Evento duplicado no histórico | `UPDATE … WHERE done_at IS NULL` (b) | ✅ |
| 10 | Número da proposta | `lib/limits.ts:39-46` | Duas propostas com o mesmo número | UPSERT atômico + `UNIQUE (tenant_id, number)` (a+b) | ✅ (8 simultâneas) |
| 11 | Criar proposta (clique duplo) | `lib/idempotency.ts:50` | Proposta duplicada | PK `(tenant_id, key)` na mesma transação (a) | ✅ |
| 12 | Aceitar proposta | `modules/proposals.ts:178` | Aceite 2×, lead ganho 2× | `UPDATE … WHERE status = 'sent'` (b) + `proposals_one_accepted_per_lead_uq` (a) | ✅ |
| 13 | Operação de checkout | `modules/billing.ts:50` | Duas chaves de idempotência para o gateway | `billing_operations_pending_uq` parcial (a) | ✅ |
| 14 | Webhook | `modules/webhooks.ts:42` | Evento processado 2× | PK `(provider, event_id)` (a) | ✅ |
| 15 | Sincronizar assinatura | `billing/sync.ts:34` | Estados intercalados | `FOR UPDATE` no tenant (c) | ✅ |
| 16 | Fila de jobs | `jobs/runner.ts:20-31` | Dois workers no mesmo job | `FOR UPDATE SKIP LOCKED` (c) | — |
| 17 | E-mail transacional | `jobs/queue.ts:14-18` | E-mail enviado 2× | `jobs.dedupe_key UNIQUE` (a) | ✅ |
| **RC-01** | **Criar etapa do funil** | `modules/pipeline.ts:32` | **Duas etapas na mesma posição** (reproduzido: 7,7,8,8,8) | **Nenhuma** | ❌ |
| **RC-02** | **Chave de idempotência "em processamento"** | `lib/idempotency.ts:75-113` | Se o processo morrer entre gravar a chave e a resposta, a chave fica presa e toda nova tentativa recebe 409 para sempre | Nenhuma expiração | ❌ |

Proteções fora do banco: o **rate limit** (`app.ts:34`, `@fastify/rate-limit`) usa memória local por instância — com N réplicas o limite vira N× e cai a cada deploy. Não protege recurso de negócio, então o banco não precisa substituí-lo, mas para valer em produção deve ficar no proxy/WAF ou numa tabela de tentativas. Não há lock em memória, Redis nem cache em nenhuma regra de negócio.

**Plano de correção (aguardando OK):**
* RC-01 → migration `docs/propostas-migrations/003_stage_position_unique.sql` (UNIQUE deferrable) + `SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE` antes do `max()`. **Já existem duplicados no banco de dev** (tenant `1a67ac27-…`, posições 7 e 8): a limpeza proposta renumera sem apagar nada e está no mesmo arquivo — não foi executada. Teste: 6 criações simultâneas → posições 0..n sem repetição.
* RC-02 → coluna `locked_until` (ou usar `created_at`): chave sem resposta há mais de 2 min pode ser retomada (`UPDATE … WHERE status_code IS NULL AND created_at < now() - interval '2 minutes' RETURNING`). Teste: chave "presa" é retomada e o gateway recebe a mesma chave da operação.
* UX: todos os botões de envio já ficam desabilitados durante a requisição (`useSubmit` em `apps/web/src/lib/api.ts:60-87`), tratado só como conforto.

---

## Etapa 4 — Idempotência

| Achado | Risco | Arquivo:linha | Situação / correção |
|---|---|---|---|
| Assinatura do webhook verificada com o **corpo bruto** antes de qualquer processamento | — | `modules/webhooks.ts:20,26-29` | ✅ HMAC-SHA256 com tolerância de 5 min e comparação em tempo constante (`billing/gateway.ts:40-55`) |
| Tabela de eventos processados com ID único; grava primeiro; repetido → 200 sem efeito | — | `modules/webhooks.ts:40-52` | ✅ registro + enfileiramento na mesma transação |
| Não depende da ordem: o job busca o estado atual no gateway | — | `billing/sync.ts:26` | ✅ teste "fora de ordem" |
| Resposta 2xx rápida, trabalho pesado na fila | — | `modules/webhooks.ts:46-53` | ✅ fila Postgres já existente |
| Idempotency key (UUID v4) por operação de negócio, reaproveitada nas novas tentativas | — | `modules/billing.ts:50-56,60-69` | ✅ teste "mesma idempotency key" |
| Endpoints que criam proposta/checkout aceitam `Idempotency-Key` e devolvem a mesma resposta | — | `lib/idempotency.ts`, `modules/proposals.ts:121`, `modules/billing.ts:43` | ✅ |
| Chave nunca usa dado pessoal | — | — | ✅ chave do cliente é UUID; dedupe de e-mail usa IDs internos |
| **ID-01**: rota de checkout fake sem autenticação (achado 2) | Alto (condicional) | `modules/webhooks.ts:57` | Registrar a rota só se `NODE_ENV==='development'` **e** uma flag explícita `ENABLE_FAKE_CHECKOUT=true`; startup recusar `fake` fora de `development`/`test`; compose sem default `development` |
| **ID-02**: troca manual de plano pela plataforma é **desfeita** na próxima sincronização do gateway | Médio | `billing/sync.ts:49`, `modules/platform.ts:162` | Plataforma deve trocar o plano **no gateway** (que gera webhook) ou marcar `plan_override` respeitado pelo sync — decisão de negócio sua |
| **RC-02** chave presa em processamento | Baixo | `lib/idempotency.ts:75-113` | Ver etapa 3 |
| Reembolso/cancelamento pelo app | — | — | Não existe no MVP (n/a) |
| Adapter Stripe | — | `billing/gateway.ts:57-105` | **Não verificado** contra a API real |

---

## Etapa 5 — Separação de responsabilidades

| Arquivo | Linhas | Mistura tela / regra / dados? |
|---|---|---|
| `apps/api/src/modules/proposals.ts` | 217 | **Sim**: rotas HTTP + validação + regra de visibilidade + SQL + renderização de PDF + transições de status |
| `apps/api/src/modules/platform.ts` | 194 | Rotas + SQL (sem regra complexa) |
| `apps/api/src/modules/leads.ts` | 187 | Rotas + regra de visibilidade/dono + SQL |
| `apps/api/src/billing/gateway.ts` | 164 | Só integração externa (ok) |
| `apps/web/src/pages/Proposals.tsx` | 143 | UI + prévia de cálculo (ok para front) |

**Candidato nº 1 para refatorar: `apps/api/src/modules/proposals.ts`.**

Mapa (camadas):

| Trecho | Linhas | Camada |
|---|---|---|
| `proposalBody` (schema Zod) | 15-31 | regra de negócio (validação de entrada) |
| `loadVisibleProposal` | 34-41 | acesso a dados + regra (visibilidade) |
| `brl` | 43-44 | apresentação |
| `renderPdf` | 46-93 | UI/apresentação (documento) |
| `GET /proposals` | 98-112 | rota + SQL + regra de escopo duplicada de `leadScope` |
| `POST /proposals` | 114-159 | rota + regra (desconto, preço) + SQL (produtos, contador, inserts, evento) |
| `GET /proposals/:id` | 161-169 | rota + SQL |
| `transition()` + send/reject/accept | 171-200 | regra (máquina de estados) + SQL + efeitos no lead |
| `GET /proposals/:id/pdf` | 202-216 | rota + SQL + apresentação |

Dependências cruzadas e duplicação: importa `loadVisibleLead` de `leads.ts`; a regra de escopo do vendedor está **duplicada** em SQL na linha 102 (`'(l.owner_id = $2 OR l.owner_id IS NULL)'`) em vez de reutilizar `leadScope`; `brl()` duplica a função do front. Sem estado global.

Estrutura proposta (mesmo padrão de pastas atual, sem biblioteca nova):
```
modules/proposals/
  routes.ts        (só HTTP: parse, guard, chamar service, responder)
  service.ts       (criar, transicionar, regras de status)
  repository.ts    (SQL)
  pdf.ts           (renderPdf + brl)
modules/proposals.ts  → reexporta proposalRoutes (mesmo nome público)
```
Passos (cada um mantém nomes, rotas e testes verdes): 1) extrair `renderPdf`/`brl` para `pdf.ts`; 2) extrair SQL de leitura para `repository.ts`; 3) extrair SQL de escrita; 4) extrair criação para `service.ts`; 5) extrair `transition`; 6) `routes.ts` + reexport. Testes de caracterização: os 12 testes de `crm.spec.ts > Propostas` + 1 de isolamento já cobrem os fluxos; antes do passo 1 eu adicionaria 1 teste de caracterização da listagem com filtro `leadId` para vendedor (hoje sem teste). Bug anotado (não corrigir na refatoração): nenhum encontrado neste arquivo além da duplicação da regra de escopo. **Aguardando seu OK para o passo 1.**

---

## Achados adicionais (baixo / informativo)

| Achado | Risco | Arquivo:linha | Correção sugerida |
|---|---|---|---|
| Sessões e chaves de idempotência expiradas nunca são apagadas | Baixo | `001_schema.sql:64,235` | Job diário de limpeza |
| Mensagens de erro expõem nome de constraint (`duplicate:users_email_uq`) e permitem enumerar e-mails no cadastro | Baixo | `lib/errors.ts:25`, `modules/auth.ts:60` | Código genérico para o cliente; logar o detalhe |
| Cookies sem prefixo `__Host-` | Baixo | `auth/guards.ts:7-8` | Usar `__Host-g360_sid` em produção (HTTPS) |
| CSP desligada na API (`helmet`) — o nginx aplica CSP no front, o servidor Vite de dev não | Info | `app.ts:31`, `apps/web/nginx.conf:5` | Manter CSP no host que serve o front |
| Listas sem paginação (`LIMIT 1000/500`) | Info | `modules/leads.ts:78`, `activities.ts:68`, `proposals.ts:107` | Paginação por cursor |
| Link do convite volta na resposta para o admin | Info | `modules/users.ts:103` | Decisão de produto (fallback sem e-mail); manter só para admin |
| Docker/compose | Info | `docker-compose.yml` | **Não verificado** em execução (sem Docker daemon neste ambiente) |

---

## Qual dos 5 prompts de correção rodar primeiro

**Rode primeiro o prompt de auditoria de segurança ("Você é um auditor de segurança…").**
Os dois achados de risco **alto** (rate limit contornável e checkout fake liberado pelos defaults do compose) são de segurança/configuração, exploráveis sem nenhuma condição de corrida e com impacto direto em dinheiro e em contas.
Race conditions e idempotência já têm proteção no banco e testes simultâneos para todos os fluxos de dinheiro; o que sobrou nessas áreas (RC-01 posição de etapa, RC-02 chave presa, ID-02 plano manual) é de risco baixo/médio e pode vir em seguida, nesta ordem: segurança → idempotência (ID-01/ID-02) → race conditions (RC-01/RC-02) → testes → refatoração.
