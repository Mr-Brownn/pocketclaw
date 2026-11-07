import { SYSTEM_PROMPT } from "./prompt.ts";
import { chatCompletion } from "./llm.ts";
import type { ChatMessage, LLMConfig } from "./llm.ts";
import { describeToolCall, executeTool, getActiveTools } from "./tools.ts";
import type { ToolContext, ToolResult } from "./tools.ts";
import { getConfig } from "./config.ts";
import { compactLine, errMsg } from "./utils.ts";

/** Structured progress events: the CLI prints them, Telegram renders them as a live status message. */
export type AgentEvent =
  | { type: "thinking"; turn: number; maxTurns: number }
  /** A piece of the model's reply, streamed as it is generated (only when AgentOptions.stream is set). */
  | { type: "text_delta"; text: string }
  | { type: "narration"; text: string }
  | { type: "tool_start"; id: string; name: string; summary: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; ms: number; preview: string }
  | { type: "notice"; text: string };

export interface AgentOptions {
  llmConfig?: Partial<LLMConfig>;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  /** Called when a tool wants the user's approval (see confirmMode). Without it, risky actions are blocked. */
  confirm?: ToolContext["confirm"];
  signal?: AbortSignal;
  maxTurns?: number;
  /** Stream the model's text as `text_delta` events. */
  stream?: boolean;
  /** Telegram chat this run belongs to (delivery target for scheduled tasks). */
  chatId?: number;
  /** Marks an unattended scheduled run (it may not schedule further tasks). */
  scheduled?: boolean;
}

export const STOPPED_MESSAGE = "Stopped by user.";

const MAX_MESSAGES = 80;
const MAX_HISTORY_CHARS = 200_000;

function sizeOf(message: ChatMessage): number {
  return (message.content?.length ?? 0) + (message.tool_calls ? JSON.stringify(message.tool_calls).length : 0);
}

/** Plain-text rendering of an event (used by the CLI). */
export function formatEvent(event: AgentEvent): string {
  switch (event.type) {
    case "thinking":
      return `🧠 Thinking (step ${event.turn}/${event.maxTurns})…`;
    case "text_delta":
      return event.text;
    case "narration":
      return `🗣️ ${event.text}`;
    case "tool_start":
      return event.summary;
    case "tool_end":
      return `   ↳ ${event.ok ? "✅" : "❌"} ${event.preview} (${event.ms} ms)`;
    case "notice":
      return `ℹ️ ${event.text}`;
  }
}

function parseArgs(raw: string | undefined): { args?: Record<string, unknown>; error?: string } {
  try {
    const value: unknown = JSON.parse(raw && raw.trim() ? raw : "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { args: value as Record<string, unknown> };
    }
    return { error: "tool arguments must be a JSON object" };
  } catch (error) {
    return { error: `tool arguments are not valid JSON (${errMsg(error)})` };
  }
}

export class Agent {
  private messages: ChatMessage[] = [];
  private busy = false;

  constructor(systemPrompt: string = SYSTEM_PROMPT) {
    this.messages.push({ role: "system", content: systemPrompt });
  }

  public getHistory(): ChatMessage[] {
    return [...this.messages];
  }

  public reset(): void {
    const sys = this.messages.find((m) => m.role === "system");
    this.messages = sys ? [sys] : [];
  }

  /** Replaces the conversation with a saved one. The current system prompt always wins over the saved one. */
  public loadHistory(saved: unknown): number {
    if (this.busy) throw new Error("The agent is busy");
    if (!Array.isArray(saved)) throw new Error("History must be an array of messages");
    const roles = new Set(["user", "assistant", "tool"]);
    const clean: ChatMessage[] = [];
    for (const raw of saved) {
      if (!raw || typeof raw !== "object") throw new Error("Malformed message in history");
      const m = raw as Partial<ChatMessage>;
      if (m.role === "system") continue;
      if (!m.role || !roles.has(m.role)) throw new Error("Unknown message role in history");
      if (m.content !== undefined && m.content !== null && typeof m.content !== "string") {
        throw new Error("Malformed message content in history");
      }
      clean.push({
        role: m.role,
        ...(m.content !== undefined ? { content: m.content } : {}),
        ...(Array.isArray(m.tool_calls) ? { tool_calls: m.tool_calls } : {}),
        ...(typeof m.tool_call_id === "string" ? { tool_call_id: m.tool_call_id } : {}),
      });
    }
    // A conversation must start with a user message, and must not end in the middle of a tool exchange.
    while (clean.length > 0 && clean[0]!.role !== "user") clean.shift();
    while (clean.length > 0) {
      const last = clean[clean.length - 1]!;
      if (last.role === "assistant" && !last.tool_calls?.length) break;
      if (last.role === "user") break;
      clean.pop();
    }
    const sys = this.messages.find((m) => m.role === "system");
    this.messages = sys ? [sys, ...clean] : clean;
    return clean.length;
  }

