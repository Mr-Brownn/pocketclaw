import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import * as os from "node:os";
import { join } from "node:path";
import { Agent, STOPPED_MESSAGE } from "./agent.ts";
import type { AgentEvent } from "./agent.ts";
import { runShell } from "./shell.ts";
import { assessShell } from "./policy.ts";
import { CONFIRM_MODES, getConfig, maskSecret, resetConfig, updateConfig, validateConfigValue } from "./config.ts";
import type { ConfigKey } from "./config.ts";
import { getSkillManager } from "./skills.ts";
import { getMCPManager, getMcpConfig } from "./mcp.ts";
import { getActiveTools } from "./tools.ts";
import type { ApprovalRequest } from "./tools.ts";
import { addTask, describeTask, loadTasks, removeTask } from "./scheduler.ts";
import { termuxApiAvailable } from "./termux.ts";
import { VERSION, dataDir, errMsg, initTimezone, truncate, writePrivateFile } from "./utils.ts";

// ------------------------------------------------------------------ styling

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint =
  (code: string) =>
  (s: string): string =>
    useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = paint("2");
const bold = paint("1");
const cyan = paint("36");
const green = paint("32");
const red = paint("31");
const yellow = paint("33");

const print = (s = ""): void => void process.stdout.write(`${s}\n`);

class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private index = 0;
  private timer: NodeJS.Timeout | null = null;
  private label = "";

  start(label: string): void {
    this.label = label;
    if (!useColor || this.timer) return;
    this.timer = setInterval(() => this.draw(), 90);
    this.draw();
  }

  update(label: string): void {
    this.label = label;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    process.stdout.write("\r\x1b[K");
  }

  private draw(): void {
    process.stdout.write(`\r\x1b[K${cyan(this.frames[this.index++ % this.frames.length] ?? "")} ${dim(this.label)}`);
  }
}

// -------------------------------------------------------- sessions & history

const SESSION_NAME = /^[A-Za-z0-9._-]{1,40}$/;

function sessionsDir(): string {
  return join(dataDir(), "sessions");
}

function sessionFile(name: string): string {
  if (!SESSION_NAME.test(name)) throw new Error("Session names use letters, digits, '.', '_' and '-' (max 40 characters)");
  return join(sessionsDir(), `${name}.json`);
}

function saveSession(name: string, agent: Agent): number {
  const messages = agent.getHistory().filter((m) => m.role !== "system");
  writePrivateFile(sessionFile(name), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), messages }));
  return messages.length;
}

function loadSession(name: string, agent: Agent): number {
  const file = sessionFile(name);
  if (!existsSync(file)) throw new Error(`No saved session called "${name}"`);
  const data = JSON.parse(readFileSync(file, "utf8")) as { messages?: unknown };
  return agent.loadHistory(data.messages);
}

function listSessions(): Array<{ name: string; when: string }> {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ name: f.slice(0, -5), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((s) => ({ name: s.name, when: new Date(s.mtime).toLocaleString() }));
}

const HISTORY_FILE = (): string => join(dataDir(), "chat_history");

function loadInputHistory(): string[] {
  try {
    if (process.env.POCKETCLAW_NO_HISTORY) return [];
    return readFileSync(HISTORY_FILE(), "utf8").split("\n").filter(Boolean).reverse(); // newest first
  } catch {
    return [];
  }
}

function saveInputHistory(lines: string[]): void {
  if (process.env.POCKETCLAW_NO_HISTORY) return;
  // Never persist a line that contains a secret the user pasted.
  const safe = lines.filter((l) => !/^\/set\s+apikey\b/i.test(l.trim())).slice(0, 500).reverse();
  try {
    writePrivateFile(HISTORY_FILE(), `${safe.join("\n")}\n`);
  } catch {
    // history is a convenience only
  }
}

// ---------------------------------------------------------------- commands

const COMMANDS = [
  "/help", "/exit", "/quit", "/clear", "/reset", "/new", "/model", "/config", "/set", "/mode", "/stream", "/skills",
  "/mcp", "/tools", "/status", "/exec", "/save", "/load", "/sessions", "/schedule",
];

