import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runShell } from "./shell.ts";
import { getMemoryStore } from "./memory.ts";
import { getConfig, maskSecret, updateConfig, validateConfigValue } from "./config.ts";
import { getSkillManager } from "./skills.ts";
import { addMcpServer, getMCPManager, getMcpConfig, removeMcpServer, validateServerSpec } from "./mcp.ts";
import { assessPath, assessShell, expandHome } from "./policy.ts";
import { addTask, describeTask, formatWhen, loadTasks, parseSchedule, removeTask } from "./scheduler.ts";
import { TERMUX_TOOLS, buildTermuxCommand, runTermuxApi, termuxApiAvailable } from "./termux.ts";
import { compactLine, errMsg, firstLine, truncate } from "./utils.ts";

// ------------------------------------------------------------------ types

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolResult {
  ok: boolean;
  output: string;
  /** Short human-readable outcome used for progress narration (e.g. "exit 0 · first line of output"). */
  note?: string;
}

export interface ApprovalRequest {
  tool: string;
  summary: string;
  reason: string | null;
}

export interface ToolContext {
  /** Asks the human to approve a risky action. When absent, risky actions are blocked. */
  confirm?: (request: ApprovalRequest) => Promise<boolean>;
  signal?: AbortSignal;
  /** Telegram chat the conversation belongs to (used as the delivery target for scheduled tasks). */
  chatId?: number;
  /** True while a scheduled task is running: it may not create further scheduled tasks. */
  scheduled?: boolean;
}

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

const MAX_TOOL_OUTPUT = 12_000;
const MAX_READ_BYTES = 2_000_000;
const MAX_WRITE_CHARS = 2_000_000;

// ------------------------------------------------------- tool definitions

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = []
): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, ...(required.length > 0 ? { required } : {}) },
    },
  };
}

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

export const BASE_TOOLS: ToolDefinition[] = [
  tool(
    "shell",
    "Run a shell command on this Android/Linux device. Returns exit_code, stdout, stderr, timed_out. The timeout is capped by the user's configured shell timeout. Risky commands (deleting files, rebooting, reading credentials, ...) require the user's approval and are blocked when it is denied.",
    {
      command: str("The shell command to run."),
      timeout_ms: num("Optional timeout in milliseconds (capped by the configured ceiling)."),
    },
    ["command"]
  ),
  tool(
    "read_file",
    "Read a text file. Returns up to `length` characters starting at `offset`; if more remains, the output tells you the next offset.",
    {
      path: str("File path."),
      offset: num("Character offset to start from (default 0)."),
      length: num("Characters to return (default 8000, max 20000)."),
    },
    ["path"]
  ),
  tool(
    "write_file",
    "Create or overwrite a file (parent folders are created). Writes outside your home/shared storage, or to credential or startup files, require the user's approval.",
    { path: str("File path."), content: str("Full file content.") },
    ["path", "content"]
  ),
  tool(
    "patch_file",
    "Replace text in a file. Fails if the target text is not found, or if it occurs more than once and replace_all is not set.",
    {
      path: str("File path."),
      target_text: str("Exact text to find (including whitespace)."),
      replacement_text: str("Text to put in its place."),
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
    },
    ["path", "target_text", "replacement_text"]
  ),
  tool(
    "remember",
    "Save a durable fact or user preference to the persistent memory store. Never store passwords, PINs, tokens or keys.",
    { fact: str("The fact to store."), category: str("Optional category.") },
    ["fact"]
  ),
  tool("search_memory", "Search stored facts and preferences (empty query lists the most recent).", {
    query: str("Text to search for."),
  }),
  tool("forget", "Delete a stored memory by its numeric id (see search_memory).", { id: num("Memory id.") }, ["id"]),
  tool("get_config", "Retrieve the active runtime configuration (model, provider URL, max turns, shell timeout, approval mode)."),
  tool(
    "set_config",
    "Change the active model or the maximum number of agent turns. Other settings (API key, provider URL, approval mode, shell timeout) can only be changed by the user.",
    { model: str("Model name."), maxTurns: num("Maximum agent turns (1-50).") }
  ),
  tool("list_skills", "List installed multi-file skills and their descriptions."),
  tool(
    "load_skill",
    "Read SKILL.md or another file from an installed skill folder.",
    { name: str("Skill name."), subFile: str("File inside the skill folder (default SKILL.md).") },
    ["name"]
  ),
  tool(
    "create_skill",
    "Create or update a skill: a folder with SKILL.md and optional extra files.",
    {
      name: str("Skill name."),
      description: str("One-line description."),
      mainContent: str("Markdown body of SKILL.md."),
      extraFiles: { type: "object", description: "Map of relative file name to file content." },
    },
    ["name", "description", "mainContent"]
  ),
  tool("delete_skill", "Delete an installed skill (requires the user's approval).", { name: str("Skill name.") }, ["name"]),
  tool(
    "add_mcp_server",
    "Install and start a Model Context Protocol (MCP) server. It will be launched automatically on every start, so the user must approve it.",
    {
      name: str("Short server name."),
      command: str("Executable to run."),
      args: { type: "array", items: { type: "string" }, description: "Command arguments." },
      env: { type: "object", description: "Extra environment variables for the server." },
    },
    ["name", "command"]
  ),
  tool("remove_mcp_server", "Stop and remove an installed MCP server.", { name: str("Server name.") }, ["name"]),
  tool("list_mcp_servers", "List configured MCP servers with their running status."),
  tool(
    "schedule_task",
    'Schedule a reminder or an autonomous agent task. `when` is one of: "in 20m", "every 2h", "daily 08:00", "weekdays 07:30", "mon,fri 18:00", "at 2026-11-06 14:30" (device local time). Results are delivered to the Telegram chat and only run while the bot daemon is running. Agent tasks need the user\'s approval to create, and risky actions inside them still need approval.',
    {
      when: str("When to run (see description)."),
      text: str("Reminder text, or the prompt the agent should carry out."),
      kind: { type: "string", enum: ["reminder", "agent"], description: "reminder (default) just sends a message; agent runs the prompt autonomously." },
    },
    ["when", "text"]
  ),
  tool("list_schedules", "List scheduled reminders and agent tasks with their next run time."),
  tool("cancel_schedule", "Cancel a scheduled task by its id (see list_schedules).", { id: str("Task id.") }, ["id"]),
];

