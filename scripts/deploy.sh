#!/usr/bin/env bash
# Publica na VPS um commit da main. Chamado pelo GitHub Actions via SSH.
#
# A chave SSH do GitHub fica presa a este script (forced command em
# ~/.ssh/authorized_keys), então ela NÃO abre um shell na VPS: só consegue
# pedir "publique o commit X". O SHA chega em $SSH_ORIGINAL_COMMAND.
#
# Uso manual na VPS:  /opt/gestao360/scripts/deploy.sh <sha-de-40-caracteres>
#
# Tudo fica dentro de main(): o bash lê a função inteira antes de executar, então
# o "git checkout" trocar este arquivo no meio do deploy não causa problema.
set -euo pipefail

main() {
  local app_dir="${APP_DIR:-/opt/gestao360}"
  local sha="${SSH_ORIGINAL_COMMAND:-${1:-}}"
  sha="$(printf '%s' "$sha" | tr -d '[:space:]')"

  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "uso: deploy.sh <sha do commit, 40 caracteres hex>" >&2
    exit 2
  fi

  # Um deploy por vez
  exec 9>"${app_dir}/.deploy.lock"
  if ! flock -n 9; then
    echo "Outro deploy está em andamento." >&2
    exit 1
  fi

  cd "$app_dir"
  echo "==> Buscando a main"
  git fetch --quiet origin main

  # Só publica commits que estão na main (nada de branch qualquer)
  if ! git merge-base --is-ancestor "$sha" origin/main; then
    echo "O commit $sha não está na main. Abortando." >&2
    exit 1
  fi

  local previous
  previous="$(git rev-parse HEAD)"
  echo "==> Publicando $sha (antes: $previous)"
  git checkout --quiet --detach "$sha"

  local compose=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)
  # "up" roda bootstrap e migrations antes de subir a API (depends_on no compose)
  if ! "${compose[@]}" up -d --build --remove-orphans; then
    echo "==> Falhou ao subir. Voltando para $previous" >&2
    git checkout --quiet --detach "$previous"
    "${compose[@]}" up -d --build --remove-orphans || true
    exit 1
  fi

  echo "==> Conferindo a saúde da API"
  local ok=""
  for _ in $(seq 1 30); do
    if "${compose[@]}" exec -T api wget -qO- http://127.0.0.1:3333/health >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 2
  done
  if [[ -z "$ok" ]]; then
    echo "==> API não respondeu em 60 s. Voltando para $previous" >&2
    "${compose[@]}" logs --tail=80 api >&2 || true
    git checkout --quiet --detach "$previous"
    "${compose[@]}" up -d --build --remove-orphans || true
    exit 1
  fi

  docker image prune -f >/dev/null 2>&1 || true
  echo "==> Publicado: $sha"
}

main "$@"
