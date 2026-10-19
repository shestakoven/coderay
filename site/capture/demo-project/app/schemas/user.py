from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

from app.models.user import User


class SignupRequest(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=10, max_length=128)


class UserOut(BaseModel):
    id: int
    email: EmailStr
    name: str
    created_at: datetime

    @classmethod
    def from_user(cls, user: User) -> "UserOut":
        return cls(id=user.id, email=user.email, name=user.name, created_at=user.created_at)
