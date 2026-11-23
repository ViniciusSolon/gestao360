"""Dados da auditoria (fonte única para o PDF). Edite aqui e rode gerar_relatorio.py."""

PROJETO = "Gestão 360° (MVP)"
DATA = "23/11/2026"

ESCOPO = [
    "apps/api — Node 22 + Fastify 5 + TypeScript, SQL via pg (sem ORM), 11 módulos de rotas, worker de jobs",
    "apps/api/src/db/migrations — schema PostgreSQL 16, RLS, GRANTs, funções SECURITY DEFINER",
    "apps/web — React 18 + Vite (app dos clientes e painel da plataforma) e bundle gerado em dist/",
    "Deploy — docker-compose.yml, Dockerfiles, nginx.conf, .github/workflows/ci.yml, .env.example",
    "Histórico git — repositório sem commits na data (não há histórico a varrer)",
]

METODO = [
    ("1. Banco sem tranca", "Mecanismo do projeto: RLS do Postgres por tenant (app_current_tenant() a partir de set_config por transação) + papel g360_app sem BYPASSRLS + GRANTs por coluna. Verificado: tabelas sem RLS, policies permissivas, consultas que dependem só do código."),
    ("2. Permissão no navegador", "Cada gate de papel do React (can(), isSuper, role === 'owner') cruzado com o guard do endpoint correspondente (guard/sessionOnly/requireSuperadmin)."),
    ("3. IDOR", "Todos os 52 handlers de rota percorridos (incluindo /health) (tenant, webhooks, plataforma, rota de dev); para cada um, como o objeto por ID é filtrado (RLS + escopo de papel)."),
    ("4. Chaves expostas", "Busca por sk_/whsec_/senhas em código, configs, compose, CI, docs e testes; defaults ${VAR:-...}; validação de startup; bundle do front; .gitignore."),
    ("5. XSS", "Sinks no React (dangerouslySetInnerHTML, innerHTML, eval, href/src dinâmicos), HTML de e-mail no backend, geração de PDF."),
]

CATEGORIAS = [
    {"id": "db", "n": 1, "nome": "Banco sem tranca (isolamento)",
     "mecanismo": "Mecanismo: RLS por tenant em 20 tabelas; a API usa g360_app (NOBYPASSRLS). Painel/webhook/worker usam g360_platform (BYPASSRLS)."},
    {"id": "perm", "n": 2, "nome": "Permissão definida no navegador",
     "mecanismo": "Gates do front: Equipe (admin+), editar produto (gerente+), assinar plano (owner), ações do painel (superadmin).",
     "sem_achados": "Nenhum achado: todos os gates do front têm verificação equivalente no servidor e teste que espera 403."},
    {"id": "idor", "n": 3, "nome": "IDOR",
     "mecanismo": "Toda busca por ID na API de clientes passa por RLS (empresa) e, para leads/atividades/propostas, pelo escopo do papel (vendedor)."},
    {"id": "keys", "n": 4, "nome": "Chaves expostas (hardcode)",
     "mecanismo": "Segredos só no servidor via variáveis de ambiente; compose usa ${VAR:?}; config.ts recusa segredos ausentes/fracos."},
    {"id": "xss", "n": 5, "nome": "Inputs sem tratamento (XSS)",
     "mecanismo": "Front React (escape automático), sem lib de sanitização porque nenhum HTML de usuário é renderizado; e-mails com template que escapa toda interpolação."},
    {"id": "extra", "n": 6, "nome": "Fora das 5 categorias (autenticação/infra)",
     "mecanismo": "Achados verificados durante a varredura que não se encaixam nas categorias pedidas."},
]