export function getActiveTools(): ToolDefinition[] {
  return [...BASE_TOOLS, ...(termuxApiAvailable() ? TERMUX_TOOLS : []), ...getMCPManager().getDiscoveredTools()];
}

export const TOOLS: ToolDefinition[] = BASE_TOOLS;

// ----------------------------------------------------------------- helpers

const ok = (output: string, note?: string): ToolResult => ({ ok: true, output, ...(note ? { note } : {}) });
const fail = (output: string, note?: string): ToolResult => ({ ok: false, output, ...(note ? { note } : {}) });

function reqStr(args: Record<string, unknown>, key: string, max = 100_000): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`"${key}" is required and must be a non-empty string`);
  if (v.length > max) throw new Error(`"${key}" is too long (max ${max} characters)`);
  return v;
}

function optStr(args: Record<string, unknown>, key: string, max = 100_000): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
  if (v.length > max) throw new Error(`"${key}" is too long (max ${max} characters)`);
  return v;
}

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`"${key}" must be a number`);
  return v;
}

function resolvePath(p: string): string {
  return resolve(expandHome(p));
}

type Gate = { allowed: true } | { allowed: false; message: string };

/** Applies the user's confirmMode to one action. `reason` is why the action is considered risky (or null). */
async function gate(ctx: ToolContext, toolName: string, summary: string, reason: string | null): Promise<Gate> {
  const mode = getConfig().confirmMode;
  const needsApproval = mode === "always" || (mode === "dangerous" && reason !== null);
  if (!needsApproval) return { allowed: true };

  if (!ctx.confirm) {
    return {
      allowed: false,
      message: `Blocked: ${reason ?? "user confirmation is required"}. No approval channel is available in this session, so the action was not run. Tell the user what you wanted to do and why.`,
    };
  }
  let approved = false;
  try {
    approved = await ctx.confirm({ tool: toolName, summary, reason });
  } catch {
    approved = false;
  }
  return approved
    ? { allowed: true }
    : {
        allowed: false,
        message:
          "The user denied this action. Do not retry it or look for a workaround; explain what you were trying to do and ask how to proceed.",
      };
}

