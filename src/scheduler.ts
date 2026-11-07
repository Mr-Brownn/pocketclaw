import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllowedChatIds } from "./config.ts";
import { dataDir, errMsg, writePrivateFile } from "./utils.ts";

export type Schedule =
  | { type: "once" }
  | { type: "every"; everyMs: number }
  | { type: "daily"; time: string; days: number[] };

export interface ScheduledTask {
  id: string;
  kind: "reminder" | "agent";
  /** Reminder text, or the prompt an agent run starts from. */
  text: string;
  /** Telegram chat that receives the output. */
  chatId: number;
  schedule: Schedule;
  /** The schedule as the user wrote it (for display). */
  spec: string;
  nextRun: number;
  createdAt: number;
  lastRun?: number;
  lastStatus?: string;
  runs: number;
}

const MIN_ONCE_MS = 5_000;
const MIN_EVERY_MS = 60_000;
const MAX_HORIZON_MS = 366 * 86_400_000;
const MAX_TASKS = 50;
const MAX_TEXT = 2_000;
const TICK_MS = 15_000;
/** A one-off task that is overdue by more than this (bot was offline) is reported as missed, not run. */
const MISSED_GRACE_MS = 5 * 60_000;

const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const SPEC_HELP =
  'Use "in 20m", "every 2h", "daily 08:00", "weekdays 07:30", "mon,fri 18:00" or "at 2026-11-06 14:30" (device local time).';

// ----------------------------------------------------------------- parsing

export function parseDuration(text: string): number | null {
  const m = /^(\d+)\s*([a-z]+)$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const table: Array<[string[], number]> = [
    [["s", "sec", "secs", "second", "seconds"], 1_000],
    [["m", "min", "mins", "minute", "minutes"], 60_000],
    [["h", "hr", "hrs", "hour", "hours"], 3_600_000],
    [["d", "day", "days"], 86_400_000],
  ];
  for (const [names, ms] of table) if (names.includes(unit)) return n * ms;
  return null;
}

/** Next local occurrence of HH:MM on one of `days` (0=Sunday) strictly after `from`. */
export function nextDailyRun(time: string, days: number[], from: number): number {
  const [h, mi] = time.split(":").map(Number) as [number, number];
  for (let offset = 0; offset <= 8; offset++) {
    const d = new Date(from);
    d.setDate(d.getDate() + offset);
    d.setHours(h, mi, 0, 0);
    if (d.getTime() > from && days.includes(d.getDay())) return d.getTime();
  }
  throw new Error("Could not work out the next run time");
}

function parseLocalDateTime(text: string): number {
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text);
  if (local) {
    const [, y, mo, d, h, mi] = local.map(Number) as [number, number, number, number, number, number];
    const date = new Date(y, mo - 1, d, h, mi, 0, 0);
    if (date.getMonth() !== mo - 1 || date.getDate() !== d) throw new Error(`"${text}" is not a valid date`);
    return date.getTime();
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new Error(`Could not understand the date "${text}". ${SPEC_HELP}`);
  return parsed;
}

export function parseSchedule(specRaw: string, now = Date.now()): { schedule: Schedule; nextRun: number } {
  const spec = specRaw.trim().replace(/\s+/g, " ");

  let m = /^in (.+)$/i.exec(spec);
  if (m) {
    const ms = parseDuration(m[1] ?? "");
    if (ms === null) throw new Error(`Could not understand the delay "${m[1]}". ${SPEC_HELP}`);
    if (ms < MIN_ONCE_MS) throw new Error("The delay must be at least 5 seconds");
    if (ms > MAX_HORIZON_MS) throw new Error("The delay must be less than a year");
    return { schedule: { type: "once" }, nextRun: now + ms };
  }

  m = /^every (.+)$/i.exec(spec);
  if (m) {
    const ms = parseDuration(m[1] ?? "");
    if (ms === null) throw new Error(`Could not understand the interval "${m[1]}". ${SPEC_HELP}`);
    if (ms < MIN_EVERY_MS) throw new Error("Repeating tasks must be at least 1 minute apart");
    if (ms > 30 * 86_400_000) throw new Error("The interval must be 30 days or less");
    return { schedule: { type: "every", everyMs: ms }, nextRun: now + ms };
  }

  m = /^(daily|weekdays|weekends|(?:mon|tue|wed|thu|fri|sat|sun)(?:,(?:mon|tue|wed|thu|fri|sat|sun))*) (\d{1,2}):(\d{2})$/i.exec(spec);
  if (m) {
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    if (hour > 23 || minute > 59) throw new Error(`"${m[2]}:${m[3]}" is not a valid time`);
    const which = (m[1] ?? "").toLowerCase();
    const days =
      which === "daily"
        ? [0, 1, 2, 3, 4, 5, 6]
        : which === "weekdays"
          ? [1, 2, 3, 4, 5]
          : which === "weekends"
            ? [0, 6]
            : which.split(",").map((d) => DAY_INDEX[d] as number);
    const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    return { schedule: { type: "daily", time, days }, nextRun: nextDailyRun(time, days, now) };
  }

  m = /^at (.+)$/i.exec(spec);
  if (m) {
    const at = parseLocalDateTime(m[1] ?? "");
    if (at < now + MIN_ONCE_MS) throw new Error("That time is in the past");
    if (at > now + MAX_HORIZON_MS) throw new Error("That time is more than a year away");
    return { schedule: { type: "once" }, nextRun: at };
  }

  throw new Error(`Unrecognised schedule "${specRaw}". ${SPEC_HELP}`);
}

