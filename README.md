# PocketClaw 3.1

Autonomous agent engine for Termux on Android (also runs on any Node 22.5+ machine). A ReAct loop calls an OpenAI-compatible chat API and acts through tools: shell, file read/write/patch, a SQLite memory vault, multi-file skills, MCP servers, Termux:API device tools and scheduled tasks. Drive it from an interactive terminal chat, one-shot CLI commands, or a Telegram bot.

## Setup

```sh
npm install
npm run build
mkdir -p ~/.pocketclaw && cp env.example ~/.pocketclaw/env && chmod 600 ~/.pocketclaw/env
# edit ~/.pocketclaw/env: LLM_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_ID
node dist/cli.js install-shortcut      # Termux: adds a `pocketclaw` command to $PREFIX/bin
pocketclaw                              # opens the chat
sh pocketclaw-run.sh                    # supervised Telegram bot (also runs scheduled tasks)
```

**Secrets are never stored in the code or the launcher scripts.** `LLM_API_KEY` and `TELEGRAM_BOT_TOKEN` come from the environment (the launcher and the `pocketclaw` shortcut load `~/.pocketclaw/env`). The API key is never written to `config.json`, and secrets are stripped from the environment of every shell command and MCP server the agent starts.

## Interactive chat (`pocketclaw` / `pocketclaw chat`)

- Replies **stream** as they are written, with a spinner and a live line for every tool call (`🛠️ Running shell command…  ↳ ✓ exit 0 · …`).
- **Ctrl+C** stops the running task and keeps you in the chat; press it twice at the prompt to exit. End a line with `\` to continue it on the next line. Tab completes slash commands; the up arrow recalls history (stored privately, `/set apiKey` lines are never saved).
- **Approvals** appear inline: `y` yes, `n` no, `a` always allow this kind of action for the session.
- `/help` `/reset` `/model [name]` `/mode [dangerous|always|never]` `/config` `/set <key> <value>` `/stream [on|off]` `/skills` `/mcp` `/tools` `/status` `/exec <cmd>` `/save [name]` `/load [name]` `/sessions` `/schedule` `/clear` `/exit`.
- The conversation is auto-saved as `last` on exit; `pocketclaw chat --resume` continues it. Pipe a prompt with `echo "..." | pocketclaw agent -`.

## CLI

| Command | What it does |
| --- | --- |
| `pocketclaw` / `pocketclaw chat [--resume] [--yes]` | interactive chat |
| `pocketclaw agent '<prompt>' [--yes]` | run the agent once (streams; `-` reads the prompt from stdin) |
| `pocketclaw exec '<cmd>' [--timeout ms]` | run a shell command (JSON result, exit code propagated) |
| `pocketclaw start` | start the Telegram bot daemon (requires an allowlist) |
| `pocketclaw schedule [list \| add '<when>' '<text>' \| agent '<when>' '<prompt>' \| rm <id>]` | manage scheduled tasks |
| `pocketclaw install-shortcut` | (Termux) install the `pocketclaw` command |
| `pocketclaw config` / `tools` / `prompt` / `version` | inspect configuration, tool schemas, system prompt |

`--yes` auto-approves risky actions: use it only for tasks you trust.

## Scheduled tasks

Say it in plain language ("remind me in 20 minutes to stretch", "every weekday at 7:30 report my battery") or use `/schedule`. Two kinds: **reminders** (a message) and **agent tasks** (the agent carries out a prompt unattended). `when` is `in 20m`, `every 2h`, `daily 08:00`, `weekdays 07:30`, `mon,fri 18:00` or `at 2026-11-06 14:30`, in device local time (the Android time zone is detected automatically).

- Tasks run **while the bot daemon is running** and are delivered to Telegram; they survive restarts. A one-off that came due while the bot was offline is reported as missed instead of running late; repeating tasks just move on.
- Creating an agent task from chat needs your approval, risky actions inside it still ask (and are denied if you don't answer in 2 minutes), and a scheduled run cannot schedule further tasks.

## Device tools (Termux:API)

When the Termux:API tools are installed (`pkg install termux-api` + the Termux:API app) the agent gets `device_battery`, `device_wifi`, `device_notify`, `device_clipboard_get/set`, `device_torch`, `device_speak`, `device_vibrate`, `device_location`, `device_camera_photo` and `device_sms_send`. Arguments are validated and passed without a shell; clipboard read, location, camera and SMS need your approval. When the daemon runs as root the commands are executed as the Termux user, which is the only user the API app answers.

## Telegram bot

`TELEGRAM_ALLOWED_CHAT_ID` is **required** (comma-separated numeric IDs); the bot refuses to start without it because it can run shell commands. Messages sent while the bot was offline are ignored on start.

- **Live narration:** one status message is edited in place with each step, the model's reply as it is being written, and a ⏹ Stop button. The typing indicator stays on for the whole task.
- **Buttons:** `/menu` opens a control panel (Config, Model, Skills, MCP, Schedule, Status, New session, Stop). `/config` has buttons for approval mode, max turns and shell timeout; `/model` lists model buttons; `/schedule` lists tasks with cancel buttons; risky actions show ✅ Approve / ❌ Deny buttons.
- **Commands:** `/menu` `/config` `/model [name]` `/skills` `/mcp` `/status` `/schedule` `/remind <when> | <text>` `/stop` `/reset` `/resetconfig` `/set <key> <value>` `/exec <cmd>`.
- Long replies are split to fit Telegram's limits; chats run independently and a task can be stopped at any time. `/set apiKey …` applies for the running process only (your message is deleted).

## Safety model

- **Approval modes** (`confirmMode`): `dangerous` (default) asks before risky shell commands (recursive deletes, reboot, `curl | sh`, reading credentials, ...), writes outside home/shared storage, edits to credential or shell-startup files, skill deletion, MCP installs, agent-task scheduling and privacy-sensitive device tools. `always` asks before every shell command, file change and device action. `never` disables prompts. Only the user can change this, not the agent.
- Without an approval channel (e.g. a non-interactive CLI run) risky actions are **blocked**, not allowed.
- This is a guard against mistakes and prompt injection, **not a sandbox**: the agent has a real shell, and pattern matching can be bypassed. Keep the allowlist tight, and remember that a daemon running as root gives the agent root.
- The agent cannot change the provider URL or API key, and `baseUrl` must be `https://` (plain `http://` only for localhost).
- Memory refuses to store things that look like passwords, PINs, tokens or keys (it is plaintext on disk).
- Files under `~/.pocketclaw/` are private (`0600`/`0700`) and keep the data directory owner's ownership even when written by a root daemon.

## Configuration

Precedence: `~/.pocketclaw/config.json` (changed via `/set`, buttons or `set_config`) > environment (`LLM_MODEL`, `LLM_BASE_URL`) > defaults. `config.json` may also contain `"modelChoices": [...]` to customise the model buttons.

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
npm run smoke       # build + 32 checks (CLI, security, streaming, agent loop with a fake LLM server, scheduler, device tools)
npm run dev -- help # run from source (Node with type stripping)
```
