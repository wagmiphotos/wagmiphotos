import { it, expect, vi } from "vitest";
import { makeVectorize } from "../src/vectorize";

it("query maps binding response to {id, score}[] and drops extra fields", async () => {
  const binding: any = {
    query: vi.fn(async () => ({
      matches: [
        { id: "a", score: 0.9, meta: "ignored" },
        { id: "b", score: 0.1 },
      ],
    })),
  };

  const store = makeVectorize(binding);
  const result = await store.query([0.1], 2);

  expect(result).toEqual([
    { id: "a", score: 0.9 },
    { id: "b", score: 0.1 },
  ]);
  expect(binding.query).toHaveBeenCalledWith([0.1], { topK: 2 });
});

it("query returns empty array when binding response has no matches", async () => {
  const binding: any = {
    query: async () => ({}),
  };

  const store = makeVectorize(binding);
  const result = await store.query([0.1], 1);

  expect(result).toEqual([]);
});
