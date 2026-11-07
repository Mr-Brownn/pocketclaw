import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { runShell } from "./shell.ts";
import { getActiveTools } from "./tools.ts";
import type { ApprovalRequest } from "./tools.ts";
import { Agent, formatEvent } from "./agent.ts";
import { TelegramBot } from "./telegram.ts";
import { runChat } from "./chat.ts";
import { addTask, describeTask, loadTasks, removeTask } from "./scheduler.ts";
import { getConfig, maskSecret, parseAllowedChatIds } from "./config.ts";
import { getMCPManager } from "./mcp.ts";
import { closeMemoryStore } from "./memory.ts";
import { VERSION, errMsg, initTimezone } from "./utils.ts";

/** sysexits.h EX_CONFIG: the launcher treats this as "do not restart, fix the configuration". */
const EXIT_CONFIG = 78;

const USAGE = `pocketclaw ${VERSION} — agent shell & engine for Termux & Node.js

Usage:
  pocketclaw                                   open the interactive chat (same as: pocketclaw chat)
  pocketclaw chat [--resume] [--yes]           interactive chat with streaming, slash commands and approvals
  pocketclaw agent '<prompt>' [--yes]          run the agent once (use - to read the prompt from stdin)
  pocketclaw exec '<command>' [--timeout ms]   run a shell command
  pocketclaw start                             start the Telegram bot daemon (also runs scheduled tasks)
  pocketclaw schedule [list]                   show scheduled tasks
  pocketclaw schedule add '<when>' '<text>'    add a reminder        e.g. add 'in 20m' 'stretch'
  pocketclaw schedule agent '<when>' '<prompt>' add an autonomous task e.g. agent 'daily 08:00' 'battery report'
  pocketclaw schedule rm <id>                  remove a task
  pocketclaw install-shortcut                  (Termux) install the 'pocketclaw' command into $PREFIX/bin
  pocketclaw config | tools [--json] | prompt | version | help

Options: --yes auto-approves risky actions (use with care); --resume continues the last chat.

Environment:
  LLM_API_KEY               API key for the LLM provider (required for chat/agent/start)
  LLM_BASE_URL, LLM_MODEL   provider URL (https) and model name
  TELEGRAM_BOT_TOKEN        bot token (required for start)
  TELEGRAM_ALLOWED_CHAT_ID  comma-separated numeric chat IDs allowed to use the bot (required for start)

Examples:
  pocketclaw exec 'id -u'
  pocketclaw agent 'Check device memory and battery status'
  echo 'summarise ~/notes.txt' | pocketclaw agent -`;