ACHADOS = [
    {"id": "SEC-01", "cat": "db", "sev": "média", "titulo": "Visibilidade de leads por vendedor existe só no código",
     "loc": "apps/api/src/modules/leads.ts:37-40, apps/api/src/db/migrations/002_rls_and_grants.sql:45-46",
     "trecho": "if (atLeast(a.role, 'manager')) return { sql: 'true', params: [] };  /  USING (tenant_id = app_current_tenant())",
     "desc": "O RLS isola empresas, mas a regra 'vendedor só vê os próprios leads' é um filtro SQL montado em cada rota. Uma rota nova que esqueça leadScope expõe todos os leads da empresa a qualquer vendedor.",
     "condicao": "Requer uma rota nova/alterada sem o filtro; hoje todas as rotas existentes aplicam o escopo (testado).",
     "impacto": "Vazamento de carteira de clientes entre vendedores da mesma empresa."},
    {"id": "SEC-02", "cat": "db", "sev": "média", "titulo": "Processo público da API carrega credencial BYPASSRLS",
     "loc": "apps/api/src/config.ts:27, apps/api/src/server.ts:9, apps/api/src/modules/webhooks.ts:40",
     "trecho": "API_SURFACE: z.enum(['tenant', 'platform', 'all']).default('all'),",
     "desc": "O default API_SURFACE=all registra rotas de clientes e da plataforma no mesmo processo, e mesmo com 'tenant' o processo recebe DATABASE_PLATFORM_URL (usado pelo webhook). Uma RCE/SQLi na API pública daria acesso irrestrito a todos os tenants.",
     "condicao": "Depende de uma segunda falha (RCE/SQLi); não há SQL com entrada do usuário concatenada hoje.",
     "impacto": "Amplia o raio de uma invasão da API pública para todas as empresas."},
    {"id": "SEC-03", "cat": "db", "sev": "baixa", "titulo": "Papel da API pode alterar contadores de limite do plano",
     "loc": "apps/api/src/db/migrations/002_rls_and_grants.sql:61",
     "trecho": "GRANT UPDATE (name, seats_used, leads_count) ON tenants TO g360_app;",
     "desc": "seats_used e leads_count são graváveis pelo papel da API (necessário para o UPDATE atômico). Com uma SQLi, o atacante zeraria os contadores e passaria dos limites do plano.",
     "condicao": "Requer SQLi (não encontrada).", "impacto": "Uso acima do plano contratado."},
    {"id": "SEC-04", "cat": "idor", "sev": "alta", "titulo": "Rota de checkout simulado sem autenticação ativa plano pago",
     "loc": "apps/api/src/modules/webhooks.ts:57-74",
     "trecho": "if (config.NODE_ENV === 'development' && gateway instanceof FakeGateway) { app.post('/dev/fake-checkout/:sessionId/complete', ...",
     "desc": "A rota não exige sessão e conclui qualquer sessão de checkout pelo ID, assinando um webhook válido com o segredo do servidor. O owner de qualquer conta inicia o checkout e chama a rota: a conta vira 'active' no plano pago sem pagamento.",
     "condicao": "Só existe com NODE_ENV=development e BILLING_PROVIDER=fake — que são exatamente os defaults do docker-compose (SEC-05). Exercitado no teste de fumaça local.",
     "impacto": "Uso dos planos pagos sem pagar; MRR incorreto no painel."},
    {"id": "SEC-05", "cat": "keys", "sev": "média", "titulo": "Defaults inseguros no compose e validação de startup incompleta",
     "loc": "docker-compose.yml:40, docker-compose.yml:44, apps/api/src/config.ts:51",
     "trecho": "NODE_ENV: ${NODE_ENV:-development}  /  BILLING_PROVIDER: ${BILLING_PROVIDER:-fake}",
     "desc": "Não são segredos, mas são defaults que viram falha: subir o compose sem definir as variáveis gera um ambiente 'development' com gateway fake (habilita SEC-04). O startup só recusa o fake quando NODE_ENV=production.",
     "condicao": "Deploy feito com o compose sem sobrescrever as variáveis.", "impacto": "Habilita SEC-04 em servidor público."},
    {"id": "SEC-06", "cat": "keys", "sev": "informativa", "titulo": "Segredo de webhook fixo nos testes",
     "loc": "apps/api/test/helpers.ts:12", "trecho": "export const WEBHOOK_SECRET = 'whsec_test_' + 'x'.repeat(32);",
     "desc": "Valor sintético usado apenas no banco de teste; não corresponde a nenhuma chave real.", "impacto": "Nenhum."},
    {"id": "SEC-07", "cat": "xss", "sev": "informativa", "titulo": "CSP desligada na API e ausente no servidor de dev",
     "loc": "apps/api/src/app.ts:31, apps/web/nginx.conf:5", "trecho": "await app.register(helmet, { contentSecurityPolicy: false });",
     "desc": "A API só devolve JSON/PDF, então a CSP relevante é a do host do front — aplicada no nginx. Nenhum sink de XSS foi encontrado; é defesa em profundidade.",
     "impacto": "Sem impacto direto."},
    {"id": "SEC-08", "cat": "extra", "sev": "alta", "titulo": "Rate limit de login contornável com X-Forwarded-For",
     "loc": "apps/api/src/app.ts:25", "trecho": "trustProxy: true,",
     "desc": "O Fastify confia em qualquer X-Forwarded-For, então cada tentativa com um IP inventado ganha cota nova. Reproduzido: mesmo IP → 429 na 11ª tentativa; IP variando → 12 respostas 401, nenhum 429. O IP gravado na auditoria também é forjável.",
     "condicao": "Sempre que a API estiver acessível diretamente ou atrás de proxy que repassa o cabeçalho do cliente.",
     "impacto": "Força bruta de senha de clientes e do painel interno; auditoria com IP falso."},
    {"id": "SEC-09", "cat": "extra", "sev": "média", "titulo": "Painel da plataforma sem MFA",
     "loc": "apps/api/src/modules/platform.ts:42-44", "trecho": "const ok = await verifyPassword(b.password, admin?.password_hash ?? null);",
     "desc": "O acesso que suspende clientes e troca planos depende só de senha.",
     "condicao": "Senha vazada/fraca; agravado por SEC-08.", "impacto": "Controle de todas as contas de clientes."},
    {"id": "SEC-10", "cat": "extra", "sev": "baixa", "titulo": "Rate limit em memória por instância",
     "loc": "apps/api/src/app.ts:34", "trecho": "await app.register(rateLimit, { global: false });",
     "desc": "Com N réplicas o limite efetivo vira N vezes maior e zera a cada deploy.", "impacto": "Enfraquece a proteção contra força bruta."},
    {"id": "SEC-11", "cat": "extra", "sev": "baixa", "titulo": "Erro expõe nome de constraint e permite enumerar e-mails",
     "loc": "apps/api/src/lib/errors.ts:25, apps/api/src/modules/auth.ts:60",
     "trecho": "return conflict('Registro duplicado', `duplicate:${err.constraint ?? 'unique'}`);",
     "desc": "O cadastro responde 409 'duplicate:users_email_uq' para e-mail já existente.", "impacto": "Descoberta de quais e-mails são clientes."},
    {"id": "SEC-12", "cat": "extra", "sev": "baixa", "titulo": "Cookies sem prefixo __Host- e sessões expiradas não removidas",
     "loc": "apps/api/src/auth/guards.ts:7-8, apps/api/src/db/migrations/001_schema.sql:64",
     "trecho": "export const TENANT_COOKIE = 'g360_sid';",
     "desc": "Sem __Host-, um subdomínio comprometido pode sobrescrever o cookie; sessões e chaves de idempotência vencidas ficam no banco indefinidamente.",
     "impacto": "Fixação de sessão via subdomínio; crescimento de tabelas."},
]

