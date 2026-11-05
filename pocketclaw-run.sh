#!/data/data/com.termux/files/usr/bin/sh
# PocketClaw launcher / supervisor.
#
# Secrets are NOT stored in this file. Put them in ~/.pocketclaw/env (chmod 600), see env.example:
#   LLM_API_KEY=...
#   TELEGRAM_BOT_TOKEN=...
#   TELEGRAM_ALLOWED_CHAT_ID=123456789
#
# Usage:  sh pocketclaw-run.sh [start]          supervise the Telegram bot (restarts on crashes)
#         sh pocketclaw-run.sh agent 'prompt'   any other pocketclaw command, run once

export PATH=/data/data/com.termux/files/usr/bin:$PATH
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${POCKETCLAW_ENV_FILE:-$HOME/.pocketclaw/env}"
# Fall back to an `env` file next to this script (gitignored).
if [ ! -f "$ENV_FILE" ] && [ -f "$APP_DIR/env" ]; then
  ENV_FILE="$APP_DIR/env"
fi
CLI="$APP_DIR/dist/cli.js"

if [ -f "$ENV_FILE" ]; then
  perms=$(stat -c %a "$ENV_FILE" 2>/dev/null)
  case "$perms" in
    600|400) ;;
    *) echo "[pocketclaw-runner] warning: $ENV_FILE is mode ${perms:-?}; run: chmod 600 \"$ENV_FILE\"" >&2 ;;
  esac
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

if [ ! -f "$CLI" ]; then
  echo "[pocketclaw-runner] $CLI not found. Build first: cd \"$APP_DIR\" && npm install && npm run build" >&2
  exit 1
fi

CMD="${1:-start}"
if [ "$CMD" != "start" ]; then
  exec node "$CLI" "$@"
fi

child=""
trap 'echo "[pocketclaw-runner] stopping"; [ -n "$child" ] && kill "$child" 2>/dev/null; exit 0' INT TERM

echo "[pocketclaw-runner] starting Telegram bot daemon"
while true; do
  node "$CLI" start &
  child=$!
  wait "$child"
  code=$?
  case "$code" in
    0|2|78)
      # 0 = clean shutdown, 2 = usage error, 78 = configuration error: restarting cannot help.
      echo "[pocketclaw-runner] bot exited with code $code; not restarting"
      exit "$code"
      ;;
  esac
  echo "[pocketclaw-runner] bot exited with code $code; restarting in 5s"
  sleep 5
done