const HELP = `${bold("Chat")}
  Type a message and press Enter. End a line with \\ to continue it on the next line.
  ${bold("Ctrl+C")} stops the running task; press it twice at the prompt to exit.

${bold("Commands")}
  /help                      this help
  /reset (/new)              start a fresh conversation
  /model [name]              show or change the model
  /mode [dangerous|always|never]   when to ask before acting (approvals)
  /config                    show settings        /set <key> <value>   change one
  /stream [on|off]           stream replies as they are written
  /skills  /mcp  /tools      what is installed / connected / available
  /status                    device and session info
  /exec <command>            run a shell command yourself
  /save [name]  /load [name]  /sessions   keep and resume conversations
  /schedule                  list scheduled tasks
  /schedule add <when> | <text>      reminder (e.g. in 20m | stretch)
  /schedule agent <when> | <prompt>  autonomous task (e.g. daily 08:00 | battery report)
  /schedule rm <id>
  /clear                     clear the screen
  /exit (/quit)              leave (the conversation is auto-saved as "last")

When asked to approve an action: y = yes, n = no, a = always allow this kind of action for this session.`;

export interface ChatOptions {
  resume?: boolean;
  autoApprove?: boolean;
}

export async function runChat(opts: ChatOptions = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("error: `pocketclaw chat` needs an interactive terminal. Use `pocketclaw agent '<prompt>'` in scripts.");
    return 2;
  }

  const tz = initTimezone();
  const cfg0 = getConfig();
  if (Object.keys(getMcpConfig().mcpServers).length > 0) print(dim("Starting MCP servers…"));
  await getMCPManager().initialize();

  const agent = new Agent();
  const spinner = new Spinner();
  let running: AbortController | null = null;
  let currentAsk: AbortController | null = null;
  let streamEnabled = true;
  let streamedThisTurn = false;
  let needNewline = false;
  let lastSigint = 0;
  let busy = false;
  const sessionAllow = new Set<string>();
  const typedLines: string[] = [];

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: bold(cyan("pocketclaw ❯ ")),
    history: loadInputHistory(),
    historySize: 500,
    removeHistoryDuplicates: true,
    completer: (line: string): [string[], string] => {
      if (!line.startsWith("/") || line.includes(" ")) return [[], line];
      const hits = COMMANDS.filter((c) => c.startsWith(line));
      return [hits.length ? hits : COMMANDS, line];
    },
  });

  /** Asks one question on the terminal; resolves "" when cancelled with Ctrl+C. */
  const ask = (question: string): Promise<string> =>
    new Promise((resolvePromise) => {
      const controller = new AbortController();
      currentAsk = controller;
      controller.signal.addEventListener("abort", () => resolvePromise(""), { once: true });
      rl.question(question, { signal: controller.signal }, (answer) => {
        currentAsk = null;
        resolvePromise(answer);
      });
    });

  const endStreamLine = (): void => {
    if (needNewline) {
      process.stdout.write("\n");
      needNewline = false;
    }
  };

  const confirm = async (req: ApprovalRequest): Promise<boolean> => {
    const key = `${req.tool}|${req.reason ?? ""}`;
    if (sessionAllow.has(key)) return true;
    spinner.stop();
    endStreamLine();
    print(`\n${yellow("🔐 Approval needed")}${req.reason ? dim(` — ${req.reason}`) : ""}`);
    print(`   ${truncate(req.summary, 600).replace(/\n/g, "\n   ")}`);
    const answer = (await ask("   Approve? [y]es / [n]o / [a]lways this session: ")).trim().toLowerCase();
    if (answer === "a" || answer === "always") {
      sessionAllow.add(key);
      return true;
    }
    return answer === "y" || answer === "yes";
  };

  const onEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case "thinking":
        streamedThisTurn = false;
        spinner.start(`Thinking… (step ${event.turn}/${event.maxTurns})`);
        break;
      case "text_delta":
        if (!streamedThisTurn) spinner.stop();
        streamedThisTurn = true;
        needNewline = true;
        process.stdout.write(event.text);
        break;
      case "narration":
        spinner.stop();
        if (needNewline) endStreamLine();
        else print(dim(`🗣️ ${event.text}`));
        break;
      case "tool_start":
        spinner.stop();
        endStreamLine();
        print(cyan(event.summary));
        spinner.start("Working…");
        break;
      case "tool_end":
        spinner.stop();
        print(`   ↳ ${event.ok ? green("✓") : red("✗")} ${event.preview} ${dim(`(${event.ms < 1000 ? `${event.ms}ms` : `${(event.ms / 1000).toFixed(1)}s`})`)}`);
        break;
      case "notice":
        spinner.stop();
        print(yellow(`ℹ️ ${event.text}`));
        break;
    }
  };

  const runPrompt = async (text: string): Promise<void> => {
    running = new AbortController();
    streamedThisTurn = false;
    needNewline = false;
    const started = Date.now();
    let steps = 0;
    try {
      const result = await agent.run(text, {
        signal: running.signal,
        stream: streamEnabled,
        confirm: opts.autoApprove ? async () => true : confirm,
        onEvent: (event) => {
          if (event.type === "tool_start") steps++;
          onEvent(event);
        },
      });
      spinner.stop();
      endStreamLine();
      if (result === STOPPED_MESSAGE) print(yellow("⏹ Stopped."));
      else if (!streamedThisTurn || result.startsWith("⚠️")) print(result);
      if (steps > 0) print(dim(`${steps} step${steps === 1 ? "" : "s"} · ${((Date.now() - started) / 1000).toFixed(1)}s`));
    } catch (error) {
      spinner.stop();
      endStreamLine();
      print(red(`error: ${errMsg(error)}`));
    } finally {
      running = null;
    }
  };

  const setConfigValue = (rawKey: string, value: string): void => {
    const keys: Record<string, ConfigKey> = {
      model: "model",
      baseurl: "baseUrl",
      apikey: "apiKey",
      maxturns: "maxTurns",
      shelltimeout: "shellTimeout",
      confirmmode: "confirmMode",
    };
    const key = keys[rawKey.toLowerCase()];
    if (!key || !value) {
      print("Usage: /set <model|baseUrl|apiKey|maxTurns|shellTimeout|confirmMode> <value>");
      return;
    }
    const checked = validateConfigValue(key, value);
    if (!checked.ok) {
      print(red(checked.error));
      return;
    }
    updateConfig({ [key]: checked.value });
    print(green(key === "apiKey" ? "API key set for this session only (never saved to disk)." : `${key} updated.`));
  };

  const scheduleCommand = (arg: string): void => {
    const [sub = "", ...restWords] = arg.split(/\s+/);
    const rest = restWords.join(" ").trim();
    if (!sub || sub === "list") {
      const tasks = loadTasks();
      print(tasks.length ? tasks.map(describeTask).join("\n") : "No scheduled tasks.");
      print(dim("Tasks run while the bot daemon (`pocketclaw start`) is running and are delivered to Telegram."));
      return;
    }
    if (sub === "rm" || sub === "remove" || sub === "cancel") {
      print(removeTask(rest) ? green(`Cancelled ${rest}.`) : red(`No task with id "${rest}".`));
      return;
    }
    if (sub === "add" || sub === "agent") {
      const bar = rest.indexOf("|");
      if (bar < 0) {
        print(`Usage: /schedule ${sub} <when> | <${sub === "agent" ? "prompt" : "text"}>   e.g. /schedule ${sub} daily 08:00 | ${sub === "agent" ? "report battery and storage" : "drink water"}`);
        return;
      }
      try {
        const task = addTask({ kind: sub === "agent" ? "agent" : "reminder", spec: rest.slice(0, bar), text: rest.slice(bar + 1) });
        print(green(`Scheduled: ${describeTask(task)}`));
      } catch (error) {
        print(red(errMsg(error)));
      }
      return;
    }
    print("Usage: /schedule [list] | add <when> | <text> | agent <when> | <prompt> | rm <id>");
  };

  const statusCommand = (): void => {
    const cfg = getConfig();
    const total = os.totalmem();
    const used = total - os.freemem();
    const mb = (n: number): string => `${Math.round(n / 1_048_576)} MB`;
    print(
      [
        `${bold("PocketClaw")} ${VERSION} · Node ${process.version} · ${os.platform()} ${os.arch()}`,
        `Model: ${cfg.model}   Approvals: ${cfg.confirmMode}   Streaming: ${streamEnabled ? "on" : "off"}`,
        `Time zone: ${tz}   Memory: ${mb(used)} / ${mb(total)}`,
        `Tools: ${getActiveTools().length}   Termux:API: ${termuxApiAvailable() ? "yes" : "no"}   Scheduled tasks: ${loadTasks().length}`,
        `Conversation: ${agent.getHistory().length - 1} messages`,
      ].join("\n")
    );
  };

  const execCommand = async (command: string): Promise<void> => {
    if (!command) {
      print("Usage: /exec <command>");
      return;
    }
    const cfg = getConfig();
    const reason = assessShell(command);
    if (cfg.confirmMode === "always" || (cfg.confirmMode === "dangerous" && reason)) {
      if (!(await confirm({ tool: "exec", summary: command, reason }))) {
        print("Not run.");
        return;
      }
    }
    running = new AbortController();
    try {
      const res = await runShell(command, cfg.shellTimeout, running.signal);
      const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
      if (out) print(out);
      print(dim(`exit ${res.exit_code ?? "?"}${res.timed_out ? " · timed out" : ""}${res.aborted ? " · cancelled" : ""}${res.truncated ? " · output truncated" : ""}`));
    } finally {
      running = null;
    }
  };

  const handleCommand = async (line: string): Promise<void> => {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(line);
    const name = (match?.[1] ?? "").toLowerCase();
    const arg = (match?.[2] ?? "").trim();
    const cfg = getConfig();

    switch (name) {
      case "help":
      case "?":
        print(HELP);
        break;
      case "exit":
      case "quit":
        rl.close();
        break;
      case "clear":
        process.stdout.write("\x1b[2J\x1b[H");
        break;
      case "reset":
      case "new":
        agent.reset();
        print(green("Started a fresh conversation."));
        break;
      case "model":
        if (!arg) {
          print(`Model: ${cfg.model}\nChoices: ${cfg.modelChoices.join(", ")}`);
        } else setConfigValue("model", arg);
        break;
      case "mode":
        if (!arg) print(`Approvals: ${cfg.confirmMode}  (${CONFIRM_MODES.join(" | ")})`);
        else setConfigValue("confirmMode", arg);
        break;
      case "config":
        print(
          [
            `model         ${cfg.model}`,
            `baseUrl       ${cfg.baseUrl}`,
            `apiKey        ${maskSecret(cfg.apiKey)}`,
            `maxTurns      ${cfg.maxTurns}`,
            `shellTimeout  ${cfg.shellTimeout} ms`,
            `confirmMode   ${cfg.confirmMode}`,
          ].join("\n")
        );
        break;
      case "set": {
        const [key = "", ...value] = arg.split(/\s+/);
        setConfigValue(key, value.join(" ").trim());
        break;
      }
      case "stream":
        if (arg === "on" || arg === "off") streamEnabled = arg === "on";
        else if (arg) {
          print("Usage: /stream [on|off]");
          break;
        }
        print(`Streaming is ${streamEnabled ? "on" : "off"}.`);
        break;
      case "skills": {
        const skills = getSkillManager().listSkills();
        print(skills.length ? skills.map((s) => `• ${bold(s.name)} — ${s.description}`).join("\n") : "No skills installed.");
        break;
      }
      case "mcp": {
        const status = getMCPManager().status();
        print(
          status.length
            ? status.map((s) => `${s.running ? green("●") : red("●")} ${s.name} (${s.command}) — ${s.toolCount} tool(s)${s.error ? dim(` — ${s.error.slice(0, 120)}`) : ""}`).join("\n")
            : "No MCP servers configured."
        );
        break;
      }
      case "tools": {
        const tools = getActiveTools();
        print(`${tools.length} tools:\n${tools.map((t) => t.function.name).join(", ")}`);
        break;
      }
      case "status":
        statusCommand();
        break;
      case "exec":
        await execCommand(arg);
        break;
      case "save": {
        const name2 = arg || "last";
        const count = saveSession(name2, agent);
        print(green(`Saved ${count} messages as "${name2}".`));
        break;
      }
      case "load": {
        const name2 = arg || "last";
        const count = loadSession(name2, agent);
        print(green(`Loaded "${name2}" (${count} messages).`));
        break;
      }
      case "sessions": {
        const sessions = listSessions();
        print(sessions.length ? sessions.map((s) => `• ${s.name}  ${dim(s.when)}`).join("\n") : "No saved sessions.");
        break;
      }
      case "schedule":
        scheduleCommand(arg);
        break;
      default:
        print(`Unknown command /${name}. Type /help.`);
    }
  };

  const handleLine = async (raw: string, continuation: { text: string }): Promise<void> => {
    // A trailing backslash continues the message on the next line (handy on phone keyboards).
    if (raw.endsWith("\\")) {
      continuation.text += `${raw.slice(0, -1)}\n`;
      rl.setPrompt(dim("   … "));
      return;
    }
    const line = (continuation.text + raw).trim();
    continuation.text = "";
    rl.setPrompt(bold(cyan("pocketclaw ❯ ")));
    if (!line) return;
    typedLines.unshift(line);

    if (busy) {
      print(dim("(busy — press Ctrl+C to stop the current task)"));
      return;
    }
    busy = true;
    try {
      if (line.startsWith("/")) await handleCommand(line);
      else await runPrompt(line);
    } catch (error) {
      print(red(`error: ${errMsg(error)}`));
    } finally {
      busy = false;
    }
  };

  rl.on("SIGINT", () => {
    if (currentAsk) {
      currentAsk.abort(); // counts as "no"
      return;
    }
    if (running) {
      running.abort();
      spinner.stop();
      print(dim("\n⏹ stopping…"));
      return;
    }
    const now = Date.now();
    if (now - lastSigint < 2_000) {
      rl.close();
      return;
    }
    lastSigint = now;
    print(dim("\n(press Ctrl+C again to exit, or type /exit)"));
    rl.prompt();
  });

  const closed = new Promise<void>((resolvePromise) => rl.on("close", resolvePromise));

  print(`${bold("⚡ PocketClaw")} ${VERSION} ${dim(`· ${cfg0.model} · approvals: ${cfg0.confirmMode}${opts.autoApprove ? " (auto-approve ON)" : ""}`)}`);
  print(dim("Type a message, or /help. Ctrl+C stops a task."));
  if (!cfg0.apiKey) print(yellow("LLM_API_KEY is not set: chatting will fail until it is (slash commands still work)."));
  if (opts.resume) {
    try {
      print(green(`Resumed the previous conversation (${loadSession("last", agent)} messages).`));
    } catch (error) {
      print(dim(`Nothing to resume (${errMsg(error)}).`));
    }
  }

  const continuation = { text: "" };
  rl.on("line", (raw) => {
    void handleLine(raw, continuation).then(() => {
      if (busy) return;
      try {
        rl.prompt();
      } catch {
        // the interface was closed by /exit
      }
    });
  });
  rl.prompt();

  await closed;

  spinner.stop();
  saveInputHistory([...typedLines, ...loadInputHistory()]);
  try {
    if (agent.getHistory().length > 1) saveSession("last", agent);
  } catch {
    // autosave is best effort
  }
  print(dim("\nBye."));
  return 0;
}
