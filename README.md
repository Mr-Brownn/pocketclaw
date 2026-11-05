# PocketClaw 3.0

Autonomous agent engine for Termux on Android (also runs on any Node 22.5+ machine). A ReAct loop calls an OpenAI-compatible chat API and acts through tools: shell, file read/write/patch, a SQLite memory vault, multi-file skills and MCP servers. It can be driven from the CLI or from a Telegram bot.

## Setup

```sh
npm install
npm run build
mkdir -p ~/.pocketclaw && cp env.example ~/.pocketclaw/env && chmod 600 ~/.pocketclaw/env
# edit ~/.pocketclaw/env: LLM_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_ID
sh pocketclaw-run.sh            # supervised Telegram bot
node dist/cli.js agent 'Check device memory and battery status'
```

**Secrets are never stored in the code or the launcher scripts.** `LLM_API_KEY` and `TELEGRAM_BOT_TOKEN` come from the environment (the launcher loads `~/.pocketclaw/env`). The API key is never written to `config.json`. The secrets are also stripped from the environment of every shell command and MCP server the agent starts.

## CLI

| Command | What it does |
| --- | --- |
| `pocketclaw exec '<cmd>' [--timeout ms]` | run a shell command (JSON result, exit code propagated) |
| `pocketclaw agent '<prompt>' [--yes]` | run the agent; prints live tool narration. `--yes` auto-approves risky actions |
| `pocketclaw start` | start the Telegram bot (requires an allowlist) |
| `pocketclaw config` / `tools` / `prompt` / `version` | inspect configuration, tool schemas, system prompt |

## Telegram bot

`TELEGRAM_ALLOWED_CHAT_ID` is **required** (comma-separated numeric IDs); the bot refuses to start without it because it can run shell commands. Messages sent while the bot was offline are ignored on start.

- **Live narration:** while the agent works, one status message is edited in place showing each step ("🛠️ Running shell command…" → "✅ exit 0 · …"), with a ⏹ Stop button. The typing indicator stays on for the whole task.
- **Buttons:** `/menu` opens a control panel (Config, Model, Skills, MCP, Status, New session, Stop). `/config` has buttons for approval mode, max turns and shell timeout; `/model` lists model buttons; risky actions show ✅ Approve / ❌ Deny buttons.
- **Commands:** `/menu` `/config` `/model [name]` `/skills` `/mcp` `/status` `/stop` `/reset` `/resetconfig` `/set <key> <value>` `/exec <cmd>`.
- Long replies are split to fit Telegram's limits; chats run independently and a task can be stopped at any time.
- `/set apiKey …` applies for the running process only (your message is deleted); it is never saved to disk.

## Safety model

- **Approval modes** (`confirmMode`): `dangerous` (default) asks before risky shell commands (recursive deletes, reboot, `curl | sh`, reading credentials, ...), writes outside home/shared storage, edits to credential or shell-startup files, skill deletion and MCP installs. `always` asks before every shell command and file change. `never` disables prompts. Only the user can change this, not the agent.
- Without an approval channel (e.g. a non-interactive CLI run) risky actions are **blocked**, not allowed.
- This is a guard against mistakes and prompt injection, **not a sandbox**: the agent has a real shell, and pattern matching can be bypassed. Run it as an unprivileged user and keep the allowlist tight.
- The agent cannot change the provider URL or API key, and `baseUrl` must be `https://` (plain `http://` only for localhost).
- Memory refuses to store things that look like passwords, PINs, tokens or keys (it is plaintext on disk).

## Configuration

Precedence: `~/.pocketclaw/config.json` (changed via `/set`, buttons or `set_config`) > environment (`LLM_MODEL`, `LLM_BASE_URL`) > defaults. `config.json` may also contain `"modelChoices": [...]` to customise the model buttons. All files under `~/.pocketclaw/` are created private (`0600`/`0700`).

| Key | Default | Notes |
| --- | --- | --- |
| `model` | `nvidia/nemotron-3-ultra-550b-a55b` | |
| `baseUrl` | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible, https |
| `maxTurns` | 15 | 1-50 |
| `shellTimeout` | 30000 | ceiling in ms (1000-300000) for any single command |
| `confirmMode` | `dangerous` | `dangerous` / `always` / `never` |

## Development

```sh
npm run typecheck   # tsc
npm run smoke       # build + CLI/security checks
npm run dev -- help # run from source (Node with type stripping)
```
