from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_version_reports_the_running_commit(monkeypatch) -> None:
    # This service has no auto-deploy on push, so "is my change actually live" has to be answerable
    # from outside. Render injects RENDER_GIT_COMMIT on every deploy.
    monkeypatch.setenv("RENDER_GIT_COMMIT", "d7df9225e47afe51049577d27240032f60203559")
    monkeypatch.setenv("RENDER_GIT_BRANCH", "main")
    body = client.get("/version").json()
    assert body["commit"] == "d7df9225e47afe51049577d27240032f60203559"
    assert body["branch"] == "main"


def test_version_is_honest_when_it_does_not_know() -> None:
    # Running anywhere that isn't Render (local dev, a container built by hand). Saying "unknown" is
    # the point: inventing a plausible-looking SHA would make the endpoint worse than not having it.
    body = client.get("/version").json()
    assert body["commit"] == "unknown"