function describeShellOutcome(res: { exit_code: number | null; stdout: string; stderr: string; timed_out: boolean; aborted: boolean }): string {
  const status = res.aborted ? "cancelled" : res.timed_out ? "timed out" : `exit ${res.exit_code ?? "?"}`;
  const line = firstLine(res.stdout || res.stderr, 100);
  return line ? `${status} · ${line}` : status;
}

// ---------------------------------------------------------------- handlers

const handlerTable: Record<string, Handler> = {
  async shell(args, ctx) {
    const command = reqStr(args, "command", 20_000);
    if (!command.trim()) return fail("Error: command must not be empty");
    const cfg = getConfig();

    const g = await gate(ctx, "shell", command, assessShell(command));
    if (!g.allowed) return fail(g.message, "blocked");

    const requested = optNum(args, "timeout_ms") ?? cfg.shellTimeout;
    const timeout = Math.min(Math.max(requested, 1_000), cfg.shellTimeout);
    const res = await runShell(command, timeout, ctx.signal);
    const output = JSON.stringify({ ...res, effective_timeout_ms: timeout }, null, 2);
    const success = res.exit_code === 0 && !res.timed_out && !res.aborted;
    return { ok: success, output, note: describeShellOutcome(res) };
  },

  async read_file(args, ctx) {
    const path = resolvePath(reqStr(args, "path", 4096));
    const g = await gate(ctx, "read_file", `Read ${path}`, assessPath(path, "read"));
    if (!g.allowed) return fail(g.message, "blocked");

    if (!existsSync(path)) return fail(`Error: File not found at ${path}`, "not found");
    const st = statSync(path);
    if (!st.isFile()) return fail(`Error: Not a regular file: ${path}`, "not a file");
    if (st.size > MAX_READ_BYTES) {
      return fail(
        `Error: File is ${st.size} bytes (limit ${MAX_READ_BYTES}). Use the shell with head/tail/sed/grep to inspect part of it.`,
        "too large"
      );
    }
    const content = readFileSync(path, "utf8");
    const offset = Math.max(0, Math.floor(optNum(args, "offset") ?? 0));
    const length = Math.min(Math.max(1, Math.floor(optNum(args, "length") ?? 8_000)), 20_000);
    const slice = content.slice(offset, offset + length);
    const end = offset + slice.length;
    const more = end < content.length ? `\n…[more content remains: call read_file again with offset=${end}]` : "";
    return ok(`[${path} — characters ${offset}-${end} of ${content.length}]\n${slice}${more}`, `${slice.length} chars`);
  },

  async write_file(args, ctx) {
    const path = resolvePath(reqStr(args, "path", 4096));
    const content = args.content;
    if (typeof content !== "string") return fail('Error: "content" is required and must be a string');
    if (content.length > MAX_WRITE_CHARS) return fail(`Error: content is too large (max ${MAX_WRITE_CHARS} characters)`);

    const g = await gate(ctx, "write_file", `Write ${content.length} characters to ${path}`, assessPath(path, "write"));
    if (!g.allowed) return fail(g.message, "blocked");

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    return ok(`Successfully wrote ${content.length} characters to ${path}`, `${content.length} chars written`);
  },

  async patch_file(args, ctx) {
    const path = resolvePath(reqStr(args, "path", 4096));
    const target = reqStr(args, "target_text", MAX_WRITE_CHARS);
    const replacement = optStr(args, "replacement_text", MAX_WRITE_CHARS);
    if (replacement === undefined) return fail('Error: "replacement_text" is required (use an empty string to delete)');
    const replaceAll = args.replace_all === true;

    const g = await gate(ctx, "patch_file", `Patch ${path}`, assessPath(path, "write"));
    if (!g.allowed) return fail(g.message, "blocked");

    if (!existsSync(path)) return fail(`Error: File not found at ${path}`, "not found");
    const content = readFileSync(path, "utf8");
    const first = content.indexOf(target);
    if (first === -1) {
      return fail(`Error: Target text not found in ${path}. Ensure whitespace and characters match exactly.`, "no match");
    }
    const occurrences = content.split(target).length - 1;
    if (occurrences > 1 && !replaceAll) {
      return fail(
        `Error: Target text occurs ${occurrences} times in ${path}. Include more surrounding context to make it unique, or set replace_all=true.`,
        `${occurrences} matches`
      );
    }
    // Slice/split instead of String.replace so "$&"-style sequences in the replacement stay literal.
    const next = replaceAll
      ? content.split(target).join(replacement)
      : content.slice(0, first) + replacement + content.slice(first + target.length);
    writeFileSync(path, next, "utf8");
    return ok(
      `Successfully patched ${path} (${replaceAll ? occurrences : 1} replacement${replaceAll && occurrences > 1 ? "s" : ""})`,
      "patched"
    );
  },

  async remember(args) {
    const store = await getMemoryStore();
    return ok(store.remember(reqStr(args, "fact", 2_000), optStr(args, "category", 50) ?? "general"), "saved");
  },

  async search_memory(args) {
    const store = await getMemoryStore();
    const rows = store.search(optStr(args, "query", 200) ?? "");
    return ok(JSON.stringify(rows, null, 2), `${rows.length} result${rows.length === 1 ? "" : "s"}`);
  },

  async forget(args) {
    const id = optNum(args, "id");
    if (id === undefined || !Number.isInteger(id)) return fail('Error: "id" must be an integer memory id');
    const removed = (await getMemoryStore()).forget(id);
    return removed > 0 ? ok(`Forgot memory #${id}`, "forgotten") : fail(`No memory with id ${id}`, "not found");
  },

  async get_config() {
    const cfg = getConfig();
    return ok(
      JSON.stringify(
        {
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          apiKey: maskSecret(cfg.apiKey),
          maxTurns: cfg.maxTurns,
          shellTimeout: cfg.shellTimeout,
          confirmMode: cfg.confirmMode,
        },
        null,
        2
      )
    );
  },

  async set_config(args) {
    const updates: Record<string, string | number> = {};
    for (const key of ["model", "maxTurns"] as const) {
      if (args[key] === undefined) continue;
      const v = validateConfigValue(key, args[key]);
      if (!v.ok) return fail(`Error: ${v.error}`);
      updates[key] = v.value;
    }
    if (Object.keys(updates).length === 0) {
      return fail("Error: nothing to change. The agent may only set model and maxTurns; other settings belong to the user.");
    }
    const updated = updateConfig(updates);
    return ok(`Configuration updated: model=${updated.model}, maxTurns=${updated.maxTurns}`, "updated");
  },

  async list_skills() {
    const skills = getSkillManager().listSkills();
    return ok(JSON.stringify(skills, null, 2), `${skills.length} skill${skills.length === 1 ? "" : "s"}`);
  },

  async load_skill(args) {
    const text = getSkillManager().loadSkill(reqStr(args, "name", 64), optStr(args, "subFile", 300) ?? "SKILL.md");
    return text.startsWith("Error:") ? fail(text) : ok(text);
  },

  async create_skill(args) {
    const extraRaw = args.extraFiles;
    const extraFiles: Record<string, string> = {};
    if (extraRaw !== undefined && extraRaw !== null) {
      if (typeof extraRaw !== "object" || Array.isArray(extraRaw)) {
        return fail('Error: "extraFiles" must be an object mapping file names to text');
      }
      for (const [file, content] of Object.entries(extraRaw)) {
        if (typeof content !== "string") return fail(`Error: extraFiles["${file}"] must be a string`);
        extraFiles[file] = content;
      }
    }
    const message = getSkillManager().createSkill(
      reqStr(args, "name", 100),
      reqStr(args, "description", 1_000),
      reqStr(args, "mainContent", 200_000),
      extraFiles
    );
    return ok(message, "skill saved");
  },

  async delete_skill(args, ctx) {
    const name = reqStr(args, "name", 64);
    const g = await gate(ctx, "delete_skill", `Permanently delete skill "${name}"`, "permanently deletes a skill folder");
    if (!g.allowed) return fail(g.message, "blocked");
    const message = getSkillManager().deleteSkill(name);
    return message.startsWith("Error:") ? fail(message) : ok(message, "deleted");
  },

  async add_mcp_server(args, ctx) {
    const name = reqStr(args, "name", 32);
    const command = reqStr(args, "command", 500);
    const serverArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const env: Record<string, string> = {};
    if (args.env && typeof args.env === "object" && !Array.isArray(args.env)) {
      for (const [k, v] of Object.entries(args.env)) env[k] = String(v);
    }
    validateServerSpec(name, command, serverArgs, env);

    const g = await gate(
      ctx,
      "add_mcp_server",
      `Install MCP server "${name}": ${[command, ...serverArgs].join(" ")}`,
      "installs a program that will be launched automatically on every start"
    );
    if (!g.allowed) return fail(g.message, "blocked");

    const saved = addMcpServer(name, command, serverArgs, env);
    const started = await getMCPManager().startServer(name, { command, args: serverArgs, env });
    return started.ok
      ? ok(`${saved}\nStarted; ${started.toolCount} tool(s) are now available.`, `${started.toolCount} tools`)
      : fail(`${saved}\nSaved, but it failed to start: ${started.error}`, "failed to start");
  },

  async remove_mcp_server(args) {
    const name = reqStr(args, "name", 32);
    getMCPManager().stopServer(name);
    const message = removeMcpServer(name);
    return message.includes("not found") ? fail(message) : ok(message, "removed");
  },

  async list_mcp_servers() {
    const cfg = getMcpConfig();
    const status = getMCPManager().status();
    const servers = Object.entries(cfg.mcpServers).map(([name, c]) => {
      const st = status.find((s) => s.name === name);
      return {
        name,
        command: c.command,
        args: c.args ?? [],
        envKeys: Object.keys(c.env ?? {}), // names only: values may be secrets
        running: st?.running ?? false,
        tools: st?.toolCount ?? 0,
        ...(st?.error ? { error: st.error } : {}),
      };
    });
    return ok(JSON.stringify(servers, null, 2), `${servers.length} server${servers.length === 1 ? "" : "s"}`);
  },
};

