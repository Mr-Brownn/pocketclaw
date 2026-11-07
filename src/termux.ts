import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "./tools.ts";
import { childEnv, errMsg, osHomedir } from "./utils.ts";

const DEFAULT_PREFIX = "/data/data/com.termux/files/usr";

function prefix(): string {
  const p = process.env.PREFIX;
  return p && p.includes("com.termux") ? p : DEFAULT_PREFIX;
}

/** True on a device where the Termux:API command-line tools are installed. */
export function termuxApiAvailable(): boolean {
  return existsSync(join(prefix(), "bin", "termux-battery-status"));
}

export interface TermuxCommand {
  argv: string[];
  stdin?: string;
  /** Why the action is privacy-sensitive or costly (needs approval in "dangerous" mode), or null. */
  reason: string | null;
  timeoutMs: number;
  summary: string;
  /** Appended to the output when the command succeeds (e.g. where a photo was saved). */
  successNote?: string;
}

function text(args: Record<string, unknown>, key: string, max: number, required = true): string {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`"${key}" is required`);
    return "";
  }
  if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
  if (v.length > max) throw new Error(`"${key}" is too long (max ${max} characters)`);
  if (v.includes("\0")) throw new Error(`"${key}" contains an invalid character`);
  return v;
}

function int(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`"${key}" must be a whole number between ${min} and ${max}`);
  }
  return v;
}

export function photoDir(): string {
  const dir = join(osHomedir(), "pocketclaw-photos");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Maps a device tool call to a fixed Termux:API command line. Arguments are validated; no shell is involved. */
export function buildTermuxCommand(name: string, args: Record<string, unknown>): TermuxCommand {
  switch (name) {
    case "device_battery":
      return { argv: ["termux-battery-status"], reason: null, timeoutMs: 15_000, summary: "Read battery status" };
    case "device_wifi":
      return { argv: ["termux-wifi-connectioninfo"], reason: null, timeoutMs: 15_000, summary: "Read Wi-Fi connection info" };
    case "device_notify": {
      const title = text(args, "title", 200);
      const content = text(args, "content", 1_000);
      return {
        argv: ["termux-notification", "--title", title, "--content", content],
        reason: null,
        timeoutMs: 15_000,
        summary: `Show notification "${title}"`,
      };
    }
    case "device_clipboard_get":
      return { argv: ["termux-clipboard-get"], reason: "reads your clipboard", timeoutMs: 15_000, summary: "Read the clipboard" };
    case "device_clipboard_set": {
      const value = text(args, "text", 10_000);
      return { argv: ["termux-clipboard-set"], stdin: value, reason: null, timeoutMs: 15_000, summary: "Set the clipboard" };
    }
    case "device_torch": {
      if (typeof args.on !== "boolean") throw new Error('"on" must be true or false');
      return { argv: ["termux-torch", args.on ? "on" : "off"], reason: null, timeoutMs: 15_000, summary: `Turn the torch ${args.on ? "on" : "off"}` };
    }
    case "device_speak": {
      const value = text(args, "text", 2_000);
      return { argv: ["termux-tts-speak"], stdin: value, reason: null, timeoutMs: 90_000, summary: "Speak text aloud" };
    }
    case "device_vibrate": {
      const ms = int(args, "duration_ms", 50, 5_000, 500);
      return { argv: ["termux-vibrate", "-d", String(ms)], reason: null, timeoutMs: 15_000, summary: `Vibrate for ${ms} ms` };
    }
    case "device_location": {
      const provider = text(args, "provider", 10, false) || "network";
      if (!["gps", "network", "passive"].includes(provider)) throw new Error('"provider" must be gps, network or passive');
      return {
        argv: ["termux-location", "-p", provider, "-r", "once"],
        reason: "reads your precise location",
        timeoutMs: 45_000,
        summary: `Read location (${provider})`,
      };
    }
    case "device_camera_photo": {
      const camera = int(args, "camera", 0, 1, 0);
      const file = join(photoDir(), `photo-${Date.now()}.jpg`);
      return {
        argv: ["termux-camera-photo", "-c", String(camera), file],
        reason: "takes a photo with the camera",
        timeoutMs: 30_000,
        summary: `Take a photo with camera ${camera}`,
        successNote: `Photo saved to ${file}`,
      };
    }
    case "device_sms_send": {
      const number = text(args, "number", 20);
      if (!/^\+?[0-9]{5,15}$/.test(number)) throw new Error('"number" must be a phone number (digits, optional leading +)');
      const body = text(args, "text", 1_000);
      return {
        argv: ["termux-sms-send", "-n", number],
        stdin: body,
        reason: "sends an SMS (it may cost money)",
        timeoutMs: 30_000,
        summary: `Send SMS to ${number}: ${body.slice(0, 80)}`,
      };
    }
    default:
      throw new Error(`Unknown device tool: ${name}`);
  }
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface RunResult {
  ok: boolean;
  code: number | null;
  output: string;
}

function runOnce(
  file: string,
  args: string[],
  stdin: string | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  env: NodeJS.ProcessEnv
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    let out = "";
    let err = "";
    let settled = false;
    const done = (code: number | null, extra = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const text = out.trim() || (code === 0 ? "" : `${err.trim()}${extra ? `\n${extra}` : ""}`.trim());
      resolvePromise({ ok: code === 0, code, output: text.slice(0, 10_000) });
    };
    const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const kill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      kill();
      done(null, `timed out after ${Math.round(timeoutMs / 1000)}s (is the Termux:API app installed and permitted?)`);
    }, timeoutMs);
    const onAbort = (): void => {
      kill();
      done(null, "cancelled");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => (out += c));
    child.stderr?.on("data", (c: string) => (err += c));
    child.on("error", (e) => done(null, e.message));
    child.on("close", (code) => done(code));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin ?? "");
  });
}

