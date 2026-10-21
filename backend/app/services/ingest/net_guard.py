"""SSRF 防護:發外連請求前(以及每次 redirect 後)驗證目標主機解析出的 IP 均為公網。

僅用標準庫(``ipaddress`` + ``socket``),不引入第三方相依。供爬蟲(``crawler``)與
媒體下載(``media_store``)共用:在請求前逐跳呼叫,阻擋指向

- loopback(127.0.0.0/8、::1)
- 私網(10/8、172.16-31/12、192.168/16、fc00::/7 唯一本地)
- link-local(169.254.0.0/16,**含雲端 metadata 169.254.169.254**;fe80::/10)
- multicast / reserved / unspecified(0.0.0.0)/ CGNAT(100.64/10)等其他非全域位址

的 URL,並拒絕非 http/https。

判斷邏輯以標準庫 ``ipaddress`` 的分類旗標為準:任一為 private/loopback/link_local/
multicast/reserved/unspecified 即拒;再要求 ``is_global`` 為真(涵蓋 CGNAT、TEST-NET、
文件位址等 ``is_global`` 為 False 的特殊範圍)。主機解析出多筆位址時,只要有一筆屬
私網/內網即整體拒絕(防 DNS 回傳混合位址繞過)。
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlparse

_ALLOWED_SCHEMES = ("http", "https")
_DEFAULT_PORTS = {"http": 80, "https": 443}


class BlockedURLError(Exception):
    """目標 URL 被 SSRF 防護拒絕(非法 scheme / 無法解析 / 指向私網或內網)。

    呼叫端應攔截此例外並「降級為拒絕」(爬蟲計為單頁錯誤、媒體下載回 None),
    不可讓它冒成未捕捉例外。
    """


def _addr_is_public(ip_str: str) -> bool:
    """判斷單一 IP 字面值是否為可安全外連的公網位址。"""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    # IPv4-mapped IPv6(::ffff:a.b.c.d)攤回 IPv4 再判,避免以對映位址繞過。
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local  # 169.254.0.0/16(含雲端 metadata 169.254.169.254)、fe80::/10
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return False
    # is_global 為 False 的還包含 CGNAT(100.64/10)、TEST-NET、文件位址等,一律拒絕。
    return bool(ip.is_global)


def _host_and_port(url: str) -> tuple[str, int]:
    """解出 (host, port);scheme 非 http/https 或缺主機名即拋 BlockedURLError。"""
    parsed = urlparse(url)
    if parsed.scheme not in _ALLOWED_SCHEMES:
        raise BlockedURLError(f"拒絕非 http/https 目標:{parsed.scheme or '(空 scheme)'}")
    try:
        host = parsed.hostname
    except ValueError as e:  # 少數畸形 URL(如非法 IPv6 字面值)
        raise BlockedURLError("拒絕:URL 主機名畸形") from e
    if not host:
        raise BlockedURLError("拒絕:URL 缺少主機名")
    port = parsed.port or _DEFAULT_PORTS[parsed.scheme]
    return host, port


def _check_addrs(host: str, addrs: list[str]) -> None:
    """對已解析出的位址逐筆驗證,任一非公網即拒(拋 BlockedURLError)。"""
    if not addrs:
        raise BlockedURLError(f"拒絕:主機 {host} 無可用位址")
    for ip_str in addrs:
        if not _addr_is_public(ip_str):
            raise BlockedURLError(f"拒絕私網/內網目標:{host} → {ip_str}")


def assert_url_public(url: str) -> None:
    """(同步)驗證 url 為 http/https 且其主機解析出的所有 IP 皆為公網;否則拋 BlockedURLError。

    主機為 IP 字面值時 ``getaddrinfo`` 直接回該 IP(不觸發 DNS 查詢)。
    """
    host, port = _host_and_port(url)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError as e:
        raise BlockedURLError(f"拒絕:無法解析主機 {host}") from e
    _check_addrs(host, [info[4][0] for info in infos])


async def assert_url_public_async(url: str) -> None:
    """``assert_url_public`` 的非阻塞版:DNS 解析改用 event loop 的 getaddrinfo,避免卡住事件迴圈。"""
    host, port = _host_and_port(url)
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError as e:
        raise BlockedURLError(f"拒絕:無法解析主機 {host}") from e
    _check_addrs(host, [info[4][0] for info in infos])
