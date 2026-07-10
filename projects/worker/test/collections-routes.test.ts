import { it, expect } from "vitest";
import { handleCreateCollection, handleListCollections, handlePatchCollection } from "../src/collections-routes";
import { handleListCollectionImages, handleDeleteCollectionImage, handleDeleteCollection, handleBrowseCollections } from "../src/collections-routes";
import { fakeServices } from "./fakes";
import { sha256Hex } from "../src/auth";

const env: any = { DEV_MODE: undefined };

// Name/theme checks are fail-closed, so every create/patch needs a moderation
// cfg. modOk always passes; tests override fetchFn to flag or fail.
const modFetch = (result: any = { flagged: false }): typeof fetch =>
  (async () => Response.json({ results: [result] })) as any;
const modOk = { moderationKey: "op-key", fetchFn: modFetch() };

// Session-authenticated request: fake sessions.resolve returns the user for any cookie.
function sessionReq(userId: string, method = "GET", body?: any): { req: Request; s: any } {
  const s: any = fakeServices();
  s.sessions.resolve = async () => ({ user_id: userId });
  const req = new Request("https://x/v1/collections", {
    method,
    headers: { Cookie: "wagmi_session=tok", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { req, s };
}

async function giveByok(s: any, userId: string, enabled = true) {
  await s.byok.put({ userId, provider: "openai", keyCiphertext: "ct", keyLast4: "1234", monthlyCap: 50, enabled });
}

it("create: 401 without auth", async () => {
  const s = fakeServices();
  const req = new Request("https://x/v1/collections", { method: "POST", body: JSON.stringify({ name: "n" }) });
  expect((await handleCreateCollection(req, env, s, modOk)).status).toBe(401);
});

it("create: 403 byok required when no enabled key", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "Retro" });
  const res = await handleCreateCollection(req, env, s, modOk);
  expect(res.status).toBe(403);
  expect(((await res.json()) as any).error).toBe("byok required");
});

it("create: 403 when byok key exists but is disabled", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "Retro" });
  await giveByok(s, "usr_1", false);
  expect((await handleCreateCollection(req, env, s, modOk)).status).toBe(403);
});

it("create: happy path returns the collection and persists it", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: " Retro posters ", theme_prompt: "retro poster style" });
  await giveByok(s, "usr_1");
  const res = await handleCreateCollection(req, env, s, modOk);
  expect(res.status).toBe(200);
  const { collection }: any = await res.json();
  expect(collection.id).toMatch(/^col_[a-z2-7]{20}$/);
  expect(collection.name).toBe("Retro posters");
  expect(collection.theme_prompt).toBe("retro poster style");
  expect((s as any)._collectionRows.get(collection.id).owner_user_id).toBe("usr_1");
});

it("create: 422 on bad name, 409 at the 20-collection cap", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "" });
  await giveByok(s, "usr_1");
  expect((await handleCreateCollection(req, env, s, modOk)).status).toBe(422);
  for (let i = 0; i < 20; i++) {
    await s.collections.create({ id: `col_${String(i).padStart(20, "x")}`, ownerUserId: "usr_1", name: `c${i}`, themePrompt: "" });
  }
  const { req: req2 } = sessionReq("usr_1", "POST", { name: "one more" });
  const res = await handleCreateCollection(req2, env, s, modOk);
  expect(res.status).toBe(409);
  expect(((await res.json()) as any).error).toBe("collection limit reached");
});

it("list: returns only own collections with aggregates", async () => {
  const { req, s } = sessionReq("usr_1");
  await s.collections.create({ id: "col_mine".padEnd(24, "a"), ownerUserId: "usr_1", name: "mine", themePrompt: "" });
  await s.collections.create({ id: "col_them".padEnd(24, "b"), ownerUserId: "usr_2", name: "theirs", themePrompt: "" });
  const res = await handleListCollections(req, env, s);
  const { collections }: any = await res.json();
  expect(collections.length).toBe(1);
  expect(collections[0].name).toBe("mine");
  expect(collections[0].image_count).toBe(0);
});

