# Progressive collection slots — design

**Date:** 2026-07-09
**Status:** approved (brainstorm w/ Joris)
**Builds on:** 2026-07-09-collections-design.md (shipped at efc95f3)

## Summary

Collection creation becomes progressively gated by **lifetime BYOK
generations**: the first collection needs only an enabled BYOK key (as today);
the n-th collection additionally requires 10^(n-1) lifetime generated images
(2nd → 10, 3rd → 100, 4th → 1000, ...). The existing 20-per-user cap stays as
a formal backstop.

### Decisions (from brainstorm)

- **Count basis: lifetime generations** — `SUM(count)` over `byok_usage` for
  the user. Monotonic (slots never re-lock after image/collection deletion),
  survives key deletion (usage rows already outlive keys by design), counts
  net successful generations (refunds already decrement `count`). Rejected:
  live-asset counts (re-locking weirdness), materialized counter on `users`
  (hot-path write + migration + drift for a check that runs only on the rare
  create call).
- **No schema change.** The gate is computed at create time from existing
  tables.

## Gate rule

```
requiredGenerationsFor(nth) = 0            when nth == 1
                              10^(nth-1)   when nth >= 2
```

`nth` = the collection being created = `countByOwner(userId) + 1`. Deleting a
collection frees the slot (count drops), and since the generation count is
lifetime, re-creating is never harder than the first time around.

## Components

### collections.ts

New pure helper:

```ts
/** Lifetime generations required to create your nth collection (1-based). */
export function requiredGenerationsFor(nth: number): number {
  return nth <= 1 ? 0 : 10 ** (nth - 1);
}
```

### ByokStore (types.ts + d1.ts + fakes)

New method `totalGenerated(userId: string): Promise<number>` —
`SELECT COALESCE(SUM(count), 0) FROM byok_usage WHERE user_id = ?`.

### handleCreateCollection (collections-routes.ts)

Order (unchanged parts in parentheses): (auth 401) → (BYOK-enabled 403) →
(invalid JSON 400 / validation 422) → (20-cap 409 "collection limit reached")
→ **new slot gate**:

```
existing = countByOwner(userId)
required = requiredGenerationsFor(existing + 1)
generated = byok.totalGenerated(userId)
if (generated < required) -> 409 {
  error: "collection slot locked",
  required,            // lifetime generations needed for this slot
  generated,           // user's current lifetime count
}
```

The first collection has `required = 0` and is never blocked by this gate.

### GET /v1/collections — slots object

Response gains a sibling field so the SPA needs no second call:

```
{ collections: [...],
  slots: { used: <count>, generated: <lifetime>, next_required: <requiredGenerationsFor(used+1)> } }
```

`next_required` reports the raw threshold even past the 20-cap backstop; the
cap error remains its own 409 and the UI never renders slots past it.

### Account card (SPA)

In `renderCollections()`: when `slots.generated >= slots.next_required`, show
the create form as today. Otherwise replace it with a progress hint:
"Generate `next_required - generated` more images to unlock collection
#`used+1` (`generated`/`next_required`)." The BYOK-required hint (no enabled
key) still takes precedence over the slot hint. `loadCollections()` stores
`slots` alongside `myCollections`.

## Error handling

- `byok.totalGenerated` D1 failure: let it throw — create is a rare, non-hot
  route; the top-level handler already 500s with a generic body. No fail-open.
- Missing `slots` in an old cached SPA response: the card guards with
  optional chaining and falls back to showing the create form (server still
  enforces).

## Testing

- `requiredGenerationsFor`: 1→0, 2→10, 3→100, 4→1000, 5→10000.
- d1: `totalGenerated` SQL shape (SUM + COALESCE, bound user id); fake sums
  the `_byokUsage` map across months.
- Routes: first collection creates with 0 generations; second blocked at 9
  (409 body carries `required: 10, generated: 9`); second allowed at exactly
  10; third blocked below 100; list response carries correct `slots` for 0 and
  N collections; 20-cap 409 unchanged and checked before the slot gate.
- Existing collection tests pass unchanged except any that create multiple
  collections on one user must seed usage counters accordingly (the Task 4
  cap test seeds 20 collections directly in the store — it bypasses the
  route, so only route-level multi-create tests need seeding).
- SPA: script-parse + router checks (no unit tests, as before); locked/unlocked
  hint verified in the manual pass.

## Out of scope

- No paid-plan interaction (Unlimited does not change thresholds).
- No admin override / per-user exceptions.
- No backfill of `slots` semantics into the public docs beyond one sentence on
  the docs page's collection row.
