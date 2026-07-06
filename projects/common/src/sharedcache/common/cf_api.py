"""Shared Cloudflare REST plumbing for the D1 and Vectorize clients: one API
base URL, one retry policy, one response-envelope check."""
import time

import httpx

API_BASE = "https://api.cloudflare.com/client/v4"

RETRY_ATTEMPTS = 3
_BACKOFF_BASE_SECONDS = 0.5
_BACKOFF_FACTOR = 4.0  # ~0.5s, 2s, 8s


def _retryable(status_code: int) -> bool:
    return status_code == 429 or status_code >= 500


def post_with_retry(client: httpx.Client, url: str, *, what: str, **kwargs) -> dict:
    """POST to a Cloudflare endpoint, retrying 429/5xx/transport errors with
    exponential backoff, then validate the {success, result} envelope.

    `what` names the operation (e.g. "D1 query") for error messages."""
    resp: httpx.Response | None = None
    last_error: Exception | None = None
    for attempt in range(RETRY_ATTEMPTS):
        if attempt:
            time.sleep(_BACKOFF_BASE_SECONDS * _BACKOFF_FACTOR ** (attempt - 1))
        try:
            resp = client.post(url, **kwargs)
        except httpx.TransportError as e:
            resp, last_error = None, e
            continue
        if not _retryable(resp.status_code):
            break
    if resp is None:
        raise RuntimeError(
            f"{what} failed after {RETRY_ATTEMPTS} attempts: {last_error}") from last_error
    if resp.status_code != 200:
        raise RuntimeError(f"{what} failed ({resp.status_code}): {resp.text}")
    body = resp.json()
    if not body.get("success", False):
        raise RuntimeError(f"{what} error: {body.get('errors')}")
    return body
