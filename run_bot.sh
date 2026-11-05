#!/data/data/com.termux/files/usr/bin/sh
# Backwards-compatible wrapper: runs the supervisor and appends its output to ~/pocketclaw.log.
# Secrets live in ~/.pocketclaw/env (see env.example), never in this file.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec sh "$DIR/pocketclaw-run.sh" start >> "$HOME/pocketclaw.log" 2>&1
