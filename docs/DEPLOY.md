# Deploy automático na VPS (GitHub → VPS)

Depois de configurado: **todo push na `main`** roda os testes no GitHub Actions e, se passarem,
publica na VPS sozinho. Push em outra branch ou pull request só roda os testes.

```
git push (main) ──► GitHub Actions: typecheck + testes + build
                         │ passou?
                         ▼
                    SSH (chave que só executa scripts/deploy.sh)
                         ▼
VPS: git checkout <commit> → docker compose up --build (migrations rodam sozinhas)
     → confere /health → se falhar, volta para a versão anterior
```

## O que você precisa

| Item | Observação |
|---|---|
| VPS Ubuntu 22.04 ou 24.04 | 2 GB de RAM ou mais; acesso root por SSH |
| Um domínio | Registro **A** apontando para o IP da VPS (ex.: `crm.suaempresa.com.br`). Sem domínio, dá para usar `IP-COM-HIFENS.sslip.io` (ex.: `203-0-113-10.sslip.io`) |
| Portas 80 e 443 livres | O Caddy usa as duas para emitir e renovar o HTTPS (Let's Encrypt) |

## Passo 1 — preparar a VPS (uma vez só)

Entre na VPS como root e rode (troque o domínio e o IP):

```bash
curl -fsSLO https://raw.githubusercontent.com/ViniciusSolon/gestao360/main/scripts/vps-setup.sh
```

```bash
sudo bash vps-setup.sh --domain crm.suaempresa.com.br --host 203.0.113.10 --mode homologacao
```

* `--mode homologacao`: pagamento **simulado** (botão "Simular pagamento aprovado"), para testar. Qualquer
  cliente consegue "assinar" de graça — **não use com clientes reais**.
* `--mode producao`: Stripe de verdade (veja o passo 4).

O script instala Docker e firewall, cria o usuário `deploy`, baixa o projeto em `/opt/gestao360`,
gera o `.env` com senhas aleatórias (fica **só na VPS**) e, no fim, mostra **uma única vez** os valores
para o GitHub. A chave SSH criada só consegue executar o `scripts/deploy.sh`: não abre terminal na VPS.

## Passo 2 — cadastrar os Secrets no GitHub

No repositório: **Settings → Secrets and variables → Actions → New repository secret**.
Crie exatamente estes, com o que o script mostrou:

| Secret | Valor |
|---|---|
| `VPS_HOST` | IP da VPS |
| `VPS_USER` | `deploy` |
| `VPS_SSH_KEY` | a chave privada inteira (de `-----BEGIN` até `END-----`) |
| `VPS_KNOWN_HOSTS` | as linhas de "known hosts" (identidade da VPS) |
| `VPS_PORT` | opcional, só se o SSH não for na porta 22 |

Opcional e recomendado: em **Settings → Environments → production**, marque *Required reviewers*
para cada deploy pedir sua aprovação antes de publicar.

## Passo 3 — primeiro deploy

Em **Actions → ci → Run workflow** (branch `main`), ou faça qualquer push na `main`.
Acompanhe o job **deploy**. Depois, crie o seu acesso ao painel da plataforma (na VPS):

```bash
cd /opt/gestao360
```

```bash
sudo -u deploy docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm -e PLATFORM_ADMIN_PASSWORD='uma-senha-longa-de-verdade' api-platform npx tsx scripts/create-platform-admin.ts voce@suaempresa.com.br "Seu Nome" superadmin
```

Cadastre a chave mostrada no app autenticador e guarde os códigos de recuperação.

* App dos clientes: `https://SEU-DOMINIO`
* Painel da plataforma: `https://SEU-DOMINIO/admin`

## Passo 4 — produção com Stripe (quando for vender)

1. Em `/opt/gestao360/.env` (na VPS): `NODE_ENV=production`, `BILLING_PROVIDER=stripe`,
   `ENABLE_FAKE_CHECKOUT=false`, `STRIPE_SECRET_KEY=sk_live_...`.
2. Na Stripe, crie os preços dos planos e um webhook para `https://SEU-DOMINIO/api/webhooks/billing`
   (eventos `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`,
   `invoice.payment_failed`). Coloque o *Signing secret* em `BILLING_WEBHOOK_SECRET`.
3. Ligue cada plano ao preço da Stripe (na VPS):
   ```bash
   cd /opt/gestao360 && sudo -u deploy docker compose exec -T postgres psql -U postgres -d gestao360 -c "UPDATE plans SET gateway_price_id = 'price_...' WHERE code = 'pro';"
   ```
4. Rode o workflow de novo (Passo 3) para reiniciar com a configuração nova.

## Operação

| Tarefa | Comando (na VPS, em `/opt/gestao360`) |
|---|---|
| Ver o que está rodando | `sudo -u deploy docker compose -f docker-compose.yml -f docker-compose.prod.yml ps` |
| Logs da API | `sudo -u deploy docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f api` |
| Publicar um commit à mão | `sudo -u deploy scripts/deploy.sh <sha-completo-do-commit>` |
| Backup do banco | `sudo -u deploy docker compose exec -T postgres pg_dump -U postgres gestao360 \| gzip > backup-$(date +%F).sql.gz` |

**Cuidados**

* **Migrations não voltam atrás.** Se um deploy com migration nova falhar no `/health`, o script volta
  o código, mas o banco continua migrado. Escreva migrations que funcionem com a versão anterior do código.
* **Backup diário fora da VPS** (ex.: `pg_dump` num cron enviando para um bucket). Sem isso, perder a VPS
  é perder os dados dos clientes.
* O painel `/admin` fica público, protegido por senha + MFA. Para fechar mais, restrinja por IP no Caddy
  ou publique o painel num subdomínio atrás de VPN.
* O `.env` da VPS é o único lugar com as senhas reais. Guarde uma cópia em um cofre (1Password, Bitwarden).