function makeCliConfirm(autoApprove: boolean): ((req: ApprovalRequest) => Promise<boolean>) | undefined {
  if (autoApprove) return async () => true;
  if (!process.stdin.isTTY) return undefined; // no human to ask: risky actions are blocked
  return async (req) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await rl.question(
        `\n🔐 Approval needed${req.reason ? ` (${req.reason})` : ""}:\n   ${req.summary}\n   Approve? [y/N] `
      );
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? (process.stdin.isTTY ? "chat" : "help");

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(VERSION);
    return 0;
  }

  if (command === "prompt") {
    console.log(SYSTEM_PROMPT);
    return 0;
  }

  if (command === "tools") {
    console.log(JSON.stringify(getActiveTools(), null, 2));
    return 0;
  }

  if (command === "config") {
    const cfg = getConfig();
    console.log(JSON.stringify({ ...cfg, apiKey: maskSecret(cfg.apiKey) }, null, 2));
    return 0;
  }

  if (command === "chat") {
    return runChat({
      resume: argv.includes("--resume") || argv.includes("-r"),
      autoApprove: argv.includes("--yes"),
    });
  }

  if (command === "install-shortcut") {
    const prefix = process.env.PREFIX ?? "/data/data/com.termux/files/usr";
    const bin = join(prefix, "bin");
    if (!existsSync(bin)) {
      console.error("error: this does not look like Termux ($PREFIX/bin not found)");
      return 1;
    }
    const cli = fileURLToPath(import.meta.url);
    const script =
      `#!${join(bin, "sh")}\n` +
      "# Installed by `pocketclaw install-shortcut`. Loads your secrets, then runs PocketClaw.\n" +
      'ENV_FILE="${POCKETCLAW_ENV_FILE:-$HOME/.pocketclaw/env}"\n' +
      '[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }\n' +
      `exec node ${shq(cli)} "$@"\n`;
    const target = join(bin, "pocketclaw");
    // An existing `pocketclaw` is often a symlink to dist/cli.js (npm link): writing through it would overwrite
    // the program itself, so remove whatever is there first and create a plain file.
    rmSync(target, { force: true });
    writeFileSync(target, script, { mode: 0o755, flag: "wx" });
    chmodSync(target, 0o755);
    console.log(`Installed ${target}\nNow just type: pocketclaw`);
    return 0;
  }

  if (command === "schedule") {
    initTimezone();
    const sub = argv[1] ?? "list";
    if (sub === "list") {
      const tasks = loadTasks();
      console.log(tasks.length ? tasks.map(describeTask).join("\n") : "No scheduled tasks.");
      console.log("Tasks run while the bot daemon (`pocketclaw start`) is running and are delivered to Telegram.");
      return 0;
    }
    if (sub === "rm" || sub === "remove") {
      const id = argv[2] ?? "";
      if (!removeTask(id)) {
        console.error(`error: no scheduled task with id "${id}"`);
        return 1;
      }
      console.log(`Removed ${id}.`);
      return 0;
    }
    if (sub === "add" || sub === "agent") {
      const [when, ...textParts] = argv.slice(2);
      const text = textParts.join(" ");
      if (!when || !text) {
        console.error(`usage: pocketclaw schedule ${sub} '<when>' '<${sub === "agent" ? "prompt" : "text"}>'`);
        return 2;
      }
      try {
        console.log(`Scheduled: ${describeTask(addTask({ kind: sub === "agent" ? "agent" : "reminder", spec: when, text }))}`);
        return 0;
      } catch (error) {
        console.error(`error: ${errMsg(error)}`);
        return 1;
      }
    }
    console.error("usage: pocketclaw schedule [list | add '<when>' '<text>' | agent '<when>' '<prompt>' | rm <id>]");
    return 2;
  }

  if (command === "exec") {
    // `--timeout` may appear anywhere; everything else is the command.
    const words: string[] = [];
    let rawTimeout: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--timeout") rawTimeout = argv[++i];
      else words.push(argv[i] ?? "");
    }
    const cmd = words.join(" ").trim();
    if (!cmd) {
      console.error("error: command required\n");
      console.log(USAGE);
      return 2;
    }
    const timeout = rawTimeout === undefined ? 30_000 : Number(rawTimeout);
    if (!Number.isFinite(timeout) || timeout < 1_000) {
      console.error("error: --timeout must be a number of milliseconds >= 1000");
      return 2;
    }

    const result = await runShell(cmd, timeout);
    console.log(JSON.stringify(result, null, 2));
    if (result.timed_out) return 124;
    return result.exit_code ?? 1;
  }

  if (command === "agent") {
    const autoApprove = argv.includes("--yes");
    let prompt = argv
      .slice(1)
      .filter((a) => a !== "--yes")
      .join(" ")
      .trim();
    if (prompt === "-") prompt = (await readStdin()).trim();
    if (!prompt) {
      console.error("error: prompt required\n");
      return 2;
    }

    initTimezone();
    const controller = new AbortController();
    const onSigint = (): void => controller.abort();
    process.once("SIGINT", onSigint);

    try {
      await getMCPManager().initialize();
      const agent = new Agent();
      console.log("⚡ Running PocketClaw Agent...");
      let streamed = false;
      const result = await agent.run(prompt, {
        signal: controller.signal,
        stream: true,
        confirm: makeCliConfirm(autoApprove),
        onEvent: (event) => {
          if (event.type === "text_delta") {
            streamed = true;
            process.stdout.write(event.text);
          } else if (event.type === "thinking") {
            if (streamed) process.stdout.write("\n");
            streamed = false;
          } else if (event.type !== "narration" || !streamed) {
            console.log(`  ${formatEvent(event)}`);
          }
        },
      });
      if (streamed) process.stdout.write("\n");
      else {
        console.log("\n--- AGENT RESPONSE ---");
        console.log(result);
      }
      return controller.signal.aborted ? 130 : 0;
    } finally {
      process.off("SIGINT", onSigint);
    }
  }

  if (command === "start") {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      console.error("error: TELEGRAM_BOT_TOKEN environment variable is required to start the Telegram daemon");
      return EXIT_CONFIG;
    }
    let allowedChatIds: number[];
    try {
      allowedChatIds = parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_ID);
    } catch (error) {
      console.error(`error: ${errMsg(error)}`);
      return EXIT_CONFIG;
    }
    if (allowedChatIds.length === 0) {
      console.error(
        "error: TELEGRAM_ALLOWED_CHAT_ID is required. The bot can run shell commands, so it refuses to start without an allowlist.\n" +
          "       Set it to your numeric Telegram chat ID (message @userinfobot to find it); use commas for several."
      );
      return EXIT_CONFIG;
    }
    if (!getConfig().apiKey) {
      console.warn("warning: LLM_API_KEY is not set; chatting with the agent will fail until it is (slash commands still work).");
    }

    console.log(`time zone: ${initTimezone()}`);
    process.on("unhandledRejection", (reason) => console.error(`[unhandledRejection] ${errMsg(reason)}`));
    const bot = new TelegramBot({ botToken, allowedChatIds });
    await bot.startPolling();
    return 0;
  }

  console.error(`error: unknown command "${command}"\n`);
  console.log(USAGE);
  return 2;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${errMsg(error)}`);
  process.exitCode = 1;
} finally {
  getMCPManager().stopAll();
  await closeMemoryStore();
}
