import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION, childEnv, dataDir, ensurePrivateDir, errMsg } from "./utils.ts";

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPConfigFile {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
}

export interface MCPServerStatus {
  name: string;
  command: string;
  running: boolean;
  toolCount: number;
  error: string;
}

const INIT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const IS_WINDOWS = process.platform === "win32";

// ---------------------------------------------------------------- config file

function mcpConfigPath(): string {
  return join(dataDir(), "mcp.json");
}

export function getMcpConfig(): MCPConfigFile {
  const file = mcpConfigPath();
  if (!existsSync(file)) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MCPConfigFile>;
    if (parsed && typeof parsed === "object" && parsed.mcpServers && typeof parsed.mcpServers === "object") {
      return { mcpServers: parsed.mcpServers };
    }
    throw new Error('missing "mcpServers" object');
  } catch (error) {
    // Keep the unreadable file around instead of silently overwriting it on the next save.
    try {
      copyFileSync(file, `${file}.bak`);
    } catch {
      // ignore
    }
    console.warn(`[mcp] could not read ${file} (${errMsg(error)}); a copy was kept as mcp.json.bak`);
    return { mcpServers: {} };
  }
}

function saveMcpConfig(cfg: MCPConfigFile): void {
  const dir = ensurePrivateDir(dataDir());
  const file = join(dir, "mcp.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}

/** Throws a descriptive error when a server definition is not acceptable. */
export function validateServerSpec(
  name: string,
  command: string,
  args: string[] = [],
  env: Record<string, string> = {}
): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
    throw new Error("MCP server name must be 1-32 characters: letters, digits, '_' or '-'");
  }
  if (!command || command.length > 500 || /[\r\n\0]/.test(command)) {
    throw new Error("MCP server command must be a single-line string (max 500 characters)");
  }
  if (args.length > 50 || args.some((a) => typeof a !== "string" || a.length > 2000 || a.includes("\0"))) {
    throw new Error("MCP server args must be at most 50 strings of up to 2000 characters");
  }
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.length > 2000) {
      throw new Error(`Invalid environment variable "${key}" for MCP server`);
    }
  }
}

export function addMcpServer(
  name: string,
  command: string,
  args: string[] = [],
  env: Record<string, string> = {}
): string {
  validateServerSpec(name, command, args, env);
  const cfg = getMcpConfig();
  cfg.mcpServers[name] = { command, args, env };
  saveMcpConfig(cfg);
  return `Saved MCP server '${name}' (${command} ${args.join(" ")})`.trim();
}

export function removeMcpServer(name: string): string {
  const cfg = getMcpConfig();
  if (!Object.hasOwn(cfg.mcpServers, name)) return `MCP server '${name}' not found.`;
  delete cfg.mcpServers[name];
  saveMcpConfig(cfg);
  return `Removed MCP server '${name}'.`;
}

