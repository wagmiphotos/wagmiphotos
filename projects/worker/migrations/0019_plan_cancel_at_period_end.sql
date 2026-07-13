-- Track "cancel at period end": a subscription the user has cancelled but that
-- stays active (paid) until plan_current_period_end. 1 => cancelling (show
-- "cancels on <date>" not "renews"); 0/absent => renewing normally. Synced from
-- the customer.subscription.created/updated webhook's cancel_at_period_end flag.
ALTER TABLE users ADD COLUMN plan_cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
