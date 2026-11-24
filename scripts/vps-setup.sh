#!/usr/bin/env bash
# Preparação ÚNICA de uma VPS Ubuntu 22.04/24.04 para o Gestão 360°.
# Rode como root na VPS:
#   curl -fsSLO https://raw.githubusercontent.com/ViniciusSolon/gestao360/main/scripts/vps-setup.sh
#   sudo bash vps-setup.sh --domain crm.suaempresa.com.br --host 203.0.113.10 --mode homologacao
#
# --domain  domínio que já aponta (registro A) para o IP desta VPS
# --host    IP ou nome que o GitHub Actions vai usar para conectar por SSH
# --mode    homologacao (pagamento simulado, para testar)  |  producao (Stripe)
#
# O que faz: instala Docker, git e firewall (22/80/443); cria o usuário "deploy";
# baixa o projeto em /opt/gestao360; gera o .env com senhas aleatórias; cria a
# chave SSH que o GitHub usa (presa ao scripts/deploy.sh) e mostra, UMA vez, os
# valores a cadastrar nos Secrets do GitHub.
set -euo pipefail

REPO_URL="https://github.com/ViniciusSolon/gestao360.git"
APP_DIR="/opt/gestao360"
DEPLOY_USER="deploy"

main() {
  local domain="" host="" mode=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain) domain="${2:-}"; shift 2 ;;
      --host) host="${2:-}"; shift 2 ;;
      --mode) mode="${2:-}"; shift 2 ;;
      *) echo "opção desconhecida: $1" >&2; exit 2 ;;
    esac
  done
  [[ $EUID -eq 0 ]] || { echo "Rode como root (sudo)." >&2; exit 1; }
  [[ "$domain" =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || { echo "--domain inválido" >&2; exit 2; }
  [[ -n "$host" ]] || { echo "--host é obrigatório (IP público da VPS)" >&2; exit 2; }
  [[ "$mode" == "homologacao" || "$mode" == "producao" ]] || { echo "--mode homologacao|producao" >&2; exit 2; }

  echo "==> Pacotes do sistema"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q ca-certificates curl git ufw openssl

  if ! command -v docker >/dev/null 2>&1; then
    echo "==> Instalando Docker (repositório oficial)"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -q
    apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  systemctl enable --now docker

  echo "==> Firewall: SSH, HTTP e HTTPS"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null

  echo "==> Usuário $DEPLOY_USER"
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$DEPLOY_USER"
  fi
  # Atenção: o grupo docker equivale a root na máquina. A chave do GitHub fica presa
  # ao deploy.sh (abaixo), então ela não ganha um shell com esse poder.
  usermod -aG docker "$DEPLOY_USER"

  echo "==> Código em $APP_DIR"
  if [[ ! -d "$APP_DIR/.git" ]]; then
    git clone --quiet "$REPO_URL" "$APP_DIR"
  fi
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"
  chmod +x "$APP_DIR/scripts/deploy.sh"

  local envfile="$APP_DIR/.env"
  if [[ -f "$envfile" ]]; then
    echo "==> .env já existe: mantido como está"
  else
    echo "==> Gerando .env ($mode)"
    local node_env="production" provider="stripe" fake="false"
    if [[ "$mode" == "homologacao" ]]; then node_env="development"; provider="fake"; fake="true"; fi
    umask 077
    cat > "$envfile" <<EOF
# Gerado por vps-setup.sh em $(date -u +%F). Fica SÓ nesta VPS; nunca vai para o GitHub.
DOMAIN=$domain
WEB_ORIGINS=https://$domain
APP_PUBLIC_URL=https://$domain
NODE_ENV=$node_env
BILLING_PROVIDER=$provider
ENABLE_FAKE_CHECKOUT=$fake
# producao: cole a chave secreta da Stripe (sk_live_... ou sk_test_...)
STRIPE_SECRET_KEY=
POSTGRES_SUPERUSER_PASSWORD=$(openssl rand -hex 24)
DB_OWNER_PASSWORD=$(openssl rand -hex 24)
DB_APP_PASSWORD=$(openssl rand -hex 24)
DB_PLATFORM_PASSWORD=$(openssl rand -hex 24)
# producao: troque pelo "Signing secret" (whsec_...) do webhook criado na Stripe
BILLING_WEBHOOK_SECRET=$(openssl rand -hex 24)
PLATFORM_MFA_KEY=$(openssl rand -hex 32)
EOF
    chown "$DEPLOY_USER:$DEPLOY_USER" "$envfile"
    chmod 600 "$envfile"
  fi

  echo "==> Chave SSH do GitHub Actions"
  local home ssh_dir keyfile
  home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  ssh_dir="$home/.ssh"
  keyfile="$(mktemp -d)/gh-deploy"
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$ssh_dir"
  ssh-keygen -q -t ed25519 -N "" -C "github-actions-gestao360" -f "$keyfile"
  # A chave só pode executar o deploy.sh: sem shell, sem túnel, sem encaminhamento.
  printf 'command="%s/scripts/deploy.sh",restrict %s\n' "$APP_DIR" "$(cat "$keyfile.pub")" >> "$ssh_dir/authorized_keys"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$ssh_dir/authorized_keys"
  chmod 600 "$ssh_dir/authorized_keys"

  local known_hosts=""
  for f in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub /etc/ssh/ssh_host_rsa_key.pub; do
    [[ -f "$f" ]] && known_hosts+="$host $(cut -d' ' -f1,2 "$f")"$'\n'
  done

  cat <<EOF

=====================================================================
 Cadastre no GitHub: Settings → Secrets and variables → Actions →
 aba "Secrets" → New repository secret
=====================================================================
 VPS_HOST         $host
 VPS_USER         $DEPLOY_USER
 VPS_KNOWN_HOSTS  (as linhas entre as marcas abaixo)
-----8<-----
${known_hosts}-----8<-----
 VPS_SSH_KEY      (a chave privada inteira, incluindo BEGIN/END)
-----8<-----
$(cat "$keyfile")
-----8<-----
 Esta chave privada NÃO fica salva na VPS e não será mostrada de novo.
=====================================================================
EOF
  shred -u "$keyfile" 2>/dev/null || rm -f "$keyfile"
  rm -f "$keyfile.pub"
  rmdir "$(dirname "$keyfile")" 2>/dev/null || true

  if [[ "$mode" == "producao" ]]; then
    echo "Modo producao: preencha STRIPE_SECRET_KEY e BILLING_WEBHOOK_SECRET em $envfile antes do primeiro deploy."
  fi
  echo "Pronto. O primeiro deploy acontece no próximo push na main (ou rode o workflow 'ci' manualmente)."
}

main "$@"
