#!/bin/sh
# Backup do planilha-pro pra Google Drive (ou qualquer remote rclone).
# Pensado pra rodar via Dokploy Schedule (diário).
#
# Variáveis esperadas no env do container:
#   API_KEY        — chave pra autenticar no /api/backup
#   RCLONE_REMOTE  — nome da remote no rclone.conf (ex: "Joao e Maria")
#   BACKUP_PATH    — caminho remoto (ex: "planilha-pro-backups")
#   KEEP_BACKUPS   — quantos backups manter (default: 3 — atual + 2 anteriores)
#
# Requer rclone.conf montado em /root/.config/rclone/rclone.conf

set -eu

: "${API_KEY:?defina API_KEY no env}"
: "${RCLONE_REMOTE:?defina RCLONE_REMOTE no env}"
: "${BACKUP_PATH:=planilha-pro-backups}"
: "${KEEP_BACKUPS:=3}"

DATE=$(date +%Y-%m-%d_%H%M)
FILENAME="planilha-${DATE}.tar.gz"
REMOTE_PATH="${RCLONE_REMOTE}:${BACKUP_PATH}"

echo "[backup] gerando snapshot e enviando pra ${REMOTE_PATH}/${FILENAME}..."

# Stream do endpoint direto pro rclone (sem arquivo temp).
curl -fsSL -H "Authorization: Bearer ${API_KEY}" \
  http://localhost:3030/api/backup \
  | rclone rcat "${REMOTE_PATH}/${FILENAME}"

echo "[backup] upload concluído. Rotacionando (mantendo ${KEEP_BACKUPS})..."

# Lista por nome (que começa com data ISO → ordem cronológica natural),
# tira o cabeçalho, pega só o que sobra ALÉM dos KEEP_BACKUPS mais recentes
# e apaga. Usa --include pra só considerar nossos arquivos.
rclone lsf "${REMOTE_PATH}" --include "planilha-*.tar.gz" \
  | sort -r \
  | tail -n "+$((KEEP_BACKUPS + 1))" \
  | while IFS= read -r OLD; do
      [ -n "$OLD" ] || continue
      echo "[backup] removendo antigo: $OLD"
      rclone deletefile "${REMOTE_PATH}/${OLD}"
    done

echo "[backup] ok."