const scheduleHandlers: Record<string, Handler> = {
  async schedule_task(args, ctx) {
    if (ctx.scheduled) return fail("Scheduled tasks cannot create further scheduled tasks.", "not allowed");
    const when = reqStr(args, "when", 100);
    const text = reqStr(args, "text", 2_000);
    const rawKind = args.kind ?? "reminder";
    if (rawKind !== "reminder" && rawKind !== "agent") return fail('Error: "kind" must be "reminder" or "agent"');
    parseSchedule(when); // fail on a bad schedule before bothering the user with an approval prompt

    if (rawKind === "agent") {
      const g = await gate(
        ctx,
        "schedule_task",
        `Schedule an autonomous agent task (${when}): ${text}`,
        "creates a task that will run on its own, unattended"
      );
      if (!g.allowed) return fail(g.message, "blocked");
    }
    const task = addTask({ kind: rawKind, text, spec: when, chatId: ctx.chatId });
    return ok(
      `Scheduled ${task.kind} ${task.id}: ${task.spec}. Next run ${formatWhen(task.nextRun)} (device local time). It only runs while the bot daemon (pocketclaw start) is running.`,
      `${task.id} · next ${formatWhen(task.nextRun)}`
    );
  },

  async list_schedules() {
    const tasks = loadTasks();
    return ok(tasks.length ? tasks.map(describeTask).join("\n") : "No scheduled tasks.", `${tasks.length} task${tasks.length === 1 ? "" : "s"}`);
  },

  async cancel_schedule(args) {
    const id = reqStr(args, "id", 20);
    return removeTask(id) ? ok(`Cancelled scheduled task ${id}.`, "cancelled") : fail(`No scheduled task with id ${id}.`, "not found");
  },
};

