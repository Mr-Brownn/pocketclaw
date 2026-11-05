import { randomBytes } from "node:crypto";
import * as os from "node:os";
import { Agent, STOPPED_MESSAGE } from "./agent.ts";
import type { AgentEvent } from "./agent.ts";
import { runShell } from "./shell.ts";
import { getConfig, maskSecret, resetConfig, updateConfig, validateConfigValue } from "./config.ts";
import type { ConfigKey } from "./config.ts";
import { getSkillManager } from "./skills.ts";
import { getMCPManager } from "./mcp.ts";
import { closeMemoryStore } from "./memory.ts";
import { assessShell } from "./policy.ts";
import type { ApprovalRequest } from "./tools.ts";
import { VERSION, chunkText, errMsg, sleep, truncate } from "./utils.ts";

export interface TelegramConfig {
  botToken: string;
  /** Chat IDs allowed to use the bot. Must not be empty: the bot can run shell commands. */
  allowedChatIds: number[];
}

// ------------------------------------------------------------------ types

interface TgUser {
  id: number;
}
interface TgChat {
  id: number;
  type: string;
}
interface TgMessage {
  message_id: number;
  text?: string;
  chat: TgChat;
  from?: TgUser;
}
interface TgCallback {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

interface Button {
  text: string;
  data: string;
}
type Keyboard = Button[][];
interface View {
  /** HTML (Telegram parse_mode=HTML). */
  text: string;
  keyboard?: Keyboard;
}
interface PendingApproval {
  messageId: number;
  timer: NodeJS.Timeout;
  settle: (approved: boolean, label: string) => void;
}

class TelegramError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "TelegramError";
    this.code = code;
  }
}

const APPROVAL_TIMEOUT_MS = 120_000;
const STOP_KEYBOARD: Keyboard = [[{ text: "⏹ Stop", data: "a:stop" }]];
const BACK_ROW: Button[] = [{ text: "🏠 Menu", data: "v:menu" }];

const COMMAND_MENU = [
  { command: "menu", description: "Show the control panel" },
  { command: "config", description: "View and change settings" },
  { command: "model", description: "Switch the LLM model" },
  { command: "skills", description: "Installed skills" },
  { command: "mcp", description: "MCP servers and tools" },
  { command: "status", description: "Device and bot status" },
  { command: "stop", description: "Stop the running task" },
  { command: "reset", description: "Start a fresh session" },
  { command: "exec", description: "Run a shell command: /exec <cmd>" },
];

// ---------------------------------------------------------------- helpers

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function markup(keyboard: Keyboard): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
  };
}

function parseCommand(text: string): { name: string; arg: string } | null {
  const m = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  return m ? { name: (m[1] ?? "").toLowerCase(), arg: (m[2] ?? "").trim() } : null;
}

