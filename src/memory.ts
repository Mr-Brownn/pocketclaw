import { chmodSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dataDir, ensurePrivateDir } from "./utils.ts";

export interface MemoryEntry {
  id: number;
  fact: string;
  category: string;
  created_at: string;
}

const MAX_FACTS = 2_000;
const MAX_FACT_LENGTH = 2_000;

/** Rejects things that look like credentials: memory is plaintext on disk and is echoed to the LLM provider. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(password|passcode|passphrase|pwd|pin|api[\s_-]?key|secret|token|private[\s_-]?key|otp)\b[^.\n]{0,20}?(\bis\b|=|:)\s*\S+/i,
  /\b(nvapi-|sk-|ghp_|xox[bap]-)[A-Za-z0-9_-]{16,}/,
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

export class MemoryStore {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fact TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  remember(fact: string, category = "general"): string {
    const clean = fact.trim().slice(0, MAX_FACT_LENGTH);
    if (!clean) throw new Error("fact must not be empty");
    if (looksLikeSecret(clean)) {
      throw new Error(
        "Refusing to store what looks like a credential (password, PIN, token or key). Memory is stored in plaintext; ask the user to provide it again when needed."
      );
    }
    const cat = category.trim().slice(0, 50) || "general";

    const existing = this.db.prepare("SELECT id FROM memories WHERE fact = ?").get(clean) as
      | { id: number }
      | undefined;
    if (existing) return `Already remembered (memory #${existing.id}).`;

    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
    if (count >= MAX_FACTS) {
      this.db
        .prepare("DELETE FROM memories WHERE id IN (SELECT id FROM memories ORDER BY id ASC LIMIT ?)")
        .run(count - MAX_FACTS + 1);
    }

    const result = this.db.prepare("INSERT INTO memories (fact, category) VALUES (?, ?)").run(clean, cat);
    return `Fact stored in memory vault as #${Number(result.lastInsertRowid)} [category: ${cat}]: "${clean}"`;
  }

  search(query = ""): MemoryEntry[] {
    const q = query.trim();
    if (!q) {
      return this.db.prepare("SELECT * FROM memories ORDER BY id DESC LIMIT 20").all() as unknown as MemoryEntry[];
    }
    // Escape LIKE wildcards so "%" and "_" in the query are matched literally.
    const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    return this.db
      .prepare("SELECT * FROM memories WHERE fact LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 20")
      .all(pattern, pattern) as unknown as MemoryEntry[];
  }

  forget(id: number): number {
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}

let instance: Promise<MemoryStore> | null = null;

/** node:sqlite is loaded lazily so commands that never touch memory (help, exec, ...) start fast and warning-free. */
export function getMemoryStore(): Promise<MemoryStore> {
  if (!instance) {
    instance = (async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const dir = ensurePrivateDir(dataDir());
      const dbPath = join(dir, "memory.db");
      const db = new DatabaseSync(dbPath);
      try {
        chmodSync(dbPath, 0o600);
      } catch {
        // best effort
      }
      return new MemoryStore(db);
    })().catch((error) => {
      instance = null;
      throw error;
    });
  }
  return instance;
}

export async function closeMemoryStore(): Promise<void> {
  if (!instance) return;
  const pending = instance;
  instance = null;
  try {
    (await pending).close();
  } catch {
    // already closed or never opened
  }
}
