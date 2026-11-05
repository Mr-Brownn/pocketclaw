import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { childEnv } from "./utils.ts";

export interface ShellResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  /** True when stdout/stderr were longer than what is returned (middle section omitted). */
  truncated: boolean;
  /** True when the run was cancelled via an AbortSignal. */
  aborted: boolean;
}

const HEAD_CHARS = 5_000;
const TAIL_CHARS = 2_500;
const IS_WINDOWS = process.platform === "win32";

/** Keeps the start and (rolling) end of a stream so both the command's setup and its error tail survive. */
class Capture {
  private head = "";
  private tail = "";
  private total = 0;

  push(chunk: string): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.head.length < HEAD_CHARS) {
      const room = HEAD_CHARS - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (rest) this.tail = (this.tail + rest).slice(-TAIL_CHARS);
  }

  result(): { text: string; cut: boolean } {
    const kept = this.head.length + this.tail.length;
    if (this.total <= kept) return { text: this.head + this.tail, cut: false };
    return {
      text: `${this.head}\n…[${this.total - kept} characters omitted]…\n${this.tail}`,
      cut: true,
    };
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (IS_WINDOWS) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGKILL"); // whole process group, not just the shell
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Executes a shell command with a hard timeout, captured (bounded) output, optional cancellation,
 * and without leaking PocketClaw's own secrets into the child's environment.
 */
export function runShell(command: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<ShellResult> {
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;

  return new Promise((resolvePromise) => {
    const file = IS_WINDOWS ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
    const args = IS_WINDOWS ? ["/d", "/s", "/c", command] : ["-c", command];

    const out = new Capture();
    const err = new Capture();
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess;

    const finish = (code: number | null, extraStderr = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", onAbort);
      const o = out.result();
      const e = err.result();
      resolvePromise({
        exit_code: code,
        stdout: o.text,
        stderr: extraStderr ? `${e.text}${e.text ? "\n" : ""}${extraStderr}` : e.text,
        timed_out: timedOut,
        truncated: o.cut || e.cut,
        aborted,
      });
    };

    const stop = (): void => {
      killTree(child);
      // If grandchildren keep the pipes open, 'close' may never fire; do not hang forever.
      forceTimer = setTimeout(() => finish(null), 2_000);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, limit);

    const onAbort = (): void => {
      aborted = true;
      stop();
    };

    try {
      child = spawn(file, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: !IS_WINDOWS,
        windowsHide: true,
        env: childEnv(),
      });
    } catch (error) {
      finish(null, String(error));
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => out.push(chunk));
    child.stderr?.on("data", (chunk: string) => err.push(chunk));
    child.on("error", (error) => finish(null, String(error)));
    child.on("close", (code) => finish(code));

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
