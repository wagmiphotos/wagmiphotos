import argparse
import asyncio
from sharedcache.common.config import Settings
from sharedcache.backfill.worker import build_worker_from_settings


def main() -> None:
    parser = argparse.ArgumentParser(description="SharedCache backfill worker")
    parser.add_argument("--once", action="store_true", help="run a single tick and exit")
    args = parser.parse_args()
    s = Settings()
    worker = build_worker_from_settings(s)
    asyncio.run(worker.run(s.worker_interval_seconds, once=args.once))


if __name__ == "__main__":
    main()
