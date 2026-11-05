import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const VERSION = "3.0.0";

export function osHomedir(): string {
  return process.env.HOME || homedir();
}

/** PocketClaw's private data directory (config, memory, skills, MCP config). */
export function dataDir(): string {
  return join(osHomedir(), ".pocketclaw");
}

export function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort (not supported on every filesystem / platform)
  }
  return dir;
}

/** True when `target` is `base` itself or lives somewhere underneath it. */
export function isInside(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target));
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(".." + sep)) return false;
  return !isAbsolute(rel);
}

export function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} more characters]`;
}

export function firstLine(text: string, max = 140): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Sleep that rejects as soon as the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Split long text into chunks that fit a chat message, preferring line/word boundaries. */
export function chunkText(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/** Secrets PocketClaw itself needs; they must never leak into child processes the agent controls. */
const PRIVATE_ENV_KEYS = ["LLM_API_KEY", "TELEGRAM_BOT_TOKEN"];

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of PRIVATE_ENV_KEYS) delete env[key];
  return { ...env, ...extra };
}