FORTES = [
    {"cat": "db", "txt": "RLS ligado em todas as 20 tabelas com dados; nenhuma policy USING(true)/WITH CHECK(true)", "ev": "002_rls_and_grants.sql:13-46; teste isolation.spec 'sem tenant definido… nenhuma linha'"},
    {"cat": "db", "txt": "Gravar linha com tenant_id de outra empresa é bloqueado pelo banco", "ev": "isolation.spec 'o RLS bloqueia'"},
    {"cat": "db", "txt": "FKs compostas (tenant_id, id) impedem referenciar etapa/usuário/produto de outra empresa", "ev": "001_schema.sql (leads, proposals, activities); teste 'FK composta por tenant'"},
    {"cat": "db", "txt": "Status, plano e trial do tenant e valores de proposta sem GRANT UPDATE para a API", "ev": "002_rls_and_grants.sql:59-77; teste 'permission denied' em UPDATE tenants"},
    {"cat": "perm", "txt": "Todo gate de papel do front tem guard equivalente no servidor", "ev": "users.ts/products.ts/pipeline.ts/billing.ts/platform.ts; crm.spec 'Permissões por papel'"},
    {"cat": "perm", "txt": "Preço, tributo, desconto máximo, limites e score recalculados no servidor", "ev": "lib/pricing.ts, lib/limits.ts; crm.spec 'valores enviados pelo cliente são ignorados'"},
    {"cat": "idor", "txt": "Todos os handlers de leads, atividades, propostas, produtos, etapas, usuários e convites retornam 404 para ID de outra empresa", "ev": "isolation.spec (5 testes A×B por rota)"},
    {"cat": "idor", "txt": "Vendedor não acessa lead/proposta/atividade de outro vendedor", "ev": "leads.ts:48-51, activities.ts:29-38; isolation.spec 'vendedor x vendedor'"},
    {"cat": "idor", "txt": "Escritas do painel exigem superadmin; cookie de cliente não autentica no painel", "ev": "platform.ts:37-38; platform.spec"},
    {"cat": "keys", "txt": "Nenhum segredo real no código, compose (${VAR:?}), CI ou bundle; .env ignorado pelo git", "ev": "docker-compose.yml; .gitignore:3; grep no dist/"},
    {"cat": "keys", "txt": "Startup recusa segredo ausente, curto ou padrão ('changeme', 'secret'…)", "ev": "config.ts:8-15; unit.spec 'Configuração de startup'"},
    {"cat": "xss", "txt": "Nenhum dangerouslySetInnerHTML/innerHTML/eval; React escapa tudo", "ev": "grep em apps/web/src"},
    {"cat": "xss", "txt": "URLs de usuário (reunião, foto) só https, validado no Zod e por CHECK no banco", "ev": "activities.ts:18, products.ts:15, 001_schema.sql; teste 'javascript:' → 400"},
    {"cat": "xss", "txt": "E-mails transacionais escapam toda interpolação", "ev": "lib/html.ts; auth.spec 'o e-mail sai com o texto escapado'"},
    {"cat": "extra", "txt": "Webhook com assinatura HMAC sobre o corpo bruto, tolerância de 5 min, comparação em tempo constante", "ev": "billing/gateway.ts:40-55; billing.spec"},
    {"cat": "extra", "txt": "CSRF: cookie SameSite=Lax + checagem de Origin + parser text/plain removido", "ev": "app.ts:28-41; auth.spec (403 e 415)"},
]

