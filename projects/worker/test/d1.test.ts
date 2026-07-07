import { it, expect } from "vitest";
import { makeD1Stores } from "../src/d1";

function fakeDb(firstResult: any = null, allResults: any[] = []) {
  const calls: { sql: string; args: any[] }[] = [];
  const db: any = {
    prepare(sql: string) {
      const stmt = {
        _args: [] as any[],
        bind(...args: any[]) { this._args = args; return this; },
        async first() { calls.push({ sql, args: this._args }); return firstResult; },
        async run() { calls.push({ sql, args: this._args }); return { success: true }; },
        async all() { calls.push({ sql, args: this._args }); return { results: allResults }; },
      };
      return stmt;
    },
  };
  return { db, calls };
}

it("getAsset selects by id and maps row", async () => {
  const row = { id: "a1", prompt: "p", source: "pd12m", source_id: "7",
    model_used: "clip-vit-l-14", width: 10, height: 20,
    mime: "image/jpeg", source_url: "https://ext/x.jpg", locally_cached: 0 };
  const { db, calls } = fakeDb(row);
  const { assets } = makeD1Stores(db);
  const got = await assets.getAsset("a1");
  expect(got?.id).toBe("a1");
  expect(calls[0].sql).toContain("FROM live_assets");
  expect(calls[0].args).toEqual(["a1"]);
});

it("getAsset returns null when missing", async () => {
  const { db } = fakeDb(null);
  const { assets } = makeD1Stores(db);
  expect(await assets.getAsset("nope")).toBeNull();
});

it("recordQuery upserts with count increment and forward-only built", async () => {
  const { db, calls } = fakeDb();
  const { queries } = makeD1Stores(db);
  await queries.recordQuery({ normalized: "a fox", original: "A Fox", assetId: "a1", similarity: 0.3, built: true, generate: true });
  expect(calls[0].sql).toContain("INSERT INTO queries");
  expect(calls[0].sql).toContain("ON CONFLICT");
  expect(calls[0].sql).toContain("count = queries.count + 1");
  // status param is 'built' when built=true, else 'pending'
  expect(calls[0].args).toContain("built");
  expect(calls[0].args).toContain("a fox");
  // assert the state-preserving clause: built rows never revert to pending, and
  // rows the backfill has claimed (status='building') keep their claim
  expect(calls[0].sql).toContain("status = CASE WHEN queries.status IN ('built','building') THEN queries.status ELSE excluded.status END");
});

it("recordQuery merges generate forward-only: generation wins over opt-out", async () => {
  // DB row already wants generation; a generate_on_miss=false request must not downgrade it
  const { db, calls } = fakeDb({ generate: 1 });
  const { queries } = makeD1Stores(db);
  const effective = await queries.recordQuery({
    normalized: "a fox", original: "A Fox", assetId: null, similarity: 0, built: false, generate: false,
  });
  expect(calls[0].sql).toContain("generate = MAX(queries.generate, excluded.generate)");
  expect(calls[0].sql).toContain("RETURNING generate");
  expect(calls[0].args).toContain(0); // request's opt-out bound as 0
  expect(effective).toBe(true); // merged state: still queued for generation
});

it("recordQuery returns effective generate=false when row stays opted out", async () => {
  const { db } = fakeDb({ generate: 0 });
  const { queries } = makeD1Stores(db);
  const effective = await queries.recordQuery({
    normalized: "a fox", original: "A Fox", assetId: null, similarity: 0, built: false, generate: false,
  });
  expect(effective).toBe(false);
});

it("keys.getKeyOwner/addKey/listByUser use api_keys with user_id", async () => {
  const { db, calls } = fakeDb({ user_id: "usr_1" }, [{ label: "cli", created_at: "2026-07-06" }]);
  const { keys } = makeD1Stores(db);
  expect(await keys.getKeyOwner("hX")).toBe("usr_1");
  expect(calls[0].sql).toContain("SELECT user_id FROM api_keys");
  await keys.addKey("hY", "usr_1", "cli");
  expect(calls[1].sql).toContain("INSERT OR IGNORE INTO api_keys");
  expect(calls[1].args).toEqual(["hY", "usr_1", "cli"]);
  const list = await keys.listByUser("usr_1");
  expect(list).toEqual([{ label: "cli", created_at: "2026-07-06" }]);
  expect(calls[2].sql).toContain("SELECT key_hash AS id");
  expect(calls[2].sql).toContain("WHERE user_id = ?");
});