it("patch: owner can edit theme; non-owner gets 404; no fields 422", async () => {
  const { req, s } = sessionReq("usr_1", "PATCH", { theme_prompt: "new theme" });
  await s.collections.create({ id: "col_x".padEnd(24, "x"), ownerUserId: "usr_1", name: "n", themePrompt: "old" });
  const id = "col_x".padEnd(24, "x");
  const res = await handlePatchCollection(id, req, env, s, modOk);
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).collection.theme_prompt).toBe("new theme");

  const { req: req2, s: s2 } = sessionReq("usr_2", "PATCH", { theme_prompt: "hijack" });
  await s2.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "old" });
  expect((await handlePatchCollection(id, req2, env, s2, modOk)).status).toBe(404);

  const { req: req3, s: s3 } = sessionReq("usr_1", "PATCH", {});
  await s3.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "old" });
  expect((await handlePatchCollection(id, req3, env, s3, modOk)).status).toBe(422);
});

it("bearer key auth works for create (paid keys manage collections too)", async () => {
  const s: any = fakeServices();
  await giveByok(s, "usr_9");
  s.keys.getKeyOwner = async (h: string) => (h === await sha256Hex("sc-k") ? "usr_9" : null);
  const req = new Request("https://x/v1/collections", {
    method: "POST", headers: { Authorization: "Bearer sc-k", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "via key" }),
  });
  expect((await handleCreateCollection(req, env, s, modOk)).status).toBe(200);
});

function seedCollectionAsset(s: any, id: string, collectionId: string) {
  const row = {
    id, prompt: `p-${id}`, source: "byok", source_id: null, model_used: "gpt-image-1",
    width: 1024, height: 1024, mime: "image/png", source_url: `https://x/${id}.png`,
    locally_cached: 0, created_at: "2026-07-09", collection_id: collectionId,
  };
  (s as any)._assets.set(id, row);
  (s as any)._libraryRows.push(row);
}

it("images list: owner sees serve_count; non-owner 404", async () => {
  const { req, s } = sessionReq("usr_1");
  const id = "col_i".padEnd(24, "i");
  await s.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "" });
  seedCollectionAsset(s, "a1", id);
  await s.assets.bumpServeCount("a1");
  const res = await handleListCollectionImages(id, new URL("https://x/v1/collections/x/images"), req, env, s, {});
  expect(res.status).toBe(200);
  const { images }: any = await res.json();
  expect(images[0].id).toBe("a1");
  expect(images[0].serve_count).toBe(1);

  const { req: req2, s: s2 } = sessionReq("usr_2");
  await s2.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "" });
  expect((await handleListCollectionImages(id, new URL("https://x/v1/collections/x/images"), req2, env, s2, {})).status).toBe(404);
});

it("image delete: tombstones + deletes vectors; 404 for non-member", async () => {
  const { req, s } = sessionReq("usr_1", "DELETE");
  const id = "col_d".padEnd(24, "d");
  await s.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "" });
  seedCollectionAsset(s, "a1", id);
  const res = await handleDeleteCollectionImage(id, "a1", req, env, s);
  expect(res.status).toBe(200);
  expect((s as any)._tombstoned).toContain("a1");
  expect((s as any)._vectorDeletes).toContain("a1");
  // not a member anymore -> 404 on repeat
  expect((await handleDeleteCollectionImage(id, "a1", req, env, s)).status).toBe(404);
});

it("collection delete: tombstones all live members, deletes vectors, removes the row", async () => {
  const { req, s } = sessionReq("usr_1", "DELETE");
  const id = "col_z".padEnd(24, "z");
  await s.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "" });
  seedCollectionAsset(s, "a1", id);
  seedCollectionAsset(s, "a2", id);
  const res = await handleDeleteCollection(id, req, env, s);
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).images_deleted).toBe(2);
  expect((s as any)._tombstoned.sort()).toEqual(["a1", "a2"]);
  expect((s as any)._vectorDeletes.sort()).toEqual(["a1", "a2"]);
  expect((s as any)._collectionRows.has(id)).toBe(false);
});

it("collection delete: vector-delete failure still deletes the collection (best-effort)", async () => {
  const { req, s } = sessionReq("usr_1", "DELETE");
  const id = "col_f".padEnd(24, "f");
  await s.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "" });
  seedCollectionAsset(s, "a1", id);
  s.vectorize.deleteByIds = async () => { throw new Error("vectorize down"); };
  const res = await handleDeleteCollection(id, req, env, s);
  expect(res.status).toBe(200);
  expect((s as any)._collectionRows.has(id)).toBe(false);
});

