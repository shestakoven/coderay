import pytest
from fastapi.testclient import TestClient

from app.core.db import database
from app.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ACME_DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    monkeypatch.setattr("app.services.email_service.EmailService._deliver", lambda self, message: None)
    with TestClient(create_app()) as client:
        yield client
    database.close()
