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

  # Chave privada: aproveita só o trecho BEGIN…END (descarta marcas -----8<----- e texto
  # em volta), tira \r/espaços e, se veio tudo numa linha só, remonta as quebras de linha.
  local raw
  raw="$(printf '%s\n' "${VPS_SSH_KEY:-}" | tr -d '\r')"
  if [[ "$(printf '%s\n' "$raw" | grep -c 'PRIVATE KEY-----')" -eq 1 ]]; then
    # BEGIN e END na mesma linha: o corpo veio separado por espaços
    raw="$(printf '%s\n' "$raw" | grep 'PRIVATE KEY-----' \
      | sed -E 's/.*(-----BEGIN [A-Z ]*PRIVATE KEY-----)(.*)(-----END [A-Z ]*PRIVATE KEY-----).*/\1\n\2\n\3/' \
      | awk 'NR==2 { gsub(/[[:space:]]+/, "\n") } { print }')"
  fi
  printf '%s\n' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    | sed -n '/^-----BEGIN [A-Z ]*PRIVATE KEY-----$/,/^-----END [A-Z ]*PRIVATE KEY-----$/p' \
    | grep -v '^$' > "$dir/deploy_key" || true
  chmod 600 "$dir/deploy_key"
  # -P '' e </dev/null: nunca pede senha (no CI o job ficaria travado esperando)
  if ! ssh-keygen -y -P '' -f "$dir/deploy_key" >/dev/null 2>&1 </dev/null; then
    # Diagnóstico do FORMATO (nunca o conteúdo)
    local why="o conteúdo entre BEGIN e END está incompleto ou alterado — copie de novo a chave inteira"
    if printf '%s' "${VPS_SSH_KEY:-}" | grep -qE '^[[:space:]]*(ssh-ed25519|ssh-rsa|ecdsa-sha2)'; then
      why="foi colada a chave PÚBLICA (começa com ssh-ed25519). Use a PRIVADA, que começa com -----BEGIN OPENSSH PRIVATE KEY-----"
    elif ! printf '%s' "${VPS_SSH_KEY:-}" | grep -q 'BEGIN [A-Z ]*PRIVATE KEY'; then
      why="não encontrei a linha -----BEGIN OPENSSH PRIVATE KEY-----"
    elif ! printf '%s' "${VPS_SSH_KEY:-}" | grep -q 'END [A-Z ]*PRIVATE KEY'; then
      why="não encontrei a linha -----END OPENSSH PRIVATE KEY----- (a cópia foi cortada no fim)"
    elif [[ "$(ssh-keygen -y -P '' -f "$dir/deploy_key" 2>&1 </dev/null || true)" == *passphrase* ]]; then
      why="a chave tem senha (passphrase); o deploy precisa de uma chave sem senha"
    fi
    echo "::error::VPS_SSH_KEY inválida: $why. ($(wc -l < "$dir/deploy_key") linha(s) entre BEGIN e END.)"
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
