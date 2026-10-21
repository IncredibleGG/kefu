"""SSRF 防護與知識庫授權的針對性測試。

- net_guard:169.254.169.254 / 127.0.0.1 / 10.x / ::1 / 非 http scheme 被拒;公網放行。
- crawler:起始網址指向私網時 crawl_site 拋 ValueError(worker 會據此記為 failed)。
- media_store:download_and_store 對私網 URL 回 None(不拋);轉址到私網被擋。
- knowledge API:五個端點補上 knowledge.manage 授權。

不需真實網路:私網以 IP 字面值(getaddrinfo 不觸發 DNS)測試;公網放行以 monkeypatch
getaddrinfo 回一個公網 IP 驗證流程,避免依賴外網。
"""
from __future__ import annotations

import socket

import httpx
import pytest

import uuid

from fastapi import HTTPException

from app.api.v1 import knowledge as kn
from app.core.deps import Principal
from app.services import media_store
from app.services.ingest import net_guard
from app.services.ingest.crawler import crawl_site
from app.services.ingest.net_guard import BlockedURLError, assert_url_public


# --------------------------------------------------------------------------- #
# net_guard(同步核心)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",  # 雲端 metadata(link-local)
        "http://127.0.0.1/x",  # loopback
        "https://127.0.0.1:8443/x",  # loopback + port
        "http://10.0.0.5/x",  # 私網 A
        "http://172.16.0.9/x",  # 私網 B
        "http://192.168.1.1/x",  # 私網 C
        "http://[::1]/x",  # IPv6 loopback
        "http://0.0.0.0/x",  # unspecified
        "http://100.64.0.1/x",  # CGNAT(非全域)
        "ftp://example.com/x",  # 非 http/https
        "file:///etc/passwd",  # 非 http/https
        "http:///nohost",  # 缺主機名
    ],
)
def test_blocked_urls(url):
    with pytest.raises(BlockedURLError):
        assert_url_public(url)


def test_public_ip_literal_allowed():
    # 8.8.8.8 為公網 IP 字面值,getaddrinfo 直接回該 IP,不觸發 DNS。
    assert_url_public("https://8.8.8.8/x")  # 不應拋例外


def test_public_hostname_allowed(monkeypatch):
    """公網主機名放行(monkeypatch getaddrinfo 回公網 IP,避免依賴外網)。"""

    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]

    monkeypatch.setattr(net_guard.socket, "getaddrinfo", fake_getaddrinfo)
    assert_url_public("https://example.com/page")  # 不應拋例外


def test_mixed_dns_any_private_blocks(monkeypatch):
    """DNS 回傳公網+私網混合位址時,只要有一筆私網即整體拒絕。"""

    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port)),
        ]

    monkeypatch.setattr(net_guard.socket, "getaddrinfo", fake_getaddrinfo)
    with pytest.raises(BlockedURLError):
        assert_url_public("https://rebind.example/x")


# --------------------------------------------------------------------------- #
# crawler:私網起始網址拒絕
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_crawl_site_rejects_private_start():
    with pytest.raises(ValueError):
        await crawl_site("http://169.254.169.254/latest/meta-data/")
    with pytest.raises(ValueError):
        await crawl_site("http://127.0.0.1:8080/")


@pytest.mark.asyncio
async def test_crawl_site_rejects_bad_scheme():
    with pytest.raises(ValueError):
        await crawl_site("ftp://example.com/")


# --------------------------------------------------------------------------- #
# media_store:私網 URL 回 None(不拋),轉址到私網被擋
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_media_store_blocks_private_url():
    assert await media_store.download_and_store("http://169.254.169.254/x.jpg") is None
    assert await media_store.download_and_store("http://127.0.0.1/x.jpg") is None
    assert await media_store.download_and_store("http://10.0.0.1/x.jpg") is None


@pytest.mark.asyncio
async def test_media_store_blocks_non_http():
    assert await media_store.download_and_store("file:///etc/passwd") is None


@pytest.mark.asyncio
async def test_media_store_public_download_ok(tmp_path, monkeypatch):
    """注入 transport(受信任測試接縫)時走正常下載存檔路徑,證明 SSRF 修改未破壞既有下載。

    (真實外連的公網 URL 同樣放行,由 net_guard 的公網放行測試涵蓋。)
    """
    monkeypatch.setenv("KEFU_UPLOAD_DIR", str(tmp_path))

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "image/png"},
            content=b"\x89PNG\r\n\x1a\n" + b"0" * 32,
        )

    transport = httpx.MockTransport(handler)
    stored = await media_store.download_and_store(
        "https://graph.facebook.example/media/1", transport=transport, filename_hint="pic.png"
    )
    assert stored is not None
    assert stored.startswith("/api/v1/channel/files/")


# --------------------------------------------------------------------------- #
# knowledge API 授權:五個寫入/爬取端點須要求 knowledge.manage
# --------------------------------------------------------------------------- #
def _weak_staff() -> Principal:
    """一名不具 admin、也不具 knowledge.manage 的最低權限 staff。"""
    return Principal(staff_id=uuid.uuid4(), tenant_id=uuid.uuid4(), roles=["agent"])


@pytest.mark.asyncio
async def test_knowledge_write_endpoints_require_manage():
    """五個端點在最低權限下應於 require() 立即擋下(403),不觸及 db。

    require() 為各函式第一個可執行敘述,故傳入 db=None 也不會被使用。
    """
    staff = _weak_staff()
    cid = uuid.uuid4()

    async def expect_403(coro):
        with pytest.raises(HTTPException) as ei:
            await coro
        assert ei.value.status_code == 403

    await expect_403(kn.create_collection(kn.CollectionIn(name="x"), staff, None))
    await expect_403(
        kn.create_document(cid, kn.DocumentIn(content="hi"), staff, None)
    )
    await expect_403(kn.upload_document(cid, staff, None, file=None))
    await expect_403(kn.create_qa(cid, kn.QAPairIn(question="q", answer="a"), staff, None))
    await expect_403(kn.crawl_website(cid, kn.CrawlIn(url="https://example.com"), staff, None))


@pytest.mark.asyncio
async def test_knowledge_manage_role_passes_require():
    """具 knowledge.manage 的 staff 通過 require()(後續才會走 db;此處以私網爬取確認已過授權)。"""
    staff = Principal(staff_id=uuid.uuid4(), tenant_id=uuid.uuid4(), roles=["knowledge.manage"])
    # 通過 require 後,crawl_website 會走 _get_collection(需 db);傳 None 會在 require 之後
    # 才觸發 AttributeError/TypeError,證明未被 403 擋下。
    with pytest.raises(Exception) as ei:
        await kn.crawl_website(uuid.uuid4(), kn.CrawlIn(url="https://example.com"), staff, None)
    assert not (isinstance(ei.value, HTTPException) and ei.value.status_code == 403)