function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function fmtMs(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// --------------------------------------------------------- live progress

/** One status message that is edited in place as the agent works (throttled to respect Telegram limits). */
class Progress {
  private status = "🧠 Starting…";
  private lines: string[] = [];
  private messageId: number | null = null;
  private lastEdit = 0;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private finished = false;
  private bot: TelegramBot;
  private chatId: number;

  constructor(bot: TelegramBot, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
  }

  async start(): Promise<void> {
    try {
      this.messageId = await this.bot.sendMessage(this.chatId, this.render(), {
        html: true,
        keyboard: STOP_KEYBOARD,
      });
    } catch {
      this.messageId = null;
    }
    this.lastEdit = Date.now();
  }

  push(event: AgentEvent): void {
    switch (event.type) {
      case "thinking":
        this.status = `🧠 Thinking… (step ${event.turn}/${event.maxTurns})`;
        break;
      case "narration":
        this.add(`🗣 ${esc(clip(event.text, 240))}`);
        break;
      case "tool_start":
        this.add(esc(clip(event.summary, 200)));
        break;
      case "tool_end":
        this.add(`   ↳ ${event.ok ? "✅" : "❌"} ${esc(clip(event.preview, 160))} <i>(${fmtMs(event.ms)})</i>`);
        break;
      case "notice":
        this.add(`ℹ️ ${esc(clip(event.text, 200))}`);
        break;
    }
    this.schedule();
  }

  async finish(statusText: string): Promise<void> {
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.status = statusText;
    this.queueEdit(true);
    await this.chain;
  }

  private add(line: string): void {
    this.lines.push(line);
    if (this.lines.length > 10) this.lines.shift();
  }

  private render(): string {
    let lines = [...this.lines];
    let body = `<b>${esc(this.status)}</b>${lines.length ? `\n\n${lines.join("\n")}` : ""}`;
    while (body.length > 3_500 && lines.length > 1) {
      lines = lines.slice(1);
      body = `<b>${esc(this.status)}</b>\n\n${lines.join("\n")}`;
    }
    return body;
  }

  private schedule(): void {
    if (this.finished || this.timer || this.messageId === null) return;
    const wait = Math.max(0, 1_500 - (Date.now() - this.lastEdit));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.queueEdit(false);
    }, wait);
  }

  private queueEdit(final: boolean): void {
    this.chain = this.chain.then(async () => {
      if (this.messageId === null || (this.finished && !final)) return;
      this.lastEdit = Date.now();
      await this.bot.editMessage(this.chatId, this.messageId, this.render(), {
        html: true,
        keyboard: final ? undefined : STOP_KEYBOARD,
      });
    });
  }
}

// -------------------------------------------------------------------- bot

export class TelegramBot {
  private readonly token: string;
  private readonly allowed: Set<number>;
  private readonly agents = new Map<number, Agent>();
  private readonly runs = new Map<number, AbortController>();
  private readonly queues = new Map<number, Promise<void>>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly lastReject = new Map<number, number>();
  private running = false;
  private pollAbort: AbortController | null = null;

  constructor(config: TelegramConfig) {
    if (config.allowedChatIds.length === 0) {
      throw new Error("At least one allowed chat ID is required to run the Telegram bot");
    }
    this.token = config.botToken;
    this.allowed = new Set(config.allowedChatIds);
  }

  // ------------------------------------------------------------ Telegram API

