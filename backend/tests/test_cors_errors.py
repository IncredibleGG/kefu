"""CORS 與錯誤信封測試(docs/NATIVE-CLIENTS.md §4.1 CORS)。

- 未捕獲例外的 500 回應也帶 CORS 標頭(CatchAllErrorMiddleware 位於 CORSMiddleware 內層),
  並維持 {ok,data,error,request_id} 信封與 X-Request-Id。
- expose_headers 含 X-Request-Id、Content-Disposition;allow_credentials 恆 False。
- 白名單模式自動併入原生 origin(完整比對,不放任意 port / 前綴);可再併 KEFU_CORS_ORIGIN_REGEX。
"""
from __future__ import annotations

import re
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from httpx import ASGITransport, AsyncClient

from app import main as main_mod

NATIVE_ORIGINS = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "capacitor://localhost",
    "https://localhost",
    "http://localhost",
]
BAD_ORIGINS = [
    "https://localhost:8080",
    "https://localhost.evil.com",
    "tauri://localhost.evil.com",
    "https://evil.com/?tauri://localhost",
    "capacitor://evil",
    "https://tauri.localhost.evil.com",
]


def _cfg(origins="*", regex=None, expose="X-Request-Id,Content-Disposition"):
    return SimpleNamespace(cors_origins=origins, cors_origin_regex=regex, cors_expose_headers=expose)


# --------------------------------------------------------------------------- #
# build_cors_options
# --------------------------------------------------------------------------- #
def test_options_allow_all_default():
    opts = main_mod.build_cors_options(_cfg("*"))
    assert opts["allow_origins"] == ["*"]
    assert opts["allow_credentials"] is False
    assert opts["allow_origin_regex"] is None
    assert opts["expose_headers"] == ["X-Request-Id", "Content-Disposition"]


def test_options_whitelist_merges_native_regex():
    opts = main_mod.build_cors_options(_cfg("https://kf.example.com, https://admin.example.com"))
    assert opts["allow_origins"] == ["https://kf.example.com", "https://admin.example.com"]
    assert opts["allow_credentials"] is False  # 白名單模式也不開 credentials
    rx = re.compile(opts["allow_origin_regex"])
    for o in NATIVE_ORIGINS:
        assert rx.fullmatch(o), o
    for o in BAD_ORIGINS:
        assert not rx.fullmatch(o), o


def test_options_whitelist_with_custom_regex():
    opts = main_mod.build_cors_options(_cfg("https://kf.example.com", regex=r"https://[a-z]+\.corp\.example"))
    rx = re.compile(opts["allow_origin_regex"])
    assert rx.fullmatch("https://shop.corp.example")
    assert rx.fullmatch("capacitor://localhost")
    assert not rx.fullmatch("https://shop.corp.example.evil")


def test_settings_defaults():
    from app.core.config import Settings

    s = Settings()
    assert s.cors_origin_regex is None
    assert s.cors_expose_headers == "X-Request-Id,Content-Disposition"
    assert s.native_redirect_uris == "kefu://auth/callback"


# --------------------------------------------------------------------------- #
# 正式 app:500 帶 CORS + 信封 + request_id
# --------------------------------------------------------------------------- #
_BOOM_PATH = "/__test__/cors-boom"


async def _boom():
    raise RuntimeError("kaboom")


if not any(getattr(r, "path", None) == _BOOM_PATH for r in main_mod.app.router.routes):
    main_mod.app.add_api_route(_BOOM_PATH, _boom, methods=["GET"])


@pytest.mark.asyncio
async def test_main_app_unhandled_500_has_cors_and_envelope():
    async with AsyncClient(transport=ASGITransport(app=main_mod.app), base_url="http://test") as c:
        r = await c.get(_BOOM_PATH, headers={"Origin": "tauri://localhost"})
    assert r.status_code == 500
    assert r.headers["access-control-allow-origin"] == "*"
    expose = r.headers["access-control-expose-headers"]
    assert "X-Request-Id" in expose and "Content-Disposition" in expose
    body = r.json()
    assert body["ok"] is False and body["data"] is None
    assert body["error"]["code"] == "internal_error"
    assert "kaboom" not in r.text  # 不洩漏例外內容
    assert body["request_id"] and body["request_id"] == r.headers["x-request-id"]


