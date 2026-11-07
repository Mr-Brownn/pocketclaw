import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const VERSION = "3.1.0";

export function osHomedir(): string {
  return process.env.HOME || homedir();
}

/** PocketClaw's private data directory (config, memory, skills, MCP config). */
export function dataDir(): string {
  return join(osHomedir(), ".pocketclaw");
}

/**
 * When PocketClaw runs as root (e.g. the Telegram daemon on a rooted phone) but the data directory belongs to the
 * Termux user, files it creates must stay owned by that user or the interactive CLI could no longer read them.
 */
export function fixOwnership(path: string): void {
  try {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
    const ref = statSync(path === dataDir() ? osHomedir() : dataDir());
    if (ref.uid !== 0) chownSync(path, ref.uid, ref.gid);
  } catch {
    // best effort
  }
}

export function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort (not supported on every filesystem / platform)
  }
  fixOwnership(dir);
  return dir;
}

/** Atomically writes a private (0600) file, keeping it owned by the data directory's owner. */
export function writePrivateFile(file: string, content: string): void {
  ensurePrivateDir(dirname(file));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best effort
  }
  fixOwnership(tmp);
  renameSync(tmp, file);
}

/**
 * Android has no /etc/localtime, so Node falls back to UTC and "daily 08:00" would fire at the wrong hour.
 * Take the timezone from the Android system property when TZ is not already set.
 */
export function initTimezone(): string {
  if (!process.env.TZ && process.platform !== "win32") {
    try {
      const res = spawnSync("getprop", ["persist.sys.timezone"], { encoding: "utf8", timeout: 2_000 });
      const tz = (res.stdout ?? "").trim();
      if (res.status === 0 && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(tz)) process.env.TZ = tz;
    } catch {
      // not Android
    }
  }
  return process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
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

/** Whole text on one line (whitespace collapsed): good for previews of JSON output. */
export function compactLine(text: string, max = 140): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
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
