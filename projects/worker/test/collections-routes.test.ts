import { it, expect } from "vitest";
import { handleCreateCollection, handleListCollections, handlePatchCollection } from "../src/collections-routes";
import { handleListCollectionImages, handleDeleteCollectionImage, handleDeleteCollection } from "../src/collections-routes";
import { fakeServices } from "./fakes";
import { sha256Hex } from "../src/auth";

const env: any = { DEV_MODE: undefined };

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
  expect((await handleCreateCollection(req, env, s)).status).toBe(401);
});

it("create: 403 byok required when no enabled key", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "Retro" });
  const res = await handleCreateCollection(req, env, s);
  expect(res.status).toBe(403);
  expect(((await res.json()) as any).error).toBe("byok required");
});

it("create: 403 when byok key exists but is disabled", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "Retro" });
  await giveByok(s, "usr_1", false);
  expect((await handleCreateCollection(req, env, s)).status).toBe(403);
});

it("create: happy path returns the collection and persists it", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: " Retro posters ", theme_prompt: "retro poster style" });
  await giveByok(s, "usr_1");
  const res = await handleCreateCollection(req, env, s);
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
  expect((await handleCreateCollection(req, env, s)).status).toBe(422);
  for (let i = 0; i < 20; i++) {
    await s.collections.create({ id: `col_${String(i).padStart(20, "x")}`, ownerUserId: "usr_1", name: `c${i}`, themePrompt: "" });
  }
  const { req: req2 } = sessionReq("usr_1", "POST", { name: "one more" });
  const res = await handleCreateCollection(req2, env, s);
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
  const res = await handlePatchCollection(id, req, env, s);
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).collection.theme_prompt).toBe("new theme");

  const { req: req2, s: s2 } = sessionReq("usr_2", "PATCH", { theme_prompt: "hijack" });
  await s2.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "old" });
  expect((await handlePatchCollection(id, req2, env, s2)).status).toBe(404);

  const { req: req3, s: s3 } = sessionReq("usr_1", "PATCH", {});
  await s3.collections.create({ id, ownerUserId: "usr_1", name: "n", themePrompt: "old" });
  expect((await handlePatchCollection(id, req3, env, s3)).status).toBe(422);
});

it("bearer key auth works for create (paid keys manage collections too)", async () => {
  const s: any = fakeServices();
  await giveByok(s, "usr_9");
  s.keys.getKeyOwner = async (h: string) => (h === await sha256Hex("sc-k") ? "usr_9" : null);
  const req = new Request("https://x/v1/collections", {
    method: "POST", headers: { Authorization: "Bearer sc-k", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "via key" }),
  });
  expect((await handleCreateCollection(req, env, s)).status).toBe(200);
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