/**
 * Runs a Termux:API command. The API app only answers the Termux user, so when PocketClaw runs as root (rooted-phone
 * daemon) the command is run as the owner of the Termux home directory first, then directly as a fallback.
 */
export async function runTermuxApi(
  cmd: TermuxCommand,
  signal?: AbortSignal
): Promise<{ ok: boolean; output: string }> {
  if (!termuxApiAvailable()) {
    return {
      ok: false,
      output: "Termux:API is not available on this device. In Termux run `pkg install termux-api` and install the Termux:API app.",
    };
  }
  const bin = join(prefix(), "bin");
  const exe = join(bin, cmd.argv[0] ?? "");
  const rest = cmd.argv.slice(1);
  const env = childEnv({ PATH: `${bin}:${process.env.PATH ?? ""}`, PREFIX: prefix(), HOME: osHomedir() });

  const attempts: Array<() => Promise<RunResult>> = [];
  try {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      const uid = statSync(osHomedir()).uid;
      if (uid !== 0) {
        const line = [`export PATH=${shQuote(env.PATH ?? "")} PREFIX=${shQuote(prefix())} HOME=${shQuote(osHomedir())}`, `exec ${[exe, ...rest].map(shQuote).join(" ")}`].join("; ");
        attempts.push(() => runOnce("su", [String(uid), "-c", line], cmd.stdin, cmd.timeoutMs, signal, env));
      }
    }
  } catch {
    // fall through to the direct attempt
  }
  attempts.push(() => runOnce(exe, rest, cmd.stdin, cmd.timeoutMs, signal, env));

  let last: RunResult = { ok: false, code: null, output: "no attempt was made" };
  for (const attempt of attempts) {
    try {
      last = await attempt();
    } catch (error) {
      last = { ok: false, code: null, output: errMsg(error) };
    }
    if (last.ok || signal?.aborted) break;
  }
  return { ok: last.ok, output: last.output || (last.ok ? "Done." : "The command failed without output.") };
}

// ------------------------------------------------------- tool definitions

function def(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, ...(required.length > 0 ? { required } : {}) },
    },
  };
}

const s = (description: string) => ({ type: "string", description });

export const TERMUX_TOOLS: ToolDefinition[] = [
  def("device_battery", "Get battery percentage, charging state, temperature and health (Termux:API)."),
  def("device_wifi", "Get the current Wi-Fi connection info: SSID, IP address, signal strength (Termux:API)."),
  def("device_notify", "Show an Android notification on the device.", { title: s("Notification title."), content: s("Notification text.") }, ["title", "content"]),
  def("device_clipboard_get", "Read the clipboard text (needs the user's approval)."),
  def("device_clipboard_set", "Replace the clipboard text.", { text: s("Text to copy.") }, ["text"]),
  def("device_torch", "Turn the flashlight on or off.", { on: { type: "boolean", description: "true = on, false = off." } }, ["on"]),
  def("device_speak", "Speak text aloud with the device's text-to-speech.", { text: s("Text to speak.") }, ["text"]),
  def("device_vibrate", "Vibrate the device.", { duration_ms: { type: "number", description: "50-5000, default 500." } }),
  def(
    "device_location",
    "Get the device's current location as JSON (needs the user's approval).",
    { provider: { type: "string", enum: ["network", "gps", "passive"], description: "Default network (fast); gps is more precise but slower." } }
  ),
  def(
    "device_camera_photo",
    "Take a photo and save it as a JPEG in ~/pocketclaw-photos/; returns the file path (needs the user's approval).",
    { camera: { type: "number", description: "0 = back camera (default), 1 = front camera." } }
  ),
  def(
    "device_sms_send",
    "Send an SMS text message (needs the user's approval; may cost money).",
    { number: s("Phone number, digits with optional leading +."), text: s("Message text.") },
    ["number", "text"]
  ),
];
