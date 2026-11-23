# Gestão 360° — Linguagens, arquitetura e painel da plataforma

Documento de decisão técnica para o MVP descrito no escopo preliminar
(Leads, Kanban, atividades, indicadores e propostas simples), com a base
pronta para as fases seguintes (WhatsApp, IA, ERP).

---

## 1. Escolha das linguagens

### Critérios (pesos pensados para o contexto do PDF)

| Critério | Por que importa aqui | Peso |
|---|---|---|
| Uma linguagem para front e back | Orçamento de R$ 30 mil e dev em tempo parcial: menos contexto para trocar, menos gente para contratar | Alto |
| Mão de obra no Brasil | Contratar/terceirizar rápido e barato | Alto |
| Ecossistema SaaS B2B | PDF, gateways (Stripe/Asaas/Pagar.me), WhatsApp Cloud API, e-mail, SDKs de IA | Alto |
| Segurança de tipos | Regras de preço, desconto e permissão não podem quebrar em silêncio | Médio |
| Desempenho | CRM é I/O-bound (banco + APIs externas), não CPU-bound | Médio |
| IA e dados (fase 2) | Resumo de conversas, priorização, consultas em linguagem natural | Médio |

### Comparativo

| Linguagem / stack | Pontos fortes | Pontos fracos para este caso | Nota |
|---|---|---|---|
| **TypeScript (Node + React)** | Mesma linguagem no front e no back; maior oferta de devs no Brasil; SDK oficial de praticamente todo gateway, WhatsApp e LLM; tipagem forte; ótimo para I/O | Não é o melhor para cálculo pesado (não é o caso do MVP) | **9/10** |
| Python (Django/FastAPI) | Melhor ecossistema de IA/dados; Django Admin pronto | Precisa de outra linguagem no front; tipagem opcional; deploy assíncrono mais trabalhoso | 7,5/10 |
| Go | Performance, binário único, ótimo para workers | Front em outra linguagem; ecossistema SaaS/PDF menor; produtividade menor para CRUD | 6,5/10 |
| Java/Kotlin (Spring) | Robusto, ótimo para ERP grande | Verboso e caro para MVP; time menor e mais caro | 6/10 |
| C# (.NET) | Muito produtivo, bom para ERP | Front separado; menos devs freelancers no nicho de startups | 6,5/10 |
| PHP (Laravel) | Barato, muitos devs | Front SPA separado; menos tipagem; menos aderente a filas/realtime | 6,5/10 |
| Elixir (Phoenix) | Realtime e concorrência excelentes (WhatsApp) | Mão de obra rara e cara no Brasil | 5/10 |

### Decisão

| Camada | Escolha | Motivo |
|---|---|---|
| Backend (API, regras, filas) | **TypeScript** — Node 22 + Fastify + Zod + `pg` | Uma linguagem só, validação forte, SQL explícito (sem ORM mágico) para controlar RLS e concorrência |
| Frontend | **TypeScript** — React 18 + Vite | Mesmo time, mesmos tipos, build estático barato de hospedar |
| Banco | **SQL / PostgreSQL 16** | Transações, RLS para isolamento entre clientes, constraints que garantem regras sob concorrência, fila com `SKIP LOCKED` — sem Redis no MVP |
| Fase 2 (IA/dados) | **Python** como *worker* separado, só quando necessário | Para embeddings/modelos próprios. Chamar LLMs via API funciona bem em TypeScript, então o MVP não precisa de Python |

> Regra de ouro: **não adicionar linguagem/infra nova enquanto o Postgres resolver.**

---

## 2. Arquitetura (pensada para escalar)

```
                 ┌──────────────── navegador ───────────────┐
                 │  app.seudominio (React)   admin.seudominio│ ← painel interno (VPN/SSO)
                 └──────────┬─────────────────────┬─────────┘
                            │ cookie httpOnly     │ cookie próprio (path /api/platform)
              ┌─────────────▼──────────┐ ┌────────▼─────────────┐
              │ API tenant (N réplicas)│ │ API plataforma (1–2) │  ← mesmo código,
              │ API_SURFACE=tenant     │ │ API_SURFACE=platform │    deploys separados
              │ papel g360_app (RLS)   │ │ papel g360_platform  │
              └───────┬────────────────┘ └────────┬─────────────┘
   webhooks ─────────►│ (assinatura HMAC)         │
                      │        ┌──────────────────┘
              ┌───────▼────────▼───────┐      ┌──────────────────────┐
              │  PostgreSQL            │◄─────┤ Worker (N réplicas)   │
              │  RLS por tenant        │ jobs │ FOR UPDATE SKIP LOCKED│──► gateway, e-mail,
              │  constraints/atômicos  │      └──────────────────────┘    WhatsApp (v2)
              └────────────────────────┘
```

