#!/usr/bin/env bash
# Outer retry loop around the in-process resilient seed, to survive HARD process
# death (segfault / OOM / host or session restart). The Python side
# (seed_pd12m --target) already handles SOFT failures in-process: it rebuilds the
# HTTP clients on an SSL bad_record_mac and is overshoot-proof + dedup-safe, so
# re-invoking after a hard death simply resumes toward the same absolute target.
#
#   projects/backfill/scripts/seed_to_target.sh <TARGET> [METADATA_DIR]
#
# Requires a Cloudflare API token (D1 + Vectorize Edit) in the repo-root .env.
set -u
TARGET="${1:?usage: seed_to_target.sh <TARGET_PD12M_COUNT> [METADATA_DIR]}"
META="${2:-$HOME/data/PD12M/metadata}"
MAX_RESTARTS="${MAX_RESTARTS:-40}"

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)" || exit 3

attempts=0
while true; do
  uv run python -m wagmiphotos.backfill.seed_pd12m --metadata-dir "$META" --target "$TARGET"
  code=$?
  [ "$code" -eq 0 ] && { echo ">>> SUCCESS: pd12m reached target $TARGET"; break; }
  attempts=$((attempts + 1))
  if [ "$attempts" -ge "$MAX_RESTARTS" ]; then
    echo ">>> giving up after $attempts restarts (last exit $code)"; exit "$code"
  fi
  echo ">>> hard exit $code; restart #$attempts in 10s"; sleep 10
done