function makeDeviceHandler(name: string): Handler {
  return async (args, ctx) => {
    const cmd = buildTermuxCommand(name, args);
    const g = await gate(ctx, name, cmd.summary, cmd.reason);
    if (!g.allowed) return fail(g.message, "blocked");
    const res = await runTermuxApi(cmd, ctx.signal);
    if (!res.ok) return fail(res.output, compactLine(res.output, 100) || "failed");
    const body = res.output === "Done." ? "" : res.output;
    const output = [body, cmd.successNote].filter(Boolean).join("\n") || "Done.";
    return ok(output, compactLine(output, 100) || "done");
  };
}

const HANDLERS = new Map<string, Handler>([
  ...Object.entries(handlerTable),
  ...Object.entries(scheduleHandlers),
  ...TERMUX_TOOLS.map((t): [string, Handler] => [t.function.name, makeDeviceHandler(t.function.name)]),
]);

async function callMcp(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const g = await gate(ctx, name, `Call MCP tool ${name} with ${truncate(JSON.stringify(args), 400)}`, null);
  if (!g.allowed) return fail(g.message, "blocked");
  const out = await getMCPManager().callMcpTool(name, args);
  if (out === null) return fail(`Unknown tool: ${name}`);
  return ok(out);
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext = {}
): Promise<ToolResult> {
  try {
    const handler = HANDLERS.get(name);
    let result: ToolResult;
    if (handler) result = await handler(args, ctx);
    else if (name.startsWith("mcp_")) result = await callMcp(name, args, ctx);
    else result = fail(`Unknown tool: ${name}`);
    return { ...result, output: truncate(result.output, MAX_TOOL_OUTPUT) };
  } catch (error) {
    return fail(`Error executing tool '${name}': ${errMsg(error)}`, "error");
  }
}