// ------------------------------------------------------------- server process

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class MCPServerProcess {
  readonly name: string;
  private config: MCPServerConfig;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private stderrTail = "";
  private stopping = false;
  running = false;
  tools: MCPTool[] = [];
  lastError = "";

  constructor(name: string, config: MCPServerConfig) {
    this.name = name;
    this.config = config;
  }

  async start(): Promise<MCPTool[]> {
    try {
      this.spawnChild();
      await this.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "PocketClaw", version: VERSION },
        },
        INIT_TIMEOUT_MS
      );
      this.notify("notifications/initialized", {});
      const res = (await this.request("tools/list", {}, INIT_TIMEOUT_MS)) as { tools?: unknown[] } | undefined;
      this.tools = (res?.tools ?? [])
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string")
        .map((t) => {
          const schema = t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema as Record<string, unknown>) : {};
          return {
            name: String(t.name),
            description: typeof t.description === "string" ? t.description : "",
            inputSchema: { type: "object", properties: {}, ...schema },
            serverName: this.name,
          };
        });
      this.lastError = "";
      return this.tools;
    } catch (error) {
      const tail = this.stderrTail.trim();
      this.lastError = `${errMsg(error)}${tail ? ` | stderr: ${tail.slice(-300)}` : ""}`;
      this.stop();
      return [];
    }
  }

  private spawnChild(): void {
    const child = spawn(this.config.command, this.config.args ?? [], {
      env: childEnv(this.config.env ?? {}),
      stdio: ["pipe", "pipe", "pipe"],
      shell: IS_WINDOWS, // npx & friends are .cmd shims on Windows
      windowsHide: true,
    });
    this.child = child;
    this.running = true;
    this.stopping = false;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-1_000);
    });
    child.stdin?.on("error", () => undefined); // EPIPE when the server dies
    child.on("error", (error) => this.onExit(`failed to start: ${error.message}`));
    child.on("exit", (code, signal) => this.onExit(`exited (code ${code ?? "?"}, signal ${signal ?? "none"})`));
  }

  private onExit(reason: string): void {
    this.running = false;
    this.child = null;
    if (!this.stopping && !this.lastError) this.lastError = reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP server '${this.name}' ${reason}`));
    }
    this.pending.clear();
  }

  private write(message: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || !this.running) throw new Error(`MCP server '${this.name}' is not running`);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    try {
      this.write({ method, params });
    } catch {
      // surfaced by the next request
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP '${method}' timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: { id?: unknown; method?: string; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // servers sometimes log plain text on stdout
      }

      if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method && msg.id !== undefined) {
        // Request from the server to us: answer pings, decline everything else.
        if (msg.method === "ping") this.notifyReply(msg.id, { result: {} });
        else this.notifyReply(msg.id, { error: { code: -32601, message: "Method not found" } });
      }
    }
  }

  private notifyReply(id: unknown, body: Record<string, unknown>): void {
    try {
      this.write({ id, ...body });
    } catch {
      // ignore
    }
  }

  async callTool(toolName: string, toolArgs: Record<string, unknown>): Promise<string> {
    const res = (await this.request("tools/call", { name: toolName, arguments: toolArgs }, CALL_TIMEOUT_MS)) as
      | { content?: unknown[]; isError?: boolean }
      | undefined;
    let text: string;
    if (res && Array.isArray(res.content)) {
      text = res.content
        .map((c) => {
          const part = c as { type?: string; text?: string };
          if (typeof part.text === "string") return part.text;
          if (part.type === "image" || part.type === "audio") return `[${part.type} content omitted]`;
          return JSON.stringify(c);
        })
        .join("\n");
    } else {
      text = JSON.stringify(res, null, 2);
    }
    if (res?.isError) throw new Error(text || "tool reported an error");
    return text;
  }

  stop(): void {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    try {
      if (IS_WINDOWS && child.pid !== undefined) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      } else {
        child.kill();
      }
    } catch {
      // already gone
    }
  }
}

// -------------------------------------------------------------------- manager

export class MCPManager {
  private servers = new Map<string, MCPServerProcess>();
  private tools = new Map<string, { serverName: string; tool: MCPTool }>();
  private initialized = false;

  /** Starts every configured server in parallel; safe to call more than once. */
  public async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const config = getMcpConfig();
    await Promise.allSettled(Object.entries(config.mcpServers).map(([name, cfg]) => this.startServer(name, cfg)));
  }

  public async startServer(
    name: string,
    cfg: MCPServerConfig
  ): Promise<{ ok: boolean; toolCount: number; error?: string }> {
    this.stopServer(name);
    const proc = new MCPServerProcess(name, cfg);
    this.servers.set(name, proc);
    const discovered = await proc.start();
    if (!proc.running) return { ok: false, toolCount: 0, error: proc.lastError || "server did not start" };
    for (const tool of discovered) {
      this.tools.set(this.makeGlobalName(name, tool.name), { serverName: name, tool });
    }
    return { ok: true, toolCount: discovered.length };
  }

  public stopServer(name: string): void {
    this.servers.get(name)?.stop();
    this.servers.delete(name);
    for (const [globalName, entry] of this.tools) {
      if (entry.serverName === name) this.tools.delete(globalName);
    }
  }

  private makeGlobalName(server: string, tool: string): string {
    // Provider function names: letters, digits, '_' and '-', max 64 characters.
    const base = `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    if (!this.tools.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base.slice(0, 60)}_${n}`;
      if (!this.tools.has(candidate)) return candidate;
    }
  }

  public status(): MCPServerStatus[] {
    const config = getMcpConfig();
    return Object.entries(config.mcpServers).map(([name, cfg]) => {
      const proc = this.servers.get(name);
      return {
        name,
        command: cfg.command,
        running: proc?.running ?? false,
        toolCount: [...this.tools.values()].filter((t) => t.serverName === name).length,
        error: proc?.lastError ?? "",
      };
    });
  }

  public getDiscoveredTools(): Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }> {
    return [...this.tools.entries()].map(([globalName, { tool }]) => ({
      type: "function" as const,
      function: {
        name: globalName,
        description: `[MCP: ${tool.serverName}] ${tool.description}`.slice(0, 1000),
        parameters: tool.inputSchema,
      },
    }));
  }

  /** Returns null when the tool is unknown; throws when the server reports an error or times out. */
  public async callMcpTool(globalName: string, args: Record<string, unknown>): Promise<string | null> {
    const target = this.tools.get(globalName);
    if (!target) return null;
    const proc = this.servers.get(target.serverName);
    if (!proc || !proc.running) throw new Error(`MCP server '${target.serverName}' is not running`);
    return proc.callTool(target.tool.name, args);
  }

  public stopAll(): void {
    for (const proc of this.servers.values()) proc.stop();
    this.servers.clear();
    this.tools.clear();
    this.initialized = false;
  }
}

let mcpManagerInstance: MCPManager | null = null;

export function getMCPManager(): MCPManager {
  mcpManagerInstance ??= new MCPManager();
  return mcpManagerInstance;
}