### Decisões e como cada uma escala

| Decisão | Hoje (MVP) | Quando crescer |
|---|---|---|
| **Monólito modular** (`modules/auth`, `leads`, `proposals`, `billing`, `platform`…) | Um repositório, um deploy por superfície | Extrair módulo para serviço só quando houver time/escala que justifique (ex.: WhatsApp) |
| **API sem estado** | Sessão no banco (token opaco, só o hash é salvo) | Réplicas horizontais atrás de load balancer; sessão pode ir para cache sem mudar contrato |
| **Multi-tenant em schema compartilhado** com `tenant_id` + **RLS** + FKs compostas `(tenant_id, id)` | Isolamento garantido pelo banco, não só pelo código | PgBouncer em *transaction mode* funciona (o tenant é `set_config(..., true)` por transação); particionar tabelas grandes (`lead_events`, `audit_log`) por hash de tenant; clientes enormes → banco dedicado com roteamento por tenant |
| **Regras críticas no banco** (unique, update atômico, lock de linha) | Sem Redis/lock em memória | Continua valendo com N réplicas, pois a garantia está no Postgres |
| **Fila no Postgres** (`jobs` + `SKIP LOCKED`, outbox na mesma transação) | Um worker basta | N workers sem disputa; migrar para SQS/RabbitMQ só acima de centenas de jobs/s |
| **Superfícies separadas** (`API_SURFACE=tenant|platform`) | Mesmo código | Painel interno fica fora da internet pública |
| **Gateway de pagamento abstraído** (`BillingGateway`) | Stripe + Fake (dev/teste) | Adicionar Asaas/Pagar.me (boleto/PIX) sem mexer nas rotas |
| **Auditoria** (`audit_log`) | Logins, mudanças de papel, propostas, ações da plataforma | Exportar para armazenamento frio; base para LGPD |

### Segurança desde a arquitetura (item 6 do escopo)

* **Isolamento**: RLS em todas as tabelas de tenant; o papel da API não tem `BYPASSRLS` e nem enxerga tabelas da plataforma.
* **Colunas sensíveis** (`tenants.status`, `plan_id`, valores da proposta) não têm `GRANT UPDATE` para a API dos clientes.
* **Permissões por usuário**: owner > admin > gerente > vendedor; vendedor só vê os próprios leads.
* **Preço/desconto/limites do plano** recalculados no servidor.
* **Startup recusa** segredos ausentes/fracos, gateway fake e cookie inseguro em produção.
* **Backups**: usar Postgres gerenciado com PITR (RDS/Cloud SQL/Neon/Supabase DB).

---

## 3. Painel para controlar os clientes — qual a melhor forma

**Recomendação: painel próprio, separado da aplicação dos clientes** (é o que está implementado em `/admin`).

| Opção | Prós | Contras | Veredito |
|---|---|---|---|
| **Painel próprio separado** (implementado) | Controle total; mesma regra de negócio; auditoria com motivo; não expõe dados de negócio do cliente (LGPD) | Precisa construir telas | ✅ Recomendado |
| Ferramenta low-code (Retool, Appsmith, Forest Admin) ligada no banco | Rápido de montar | Acesso amplo ao banco de todos os clientes; difícil garantir auditoria e regras; custo por usuário | Só para relatórios internos, com usuário de banco **somente leitura** |
| Usar a própria app com um "super usuário" | Nenhum código novo | Mistura papéis; um bug de permissão expõe tudo; impossível isolar por rede | ❌ Evitar |

Como foi construído:

1. **Identidade separada**: tabela `platform_admins`, login próprio, cookie `g360_admin_sid` com `path=/api/platform`. Cookie de cliente não funciona no painel e vice-versa.
2. **Papel de banco separado**: `g360_platform` (com BYPASSRLS) usado só pelo painel, webhooks e worker.
3. **RBAC interno**: `superadmin` (altera) e `support` (somente leitura), validado no servidor.
4. **Ações com motivo obrigatório e auditoria**: suspender/reativar, trocar plano, estender trial.
5. **LGPD**: o painel mostra metadados de uso (contagens, usuários, assinatura), **não** os leads/propostas dos clientes.
6. **Métricas do negócio**: MRR, clientes por status, novos em 30 dias, uso total.
7. **Deploy recomendado**: `API_SURFACE=platform` em host interno (VPN/Cloudflare Access/SSO com MFA).

Próximos passos sugeridos para o painel: MFA obrigatório, *impersonation* somente com consentimento do cliente e registro na auditoria, alertas de inadimplência e de clientes sem login há X dias (churn).
