import { createInterface } from "node:readline/promises";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { runShell } from "./shell.ts";
import { TOOLS } from "./tools.ts";
import type { ApprovalRequest } from "./tools.ts";
import { Agent, formatEvent } from "./agent.ts";
import { TelegramBot } from "./telegram.ts";
import { getConfig, maskSecret, parseAllowedChatIds } from "./config.ts";
import { getMCPManager } from "./mcp.ts";
import { closeMemoryStore } from "./memory.ts";
import { VERSION, errMsg } from "./utils.ts";

/** sysexits.h EX_CONFIG: the launcher treats this as "do not restart, fix the configuration". */
const EXIT_CONFIG = 78;

const USAGE = `pocketclaw ${VERSION} — agent shell & engine for Termux & Node.js

Usage:
  pocketclaw exec '<command>' [--timeout ms]   run a shell command
  pocketclaw agent '<prompt>' [--yes]          run the autonomous LLM agent (--yes auto-approves risky actions)
  pocketclaw start                             start the Telegram bot daemon
  pocketclaw config                            show the active configuration
  pocketclaw prompt                            print the system prompt
  pocketclaw tools [--json]                    print available tool schemas
  pocketclaw version                           print the version
  pocketclaw help                              show this message

Environment:
  LLM_API_KEY               API key for the LLM provider (required for agent/start)
  LLM_BASE_URL, LLM_MODEL   provider URL (https) and model name
  TELEGRAM_BOT_TOKEN        bot token (required for start)
  TELEGRAM_ALLOWED_CHAT_ID  comma-separated numeric chat IDs allowed to use the bot (required for start)

Examples:
  pocketclaw exec 'id -u'
  pocketclaw exec "su -c 'input tap 500 500'" --timeout 5000
  pocketclaw agent 'Check device memory and battery status'`;

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

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? "help";

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
    console.log(JSON.stringify(TOOLS, null, 2));
    return 0;
  }

  if (command === "config") {
    const cfg = getConfig();
    console.log(
      JSON.stringify({ ...cfg, apiKey: maskSecret(cfg.apiKey) }, null, 2)
    );
    return 0;
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
    const prompt = argv
      .slice(1)
      .filter((a) => a !== "--yes")
      .join(" ")
      .trim();
    if (!prompt) {
      console.error("error: prompt required\n");
      return 2;
    }

    const controller = new AbortController();
    const onSigint = (): void => controller.abort();
    process.once("SIGINT", onSigint);

    try {
      await getMCPManager().initialize();
      const agent = new Agent();
      console.log("⚡ Running PocketClaw Agent...");
      const result = await agent.run(prompt, {
        signal: controller.signal,
        confirm: makeCliConfirm(autoApprove),
        onEvent: (event) => {
          console.log(`  ${formatEvent(event)}`);
        },
      });
      console.log("\n--- AGENT RESPONSE ---");
      console.log(result);
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
