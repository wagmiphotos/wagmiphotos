import pathlib, sqlite3
SQL = (pathlib.Path(__file__).resolve().parents[3] / "projects" / "worker" / "migrations" / "0001_init.sql").read_text()

def test_migration_creates_tables_and_columns():
    conn = sqlite3.connect(":memory:")
    conn.executescript(SQL)
    cols = {t: {r[1] for r in conn.execute(f"PRAGMA table_info({t})")} for t in ("assets", "queries", "api_keys")}
    assert {"id","prompt","source","source_id","thumb_url","medium_url","url","model_used",
            "content_hash","width","height","mime","source_url","locally_cached","created_at"} <= cols["assets"]
    assert {"normalized_prompt","original_prompt","count","status","last_asset_id",
            "last_similarity","first_seen","last_seen"} <= cols["queries"]
    assert {"key_hash","created_at"} <= cols["api_keys"]
    # index present
    idx = {r[1] for r in conn.execute("PRAGMA index_list(queries)")}
    assert any("pending_count" in name for name in idx)
