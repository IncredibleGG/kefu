"""GET /api/v1/public/server-info(免登入)測試。

驗證:回應形狀符合契約(docs/NATIVE-CLIENTS.md §4.1)、features 旗標依設定變化、
push 對「模組不存在 / is_configured 出錯」防禦為 False、已掛進正式 app 且免登入。
"""
from __future__ import annotations

import sys
import types

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.v1 import public_info
from app.api.v1 import saml as saml_api


def _mini_app():
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(public_info.router, prefix="/api/v1/public")
    return app


async def _get(app) -> dict:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.get("/api/v1/public/server-info")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    return body["data"]


@pytest.mark.asyncio
async def test_shape_and_defaults(monkeypatch):
    monkeypatch.delenv("KEFU_GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("KEFU_GOOGLE_CLIENT_SECRET", raising=False)
    monkeypatch.setitem(sys.modules, "app.services.push", None)  # 模擬模組不存在 → ImportError
    data = await _get(_mini_app())
    assert data["app"] == "kefu"
    assert data["api_version"] == 1
    assert data["min_app_version"] == "0.1.0"
    assert isinstance(data["server_version"], str) and data["server_version"]
    assert data["features"] == {"google_sso": False, "saml": saml_api._SIGNXML_AVAILABLE, "push": False}
    assert set(data) == {"app", "api_version", "server_version", "min_app_version", "features"}


@pytest.mark.asyncio
async def test_google_sso_needs_id_and_secret(monkeypatch):
    monkeypatch.setitem(sys.modules, "app.services.push", None)
    monkeypatch.setenv("KEFU_GOOGLE_CLIENT_ID", "cid")
    monkeypatch.delenv("KEFU_GOOGLE_CLIENT_SECRET", raising=False)
    assert (await _get(_mini_app()))["features"]["google_sso"] is False
    monkeypatch.setenv("KEFU_GOOGLE_CLIENT_SECRET", "sec")
    data = await _get(_mini_app())
    assert data["features"]["google_sso"] is True
    # 不洩漏設定值
    assert "cid" not in str(data) and "sec" not in str(data)


@pytest.mark.asyncio
async def test_saml_flag_follows_signxml(monkeypatch):
    monkeypatch.setitem(sys.modules, "app.services.push", None)
    monkeypatch.setattr(saml_api, "_SIGNXML_AVAILABLE", True)
    assert (await _get(_mini_app()))["features"]["saml"] is True
    monkeypatch.setattr(saml_api, "_SIGNXML_AVAILABLE", False)
    assert (await _get(_mini_app()))["features"]["saml"] is False


@pytest.mark.asyncio
async def test_push_flag_from_module(monkeypatch):
    import app.services as services_pkg

    fake = types.ModuleType("app.services.push")
    fake.is_configured = lambda: True
    monkeypatch.setitem(sys.modules, "app.services.push", fake)
    monkeypatch.setattr(services_pkg, "push", fake, raising=False)
    assert (await _get(_mini_app()))["features"]["push"] is True

    def _boom():
        raise RuntimeError("bad config")

    fake.is_configured = _boom
    assert (await _get(_mini_app()))["features"]["push"] is False


def test_server_version_fallback(monkeypatch):
    import importlib.metadata as md

    def _missing(name):  # noqa: ANN001
        raise md.PackageNotFoundError(name)

    monkeypatch.setattr(md, "version", _missing)
    assert public_info.server_version() == "0.1.0"


@pytest.mark.asyncio
async def test_mounted_on_main_app_without_auth():
    from app.main import app

    data = await _get(app)
    assert data["app"] == "kefu"
