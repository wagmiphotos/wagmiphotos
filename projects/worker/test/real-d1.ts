import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createRequire } from "node:module";

// A real SQLite database with EVERY migration applied in order, adapted to
// the tiny D1Database surface makeD1Stores uses (prepare/bind/first/run/all
// + batch). Exists because fake-D1 tests validate nothing about the real
// schema — that's how the 0007 url-column bug shipped (HANDOFF-2026-07-10).
export function realDb(): any {
  // Node 22.5+ built-in. Emits an ExperimentalWarning on import — harmless.
  // Using createRequire to load node:sqlite at runtime, bypassing Vite's
  // static module resolution that occurs during import parsing.
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite");

  // D1 enforces foreign keys; mirror that.
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const dir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith(".sql")) db.exec(readFileSync(join(dir, f), "utf8"));
  }
  const stmt = (sql: string) => ({
    _args: [] as any[],
    bind(...args: any[]) { this._args = args; return this; },
    async first() { const r = db.prepare(sql).get(...this._args); return r === undefined ? null : r; },
    async run() { db.prepare(sql).run(...this._args); return { success: true }; },
    async all() { return { results: db.prepare(sql).all(...this._args) }; },
  });
  return {
    prepare: stmt,
    async batch(stmts: any[]) { const out: any[] = []; for (const s of stmts) out.push(await s.run()); return out; },
    _raw: db,
  };
}
