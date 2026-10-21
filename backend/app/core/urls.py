"""反向代理感知的對外 URL 組裝。

用於 SAML / SCIM 的 metadata、entityID、ACS 等「必須是對外可達且 scheme 正確」的絕對
URL:Cloudflare → nginx → uvicorn 會在邊緣終止 TLS,``request.base_url`` 於是只見到
``http://``、host 也可能是內網名,導致產出的 entityID/ACS 與 IdP 端登記不符而握手失敗。

這裡依 ``X-Forwarded-Proto`` / ``X-Forwarded-Host`` 還原對外 scheme/host,取「最左值」
(XFF 慣例:最靠近原始客戶端者)。標頭缺失時回落到請求本身的 scheme/host。

安全備註:這些標頭由反向代理注入;若服務直接暴露於公網(無可信代理)則可被偽造。
本專案部署於 Cloudflare→nginx 之後,由邊緣覆寫這些標頭。對安全敏感的 SAML ACS,
生產環境仍應以租戶設定 ``saml_sp_acs_url`` 明確覆寫,不倚賴推導值(見 saml._acs_url)。
"""
from __future__ import annotations

from starlette.requests import Request


def forwarded_scheme(request: Request) -> str:
    """還原對外 scheme:優先 X-Forwarded-Proto 最左值,否則請求本身 scheme(再否則 https)。"""
    xf = request.headers.get("x-forwarded-proto")
    if xf:
        proto = xf.split(",")[0].strip().lower()
        if proto in ("http", "https"):
            return proto
    return request.url.scheme or "https"


def forwarded_host(request: Request) -> str:
    """還原對外 host(含 port):優先 X-Forwarded-Host,否則 Host 標頭,再否則請求 netloc。"""
    xf = request.headers.get("x-forwarded-host")
    if xf:
        host = xf.split(",")[0].strip()
        if host:
            return host
    host = request.headers.get("host")
    if host:
        return host.strip()
    return request.url.netloc


def external_base_url(request: Request) -> str:
    """後端對外基底 ``scheme://host``(無尾斜線),已還原反代終止的 TLS scheme。"""
    return f"{forwarded_scheme(request)}://{forwarded_host(request)}"
