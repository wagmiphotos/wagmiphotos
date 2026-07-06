import argparse
import asyncio
import logging
from wagmiphotos.common.config import Settings
from wagmiphotos.backfill.worker import build_worker_from_settings


def main() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description="wagmiphotos backfill worker")
    parser.add_argument("--once", action="store_true", help="run a single tick and exit")
    args = parser.parse_args()
    s = Settings()
    worker = build_worker_from_settings(s)
    asyncio.run(worker.run(s.worker_interval_seconds, once=args.once))


if __name__ == "__main__":
    main()
