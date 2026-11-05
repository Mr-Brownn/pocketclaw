import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dataDir, isInside, osHomedir } from "./utils.ts";

/**
 * Heuristics that decide when an action needs the user's approval.
 * These are a speed bump against mistakes and prompt injection, NOT a sandbox:
 * a determined or confused model can phrase a command in ways a regex will not catch.
 */
const SHELL_RULES: Array<[RegExp, string]> = [
  [
    /(^|[;&|`(]|\s)rm\s+([^;&|\n]*\s)?(-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)(\s|$)/,
    "recursive or forced file deletion",
  ],
  [/\b(shred|wipefs)\b|\bfind\b[^;&|\n]*\s-delete\b/, "bulk or irreversible deletion"],
  [/\bmkfs(\.\w+)?\b/, "formatting a filesystem"],
  [/\bdd\b[^;&|\n]*\bof=/, "raw disk/file write with dd"],
  [/>\s*\/dev\/(sd|mmcblk|block|nvme)/, "writing to a block device"],
  [/\b(chmod|chown)\s+[^;&|\n]*-[a-zA-Z]*R/, "recursive permission/ownership change"],
  [/(^|[;&|`(]|\s)(reboot|shutdown|poweroff|halt)\b|\bsvc\s+power\b/, "rebooting or powering off the device"],
  [/\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, "piping a download straight into a shell"],
  [/\bpm\s+(uninstall|clear|disable|disable-user)\b|\bcmd\s+package\s+uninstall\b/, "uninstalling or wiping an app"],
  [/:\(\)\s*\{/, "fork bomb pattern"],
  [/\/dev\/tcp\/|\b(nc|ncat|netcat)\b[^;&|\n]*\s-[a-zA-Z]*[el]/, "opening a network listener or reverse shell"],
  [
    /\b(cat|cp|scp|tar|zip|base64|curl|wget)\b[^;&|\n]*(\.ssh\/|\.gnupg\/|\.netrc|\.git-credentials|\.pocketclaw\/(config|mcp|env)|id_rsa|id_ed25519)/,
    "reading or copying credential files",
  ],
  [
    />>?\s*~?\/?[^\s;&|]*\.(bashrc|bash_profile|profile|zshrc|zprofile)\b|\.termux\/boot/,
    "modifying shell startup or boot scripts",
  ],
];

export function assessShell(command: string): string | null {
  for (const [pattern, reason] of SHELL_RULES) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

export function expandHome(p: string): string {
  if (p === "~") return osHomedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(osHomedir(), p.slice(2));
  return p;
}

function writeRoots(): string[] {
  return [osHomedir(), tmpdir(), "/sdcard", "/storage", "/data/local/tmp", process.cwd()];
}

export function assessPath(rawPath: string, mode: "read" | "write"): string | null {
  const p = resolve(expandHome(rawPath));
  const norm = p.replace(/\\/g, "/").toLowerCase();

  const data = dataDir();
  if (isInside(data, p) && !isInside(join(data, "skills"), p)) {
    return "PocketClaw's private config/memory directory";
  }
  if (/\/\.(ssh|gnupg|aws|kube)(\/|$)/.test(norm) || /\/\.(netrc|git-credentials)$/.test(norm)) {
    return "credential files";
  }
  if (mode === "write") {
    if (/\/\.(bashrc|bash_profile|profile|zshrc|zprofile)$/.test(norm) || /\/\.termux\/boot(\/|$)/.test(norm)) {
      return "shell startup/boot scripts (persistence)";
    }
    if (!writeRoots().some((root) => isInside(root, p))) {
      return "a location outside your home folder, shared storage and temp directories";
    }
  }
  return null;
}