  private async apiCall(
    method: string,
    payload: Record<string, unknown> = {},
    opts: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<any> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      });
      let data: {
        ok: boolean;
        result?: any;
        description?: string;
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      try {
        data = (await response.json()) as typeof data;
      } catch {
        throw new TelegramError(`Telegram API ${method}: HTTP ${response.status} (unreadable response)`, response.status);
      }
      if (data.ok) return data.result;
      const retryAfter = data.parameters?.retry_after;
      if (data.error_code === 429 && retryAfter && attempt < 2) {
        await sleep(Math.min(retryAfter, 30) * 1_000);
        continue;
      }
      throw new TelegramError(
        `Telegram API ${method} failed: ${data.description ?? response.status}`,
        data.error_code ?? response.status
      );
    }
  }

  private async sendOne(chatId: number, text: string, html: boolean, keyboard?: Keyboard): Promise<number> {
    const payload: Record<string, unknown> = { chat_id: chatId, text };
    if (keyboard) payload.reply_markup = markup(keyboard);
    if (html) payload.parse_mode = "HTML";
    try {
      return (await this.apiCall("sendMessage", payload)).message_id as number;
    } catch (error) {
      if (html && error instanceof TelegramError && error.code === 400) {
        delete payload.parse_mode;
        payload.text = stripHtml(text);
        return (await this.apiCall("sendMessage", payload)).message_id as number;
      }
      throw error;
    }
  }

  /** Sends text (HTML when `html`), splitting long plain text into several messages. Returns the last message id. */
  public async sendMessage(
    chatId: number,
    text: string,
    opts: { html?: boolean; keyboard?: Keyboard } = {}
  ): Promise<number> {
    const wantsHtml = opts.html === true;
    const html = wantsHtml && text.length <= 4_000;
    const body = wantsHtml && !html ? stripHtml(text) : text;
    const parts = html ? [body] : chunkText(body || "(empty)", 4_000);
    let id = 0;
    for (const [i, part] of parts.entries()) {
      id = await this.sendOne(chatId, part, html, i === parts.length - 1 ? opts.keyboard : undefined);
    }
    return id;
  }

  public async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    opts: { html?: boolean; keyboard?: Keyboard } = {}
  ): Promise<void> {
    const payload: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text: text.slice(0, 4_000) };
    // Omitting reply_markup removes the buttons; that is what we want for finished messages.
    if (opts.keyboard) payload.reply_markup = markup(opts.keyboard);
    if (opts.html) payload.parse_mode = "HTML";
    try {
      await this.apiCall("editMessageText", payload);
    } catch (error) {
      const message = errMsg(error);
      if (message.includes("not modified")) return;
      if (opts.html && error instanceof TelegramError && error.code === 400) {
        try {
          delete payload.parse_mode;
          payload.text = stripHtml(text).slice(0, 4_000);
          await this.apiCall("editMessageText", payload);
        } catch (retryError) {
          if (!errMsg(retryError).includes("not modified")) console.warn(`[telegram] edit failed: ${errMsg(retryError)}`);
        }
        return;
      }
      console.warn(`[telegram] edit failed: ${message}`);
    }
  }

  private async answerCallback(id: string, text?: string, alert = false): Promise<void> {
    try {
      await this.apiCall("answerCallbackQuery", { callback_query_id: id, ...(text ? { text, show_alert: alert } : {}) }, { timeoutMs: 8_000 });
    } catch {
      // the query may have expired; nothing to do
    }
  }

  /** Telegram's "typing…" status lasts ~5s, so refresh it until stopped. */
  private startTyping(chatId: number): () => void {
    const send = (): void => {
      void this.apiCall("sendChatAction", { chat_id: chatId, action: "typing" }, { timeoutMs: 5_000 }).catch(() => undefined);
    };
    send();
    const timer = setInterval(send, 4_000);
    return () => clearInterval(timer);
  }

  // ----------------------------------------------------------------- views

  private modelChoices(): string[] {
    return [...new Set(getConfig().modelChoices)];
  }

  private async buildView(name: string): Promise<View> {
    const cfg = getConfig();
    switch (name) {
      case "config": {
        const mark = (active: boolean, label: string): string => (active ? `✓ ${label}` : label);
        return {
          text:
            `⚙️ <b>Configuration</b>\n\n` +
            `• Model: <code>${esc(cfg.model)}</code>\n` +
            `• Base URL: <code>${esc(cfg.baseUrl)}</code>\n` +
            `• API key: <code>${esc(maskSecret(cfg.apiKey))}</code>\n` +
            `• Max turns: <code>${cfg.maxTurns}</code>\n` +
            `• Shell timeout: <code>${cfg.shellTimeout / 1000}s</code>\n` +
            `• Approvals: <code>${cfg.confirmMode}</code>\n\n` +
            `<b>Approvals</b>: <i>dangerous</i> asks before risky actions, <i>always</i> asks before every shell command or file change, <i>never</i> never asks.\n` +
            `Other keys: <code>/set &lt;key&gt; &lt;value&gt;</code> (model, baseUrl, apiKey, maxTurns, shellTimeout, confirmMode)`,
          keyboard: [
            [
              { text: mark(cfg.confirmMode === "dangerous", "🛡 Dangerous"), data: "cm:dangerous" },
              { text: mark(cfg.confirmMode === "always", "🔒 Always"), data: "cm:always" },
              { text: mark(cfg.confirmMode === "never", "⚡ Never"), data: "cm:never" },
            ],
            [10, 15, 25, 40].map((n) => ({ text: mark(cfg.maxTurns === n, `${n} turns`), data: `mt:${n}` })),
            [15, 30, 60, 120].map((s) => ({ text: mark(cfg.shellTimeout === s * 1_000, `${s}s`), data: `st:${s * 1_000}` })),
            [{ text: "♻️ Reset config", data: "a:resetcfg" }, ...BACK_ROW],
          ],
        };
      }
      case "resetcfg":
        return {
          text: "♻️ <b>Reset configuration to defaults?</b>\nModel, limits and approval mode go back to their defaults. Your API key is not stored on disk, so it is unaffected.",
          keyboard: [
            [
              { text: "✅ Yes, reset", data: "a:resetcfg_yes" },
              { text: "✖ Cancel", data: "v:config" },
            ],
          ],
        };
      case "model": {
        const choices = this.modelChoices();
        return {
          text:
            `🧠 <b>Active model</b>: <code>${esc(cfg.model)}</code>\n\n` +
            `Tap a model to switch, or type <code>/model &lt;name&gt;</code> for any other.\n` +
            `<i>Edit "modelChoices" in ~/.pocketclaw/config.json to change these buttons.</i>`,
          keyboard: [
            ...choices.map((m, i) => [{ text: `${m === cfg.model ? "✓ " : ""}${m}`.slice(0, 60), data: `m:${i}` }]),
            BACK_ROW,
          ],
        };
      }
      case "skills": {
        const skills = getSkillManager().listSkills();
        const list = skills.length
          ? skills.map((s) => `• <b>${esc(s.name)}</b>: ${esc(clip(s.description, 160))}`).join("\n")
          : "No custom skills installed yet.\n<i>Tip: ask PocketClaw to author one, e.g. “Create a skill for camera automation”.</i>";
        return {
          text: truncate(`📚 <b>Skills</b>\n\n${list}`, 3_500),
          keyboard: [[{ text: "🔄 Refresh", data: "v:skills" }, ...BACK_ROW]],
        };
      }
      case "mcp": {
        const status = getMCPManager().status();
        const tools = getMCPManager().getDiscoveredTools();
        const list = status.length
          ? status
              .map(
                (s) =>
                  `• ${s.running ? "🟢" : "🔴"} <code>${esc(s.name)}</code> (${esc(s.command)}) — ${s.toolCount} tool(s)` +
                  (s.error ? `\n   <i>${esc(clip(s.error, 160))}</i>` : "")
              )
              .join("\n")
          : "No MCP servers configured yet.\n<i>Tip: ask PocketClaw to connect one, e.g. “Connect the filesystem MCP server for /sdcard”.</i>";
        const toolList = tools.length ? `\n\n<b>Tools</b>\n${tools.map((t) => `• <code>${esc(t.function.name)}</code>`).join("\n")}` : "";
        return {
          text: truncate(`🔌 <b>MCP servers</b>\n\n${list}${toolList}`, 3_500),
          keyboard: [[{ text: "🔄 Refresh", data: "v:mcp" }, ...BACK_ROW]],
        };
      }
      case "status": {
        let deviceUptime = "n/a";
        let load = "n/a";
        try {
          deviceUptime = fmtDuration(os.uptime());
          load = os.loadavg().map((n) => n.toFixed(2)).join(" / ");
        } catch {
          // some Android builds restrict /proc
        }
        const total = os.totalmem();
        const free = os.freemem();
        const mb = (n: number): string => `${Math.round(n / 1_048_576)} MB`;
        return {
          text:
            `📊 <b>Status</b>\n\n` +
            `• Platform: <code>${os.platform()} ${os.arch()}</code> · Node <code>${process.version}</code>\n` +
            `• Device uptime: <code>${deviceUptime}</code>\n` +
            `• Bot uptime: <code>${fmtDuration(process.uptime())}</code>\n` +
            `• Memory: <code>${mb(total - free)} used of ${mb(total)}</code>\n` +
            `• Bot memory: <code>${mb(process.memoryUsage().rss)}</code>\n` +
            `• Load (1/5/15m): <code>${load}</code>\n` +
            `• Sessions: <code>${this.agents.size}</code> · Tasks running: <code>${this.runs.size}</code>`,
          keyboard: [[{ text: "🔄 Refresh", data: "v:status" }, ...BACK_ROW]],
        };
      }
      default:
        return {
          text:
            `⚡ <b>PocketClaw ${VERSION}</b>\n\n` +
            `Chat in plain language to control the agent, or use the buttons below.\n` +
            `<i>Tip: while a task runs you can tap ⏹ Stop or send /stop.</i>`,
          keyboard: [
            [
              { text: "⚙️ Config", data: "v:config" },
              { text: "🧠 Model", data: "v:model" },
            ],
            [
              { text: "📚 Skills", data: "v:skills" },
              { text: "🔌 MCP", data: "v:mcp" },
            ],
            [
              { text: "📊 Status", data: "v:status" },
              { text: "🔄 New session", data: "a:reset" },
            ],
            [{ text: "⏹ Stop task", data: "a:stop" }],
          ],
        };
    }
  }

  private async sendView(chatId: number, name: string): Promise<void> {
    const view = await this.buildView(name);
    await this.sendMessage(chatId, view.text, { html: true, keyboard: view.keyboard });
  }

  private async showView(chatId: number, messageId: number, name: string): Promise<void> {
    const view = await this.buildView(name);
    await this.editMessage(chatId, messageId, view.text, { html: true, keyboard: view.keyboard });
  }

  // ------------------------------------------------------------- approvals

  private requestApproval(chatId: number, req: ApprovalRequest, signal?: AbortSignal): Promise<boolean> {
    const id = randomBytes(6).toString("hex");
    return new Promise<boolean>((resolvePromise) => {
      const settle = (approved: boolean, label: string): void => {
        const pending = this.approvals.get(id);
        if (!pending) return;
        this.approvals.delete(id);
        clearTimeout(pending.timer);
        signal?.removeEventListener("abort", onAbort);
        void this.editMessage(chatId, pending.messageId, `${label}\n<pre>${esc(truncate(req.summary, 800))}</pre>`, { html: true });
        resolvePromise(approved);
      };
      const onAbort = (): void => settle(false, "⏹ <b>Cancelled</b>");
      const timer = setTimeout(() => settle(false, "⌛ <b>Timed out — denied</b>"), APPROVAL_TIMEOUT_MS);

      const text =
        `🔐 <b>Approval needed</b>\n${esc(req.reason ? `This action ${req.reason}.` : "Confirmation mode is on.")}\n\n` +
        `<pre>${esc(truncate(req.summary, 1_500))}</pre>`;
      this.sendMessage(chatId, text, {
        html: true,
        keyboard: [
          [
            { text: "✅ Approve", data: `ap:${id}:y` },
            { text: "❌ Deny", data: `ap:${id}:n` },
          ],
        ],
      })
        .then((messageId) => {
          this.approvals.set(id, { messageId, timer, settle });
          if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }
        })
        .catch(() => {
          clearTimeout(timer);
          resolvePromise(false);
        });
    });
  }

  // --------------------------------------------------------------- sessions

  private getAgent(chatId: number): Agent {
    let agent = this.agents.get(chatId);
    if (!agent) {
      agent = new Agent();
      this.agents.set(chatId, agent);
    }
    return agent;
  }

  private enqueue(chatId: number, job: () => Promise<void>): void {
    const previous = this.queues.get(chatId);
    if (previous) {
      void this.sendMessage(chatId, "⏳ Queued behind the current task. Send /stop to cancel it.").catch(() => undefined);
    }
    const next = (previous ?? Promise.resolve())
      .then(job)
      .catch((error) => console.error(`[telegram] job failed: ${errMsg(error)}`));
    this.queues.set(chatId, next);
    void next.then(() => {
      if (this.queues.get(chatId) === next) this.queues.delete(chatId);
    });
  }

  private stopRun(chatId: number): boolean {
    const controller = this.runs.get(chatId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private resetSession(chatId: number): void {
    this.stopRun(chatId);
    // Queued behind any running task so the history is not swapped out from under it.
    this.enqueue(chatId, async () => {
      this.getAgent(chatId).reset();
      await this.sendMessage(chatId, "🔄 Session reset. Starting fresh.");
    });
  }

  private async runAgent(chatId: number, text: string): Promise<void> {
    const agent = this.getAgent(chatId);
    const controller = new AbortController();
    this.runs.set(chatId, controller);
    const stopTyping = this.startTyping(chatId);
    const progress = new Progress(this, chatId);
    await progress.start();

    const started = Date.now();
    let steps = 0;
    const summary = (): string => `${steps} step${steps === 1 ? "" : "s"} · ${fmtMs(Date.now() - started)}`;
    try {
      const response = await agent.run(text, {
        signal: controller.signal,
        confirm: (req) => this.requestApproval(chatId, req, controller.signal),
        onEvent: (event) => {
          if (event.type === "tool_start") steps++;
          progress.push(event);
        },
      });
      if (controller.signal.aborted || response === STOPPED_MESSAGE) {
        await progress.finish(`⏹ Stopped · ${summary()}`);
        return;
      }
      await progress.finish(`✅ Done · ${summary()}`);
      await this.sendMessage(chatId, response);
    } catch (error) {
      await progress.finish(`❌ Failed · ${summary()}`);
      await this.sendMessage(chatId, `❌ Error: ${errMsg(error)}`);
    } finally {
      stopTyping();
      if (this.runs.get(chatId) === controller) this.runs.delete(chatId);
    }
  }

  // --------------------------------------------------------------- commands

  private async handleSet(chatId: number, message: TgMessage, arg: string): Promise<void> {
    const [rawKey, ...rest] = arg.split(/\s+/);
    const value = rest.join(" ").trim();
    const keys: Record<string, ConfigKey> = {
      model: "model",
      baseurl: "baseUrl",
      apikey: "apiKey",
      maxturns: "maxTurns",
      shelltimeout: "shellTimeout",
      confirmmode: "confirmMode",
    };
    const key = rawKey ? keys[rawKey.toLowerCase()] : undefined;

    if (key === "apiKey") {
      // Do not leave the secret sitting in the chat history.
      await this.apiCall("deleteMessage", { chat_id: chatId, message_id: message.message_id }).catch(() => undefined);
    }
    if (!rawKey || !key || !value) {
      await this.sendMessage(
        chatId,
        "Usage: <code>/set &lt;key&gt; &lt;value&gt;</code>\nKeys: <code>model</code>, <code>baseUrl</code>, <code>apiKey</code>, <code>maxTurns</code>, <code>shellTimeout</code> (ms), <code>confirmMode</code> (dangerous|always|never)",
        { html: true }
      );
      return;
    }
    const checked = validateConfigValue(key, value);
    if (!checked.ok) {
      await this.sendMessage(chatId, `❌ ${checked.error}`);
      return;
    }
    updateConfig({ [key]: checked.value });
    await this.sendMessage(
      chatId,
      key === "apiKey"
        ? "✅ API key updated for this run only (never saved to disk). I tried to delete your message; to make it permanent set LLM_API_KEY in ~/.pocketclaw/env."
        : `✅ <code>${key}</code> updated.`,
      { html: key !== "apiKey" }
    );
  }

  private async handleExec(chatId: number, arg: string): Promise<void> {
    if (!arg) {
      await this.sendMessage(chatId, "Usage: <code>/exec &lt;command&gt;</code>", { html: true });
      return;
    }
    const cfg = getConfig();
    const reason = assessShell(arg);
    const needsApproval = cfg.confirmMode === "always" || (cfg.confirmMode === "dangerous" && reason !== null);
    if (needsApproval) {
      const approved = await this.requestApproval(chatId, { tool: "exec", summary: arg, reason });
      if (!approved) {
        await this.sendMessage(chatId, "✖ Command not run.");
        return;
      }
    }
    const stopTyping = this.startTyping(chatId);
    try {
      const res = await runShell(arg, cfg.shellTimeout);
      const output = [res.stdout, res.stderr].filter(Boolean).join("\n").trim() || "(no output)";
      const header = `exit ${res.exit_code ?? "?"}${res.timed_out ? " · timed out" : ""}${res.truncated ? " · output truncated" : ""}`;
      await this.sendMessage(chatId, `<b>${esc(header)}</b>\n<pre>${esc(truncate(output, 3_300))}</pre>`, { html: true });
    } finally {
      stopTyping();
    }
  }

  private async handleText(chatId: number, message: TgMessage, text: string): Promise<void> {
    const cmd = parseCommand(text);
    if (!cmd) {
      await this.runAgent(chatId, text);
      return;
    }
    switch (cmd.name) {
      case "start":
      case "help":
      case "commands":
      case "menu":
        return this.sendView(chatId, "menu");
      case "config":
      case "skills":
      case "mcp":
      case "status":
        return this.sendView(chatId, cmd.name);
      case "model": {
        if (!cmd.arg) return this.sendView(chatId, "model");
        const checked = validateConfigValue("model", cmd.arg);
        if (!checked.ok) {
          await this.sendMessage(chatId, `❌ ${checked.error}`);
          return;
        }
        updateConfig({ model: checked.value });
        await this.sendMessage(chatId, `✅ Active model updated to <code>${esc(String(checked.value))}</code>`, { html: true });
        return;
      }
      case "set":
        return this.handleSet(chatId, message, cmd.arg);
      case "resetconfig":
        return this.sendView(chatId, "resetcfg");
      case "exec":
        return this.handleExec(chatId, cmd.arg);
      default:
        await this.sendMessage(chatId, `Unknown command /${esc(cmd.name)}. Use the menu:`, {
          html: true,
          keyboard: [[{ text: "🏠 Menu", data: "v:menu" }]],
        });
    }
  }

  private async handleCallback(cb: TgCallback): Promise<void> {
    const message = cb.message;
    if (!message || !this.isAuthorized(message.chat, cb.from)) {
      await this.answerCallback(cb.id, "Unauthorized", true);
      return;
    }
    const chatId = message.chat.id;
    const messageId = message.message_id;
    const [kind, ...rest] = (cb.data ?? "").split(":");
    let toast: string | undefined;

    try {
      switch (kind) {
        case "v":
          await this.showView(chatId, messageId, rest[0] ?? "menu");
          break;
        case "a": {
          const action = rest[0];
          if (action === "stop") {
            toast = this.stopRun(chatId) ? "Stopping…" : "Nothing is running";
          } else if (action === "reset") {
            this.resetSession(chatId);
            toast = "Resetting session";
          } else if (action === "resetcfg") {
            await this.showView(chatId, messageId, "resetcfg");
          } else if (action === "resetcfg_yes") {
            resetConfig();
            await this.showView(chatId, messageId, "config");
            toast = "Configuration reset";
          }
          break;
        }
        case "cm":
        case "mt":
        case "st": {
          const key: ConfigKey = kind === "cm" ? "confirmMode" : kind === "mt" ? "maxTurns" : "shellTimeout";
          const checked = validateConfigValue(key, rest[0]);
          if (checked.ok) {
            updateConfig({ [key]: checked.value });
            toast = "Saved";
          } else {
            toast = checked.error;
          }
          await this.showView(chatId, messageId, "config");
          break;
        }
        case "m": {
          const choice = this.modelChoices()[Number(rest[0])];
          if (choice) {
            updateConfig({ model: choice });
            toast = `Model: ${choice}`.slice(0, 190);
          }
          await this.showView(chatId, messageId, "model");
          break;
        }
        case "ap": {
          const pending = this.approvals.get(rest[0] ?? "");
          if (!pending) {
            toast = "This request has expired";
          } else if (rest[1] === "y") {
            pending.settle(true, "✅ <b>Approved</b>");
            toast = "Approved";
          } else {
            pending.settle(false, "❌ <b>Denied</b>");
            toast = "Denied";
          }
          break;
        }
        default:
          toast = "Unknown action";
      }
    } catch (error) {
      toast = clip(errMsg(error), 150);
    }
    await this.answerCallback(cb.id, toast);
  }

  // ---------------------------------------------------------------- polling

  private isAuthorized(chat: TgChat, from?: TgUser): boolean {
    if (!this.allowed.has(chat.id)) return false;
    return chat.type === "private" || (from !== undefined && this.allowed.has(from.id));
  }

  private async rejectUnauthorized(chatId: number): Promise<void> {
    const now = Date.now();
    if (now - (this.lastReject.get(chatId) ?? 0) < 60_000) return;
    this.lastReject.set(chatId, now);
    console.warn(`[telegram] rejected a message from chat ${chatId}`);
    await this.sendMessage(chatId, `Unauthorized. This chat's ID is ${chatId}.`).catch(() => undefined);
  }

  private guard(job: () => Promise<void>): void {
    void job().catch((error) => console.error(`[telegram] ${errMsg(error)}`));
  }

  private dispatch(update: TgUpdate): void {
    if (update.callback_query) {
      const cb = update.callback_query;
      this.guard(() => this.handleCallback(cb));
      return;
    }
    const message = update.message;
    if (!message || typeof message.text !== "string") return;
    const chatId = message.chat.id;
    if (!this.isAuthorized(message.chat, message.from)) {
      this.guard(() => this.rejectUnauthorized(chatId));
      return;
    }
    const text = message.text.trim();
    if (!text) return;

    const cmd = parseCommand(text);
    if (cmd?.name === "stop") {
      this.guard(async () => {
        const stopped = this.stopRun(chatId);
        await this.sendMessage(chatId, stopped ? "⏹ Stopping the current task…" : "Nothing is running right now.");
      });
      return;
    }
    if (cmd?.name === "reset") {
      this.resetSession(chatId);
      return;
    }
    this.enqueue(chatId, () => this.handleText(chatId, message, text));
  }

  public stop(): void {
    if (!this.running) return;
    this.running = false;
    this.pollAbort?.abort();
    for (const controller of this.runs.values()) controller.abort();
    for (const pending of [...this.approvals.values()]) pending.settle(false, "⏹ <b>Bot stopped</b>");
  }

  public async startPolling(): Promise<void> {
    await getMCPManager().initialize();
    const me = await this.apiCall("getMe");
    console.log(`⚡ PocketClaw ${VERSION} bot @${me.username} polling (${this.allowed.size} allowed chat(s))`);
    await this.apiCall("setMyCommands", { commands: COMMAND_MENU }).catch(() => undefined);

    // Skip anything sent while the bot was offline: replaying old /exec or agent requests would be dangerous.
    let offset = 0;
    try {
      const backlog = (await this.apiCall("getUpdates", { offset: -1, timeout: 0 })) as TgUpdate[];
      const last = backlog[backlog.length - 1];
      if (last) offset = last.update_id + 1;
    } catch {
      // start from the beginning of whatever Telegram still holds
    }

    this.running = true;
    this.pollAbort = new AbortController();
    const onSignal = (): void => {
      console.log("[telegram] shutting down…");
      this.stop();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    let failures = 0;
    while (this.running) {
      try {
        const updates = (await this.apiCall(
          "getUpdates",
          { offset, timeout: 30, allowed_updates: ["message", "callback_query"] },
          { timeoutMs: 45_000, signal: this.pollAbort.signal }
        )) as TgUpdate[];
        failures = 0;
        for (const update of updates) {
          offset = update.update_id + 1;
          this.dispatch(update);
        }
      } catch (error) {
        if (!this.running) break;
        failures++;
        console.error(`[telegram] polling error: ${errMsg(error)}`);
        await sleep(Math.min(2_000 * 2 ** Math.min(failures, 4), 30_000)).catch(() => undefined);
      }
    }

    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await Promise.allSettled([...this.queues.values()]);
    getMCPManager().stopAll();
    await closeMemoryStore();
  }
}
