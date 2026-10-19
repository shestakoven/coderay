from fastapi import FastAPI

from app.core.config import settings
from app.core.db import database
from app.routes import health, users


def create_app() -> FastAPI:
    app = FastAPI(title="acme-signup", version=settings.version)
    app.include_router(health.router)
    app.include_router(users.router, prefix="/users", tags=["users"])

    @app.on_event("startup")
    def connect() -> None:
        database.connect(settings.database_url)
        database.migrate()

    @app.on_event("shutdown")
    def disconnect() -> None:
        database.close()

    return app


app = create_app()
