import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataDir, errMsg, writePrivateFile } from "./utils.ts";

export type ConfirmMode = "dangerous" | "always" | "never";
export const CONFIRM_MODES: ConfirmMode[] = ["dangerous", "always", "never"];

export interface AppConfig {
  model: string;
  baseUrl: string;
  /** Never written to disk. Comes from LLM_API_KEY (or a runtime /set apiKey). */
  apiKey: string;
  maxTurns: number;
  /** Ceiling (ms) for any single shell command, including ones the agent runs. */
  shellTimeout: number;
  /** dangerous = ask before risky actions, always = ask before every shell/file change, never = no prompts. */
  confirmMode: ConfirmMode;
  /** Models offered as buttons in the Telegram /model view. */
  modelChoices: string[];
}

export type ConfigKey = "model" | "baseUrl" | "apiKey" | "maxTurns" | "shellTimeout" | "confirmMode";
export type Validation = { ok: true; value: string | number } | { ok: false; error: string };

const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const PERSISTED_KEYS = ["model", "baseUrl", "maxTurns", "shellTimeout", "confirmMode"] as const;

export function validateConfigValue(key: string, raw: unknown): Validation {
  switch (key) {
    case "model": {
      const v = typeof raw === "string" ? raw.trim() : "";
      if (!v || v.length > 200 || /\s/.test(v)) {
        return { ok: false, error: "model must be a non-empty string without spaces (max 200 characters)" };
      }
      return { ok: true, value: v };
    }
    case "baseUrl": {
      const v = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
      let url: URL;
      try {
        url = new URL(v);
      } catch {
        return { ok: false, error: "baseUrl must be a valid URL" };
      }
      if (url.username || url.password) {
        return { ok: false, error: "baseUrl must not contain credentials" };
      }
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
        return { ok: false, error: "baseUrl must use https:// (plain http:// is only allowed for localhost)" };
      }
      return { ok: true, value: v };
    }
    case "apiKey": {
      const v = typeof raw === "string" ? raw.trim() : "";
      if (v.length < 8 || v.length > 500 || /\s/.test(v)) {
        return { ok: false, error: "apiKey must be 8-500 characters without whitespace" };
      }
      return { ok: true, value: v };
    }
    case "maxTurns": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 50) {
        return { ok: false, error: "maxTurns must be a whole number between 1 and 50" };
      }
      return { ok: true, value: n };
    }
    case "shellTimeout": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isInteger(n) || n < 1_000 || n > 300_000) {
        return { ok: false, error: "shellTimeout must be a whole number of milliseconds between 1000 and 300000" };
      }
      return { ok: true, value: n };
    }
    case "confirmMode": {
      const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      if (!(CONFIRM_MODES as string[]).includes(v)) {
        return { ok: false, error: `confirmMode must be one of: ${CONFIRM_MODES.join(", ")}` };
      }
      return { ok: true, value: v };
    }
    default:
      return { ok: false, error: `unknown setting "${key}"` };
  }
}

function apply(cfg: AppConfig, key: ConfigKey, value: string | number): void {
  switch (key) {
    case "model":
      cfg.model = String(value);
      break;
    case "baseUrl":
      cfg.baseUrl = String(value);
      break;
    case "apiKey":
      cfg.apiKey = String(value);
      break;
    case "maxTurns":
      cfg.maxTurns = Number(value);
      break;
    case "shellTimeout":
      cfg.shellTimeout = Number(value);
      break;
    case "confirmMode":
      cfg.confirmMode = String(value) as ConfirmMode;
      break;
  }
}

function envValue(key: ConfigKey, envName: string, fallback: string): string {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const v = validateConfigValue(key, raw);
  if (v.ok) return String(v.value);
  console.warn(`[config] ignoring ${envName}: ${v.error}`);
  return fallback;
}

function getDefaultConfig(): AppConfig {
  const model = envValue("model", "LLM_MODEL", DEFAULT_MODEL);
  return {
    model,
    baseUrl: envValue("baseUrl", "LLM_BASE_URL", DEFAULT_BASE_URL),
    apiKey: envValue("apiKey", "LLM_API_KEY", ""),
    maxTurns: 15,
    shellTimeout: 30_000,
    confirmMode: "dangerous",
    modelChoices: [model, "meta/llama-3.3-70b-instruct", "deepseek-ai/deepseek-r1"],
  };
}

export function getConfigFilePath(): string {
  return join(dataDir(), "config.json");
}

let activeConfig: AppConfig | null = null;

/**
 * Precedence: config.json (explicit runtime choices) > environment > built-in defaults.
 * The API key is the exception: it only ever comes from the environment / runtime, never from disk.
 */
export function loadConfig(): AppConfig {
  const cfg = getDefaultConfig();
  const file = getConfigFilePath();
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const key of PERSISTED_KEYS) {
        if (data[key] === undefined) continue;
        const v = validateConfigValue(key, data[key]);
        if (v.ok) apply(cfg, key, v.value);
        else console.warn(`[config] ignoring invalid "${key}" in ${file}: ${v.error}`);
      }
      if (Array.isArray(data.modelChoices)) {
        const choices = data.modelChoices.filter(
          (m): m is string => typeof m === "string" && m.length > 0 && m.length <= 200 && !/\s/.test(m)
        );
        if (choices.length > 0) cfg.modelChoices = [...new Set(choices)].slice(0, 12);
      }
    } catch (error) {
      console.warn(`[config] could not read ${file} (${errMsg(error)}); using defaults`);
    }
  }
  activeConfig = cfg;
  return cfg;
}

export function getConfig(): AppConfig {
  return activeConfig ?? loadConfig();
}

function persist(cfg: AppConfig): void {
  const { apiKey: _neverPersisted, ...rest } = cfg;
  writePrivateFile(getConfigFilePath(), JSON.stringify(rest, null, 2));
}

export function updateConfig(updates: Partial<Record<ConfigKey, string | number>>): AppConfig {
  const next: AppConfig = { ...getConfig() };
  for (const [key, raw] of Object.entries(updates)) {
    if (raw === undefined) continue;
    const v = validateConfigValue(key, raw);
    if (!v.ok) throw new Error(v.error);
    apply(next, key as ConfigKey, v.value);
  }
  persist(next);
  activeConfig = next;
  return next;
}

export function resetConfig(): AppConfig {
  const file = getConfigFilePath();
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch (error) {
      console.warn(`[config] could not delete ${file}: ${errMsg(error)}`);
    }
  }
  activeConfig = getDefaultConfig();
  return activeConfig;
}

/** Parses TELEGRAM_ALLOWED_CHAT_ID: one or more numeric chat IDs separated by commas or spaces. */
export function parseAllowedChatIds(raw: string | undefined): number[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((entry) => {
      if (!/^-?\d+$/.test(entry)) {
        throw new Error(`Invalid TELEGRAM_ALLOWED_CHAT_ID entry "${entry}" (expected numeric chat IDs)`);
      }
      const n = Number(entry);
      if (!Number.isSafeInteger(n) || n === 0) {
        throw new Error(`Invalid TELEGRAM_ALLOWED_CHAT_ID entry "${entry}"`);
      }
      return n;
    });
}

export function maskSecret(secret: string): string {
  if (!secret) return "(not set)";
  return secret.length <= 12 ? "••••" : `••••${secret.slice(-4)}`;
}
