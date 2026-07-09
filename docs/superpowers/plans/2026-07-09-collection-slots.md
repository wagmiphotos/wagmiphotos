# Progressive Collection Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the creation of the n-th collection behind 10^(n-1) lifetime BYOK generations (1st free, 2nd needs 10, 3rd 100, ...), with the unlock progress surfaced on the account card.

**Architecture:** A pure threshold helper in `collections.ts`, a `byok.totalGenerated(userId)` SUM over the existing `byok_usage` table (no schema change), a slot-gate 409 in `handleCreateCollection` after the existing 20-cap check, a `slots: {used, generated, next_required}` sibling field on `GET /v1/collections`, and a progress hint replacing the account-card create form when locked.

**Tech Stack:** Cloudflare Workers (TypeScript), D1, vitest fake stores, single-file SPA.

**Spec:** `docs/superpowers/specs/2026-07-09-collection-slots-design.md` (approved 2026-07-09).

## Global Constraints

- Threshold rule, exact: `requiredGenerationsFor(nth) = 0` when `nth <= 1`, else `10 ** (nth - 1)`. Creation is allowed when `generated >= required` (blocked only when strictly below — "second allowed at exactly 10").
- Count basis: `SELECT COALESCE(SUM(count), 0) FROM byok_usage WHERE user_id = ?` — lifetime, monotonic, net of refunds. NO schema change, NO new columns.
- Gate order in `handleCreateCollection` is fixed: auth 401 → BYOK 403 → JSON 400 / validation 422 → 20-cap 409 (`collection limit reached`) → slot gate 409 (`{error: "collection slot locked", required, generated}`). The cap check must stay BEFORE the slot gate (the existing cap test seeds 20 collections without usage counters and must pass unchanged).
- `GET /v1/collections` response gains `slots: { used: <own collection count>, generated: <lifetime>, next_required: <requiredGenerationsFor(used+1)> }` alongside `collections`.
- SPA precedence in the account card: no-enabled-BYOK hint > slot-locked progress hint > create form. The playground's `loadPlaygroundCollections` destructures only `collections` and must keep working untouched.
- All existing tests pass unchanged (the Task-4-era cap test bypasses the route for seeding, so it is unaffected by the new gate).
- Working directory: `projects/worker`. Full suite `npx vitest run` + `npx tsc --noEmit` before every commit.

---

### Task 1: Threshold helper + byok.totalGenerated

**Files:**
- Modify: `projects/worker/src/collections.ts` (append helper)
- Modify: `projects/worker/src/types.ts` (ByokStore method)
- Modify: `projects/worker/src/d1.ts` (byok store method)
- Modify: `projects/worker/test/fakes.ts` (fake byok method)
- Test: `projects/worker/test/collections.test.ts`, `projects/worker/test/byok-d1.test.ts`

**Interfaces:**
- Consumes: existing `byok_usage` table (columns `user_id, month, count, est_spend_usd`), fake `byokUsage` Map keyed `` `${userId}:${month}` `` in fakes.ts.
- Produces: `requiredGenerationsFor(nth: number): number` (exported from `src/collections.ts`); `ByokStore.totalGenerated(userId: string): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

Append to `projects/worker/test/collections.test.ts` (add `requiredGenerationsFor` to the existing import from `../src/collections`):

```ts
it("requiredGenerationsFor: first free, then powers of ten", () => {
  expect(requiredGenerationsFor(0)).toBe(0);
  expect(requiredGenerationsFor(1)).toBe(0);
  expect(requiredGenerationsFor(2)).toBe(10);
  expect(requiredGenerationsFor(3)).toBe(100);
  expect(requiredGenerationsFor(4)).toBe(1000);
  expect(requiredGenerationsFor(5)).toBe(10000);
});
```

Append to `projects/worker/test/byok-d1.test.ts`:

```ts
it("totalGenerated sums byok_usage counts across months (COALESCE 0)", async () => {
  const { db, calls } = fakeDb({ n: 15 });
  const { byok } = makeD1Stores(db);
  expect(await byok.totalGenerated("u1")).toBe(15);
  expect(calls[0].sql).toContain("COALESCE(SUM(count), 0)");
  expect(calls[0].sql).toContain("FROM byok_usage WHERE user_id = ?");
  expect(calls[0].args).toEqual(["u1"]);
});