RECOMENDACOES = [
    ("P1", "Configurar trustProxy com a lista/contagem exata de proxies confiáveis (ou false) e mover o rate limit para o proxy/WAF ou tabela no Postgres.", "SEC-08, SEC-10"),
    ("P1", "Registrar a rota de checkout simulado só com flag explícita ENABLE_FAKE_CHECKOUT e recusar gateway fake fora de development/test; remover defaults NODE_ENV/BILLING_PROVIDER do compose.", "SEC-04, SEC-05"),
    ("P2", "Default API_SURFACE=tenant; webhook grava evento via função SECURITY DEFINER e o processo público deixa de receber DATABASE_PLATFORM_URL.", "SEC-02"),
    ("P2", "MFA (TOTP/WebAuthn) obrigatório no painel e publicá-lo apenas atrás de VPN/SSO.", "SEC-09"),
    ("P2", "Policy RLS RESTRICTIVE por dono do lead (migration 009_rls_seller_leads.sql).", "SEC-01"),
    ("P3", "Contadores de plano via funções SECURITY DEFINER (revogar GRANT de coluna); mensagens de erro genéricas; cookies __Host-; job de limpeza de sessões/chaves.", "SEC-03, SEC-11, SEC-12"),
]

ISSUES = [
"""
# [Segurança] Rate limit de login contornável via X-Forwarded-For

**Labels sugeridas:** security, severity:alta

## Problema
`trustProxy: true` faz o Fastify aceitar qualquer `X-Forwarded-For`. O rate limit de login/cadastro/convite e do painel usa `req.ip`, então cada tentativa com um IP inventado recebe cota nova. O limite também fica em memória por instância.

## Evidência
- `apps/api/src/app.ts:25` → `trustProxy: true,`
- `apps/api/src/app.ts:34` → `await app.register(rateLimit, { global: false });`
- Reproduzido localmente: mesmo IP → 429 na 11ª tentativa; IP variando → 12×401, nenhum 429.

## Impacto
Força bruta de senhas de clientes e do painel interno; IP falso no audit_log.

## Sugestão de correção
- `trustProxy` com o número/lista exata de proxies confiáveis (ex.: `trustProxy: 1` atrás do nginx) ou `false` sem proxy.
- Rate limit também no proxy/WAF, ou contagem de tentativas por e-mail numa tabela do Postgres (vale para N réplicas).

## Critérios de aceite
- [ ] Teste de integração: 11 tentativas com `X-Forwarded-For` variando recebem 429.
- [ ] Limite por e-mail além de por IP.
- [ ] `audit_log.ip` registra o IP real visto pelo proxy confiável.
""",
"""
# [Segurança] Checkout simulado ativa plano pago sem pagamento fora de dev

**Labels sugeridas:** security, severity:alta

## Problema
`POST /api/webhooks/dev/fake-checkout/:sessionId/complete` não exige autenticação e conclui qualquer sessão de checkout, assinando um webhook válido. A rota existe quando `NODE_ENV=development` e `BILLING_PROVIDER=fake` — que são os **defaults do docker-compose**. O startup só recusa o fake com `NODE_ENV=production`.

## Evidência
- `apps/api/src/modules/webhooks.ts:57-58` → `if (config.NODE_ENV === 'development' && gateway instanceof FakeGateway) { app.post('/dev/fake-checkout/...`
- `docker-compose.yml:40` → `NODE_ENV: ${NODE_ENV:-development}`
- `docker-compose.yml:44` → `BILLING_PROVIDER: ${BILLING_PROVIDER:-fake}`
- `apps/api/src/config.ts:51`

## Impacto
Qualquer owner ativa Pro/Business sem pagar; MRR do painel fica errado.

## Sugestão de correção
- Registrar a rota só com `ENABLE_FAKE_CHECKOUT=true` explícito **e** `NODE_ENV=development`.
- `config.ts`: recusar `BILLING_PROVIDER=fake` quando `NODE_ENV` não for `development`/`test`.
- Compose: `NODE_ENV: ${NODE_ENV:?}` e `BILLING_PROVIDER: ${BILLING_PROVIDER:?}`.

## Critérios de aceite
- [ ] Teste: com `NODE_ENV=development` sem a flag, a rota responde 404.
- [ ] Teste: `loadConfig` com `NODE_ENV=staging` + fake lança erro.
- [ ] `docker compose config` falha sem as variáveis definidas.
""",
"""
# [Segurança] API pública carrega credencial do banco com BYPASSRLS

**Labels sugeridas:** security, severity:média

## Problema
`API_SURFACE` tem default `all`, e mesmo com `tenant` o processo recebe `DATABASE_PLATFORM_URL` (papel `g360_platform`, BYPASSRLS) por causa do webhook. Uma RCE/SQLi na API pública teria acesso a todos os clientes.

## Evidência
- `apps/api/src/config.ts:27` → `API_SURFACE: z.enum(['tenant', 'platform', 'all']).default('all'),`
- `apps/api/src/server.ts:9` → `new Db(config.DATABASE_APP_URL, config.DATABASE_PLATFORM_URL, ...)`
- `apps/api/src/modules/webhooks.ts:40` → `db.withPlatform(...)`

## Impacto
Amplia uma invasão da API pública para todas as empresas.

## Sugestão de correção
- Default `API_SURFACE=tenant`; `DATABASE_PLATFORM_URL` opcional nesse modo.
- Webhook grava evento + job via função `SECURITY DEFINER record_billing_webhook(provider, event_id, type, subscription_id)` com GRANT EXECUTE só para `g360_app`.

## Critérios de aceite
- [ ] API sobe com `API_SURFACE=tenant` sem `DATABASE_PLATFORM_URL`.
- [ ] Testes de webhook (duplicado/simultâneo/fora de ordem) continuam passando.
""",
"""
# [Segurança] Visibilidade de leads por vendedor sem defesa no banco

**Labels sugeridas:** security, severity:média

## Problema
A regra "vendedor só vê os próprios leads" é um filtro SQL aplicado por rota (`leadScope`). O RLS só compara a empresa. Uma rota nova sem o filtro expõe a carteira inteira.

## Evidência
- `apps/api/src/modules/leads.ts:37-40` → `if (atLeast(a.role, 'manager')) return { sql: 'true', params: [] };`
- `apps/api/src/db/migrations/002_rls_and_grants.sql:45-46` → `USING (tenant_id = app_current_tenant())`

## Impacto
Vazamento de clientes entre vendedores da mesma empresa.

## Sugestão de correção
Policy `RESTRICTIVE` por dono (proposta em `apps/api/src/db/migrations/009_rls_seller_leads.sql`) e `withTenant` passando `app.role`.

## Critérios de aceite
- [ ] Teste direto no banco: com `app.role='seller'`, SELECT em lead de outro dono retorna 0 linhas.
- [ ] Testes de `isolation.spec.ts` continuam passando.
""",
"""
# [Segurança] Painel da plataforma sem MFA

**Labels sugeridas:** security, severity:média

## Problema
O login do painel que suspende clientes e troca planos usa só senha.

## Evidência
- `apps/api/src/modules/platform.ts:42-44` → `const ok = await verifyPassword(b.password, admin?.password_hash ?? null);`

## Impacto
Senha vazada = controle sobre todas as contas de clientes.

## Sugestão de correção
TOTP ou WebAuthn obrigatório para `platform_admins`; publicar `API_SURFACE=platform` só atrás de VPN/SSO.

## Critérios de aceite
- [ ] Login sem segundo fator não cria `platform_sessions`.
- [ ] Teste cobrindo código TOTP inválido/expirado.
""",
"""
# [Segurança] Endurecimentos de baixo risco (contadores, erros, cookies, limpeza)

**Labels sugeridas:** security, severity:baixa

## Problema
1. `g360_app` pode dar UPDATE em `seats_used`/`leads_count` (com SQLi, burla limites do plano).
2. Erro 409 expõe nome da constraint e permite enumerar e-mails no cadastro.
3. Cookies sem prefixo `__Host-`.
4. Sessões e chaves de idempotência vencidas nunca são apagadas.

## Evidência
- `apps/api/src/db/migrations/002_rls_and_grants.sql:61` → `GRANT UPDATE (name, seats_used, leads_count) ON tenants TO g360_app;`
- `apps/api/src/lib/errors.ts:25` → `` `duplicate:${err.constraint ?? 'unique'}` ``
- `apps/api/src/auth/guards.ts:7` → `export const TENANT_COOKIE = 'g360_sid';`
- `apps/api/src/db/migrations/001_schema.sql:64` (sessions)

## Impacto
Baixo isoladamente; reduz o dano de outras falhas.

## Sugestão de correção
Funções `SECURITY DEFINER consume_seat/consume_lead` e revogar o GRANT; código de erro genérico para o cliente; `__Host-` em produção; job diário de limpeza.

## Critérios de aceite
- [ ] `UPDATE tenants SET seats_used = 0` como `g360_app` falha com permission denied.
- [ ] Cadastro com e-mail existente não revela o nome da constraint.
- [ ] Cookie em produção começa com `__Host-`.
- [ ] Job remove sessões expiradas há mais de 1 dia.
""",
]


# Status pós-correção (23/11/2026). Fonte para a coluna de status do PDF.
STATUS = {
    "SEC-01": "Corrigido — migration 009 (policy RESTRICTIVE) + Db.withAuth com papel",
    "SEC-02": "Corrigido — migration 005 (record_billing_webhook); API pública sem DATABASE_PLATFORM_URL",
    "SEC-03": "Corrigido — migration 007 (funções de contador; GRANT revogado)",
    "SEC-04": "Corrigido — rota só com ENABLE_FAKE_CHECKOUT=true + development",
    "SEC-05": "Corrigido — NODE_ENV padrão production; compose sem defaults",
    "SEC-06": "Sem ação (informativo)",
    "SEC-07": "Sem ação (informativo; CSP no nginx)",
    "SEC-08": "Corrigido — TRUST_PROXY explícito (true é recusado)",
    "SEC-09": "Corrigido — TOTP obrigatório, migration 008",
    "SEC-10": "Corrigido — rate limit no Postgres por IP e e-mail, migration 006",
    "SEC-11": "Corrigido parcialmente — códigos genéricos; enumeração no cadastro exige verificação de e-mail",
    "SEC-12": "Corrigido — cookies __Host-/__Secure- e limpeza horária",
}
