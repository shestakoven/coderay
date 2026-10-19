# acme-signup

Sign-up and account service for Acme.

```sh
pip install -e '.[dev]'
uvicorn app.main:app --reload
pytest
```

| Endpoint | What it does |
|---|---|
| `POST /users` | Create an account |
| `GET /users/{id}` | Read an account |
| `GET /health`, `GET /ready` | Liveness and readiness |
