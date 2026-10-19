from fastapi import APIRouter, Depends, HTTPException, status

from app.core.config import settings
from app.core.db import database
from app.repositories.user_repository import UserRepository
from app.schemas.user import SignupRequest, UserOut
from app.services.email_service import EmailService
from app.services.user_service import DuplicateEmail, UserService

router = APIRouter()


def get_user_service() -> UserService:
    emails = EmailService(host=settings.smtp_host, sender=settings.email_from)
    return UserService(UserRepository(database), emails)


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def sign_up(body: SignupRequest, service: UserService = Depends(get_user_service)) -> UserOut:
    try:
        user = service.register(body)
    except DuplicateEmail:
        raise HTTPException(status.HTTP_409_CONFLICT, "This email is already registered.")
    return UserOut.from_user(user)


@router.get("/{user_id}", response_model=UserOut)
def get_user(user_id: int, service: UserService = Depends(get_user_service)) -> UserOut:
    user = service.get(user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such user.")
    return UserOut.from_user(user)