/** Next run after a task fired at `now`, or null when the task is finished (one-offs). */
export function advanceTask(task: ScheduledTask, now: number): number | null {
  const s = task.schedule;
  if (s.type === "once") return null;
  if (s.type === "every") {
    if (now < task.nextRun) return task.nextRun;
    return task.nextRun + (Math.floor((now - task.nextRun) / s.everyMs) + 1) * s.everyMs;
  }
  return nextDailyRun(s.time, s.days, now);
}

export function formatWhen(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ----------------------------------------------------------------- storage

function tasksFile(): string {
  return join(dataDir(), "schedules.json");
}

function isTask(value: unknown): value is ScheduledTask {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<ScheduledTask>;
  return (
    typeof t.id === "string" &&
    (t.kind === "reminder" || t.kind === "agent") &&
    typeof t.text === "string" &&
    typeof t.chatId === "number" &&
    typeof t.nextRun === "number" &&
    typeof t.schedule === "object" &&
    t.schedule !== null &&
    typeof (t.schedule as { type?: unknown }).type === "string"
  );
}

export function loadTasks(): ScheduledTask[] {
  const file = tasksFile();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { tasks?: unknown[] };
    return (parsed.tasks ?? []).filter(isTask);
  } catch (error) {
    console.warn(`[scheduler] could not read ${file}: ${errMsg(error)}`);
    return [];
  }
}

function saveTasks(tasks: ScheduledTask[]): void {
  writePrivateFile(tasksFile(), JSON.stringify({ tasks }, null, 2));
}

/** The chat that receives output when a task is created without one (CLI): the first allowed Telegram chat. */
export function defaultChatId(): number | undefined {
  try {
    return parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_ID).find((id) => id > 0);
  } catch {
    return undefined;
  }
}

export function addTask(opts: { kind: "reminder" | "agent"; text: string; spec: string; chatId?: number }): ScheduledTask {
  const text = opts.text.trim();
  if (!text) throw new Error("The task text must not be empty");
  if (text.length > MAX_TEXT) throw new Error(`The task text is too long (max ${MAX_TEXT} characters)`);
  const chatId = opts.chatId ?? defaultChatId();
  if (chatId === undefined) {
    throw new Error("No Telegram chat to deliver to. Set TELEGRAM_ALLOWED_CHAT_ID, or create the task from Telegram.");
  }
  const tasks = loadTasks();
  if (tasks.length >= MAX_TASKS) throw new Error(`At most ${MAX_TASKS} scheduled tasks are allowed`);

  const now = Date.now();
  const { schedule, nextRun } = parseSchedule(opts.spec, now);
  const task: ScheduledTask = {
    id: randomBytes(3).toString("hex"),
    kind: opts.kind,
    text,
    chatId,
    schedule,
    spec: opts.spec.trim().replace(/\s+/g, " "),
    nextRun,
    createdAt: now,
    runs: 0,
  };
  saveTasks([...tasks, task]);
  return task;
}

export function removeTask(id: string): boolean {
  const tasks = loadTasks();
  const remaining = tasks.filter((t) => t.id !== id);
  if (remaining.length === tasks.length) return false;
  saveTasks(remaining);
  return true;
}

export function recordTaskResult(id: string, status: string): void {
  const tasks = loadTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return; // one-offs are already removed
  task.lastStatus = status.slice(0, 200);
  saveTasks(tasks);
}

export function describeTask(t: ScheduledTask): string {
  const icon = t.kind === "agent" ? "🤖" : "⏰";
  return `${icon} ${t.id} · ${t.spec} · next ${formatWhen(t.nextRun)} · ${t.text.replace(/\s+/g, " ").slice(0, 70)}`;
}

// ------------------------------------------------------------------ runner

export interface SchedulerHooks {
  /** Called for every task that is due. Must return quickly (enqueue long work). `late` = overdue one-off. */
  onDue(task: ScheduledTask, late: boolean): Promise<void> | void;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private hooks: SchedulerHooks;

  constructor(hooks: SchedulerHooks) {
    this.hooks = hooks;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-reads the task file every time so tasks added from the CLI or by the agent are picked up. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const tasks = loadTasks();
      if (!tasks.some((t) => t.nextRun <= now)) return;

      const keep: ScheduledTask[] = [];
      const due: Array<{ task: ScheduledTask; late: boolean }> = [];
      for (const task of tasks) {
        if (task.nextRun > now) {
          keep.push(task);
          continue;
        }
        const late = now - task.nextRun > MISSED_GRACE_MS;
        const next = advanceTask(task, now);
        if (next !== null) keep.push({ ...task, nextRun: next, lastRun: now, runs: task.runs + 1 });
        // Repeating tasks that were missed while offline just move on instead of firing a stale run.
        if (late && task.schedule.type !== "once") continue;
        due.push({ task, late });
      }
      // Persist the new schedule BEFORE running anything, so a crash cannot cause an endless re-run loop.
      saveTasks(keep);

      for (const { task, late } of due) {
        try {
          await this.hooks.onDue(task, late);
        } catch (error) {
          console.error(`[scheduler] task ${task.id} failed: ${errMsg(error)}`);
        }
      }
    } catch (error) {
      console.error(`[scheduler] tick failed: ${errMsg(error)}`);
    } finally {
      this.ticking = false;
    }
  }
}
