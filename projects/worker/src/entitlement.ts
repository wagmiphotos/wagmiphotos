import type { User } from "./types";

// The single entitlement rule. Trust Stripe to flip plan_status away from
// active/trialing at the right time (past_due, canceled, or sub deleted).
export function isPaid(user: Pick<User, "plan_status"> | null | undefined): boolean {
  return !!user && (user.plan_status === "active" || user.plan_status === "trialing");
}

// Public projection of the plan for /v1/me (never leaks the customer/sub ids).
export function planView(user: User): { active: boolean; status: string | null; current_period_end: string | null; cancel_at_period_end: boolean } {
  return {
    active: isPaid(user), status: user.plan_status ?? null,
    current_period_end: user.plan_current_period_end ?? null,
    cancel_at_period_end: !!user.plan_cancel_at_period_end,
  };
}