it("keys.deleteKey deletes scoped to the owner (key_hash AND user_id)", async () => {
  const { db, calls } = fakeDb();
  const { keys } = makeD1Stores(db);
  await keys.deleteKey("usr_1", "hZ");
  expect(calls[0].sql).toContain("DELETE FROM api_keys");
  expect(calls[0].sql).toContain("WHERE key_hash = ? AND user_id = ?");
  expect(calls[0].args).toEqual(["hZ", "usr_1"]);   // id bound first, then userId
});

it("searchAssets browse mode: no WHERE, ordered newest-first, binds limit/offset", async () => {
  const row = { id: "a1", prompt: "p", source: "pd12m", source_id: null,
    model_used: null, width: null, height: null,
    mime: null, source_url: null, locally_cached: 0, created_at: "2026-07-03 00:00:00" };
  const { db, calls } = fakeDb(null, [row]);
  const { assets } = makeD1Stores(db);
  const got = await assets.searchAssets({ q: "", limit: 25, offset: 0 });
  expect(got).toEqual([row]);
  expect(calls[0].sql).not.toContain("WHERE");
  expect(calls[0].sql).toContain("ORDER BY created_at DESC, id DESC");
  expect(calls[0].sql).toContain("created_at");
  expect(calls[0].args).toEqual([25, 0]);
  expect(calls[0].sql).toContain("FROM live_assets");
});

it("searchAssets query mode: LIKE over prompt with bound pattern", async () => {
  const { db, calls } = fakeDb(null, []);
  const { assets } = makeD1Stores(db);
  await assets.searchAssets({ q: "fox", limit: 10, offset: 20 });
  expect(calls[0].sql).toContain("WHERE prompt LIKE ? ESCAPE '\\'");
  expect(calls[0].args).toEqual(["%fox%", 10, 20]);
  expect(calls[0].sql).toContain("FROM live_assets");
});

it("searchAssets escapes LIKE wildcards in user input", async () => {
  const { db, calls } = fakeDb(null, []);
  const { assets } = makeD1Stores(db);
  await assets.searchAssets({ q: "100%_\\", limit: 5, offset: 0 });
  expect(calls[0].args[0]).toBe("%100\\%\\_\\\\%");
});

it("searchAssets tolerates missing results array", async () => {
  const { db } = fakeDb(null, undefined as any);
  const { assets } = makeD1Stores(db);
  expect(await assets.searchAssets({ q: "", limit: 5, offset: 0 })).toEqual([]);
});

it("searchAssets multi-word query: ANDs one LIKE clause per token", async () => {
  const { db, calls } = fakeDb(null, []);
  const { assets } = makeD1Stores(db);
  await assets.searchAssets({ q: "flamingo sunset", limit: 24, offset: 0 });
  const likeClauseCount = calls[0].sql.split("prompt LIKE ? ESCAPE '\\'").length - 1;
  expect(likeClauseCount).toBe(2);
  expect(calls[0].sql).toContain("prompt LIKE ? ESCAPE '\\' AND prompt LIKE ? ESCAPE '\\'");
  expect(calls[0].args).toEqual(["%flamingo%", "%sunset%", 24, 0]);
});

it("getAssetsByIds returns [] without querying when ids is empty", async () => {
  const { db, calls } = fakeDb(null, []);
  const { assets } = makeD1Stores(db);
  expect(await assets.getAssetsByIds([])).toEqual([]);
  expect(calls).toHaveLength(0);
});

it("getAssetsByIds selects rows by id IN (...), binding every id", async () => {
  const rows = [
    { id: "demo-2", prompt: "p2", source: "pd12m", source_id: null, model_used: null, width: null, height: null, mime: null, source_url: null, locally_cached: 0, created_at: "2026-07-03 00:00:00" },
    { id: "demo-1", prompt: "p1", source: "pd12m", source_id: null, model_used: null, width: null, height: null, mime: null, source_url: null, locally_cached: 0, created_at: "2026-07-02 00:00:00" },
  ];
  const { db, calls } = fakeDb(null, rows);
  const { assets } = makeD1Stores(db);
  const got = await assets.getAssetsByIds(["demo-2", "demo-1"]);
  expect(got).toEqual(rows);
  expect(calls[0].sql).toContain("WHERE id IN (?,?)");
  expect(calls[0].args).toEqual(["demo-2", "demo-1"]);
  expect(calls[0].sql).toContain("FROM live_assets");
});

