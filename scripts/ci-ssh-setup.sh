#!/usr/bin/env bash
# Prepara ~/.ssh no runner do GitHub Actions a partir dos secrets e diagnostica
# problemas SEM imprimir nenhum valor (os logs de repositório público são públicos).
#
# Entrada (variáveis de ambiente): VPS_HOST, VPS_USER, VPS_PORT (opcional),
# VPS_SSH_KEY, VPS_KNOWN_HOSTS. SSH_DIR opcional (padrão ~/.ssh).
# Saída: arquivos deploy_key e known_hosts, e o arquivo "target" com HOST PORT USER.
set -euo pipefail

main() {
  local dir="${SSH_DIR:-$HOME/.ssh}"
  install -m 700 -d "$dir"

  # Limpa o que costuma vir junto ao copiar do terminal: \r, espaços nas pontas
  local host user port
  host="$(printf '%s' "${VPS_HOST:-}" | tr -d '\r' | xargs)"
  user="$(printf '%s' "${VPS_USER:-}" | tr -d '\r' | xargs)"
  port="$(printf '%s' "${VPS_PORT:-}" | tr -d '\r' | xargs)"
  port="${port:-22}"

  local fail=0
  [[ -n "$host" ]] || { echo "::error::VPS_HOST está vazio"; fail=1; }
  [[ -n "$user" ]] || { echo "::error::VPS_USER está vazio"; fail=1; }
  [[ "$port" =~ ^[0-9]+$ ]] || { echo "::error::VPS_PORT precisa ser só o número da porta"; fail=1; }
  [[ "$host" =~ [[:space:]@] ]] && { echo "::error::VPS_HOST deve ser só o IP ou nome (sem espaços, sem usuário@)"; fail=1; }

  # Chave privada: remove \r e espaços nas pontas de cada linha
  printf '%s\n' "${VPS_SSH_KEY:-}" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -v '^$' > "$dir/deploy_key" || true
  chmod 600 "$dir/deploy_key"
  if ! ssh-keygen -y -f "$dir/deploy_key" >/dev/null 2>&1; then
    echo "::error::VPS_SSH_KEY não é uma chave privada válida. Cole da linha -----BEGIN até a linha -----END, inclusive."
    fail=1
  fi

  # known_hosts: remove \r, espaços nas pontas, linhas vazias e as marcas -----8<-----
  printf '%s\n' "${VPS_KNOWN_HOSTS:-}" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    | grep -v '^-----' | grep -v '^$' | grep -v '^#' > "$dir/known_hosts" || true

  local expected="$host"
  [[ "$port" != "22" ]] && expected="[$host]:$port"

  # Diagnóstico linha a linha: só o FORMATO, nunca o valor
  local n=0 line first type shape match
  while IFS= read -r line; do
    n=$((n + 1))
    first="${line%% *}"
    type="$(printf '%s' "$line" | awk '{print $2}')"
    case "$first" in
      '|1|'*) shape="hash" ;;
      '['*']:'*) shape="[host]:porta" ;;
      *[!0-9.]*) if [[ "$first" == *:* ]]; then shape="IPv6"; else shape="nome"; fi ;;
      *) shape="IPv4" ;;
    esac
    if ssh-keygen -F "$expected" -f <(printf '%s\n' "$line") >/dev/null 2>&1; then match="sim"; else match="NÃO"; fi
    echo "known_hosts linha $n: tipo=${type:-?} começo=$shape bate_com_VPS_HOST=$match"
  done < "$dir/known_hosts"

  if [[ $n -eq 0 ]]; then
    echo "::error::VPS_KNOWN_HOSTS está vazio"
    fail=1
  elif ! ssh-keygen -F "$expected" -f "$dir/known_hosts" >/dev/null 2>&1; then
    local hint="o começo de cada linha precisa ser exatamente igual ao VPS_HOST"
    if [[ "$port" != "22" ]]; then hint="com VPS_PORT=$port, cada linha precisa começar com [VPS_HOST]:$port"; fi
    if [[ "$port" == "22" ]] && grep -q '^\[' "$dir/known_hosts"; then
      hint="as linhas estão no formato [host]:porta, mas VPS_PORT não foi definido (porta 22). Cadastre VPS_PORT com a porta certa"
    fi
    echo "::error::Nenhuma linha do VPS_KNOWN_HOSTS corresponde ao VPS_HOST: $hint. Gere na VPS com: for f in /etc/ssh/ssh_host_*_key.pub; do echo \"VALOR_DO_VPS_HOST \$(cut -d' ' -f1,2 \"\$f\")\"; done"
    fail=1
  fi

  [[ $fail -eq 0 ]] || exit 1
  printf '%s %s %s\n' "$host" "$port" "$user" > "$dir/target"
  echo "SSH preparado: $n linha(s) em known_hosts, host conferido."
}

main "$@"
