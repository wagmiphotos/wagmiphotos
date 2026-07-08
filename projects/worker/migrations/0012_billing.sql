-- Stripe subscription state, one row per user. plan_status mirrors the Stripe
-- subscription status; NULL means the user never subscribed (free tier).
-- isPaid() = plan_status IN ('active','trialing'). users is read directly (no
-- live_users view), so no view recreation is needed here.
ALTER TABLE users ADD COLUMN stripe_customer_id      TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id  TEXT;
ALTER TABLE users ADD COLUMN plan_status             TEXT;   -- 'active'|'trialing'|'past_due'|'canceled'|...; NULL => free
ALTER TABLE users ADD COLUMN plan_current_period_end TEXT;   -- ISO8601; display + grace, informational

-- Webhooks resolve the user by their Stripe customer id.
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id);
