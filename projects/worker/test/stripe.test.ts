import { it, expect } from "vitest";
import { isPaid, planView } from "../src/entitlement";

it("isPaid true for active and trialing only", () => {
  expect(isPaid({ plan_status: "active" })).toBe(true);
  expect(isPaid({ plan_status: "trialing" })).toBe(true);
  expect(isPaid({ plan_status: "past_due" })).toBe(false);
  expect(isPaid({ plan_status: "canceled" })).toBe(false);
  expect(isPaid({ plan_status: null })).toBe(false);
  expect(isPaid(null)).toBe(false);
  expect(isPaid(undefined)).toBe(false);
});

it("planView projects the public plan shape", () => {
  const u: any = { plan_status: "active", plan_current_period_end: "2027-07-08T00:00:00.000Z" };
  expect(planView(u)).toEqual({ active: true, status: "active", current_period_end: "2027-07-08T00:00:00.000Z" });
  expect(planView({ plan_status: null, plan_current_period_end: null } as any)).toEqual({ active: false, status: null, current_period_end: null });
});
