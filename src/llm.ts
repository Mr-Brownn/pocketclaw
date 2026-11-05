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
const REQUEST_TIMEOUT_MS = 90_000;
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

export async function chatCompletion(
  messages: ChatMessage[],
  tools?: unknown[],
  config?: Partial<LLMConfig>,
  signal?: AbortSignal
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
  const payload = JSON.stringify(body);

  let lastError: unknown = new LLMError("LLM request failed");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: payload,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });

      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        lastError = new LLMError(`HTTP ${response.status} from LLM API`, response.status, true);
        if (attempt === MAX_ATTEMPTS - 1) break;
        const retryAfter = Number(response.headers.get("retry-after"));
        const backoff = Math.min(2_000 * 2 ** attempt, 30_000);
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1_000 : backoff;
        console.warn(`[LLM API] HTTP ${response.status}, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await sleep(waitMs, signal);
        continue;
      }

      if (!response.ok) {
        const text = (await response.text()).slice(0, 500);
        // 4xx (bad key, bad model, bad request) will not fix itself: fail fast.
        throw new LLMError(`HTTP ${response.status}: ${text}`, response.status, false);
      }

      const data = (await response.json()) as { choices?: Array<{ message?: unknown }> };
      return normalizeMessage(data.choices?.[0]?.message);
    } catch (error) {
      if (signal?.aborted) throw new Error("Aborted");
      if (error instanceof LLMError && !error.retryable) throw error;
      lastError = error;
      if (attempt === MAX_ATTEMPTS - 1) break;
      await sleep(Math.min(1_000 * 2 ** attempt, 15_000), signal);
    }
  }

  throw lastError instanceof Error ? lastError : new LLMError(String(lastError));
}