function seedGenerated(s: any, userId: string, count: number, month = "2026-07") {
  (s as any)._byokUsage.set(`${userId}:${month}`, { count, est_spend_usd: 0 });
}

it("slot gate: second collection blocked below 10 lifetime generations", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "Second" });
  await giveByok(s, "usr_1");
  await s.collections.create({ id: "col_first".padEnd(24, "f"), ownerUserId: "usr_1", name: "First", themePrompt: "" });
  seedGenerated(s, "usr_1", 9);
  const res = await handleCreateCollection(req, env, s, modOk);
  expect(res.status).toBe(409);
  const body: any = await res.json();
  expect(body).toEqual({ error: "collection slot locked", required: 10, generated: 9 });
});

it("slot gate: second collection allowed at exactly 10; counts sum across months", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "Second" });
  await giveByok(s, "usr_1");
  await s.collections.create({ id: "col_first".padEnd(24, "f"), ownerUserId: "usr_1", name: "First", themePrompt: "" });
  seedGenerated(s, "usr_1", 5, "2026-06");
  seedGenerated(s, "usr_1", 5, "2026-07");
  expect((await handleCreateCollection(req, env, s, modOk)).status).toBe(200);
});

it("slot gate: third collection requires 100", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "Third" });
  await giveByok(s, "usr_1");
  await s.collections.create({ id: "col_a".padEnd(24, "a"), ownerUserId: "usr_1", name: "A", themePrompt: "" });
  await s.collections.create({ id: "col_b".padEnd(24, "b"), ownerUserId: "usr_1", name: "B", themePrompt: "" });
  seedGenerated(s, "usr_1", 99);
  const res = await handleCreateCollection(req, env, s, modOk);
  expect(res.status).toBe(409);
  expect(((await res.json()) as any).required).toBe(100);
});

it("slot gate: first collection needs no generations (existing happy path unchanged)", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "First ever" });
  await giveByok(s, "usr_1");
  expect((await handleCreateCollection(req, env, s, modOk)).status).toBe(200);
});

it("list: slots object reports used/generated/next_required", async () => {
  const { req, s } = sessionReq("usr_1");
  await s.collections.create({ id: "col_one".padEnd(24, "o"), ownerUserId: "usr_1", name: "One", themePrompt: "" });
  seedGenerated(s, "usr_1", 7);
  const res = await handleListCollections(req, env, s);
  const body: any = await res.json();
  expect(body.slots).toEqual({ used: 1, generated: 7, next_required: 10 });
});

it("list: zero collections -> next_required 0 (first is free)", async () => {
  const { req, s } = sessionReq("usr_1");
  const body: any = await (await handleListCollections(req, env, s)).json();
  expect(body.slots).toEqual({ used: 0, generated: 0, next_required: 0 });
});

// ---- name/theme content checks (public browse means names are public copy) ----

it("create: denylisted name -> 422 content_policy, nothing persisted", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "Best of Pikachu" });
  await giveByok(s, "usr_1");
  const res = await handleCreateCollection(req, env, s, modOk);
  expect(res.status).toBe(422);
  const body: any = await res.json();
  expect(body.error).toBe("content_policy");
  expect(body.category).toBe("denylist:pikachu");
  expect((s as any)._collectionRows.size).toBe(0);
});

it("create: moderation-flagged theme -> 422 with the flagged category", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "Fine name", theme_prompt: "something awful" });
  await giveByok(s, "usr_1");
  const res = await handleCreateCollection(req, env, s, { moderationKey: "op-key", fetchFn: modFetch({ flagged: true, categories: { sexual: true } }) });
  expect(res.status).toBe(422);
  expect(((await res.json()) as any).category).toBe("sexual");
});

it("create: moderation unreachable -> 503 (fail closed); no moderation key -> 503", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "Fine name" });
  await giveByok(s, "usr_1");
  const down = (async () => { throw new Error("network down"); }) as any;
  expect((await handleCreateCollection(req, env, s, { moderationKey: "op-key", fetchFn: down })).status).toBe(503);
  const { req: req2, s: s2 } = sessionReq("usr_1", "POST", { name: "Fine name" });
  await giveByok(s2, "usr_1");
  expect((await handleCreateCollection(req2, env, s2, {})).status).toBe(503);
});

