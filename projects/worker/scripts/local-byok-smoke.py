#!/usr/bin/env python3
"""BYOK key-management smoke test against a local `wrangler dev --local` worker.

Needs .dev.vars: DEV_MODE=true, PUBLIC_SITE_URL=http://localhost:8787,
BYOK_KEK=<base64 32 bytes>. Generation itself can't run locally (no Workers
AI/Vectorize) — this drives the key lifecycle: PUT (validated), /v1/me block,
PATCH cap/enabled, DELETE, auth gating. Provider validation is exercised with
an intentionally-bad key (expect key_rejected) and, when OPENAI_TEST_KEY is
exported, a real accept path.

Run from projects/worker:  python3 scripts/local-byok-smoke.py
Env overrides: BASE (default http://localhost:8787), EMAIL (default a unique
test address), OPENAI_TEST_KEY (optional — enables checks 6-10).
Exit code 0 iff every check passes (skipped checks don't count as failures).
"""
import http.cookiejar
import json
import os
import re
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("BASE", "http://localhost:8787")
EMAIL = os.environ.get("EMAIL", "byok-smoke@example.com")
REAL_KEY = os.environ.get("OPENAI_TEST_KEY")  # optional

passed = failed = 0


def check(name, cond):
    global passed, failed
    passed += cond
    failed += (not cond)
    print(("  ok " if cond else "FAIL ") + name)


def skip(name):
    print("skip " + name + " (no OPENAI_TEST_KEY)")


# -- tiny cookie-carrying client (mirrors local-billing-smoke.py's req helper) --
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
bare_opener = urllib.request.build_opener()  # no cookie jar, for unauthenticated checks


def req(method, path, body=None, headers=None, cookies=True):
    url = BASE + re.sub(r'^https?://[^/]+', '', path)  # accept absolute URLs, route to BASE
    h = dict(headers or {})
    data = None
    if body is not None:
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        else:
            data = body.encode() if isinstance(body, str) else body
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    use = opener if cookies else bare_opener
    try:
        resp = use.open(r)
        return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def parse(bod):
    try:
        return json.loads(bod)
    except Exception:
        return {}


print(f"BASE={BASE}  EMAIL={EMAIL}")

# 1. dev login: POST /v1/auth/login {email} -> dev_link; GET it with the nonce cookie -> session cookie
print("\n=== 1. dev login ===")
st, bod = req("POST", "/v1/auth/login", body={"email": EMAIL})
dev_link = parse(bod).get("dev_link") if st == 200 else None
check("login returns dev_link", st == 200 and bool(dev_link))
if not dev_link:
    print(bod)
    sys.exit(1)
st, _ = req("GET", dev_link)
check("verify sets session cookie", any(c.name == "wagmi_session" for c in jar))

# 2. unauthenticated PUT /v1/byok -> 401
print("\n=== 2. unauthenticated PUT is rejected ===")
st, bod = req("PUT", "/v1/byok", body={"provider": "openai", "api_key": "sk-anything-8chars"}, cookies=False)
check("unauthenticated PUT -> 401", st == 401)

# 3. authenticated PUT with provider "google" -> 422
print("\n=== 3. bad provider rejected ===")
st, bod = req("PUT", "/v1/byok", body={"provider": "google", "api_key": "sk-anything-8chars"})
check("PUT provider=google -> 422", st == 422)

# 4. authenticated PUT with a bad key -> 400 key_rejected (openai rejects "sk-invalid-smoke-key")
print("\n=== 4. bad key rejected by provider ===")
st, bod = req("PUT", "/v1/byok", body={"provider": "openai", "api_key": "sk-invalid-smoke-key"})
check("PUT with bad key -> 400 key_rejected", st == 400 and parse(bod).get("error") == "key_rejected")

# 5. GET /v1/me -> byok is null
print("\n=== 5. /v1/me shows no byok key ===")
st, bod = req("GET", "/v1/me")
check("me.byok is null (no key stored yet)", st == 200 and parse(bod).get("byok") is None)

# 6-10: real-key path, only when OPENAI_TEST_KEY is exported
print("\n=== 6-10. real-key lifecycle ===")
if REAL_KEY:
    st, bod = req("PUT", "/v1/byok", body={"provider": "openai", "api_key": REAL_KEY, "monthly_cap": 3})
    byok = parse(bod).get("byok") if st == 200 else None
    check("PUT with real key -> 200", st == 200 and bool(byok))
    check("key_last4 matches real key's last 4", bool(byok) and byok.get("key_last4") == REAL_KEY[-4:])

    st, bod = req("GET", "/v1/me")
    me_byok = parse(bod).get("byok") if st == 200 else None
    check("me.byok.monthly_cap == 3", bool(me_byok) and me_byok.get("monthly_cap") == 3)
    check("me.byok.used_this_month == 0", bool(me_byok) and me_byok.get("used_this_month") == 0)

    st, bod = req("PATCH", "/v1/byok", body={"enabled": False})
    patched = parse(bod).get("byok") if st == 200 else None
    check("PATCH enabled=false -> 200", st == 200 and bool(patched))
    check("byok.enabled == False", bool(patched) and patched.get("enabled") is False)

    st, bod = req("PATCH", "/v1/byok", body={"monthly_cap": 7})
    patched = parse(bod).get("byok") if st == 200 else None
    check("PATCH monthly_cap=7 -> 200", st == 200 and bool(patched))
    check("byok.monthly_cap == 7", bool(patched) and patched.get("monthly_cap") == 7)

    st, _ = req("DELETE", "/v1/byok")
    check("DELETE -> 200", st == 200)
    st, bod = req("GET", "/v1/me")
    check("me.byok is null after delete", st == 200 and parse(bod).get("byok") is None)
else:
    for name in [
        "PUT with real key -> 200",
        "key_last4 matches real key's last 4",
        "me.byok.monthly_cap == 3",
        "me.byok.used_this_month == 0",
        "PATCH enabled=false -> 200",
        "byok.enabled == False",
        "PATCH monthly_cap=7 -> 200",
        "byok.monthly_cap == 7",
        "DELETE -> 200",
        "me.byok is null after delete",
    ]:
        skip(name)

# 11. PATCH with no key on the account -> 404
print("\n=== 11. PATCH with no key on account ===")
st, bod = req("PATCH", "/v1/byok", body={"enabled": False})
check("PATCH with no key -> 404", st == 404)

print(f"\n{passed}/{passed + failed} checks passed")
sys.exit(1 if failed else 0)
