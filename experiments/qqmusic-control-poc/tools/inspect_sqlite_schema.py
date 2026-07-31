"""Print SQLite tables, columns, row counts, and matching rows read-only.

Usage:
  python inspect_sqlite_schema.py <database> [search-term]
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path


def quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print(__doc__.strip(), file=sys.stderr)
        return 2

    path = Path(sys.argv[1]).resolve()
    term = sys.argv[2] if len(sys.argv) == 3 else None
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        tables = [
            row[0]
            for row in connection.execute(
                "select name from sqlite_master "
                "where type='table' order by name"
            )
        ]
        for table in tables:
            columns = list(
                connection.execute(
                    f"pragma table_info({quote(table)})"
                )
            )
            print(f"TABLE {table}")
            print(
                "  COLUMNS "
                + ", ".join(f"{row[1]}:{row[2]}" for row in columns)
            )
            try:
                count = connection.execute(
                    f"select count(*) from {quote(table)}"
                ).fetchone()[0]
                print(f"  ROWS {count}")
            except sqlite3.DatabaseError as error:
                print(f"  COUNT_ERROR {error}")

            if term is None or not columns:
                continue
            text_columns = [
                row[1]
                for row in columns
                if not row[2]
                or "CHAR" in row[2].upper()
                or "TEXT" in row[2].upper()
                or "CLOB" in row[2].upper()
            ]
            if not text_columns:
                continue
            predicate = " or ".join(
                f"cast({quote(column)} as text) like ?"
                for column in text_columns
            )
            query = (
                f"select * from {quote(table)} "
                f"where {predicate} limit 20"
            )
            parameters = [f"%{term}%"] * len(text_columns)
            rows = list(connection.execute(query, parameters))
            for row in rows:
                print(f"  MATCH {row!r}")
    finally:
        connection.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