// -------------------------------------------------------------- narration

/** One-line, human-readable description of what a tool call is about to do. */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  const s = (key: string): string => (typeof args[key] === "string" ? (args[key] as string) : "");
  const clip = (text: string, max = 120): string => {
    const one = text.replace(/\s+/g, " ").trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
  };

  switch (name) {
    case "shell":
      return `🛠️ Running shell command: ${clip(s("command"))}`;
    case "read_file":
      return `📖 Reading file: ${clip(s("path"))}`;
    case "write_file":
      return `📝 Writing file: ${clip(s("path"))}`;
    case "patch_file":
      return `✂️ Patching file: ${clip(s("path"))}`;
    case "remember":
      return `🧠 Saving to memory: "${clip(s("fact"), 80)}"`;
    case "search_memory":
      return s("query") ? `🔍 Searching memory for "${clip(s("query"), 60)}"` : "🔍 Listing recent memories";
    case "forget":
      return `🗑️ Forgetting memory #${String(args.id ?? "?")}`;
    case "get_config":
      return "⚙️ Reading configuration";
    case "set_config":
      return "⚙️ Updating configuration";
    case "list_skills":
      return "📚 Listing skills";
    case "load_skill":
      return `📚 Loading skill: ${clip(s("name"))}`;
    case "create_skill":
      return `📚 Creating skill: ${clip(s("name"))}`;
    case "delete_skill":
      return `🗑️ Deleting skill: ${clip(s("name"))}`;
    case "add_mcp_server":
      return `🔌 Installing MCP server: ${clip(s("name"))}`;
    case "remove_mcp_server":
      return `🔌 Removing MCP server: ${clip(s("name"))}`;
    case "list_mcp_servers":
      return "🔌 Listing MCP servers";
    case "schedule_task":
      return `📅 Scheduling ${s("kind") === "agent" ? "an agent task" : "a reminder"} (${clip(s("when"), 40)}): ${clip(s("text"), 80)}`;
    case "list_schedules":
      return "📅 Listing scheduled tasks";
    case "cancel_schedule":
      return `📅 Cancelling scheduled task ${clip(s("id"), 20)}`;
    case "device_battery":
      return "🔋 Reading battery status";
    case "device_wifi":
      return "📶 Reading Wi-Fi info";
    case "device_notify":
      return `🔔 Showing notification: ${clip(s("title"), 60)}`;
    case "device_clipboard_get":
      return "📋 Reading the clipboard";
    case "device_clipboard_set":
      return "📋 Setting the clipboard";
    case "device_torch":
      return `🔦 Turning the torch ${args.on === true ? "on" : "off"}`;
    case "device_speak":
      return `🔊 Speaking: ${clip(s("text"), 80)}`;
    case "device_vibrate":
      return "📳 Vibrating";
    case "device_location":
      return "📍 Getting location";
    case "device_camera_photo":
      return "📷 Taking a photo";
    case "device_sms_send":
      return `💬 Sending SMS to ${clip(s("number"), 20)}`;
    default:
      return name.startsWith("mcp_") ? `🔌 Calling MCP tool: ${name.slice(4)}` : `⚙️ Running ${name}`;
  }
}
