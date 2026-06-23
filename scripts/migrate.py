"""Emit the migration SQL with the correct embedding dimension substituted.

Usage:
    uv run python scripts/migrate.py | psql "$DATABASE_URL"

Honors the EMBEDDING_DIMS env var (default: 768). Does not require a database
connection — it just prints the SQL to stdout.
"""
import pathlib
import sys

# Allow running from any working directory
_SQL_PATH = pathlib.Path(__file__).parent / "migrate.sql"


def main() -> None:
    from sharedcache.config import Settings

    s = Settings()
    sql = _SQL_PATH.read_text()
    sql = sql.replace("__EMBEDDING_DIMS__", str(s.embedding_dims))
    sys.stdout.write(sql)


if __name__ == "__main__":
    main()
