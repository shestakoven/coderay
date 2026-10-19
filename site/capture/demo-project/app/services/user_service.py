from app.core.security import hash_password
from app.models.user import User
from app.repositories.user_repository import UserRepository
from app.schemas.user import SignupRequest
from app.services.email_service import EmailService


class DuplicateEmail(Exception):
    pass


class UserService:
    def __init__(self, users: UserRepository, emails: EmailService) -> None:
        self.users = users
        self.emails = emails

    def register(self, request: SignupRequest) -> User:
        email = request.email.strip().lower()
        if self.users.find_by_email(email) is not None:
            raise DuplicateEmail(email)
        user = self.users.add(
            User(email=email, name=request.name.strip(), password_hash=hash_password(request.password))
        )
        self.emails.send_welcome(user)
        return user

    def get(self, user_id: int) -> User | None:
        return self.users.get(user_id)
