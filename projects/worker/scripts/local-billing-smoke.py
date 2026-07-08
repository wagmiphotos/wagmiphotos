#!/usr/bin/env python3
"""Local end-to-end smoke test for the Stripe billing + gating flow.

Drives the running `wrangler dev --local` worker through the whole subscription
lifecycle and asserts the gating at each step. Because we hold the same
STRIPE_WEBHOOK_SECRET the worker verifies against, we sign the webhook events
ourselves with the exact HMAC-SHA256 scheme Stripe uses — so this exercises the
real verifyStripeSignature -> entitlementFromEvent -> gating path without needing
the Stripe CLI's forwarding tunnel.

Prereqs (see docs/HANDOFF-2026-07-08-stripe-billing.md):
  1. projects/worker/.dev.vars has DEV_MODE=true, PUBLIC_SITE_URL=http://localhost:8787,
     STRIPE_SECRET_KEY=sk_test_..., STRIPE_PRICE_ID=price_..., and STRIPE_WEBHOOK_SECRET
     (any value locally — we are the signer).
  2. Local D1 migrated:  npx wrangler d1 migrations apply wagmiphotos --local
  3. Worker running:     npx wrangler dev --local --port 8787 --ip 127.0.0.1

Run from projects/worker:  python3 scripts/local-billing-smoke.py
Env overrides: BASE (default http://localhost:8787), EMAIL (default a unique test address).
Exit code 0 iff every check passes.
"""
import json, time, hmac, hashlib, subprocess, urllib.request, urllib.error, http.cookiejar, os, sys, re, pathlib

BASE = os.environ.get("BASE", "http://localhost:8787")
EMAIL = os.environ.get("EMAIL", "billing-smoke@example.com")
WORKER_DIR = pathlib.Path(__file__).resolve().parent.parent          # projects/worker
DEV_VARS = WORKER_DIR / ".dev.vars"
results = []

def rec(name, ok, detail=""):
    results.append(ok)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))

def read_secret(key):
    for line in DEV_VARS.read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    raise SystemExit(f"{key} not found in {DEV_VARS}")

WHSEC = read_secret("STRIPE_WEBHOOK_SECRET")

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def req(method, path, body=None, headers=None, cookies=True):
    url = BASE + re.sub(r'^https?://[^/]+', '', path)   # accept absolute URLs, route to BASE
    h = dict(headers or {})
    data = None
    if body is not None:
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode(); h.setdefault("Content-Type", "application/json")
        else:
            data = body.encode() if isinstance(body, str) else body
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    use = opener if cookies else urllib.request.build_opener()
    try:
        resp = use.open(r); return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def signed_webhook(event):
    payload = json.dumps(event)
    t = int(time.time())
    sig = hmac.new(WHSEC.encode(), f"{t}.{payload}".encode(), hashlib.sha256).hexdigest()
    return req("POST", "/v1/stripe/webhook", body=payload,
               headers={"Content-Type": "application/json", "Stripe-Signature": f"t={t},v1={sig}"})

def d1(sql):
    out = subprocess.run(["npx", "wrangler", "d1", "execute", "wagmiphotos", "--local", "--json", "--command", sql],
                         cwd=str(WORKER_DIR), capture_output=True, text=True)
    m = re.search(r"\[.*\]", out.stdout, re.S)
    data = json.loads(m.group(0)) if m else []
    return data[0].get("results", []) if data else []

print(f"BASE={BASE}  EMAIL={EMAIL}\n=== 1. dev login ===")
st, bod = req("POST", "/v1/auth/login", body={"email": EMAIL})
dev_link = json.loads(bod).get("dev_link") if st == 200 else None
rec("login returns dev_link", bool(dev_link), f"status={st}")
if not dev_link:
    print(bod); sys.exit(1)
st, _ = req("GET", dev_link)
rec("verify sets session cookie", any(c.name == "wagmi_session" for c in jar), f"status={st}")

print("\n=== 2. free user is gated ===")
_, bod = req("GET", "/v1/me")
rec("me.plan.active false for new user", json.loads(bod).get("plan", {}).get("active") is False)
st, bod = req("POST", "/v1/keys/generate", body={"label": "x"})
rec("keygen 402 for free user", st == 402, f"status={st}")

print("\n=== 3. checkout creates a real Stripe customer ===")
st, bod = req("POST", "/v1/billing/checkout")
url = json.loads(bod).get("url") if st == 200 else None
rec("checkout returns a Stripe URL", bool(url) and "stripe" in (url or ""), f"status={st}")
rows = d1(f"SELECT stripe_customer_id FROM users WHERE email='{EMAIL}'")
cus = rows[0]["stripe_customer_id"] if rows else None
rec("customer id persisted", bool(cus) and str(cus).startswith("cus_"), f"cus={cus}")

print("\n=== 4. webhook signature enforced ===")
active = {"type": "customer.subscription.created", "data": {"object": {
    "id": "sub_smoke", "customer": cus, "status": "active", "current_period_end": int(time.time()) + 31536000}}}
st, _ = req("POST", "/v1/stripe/webhook", body=json.dumps(active),
            headers={"Content-Type": "application/json", "Stripe-Signature": "t=1,v1=deadbeef"})
rec("bad-signature webhook -> 400", st == 400, f"status={st}")

print("\n=== 5. active subscription -> Unlimited ===")
st, _ = signed_webhook(active)
rec("signed subscription.created -> 200", st == 200, f"status={st}")
_, bod = req("GET", "/v1/me")
rec("me.plan.active true", json.loads(bod).get("plan", {}).get("active") is True, json.loads(bod).get("plan"))

print("\n=== 6. paid user can mint + use a key ===")
st, bod = req("POST", "/v1/keys/generate", body={"label": "paid"})
key = json.loads(bod).get("key") if st == 200 else None
rec("keygen 200 for paid user", st == 200 and bool(key), f"status={st}")
st, _ = req("POST", "/v1/images/generations", body={"prompt": "cat"}, headers={"Authorization": "Bearer sc-nope"}, cookies=False)
rec("unknown bearer -> 401", st == 401, f"status={st}")
st, _ = req("POST", "/v1/images/generations", body={"prompt": "cat"}, headers={"Authorization": f"Bearer {key}"}, cookies=False)
rec("paid key passes gate (500 offline OK, not 402/401)", st not in (401, 402), f"status={st}")

print("\n=== 7. cancellation revokes ===")
st, _ = signed_webhook({"type": "customer.subscription.deleted", "data": {"object": {"id": "sub_smoke", "customer": cus, "status": "canceled"}}})
rec("signed subscription.deleted -> 200", st == 200, f"status={st}")
_, bod = req("GET", "/v1/me")
rec("me.plan.active false after cancel", json.loads(bod).get("plan", {}).get("active") is False)
st, _ = req("POST", "/v1/images/generations", body={"prompt": "cat"}, headers={"Authorization": f"Bearer {key}"}, cookies=False)
rec("canceled owner's key -> 402", st == 402, f"status={st}")

print("\n=== 8. unknown event ignored ===")
st, _ = signed_webhook({"type": "invoice.paid", "data": {"object": {"customer": cus}}})
rec("unknown event -> 200", st == 200, f"status={st}")

ok = sum(results)
print(f"\n==== {ok}/{len(results)} checks passed ====")
sys.exit(0 if ok == len(results) else 1)
