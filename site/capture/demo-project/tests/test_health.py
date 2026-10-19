def test_health_reports_the_version(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["version"]


def test_ready_checks_the_database(client):
    assert client.get("/ready").json() == {"status": "ready"}