it("searchAssets whitespace-only query: browse mode (no WHERE)", async () => {
  const { db, calls } = fakeDb(null, []);
  const { assets } = makeD1Stores(db);
  await assets.searchAssets({ q: "   ", limit: 24, offset: 0 });
  expect(calls[0].sql).not.toContain("WHERE");
  expect(calls[0].args).toEqual([24, 0]);
});

it("users.upsertByEmail inserts with ON CONFLICT and returns id/email", async () => {
  const { db, calls } = fakeDb({ id: "usr_1", email: "a@b.co" });
  const { users } = makeD1Stores(db);
  const u = await users.upsertByEmail("usr_1", "a@b.co");
  expect(u).toEqual({ id: "usr_1", email: "a@b.co" });
  expect(calls[0].sql).toContain("INSERT INTO users");
  expect(calls[0].sql).toContain("ON CONFLICT(email)");
  expect(calls[0].sql).toContain("RETURNING id, email");
  expect(calls[0].args).toEqual(["usr_1", "a@b.co"]);
});

it("sessions.create/resolve/touch/delete hit sessions with TTL and expiry guard", async () => {
  const { db, calls } = fakeDb({ user_id: "usr_1" });
  const { sessions } = makeD1Stores(db);
  await sessions.create("usr_1", "h1");
  expect(calls[0].sql).toContain("INSERT INTO sessions");
  expect(calls[0].sql).toContain("+30 days");
  expect(calls[0].args).toEqual(["usr_1", "h1"]);
  const r = await sessions.resolve("h1");
  expect(r).toEqual({ user_id: "usr_1" });
  expect(calls[1].sql).toContain("expires_at > datetime('now')");
  await sessions.touch("h1");
  expect(calls[2].sql).toContain("UPDATE sessions SET expires_at");
  // conditional sliding renewal: writes at most ~once/day per session
  expect(calls[2].sql).toContain("AND expires_at < datetime('now','+29 days')");
  await sessions.delete("h1");
  expect(calls[3].sql).toContain("DELETE FROM sessions");
});

it("sessions.purgeExpired and loginTokens.purgeExpired delete rows past expiry", async () => {
  const { db, calls } = fakeDb();
  const { sessions, loginTokens } = makeD1Stores(db);
  await sessions.purgeExpired();
  expect(calls[0].sql).toContain("DELETE FROM sessions WHERE expires_at <= datetime('now')");
  await loginTokens.purgeExpired();
  expect(calls[1].sql).toContain("DELETE FROM login_tokens WHERE expires_at <= datetime('now')");
});

it("loginTokens.create sets 15-min TTL + nonce_hash; consume is nonce-guarded, single-use + expiry-guarded", async () => {
  const { db, calls } = fakeDb({ email: "a@b.co" });
  const { loginTokens } = makeD1Stores(db);
  await loginTokens.create("h1", "a@b.co", "n1");
  expect(calls[0].sql).toContain("INSERT INTO login_tokens");
  expect(calls[0].sql).toContain("nonce_hash");
  expect(calls[0].sql).toContain("+15 minutes");
  expect(calls[0].args).toEqual(["h1", "a@b.co", "n1"]);
  const c = await loginTokens.consume("h1", "n1");
  expect(c).toEqual({ email: "a@b.co" });
  expect(calls[1].sql).toContain("UPDATE login_tokens SET used_at");
  expect(calls[1].sql).toContain("nonce_hash = ?"); // atomic guard: wrong/absent nonce never consumes
  expect(calls[1].sql).toContain("used_at IS NULL");
  expect(calls[1].sql).toContain("expires_at > datetime('now')");
  expect(calls[1].sql).toContain("RETURNING email");
  expect(calls[1].args).toEqual(["h1", "n1"]);
});
