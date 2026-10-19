from fastapi import APIRouter, Response, status

from app.core.config import settings
from app.core.db import database

router = APIRouter()


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": settings.version}


@router.get("/ready")
def ready(response: Response) -> dict[str, str]:
    if not database.ping():
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "database unavailable"}
    return {"status": "ready"}
