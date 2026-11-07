import { getConfig, validateConfigValue } from "./config.ts";
import { sleep } from "./utils.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class LLMError extends Error {
  status?: number;
  retryable: boolean;

  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.retryable = retryable;
  }
}

export function getLLMConfig(): LLMConfig {
  const cfg = getConfig();
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model };
}

const MAX_ATTEMPTS = 5;
const TOTAL_TIMEOUT_MS = 90_000; // non-streaming requests
const CONNECT_TIMEOUT_MS = 60_000; // streaming: time to first byte
const IDLE_TIMEOUT_MS = 45_000; // streaming: max silence between chunks
const MAX_TOKENS = 4096;

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

function normalizeMessage(raw: unknown): ChatMessage {
  if (!raw || typeof raw !== "object") throw new LLMError("Malformed response from LLM API (no message)");
  const msg = raw as { content?: unknown; tool_calls?: unknown };
  const calls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as RawToolCall[]) : [];
  const tool_calls = calls
    .filter((c) => typeof c?.function?.name === "string" && c.function.name.length > 0)
    .map((c, i) => ({
      id: c.id || `call_${Date.now()}_${i}`,
      type: "function" as const,
      function: {
        name: c.function!.name as string,
        arguments:
          typeof c.function!.arguments === "string"
            ? c.function!.arguments
            : JSON.stringify(c.function!.arguments ?? {}),
      },
    }));
  return {
    role: "assistant",
    content: typeof msg.content === "string" ? msg.content : null,
    ...(tool_calls.length > 0 ? { tool_calls } : {}),
  };
}

interface StreamState {
  /** True once any bytes arrived: from then on the request is no longer safe to retry. */
  received: boolean;
}

/** Reads an OpenAI-style server-sent-events stream, forwarding text deltas and assembling tool calls. */
async function readStream(
  response: Response,
  onText: (delta: string) => void,
  state: StreamState,
  keepAlive: () => void
): Promise<ChatMessage> {
  if (!response.body) throw new LLMError("LLM API returned an empty stream", undefined, true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();

  const handle = (payload: string): boolean => {
    if (payload === "[DONE]") return true;
    let json: { choices?: Array<{ delta?: Record<string, unknown> }> };
    try {
      json = JSON.parse(payload);
    } catch {
      return false;
    }
    const delta = json.choices?.[0]?.delta;
    if (!delta) return false;
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onText(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls as Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>) {
        const index = typeof tc.index === "number" ? tc.index : 0;
        const current = calls.get(index) ?? { id: "", name: "", args: "" };
        if (tc.id) current.id = tc.id;
        if (tc.function?.name && !current.name) current.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") current.args += tc.function.arguments;
        calls.set(index, current);
      }
    }
    return false;
  };

  const finish = (): ChatMessage => {
    const tool_calls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, c]) => c.name)
      .map(([index, c]) => ({
        id: c.id || `call_${Date.now()}_${index}`,
        type: "function" as const,
        function: { name: c.name, arguments: c.args || "{}" },
      }));
    return {
      role: "assistant",
      content: content || null,
      ...(tool_calls.length > 0 ? { tool_calls } : {}),
    };
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    state.received = true;
    keepAlive();
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      if (handle(line.slice(5).trim())) {
        await reader.cancel().catch(() => undefined);
        return finish();
      }
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) handle(tail.slice(5).trim());
  return finish();
}

/**
 * Calls the chat completions API. When `onText` is given the response is streamed and text deltas are passed to it
 * as they arrive; the returned message is the fully assembled assistant message either way.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  tools?: unknown[],
  config?: Partial<LLMConfig>,
  signal?: AbortSignal,
  onText?: (delta: string) => void
): Promise<ChatMessage> {
  const cfg = { ...getLLMConfig(), ...config };
  if (!cfg.apiKey) {
    throw new LLMError("No API key configured. Set the LLM_API_KEY environment variable (see README).");
  }
  const urlCheck = validateConfigValue("baseUrl", cfg.baseUrl);
  if (!urlCheck.ok) throw new LLMError(`Refusing to call LLM API: ${urlCheck.error}`);
  const url = `${String(urlCheck.value)}/chat/completions`;

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    max_tokens: MAX_TOKENS,
    temperature: 0.2,
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (onText) body.stream = true;
  const payload = JSON.stringify(body);

  let lastError: unknown = new LLMError("LLM request failed");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const state: StreamState = { received: false };
    const timeout = new AbortController();
    let timer = setTimeout(() => timeout.abort(), onText ? CONNECT_TIMEOUT_MS : TOTAL_TIMEOUT_MS);
    const keepAlive = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => timeout.abort(), IDLE_TIMEOUT_MS);
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: payload,
        signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
      });

      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        lastError = new LLMError(`HTTP ${response.status} from LLM API`, response.status, true);
        if (attempt === MAX_ATTEMPTS - 1) break;
        const retryAfter = Number(response.headers.get("retry-after"));
        const backoff = Math.min(2_000 * 2 ** attempt, 30_000);
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1_000 : backoff;
        console.warn(
          `[LLM API] HTTP ${response.status}, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})`
        );
        clearTimeout(timer);
        await sleep(waitMs, signal);
        continue;
      }

      if (!response.ok) {
        const text = (await response.text()).slice(0, 500);
        // 4xx (bad key, bad model, bad request) will not fix itself: fail fast.
        throw new LLMError(`HTTP ${response.status}: ${text}`, response.status, false);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (onText && contentType.includes("text/event-stream")) {
        keepAlive();
        return await readStream(response, onText, state, keepAlive);
      }

      const data = (await response.json()) as { choices?: Array<{ message?: unknown }> };
      const message = normalizeMessage(data.choices?.[0]?.message);
      // The provider ignored stream=true: still surface the text through the callback.
      if (onText && message.content) onText(message.content);
      return message;
    } catch (error) {
      if (signal?.aborted) throw new Error("Aborted");
      if (error instanceof LLMError && !error.retryable) throw error;
      // Text may already be on the user's screen; retrying would print it twice.
      if (state.received) throw error;
      lastError = error;
      if (attempt === MAX_ATTEMPTS - 1) break;
      clearTimeout(timer);
      await sleep(Math.min(1_000 * 2 ** attempt, 15_000), signal);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new LLMError(String(lastError));
}
