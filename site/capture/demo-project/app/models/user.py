from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class User:
    email: str
    name: str
    password_hash: str
    id: int | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @classmethod
    def from_row(cls, row) -> "User":
        user_id, email, name, password_hash, created_at = row
        return cls(
            id=user_id,
            email=email,
            name=name,
            password_hash=password_hash,
            created_at=datetime.fromisoformat(created_at),
        )
