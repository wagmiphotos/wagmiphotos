import { describe, it, expect } from "vitest";
import worker from "../src/index";

describe("healthz", () => {
  it("returns ok", async () => {
    const res = await worker.fetch(new Request("https://x/healthz"), {} as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