  /** Drops the oldest whole turns (never splitting a tool call from its results) when history grows too large. */
  private trim(): void {
    let total = this.messages.reduce((sum, m) => sum + sizeOf(m), 0);
    while (this.messages.length > MAX_MESSAGES || total > MAX_HISTORY_CHARS) {
      let next = 2;
      while (next < this.messages.length && this.messages[next]!.role !== "user") next++;
      if (next >= this.messages.length) break; // the current turn is all that is left
      total -= this.messages.slice(1, next).reduce((sum, m) => sum + sizeOf(m), 0);
      this.messages.splice(1, next - 1);
    }
  }

  public async run(userPrompt: string, options: AgentOptions = {}): Promise<string> {
    if (this.busy) throw new Error("The agent is already working on a task");
    this.busy = true;
    const startLength = this.messages.length;
    try {
      return await this.loop(userPrompt, options);
    } catch (error) {
      // A failed turn (API error, ...) is rolled back so the next message starts from a valid history.
      if (!options.signal?.aborted) this.messages.length = startLength;
      throw error;
    } finally {
      this.busy = false;
    }
  }

  private async loop(userPrompt: string, options: AgentOptions): Promise<string> {
    const signal = options.signal;
    const maxTurns = options.maxTurns ?? getConfig().maxTurns;
    const ctx: ToolContext = { confirm: options.confirm, signal, chatId: options.chatId, scheduled: options.scheduled };
    const emit = async (event: AgentEvent): Promise<void> => {
      try {
        await options.onEvent?.(event);
      } catch {
        // a broken UI must never break the agent
      }
    };
    const onText = options.stream ? (delta: string): void => void emit({ type: "text_delta", text: delta }) : undefined;

    this.messages.push({ role: "user", content: userPrompt });

    for (let turn = 1; turn <= maxTurns; turn++) {
      if (signal?.aborted) return STOPPED_MESSAGE;
      this.trim();
      await emit({ type: "thinking", turn, maxTurns });

      let assistant: ChatMessage;
      try {
        assistant = await chatCompletion(this.messages, getActiveTools(), options.llmConfig, signal, onText);
      } catch (error) {
        if (signal?.aborted) return STOPPED_MESSAGE;
        throw error;
      }
      this.messages.push(assistant);

      const calls = assistant.tool_calls ?? [];
      if (calls.length === 0) return assistant.content?.trim() || "(No content returned)";

      const narration = assistant.content?.trim();
      if (narration) await emit({ type: "narration", text: narration });

      for (const [index, call] of calls.entries()) {
        if (signal?.aborted) {
          // Every tool call needs a matching result or the next API request is rejected.
          for (const skipped of calls.slice(index)) {
            this.messages.push({ role: "tool", tool_call_id: skipped.id, content: "Cancelled by the user before it ran." });
          }
          return STOPPED_MESSAGE;
        }

        const name = call.function.name;
        const parsed = parseArgs(call.function.arguments);
        const summary = parsed.args ? describeToolCall(name, parsed.args) : `⚙️ Running ${name}`;
        await emit({ type: "tool_start", id: call.id, name, summary });

        const started = Date.now();
        const result: ToolResult = parsed.args
          ? await executeTool(name, parsed.args, ctx)
          : { ok: false, output: `Error: ${parsed.error}. Fix the arguments and call the tool again.`, note: "bad arguments" };

        await emit({
          type: "tool_end",
          id: call.id,
          name,
          ok: result.ok,
          ms: Date.now() - started,
          preview: result.note ?? (compactLine(result.output, 140) || (result.ok ? "done" : "failed")),
        });
        this.messages.push({ role: "tool", tool_call_id: call.id, content: result.output });
      }
    }

    return `⚠️ Reached the step limit (${maxTurns}) before finishing. Say "continue" to keep going, or raise the limit with /set maxTurns.`;
  }
}