it("totalGenerated returns 0 when the user has no usage rows", async () => {
  const { db } = fakeDb(null);
  const { byok } = makeD1Stores(db);
  expect(await byok.totalGenerated("nobody")).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/collections.test.ts test/byok-d1.test.ts`
Expected: FAIL — `requiredGenerationsFor` not exported; `totalGenerated` not a function.

- [ ] **Step 3: Implement**

Append to `projects/worker/src/collections.ts`:

```ts
/** Lifetime generations required to create your nth collection (1-based):
 *  the first needs only an enabled BYOK key, the nth needs 10^(n-1)
 *  (2nd -> 10, 3rd -> 100, ...). Spec: 2026-07-09-collection-slots-design.md */
export function requiredGenerationsFor(nth: number): number {
  return nth <= 1 ? 0 : 10 ** (nth - 1);
}
```

In `projects/worker/src/types.ts`, add to the `ByokStore` interface (after `addSpend`):

```ts
  /** Lifetime successful generations (net of refunds) summed across all months. */
  totalGenerated(userId: string): Promise<number>;
```

In `projects/worker/src/d1.ts`, add to the `byok` store (after `addSpend`):

```ts
    async totalGenerated(userId) {
      const row = await db.prepare(
        "SELECT COALESCE(SUM(count), 0) AS n FROM byok_usage WHERE user_id = ?"
      ).bind(userId).first<{ n: number }>();
      return row?.n ?? 0;
    },
```

In `projects/worker/test/fakes.ts`, add to the fake `byok` store (after `addSpend`; `byokUsage` keys are `` `${userId}:${month}` ``):

```ts
      totalGenerated: async (u) => {
        let n = 0;
        for (const [k, v] of byokUsage) if (k.startsWith(`${u}:`)) n += v.count;
        return n;
      },
```

- [ ] **Step 4: Run the full suite**

Run: `cd projects/worker && npx vitest run && npx tsc --noEmit`
Expected: ALL PASS (310 + 3 new), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/collections.ts projects/worker/src/types.ts projects/worker/src/d1.ts projects/worker/test/fakes.ts projects/worker/test/collections.test.ts projects/worker/test/byok-d1.test.ts
git commit -m "feat(collections): requiredGenerationsFor thresholds + byok.totalGenerated"
```

---

### Task 2: Slot gate on create + slots object on list

**Files:**
- Modify: `projects/worker/src/collections-routes.ts`
- Test: `projects/worker/test/collections-routes.test.ts`

**Interfaces:**
- Consumes: Task 1's `requiredGenerationsFor`, `s.byok.totalGenerated`; existing `sessionReq`/`giveByok` helpers and `_byokUsage` fake internals in the test file.
- Produces: create 409 body `{ error: "collection slot locked", required: number, generated: number }`; list body `{ collections: [...], slots: { used, generated, next_required } }`.

- [ ] **Step 1: Write the failing tests**

Append to `projects/worker/test/collections-routes.test.ts` (helper first — `_byokUsage` is the fake's `Map` keyed `` `${userId}:${month}` ``):

```ts
function seedGenerated(s: any, userId: string, count: number, month = "2026-07") {
  (s as any)._byokUsage.set(`${userId}:${month}`, { count, est_spend_usd: 0 });
}

it("slot gate: second collection blocked below 10 lifetime generations", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "Second" });
  await giveByok(s, "usr_1");
  await s.collections.create({ id: "col_first".padEnd(24, "f"), ownerUserId: "usr_1", name: "First", themePrompt: "" });
  seedGenerated(s, "usr_1", 9);
  const res = await handleCreateCollection(req, env, s);
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
  expect((await handleCreateCollection(req, env, s)).status).toBe(200);
});

it("slot gate: third collection requires 100", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "Third" });
  await giveByok(s, "usr_1");
  await s.collections.create({ id: "col_a".padEnd(24, "a"), ownerUserId: "usr_1", name: "A", themePrompt: "" });
  await s.collections.create({ id: "col_b".padEnd(24, "b"), ownerUserId: "usr_1", name: "B", themePrompt: "" });
  seedGenerated(s, "usr_1", 99);
  const res = await handleCreateCollection(req, env, s);
  expect(res.status).toBe(409);
  expect(((await res.json()) as any).required).toBe(100);
});

it("slot gate: first collection needs no generations (existing happy path unchanged)", async () => {
  const { req, s } = sessionReq("usr_1", "POST", { name: "First ever" });
  await giveByok(s, "usr_1");
  expect((await handleCreateCollection(req, env, s)).status).toBe(200);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd projects/worker && npx vitest run test/collections-routes.test.ts`
Expected: the new slot-gate tests FAIL (create currently succeeds; list has no `slots`). The "first collection" test may already pass — fine.

- [ ] **Step 3: Implement**

In `projects/worker/src/collections-routes.ts`, add `requiredGenerationsFor` to the import from `./collections`. Replace the cap check in `handleCreateCollection`:

```ts
  if ((await s.collections.countByOwner(userId)) >= MAX_COLLECTIONS_PER_USER) {
    return Response.json({ error: "collection limit reached", limit: MAX_COLLECTIONS_PER_USER }, { status: 409 });
  }
```

with:

```ts
  const existing = await s.collections.countByOwner(userId);
  if (existing >= MAX_COLLECTIONS_PER_USER) {
    return Response.json({ error: "collection limit reached", limit: MAX_COLLECTIONS_PER_USER }, { status: 409 });
  }
  // Progressive slots (spec 2026-07-09-collection-slots-design.md): the nth
  // collection needs 10^(n-1) lifetime generations. byok_usage sums are
  // monotonic — deleting images/collections/keys never re-locks a slot.
  const required = requiredGenerationsFor(existing + 1);
  if (required > 0) {
    const generated = await s.byok.totalGenerated(userId);
    if (generated < required) {
      return Response.json({ error: "collection slot locked", required, generated }, { status: 409 });
    }
  }
```

Replace `handleListCollections`'s body after the auth check:

```ts
  const rows = await s.collections.listByOwner(userId);
  const generated = await s.byok.totalGenerated(userId);
  return Response.json({
    collections: rows.map(collectionView),
    slots: { used: rows.length, generated, next_required: requiredGenerationsFor(rows.length + 1) },
  });
```

- [ ] **Step 4: Run the full suite**

Run: `cd projects/worker && npx vitest run && npx tsc --noEmit`
Expected: ALL PASS — including the pre-existing "422 then 409 at cap" test (cap stays before the slot gate) and the pre-existing list tests (they assert on `collections`, not exact body equality; if one does deep-equal the whole body, extend it with the `slots` field rather than weakening it — note this in your report).

- [ ] **Step 5: Commit**

```bash
git add projects/worker/src/collections-routes.ts projects/worker/test/collections-routes.test.ts
git commit -m "feat(collections): progressive slot gate on create + slots object on list"
```

---

### Task 3: Account-card progress hint + docs sentence

**Files:**
- Modify: `projects/worker/public/index.html`

No unit tests (SPA); verify via router tests + script-parse + full suite.

- [ ] **Step 1: Store slots in loadCollections**

In `loadCollections()` (around line 4530), the file currently has:

```js
        myCollections = (await r.json()).collections;
        renderCollections();
```

Replace with:

```js
        const data = await r.json();
        myCollections = data.collections;
        mySlots = data.slots || null;
        renderCollections();
```

And directly under the existing `let myCollections = [];` declaration (around line 4527) add:

```js
    let mySlots = null;
```

- [ ] **Step 2: Branch the create form on slot state**

In `renderCollections()` the file currently computes (around line 4548):

```js
      const canCreate = !!(currentByok && currentByok.enabled);
      const createForm = canCreate ? `
```

Replace the `createForm` construction so the precedence is byok-hint > slot-hint > form. Keep the existing form template literal and byok-hint string byte-for-byte; only the surrounding conditional changes:

```js
      const canCreate = !!(currentByok && currentByok.enabled);
      const slotLocked = !!(mySlots && mySlots.generated < mySlots.next_required);
      const createForm = !canCreate
        ? `<div style="font-size:0.8125rem;margin-top:10px;">Add an enabled provider key above to create collections.</div>`
        : slotLocked
        ? `<div style="font-size:0.8125rem;margin-top:10px;">Generate ${mySlots.next_required - mySlots.generated} more image${mySlots.next_required - mySlots.generated === 1 ? '' : 's'} to unlock collection #${mySlots.used + 1} (${mySlots.generated}/${mySlots.next_required} lifetime images).</div>`
        : `
        <div class="form-group" style="margin-top:14px;">
          ... (existing create-form template literal, unchanged) ...
        </div>`;
```

(The `...` line above means: keep the file's existing form template exactly as it is — move it into the final ternary branch. All interpolated values in the slot hint are server integers; no escaping needed.)

- [ ] **Step 3: Docs sentence**

In the docs request-body table's `collection` row (`<td>` description, around line 3265), append one sentence before the closing `</td>`:

```html
 Additional collections unlock with lifetime generated images (10 for the 2nd, 100 for the 3rd, 1000 for the 4th, …).
```

- [ ] **Step 4: Verify**

Run: `cd projects/worker && npx vitest run test/router.test.ts` → 32/32.
Run the script-parse check: `node -e "const m=require('fs').readFileSync('public/index.html','utf8').match(/<script>([\s\S]*)<\/script>/); new Function(m[1]); console.log('script parses')"` → `script parses`.
Run: `npx vitest run && npx tsc --noEmit` → ALL PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add projects/worker/public/index.html
git commit -m "feat(collections): slot-unlock progress hint on account card + docs sentence"
```