it("patch: renaming to a denylisted name -> 422; clearing the theme skips moderation", async () => {
  const id = "col_m".padEnd(24, "m");
  const { req, s } = sessionReq("usr_1", "PATCH", { name: "disney classics" });
  await s.collections.create({ id, ownerUserId: "usr_1", name: "ok", themePrompt: "t" });
  expect((await handlePatchCollection(id, req, env, s, modOk)).status).toBe(422);

  // Blank theme has no content to moderate — must succeed even with moderation down.
  const { req: req2, s: s2 } = sessionReq("usr_1", "PATCH", { theme_prompt: "" });
  await s2.collections.create({ id, ownerUserId: "usr_1", name: "ok", themePrompt: "t" });
  expect((await handlePatchCollection(id, req2, env, s2, {})).status).toBe(200);
});

// ---- public browse ----

function browseReq(userId: string | null, query = ""): { url: URL; req: Request; s: any } {
  const s: any = fakeServices();
  if (userId) s.sessions.resolve = async () => ({ user_id: userId });
  const req = new Request("https://x/v1/collections/browse" + query, { headers: userId ? { Cookie: "wagmi_session=tok" } : {} });
  return { url: new URL(req.url), req, s };
}

it("browse: 401 without auth", async () => {
  const { url, req, s } = browseReq(null);
  expect((await handleBrowseCollections(url, req, env, s, {})).status).toBe(401);
});

it("browse: lists everyone's collections most-served first with stats + previews, no owner leak", async () => {
  const { url, req, s } = browseReq("usr_1");
  const quiet = "col_quiet".padEnd(24, "q"), busy = "col_busy".padEnd(24, "b");
  await s.collections.create({ id: quiet, ownerUserId: "usr_1", name: "Quiet", themePrompt: "" });
  await s.collections.create({ id: busy, ownerUserId: "usr_2", name: "Busy", themePrompt: "posters" });
  seedCollectionAsset(s, "a1", busy);
  seedCollectionAsset(s, "a2", busy);
  await s.assets.bumpServeCount("a1");
  await s.collections.bumpSearchCount(busy);
  const res = await handleBrowseCollections(url, req, env, s, {});
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.collections.map((c: any) => c.name)).toEqual(["Busy", "Quiet"]);
  const [first] = body.collections;
  expect(first).toMatchObject({ image_count: 2, total_serves: 1, search_count: 1 });
  expect(first.previews.length).toBe(2);
  expect(first.previews[0].url).toBe("https://x/a1.png");
  expect("owner_user_id" in first).toBe(false);
  expect(body.has_more).toBe(false);
});

it("browse: q filters by name; bad params rejected", async () => {
  const { url, req, s } = browseReq("usr_1", "?q=bus");
  await s.collections.create({ id: "col_busy".padEnd(24, "b"), ownerUserId: "usr_2", name: "Busy", themePrompt: "" });
  await s.collections.create({ id: "col_quiet".padEnd(24, "q"), ownerUserId: "usr_1", name: "Quiet", themePrompt: "" });
  const body: any = await (await handleBrowseCollections(url, req, env, s, {})).json();
  expect(body.collections.map((c: any) => c.name)).toEqual(["Busy"]);

  const { url: u2, req: r2, s: s2 } = browseReq("usr_1", "?limit=1.5");
  expect((await handleBrowseCollections(u2, r2, env, s2, {})).status).toBe(400);
  const { url: u3, req: r3, s: s3 } = browseReq("usr_1", "?offset=-1");
  expect((await handleBrowseCollections(u3, r3, env, s3, {})).status).toBe(400);
  const { url: u4, req: r4, s: s4 } = browseReq("usr_1", "?q=" + "x".repeat(81));
  expect((await handleBrowseCollections(u4, r4, env, s4, {})).status).toBe(400);
});

it("browse: has_more pagination", async () => {
  const { url, req, s } = browseReq("usr_1", "?limit=1");
  await s.collections.create({ id: "col_a".padEnd(24, "a"), ownerUserId: "usr_1", name: "A", themePrompt: "" });
  await s.collections.create({ id: "col_b".padEnd(24, "b"), ownerUserId: "usr_2", name: "B", themePrompt: "" });
  const body: any = await (await handleBrowseCollections(url, req, env, s, {})).json();
  expect(body.collections.length).toBe(1);
  expect(body.has_more).toBe(true);
});
