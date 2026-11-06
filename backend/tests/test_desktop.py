from fastapi.testclient import TestClient

from pdfer.api import app
from pdfer.desktop import DesktopAccess


def test_desktop_requires_token_for_api_and_static_files():
    client = TestClient(DesktopAccess(app, "a" * 64))
    for endpoint in ("/", "/api/fonts", "/api/desktop/health"):
        assert client.get(endpoint).status_code == 403
        assert client.get(endpoint, headers={"x-pdfer-token": "incorrect"}).status_code == 403
    assert client.get("/api/desktop/health", headers={"x-pdfer-token": "a" * 64}).json() == {"ready": True}
    assert client.get("/api/fonts", headers={"x-pdfer-token": "a" * 64}).status_code == 200


def test_browser_api_still_works_without_desktop_token():
    assert TestClient(app).get("/api/fonts").status_code == 200