def test_main_app_catch_all_inside_cors():
    """user_middleware[0] 為最外層:CORS 必須在 CatchAll 外側,500 才會經 CORS 加標頭。"""
    classes = [m.cls for m in main_mod.app.user_middleware]
    assert classes.index(CORSMiddleware) < classes.index(main_mod.CatchAllErrorMiddleware)
    cors = next(m for m in main_mod.app.user_middleware if m.cls is CORSMiddleware)
    assert cors.kwargs["allow_credentials"] is False
    assert "X-Request-Id" in cors.kwargs["expose_headers"]


@pytest.mark.asyncio
async def test_main_app_preflight_and_404_from_native_origin():
    async with AsyncClient(transport=ASGITransport(app=main_mod.app), base_url="http://test") as c:
        r = await c.options(
            "/api/v1/auth/me",
            headers={
                "Origin": "capacitor://localhost",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )
        assert r.status_code == 200
        assert r.headers["access-control-allow-origin"] == "*"
        assert "authorization" in r.headers["access-control-allow-headers"].lower()
        assert "access-control-allow-credentials" not in r.headers

        r = await c.get("/api/v1/__nope__", headers={"Origin": "https://localhost"})
        assert r.status_code == 404
        assert r.headers["access-control-allow-origin"] == "*"
        assert r.json()["error"]["code"] == "not_found"


# --------------------------------------------------------------------------- #
# 白名單模式的 mini app(同一組 middleware 與註冊順序)
# --------------------------------------------------------------------------- #
def _whitelist_app() -> FastAPI:
    app = FastAPI()

    @app.get("/boom")
    async def boom():
        raise ValueError("secret detail")

    @app.get("/forbidden")
    async def forbidden():
        raise HTTPException(403, detail="nope")

    app.add_middleware(main_mod.CatchAllErrorMiddleware)
    app.add_middleware(CORSMiddleware, **main_mod.build_cors_options(_cfg("https://kf.example.com")))
    return app


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", NATIVE_ORIGINS + ["https://kf.example.com"])
async def test_whitelist_500_echoes_allowed_origin(origin):
    async with AsyncClient(transport=ASGITransport(app=_whitelist_app()), base_url="http://test") as c:
        r = await c.get("/boom", headers={"Origin": origin})
    assert r.status_code == 500
    assert r.headers["access-control-allow-origin"] == origin
    assert "origin" in r.headers.get("vary", "").lower()
    assert "access-control-allow-credentials" not in r.headers
    assert r.json()["error"]["code"] == "internal_error"
    assert "secret detail" not in r.text


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", BAD_ORIGINS)
async def test_whitelist_rejects_other_origins(origin):
    async with AsyncClient(transport=ASGITransport(app=_whitelist_app()), base_url="http://test") as c:
        r = await c.get("/boom", headers={"Origin": origin})
    assert r.status_code == 500
    assert "access-control-allow-origin" not in r.headers


# --------------------------------------------------------------------------- #
# 最外層保底處理器的 CORS 標頭(外層 middleware 自身例外時)
# --------------------------------------------------------------------------- #
def _req(origin: str | None):
    headers = {"origin": origin} if origin else {}
    return SimpleNamespace(headers=headers)


def test_outer_handler_cors_headers(monkeypatch):
    monkeypatch.setattr(main_mod, "_cors_options", main_mod.build_cors_options(_cfg("*")))
    monkeypatch.setattr(main_mod, "_cors_regex", None)
    h = main_mod._cors_headers_for(_req("tauri://localhost"))
    assert h["Access-Control-Allow-Origin"] == "*"
    assert "X-Request-Id" in h["Access-Control-Expose-Headers"]
    assert main_mod._cors_headers_for(_req(None)) == {}

    opts = main_mod.build_cors_options(_cfg("https://kf.example.com"))
    monkeypatch.setattr(main_mod, "_cors_options", opts)
    monkeypatch.setattr(main_mod, "_cors_regex", re.compile(opts["allow_origin_regex"]))
    h = main_mod._cors_headers_for(_req("capacitor://localhost"))
    assert h["Access-Control-Allow-Origin"] == "capacitor://localhost" and h["Vary"] == "Origin"
    assert main_mod._cors_headers_for(_req("https://evil.example.com")) == {}
    assert main_mod._cors_headers_for(_req("https://kf.example.com"))["Access-Control-Allow-Origin"] == (
        "https://kf.example.com"
    )
