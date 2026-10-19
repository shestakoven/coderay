SIGNUP = {"email": "Ada@Example.com", "name": "Ada Lovelace", "password": "analytical-engine"}


def test_sign_up_creates_a_user(client):
    response = client.post("/users", json=SIGNUP)
    assert response.status_code == 201
    body = response.json()
    assert body["email"] == "ada@example.com"
    assert client.get(f"/users/{body['id']}").json()["name"] == "Ada Lovelace"


def test_sign_up_twice_is_a_conflict(client):
    client.post("/users", json=SIGNUP)
    assert client.post("/users", json=SIGNUP).status_code == 409


def test_unknown_user_is_404(client):
    assert client.get("/users/999").status_code == 404
