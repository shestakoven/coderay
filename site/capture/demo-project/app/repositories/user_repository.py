from app.core.db import Database
from app.models.user import User

COLUMNS = "id, email, name, password_hash, created_at"


class UserRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def add(self, user: User) -> User:
        with self.db.transaction() as tx:
            cursor = tx.execute(
                "INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)",
                (user.email, user.name, user.password_hash),
            )
            return self.get(cursor.lastrowid, tx)

    def get(self, user_id: int, tx=None) -> User | None:
        row = (tx or self.db).execute(f"SELECT {COLUMNS} FROM users WHERE id = ?", (user_id,)).fetchone()
        return User.from_row(row) if row else None

    def find_by_email(self, email: str) -> User | None:
        row = self.db.execute(f"SELECT {COLUMNS} FROM users WHERE email = ?", (email,)).fetchone()
        return User.from_row(row) if row else None
