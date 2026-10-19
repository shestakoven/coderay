import sqlite3
from contextlib import contextmanager
from threading import Lock

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'))
);
"""


class Database:
    def __init__(self) -> None:
        self._conn: sqlite3.Connection | None = None
        self._lock = Lock()

    def connect(self, url: str) -> None:
        path = url.removeprefix("sqlite:///")
        self._conn = sqlite3.connect(path, check_same_thread=False)

    def migrate(self) -> None:
        with self.transaction() as tx:
            tx.executescript(SCHEMA)

    def execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, params)

    @contextmanager
    def transaction(self):
        with self._lock, self._conn:
            yield self._conn

    def ping(self) -> bool:
        try:
            self.execute("SELECT 1")
            return True
        except (sqlite3.Error, AttributeError):
            return False

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None


database = Database()
